import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD } from './heightfield.js';
import { U } from './environment.js';
import { sampleHeight, sampleSlope } from './heightgrid.js';
import { createRandom } from '../util/math.js';
import { createNoise2D, fbm } from '../util/noise.js';

const nShape = createNoise2D(5501);
const nClump = createNoise2D(8123);
const nTint = createNoise2D(3311);

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

function paint(geo, color, variation = 0.0, seedRand = Math.random) {
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    c.copy(color);
    if (variation > 0) {
      const v = 1 + (seedRand() - 0.5) * variation;
      c.multiplyScalar(v);
    }
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function deform(geo, amount, freq, seedOffset = 0) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = nShape(x * freq + seedOffset, z * freq + y * freq * 0.7);
    pos.setXYZ(i, x * (1 + n * amount), y * (1 + n * amount * 0.8), z * (1 + n * amount));
  }
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ trees */

const TRUNK_COLORS = [0x6d4c31, 0x5d4029, 0x79573a];
const LEAF_SETS = [
  [0x4c7a28, 0x63963a, 0x39601f],
  [0x43722a, 0x578b34, 0x2f551b],
  [0x55842f, 0x6b9c3f, 0x3d6a24],
  [0x3f6b2c, 0x527f38, 0x2b4f1e],
];

/*
 * Trees double as hard cover: the trunk below is a real, solid column that
 * stops movement, bullets and bot line-of-sight (see game/colliders.js). To
 * make that readable in-game the trunk is a little wider and slightly
 * buttressed at the base, and it starts below the ground plane so no root
 * gap is ever visible on a slope.
 */
const TREE_TRUNK_BASE = -0.55;   // sunk into the terrain

function makeTree(variant) {
  const rand = createRandom(1000 + variant * 77);
  const parts = [];
  const leafSet = LEAF_SETS[variant % LEAF_SETS.length];

  const trunkH = 3.4 + rand() * 2.4;
  const trunkR = 0.30 + rand() * 0.08;

  const trunk = new THREE.CylinderGeometry(trunkR * 0.62, trunkR * 1.18, trunkH - TREE_TRUNK_BASE, 8, 1, false);
  trunk.translate(0, (trunkH + TREE_TRUNK_BASE) * 0.5, 0);
  let trunkGeo = trunk.index ? trunk.toNonIndexed() : trunk;
  trunkGeo.deleteAttribute('uv');
  trunkGeo = deform(trunkGeo, 0.04, 1.4, variant * 3.3);
  paint(trunkGeo, C(TRUNK_COLORS[variant % TRUNK_COLORS.length]), 0.22, rand);
  parts.push(trunkGeo);

  // Two root flares so the base reads as planted, not floating.
  for (let f = 0; f < 2; f++) {
    const flare = new THREE.CylinderGeometry(trunkR * 0.5, trunkR * 1.9, 0.7, 7, 1, false);
    const a = (f / 2) * Math.PI * 2 + rand();
    flare.translate(Math.cos(a) * trunkR * 0.8, 0.05, Math.sin(a) * trunkR * 0.8);
    let fg = flare.index ? flare.toNonIndexed() : flare;
    fg.deleteAttribute('uv');
    paint(fg, C(TRUNK_COLORS[(variant + 1) % TRUNK_COLORS.length]), 0.18, rand);
    parts.push(fg);
  }


  // A full, layered canopy: a big crown plus satellite clusters.
  const blobCount = 4 + (variant % 2);
  for (let b = 0; b < blobCount; b++) {
    const isCrown = b === 0;
    const r = isCrown ? 2.0 + rand() * 0.9 : 1.05 + rand() * 0.85;
    let blob = new THREE.IcosahedronGeometry(r, 1);
    blob.deleteAttribute('uv');
    if (blob.index) blob = blob.toNonIndexed();
    blob = deform(blob, 0.26, 0.85 / Math.max(r, 0.7), b * 7.1 + variant);

    const ang = (b / blobCount) * Math.PI * 2 + rand() * 0.9;
    const spread = isCrown ? 0 : 0.9 + rand() * 1.5;
    blob.scale(1.12, 0.78, 1.12);
    blob.translate(
      Math.cos(ang) * spread,
      trunkH + (isCrown ? 0.95 : rand() * 1.5 - 0.15),
      Math.sin(ang) * spread
    );
    paint(blob, C(leafSet[b % leafSet.length]), 0.3, rand);
    parts.push(blob);
  }

  const merged = mergeGeometries(parts, false);
  merged.computeBoundingSphere();
  return merged;
}

