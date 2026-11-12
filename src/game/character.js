import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeDirectMeshes } from '../util/merge.js';

/* A lightweight, hand-built soldier rig: rounded low-poly volumes, a helmet,
   plate carrier, backpack and a two-segment arm/leg hierarchy so it can walk,
   aim and fall over without any external model files. */

const GEO = {
  torso: new RoundedBoxGeometry(0.40, 0.50, 0.23, 2, 0.055),
  chest: new RoundedBoxGeometry(0.44, 0.34, 0.29, 2, 0.06),
  pelvis: new RoundedBoxGeometry(0.30, 0.20, 0.21, 2, 0.05),
  pack: new RoundedBoxGeometry(0.28, 0.34, 0.16, 2, 0.05),
  head: new THREE.SphereGeometry(0.115, 18, 14),
  helmet: new THREE.SphereGeometry(0.135, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
  neck: new THREE.CylinderGeometry(0.05, 0.055, 0.09, 10),
  upperArm: new THREE.CapsuleGeometry(0.052, 0.16, 4, 10),
  forearm: new THREE.CapsuleGeometry(0.045, 0.16, 4, 10),
  hand: new RoundedBoxGeometry(0.075, 0.09, 0.075, 2, 0.025),
  thigh: new THREE.CapsuleGeometry(0.072, 0.22, 4, 10),
  shin: new THREE.CapsuleGeometry(0.058, 0.22, 4, 10),
  boot: new RoundedBoxGeometry(0.11, 0.09, 0.24, 2, 0.035),
  shoulder: new THREE.SphereGeometry(0.075, 12, 10),
  patch: new RoundedBoxGeometry(0.09, 0.05, 0.02, 1, 0.008),
};

export const CHARACTER_COLORS = {
  p1: { uniform: 0x2f4433, vest: 0x222b24, helmet: 0x2a3a2c, skin: 0xb08262, accent: 0x35d6c4 },
  p2: { uniform: 0x5d5236, vest: 0x2f2b22, helmet: 0x4a4230, skin: 0x8d6247, accent: 0xff9a3c },
  botA: { uniform: 0x3a3f4a, vest: 0x24272e, helmet: 0x2f333c, skin: 0xa87b5c, accent: 0xd8483f },
  botB: { uniform: 0x4a3a3a, vest: 0x2b2020, helmet: 0x3a2d2d, skin: 0x9a6f52, accent: 0xd8483f },
};

export function createCharacter(paletteKey = 'botA', accentOverride = null) {
  const C = CHARACTER_COLORS[paletteKey] || CHARACTER_COLORS.botA;

  const mat = {
    uniform: new THREE.MeshStandardMaterial({ color: C.uniform, roughness: 0.86, metalness: 0.02 }),
    vest: new THREE.MeshStandardMaterial({ color: C.vest, roughness: 0.7, metalness: 0.08 }),
    helmet: new THREE.MeshStandardMaterial({ color: C.helmet, roughness: 0.62, metalness: 0.15 }),
    skin: new THREE.MeshStandardMaterial({ color: C.skin, roughness: 0.72, metalness: 0.0 }),
    boot: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 }),
    accent: new THREE.MeshStandardMaterial({
      color: accentOverride ?? C.accent,
      emissive: accentOverride ?? C.accent,
      emissiveIntensity: 0.35,
      roughness: 0.5,
    }),
  };

  const mk = (geo, material, parent, pos = [0, 0, 0], rot = [0, 0, 0]) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  const root = new THREE.Group();
  root.name = 'character';

  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);

  mk(GEO.pelvis, mat.uniform, hips, [0, 0.02, 0]);
  mk(GEO.torso, mat.uniform, hips, [0, 0.30, 0]);
  mk(GEO.chest, mat.vest, hips, [0, 0.32, -0.005]);
  // magazine pouches on the carrier
  for (let i = -1; i <= 1; i++) {
    const pouch = mk(new RoundedBoxGeometry(0.075, 0.10, 0.06, 1, 0.02), mat.vest, hips, [i * 0.115, 0.26, -0.155]);
    pouch.castShadow = true;
  }
  mk(GEO.pack, mat.vest, hips, [0, 0.34, 0.19]);
  mk(GEO.patch, mat.accent, hips, [0.155, 0.44, -0.14], [0, 0.3, 0]);
  mk(GEO.patch, mat.accent, hips, [-0.155, 0.44, -0.14], [0, -0.3, 0]);

  // head
  const head = new THREE.Group();
  head.position.set(0, 0.60, 0);
  hips.add(head);
  mk(GEO.neck, mat.skin, head, [0, 0.0, 0]);
  mk(GEO.head, mat.skin, head, [0, 0.11, 0]);
  mk(GEO.helmet, mat.helmet, head, [0, 0.135, 0.005]);
  const visor = mk(new RoundedBoxGeometry(0.16, 0.05, 0.06, 1, 0.02), mat.helmet, head, [0, 0.12, -0.10]);
  visor.rotation.x = -0.12;

  // arms
  const makeArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.235, 0.50, 0);
    hips.add(shoulder);
    mk(GEO.shoulder, mat.vest, shoulder, [0, 0.01, 0]);
    mk(GEO.upperArm, mat.uniform, shoulder, [0, -0.145, 0]);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.28, 0);
    shoulder.add(elbow);
    mk(GEO.forearm, mat.uniform, elbow, [0, -0.10, 0]);
    const hand = mk(GEO.hand, mat.skin, elbow, [0, -0.22, 0]);
    return { shoulder, elbow, hand };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

  // legs
  const makeLeg = (side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.105, -0.02, 0);
    hips.add(hip);
    mk(GEO.thigh, mat.uniform, hip, [0, -0.20, 0]);
    const knee = new THREE.Group();
    knee.position.set(0, -0.40, 0);
    hip.add(knee);
    mk(GEO.shin, mat.uniform, knee, [0, -0.20, 0]);
    mk(GEO.boot, mat.boot, knee, [0, -0.42, -0.03]);
    return { hip, knee };
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // weapon mount, parented to the chest so it follows the torso
  const gunMount = new THREE.Group();
  gunMount.position.set(0.045, 0.30, -0.33);
  hips.add(gunMount);

  // Collapse the static chunks on the torso and head into a few meshes.
  mergeDirectMeshes(hips);
  mergeDirectMeshes(head);

  return {
    root,
    hips,
    head,
    armL,
    armR,
    legL,
    legR,
    gunMount,
    materials: mat,
    walkPhase: 0,
    deathT: 0,
  };
}

