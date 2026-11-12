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

  out = out.replace(
    /<script[^>]*\ssrc="([^"]+)"[^>]*>\s*<\/script>/g,
    (match, src) => {
      const file = path.join(DIST, src.replace(/^\.?\//, ''));
      const code = fs.readFileSync(file, 'utf8');
      if (code.includes('</script')) throw new Error('Bundle contains a literal </script>');
      assets++;
      return `<script>\n${code}\n</script>`;
    }
  );

  out = out.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (match, href) => {
    const file = path.join(DIST, href.replace(/^\.?\//, ''));
    const css = fs.readFileSync(file, 'utf8');
    assets++;
    return `<style>\n${css}\n</style>`;
  });

  // Any leftover asset references mean the page would break in a single file.
  const leftover = out.match(/(?:src|href)="\.?\/?assets\/[^"]+"/g);
  if (leftover) throw new Error(`Un-inlined assets: ${leftover.join(', ')}`);

  return { html: out, assets };
}

async function main() {
  console.log('▸ building web bundle…');
  await build({ root: ROOT, logLevel: 'warn' });

  const indexPath = path.join(DIST, 'index.html');
  const raw = await fsp.readFile(indexPath, 'utf8');
  const { html, assets } = inlineBundle(raw);
  const payload = Buffer.from(html, 'utf8');
  console.log(`  inlined ${assets} asset(s) → ${(payload.length / 1024).toFixed(0)} KB`);

  await fsp.mkdir(BUILD, { recursive: true });
  await fsp.mkdir(RELEASE, { recursive: true });

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
  await fsp.writeFile(path.join(RELEASE, 'Aetheris.html'), html);
  console.log('▸ wrote release/Aetheris.html');
}

main().catch((err) => {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
});
