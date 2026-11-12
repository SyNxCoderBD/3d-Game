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
const { Match, STREAKS } = await import('../src/game/match.js');
const { Sfx } = await import('../src/audio/sfx.js');
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
check('fighter built', p1.slots.length === 3 && !!p1.viewGun && !!p1.bodyGun);

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
  fire: false, aim: false, reload: false, swap: false, slot: 0, med: false,
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

// --- loot dropped by the dead
const dropOwner = new Fighter({ id: 'drop', name: 'DROP', scene, isBot: true, bodyLayer: 0, palette: 'botA', spawnPoints: spawns });
dropOwner.spawnAt({ x: p1.position.x + 3, y: p1.position.y, z: p1.position.z + 3 }, 0);
dropOwner.giveWeapon('sniper');
const dropItem = pickups.dropFrom(dropOwner);
check('death drops the held weapon', !!dropItem && dropItem.type === 'sniper' && dropItem.drop === true, dropItem?.type);
const countBefore = pickups.items.length;
dropOwner.position.copy(dropItem.position);
dropOwner.position.y -= 0.8;
dropOwner.alive = true;
pickups.update(1 / 60, [dropOwner]);
check('dropped weapon can be collected', pickups.items.length === countBefore - 1);
const timed = pickups.addItem('smg', { x: p1.position.x, y: p1.position.y, z: p1.position.z }, 'drop');
const beforeExpire = pickups.items.length;
for (let i = 0; i < 3000; i++) pickups.update(1 / 60, []);
check('untouched drops expire', pickups.items.length === beforeExpire - 1, `${Math.round(timed.ttl)}s ttl`);

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

// --- three weapon slots
console.log('\n▸ loadout');
check('starts with three slots', p1.slots.length === 3, p1.slots.map((s) => s.id).join(' / '));
p1.spawnProtect = 0;
p1.spawnAt(p1.position, 0);
p1.giveWeapon('sniper');
check('loot fills the free slot', p1.slots.some((s) => s.id === 'sniper'), p1.slots.map((s) => s.id).join(' / '));
const sniperSlot = p1.slots.findIndex((s) => s.id === 'sniper');
p1.swapTimer = 0;
p1.selectSlot(sniperSlot);
check('selectSlot switches', p1.slot === sniperSlot, `slot ${p1.slot} → ${p1.weapon.short}`);
check('gun model follows slot', !!p1.viewGun && p1._gunId === 'sniper');
p1.aimT = 1;
p1.updateViewmodel(0.016);
check('scope hides the viewmodel', p1.viewGun.visible === false);

// --- aim assist pulls the reticle toward a target
const assistBot = new Fighter({
  id: 'assist', name: 'AB', scene, isBot: true, bodyLayer: 0,
  palette: 'botA', spawnPoints: spawns,
});
const pa = new Fighter({
  id: 'pa', name: 'PA', scene, camera: new THREE.PerspectiveCamera(78, 1.6, 0.03, 6000),
  bodyLayer: 4, viewLayer: 1, palette: 'p1', spawnPoints: spawns,
});
// Place both on level ground so the assist cone test is deterministic.
pa.position.set(0, sampleHeight(0, 0), 0);
pa.alive = true;
assistBot.position.set(0, pa.position.y, -14);   // 14 m straight ahead of yaw 0
assistBot.alive = true;
assistBot.crouching = false;
pa.pitch = 0;
pa.yaw = 0.12;                     // just right of the bot
const assist = pa.computeAimAssist([pa, assistBot]);
check('aim assist finds target', !!assist && Math.abs(assist.x) > 0.0001, assist ? `dx ${assist.x.toFixed(4)}` : 'none');

