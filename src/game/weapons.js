import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeDirectMeshes } from '../util/merge.js';

/* ------------------------------------------------------------------ data */

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'P-9 SIDEARM',
    short: 'P9',
    damage: 23,
    headMul: 2.2,
    rpm: 420,
    auto: false,
    magSize: 12,
    startReserve: 60,
    maxReserve: 120,
    spread: 0.012,
    adsSpread: 0.0035,
    recoil: 0.016,
    range: 90,
    pellets: 1,
    reloadTime: 1.5,
    adsFov: 58,
    kind: 'pistol',
  },
  smg: {
    id: 'smg',
    name: 'VK-9 SMG',
    short: 'SMG',
    damage: 16,
    headMul: 1.9,
    rpm: 900,
    auto: true,
    magSize: 32,
    startReserve: 120,
    maxReserve: 240,
    spread: 0.016,
    adsSpread: 0.006,
    recoil: 0.010,
    range: 100,
    pellets: 1,
    reloadTime: 1.9,
    adsFov: 60,
    kind: 'smg',
  },
  rifle: {
    id: 'rifle',
    name: 'AR-15 RIFLE',
    short: 'AR15',
    damage: 27,
    headMul: 2.1,
    rpm: 620,
    auto: true,
    magSize: 30,
    startReserve: 120,
    maxReserve: 210,
    spread: 0.009,
    adsSpread: 0.0022,
    recoil: 0.014,
    range: 220,
    pellets: 1,
    reloadTime: 2.2,
    adsFov: 50,
    kind: 'rifle',
  },
  shotgun: {
    id: 'shotgun',
    name: 'M870 BREACHER',
    short: 'M870',
    damage: 12,
    headMul: 1.6,
    rpm: 75,
    auto: false,
    magSize: 6,
    startReserve: 30,
    maxReserve: 48,
    spread: 0.055,
    adsSpread: 0.038,
    recoil: 0.055,
    range: 45,
    pellets: 9,
    reloadTime: 2.8,
    adsFov: 62,
    kind: 'shotgun',
  },
  sniper: {
    id: 'sniper',
    name: 'AWM .338',
    short: 'AWM',
    damage: 88,
    headMul: 2.6,
    rpm: 48,
    auto: false,
    magSize: 5,
    startReserve: 20,
    maxReserve: 40,
    spread: 0.0018,
    adsSpread: 0.0002,
    recoil: 0.07,
    range: 400,
    pellets: 1,
    reloadTime: 3.1,
    adsFov: 26,
    kind: 'sniper',
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

/* ------------------------------------------------------------- materials */

const M = {
  steel: new THREE.MeshStandardMaterial({ color: 0x30353b, metalness: 0.92, roughness: 0.33 }),
  steelLight: new THREE.MeshStandardMaterial({ color: 0x555c64, metalness: 0.95, roughness: 0.26 }),
  polymer: new THREE.MeshStandardMaterial({ color: 0x1a1d20, metalness: 0.18, roughness: 0.7 }),
  polymerTan: new THREE.MeshStandardMaterial({ color: 0x8d7c5c, metalness: 0.08, roughness: 0.78 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x6d4526, metalness: 0.04, roughness: 0.58 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0x49e2d4, emissive: 0x1d9a90, emissiveIntensity: 2.2, metalness: 0.3, roughness: 0.08,
  }),
  accent: new THREE.MeshStandardMaterial({ color: 0xc9a24d, metalness: 0.9, roughness: 0.28 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xb08d3f, metalness: 1.0, roughness: 0.35 }),
};

const GEO_CACHE = new Map();
function boxGeo(w, h, d, r = 0.006) {
  const radius = Math.min(r, Math.min(w, h, d) * 0.34);
  if (radius <= 0.0015) {
    const key = `b${w},${h},${d}`;
    if (!GEO_CACHE.has(key)) GEO_CACHE.set(key, new THREE.BoxGeometry(w, h, d));
    return GEO_CACHE.get(key);
  }
  const key = `r${w},${h},${d},${radius}`;
  if (!GEO_CACHE.has(key)) GEO_CACHE.set(key, new RoundedBoxGeometry(w, h, d, 2, radius));
  return GEO_CACHE.get(key);
}
function cylGeo(rTop, rBot, h, seg = 14) {
  const key = `c${rTop},${rBot},${h},${seg}`;
  if (!GEO_CACHE.has(key)) GEO_CACHE.set(key, new THREE.CylinderGeometry(rTop, rBot, h, seg));
  return GEO_CACHE.get(key);
}

function add(group, geo, mat, pos = [0, 0, 0], rot = null) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  m.castShadow = true;
  m.receiveShadow = false;
  group.add(m);
  return m;
}

