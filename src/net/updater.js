/**
 * Self-update: keep the installed game current without re-downloading the exe.
 *
 * The .exe never changes. It is only a launcher plus a copy of the game to fall
 * back on. The authoritative build lives in Supabase; when the launcher opens,
 * the running page asks for the newest release and, if it is newer than what is
 * already extracted, stages it so the next launch runs it.
 *
 * Why the page does the downloading rather than the launcher:
 *   - the page already talks to Supabase, and already runs inside a sandboxed
 *     browser at a real http origin, so TLS and CORS are the browser's problem;
 *   - a plain-C WinHTTP client in the launcher would need its own TLS stack,
 *     certificate validation and retry logic — a lot of untestable native code
 *     standing between the player and a working game.
 *
 * Why a staging file rather than overwriting index.html in place:
 *   - the browser has index.html open, and on Windows a file that is mapped by
 *     another process cannot be replaced reliably;
 *   - a download that dies halfway must never be able to leave a corrupt game.
 * So the new build is written to `next.html` + `next.ver`, and the launcher
 * swaps it in at startup, before any browser touches the file.
 *
 * Nothing here is allowed to interrupt play. Every failure path is silent apart
 * from a status line: offline, blocked, corrupt download, no local server (the
 * game opened over file://) — in all of those cases the player keeps the build
 * they already have.
 */

const DEFAULT_TABLE = 'aetheris_releases';
const DEFAULT_TIMEOUT_MS = 20000;

