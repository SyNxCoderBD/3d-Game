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
  A complete static website. One file: index.html. It contains the game, its
  styles and its code. There is nothing to install and nothing to build.

HOW TO PUT IT ONLINE
  Any static host works. Unzip and upload index.html.

    Netlify      drag the folder onto https://app.netlify.com/drop
    Vercel       vercel deploy --prod  (from this folder)
    GitHub Pages commit index.html to a repo, enable Pages
    Cloudflare   wrangler pages deploy .
    S3 / nginx   copy index.html to the web root

  Self-hosting in the same folder also works:

    python3 -m http.server 8080    then open http://localhost:8080/

  Open it over http:// rather than double-clicking the file. A file:// page is
  an opaque origin: the browser blocks the cross-origin calls the online
  multiplayer needs. Single-player works either way.

WHAT WORKS
  Everything: split-screen, bot practice, the full weapon set, online rooms.

WHAT IS DIFFERENT FROM THE WINDOWS BUILD
  The .exe ships its own loopback server, which lets it hand a downloaded
  update to the launcher for the next start. The web build has no launcher, so
  it plays the version it was deployed as. Everything else is identical - it is
  the same game code.

CONTROLS
  Keyboard + mouse, or a gamepad. Both are used in the game itself; the menu
  has the full list.
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
   * release/Aetheris.html is the published artifact: the updater downloads it
   * from a committed URL, so it must stay committed and byte-stable. It is the
   * same document as the zip's index.html, just without the README.
   */
  await fsp.writeFile(path.join(RELEASE, 'Aetheris.html'), html, 'utf8');

  const siteDir = path.join(RELEASE, `aetheris-web-${VERSION}`);
  await fsp.rm(siteDir, { recursive: true, force: true });
  await fsp.mkdir(siteDir, { recursive: true });
  await fsp.writeFile(path.join(siteDir, 'index.html'), html, 'utf8');
  await fsp.writeFile(path.join(siteDir, 'README.txt'), README, 'utf8');

  // 404 is served by most hosts for unknown paths; give them the game rather
  // than a bare error if someone mistypes the URL.
  await fsp.copyFile(path.join(siteDir, 'index.html'), path.join(siteDir, '404.html'));

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