const b = (group, w, h, d, mat, pos, rot, r) => add(group, boxGeo(w, h, d, r), mat, pos, rot);
const c = (group, rt, rb, h, mat, pos, rot, seg) => add(group, cylGeo(rt, rb, h, seg), mat, pos, rot);

/* --------------------------------------------------------------- models
   Convention: the muzzle points down -Z, the grip is at the origin, +Y up.
   Everything is modelled at real scale (metres).                        */

/* Named hand anchors. The character rig solves two-bone IK onto these, so the
   soldier's hands actually wrap the grip instead of hanging at their sides.
   `grip` is the strong hand, `foregrip` the support hand. */
function addHandAnchors(g, grip, foregrip) {
  const a = new THREE.Object3D();
  a.name = 'grip';
  a.position.set(grip[0], grip[1], grip[2]);
  g.add(a);
  const b = new THREE.Object3D();
  b.name = 'foregrip';
  b.position.set(foregrip[0], foregrip[1], foregrip[2]);
  g.add(b);
  return g;
}

function buildPistol() {
  const g = new THREE.Group();

  b(g, 0.038, 0.052, 0.19, M.steel, [0, 0.012, -0.045], null, 0.008);       // slide
  b(g, 0.032, 0.02, 0.15, M.steelLight, [0, -0.021, -0.05], null, 0.005);    // frame rail
  b(g, 0.034, 0.115, 0.055, M.polymer, [0, -0.082, 0.028], [0.22, 0, 0], 0.008); // grip
  b(g, 0.03, 0.05, 0.05, M.polymer, [0, -0.05, 0.045], [0.22, 0, 0], 0.006);
  c(g, 0.011, 0.011, 0.045, M.steelLight, [0, 0.012, -0.163], [Math.PI / 2, 0, 0], 10); // barrel
  b(g, 0.008, 0.014, 0.03, M.steel, [0, 0.036, -0.12], null, 0.002);         // front sight
  b(g, 0.024, 0.012, 0.014, M.steel, [0, 0.036, 0.035], null, 0.002);        // rear sight
  b(g, 0.006, 0.006, 0.05, M.polymer, [0, -0.038, -0.03], null, 0.002);      // trigger guard
  b(g, 0.01, 0.026, 0.012, M.steel, [0, -0.032, -0.005], [0.2, 0, 0], 0.003);// trigger
  b(g, 0.006, 0.008, 0.07, M.accent, [0, -0.014, -0.06], null, 0.002);       // accent strip

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, -0.19);
  muzzle.name = 'muzzle';
  g.add(muzzle);
addHandAnchors(g, [0, -0.082, 0.028], [0, -0.062, -0.005]);
  return g;
}

function buildSMG() {
  const g = new THREE.Group();

  b(g, 0.052, 0.075, 0.26, M.steel, [0, 0.004, -0.07], null, 0.012);         // receiver
  b(g, 0.028, 0.028, 0.10, M.steelLight, [0, 0.012, -0.25], null, 0.008);     // barrel shroud
  c(g, 0.009, 0.009, 0.09, M.steelLight, [0, 0.012, -0.31], [Math.PI / 2, 0, 0], 10);
  b(g, 0.036, 0.13, 0.05, M.polymer, [0, -0.09, -0.02], [0.14, 0, 0], 0.008); // grip
  b(g, 0.03, 0.15, 0.058, M.polymer, [0, -0.10, -0.14], [-0.1, 0, 0], 0.006); // long magazine
  b(g, 0.02, 0.038, 0.19, M.polymer, [0, -0.006, 0.16], null, 0.006);         // folding stock
  b(g, 0.045, 0.05, 0.03, M.polymer, [0, 0.0, 0.255], null, 0.008);           // butt plate
  b(g, 0.042, 0.012, 0.12, M.steelLight, [0, 0.05, -0.09], null, 0.004);      // top rail
  b(g, 0.006, 0.016, 0.012, M.steel, [0, 0.066, -0.20], null, 0.002);         // front sight
  b(g, 0.005, 0.01, 0.04, M.polymer, [0, -0.045, -0.03], null, 0.002);        // trigger guard
  c(g, 0.012, 0.012, 0.05, M.steel, [0, 0.012, -0.345], [Math.PI / 2, 0, 0], 10); // muzzle
  b(g, 0.008, 0.008, 0.09, M.accent, [0.026, 0.01, -0.02], null, 0.002);      // accent

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, -0.375);
  muzzle.name = 'muzzle';
  g.add(muzzle);
addHandAnchors(g, [0, -0.090, -0.020], [0, -0.020, -0.150]);
  return g;
}

