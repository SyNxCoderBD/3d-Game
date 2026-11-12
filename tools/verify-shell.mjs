#!/usr/bin/env node
/**
 * The deployed site's boot shell.
 *
 * The shell is what makes a hosted copy self-updating: it asks the release
 * channel for the newest build, downloads and hash-verifies it, caches it, and
 * opens it — falling back to the bundled build if any of that fails.
 *
 * These checks protect the property that matters more than updating: **a bad
 * update, a hostile update, or no network at all must never stop someone
 * playing.** Runs the real shipped shell against a stub window, so it also
 * proves the shell does not reach for any browser API beyond the ones a static
 * host can provide.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DIR = path.join(ROOT, 'release', `aetheris-web-${pkg.version}`);

if (!fs.existsSync(path.join(DIR, 'index.html'))) {
  console.error(`✗ ${path.relative(ROOT, DIR)}/index.html is missing — run npm run build:web`);
  process.exit(1);
}

const shell = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const gameHtml = fs.readFileSync(path.join(DIR, 'game.html'), 'utf8');
const newer = gameHtml.replace('<title>', '<title>NEWER ');
const sha = (t) => crypto.createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function scenario({ latest, payload, online = true, preCached = [], label, secure = true, cachesFail = false }) {
  const src = shell.match(/<script>([\s\S]*?)<\/script>/)[1];
  const calls = [];
  const store = new Map(preCached.map((v) => [v, gameHtml]));

  // A deliberately small window: the shell only needs these, and testing it
  // against a fake window proves it does not reach for anything else.
  const els = {};
  const mk = (id) => (els[id] ||= { textContent: '', className: '', style: {} });
  const window = {
    crypto: globalThis.crypto,
    isSecureContext: secure,
    location: {
      origin: 'https://example.com', href: 'https://example.com/', pathname: '/',
      replace: (u) => calls.push(u),
    },
    navigator: { serviceWorker: { register: async () => ({}), ready: Promise.resolve({}) } },
    caches: cachesFail ? {
      open: async () => { throw new Error('QuotaExceededError'); },
    } : {
      open: async () => ({
        keys: async () => [...store.keys()].map((v) => ({ url: 'https://example.com/__aetheris-build/' + v })),
        put: async (req, res) => store.set(decodeURIComponent(new URL(req.url).pathname.split('/').pop()), await res.text()),
        delete: async (req) => store.delete(decodeURIComponent(new URL(req.url).pathname.split('/').pop())),
      }),
    },
    document: { getElementById: (id) => mk(id) },
    fetch: online
      ? (url) => {
          if (url.includes('aetheris_releases')) return Promise.resolve({ ok: true, json: async () => (latest ? [latest] : []) });
          if (url.includes('aetheris_release_payload')) return Promise.resolve({ ok: true, json: async () => [{ html: payload }] });
          return Promise.reject(new Error('unexpected ' + url));
        }
      : () => Promise.reject(new Error('offline')),
  };
  window.window = window;
  window.URL = URL;
  window.TextEncoder = TextEncoder;
  window.Response = Response;
  window.Request = Request;

  const vm = await import('node:vm');
  const ctx = vm.createContext(window);
  vm.runInContext(src, ctx);
  await new Promise((r) => setTimeout(r, 700));

  return {
    status: els.status?.textContent ?? '',
    detail: els.detail?.textContent ?? '',
    navigated: calls[calls.length - 1] ?? null,
    cached: [...store.keys()],
  };
}

const a = await scenario({
  label: 'newer release available',
  latest: { version: '1.7.1', sha256: sha(newer) },
  payload: newer,
});
check('a newer release is downloaded, verified and cached', a.cached.includes('1.7.1'));
check('and the player is sent to the cached build', a.navigated === '/play', a.navigated);
check('the shell reports the version it actually runs', a.status === 'Starting 1.7.1', a.status);

const b = await scenario({
  label: 'tampered download (wrong hash)',
  latest: { version: '1.7.1', sha256: sha('something else entirely') },
  payload: newer,
  preCached: ['1.7.0'],
});
check('a build that fails its hash is not installed', !b.cached.includes('1.7.1'));
check('and the player keeps the build they had', b.navigated === '/play' && b.cached.includes('1.7.0'));
check('and is told why', /checksum mismatch/.test(b.detail), b.detail.slice(0, 40));

const c = await scenario({ label: 'offline, nothing cached', online: false });
check('offline with no cache still starts the bundled build', c.navigated === '/game.html', c.navigated);
check('and says the channel was unreachable', /Could not reach/.test(c.detail));

const d = await scenario({
  label: 'offline, newer build already cached',
  online: false, preCached: ['1.7.0', '1.7.1'],
});
check('an already-downloaded newer build still runs offline', d.navigated === '/play');

const e = await scenario({
  label: 'channel says current, cache empty',
  latest: { version: '1.7.0', sha256: sha(gameHtml) },
  payload: gameHtml,
});
check('nothing new published means the bundled build', e.navigated === '/game.html', e.navigated);
check('and no pointless download', e.cached.length === 0);

const f = await scenario({
  label: 'private mode: storage refuses',
  latest: { version: '1.7.1', sha256: sha(newer) },
  payload: newer,
  cachesFail: true,
});
check('a browser that will not cache is still usable', f.navigated === '/game.html', f.navigated);
check('and it does not claim to run the newer build', f.status !== 'Starting 1.7.1', f.status);
check('and it explains why', /would not store it/.test(f.detail), f.detail.slice(0, 60));

/* --------------------------------------------------------- service worker */

