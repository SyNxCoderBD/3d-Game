#!/usr/bin/env node
/**
 * Builds the portable Windows executable.
 *
 *   1. vite build  -> dist/ (single ES bundle)
 *   2. inline the JS + CSS into one self-contained index.html
 *   3. cross-compile launcher/launcher.c with Zig (x86_64-windows-gnu)
 *   4. append the html payload + trailer to the launcher
 *
 * Result: release/Aetheris.exe (single file, no installer, no runtime).
 */
import { build } from 'vite';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');
const RELEASE = path.join(ROOT, 'release');
const MAGIC = 'AETHERIS-PAYLOAD';

const ZIG_CANDIDATES = [
  process.env.ZIG,
  '/tmp/zigpkg/ziglang/zig',
  'zig',
].filter(Boolean);

function findZig() {
  for (const candidate of ZIG_CANDIDATES) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'pipe' });
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'Zig not found. Install it (pip install ziglang --target /tmp/zigpkg) or set ZIG=/path/to/zig'
  );
}

function inlineBundle(html) {
  let out = html;
  let assets = 0;

  /*
   * Inlining must not change *when* a script runs.
   *
   * Vite emits `<script type="module" src=...>` in <head>. A module script is
   * deferred by definition, so it runs after the document has been parsed and
   * every element exists. Replacing that tag with a plain `<script>` makes it
   * run immediately, while the parser is still inside <head> — at which point
   * document.body is null. Then every `document.getElementById(...)` in
   * main.js returns null, the first null dereference throws, and the browser
   * has no crash card to show because #fatal does not exist yet either. The
   * player sees the loading screen forever.
   *
   * So the bundle keeps its deferred timing by moving to the end of <body>,
   * which is where a deferred script effectively runs anyway. The bundle is an
   * IIFE, not a real module, so it needs the timing, not the module semantics.
   *
   * Note on `$`: every insertion below is done by index, never by returning a
   * replacement string from String.replace. Minified game code contains `$&`,
   * `$'` and `$1`, and replacement strings expand those — which spliced a
   * literal `</body>` into the middle of the bundle and broke the whole page.
   */
  const insertions = []; // { match: RegExp, code: string, defer: boolean }
  const placeholders = [];

  out = out.replace(/<script([^>]*)\ssrc="([^"]+)"([^>]*)>\s*<\/script>/g, (match, before, src, after) => {
    const file = path.join(DIST, src.replace(/^\.?\//, ''));
    const code = fs.readFileSync(file, 'utf8');
    if (code.includes('</script')) throw new Error('Bundle contains a literal </script>');
    assets++;

    const isModule = /type="module"/.test(before + after);
    const key = `@@AETHERIS_BUNDLE_${placeholders.length}@@`;
    placeholders.push({ key, code: `<script>\n${code}\n</script>`, defer: isModule });
    return key;
  });

  out = out.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (match, href) => {
    const file = path.join(DIST, href.replace(/^\.?\//, ''));
    const css = fs.readFileSync(file, 'utf8');
    assets++;
    const key = `@@AETHERIS_STYLE_${placeholders.length}@@`;
    placeholders.push({ key, code: `<style>\n${css}\n</style>`, defer: false });
    return key;
  });

  // Now the document is settled: put each piece back, by index.
  for (const { key, code, defer } of placeholders) {
    const at = out.indexOf(key);
    if (at < 0) throw new Error(`inline placeholder ${key} was lost`);
    if (!defer) {
      out = out.slice(0, at) + code + out.slice(at + key.length);
      continue;
    }
    const closeAt = out.search(/<\/body\s*>/i);
    if (closeAt < 0) throw new Error('payload has no </body> to defer the bundle into');
    out = out.slice(0, at) + out.slice(at + key.length);
    const closeNow = out.search(/<\/body\s*>/i);
    out = out.slice(0, closeNow) + code + '\n' + out.slice(closeNow);
  }

  if (/@@AETHERIS_(BUNDLE|STYLE)_/.test(out)) throw new Error('an inline placeholder was not replaced');
  if (assets && !out.includes('<script>')) throw new Error('the bundle did not survive inlining');

  // Any leftover asset references mean the page would break in a single file.
  const leftover = out.match(/[Ss]rc="\.?\/?assets\/[^"]+"/g);
  if (leftover) throw new Error(`Un-inlined assets: ${leftover.join(', ')}`);

  return { html: out, assets };
}

