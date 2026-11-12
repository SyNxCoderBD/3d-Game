/*
 * AETHERIS build cache.
 *
 * The shell (index.html) decides which build to play and stores it in the Cache
 * API. This worker is what makes that build playable: it answers `/play` (and
 * every navigation to it) with the newest cached build.
 *
 * Why a worker at all: the shell could open a blob: URL or a data: URL, but both
 * have an opaque origin. The game needs a real origin for online multiplayer —
 * its CORS requests and the realtime WebSocket are rejected from `null`. A
 * worker lets a cached document be served *at the site's own origin*, so a
 * browser-cached build behaves exactly like a deployed one, including a normal
 * reload and a normal address bar.
 *
 * Deliberately dumb: it serves caches and nothing else. No network fallback for
 * game content, no clever invalidation. The shell owns all of the decisions.
 */

const CACHE = 'aetheris-game-v1';
const BUILD_PREFIX = '/__aetheris-build/';

/** Newest cached build, or null. */
async function newestBuild() {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  const versions = keys
    .map((req) => {
      const m = new URL(req.url).pathname.match(/^\/__aetheris-build\/(.+)$/);
      return m ? decodeURIComponent(m[1]) : null;
    })
    .filter(Boolean);

  if (!versions.length) return null;

  const parse = (v) => String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  versions.sort((a, b) => {
    const x = parse(a), y = parse(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return versions[versions.length - 1];
}

self.addEventListener('install', () => {
  // Take over as soon as possible: the shell has already waited for `ready`.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  /*
   * Any navigation to /play is the game. Anything else is left completely alone
   * — this worker must never interfere with the shell, the release channel, or
   * the game's own network calls.
   */
  const isPlay = url.pathname === '/play' || url.pathname === '/play/';
  if (!isPlay && req.mode !== 'navigate') return;
  if (!isPlay) return;

  event.respondWith((async () => {
    const version = await newestBuild();
    if (!version) {
      // Nothing cached: hand the player back to the shell rather than a blank
      // 404. The shell will pick the bundled build.
      return Response.redirect(new URL('/game.html', self.location.origin).href, 302);
    }
    const cache = await caches.open(CACHE);
    const hit = await cache.match(new URL(BUILD_PREFIX + encodeURIComponent(version), self.location.origin));
    if (!hit) {
      return Response.redirect(new URL('/game.html', self.location.origin).href, 302);
    }
    // A fresh Response: the cached one may be consumed, and the game must be
    // delivered as html so the browser treats it as a document.
    return new Response(hit.body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  })());
});