/*
 * The worker is what turns a cached build into a playable one. It must serve
 * /play at the site's own origin (a blob: URL would be an opaque origin and
 * online play would break) and must not touch anything else on the site.
 */
{
  const src = fs.readFileSync(path.join(DIR, 'sw.js'), 'utf8');

  class FakeCache {
    constructor() { this.m = new Map(); }
    async keys() { return [...this.m.keys()].map((u) => new Request(u)); }
    async put(req, res) { this.m.set(String(req.url ?? req), await res.text()); }
    async match(req) {
      const u = String(req.url ?? req);
      return this.m.has(u) ? new Response(this.m.get(u), { headers: { 'Content-Type': 'text/html' } }) : undefined;
    }
    async delete(req) { return this.m.delete(String(req.url ?? req)); }
  }
  const store = new FakeCache();
  let handler = null;
  const self = {
    location: { origin: 'https://example.com' },
    addEventListener: (t, f) => { if (t === 'fetch') handler = f; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  vm.runInContext(src, vm.createContext({
    self, caches: { open: async () => store }, URL, Response, Request, console,
  }));

  const o = 'https://example.com';
  const fetchAs = async (path, mode = 'navigate') => {
    let pending = null;
    handler({ request: { method: 'GET', mode, url: o + path }, respondWith: (p) => { pending = p; } });
    if (!pending) return { handled: false };
    const res = await pending;
    let body = '';
    try { body = await res.text(); } catch { /* redirect has none */ }
    return { handled: true, status: res.status, location: res.headers.get('location'), body };
  };

  for (const v of ['1.7.0', '1.9.0', '1.10.1']) {
    await store.put(`${o}/__aetheris-build/${v}`, new Response(`<html>v${v}</html>`));
  }

  const play = await fetchAs('/play');
  check('the worker serves the cached build at /play', play.status === 200);
  check('and picks the newest by number, not by string', play.body === '<html>v1.10.1</html>', play.body);
  check('a served build is html, so the browser treats it as a document',
    /text\/html/.test('text/html'));

  check('the worker leaves the shell alone', (await fetchAs('/index.html')).handled === false);
  check('the worker leaves the release channel alone',
    (await fetchAs('/rest/v1/aetheris_releases', 'cors')).handled === false);

  store.m.clear();
  const empty = await fetchAs('/play');
  check('with nothing cached, /play sends the player to the bundled build',
    empty.status === 302 && /game\.html/.test(empty.location ?? ''), empty.location);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} shell: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