/**
 * Compile launcher/localserver.c natively (the same source the Windows build
 * embeds), serve the actual payload through it, and check we get it back byte
 * for byte. Catches a broken server before it becomes a broken .exe.
 */
async function verifyLocalServer(html) {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aetheris-srv-'));
  const page = path.join(tmp, 'index.html');
  await fsp.writeFile(page, html, 'utf8');

  const harness = path.join(tmp, 'harness.c');
  // Mirrors WinMain's lifecycle: start serving, then wait for the page to stop
  // checking in. Arguments let the test use short timings.
  await fsp.writeFile(harness, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "localserver.c"
int main(int argc, char **argv) {
  local_server srv;
  if (!srv_start(&srv, argv[1])) { fprintf(stderr, "%s", srv.error); return 1; }
  printf("%d\\n", srv.port);
  fflush(stdout);
  unsigned idle = (unsigned)atoi(argv[2]);
  unsigned alive = (unsigned)atoi(argv[3]);
  unsigned max = (unsigned)atoi(argv[4]);
  srv_wait_for_idle(&srv, idle, alive, max);
  srv_stop(&srv);
  return 0;
}
`, 'utf8');

  const bin = path.join(tmp, 'srv');
  execFileSync('cc', ['-O2', '-w', '-I', path.join(ROOT, 'launcher'), '-o', bin, harness], {
    stdio: 'pipe',
  });

  /* Short timings so the test is quick: shut down 1.5 s after the page stops
   * checking in, or 2 s after the last request for a page that never polls. */
  const child = (await import('node:child_process')).spawn(bin, [page, '1500', '2000', '30000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('loopback server did not report a port')), 8000);
      child.stdout.on('data', (d) => {
        out += d.toString();
        if (/^\d+$/.test(out.trim())) { clearTimeout(timer); resolve(parseInt(out.trim(), 10)); }
      });
      child.on('error', reject);
    });

    const res = await fetch(`http://127.0.0.1:${port}/`);
    if (!res.ok) throw new Error(`loopback server answered ${res.status}`);
    const got = await res.text();
    if (got !== html) {
      throw new Error(`loopback server returned ${got.length} bytes, expected ${html.length}`);
    }
    console.log(`  served ${(got.length / 1024).toFixed(0)} KB over 127.0.0.1:${port} ✓`);

    /*
     * The server must outlive the browser process it was started for.
     *
     * Chromium uses a process singleton: the exe the launcher spawns usually
     * forwards the URL to an existing instance and exits immediately. The old
     * launcher waited on that handle and stopped the server the moment it
     * signalled, so the real window opened onto a dead port and showed
     * ERR_CONNECTION_REFUSED.
     *
     * A loaded page can then go quiet for minutes and still be open, so
     * silence is not a shutdown signal either. The page checks in while it is
     * open, and this test plays that page: check in for several idle windows'
     * worth of time and confirm the port stays up the whole way.
     */
    const aliveUrl = `http://127.0.0.1:${port}/__aetheris/alive`;
    const beat = () => fetch(aliveUrl, { cache: 'no-store' }).then((r) => r.ok).catch(() => false);

    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (!(await beat())) throw new Error(`liveness check-in ${i + 1} failed — the page would lose its server`);
    }
    console.log('  stays up while the open page checks in ✓');

    // And a reload mid-session must still land on a live port — this is the
    // exact thing the player does after an error card.
    const reload = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status).catch(() => 0);
    if (reload !== 200) throw new Error(`a reload during play answered ${reload}`);

    // Only when the page stops checking in does the launcher shut down.
    const closed = await new Promise((resolve) => {
      const deadline = Date.now() + 12000;
      const poll = async () => {
        const ok = await fetch(`http://127.0.0.1:${port}/`).then(() => true).catch(() => false);
        if (!ok) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 250);
      };
      poll();
    });
    if (!closed) throw new Error('the server never shut down after the page closed');
    console.log('  shuts down after the page goes away ✓');
  } finally {
    child.kill('SIGKILL');
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  console.log('▸ building web bundle…');
  await build({ root: ROOT, logLevel: 'warn' });

  const indexPath = path.join(DIST, 'index.html');
  const raw = await fsp.readFile(indexPath, 'utf8');
  const { html, assets } = inlineBundle(raw);
  const payload = Buffer.from(html, 'utf8');
  console.log(`  inlined ${assets} asset(s) → ${(payload.length / 1024).toFixed(0)} KB`);

  /*
   * The bundle must not run before the elements it looks up exist.
   *
   * This is a regression guard with a real failure behind it: the inliner used
   * to strip `type="module"`, turning a deferred head script into an immediate
   * one. main.js then ran with document.body === null, threw on the first
   * getElementById that returned null, and the game stopped on its loading
   * screen with no error card — the crash card could not be shown because
   * #fatal did not exist yet either.
   */
  {
    const bodyAt = html.search(/<body[^>]*>/i);
    const closeAt = html.search(/<\/body\s*>/i);
    if (bodyAt < 0 || closeAt < 0) throw new Error('payload has no <body>');
    const head = html.slice(0, bodyAt);

    // No executable script may sit in the head: a classic one runs too early,
    // and a module one would need a second request that cannot exist in a
    // single file.
    const headScripts = head.match(/<script(?![^>]*\stype=)/gi) || [];
    if (headScripts.length) {
      throw new Error(`${headScripts.length} classic script(s) run in <head>, before the DOM exists`);
    }

    // The game bundle must be in the body and parsed into it.
    const body = html.slice(bodyAt, closeAt);
    if (!/game did not start/.test(body)) throw new Error('the boot watchdog is not in <body>');
    if (/<script[^>]*\ssrc=/.test(html)) throw new Error('a script src survived inlining');

    console.log('  the bundle runs after the DOM exists ✓');
  }

  await fsp.mkdir(BUILD, { recursive: true });
  await fsp.mkdir(RELEASE, { recursive: true });

  // The launcher now serves the payload over loopback HTTP, which is what makes
  // online play work from a real origin. Verify that server before shipping:
  // compile it natively and fetch the real payload through it.
  console.log('▸ verifying the loopback server…');
  await verifyLocalServer(html);

  const zig = findZig();
  const stub = path.join(BUILD, 'launcher.exe');
  console.log(`▸ compiling launcher with ${zig}…`);
  execFileSync(
    zig,
    [
      'cc',
      '-target', 'x86_64-windows-gnu',
      '-O2',
      '-w',
      '-Wl,--subsystem,windows',
      '-Wl,-s',
      '-o', stub,
      path.join(ROOT, 'launcher', 'launcher.c'),
      // Winsock is needed by the loopback server that hosts the payload.
      '-lws2_32',
    ],
    { stdio: 'inherit', cwd: ROOT }
  );

  const stubBytes = await fsp.readFile(stub);
  const trailer = Buffer.alloc(24);
  trailer.write(MAGIC, 0, 'ascii');
  trailer.writeBigUInt64LE(BigInt(payload.length), 16);

  const exePath = path.join(RELEASE, 'Aetheris.exe');
  await fsp.writeFile(exePath, Buffer.concat([stubBytes, payload, trailer]));

  const stats = await fsp.stat(exePath);
  console.log(`▸ wrote ${path.relative(ROOT, exePath)} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  // Also drop the standalone html next to it: same build, playable in any browser.
  const htmlPath = path.join(RELEASE, 'Aetheris.html');
  await fsp.writeFile(htmlPath, html);
  console.log('▸ wrote release/Aetheris.html');

  // Re-read what we shipped and prove the payload survived the append intact,
  // and that the launcher really is going to serve it over loopback rather
  // than fall back to file://. A trailer mistake here produces an .exe that is
  // only broken on the user's machine.
  const shipped = await fsp.readFile(exePath);
  const trailerAt = shipped.length - 24;
  if (shipped.subarray(trailerAt, trailerAt + 16).toString('ascii') !== MAGIC) {
    throw new Error('payload trailer magic is missing from the exe');
  }
  const declared = Number(shipped.readBigUInt64LE(trailerAt + 16));
  if (declared !== payload.length) {
    throw new Error(`trailer declares ${declared} bytes, payload is ${payload.length}`);
  }
  const embedded = shipped.subarray(trailerAt - declared, trailerAt);
  if (!embedded.equals(payload)) throw new Error('embedded payload does not match the built html');

  const stubBytes2 = shipped.subarray(0, shipped.length - declared - 24);
  const wide = (t) => Buffer.from(t, 'utf16le');
  if (!stubBytes2.includes(wide('http://127.0.0.1:'))) {
    throw new Error('launcher does not serve over loopback — online play would use a file:// origin');
  }
  console.log(`  exe verified: payload ${(declared / 1024).toFixed(0)} KB intact, loopback server present ✓`);
}

main().catch((err) => {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
});