function buildRifle() {
  const g = new THREE.Group();

  // receiver + upper
  b(g, 0.062, 0.082, 0.30, M.steel, [0, 0.006, -0.09], null, 0.014);
  b(g, 0.05, 0.02, 0.28, M.steelLight, [0, 0.05, -0.10], null, 0.008);        // flat top
  b(g, 0.008, 0.012, 0.24, M.steel, [0, 0.062, -0.11], null, 0.003);         // rail spine

  // handguard with rail slots
  b(g, 0.058, 0.062, 0.28, M.polymer, [0, 0.006, -0.38], null, 0.012);
  for (let i = 0; i < 6; i++) {
    b(g, 0.062, 0.008, 0.012, M.steelLight, [0, 0.032, -0.26 - i * 0.045], null, 0.002);
  }
  b(g, 0.02, 0.02, 0.05, M.steel, [0, 0.045, -0.52], null, 0.004);            // gas block

  // barrel + muzzle brake
  c(g, 0.0105, 0.0105, 0.34, M.steelLight, [0, 0.014, -0.68], [Math.PI / 2, 0, 0], 12);
  c(g, 0.019, 0.021, 0.055, M.steel, [0, 0.014, -0.865], [Math.PI / 2, 0, 0], 12);
  for (let i = 0; i < 3; i++) {
    b(g, 0.03, 0.026, 0.008, M.steel, [0, 0.014, -0.855 + i * 0.017], null, 0.002);
  }

  // stock
  b(g, 0.045, 0.07, 0.22, M.polymer, [0, 0.004, 0.20], null, 0.01);
  b(g, 0.05, 0.095, 0.035, M.polymer, [0, -0.002, 0.315], null, 0.01);
  b(g, 0.028, 0.045, 0.07, M.steel, [0, 0.03, 0.09], null, 0.006);            // buffer tube

  // grip + trigger
  b(g, 0.036, 0.115, 0.05, M.polymer, [0, -0.078, 0.035], [0.2, 0, 0], 0.008);
  b(g, 0.03, 0.008, 0.075, M.steel, [0, -0.045, -0.01], null, 0.002);
  b(g, 0.008, 0.024, 0.01, M.steel, [0, -0.038, 0.005], [0.2, 0, 0], 0.002);

  // magazine (curved look from two blocks)
  b(g, 0.042, 0.12, 0.07, M.polymer, [0, -0.085, -0.085], [-0.12, 0, 0], 0.008);
  b(g, 0.04, 0.075, 0.062, M.polymer, [0, -0.175, -0.10], [-0.3, 0, 0], 0.008);

  // optic
  b(g, 0.026, 0.03, 0.045, M.steel, [0, 0.085, -0.02], null, 0.004);
  c(g, 0.028, 0.028, 0.11, M.steel, [0, 0.115, -0.055], [Math.PI / 2, 0, 0], 16);
  c(g, 0.026, 0.026, 0.008, M.glass, [0, 0.115, -0.112], [Math.PI / 2, 0, 0], 16);
  b(g, 0.03, 0.014, 0.02, M.steel, [0, 0.115, -0.005], null, 0.004);

  // details
  b(g, 0.014, 0.014, 0.05, M.steel, [0.032, 0.03, 0.02], null, 0.004);        // charging handle
  b(g, 0.006, 0.02, 0.06, M.steelLight, [0.034, 0.0, -0.09], null, 0.002);    // ejection port
  b(g, 0.008, 0.008, 0.16, M.accent, [-0.032, 0.02, -0.3], null, 0.002);      // accent rail

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.014, -0.9);
  muzzle.name = 'muzzle';
  g.add(muzzle);
addHandAnchors(g, [0, -0.078, 0.035], [0, -0.010, -0.200]);
  return g;
}

function buildShotgun() {
  const g = new THREE.Group();

  b(g, 0.055, 0.09, 0.24, M.steel, [0, 0.0, -0.06], null, 0.012);             // receiver
  c(g, 0.018, 0.018, 0.55, M.steel, [0, 0.022, -0.44], [Math.PI / 2, 0, 0], 14); // barrel
  c(g, 0.016, 0.016, 0.42, M.steelLight, [0, -0.018, -0.40], [Math.PI / 2, 0, 0], 12); // tube
  b(g, 0.052, 0.052, 0.16, M.wood, [0, -0.022, -0.30], null, 0.012);          // pump
  b(g, 0.05, 0.075, 0.24, M.wood, [0, -0.01, 0.16], null, 0.012);             // stock
  b(g, 0.052, 0.10, 0.03, M.polymer, [0, -0.02, 0.29], null, 0.008);          // butt pad
  b(g, 0.036, 0.11, 0.05, M.wood, [0, -0.085, 0.03], [0.2, 0, 0], 0.008);     // grip
  b(g, 0.028, 0.008, 0.07, M.steel, [0, -0.045, -0.01], null, 0.002);
  b(g, 0.006, 0.02, 0.01, M.steel, [0, 0.062, -0.72], null, 0.002);           // front bead
  b(g, 0.04, 0.012, 0.1, M.steelLight, [0, 0.048, -0.05], null, 0.004);       // top rib
  b(g, 0.008, 0.008, 0.2, M.accent, [0, 0.062, -0.30], null, 0.002);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.022, -0.73);
  muzzle.name = 'muzzle';
  g.add(muzzle);
