#!/usr/bin/env node
/**
 * Headless gameplay smoke test: builds the island, spawns a player and bots,
 * fires weapons, collects pickups and runs a few hundred simulated frames.
 * Catches NaN physics, broken hit detection, AI crashes and model build errors
 * without needing a GPU.
 */
import * as THREE from 'three';

globalThis.window = globalThis.window || {
  devicePixelRatio: 1, addEventListener() {}, innerWidth: 1600, innerHeight: 900,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
};
globalThis.document = globalThis.document || { addEventListener() {}, createElement: () => ({ getContext: () => ({}) }) };
try {
  if (!globalThis.navigator) globalThis.navigator = { getGamepads: () => [] };
} catch (_) { /* node exposes a read-only navigator */ }

const { createTerrain } = await import('../src/world/terrain.js');
const { buildSpawnPoints, buildPickupSpots } = await import('../src/game/spawns.js');
const { Fighter } = await import('../src/game/fighter.js');
const { BotBrain } = await import('../src/game/ai.js');
const { Pickups } = await import('../src/game/pickups.js');
const { hitscan } = await import('../src/game/combat.js');
const { createWeaponModel, WEAPONS } = await import('../src/game/weapons.js');
const { createCharacter } = await import('../src/game/character.js');
const { sampleHeight } = await import('../src/world/heightgrid.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  else { console.error(`  ✗ ${name} ${extra}`); failures++; }
};

console.log('\n▸ models');
for (const id of Object.keys(WEAPONS)) {
  const model = createWeaponModel(id);
  let meshes = 0;
  model.traverse((o) => { if (o.isMesh) meshes++; });
  const muzzle = model.userData.muzzle;
  check(`weapon "${id}"`, meshes >= 3 && meshes <= 10 && !!muzzle, `${meshes} parts, muzzle ${muzzle ? 'yes' : 'missing'}`);
}
const char = createCharacter('p1');
let charMeshes = 0;
char.root.traverse((o) => { if (o.isMesh) charMeshes++; });
check('character rig', charMeshes >= 12 && charMeshes <= 30 && char.armL && char.legR && char.gunMount, `${charMeshes} meshes`);

console.log('\n▸ world');
const scene = new THREE.Scene();
const terrain = createTerrain();
scene.add(terrain);
const spawns = buildSpawnPoints(14);
check('spawn points', spawns.length >= 8, `${spawns.length}`);
const spots = buildPickupSpots(26);
check('pickup spots', spots.length > 10, `${spots.length}`);

console.log('\n▸ pickups');
const pickups = new Pickups(scene, spots);
check('pickups spawned', pickups.items.length === spots.length, `${pickups.items.length} items`);
const types = new Set(pickups.items.map((i) => i.type));
check('pickup variety', types.size >= 3, [...types].join(', '));

console.log('\n▸ fighters');
const effects = {
  tracer() {}, impact() {}, update() {},
};

const cam = new THREE.PerspectiveCamera(78, 1.6, 0.03, 6000);
const p1 = new Fighter({
  id: 'p1', name: 'P1', scene, camera: cam, bodyLayer: 4, viewLayer: 1,
  palette: 'p1', spawnPoints: spawns,
});
const bot = new Fighter({
  id: 'bot', name: 'BOT', scene, isBot: true, bodyLayer: 0,
  palette: 'botA', spawnPoints: spawns,
});
check('fighter built', p1.slots.length === 2 && !!p1.viewGun && !!p1.bodyGun);

const s0 = spawns[0];
p1.spawnAt(s0.position, 0);

// place the bot 12 m in front of the player, on the ground
const bx = p1.position.x - Math.sin(p1.yaw) * 12;
const bz = p1.position.z - Math.cos(p1.yaw) * 12;
bot.spawnAt({ x: bx, y: sampleHeight(bx, bz), z: bz }, Math.PI);
check('spawned above ground', p1.position.y > sampleHeight(p1.position.x, p1.position.z) - 1.5);

