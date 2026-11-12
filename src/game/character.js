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
    mk(GEO.upperArm, mat.uniform, shoulder, [0, -0.160, 0]);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.32, 0);
    shoulder.add(elbow);
    mk(GEO.forearm, mat.uniform, elbow, [0, -0.130, 0]);
    const hand = mk(GEO.hand, mat.skin, elbow, [0, -0.26, 0]);
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
  gunMount.position.set(0.02, 0.23, -0.24);
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
    // Bone measurements used by the arm IK below.
    upperArmLen: 0.32,
    foreArmLen: 0.26,
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
/* --------------------------------------------------------------- arm IK

   Two-bone analytic IK in the arm's own space. Kicking a hand to a world
   position makes the soldier actually hold the weapon instead of pointing a
   gun welded to their chest while their arms hang by their sides.          */

const _ikTarget = new THREE.Vector3();
const _ikElbow = new THREE.Vector3();
const _ikEnd = new THREE.Vector3();
const _ikPole = new THREE.Vector3();
const _ikDir = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();
const _ikQp = new THREE.Quaternion();
const _ikV = new THREE.Vector3();
const _ikArm = new THREE.Vector3();
const _ikRest = new THREE.Vector3();
const _ikWrist = new THREE.Vector3();
const _ikRoot = new THREE.Vector3();
const _ikOrigin = new THREE.Vector3();

/**
 * Solve one arm onto `worldTarget` (in the rigid root's parent space).
 *
 * The limb is built along -Y, so the rest direction is (0,-1,0). `poleWorld`
 * names the direction the elbow should bulge towards. Everything is done in
 * the arm's parent space, which is valid because the whole rig is only ever
 * translated and yawed by the body anchor.
 */
function solveArm(rig, arm, worldTarget, poleWorld) {
  const parent = arm.shoulder.parent;
  if (!parent) return;

  // Solve in the shoulder's parent space. The rig is only translated and
  // yawed, so this frame is a pure rotation/translation of world space.
  parent.updateWorldMatrix(true, false);
  parent.getWorldPosition(_ikOrigin);
  _ikQp.copy(parent.getWorldQuaternion(_ikQp));
  // The chain starts at the shoulder joint, not at the parent's origin.
  _ikRoot.copy(worldTarget).sub(_ikOrigin).applyQuaternion(_ikQp.invert())
    .sub(arm.shoulder.position);

  const L1 = rig.upperArmLen;
  const L2 = rig.foreArmLen;
  const want = _ikRoot.length();
  const reach = Math.min(want, L1 + L2 - 0.006);
  if (reach < 1e-4) return;
  _ikDir.copy(_ikRoot).normalize();

  // Cosines for the two joint angles (law of cosines on the triangle).
  const cosShoulder = THREE.MathUtils.clamp(
    (L1 * L1 + reach * reach - L2 * L2) / (2 * L1 * reach), -1, 1);
  const sinShoulder = Math.sqrt(Math.max(0, 1 - cosShoulder * cosShoulder));

  // Elbow plane: pole vectors, orthonormalised against the reach direction.
  _ikPole.copy(poleWorld).applyQuaternion(_ikQp).addScaledVector(_ikDir, -_ikPole.dot(_ikDir));
  if (_ikPole.lengthSq() < 1e-6) {
    // Any perpendicular will do when the caller's pole is degenerate.
    _ikPole.set(0, 0, 1).cross(_ikDir);
    if (_ikPole.lengthSq() < 1e-6) _ikPole.set(1, 0, 0);
  }
  _ikPole.normalize();

  // Elbow sits in the plane spanned by the reach direction and the pole.
  _ikElbow.copy(_ikDir).multiplyScalar(L1 * cosShoulder).addScaledVector(_ikPole, L1 * sinShoulder);
  _ikEnd.copy(_ikDir).multiplyScalar(reach);

  // Shoulder rotation: rest direction (0,-1,0) -> upper arm direction.
  const rest = _ikRest.set(0, -1, 0);
  const toElbow = _ikArm.copy(_ikElbow).normalize();
  const shoulderQ = _ikQ.setFromUnitVectors(rest, toElbow);
  arm.shoulder.quaternion.copy(shoulderQ);

  // Elbow rotation, in the shoulder's own frame. The forearm's rest direction
  // there is still (0,-1,0); rotating it onto (wrist - elbow) folds the arm.
  const toWrist = _ikWrist.copy(_ikEnd).sub(_ikElbow).normalize();
  toWrist.applyQuaternion(_ikQ.copy(shoulderQ).invert());
  arm.elbow.quaternion.setFromUnitVectors(rest, toWrist);
}

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
  // The weapon sits on the right-hand side of the chest with the stock in the
  // shoulder pocket — not centred like a box held under the chin. That offset
  // is what makes the pose read as "carrying a rifle" rather than "holding a
  // plank", and it keeps the support arm from crossing the body.
  rig.gunMount.position.x = THREE.MathUtils.lerp(0.02, 0.065, aim);
  rig.gunMount.position.y = THREE.MathUtils.lerp(0.23, 0.30, aim);
  rig.gunMount.position.z = THREE.MathUtils.lerp(-0.24, -0.25, aim);
  rig.gunMount.rotation.z = THREE.MathUtils.lerp(0.10, 0, aim);
  rig.gunMount.rotation.y = THREE.MathUtils.lerp(0.05, 0.02, aim);

  // Hands on the weapon. Without this the gun is welded to the chest and the
  // arms dangle behind it, which reads as the player not holding the gun.
  if (state.hands) {
    rig.root.updateWorldMatrix(true, true);
    // Elbows flare out to the sides and slightly down/back, the way a shooter
    // stands — otherwise the IK folds them through the torso.
    solveArm(rig, rig.armR, state.hands.grip, _ikPole.set(1, -0.75, 0.55));
    solveArm(rig, rig.armL, state.hands.foregrip, _ikPole.set(-1, -0.55, 0.25));
    // The two calls share a temp, so pass distinct instances.
  }
}