// --- match rules + scoreboard
console.log('\n▸ match');
const match = new Match({ mode: 'duo', killLimit: 5, timeLimit: 60 });
const A = new Fighter({ id: 'A', name: 'ALPHA', scene, isBot: false, bodyLayer: 0, palette: 'p1', spawnPoints: spawns });
const B = new Fighter({ id: 'B', name: 'BRAVO', scene, isBot: false, bodyLayer: 0, palette: 'p2', spawnPoints: spawns });
A.spawnAt(s0.position, 0);
B.spawnAt({ x: s0.position.x + 2, y: s0.position.y, z: s0.position.z }, 0);
let streakEvent = null;
for (let i = 0; i < 3; i++) {
  match.hit(A, i === 1, 30);
  B.health = 100;
  B.alive = true;
  B.spawnProtect = 0;
  B.takeDamage(200, A);
  const res = match.kill(A, B);
  if (res?.milestone) streakEvent = res;
}
check('kills tracked', match.stat(A).kills === 3, `A killed B ${match.stat(A).kills}×`);
check('deaths tracked', match.stat(B).deaths === 3);
check('shots-accurate damage totals', match.stat(A).damage === 90);
check('headshot counted', match.stat(A).headshots === 1);
check('kill streak milestone', match.stat(A).streak === 3 && streakEvent?.milestone === STREAKS[3], streakEvent?.milestone);

B.lastHitBy = A;
const rows = match.results([A, B]);
check('scoreboard sorted', rows[0].fighter === A && rows[0].kills === 3);

// kill limit ends the match
A.alive = true; B.alive = true; B.spawnProtect = 0;
A.kills = 4;
B.takeDamage(999, A);
const fin = match.kill(A, B);
check('kill limit ends duel', fin?.over === true && match.winner === A, `${A.kills} kills`);
check('clock stops at over', (() => { const c = match.clock; match.update(5); return match.clock === c; })());

// timeout resolves to the leader
const m2 = new Match({ mode: 'duo', killLimit: 99, timeLimit: 10 });
m2.stat(A).kills = 4;
m2.stat(B).kills = 2;
m2.update(11);
check('time limit ends duel', m2.over && m2.reason === 'time');
check('timeout awards the leader', m2.resolveTimeoutWinner([A, B]) === A);

// solo run ends when the player dies
const m3 = new Match({ mode: 'solo' });
m3.kill(bot, p1);
check('solo run ends on player death', m3.over && m3.winner === bot);

// --- combat audio synthesis (offline AudioContext not available: check API shape)
console.log('\n▸ audio');
const sfx = new Sfx();
check('sfx builds without an audio context', typeof sfx.shot === 'function' && sfx.ready === false);
const panel = new Sfx();
class FakeParam { constructor(v) { this.value = v; } setValueAtTime() { return this; } exponentialRampToValueAtTime() { return this; } setTargetAtTime() { return this; } }
class FakeNode {
  constructor() {
    this.gain = new FakeParam(1); this.frequency = new FakeParam(440); this.Q = new FakeParam(1);
    this.pan = new FakeParam(0); this.playbackRate = new FakeParam(1); this.type = 'sine';
    this.threshold = new FakeParam(0); this.knee = new FakeParam(0); this.ratio = new FakeParam(1);
    this.attack = new FakeParam(0); this.release = new FakeParam(0);
  }
  connect() { return this; }
  start() {} stop() {}
}
class FakeCtx {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = new FakeNode(); }
  createGain() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createOscillator() { return new FakeNode(); }
  createStereoPanner() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
}
panel.attach(new FakeCtx());
cam.position.set(0, 2, 0);
cam.updateMatrixWorld();
let audioOk = true;
try {
  panel.setListeners([cam]);
  for (const kind of ['pistol', 'smg', 'rifle', 'shotgun', 'sniper']) {
    panel.shot(kind, new THREE.Vector3(5, 1, 5), true);
    panel.shot(kind, new THREE.Vector3(300, 1, -200), false);
  }
  panel.hit(true); panel.hurt(); panel.death(); panel.pickup('medkit');
  panel.streak(5); panel.announce('victory'); panel.reloadStart('rifle'); panel.reloadEnd();
} catch (err) {
  audioOk = false;
  console.error('   audio error:', err.message);
}
check('all shot kinds synthesise', audioOk);
check('spatial falloff is quieter far away', (() => {
  const near = panel.spatial(new THREE.Vector3(1, 1, 1));
  const far = panel.spatial(new THREE.Vector3(500, 1, 500));
  return far.gain < near.gain;
})());

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
