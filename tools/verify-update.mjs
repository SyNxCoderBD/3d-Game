#!/usr/bin/env node
/**
 * Tests the page half of the updater.
 *
 * The rule this file exists to protect: **the game must never install a build
 * it could not verify**, and **a failed update must never be able to stop the
 * game from starting**. Everything below is a scenario where the happy path is
 * disturbed, because the happy path is the one that gets tested by playing.
 */
import crypto from 'node:crypto';
import { renderChangelog, shortDate } from '../src/ui/menu-chrome.js';
import {
  compareVersions,
  versionLabel,
  updateTarget,
  fetchLatestRelease,
  downloadRelease,
  stageRelease,
  sha256Hex,
  runUpdateCheck,
} from '../src/net/updater.js';
import { startHeartbeat, HEARTBEAT_INTERVAL_MS } from '../src/net/heartbeat.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const URL_BASE = 'https://example.supabase.co';
const ANON = 'anon-key';
const BUILD = '<!doctype html>\n<html><body><script>v1.4.0</script>·→✕</body></html>\n';
const BUILD_BYTES = Buffer.from(BUILD, 'utf8');
const BUILD_SHA = crypto.createHash('sha256').update(BUILD_BYTES).digest('hex');

const RELEASE = {
  version: '1.4.0',
  channel: 'stable',
  release_no: 2,
  notes: 'Sharper shadows',
  released_at: '2026-11-12T10:00:00Z',
  size_bytes: BUILD_BYTES.length,
  sha256: BUILD_SHA,
};

