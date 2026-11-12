#!/usr/bin/env node
/**
 * Builds the deployable web version of the game.
 *
 *   1. vite build            -> dist/ (single JS bundle + CSS)
 *   2. inline everything     -> one self-contained index.html
 *   3. package              -> release/Aetheris-web-<version>.zip
 *
 * The zip is a static site: unzip it, point any web server at the folder, and
 * the game runs. No build step, no Node, no server-side code, no API keys.
 *
 * Why a single index.html rather than dist/ as-is: the game has no external
 * assets at runtime (no images, audio files or fonts beyond the ones the
 * stylesheet already embeds), so one file is a complete deployment. It also
 * means the same document ships here and inside the Windows launcher — both
 * call tools/inline.mjs, so they cannot drift apart.
 *
 * The one thing that cannot work from a static file is the launcher's update
 * channel (`POST /__aetheris/staged`). The page detects that the server it is
 * served from is not the launcher and simply skips the download; see
 * updateTarget() in src/net/updater.js. Nothing else is affected.
 */
import { build } from 'vite';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inlineBundle } from './inline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'release');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

/**
 * A hosting provider needs a hint that the game is a game, and a README in the
 * zip saves whoever deploys it from guessing.
 */
const README = `AETHERIS - Island Warfare ${VERSION}
${'='.repeat(40)}

WHAT THIS IS
  A complete static website that keeps itself up to date.

      index.html   the boot shell: picks which build to open (small, stable)
      game.html    the game as shipped in this zip (the fallback)
      sw.js        serves a browser-downloaded build at the site's own origin

HOW TO PUT IT ONLINE
  Any static host works. Upload all three files to the same folder.

    Netlify      drag the folder onto https://app.netlify.com/drop
    Vercel       vercel deploy --prod  (from this folder)
    GitHub Pages commit the three files to a repo, enable Pages
    Cloudflare   wrangler pages deploy .
    S3 / nginx   copy the files to the web root

  Must be served over http:// or https:// - not opened as a file. The browser
  needs a real origin for the service worker and for online multiplayer.

SELF-UPDATES
  On every load the shell asks the release channel what the newest build is.
  If it is newer than what the player has, it downloads it, checks its SHA-256
  against the published hash, caches it, and opens it. A released version
  reaches players on their next visit without you redeploying anything.

  If the download fails, is tampered with, or the player is offline, the game
  falls back to the copy in this zip and plays normally. The game cannot be
  broken by a bad update.

  The shell (index.html) is meant never to need replacing again. Only repackage
  if the fallback build itself should move.

CONTROLS
  Keyboard + mouse, or a gamepad. The menu lists the full set.
`;

function findZip() {
  for (const candidate of ['zip']) {
    try {
      execFileSync(candidate, ['-v'], { stdio: 'pipe' });
      return candidate;
    } catch {
      /* not installed */
    }
  }
  throw new Error('the `zip` command is required to build the web package');
}