/**
 * Animate a character rig.
 * state: { speed, grounded, aiming, aimPitch, dead, crouch }
 */
export function animateCharacter(rig, state, dt) {
  const moving = state.speed > 0.4 && state.grounded;
  rig.walkPhase += dt * (2.2 + state.speed * 1.15);

  const swing = moving ? Math.min(1, state.speed / 5.2) : 0;
  const s = Math.sin(rig.walkPhase);
  const s2 = Math.sin(rig.walkPhase * 2);

  if (state.dead) {
    rig.deathT = Math.min(1, rig.deathT + dt * 3.2);
    const t = rig.deathT;
    const ease = 1 - Math.pow(1 - t, 3);
    rig.root.rotation.x = -ease * Math.PI * 0.48;
    rig.root.position.y = -ease * 0.18;
    rig.legL.hip.rotation.x = ease * 0.5;
    rig.legR.hip.rotation.x = ease * -0.25;
    rig.armL.shoulder.rotation.set(0.4, 0, -1.2 * ease);
    rig.armR.shoulder.rotation.set(0.4, 0, 1.2 * ease);
    return;
  }
  rig.deathT = 0;
  rig.root.rotation.x = 0;

  const aim = state.aiming ? 1 : 0;
  const pitch = state.aimPitch || 0;

  // Body bob and lean
  rig.hips.position.y = 0.92 - (state.crouch ? 0.26 : 0) + Math.abs(s2) * 0.022 * swing;
  rig.hips.rotation.z = s * 0.03 * swing;
  rig.hips.rotation.x = aim * 0.05 + (state.speed > 0 ? 0.04 : 0);

  // Head follows the aim pitch a little
  rig.head.rotation.x = pitch * 0.5 - 0.05 * aim;
  rig.head.rotation.y = Math.sin(rig.walkPhase * 0.3) * 0.04 * (1 - aim);

  // Legs
  const legAmp = 0.62 * swing;
  rig.legL.hip.rotation.x = s * legAmp;
  rig.legR.hip.rotation.x = -s * legAmp;
  rig.legL.knee.rotation.x = Math.max(0, -s) * 0.9 * swing + (state.crouch ? 0.7 : 0.05);
  rig.legR.knee.rotation.x = Math.max(0, s) * 0.9 * swing + (state.crouch ? 0.7 : 0.05);

  // Arms: relaxed swing -> shouldered aim
  const swingArm = -s * 0.5 * swing;
  const aimShoulderX = -1.15 + pitch * 0.65;
  const aimShoulderZ = 0.30;

  rig.armR.shoulder.rotation.x = THREE.MathUtils.lerp(swingArm, aimShoulderX, aim);
  rig.armR.shoulder.rotation.y = THREE.MathUtils.lerp(0, -0.28, aim);
  rig.armR.shoulder.rotation.z = THREE.MathUtils.lerp(-0.12, aimShoulderZ - 0.16, aim);
  rig.armR.elbow.rotation.x = THREE.MathUtils.lerp(-0.25, -0.55, aim);

  rig.armL.shoulder.rotation.x = THREE.MathUtils.lerp(-swingArm, aimShoulderX + 0.06, aim);
  rig.armL.shoulder.rotation.y = THREE.MathUtils.lerp(0, 0.55, aim);
  rig.armL.shoulder.rotation.z = THREE.MathUtils.lerp(0.12, -aimShoulderZ + 0.28, aim);
  rig.armL.elbow.rotation.x = THREE.MathUtils.lerp(-0.25, -0.95, aim);
  rig.armL.elbow.rotation.y = THREE.MathUtils.lerp(0, 0.35, aim);

  // Gun follows the aim
  rig.gunMount.rotation.x = pitch * 0.85;
  rig.gunMount.position.y = THREE.MathUtils.lerp(0.10, 0.30, aim);
  rig.gunMount.position.z = THREE.MathUtils.lerp(-0.12, -0.33, aim);
  rig.gunMount.rotation.z = THREE.MathUtils.lerp(0.5, 0, aim);
}
