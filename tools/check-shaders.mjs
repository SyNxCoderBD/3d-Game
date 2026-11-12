import { parser } from '@shaderfrog/glsl-parser';
import fs from 'node:fs';
const files = ['src/world/sky-glsl.js','src/world/sky.js','src/world/water.js','src/world/vegetation.js','src/fx/postprocessing.js','src/world/particles.js'];
const src = files.map(f=>fs.readFileSync(f,'utf8')).join('\n');
const blocks = [...src.matchAll(/\/\* glsl \*\/`([\s\S]*?)`/g)].map(m=>m[1].replace(/\$\{[^}]*\}/g,''));
let bad=0;
blocks.forEach((b,i)=>{
  try { parser.parse(b, { quiet: true }); }
  catch(e){ bad++; console.log(`block ${i} ERROR: ${e.message}`); }
});
console.log(bad? `${bad}/${blocks.length} blocks failed` : `all ${blocks.length} glsl blocks parse cleanly`);

// terrain shader injections
const terrain = fs.readFileSync('src/world/terrain.js','utf8');
const snippets = [...terrain.matchAll(/`#include <common>\n([\s\S]*?)`/g)].map(m=>m[1]).concat(
  [...terrain.matchAll(/`#include <color_fragment>\n([\s\S]*?)`/g)].map(m=>m[1]),
  [...terrain.matchAll(/`#include <roughnessmap_fragment>\n([\s\S]*?)`/g)].map(m=>m[1])
);
console.log('terrain snippets:', snippets.length);
snippets.forEach((s,i)=>{
  // snippet 0 is injected at global scope (varying + helper functions),
  // the rest are statements injected inside main().
  const code = i === 0 ? s : 'void main(){' + s + '}';
  try { parser.parse(code, { quiet: true }); }
  catch (e) { bad++; console.log(`terrain snippet ${i} ERROR: ${e.message}\n${s}`); }
});
if (bad) { console.error("FAILURES"); process.exitCode = 1; } else { console.log("all shader sources OK"); }