/* ------------------------------------------------------------------ grass */

function makeGrassClump(seed) {
  const rand = createRandom(seed);
  const bladeCount = 4;
  const positions = [];
  const normals = [];
  const colors = [];
  const bends = [];

  const baseCol = new THREE.Color(0x2a3d12);
  const tipCol = new THREE.Color(0x7d9c40);

  for (let b = 0; b < bladeCount; b++) {
    const ang = rand() * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const w = 0.020 + rand() * 0.016;
    const h = 0.18 + rand() * 0.26;
    const lean = (rand() - 0.5) * 0.16;
    const ox = (rand() - 0.5) * 0.28;
    const oz = (rand() - 0.5) * 0.28;

    const pts = [
      [-w, 0, 0, 0],
      [w, 0, 0, 0],
      [w * 0.65, h * 0.55, lean * 0.45, 0.55],
      [-w * 0.65, h * 0.55, lean * 0.45, 0.55],
      [0, h, lean, 1.0],
    ];

    const tris = [[0, 1, 2], [0, 2, 3], [3, 2, 4]];
    for (const t of tris) {
      for (const idx of t) {
        const p = pts[idx];
        const px = p[0] * ca - p[2] * sa + ox;
        const pz = p[0] * sa + p[2] * ca + oz;
        positions.push(px, p[1], pz);
        normals.push(sa * 0.3, 0.9, ca * 0.3);
        const c = baseCol.clone().lerp(tipCol, p[3] * 0.9 + rand() * 0.1);
        colors.push(c.r, c.g, c.b);
        bends.push(p[3]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('aBend', new THREE.Float32BufferAttribute(bends, 1));
  return geo;
}

const grassVertex = /* glsl */`
attribute float aBend;
attribute vec3 aColor;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform float uAmbientIntensity;
uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec3 vColor;
varying float vLight;
varying float vFogDepth;

void main() {
  vec3 p = position;

  #ifdef USE_INSTANCING
    vec3 origin = instanceMatrix[3].xyz;
  #else
    vec3 origin = vec3(0.0);
  #endif

  // Distance based collapse so far-away blades cost almost nothing visually.
  float d = distance(cameraPosition.xz, origin.xz);
  float visible = 1.0 - smoothstep(36.0, 49.0, d);
  p *= mix(0.001, 1.0, visible);

  #ifdef USE_INSTANCING
    vec4 wp = instanceMatrix * vec4(p, 1.0);
  #else
    vec4 wp = vec4(p, 1.0);
  #endif
  wp = modelMatrix * wp;

  // Wind.
  float sway = sin(uTime * 1.7 + wp.x * 0.42 + wp.z * 0.31) * 0.55
             + sin(uTime * 3.3 + wp.x * 1.1) * 0.22
             + sin(uTime * 0.7 + wp.z * 0.6) * 0.3;
  wp.x += sway * aBend * 0.075;
  wp.z += sway * aBend * 0.045;
  wp.y -= abs(sway) * aBend * 0.006;

  vec4 mv = viewMatrix * wp;
  vFogDepth = -mv.z;

  vec3 n = normalize(vec3(sway * 0.1, 1.0, sway * 0.07));
  float ndl = max(dot(n, uSunDir), 0.0);
  vLight = 0.22 + 0.78 * ndl;

  #ifdef USE_INSTANCING_COLOR
    vColor = aColor * instanceColor;
  #else
    vColor = aColor;
  #endif

  gl_Position = projectionMatrix * mv;
}
`;

const grassFragment = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform float uAmbientIntensity;
uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec3 vColor;
varying float vLight;
varying float vFogDepth;

void main() {
  vec3 sun = uSunColor * uSunIntensity * 0.28;
  vec3 amb = uAmbientSky * uAmbientIntensity * 0.30 + uAmbientGround * uAmbientIntensity * 0.10;
  vec3 col = vColor * (sun * vLight + amb);

  float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ------------------------------------------------------------------ grass
   The meadow follows the player: a square grid of clumps is re-anchored to
   the nearest 0.9 m cell, and every clump is placed with a deterministic hash
   of its world cell. Because the hash is position based, the grass stays
   pinned to the ground when the field re-anchors — only the fading rim
   changes, which is far outside the visible blade distance.
   That buys ~1.2 clumps per square metre around the player, which is what
   makes the ground read as grass instead of coloured clay.               */

const GRASS_GRID = 112;
const GRASS_SPACING = 0.9;
const GRASS_HALF = GRASS_GRID / 2;
const GRASS_SLOTS = GRASS_GRID * GRASS_GRID;
const GRASS_PER_MESH = Math.ceil(GRASS_SLOTS / 3);

function hash3(x, y, s) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function createGrass() {
  const clumps = [
    makeGrassClump(11),
    makeGrassClump(22),
    makeGrassClump(33),
  ];

  const meshes = clumps.map((geo) => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uSunDir: U.uSunDir,
        uSunColor: U.uSunColor,
        uSunIntensity: U.uSunIntensity,
        uAmbientSky: U.uAmbientSky,
        uAmbientGround: U.uAmbientGround,
        uAmbientIntensity: U.uAmbientIntensity,
        uFogColor: U.uFogColor,
        uFogDensity: U.uFogDensity,
      },
      vertexShader: grassVertex,
      fragmentShader: grassFragment,
      side: THREE.DoubleSide,
      fog: false,
    });

    const mesh = new THREE.InstancedMesh(geo, material, GRASS_PER_MESH);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  });

  const group = new THREE.Group();
  group.name = 'grass';
  meshes.forEach((m) => group.add(m));

  const matrix = new THREE.Matrix4();
  const zero = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
  const quat = new THREE.Quaternion();
  const posv = new THREE.Vector3();
  const scalev = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();

  // Park every slot out of sight until it is filled.
  meshes.forEach((m) => {
    for (let i = 0; i < GRASS_PER_MESH; i++) m.setMatrixAt(i, zero);
    m.count = GRASS_PER_MESH;
    m.instanceMatrix.needsUpdate = true;
  });

  let lastGX = null;
  let lastGZ = null;
  let dirty = true;
  let alive = 0;
  const occupied = new Uint8Array(GRASS_SLOTS);

  /* Slots are addressed modulo the grid, so moving the field by one cell only
     rewrites the one row/column that entered — the meadow stays world-locked
     and the update costs ~112 placements instead of ~12 500. */
  function writeCell(gx, gz) {
    const i = ((gx % GRASS_GRID) + GRASS_GRID) % GRASS_GRID;
    const j = ((gz % GRASS_GRID) + GRASS_GRID) % GRASS_GRID;
    const slot = j * GRASS_GRID + i;
    const v = slot % 3;
    const idx = (slot - v) / 3;

    const x = gx * GRASS_SPACING;
    const z = gz * GRASS_SPACING;
    const h = sampleHeight(x, z);

    let visible = false;
    if (h >= 2.4 && h <= 92) {
      const r1 = hash3(gx, gz, 1);
      const r2 = hash3(gx, gz, 2);
      const r4 = hash3(gx, gz, 4);
      const patch = fbm(nClump, x * 0.02, z * 0.02, 2) * 0.5 + 0.5;
      if (r2 <= 0.42 + patch * 0.62 && sampleSlope(x, z) <= 0.46) {
        const s = 0.62 + r1 * 0.62;
        posv.set(x, h - 0.02, z);
        quat.setFromAxisAngle(up, r4 * Math.PI * 2);
        scalev.set(
          s * (0.85 + r1 * 0.3),
          s * (0.8 + r4 * 0.7),
          s * (0.85 + r2 * 0.3)
        );
        matrix.compose(posv, quat, scalev);

        const tint = 0.72 + hash3(gx, gz, 5) * 0.5;
        color.setRGB(tint, tint * 1.06, tint * 0.84);
        visible = true;
      }
    }

    if (visible && !occupied[slot]) { occupied[slot] = 1; alive++; }
    else if (!visible && occupied[slot]) { occupied[slot] = 0; alive--; }

    meshes[v].setMatrixAt(idx, visible ? matrix : zero);
    if (visible) {
      meshes[v].setColorAt(idx, color);
      meshes[v].instanceColor.needsUpdate = true;
    }
  }

  function update(px, pz) {
    const gx0 = Math.round(px / GRASS_SPACING);
    const gz0 = Math.round(pz / GRASS_SPACING);

    if (lastGX === null) {
      for (let j = 0; j < GRASS_GRID; j++) {
        for (let i = 0; i < GRASS_GRID; i++) {
          writeCell(gx0 - GRASS_HALF + i, gz0 - GRASS_HALF + j);
        }
      }
      lastGX = gx0;
      lastGZ = gz0;
      dirty = true;
    } else {
      while (lastGX !== gx0) {
        const step = gx0 > lastGX ? 1 : -1;
        lastGX += step;
        const col = step > 0 ? lastGX + GRASS_HALF - 1 : lastGX - GRASS_HALF;
        for (let j = 0; j < GRASS_GRID; j++) {
          writeCell(col, lastGZ - GRASS_HALF + j);
        }
        dirty = true;
      }
      while (lastGZ !== gz0) {
        const step = gz0 > lastGZ ? 1 : -1;
        lastGZ += step;
        const row = step > 0 ? lastGZ + GRASS_HALF - 1 : lastGZ - GRASS_HALF;
        for (let i = 0; i < GRASS_GRID; i++) {
          writeCell(lastGX - GRASS_HALF + i, row);
        }
        dirty = true;
      }
    }

    if (dirty) {
      for (let v = 0; v < meshes.length; v++) {
        meshes[v].instanceMatrix.needsUpdate = true;
      }
      dirty = false;
    }
  }

  return {
    group,
    rebuild: update,
    get count() { return alive; },
  };
}

/* -------------------------------------------------------------- rocks etc */

function makeRock(seed) {
  const rand = createRandom(seed);
  let geo = new THREE.IcosahedronGeometry(1, 1);
  geo.deleteAttribute('uv');
  if (geo.index) geo = geo.toNonIndexed();
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = nShape(x * 1.7 + seed, z * 1.7 + y * 1.1);
    const n2 = nShape(x * 3.3 - seed, y * 3.3 + z);
    const k = 1 + n * 0.3 + n2 * 0.13;
    pos.setXYZ(i, x * k, y * k * (0.55 + rand() * 0.3), z * k);
  }
  geo.computeVertexNormals();
  paint(geo, C(0x8a8175), 0.3, rand);
  return geo;
}