/** Compare two dotted version strings. Returns <0, 0 or >0. */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((part) => {
        const n = parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/**
 * Where updates can be collected. Only meaningful when the launcher is serving
 * the game over loopback http; a file:// page has no server to hand bytes to.
 */
export function updateTarget(loc) {
  const href = loc?.href ?? '';
  const host = loc?.hostname ?? '';
  const port = loc?.port ?? '';
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  if (!loc?.protocol?.startsWith('http') || !isLoopback || !port) return null;
  return {
    base: `${loc.protocol}//${host}:${port}`,
    staged: `${loc.protocol}//${host}:${port}/__aetheris/staged`,
  };
}

/**
 * Ask Supabase for the newest published release on a channel.
 * Returns null when there is nothing published yet.
 */
export async function fetchLatestRelease({ url, anonKey, channel = 'stable', table = DEFAULT_TABLE,
                                           timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!url || !anonKey) throw new Error('supabase url and anon key are required');
  const query = `${url.replace(/\/+$/, '')}/rest/v1/${table}` +
    `?select=version,channel,release_no,notes,released_at,size_bytes,sha256` +
    `&channel=eq.${encodeURIComponent(channel)}&published=eq.true` +
    `&order=release_no.desc&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(query, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`release lookup failed (${res.status})`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (!row.version || !row.sha256) throw new Error('release row is incomplete');
    return {
      version: String(row.version),
      channel: String(row.channel ?? channel),
      releaseNo: Number(row.release_no ?? 0),
      notes: String(row.notes ?? ''),
      releasedAt: String(row.released_at ?? ''),
      sizeBytes: Number(row.size_bytes ?? 0),
      sha256: String(row.sha256).toLowerCase(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Both payload transport paths, in the order they should be tried. */
function payloadUrls({ url, version, sha256, table = DEFAULT_TABLE }) {
  const base = url.replace(/\/+$/, '');
  return [
    // 1. Read the payload as a byte-exact binary body. Exact-byte transport is
    //    what lets the launcher verify a hash; JSON would re-encode it.
    `${base}/storage/v1/object/public/${table}/${encodeURIComponent(version)}.html`,
    // 2. JSON fallback: PostgREST returns the html column as a JSON string.
    `${base}/rest/v1/aetheris_release_payload?select=html&version=eq.${encodeURIComponent(version)}`,
  ].map((u) => ({ url: u, kind: u.includes('/storage/') ? 'binary' : 'json', version, sha256 }));
}

/** SHA-256 of a byte buffer as lowercase hex. */
export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('SubtleCrypto is unavailable');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Download a release's html and prove it is the build we asked for.
 * Throws on any mismatch rather than returning something unverified.
 */
export async function downloadRelease(latest, { url, anonKey, timeoutMs = 60000,
                                                fetchImpl = fetch, subtle } = {}) {
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const errors = [];

  for (const candidate of payloadUrls({ url, version: latest.version, sha256: latest.sha256 })) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(candidate.url, {
        headers: candidate.kind === 'json' ? { ...headers, Accept: 'application/json' } : headers,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        errors.push(`${candidate.kind}: HTTP ${res.status}`);
        continue;
      }

      let text;
      if (candidate.kind === 'json') {
        const rows = await res.json();
        text = Array.isArray(rows) && rows.length ? rows[0].html : null;
        if (typeof text !== 'string' || !text) {
          errors.push('json: empty payload');
          continue;
        }
      } else {
        // Decode as UTF-8 explicitly: the build contains non-ASCII (·, →, ✕)
        // and must arrive byte-identical to what was hashed.
        const buffer = await res.arrayBuffer();
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      }

      const bytes = new TextEncoder().encode(text);
      const digest = await sha256Hex(bytes, subtle);
      if (digest !== latest.sha256) {
        errors.push(`${candidate.kind}: sha256 mismatch`);
        continue;
      }
      if (!/<!doctype html/i.test(text.slice(0, 200))) {
        errors.push(`${candidate.kind}: not an html document`);
        continue;
      }
      return { html: text, bytes: bytes.length, sha256: digest, transport: candidate.kind };
    } catch (err) {
      errors.push(`${candidate.kind}: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`could not download ${latest.version} (${errors.join('; ')})`);
}

/**
 * Hand a verified build to the launcher, which stages it for the next start.
 * Returns the launcher's reply (expected status 'staged').
 */
export async function stageRelease(stagedUrl, html, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(stagedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`launcher refused the update (${res.status}) ${text.slice(0, 80)}`);
    if (!/staged/i.test(text)) throw new Error(`launcher did not stage the update (${text.slice(0, 80)})`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole update cycle, best-effort.
 *
 * `currentVersion` is whatever this page believes it is. The launcher is the
 * real authority on what is staged, so this only decides whether a download is
 * worth doing at all.
 *
 * Returns { state, ... } where state is one of:
 *   'unsupported'  - not served over loopback (file:// or dev server)
 *   'offline'      - lookup failed; keep playing
 *   'current'      - nothing newer published
 *   'staged'       - newer build verified and handed to the launcher
 *   'failed'       - newer build exists but could not be fetched safely
 */
export async function runUpdateCheck({
  currentVersion,
  location = globalThis.location,
  supabaseUrl,
  anonKey,
  channel = 'stable',
  onStatus = () => {},
  ...opts
} = {}) {
  const target = updateTarget(location);
  if (!target) return { state: 'unsupported' };

  let latest;
  try {
    onStatus('checking');
    latest = await fetchLatestRelease({ url: supabaseUrl, anonKey, channel, ...opts });
  } catch (err) {
    onStatus('offline');
    return { state: 'offline', error: err?.message ?? String(err) };
  }

  if (!latest) {
    onStatus('current');
    return { state: 'current', latest: null };
  }
  if (compareVersions(latest.version, currentVersion) <= 0) {
    onStatus('current');
    return { state: 'current', latest };
  }

  try {
    onStatus('downloading', latest);
    const downloaded = await downloadRelease(latest, { url: supabaseUrl, anonKey, ...opts });
    await stageRelease(target.staged, downloaded.html, opts);
    onStatus('staged', latest);
    return {
      state: 'staged',
      latest,
      bytes: downloaded.bytes,
      transport: downloaded.transport,
    };
  } catch (err) {
    onStatus('failed', latest);
    return { state: 'failed', latest, error: err?.message ?? String(err) };
  }
}

/** Short label for the menu: 'v1.3.0'. */
export function versionLabel(version) {
  const v = String(version ?? '').trim();
  return v ? (v.toLowerCase().startsWith('v') ? v : `v${v}`) : '';
}