async function main() {
  console.log('▸ building web bundle…');
  await build({ root: ROOT, logLevel: 'warn' });

  const indexPath = path.join(DIST, 'index.html');
  const raw = await fsp.readFile(indexPath, 'utf8');
  const { html, assets } = inlineBundle(raw, { dist: DIST });
  console.log(`  inlined ${assets} asset(s) → ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);

  /*
   * The same two checks the exe build makes, for the same reason: a bundle
   * that runs before the DOM exists leaves the player on a frozen loading
   * screen with no error. Shipping that to a host would be worse than shipping
   * it in an exe, because there is no launcher to blame.
   */
  const bodyAt = html.search(/<body[^>]*>/i);
  const closeAt = html.search(/<\/body\s*>/i);
  if (bodyAt < 0 || closeAt < 0) throw new Error('payload has no <body>');
  const headScripts = (html.slice(0, bodyAt).match(/<script(?![^>]*\stype=)/gi) || []).length;
  if (headScripts) throw new Error(`${headScripts} classic script(s) run in <head>, before the DOM exists`);
  const bundleAt = html.indexOf('<script>');
  if (!(bundleAt > bodyAt && bundleAt < closeAt)) throw new Error('the game bundle is not inside <body>');
  if (/<script[^>]*\ssrc=/.test(html)) throw new Error('a script src survived inlining');
  console.log('  the bundle runs after the DOM exists ✓');

  // A deployed site must not claim it can reach a launcher that is not there.
  if (!/__aetheris\/staged/.test(html)) throw new Error('the updater endpoint check went missing');
  console.log('  single file, no external assets ✓');

  await fsp.mkdir(RELEASE, { recursive: true });

  /*
   * release/Aetheris.html is the published artifact: the release channel and
   * the updater both fetch it from a committed URL, so it must stay committed
   * and byte-stable.
   */
  await fsp.writeFile(path.join(RELEASE, 'Aetheris.html'), html, 'utf8');

  /*
   * The deployed site is three files:
   *
   *   index.html  the boot shell — small, and meant never to change again
   *   game.html   this build, used when the shell cannot download a newer one
   *   sw.js       serves a downloaded build at the site's own origin
   *
   * Separation is the whole point: a new release is published to the release
   * channel, and browsers pick it up through the shell without the hosted
   * files changing at all.
   */
  const shellPath = path.join(ROOT, 'web', 'shell.html');
  const shellTemplate = await fsp.readFile(shellPath, 'utf8');

  const net = await fsp.readFile(path.join(ROOT, 'src', 'net', 'net.js'), 'utf8');
  const supabaseUrl = (net.match(/SUPABASE_URL = '([^']+)'/) || [])[1];
  const anonKey = (net.match(/SUPABASE_ANON_KEY = '([^']+)'/) || [])[1];
  if (!supabaseUrl || !anonKey) throw new Error('could not read the Supabase credentials from src/net/net.js');

  const shell = shellTemplate
    .replace('__SUPABASE_URL__', supabaseUrl)
    .replace('__SUPABASE_ANON_KEY__', anonKey)
    .replace(/__CHANNEL__/g, 'stable')
    .replace(/__VERSION__/g, VERSION);

  if (/__[A-Z_]+__/.test(shell)) throw new Error('the boot shell has an unfilled placeholder');
  if (/<script[^>]*\ssrc=/.test(shell)) throw new Error('the boot shell must stay inline and self-contained');
  if (!/serviceWorker/.test(shell)) throw new Error('the boot shell lost its service worker wiring');

  const sw = await fsp.readFile(path.join(ROOT, 'web', 'sw.js'), 'utf8');
  if (!/aetheris-game-v1/.test(sw)) throw new Error('the service worker cache name changed unexpectedly');

  const siteDir = path.join(RELEASE, `aetheris-web-${VERSION}`);
  await fsp.rm(siteDir, { recursive: true, force: true });
  await fsp.mkdir(siteDir, { recursive: true });
  await fsp.writeFile(path.join(siteDir, 'index.html'), shell, 'utf8');
  await fsp.writeFile(path.join(siteDir, 'game.html'), html, 'utf8');
  await fsp.writeFile(path.join(siteDir, 'sw.js'), sw, 'utf8');
  await fsp.writeFile(path.join(siteDir, 'README.txt'), README, 'utf8');
  console.log(`  site: index.html (${(Buffer.byteLength(shell) / 1024).toFixed(1)} KB shell) + game.html (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB) + sw.js`);

  const zipPath = path.join(RELEASE, `Aetheris-web-${VERSION}.zip`);
  await fsp.rm(zipPath, { force: true });
  execFileSync(findZip(), ['-r', '-9', '-q', path.basename(zipPath), `aetheris-web-${VERSION}`], {
    cwd: RELEASE,
    stdio: 'inherit',
  });

  const { size } = await fsp.stat(zipPath);
  console.log(`▸ wrote ${path.relative(ROOT, zipPath)} (${(size / 1024).toFixed(0)} KB)`);
  console.log(`  deploy: unzip and serve index.html as a static site`);
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