export function createProps() {
  const group = new THREE.Group();
  group.name = 'props';
  const rand = createRandom(40321);

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const posv = new THREE.Vector3();
  const scalev = new THREE.Vector3();

  /* ---- trees ---- */
  const variantGeos = [makeTree(0), makeTree(1), makeTree(2), makeTree(3), makeTree(4)];
  const buckets = variantGeos.map(() => []);

  const trunks = [];
  let treeCount = 0;
  let tries = 0;
  while (treeCount < 860 && tries < 60000) {
    tries++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * WORLD.radius * 0.95;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = sampleHeight(x, z);
    if (h < 4.5 || h > 88) continue;
    if (sampleSlope(x, z) > 0.42) continue;

    // Forest clumping: dense groves with open meadows between them.
    const forest = fbm(nClump, x * 0.0042 + 31, z * 0.0042 - 12, 3) * 0.5 + 0.5;
    if (rand() > forest * 1.55 - 0.28) continue;

    // Leave a small clearing between trunks so each one is usable cover.
    let crowded = false;
    for (const t of trunks) {
      const dx = t.x - x;
      const dz = t.z - z;
      if (dx * dx + dz * dz < 3.1 * 3.1) { crowded = true; break; }
    }
    if (crowded) continue;

    const v = (rand() * variantGeos.length) | 0;
    const s = 0.85 + rand() * 0.95;
    const sxz = s * (0.9 + rand() * 0.25);
    posv.set(x, h - 0.15, z);
    euler.set((rand() - 0.5) * 0.07, rand() * Math.PI * 2, (rand() - 0.5) * 0.07);
    quat.setFromEuler(euler);
    const sy = s * (0.9 + rand() * 0.4);
    scalev.set(sxz, sy, sxz);
    matrix.compose(posv, quat, scalev);
    buckets[v].push({ matrix: matrix.clone(), tint: 0.85 + rand() * 0.35 });

    // Collision column: a touch wider than the visible bark so bullets do not
    // slip through the model's facet edges.
    const R = (0.30 + 0.08 * 0.5) * 1.18 * sxz + 0.10;
    trunks.push({
      x, z,
      r: R,
      y0: h - 3.0,
      y1: h + Math.min(6.2, (3.4 + 1.2) * sy),
      kind: 'tree',
    });
    treeCount++;
  }

  const treeMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.88,
    metalness: 0.0,
  });

  variantGeos.forEach((geo, i) => {
    const list = buckets[i];
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, treeMat, list.length);
    const color = new THREE.Color();
    list.forEach((item, idx) => {
      mesh.setMatrixAt(idx, item.matrix);
      const t = item.tint;
      color.setRGB(t * 0.96, t, t * 0.88);
      mesh.setColorAt(idx, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  });

  /* ---- rocks ---- */
  const rockGeos = [makeRock(3), makeRock(9), makeRock(17)];
  const rockBuckets = rockGeos.map(() => []);
  let rockCount = 0;
  tries = 0;
  while (rockCount < 460 && tries < 30000) {
    tries++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * WORLD.radius * 1.02;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = sampleHeight(x, z);
    if (h > 130) continue;
    const slope = sampleSlope(x, z);
    if (slope < 0.18 && rand() > 0.22) continue;

    const v = (rand() * rockGeos.length) | 0;
    const s = 0.32 + Math.pow(rand(), 2.3) * 4.0;
    posv.set(x, h - s * 0.3, z);
    euler.set(rand() * Math.PI, rand() * Math.PI * 2, rand() * Math.PI);
    quat.setFromEuler(euler);
    const sy = s * (0.7 + rand() * 0.5);
    scalev.set(s, sy, s * (0.85 + rand() * 0.4));
    matrix.compose(posv, quat, scalev);
    rockBuckets[v].push({ matrix: matrix.clone(), tint: 0.7 + rand() * 0.55 });

    // Only boulders you can actually crouch behind count as cover.
    if (s > 1.05) {
      trunks.push({
        x, z,
        r: s * 0.62,
        y0: h - 2.0,
        y1: h + sy * 0.95,
        kind: 'rock',
      });
    }
    rockCount++;
  }

  const rockMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
    metalness: 0.0,
  });

  rockGeos.forEach((geo, i) => {
    const list = rockBuckets[i];
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, rockMat, list.length);
    const color = new THREE.Color();
    list.forEach((item, idx) => {
      mesh.setMatrixAt(idx, item.matrix);
      color.setRGB(item.tint * 1.03, item.tint, item.tint * 0.93);
      mesh.setColorAt(idx, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  });

  /* ---- bushes ---- */
  let bushGeo = new THREE.IcosahedronGeometry(1, 1);
  bushGeo.deleteAttribute('uv');
  if (bushGeo.index) bushGeo = bushGeo.toNonIndexed();
  bushGeo = deform(bushGeo, 0.38, 1.5, 4.4);
  bushGeo.scale(1.0, 0.58, 1.0);
  paint(bushGeo, C(0x466a24), 0.35, rand);

  const bushList = [];
  tries = 0;
  while (bushList.length < 1100 && tries < 40000) {
    tries++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * WORLD.radius * 0.94;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = sampleHeight(x, z);
    if (h < 3.2 || h > 78) continue;
    if (sampleSlope(x, z) > 0.46) continue;
    const s = 0.45 + rand() * 0.95;
    posv.set(x, h + s * 0.1, z);
    euler.set(0, rand() * Math.PI * 2, 0);
    quat.setFromEuler(euler);
    scalev.set(s * (0.9 + rand() * 0.4), s * (0.8 + rand() * 0.5), s * (0.9 + rand() * 0.4));
    matrix.compose(posv, quat, scalev);
    bushList.push({ matrix: matrix.clone(), tint: 0.82 + rand() * 0.45 });
  }

  const bushMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.9,
  });
  const bushMesh = new THREE.InstancedMesh(bushGeo, bushMat, bushList.length);
  const bc = new THREE.Color();
  bushList.forEach((item, idx) => {
    bushMesh.setMatrixAt(idx, item.matrix);
    bc.setRGB(item.tint * 0.96, item.tint * 1.04, item.tint * 0.85);
    bushMesh.setColorAt(idx, bc);
  });
  bushMesh.instanceMatrix.needsUpdate = true;
  if (bushMesh.instanceColor) bushMesh.instanceColor.needsUpdate = true;
  bushMesh.castShadow = true;
  bushMesh.receiveShadow = true;
  bushMesh.frustumCulled = false;
  group.add(bushMesh);

  return {
    group,
    treeCount,
    rockCount,
    bushCount: bushList.length,
    colliders: trunks,
  };
}