/** A fetch stand-in with per-URL behaviour, recording what was requested. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init);
    }
    return { ok: false, status: 404, async json() { return null; }, async text() { return 'not found'; } };
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
  async text() { return JSON.stringify(body); },
});

const binaryResponse = (text, status = 200) => {
  const bytes = Buffer.from(text, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async json() { return null; },
    async text() { return text; },
  };
};

const LOOPBACK = {
  href: 'http://127.0.0.1:51234/',
  protocol: 'http:',
  hostname: '127.0.0.1',
  port: '51234',
};

async function main() {
  console.log('▸ updater module');

  /* ---------------------------------------------------------- versions */
  check('newer version compares greater', compareVersions('1.4.0', '1.3.0') > 0);
  check('older version compares smaller', compareVersions('1.2.9', '1.3.0') < 0);
  check('same version compares equal', compareVersions('1.3.0', '1.3.0') === 0);
  check('numeric, not lexical: 1.10 > 1.9', compareVersions('1.10.0', '1.9.0') > 0);
  check('v-prefix is ignored', compareVersions('v1.4.0', '1.3.0') > 0);
  check('missing segments count as zero', compareVersions('1.4', '1.4.0') === 0);
  check('label adds exactly one v', versionLabel('1.3.0') === 'v1.3.0' && versionLabel('v1.3.0') === 'v1.3.0');

  /* ------------------------------------------------------- update target */
  const t = updateTarget(LOOPBACK);
  check('loopback server is an update target', t?.staged === `${t?.base}/__aetheris/staged`, t?.staged);
  check('file:// is not an update target', updateTarget({ protocol: 'file:', hostname: '', port: '', href: 'file:///x' }) === null);
  check('dev server is not an update target (would overwrite the repo)',
    updateTarget({ protocol: 'http:', hostname: '0.0.0.0', port: '5173', href: 'http://0.0.0.0:5173/' }) === null);
  check('public web host is not an update target',
    updateTarget({ protocol: 'https:', hostname: 'example.com', port: '', href: 'https://example.com/' }) === null);

  /* ------------------------------------------------------ release lookup */
  {
    const f = fakeFetch([['/rest/v1/aetheris_releases', () => jsonResponse([RELEASE])]]);
    const latest = await fetchLatestRelease({ url: URL_BASE, anonKey: ANON, fetchImpl: f });
    check('reads the newest release', latest?.version === '1.4.0');
    check('carries the hash through', latest?.sha256 === BUILD_SHA);
    check('sends the anon key as both headers',
      f.calls[0].init.headers.apikey === ANON && f.calls[0].init.headers.Authorization === `Bearer ${ANON}`);
    check('only asks for published rows', f.calls[0].url.includes('published=eq.true'));
    check('orders by release_no', f.calls[0].url.includes('order=release_no.desc'));
  }
  {
    const f = fakeFetch([['/rest/v1/aetheris_releases', () => jsonResponse([])]]);
    const latest = await fetchLatestRelease({ url: URL_BASE, anonKey: ANON, fetchImpl: f });
    check('empty table means nothing published', latest === null);
  }
  {
    const f = fakeFetch([['/rest/v1/aetheris_releases', () => jsonResponse({ message: 'nope' }, 500)]]);
    let threw = false;
    try {
      await fetchLatestRelease({ url: URL_BASE, anonKey: ANON, fetchImpl: f });
    } catch { threw = true; }
    check('a server error is reported, not hidden', threw);
  }
  {
    const f = fakeFetch([['/rest/v1/aetheris_releases', () => jsonResponse([{ version: '1.4.0' }])]]);
    let threw = false;
    try {
      await fetchLatestRelease({ url: URL_BASE, anonKey: ANON, fetchImpl: f });
    } catch { threw = true; }
    check('a release with no hash is rejected', threw);
  }

  /* --------------------------------------------------------- downloading */
  {
    const f = fakeFetch([
      ['/storage/v1/object/public/', () => binaryResponse(BUILD)],
      ['/rest/v1/aetheris_release_payload', () => jsonResponse([{ html: BUILD }])],
    ]);
    const got = await downloadRelease(RELEASE, { url: URL_BASE, anonKey: ANON, fetchImpl: f });
    check('downloads and verifies a build', got.sha256 === BUILD_SHA, `${got.bytes} bytes`);
    check('prefers byte-exact transport', got.transport === 'binary');
    check('utf-8 round-trips intact', got.html.includes('·→✕'));
    check('does not fall through to json on success', f.calls.length === 1);
  }
  {
    // Storage is missing (not set up yet): the JSON path must carry the day.
    const f = fakeFetch([
      ['/storage/v1/object/public/', () => ({ ok: false, status: 404, async text() { return ''; }, async json() { return null; } })],
      ['/rest/v1/aetheris_release_payload', () => jsonResponse([{ html: BUILD }])],
    ]);
    const got = await downloadRelease(RELEASE, { url: URL_BASE, anonKey: ANON, fetchImpl: f });
    check('falls back to the JSON payload', got.transport === 'json' && got.sha256 === BUILD_SHA);
  }
  {
    const tampered = BUILD.replace('v1.4.0', 'v9.9.9');
    const f = fakeFetch([
      ['/storage/v1/object/public/', () => binaryResponse(tampered)],
      ['/rest/v1/aetheris_release_payload', () => jsonResponse([{ html: tampered }])],
    ]);
    let threw = false;
    try {
      await downloadRelease(RELEASE, { url: URL_BASE, anonKey: ANON, fetchImpl: f });
    } catch (err) { threw = /sha256 mismatch/.test(err.message); }
    check('refuses a build whose hash does not match', threw);
  }
  {
    const f = fakeFetch([['/storage/v1/object/public/', () => binaryResponse('<html>not a doctype</html>')]]);
    let threw = false;
    try {
      await downloadRelease({ ...RELEASE, sha256: crypto.createHash('sha256').update('<html>not a doctype</html>').digest('hex') },
        { url: URL_BASE, anonKey: ANON, fetchImpl: f });
    } catch (err) { threw = /not an html document/.test(err.message); }
    check('refuses something with a matching hash but no doctype', threw);
  }
  {
    const f = fakeFetch([]);  // everything 404s
    let threw = false;
    try {
      await downloadRelease(RELEASE, { url: URL_BASE, anonKey: ANON, fetchImpl: f });
    } catch (err) { threw = /could not download/.test(err.message); }
    check('reports when no transport works', threw);
  }

  /* -------------------------------------------------------------- staging */
  {
    const f = fakeFetch([['/__aetheris/staged', () => ({ ok: true, status: 200, async text() { return 'staged 96 bytes'; } })]]);
    const reply = await stageRelease('http://127.0.0.1:1/__aetheris/staged', BUILD, { fetchImpl: f });
    check('hands the build to the launcher', /staged/i.test(reply));
    check('posts the exact build', f.calls[0].init.body === BUILD);
    check('posts it as html', f.calls[0].init.headers['Content-Type'].includes('text/html'));
  }
  {
    const f = fakeFetch([['/__aetheris/staged', () => ({ ok: false, status: 400, async text() { return 'not an html build'; } })]]);
    let threw = false;
    try { await stageRelease('http://127.0.0.1:1/__aetheris/staged', 'x', { fetchImpl: f }); }
    catch (err) { threw = /refused/.test(err.message); }
    check('surfaces a launcher refusal', threw);
  }

  /* --------------------------------------------------------- whole cycle */
  const routes = () => [
    ['/rest/v1/aetheris_releases', () => jsonResponse([RELEASE])],
    ['/storage/v1/object/public/', () => binaryResponse(BUILD)],
    ['/__aetheris/staged', () => ({ ok: true, status: 200, async text() { return 'staged'; } })],
  ];

  {
    const f = fakeFetch(routes());
    const out = await runUpdateCheck({
      currentVersion: '1.3.0', location: LOOPBACK,
      supabaseUrl: URL_BASE, anonKey: ANON, fetchImpl: f,
    });
    check('updates when a newer build exists', out.state === 'staged', `${out.latest?.version} ${out.bytes}B`);
  }
  {
    const f = fakeFetch(routes());
    const out = await runUpdateCheck({
      currentVersion: '1.4.0', location: LOOPBACK,
      supabaseUrl: URL_BASE, anonKey: ANON, fetchImpl: f,
    });
    check('does nothing when already current', out.state === 'current');
    check('current build is not re-downloaded', f.calls.length === 1);
  }
  {
    const f = fakeFetch(routes());
    const out = await runUpdateCheck({
      currentVersion: '1.5.0', location: LOOPBACK,
      supabaseUrl: URL_BASE, anonKey: ANON, fetchImpl: f,
    });
    check('never downgrades to an older release', out.state === 'current');
  }
  {
    const f = fakeFetch([['/rest/v1/aetheris_releases', () => { throw new Error('offline'); }]]);
    const out = await runUpdateCheck({
      currentVersion: '1.3.0', location: LOOPBACK,
      supabaseUrl: URL_BASE, anonKey: ANON, fetchImpl: f,
    });
    check('offline is a normal outcome, not an error', out.state === 'offline');
  }
  {
    const f = fakeFetch(routes());
    const out = await runUpdateCheck({
      currentVersion: '1.3.0', location: { protocol: 'file:', hostname: '', port: '', href: 'file:///x' },
      supabaseUrl: URL_BASE, anonKey: ANON, fetchImpl: f,
    });
    check('no update attempt over file://', out.state === 'unsupported' && f.calls.length === 0);
  }
  {
    const f = fakeFetch([
      ['/rest/v1/aetheris_releases', () => jsonResponse([RELEASE])],
      ['/storage/v1/object/public/', () => binaryResponse(BUILD.replace('v1.4.0', 'evil'))],
      ['/rest/v1/aetheris_release_payload', () => jsonResponse([{ html: BUILD.replace('v1.4.0', 'evil') }])],
      ['/__aetheris/staged', () => ({ ok: true, status: 200, async text() { return 'staged'; } })],
    ]);
    const out = await runUpdateCheck({
      currentVersion: '1.3.0', location: LOOPBACK,
      supabaseUrl: URL_BASE, anonKey: ANON, fetchImpl: f,
    });
    check('a tampered payload is never staged', out.state === 'failed' && !f.calls.some((c) => c.url.includes('/__aetheris/staged')));
  }
  {
    const f = fakeFetch([
      ['/rest/v1/aetheris_releases', () => jsonResponse([RELEASE])],
      ['/storage/v1/object/public/', () => binaryResponse(BUILD)],
      ['/__aetheris/staged', () => ({ ok: false, status: 500, async text() { return 'could not stage'; } })],
    ]);
    const out = await runUpdateCheck({
      currentVersion: '1.3.0', location: LOOPBACK,
      supabaseUrl: URL_BASE, anonKey: ANON, fetchImpl: f,
    });
    check('a staging failure leaves the running build alone', out.state === 'failed');
  }
  {
    // Status callbacks are the only thing the player sees.
    const seen = [];
    const f = fakeFetch(routes());
    await runUpdateCheck({
      currentVersion: '1.3.0', location: LOOPBACK,
      supabaseUrl: URL_BASE, anonKey: ANON, fetchImpl: f,
      onStatus: (s) => seen.push(s),
    });
    check('reports progress to the menu',
      seen.includes('checking') && seen.includes('downloading') && seen.includes('staged'),
      seen.join(' → '));
  }

  /* ------------------------------------------------------------ change log */
  {
    const el = { innerHTML: '' };
    const entries = [
      { version: '1.4.0', notes: 'Self-updating', released_at: '2026-11-12T15:39:31Z', release_no: 2 },
      { version: '1.3.0', notes: 'Online <duels> & "ammo"', released_at: '2026-11-12T15:33:23Z', release_no: 1 },
      { version: '1.2.0', notes: '', released_at: '2026-11-12T12:00:00Z', release_no: 0 },
    ];
    const n = renderChangelog(entries, '1.3.0', el);
    check('change log lists every release', n === 3);
    check('marks exactly one entry as current', (el.innerHTML.match(/YOU ARE HERE/g) || []).length === 1);
    check('marks the entry that is actually running',
      /clEntry current"><div class="clHead"><span class="clVer">v1\.3\.0/.test(el.innerHTML.replace(/\s+/g, ' ')) ||
      el.innerHTML.includes('v1.3.0'));
    check('escapes release notes', el.innerHTML.includes('&lt;duels&gt;') && !el.innerHTML.includes('<duels>'));
    check('escapes quotes in notes', el.innerHTML.includes('&quot;ammo&quot;'));
    check('shows a v-prefixed version per row',
      el.innerHTML.includes('v1.4.0') && el.innerHTML.includes('v1.3.0') && el.innerHTML.includes('v1.2.0'));
    check('empty notes get a readable placeholder', el.innerHTML.includes('No notes'));
    check('dates render as calendar days', shortDate('2026-11-12T15:39:31Z') === '2026-11-12');
    check('an unusable date renders blank, not "Invalid Date"', shortDate('nonsense') === '');
  }
  {
    const el = { innerHTML: '' };
    renderChangelog([], '1.0.0', el);
    check('change log copes with no releases at all', el.innerHTML.includes('No releases'));
  }

  /* ------------------------------------------------------------ heartbeat */

  /*
   * The launcher only knows the game window is still open because the page
   * says so. If this stops happening, the server shuts down mid-session and the
   * player gets ERR_CONNECTION_REFUSED on reload — the original bug.
   */
  {
    const calls = [];
    const timers = [];
    const hb = startHeartbeat({
      location: { protocol: 'http:', hostname: '127.0.0.1', port: '5000', href: 'http://127.0.0.1:5000/' },
      fetchImpl: (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true }); },
      setIntervalImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearIntervalImpl: (id) => { timers.splice(id - 1, 1); },
    });

    check('the page checks in immediately on boot', calls.length === 1);
    check('it checks in on the launcher port, not somewhere else',
      calls[0]?.url === 'http://127.0.0.1:5000/__aetheris/alive', calls[0]?.url);
    check('the check-in is not cached by the browser', calls[0]?.opts?.cache === 'no-store');
    check('repeats on a timer', timers.length === 1 && timers[0].ms === HEARTBEAT_INTERVAL_MS);

    // The timer must actually fire more check-ins.
    timers[0].fn();
    check('the timer keeps the launcher informed', calls.length === 2);

    hb.stop();
    check('stopping clears the timer', timers.length === 0);

    // A failed check-in must never throw into the game.
    let threw = false;
    try {
      startHeartbeat({
        location: { protocol: 'http:', hostname: '127.0.0.1', port: '5000', href: 'http://127.0.0.1:5000/' },
        fetchImpl: () => { throw new Error('network is on fire'); },
        setIntervalImpl: () => 1,
        clearIntervalImpl: () => {},
      });
    } catch { threw = true; }
    check('a failing check-in cannot break the game', !threw);

    // file:// and the dev server have no launcher; nothing may be scheduled.
    const none = startHeartbeat({
      location: { protocol: 'file:', hostname: '', port: '', href: 'file:///C:/x/index.html' },
      fetchImpl: () => { throw new Error('must not be called'); },
      setIntervalImpl: () => { throw new Error('must not be called'); },
    });
    check('no heartbeat over file://', none.url === null);
  }

  /* -------------------------------------------------------------- hashing */
  check('sha256 of empty input is known-good',
    (await sha256Hex(new Uint8Array(0))) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n  ${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nverify-update failed:', err.message);
  process.exit(1);
});
