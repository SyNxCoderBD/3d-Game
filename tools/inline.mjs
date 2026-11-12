/**
 * Turn a Vite build into one self-contained HTML file.
 *
 * Shared by the .exe packer and the web zip so the two can never ship
 * different documents. The rules encoded here are all regressions that shipped:
 *
 *  1. Timing. A `type="module"` script in <head> is deferred, so it runs after
 *     the document is parsed. Inlining it as a classic script makes it run
 *     immediately, while document.body is null — the game then dies on its
 *     first getElementById and cannot even show its crash card. Deferred
 *     bundles move to the end of <body>.
 *  2. `$` in replacement strings. Minified game code contains `$&` and `$'`,
 *     which String.replace expands, splicing markup into the bundle. Every
 *     insertion here is done by index instead.
 */
import fs from 'node:fs';
import path from 'node:path';

export function inlineBundle(html, { dist }) {
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
    const file = path.join(dist, src.replace(/^\.?\//, ''));
    const code = fs.readFileSync(file, 'utf8');
    if (code.includes('</script')) throw new Error('Bundle contains a literal </script>');
    assets++;

    const isModule = /type="module"/.test(before + after);
    const key = `@@AETHERIS_BUNDLE_${placeholders.length}@@`;
    placeholders.push({ key, code: `<script>\n${code}\n</script>`, defer: isModule });
    return key;
  });

  out = out.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (match, href) => {
    const file = path.join(dist, href.replace(/^\.?\//, ''));
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

