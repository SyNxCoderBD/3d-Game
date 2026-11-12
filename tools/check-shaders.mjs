#!/usr/bin/env node
/**
 * GLSL syntax check for every shader source in the project.
 * Blocks are extracted from the tagged template literals and parsed; if a
 * block is a statement list rather than a translation unit it is retried
 * wrapped in main().
 */
import { parser } from '@shaderfrog/glsl-parser';
import fs from 'node:fs';
import path from 'node:path';

const FILES = [
  'src/world/sky-glsl.js',
  'src/world/sky.js',
  'src/world/water.js',
  'src/world/vegetation.js',
  'src/world/terrain.js',
  'src/world/particles.js',
];

let bad = 0;
let checked = 0;

function tryParse(code) {
  parser.parse(code, { quiet: true });
}

for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const blocks = [...src.matchAll(/\/\* glsl \*\/`([\s\S]*?)`/g)]
    // strip template interpolation (the parser only checks syntax)
    .map((m) => m[1].replace(/\$\{[^}]*\}/g, ''));
  blocks.forEach((block, i) => {
    checked++;
    try {
      tryParse(block);
    } catch (first) {
      try {
        tryParse('void main(){' + block + '}');
      } catch (second) {
        bad++;
        console.error(`✗ ${file} block ${i}: ${second.message}`);
        console.error(block.split('\n').slice(0, 6).join('\n'));
      }
    }
  });
}

// Also validate the shader chunk replacements used by the terrain material.
const terrain = fs.readFileSync('src/world/terrain.js', 'utf8');
const names = [...terrain.matchAll(/const (\w+_GLSL) = /g)].map((m) => m[1]);
for (const name of names) {
  const re = new RegExp('const ' + name + ' = /\\* glsl \\*/`([\\s\\S]*?)`;');
  const m = terrain.match(re);
  if (!m) continue;
  checked++;
  const code = m[1].replace(/\$\{[^}]*\}/g, '');
  try {
    tryParse(code);
  } catch (_) {
    try {
      tryParse('void main(){' + code + '}');
    } catch (e2) {
      bad++;
      console.error(`✗ terrain ${name}: ${e2.message}`);
    }
  }
}

if (bad) {
  console.error(`\n${bad} of ${checked} shader block(s) failed to parse`);
  process.exit(1);
}
console.log(`all ${checked} shader blocks parse cleanly`);