addHandAnchors(g, [0, -0.085, 0.030], [0, -0.022, -0.200]);
  return g;
}

function buildSniper() {
  const g = new THREE.Group();

  b(g, 0.06, 0.085, 0.34, M.polymer, [0, 0.004, -0.06], null, 0.014);         // chassis
  c(g, 0.013, 0.013, 0.62, M.steelLight, [0, 0.022, -0.52], [Math.PI / 2, 0, 0], 13);
  c(g, 0.021, 0.019, 0.07, M.steel, [0, 0.022, -0.86], [Math.PI / 2, 0, 0], 12); // brake
  b(g, 0.056, 0.075, 0.26, M.polymer, [0, -0.004, 0.22], null, 0.012);        // stock
  b(g, 0.045, 0.08, 0.05, M.polymer, [0, 0.03, 0.30], null, 0.01);            // cheek rest
  b(g, 0.036, 0.12, 0.055, M.polymer, [0, -0.08, 0.04], [0.18, 0, 0], 0.008); // grip
  b(g, 0.045, 0.10, 0.075, M.steel, [0, -0.075, -0.12], null, 0.008);         // magazine
  b(g, 0.028, 0.008, 0.08, M.steel, [0, -0.05, 0.0], null, 0.002);

  // big scope
  c(g, 0.034, 0.034, 0.26, M.steel, [0, 0.115, -0.06], [Math.PI / 2, 0, 0], 16);
  c(g, 0.042, 0.034, 0.05, M.steel, [0, 0.115, -0.20], [Math.PI / 2, 0, 0], 16);
  c(g, 0.032, 0.032, 0.008, M.glass, [0, 0.115, -0.226], [Math.PI / 2, 0, 0], 16);
  b(g, 0.024, 0.03, 0.02, M.steel, [0, 0.115, 0.07], null, 0.004);
  b(g, 0.022, 0.05, 0.02, M.steel, [0, 0.075, -0.06], null, 0.004);           // mount front
  b(g, 0.022, 0.05, 0.02, M.steel, [0, 0.075, -0.01], null, 0.004);           // mount rear
  b(g, 0.014, 0.02, 0.014, M.steel, [0, 0.148, -0.06], null, 0.004);          // turret

  // bipod
  b(g, 0.008, 0.008, 0.16, M.steel, [0.03, 0.03, -0.55], [0, 0.3, 0], 0.002);
  b(g, 0.008, 0.008, 0.16, M.steel, [-0.03, 0.03, -0.55], [0, -0.3, 0], 0.002);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.022, -0.9);
  muzzle.name = 'muzzle';
  g.add(muzzle);
addHandAnchors(g, [0, -0.080, 0.040], [0, -0.050, -0.140]);
  return g;
}

const BUILDERS = {
  pistol: buildPistol,
  smg: buildSMG,
  rifle: buildRifle,
  shotgun: buildShotgun,
  sniper: buildSniper,
};

const TEMPLATES = {};

/** A fresh, independent weapon model (geometry + materials are shared). */
export function createWeaponModel(type) {
  if (!TEMPLATES[type]) TEMPLATES[type] = BUILDERS[type]();
  const model = TEMPLATES[type].clone(true);
  // Object3D.clone() JSON-serialises userData, so re-link the muzzle object.
  const muzzle = model.getObjectByName('muzzle');
  if (muzzle) model.userData.muzzle = muzzle;
  // ~20 little parts per gun -> a handful of draw calls.
  mergeDirectMeshes(model);
  return model;
}

/** Hand anchor objects ({ grip, foregrip }) or null when the model lacks them. */
export function weaponHands(model) {
  const grip = model.getObjectByName('grip');
  const foregrip = model.getObjectByName('foregrip');
  if (!grip || !foregrip) return null;
  return { grip, foregrip };
}

export function weaponMuzzle(model) {
  return model.userData.muzzle || model.getObjectByName('muzzle');
}

/** Where the round leaves the barrel, in world space. */
export function muzzleWorldPosition(model, out = new THREE.Vector3()) {
  const m = weaponMuzzle(model);
  if (m) m.getWorldPosition(out);
  else model.getWorldPosition(out);
  return out;
}
