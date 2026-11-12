#!/usr/bin/env node
/**
 * Headless smoke test: builds every world system in Node (three.js works
 * without a GL context for geometry/material construction) and checks for
 * NaNs, empty meshes and sane statistics. Catches most runtime errors
 * before the game ever reaches a GPU.
 */
import * as THREE from 'three';

globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener() {}, innerWidth: 1600, innerHeight: 900 };
globalThis.document = globalThis.document || { addEventListener() {} };

const { WORLD, terrainHeight, terrainSlope } = await import('../src/world/heightfield.js');
const { createTerrain } = await import('../src/world/terrain.js');
const { createWater } = await import('../src/world/water.js');
const { createSky } = await import('../src/world/sky.js');
const { createGrass, createProps } = await import('../src/world/vegetation.js');
const { createMotes } = await import('../src/world/particles.js');
const { applyPreset } = await import('../src/world/environment.js');
const { buildSpawnPoints } = await import('../src/game/spawns.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  else { console.error(`  ✗ ${name} ${extra}`); failures++; }
};

function scanGeometry(geo, label) {
  const pos = geo.attributes.position;
  let nan = 0;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nan++;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  check(`${label} finite vertices`, nan === 0, `${pos.count} verts, y ${minY.toFixed(1)}..${maxY.toFixed(1)}`);
  return nan === 0;
}

console.log('\n▸ environment presets');
for (let i = 0; i < 3; i++) {
  const p = applyPreset(i);
  check(`preset "${p.name}"`, Number.isFinite(p.sunIntensity) && p.fogDensity > 0);
}

console.log('\n▸ height field');
let min = Infinity, max = -Infinity, wet = 0, samples = 0;
for (let z = -800; z <= 800; z += 10) {
  for (let x = -800; x <= 800; x += 10) {
    const h = terrainHeight(x, z);
    if (!Number.isFinite(h)) { failures++; console.error('  ✗ NaN height at', x, z); }
    min = Math.min(min, h); max = Math.max(max, h);
    if (h < 0) wet++;
    samples++;
  }
}
check('heights finite', true, `range ${min.toFixed(1)} .. ${max.toFixed(1)}`);
check('island peaks above 100m', max > 100, `${max.toFixed(1)}m`);
check('sea covers part of map', wet / samples > 0.3, `${((wet / samples) * 100).toFixed(0)}% below sea level`);

const spawnList = buildSpawnPoints(14);
const spawn = spawnList[0].position;
const spawnH = terrainHeight(spawn.x, spawn.z);
check('spawn points found', spawnList.length >= 8 && spawnH > 4, `${spawnList.length} points, h=${spawnH.toFixed(1)}`);
check('spawn slope walkable', terrainSlope(spawn.x, spawn.z) < 0.35, terrainSlope(spawn.x, spawn.z).toFixed(2));

// Landform sanity: real hills, no needles.
console.log('\n▸ slopes');
let steep = 0, slTotal = 0, maxSlope = 0;
for (let z = -460; z <= 460; z += 8) {
  for (let x = -460; x <= 460; x += 8) {
    const h = terrainHeight(x, z);
    if (h < 1) continue;
    const e = 4;
    const gx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
    const gz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
    const slope = Math.hypot(gx, gz);
    maxSlope = Math.max(maxSlope, slope);
    if (slope > 0.84) steep++;   // > 40 degrees
    slTotal++;
  }
}
const maxDeg = (Math.atan(maxSlope) * 180 / Math.PI);
check('no vertical spikes', maxDeg < 58, `max slope ${maxDeg.toFixed(0)}°`);
check('mostly walkable land', steep / slTotal < 0.14, `${((steep / slTotal) * 100).toFixed(1)}% steeper than 40°`);

console.log('\n▸ meshes');
const t0 = performance.now();
const terrain = createTerrain();
scanGeometry(terrain.geometry, 'terrain');
check('terrain has vertex colours', !!terrain.geometry.attributes.color);

const water = createWater();
check('ocean built', water.material.uniforms.uHeightMap.value.image.width === 256);

const sky = createSky(5000);
check('sky built', sky.geometry.attributes.position.count > 0);

const props = createProps();
check('trees placed', props.treeCount > 100, `${props.treeCount}`);
check('rocks placed', props.rockCount > 100, `${props.rockCount}`);
check('bushes placed', props.bushCount > 100, `${props.bushCount}`);
for (const child of props.group.children) {
  check(`props mesh (${child.count} instances)`, child.geometry.attributes.position.count > 0 && child.count > 0);
}

const grass = createGrass();
grass.rebuild(spawn.x, spawn.z);
check('grass placed', grass.count > 5000, `${grass.count} clumps around spawn`);
check('grass meshes', grass.group.children.length > 0, `${grass.group.children.length} draw calls`);

const motes = createMotes(500, 50);
check('motes built', motes.geometry.attributes.position.count === 500);

const buildMs = performance.now() - t0;
console.log(`\n  world build time: ${buildMs.toFixed(0)} ms`);

let triangles = 0;
const countTris = (obj) => {
  obj.traverse?.((o) => {
    if (o.isMesh || o.isPoints) {
      const g = o.geometry;
      const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      triangles += n * (o.isInstancedMesh ? o.count : 1);
    }
  });
};
countTris(terrain); countTris(props.group); countTris(grass.group);
console.log(`  approx triangles: ${(triangles / 1000).toFixed(0)}k`);

console.log(failures === 0 ? '\n✅ world verification passed\n' : `\n❌ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