// aim exactly at the bot's chest, then fire
const aimAtBot = () => {
  const dx = bot.position.x - p1.position.x;
  const dz = bot.position.z - p1.position.z;
  const dy = (bot.position.y + 1.2) - (p1.position.y + 1.62);
  p1.yaw = Math.atan2(-dx, -dz);
  p1.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  p1.recoilPitch = 0;
};

const eye = p1.getEyePosition(new THREE.Vector3());
aimAtBot();
const dir = p1.getAimDirection(new THREE.Vector3());
const hit = hitscan(eye, dir, 80, [p1, bot], p1);
check('hitscan hits the bot', hit.victim === bot, `${hit.distance.toFixed(1)} m`);

const beforeHp = bot.health;
bot.spawnProtect = 0;
p1.spawnProtect = 0;
aimAtBot();
p1.cooldown = 0;
p1.tryFire({ fighters: [p1, bot], effects });
check('shot did damage', bot.health < beforeHp, `${beforeHp} → ${bot.health.toFixed(0)}`);

// --- movement / physics
const input = {
  forward: 1, strafe: 0, lookX: 0, lookY: 0,
  jump: false, sprint: false, crouch: false,
  fire: false, aim: false, reload: false, swap: false, med: false,
};
const startPos = p1.position.clone();
const ctx = { fighters: [p1, bot], effects, pickups };

let nan = false;
for (let i = 0; i < 240; i++) {
  input.jump = i === 30;
  p1.update(1 / 60, input, ctx);
  if (!Number.isFinite(p1.position.x) || !Number.isFinite(p1.position.y) || !Number.isFinite(p1.position.z)) nan = true;
}
check('player physics stable', !nan);
const moved = startPos.distanceTo(p1.position);
check('player moved', moved > 2, `${moved.toFixed(1)} m in 4 s`);

// --- bot AI
const brain = new BotBrain(bot, spawns, 0.8);
bot.spawnAt({ x: p1.position.x + 20, y: p1.position.y, z: p1.position.z }, Math.PI);
let botMoved = 0;
const botStart = bot.position.clone();
let botFired = false;
for (let i = 0; i < 600; i++) {
  const ai = brain.update(1 / 60, ctx);
  if (ai.fire) botFired = true;
  bot.update(1 / 60, ai, ctx);
  if (!Number.isFinite(bot.position.x)) nan = true;
}
botMoved = botStart.distanceTo(bot.position);
check('bot AI runs', !nan);
check('bot moved', botMoved > 3, `${botMoved.toFixed(1)} m`);
check('bot engaged the player', botFired || bot.kills > 0);

// --- death & respawn
bot.health = 5;
bot.spawnProtect = 0;
bot.takeDamage(50, p1);
check('damage kills', !bot.alive);
check('killer scored', p1.kills === 1);
let respawned = false;
for (let i = 0; i < 400; i++) {
  bot.update(1 / 60, input, ctx);
  if (bot.alive) { respawned = true; break; }
}
check('bot respawns', respawned);

// --- pickups collection
const pk = pickups.items.find((i) => i.type === 'medkit');
p1.slots[0].ammo = 5;
p1.position.set(pk.position.x, pk.position.y - 0.8, pk.position.z);
p1.alive = true;
const medsBefore = p1.medkits;
pickups.update(1 / 60, [p1]);
check('pickup collected', !pk.active, `${pk.type}`);

// --- weapon switching / reload
p1.refreshWeaponModels();
p1.addAmmo(30);
const ammoBefore = p1.slotData.reserve;
p1.startReload();
for (let i = 0; i < 300; i++) p1.update(1 / 60, input, ctx);
check('reload works', p1.slotData.ammo > 0, `mag ${p1.slotData.ammo}/${ammoBefore}`);

const slotBefore = p1.slot;
p1.swapWeapon();
check('weapon swap', p1.slot !== slotBefore, `slot ${p1.slot} → ${p1.slotData.id}`);

let tris = 0;
scene.traverse((o) => {
  if (o.isMesh && o.geometry) {
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
});
console.log(`\n  scene objects: ${scene.children.length}, approx tris (fighters only): ${(tris / 1000).toFixed(0)}k`);

console.log(failures === 0 ? '\n✅ gameplay verification passed\n' : `\n❌ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
