import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, terrainHeight, terrainSlope } from './heightfield.js';
import { U } from './environment.js';
import { createRandom, smoothstep, clamp } from '../util/math.js';
import { createNoise2D, fbm } from '../util/noise.js';

const nShape = createNoise2D(5501);
const nClump = createNoise2D(8123);

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

const TRUNK_COLORS = [0x6a4a30, 0x5a3f2a, 0x745336];
const LEAF_COLORS = [
  [0x3f6029, 0x53793a, 0x2f4a20],
  [0x466a2c, 0x5c8340, 0x33501f],
  [0x37552a, 0x4a6c35, 0x27401d],
];

function makeTree(variant) {
  const rand = createRandom(1000 + variant * 77);
  const parts = [];
  const leafSet = LEAF_COLORS[variant % LEAF_COLORS.length];

  const trunkH = 3.4 + rand() * 2.6;
  const trunkR = 0.17 + rand() * 0.1;

  const trunk = new THREE.CylinderGeometry(trunkR * 0.62, trunkR, trunkH, 6, 1, false);
  trunk.translate(0, trunkH / 2, 0);
  let trunkGeo = trunk.index ? trunk.toNonIndexed() : trunk;
  trunkGeo.deleteAttribute('uv');
  trunkGeo = deform(trunkGeo, 0.05, 1.4, variant * 3.3);
  paint(trunkGeo, C(TRUNK_COLORS[variant % TRUNK_COLORS.length]), 0.22, rand);
  parts.push(trunkGeo);

  const blobCount = 3 + ((variant + 1) % 3);
  for (let b = 0; b < blobCount; b++) {
    const r = (1.15 + rand() * 0.85) * (1 - b * 0.11);
    let blob = new THREE.IcosahedronGeometry(r, 1);
    blob.deleteAttribute('uv');
    if (blob.index) blob = blob.toNonIndexed();
    blob = deform(blob, 0.24, 0.9 / Math.max(r, 0.6), b * 7.1 + variant);
    const ang = (b / blobCount) * Math.PI * 2 + rand();
    const spread = b === 0 ? 0 : 0.55 + rand() * 0.7;
    const ox = Math.cos(ang) * spread;
    const oz = Math.sin(ang) * spread;
    const oy = trunkH + 0.25 + (b === 0 ? 0.5 : rand() * 0.9);
    blob.scale(1.15, 0.82, 1.15);
    blob.translate(ox, oy, oz);
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
  const bladeCount = 3;
  const positions = [];
  const normals = [];
  const colors = [];
  const bends = [];

  const baseCol = new THREE.Color(0x24380f);
  const tipCol = new THREE.Color(0x81a34a);

  for (let b = 0; b < bladeCount; b++) {
    const ang = rand() * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const w = 0.035 + rand() * 0.022;
    const h = 0.38 + rand() * 0.42;
    const lean = (rand() - 0.5) * 0.28;
    const ox = (rand() - 0.5) * 0.22;
    const oz = (rand() - 0.5) * 0.22;

    // local blade points, x = width, y = height, lean in +z
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
        // rotate around Y and offset
        const px = p[0] * ca - p[2] * sa + ox;
        const pz = p[0] * sa + p[2] * ca + oz;
        positions.push(px, p[1], pz);
        normals.push(sa * 0.25, 0.94, ca * 0.25);
        const c = baseCol.clone().lerp(tipCol, p[3] * 0.92 + rand() * 0.08);
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
  float visible = 1.0 - smoothstep(58.0, 96.0, d);
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
  wp.x += sway * aBend * 0.14;
  wp.z += sway * aBend * 0.08;
  wp.y -= abs(sway) * aBend * 0.012;

  vec4 mv = viewMatrix * wp;
  vFogDepth = -mv.z;

  vec3 n = normalize(vec3(sway * 0.08, 1.0, sway * 0.05));
  float ndl = max(dot(n, uSunDir), 0.0);
  vLight = 0.25 + 0.75 * ndl;

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
  vec3 sun = uSunColor * uSunIntensity * 0.30;
  vec3 amb = uAmbientSky * uAmbientIntensity * 0.30 + uAmbientGround * uAmbientIntensity * 0.10;
  vec3 col = vColor * (sun * vLight + amb);

  // Subtle backlit translucency.
  col += vColor * uSunColor * uSunIntensity * 0.02;

  float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createGrass() {
  const rand = createRandom(20240);
  const clumps = [
    makeGrassClump(11),
    makeGrassClump(22),
    makeGrassClump(33),
  ];

  const maxCount = 26000;
  const buckets = clumps.map(() => []);
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const posv = new THREE.Vector3();
  const scalev = new THREE.Vector3();

  let placed = 0;
  let tries = 0;
  while (placed < maxCount && tries < maxCount * 9) {
    tries++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 420;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;

    const h = terrainHeight(x, z);
    if (h < 3.2 || h > 108) continue;

    const slope = terrainSlope(x, z);
    if (slope > 0.42) continue;

    // patchiness
    const patch = fbm(nClump, x * 0.012, z * 0.012, 3) * 0.5 + 0.5;
    if (patch < 0.34 && rand() > 0.22) continue;

    const variant = (rand() * clumps.length) | 0;
    const s = 0.75 + rand() * 1.15 * (0.6 + patch * 0.7);

    posv.set(x, h - 0.03, z);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
    scalev.set(s * (0.85 + rand() * 0.3), s * (0.8 + rand() * 0.75), s * (0.85 + rand() * 0.3));
    matrix.compose(posv, quat, scalev);

    const tint = 0.78 + rand() * 0.5;
    buckets[variant].push({ matrix: matrix.clone(), tint });
    placed++;
  }

  const group = new THREE.Group();
  group.name = 'grass';

  clumps.forEach((geo, i) => {
    const list = buckets[i];
    if (!list.length) return;

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

    const mesh = new THREE.InstancedMesh(geo, material, list.length);
    const color = new THREE.Color();
    list.forEach((item, idx) => {
      mesh.setMatrixAt(idx, item.matrix);
      color.setRGB(item.tint * 0.95, item.tint, item.tint * 0.86);
      mesh.setColorAt(idx, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  });

  return { group, count: placed };
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
    const k = 1 + n * 0.28 + n2 * 0.12;
    pos.setXYZ(i, x * k, y * k * (0.62 + rand() * 0.25), z * k);
  }
  geo.computeVertexNormals();
  paint(geo, C(0x6b6862), 0.3, rand);
  return geo;
}

export function createProps() {
  const group = new THREE.Group();
  group.name = 'props';
  const rand = createRandom(40321);

  /* ---- trees ---- */
  const variantGeos = [makeTree(0), makeTree(1), makeTree(2), makeTree(3)];
  const buckets = variantGeos.map(() => []);
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const posv = new THREE.Vector3();
  const scalev = new THREE.Vector3();

  let treeCount = 0;
  let tries = 0;
  while (treeCount < 620 && tries < 40000) {
    tries++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 445;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < 4.5 || h > 92) continue;
    if (terrainSlope(x, z) > 0.4) continue;

    const forest = fbm(nClump, x * 0.0045 + 31, z * 0.0045 - 12, 3) * 0.5 + 0.5;
    if (rand() > forest * 1.35 - 0.25) continue;

    const v = (rand() * variantGeos.length) | 0;
    const s = 0.75 + rand() * 0.85;
    posv.set(x, h - 0.25, z);
    euler.set((rand() - 0.5) * 0.06, rand() * Math.PI * 2, (rand() - 0.5) * 0.06);
    quat.setFromEuler(euler);
    scalev.set(s * (0.9 + rand() * 0.25), s * (0.9 + rand() * 0.35), s * (0.9 + rand() * 0.25));
    matrix.compose(posv, quat, scalev);
    buckets[v].push({ matrix: matrix.clone(), tint: 0.82 + rand() * 0.4 });
    treeCount++;
  }

  const treeMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.92,
    metalness: 0.0,
  });

  variantGeos.forEach((geo, i) => {
    const list = buckets[i];
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, treeMat, list.length);
    const color = new THREE.Color();
    list.forEach((item, idx) => {
      mesh.setMatrixAt(idx, item.matrix);
      color.setRGB(item.tint * 0.98, item.tint, item.tint * 0.9);
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
  while (rockCount < 420 && tries < 30000) {
    tries++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 490;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h > 96) continue;
    const slope = terrainSlope(x, z);
    if (slope < 0.16 && rand() > 0.25) continue;

    const v = (rand() * rockGeos.length) | 0;
    const s = 0.35 + Math.pow(rand(), 2.2) * 4.2;
    posv.set(x, h - s * 0.28, z);
    euler.set(rand() * Math.PI, rand() * Math.PI * 2, rand() * Math.PI);
    quat.setFromEuler(euler);
    scalev.set(s, s * (0.7 + rand() * 0.5), s * (0.85 + rand() * 0.4));
    matrix.compose(posv, quat, scalev);
    rockBuckets[v].push({ matrix: matrix.clone(), tint: 0.75 + rand() * 0.5 });
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
      color.setRGB(item.tint * 1.02, item.tint, item.tint * 0.94);
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
  bushGeo = deform(bushGeo, 0.35, 1.5, 4.4);
  bushGeo.scale(1.0, 0.62, 1.0);
  paint(bushGeo, C(0x3b5a27), 0.35, rand);

  const bushList = [];
  tries = 0;
  while (bushList.length < 900 && tries < 30000) {
    tries++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 440;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < 3.4 || h > 80) continue;
    if (terrainSlope(x, z) > 0.45) continue;
    const s = 0.5 + rand() * 1.1;
    posv.set(x, h + s * 0.12, z);
    euler.set(0, rand() * Math.PI * 2, 0);
    quat.setFromEuler(euler);
    scalev.set(s * (0.9 + rand() * 0.4), s * (0.8 + rand() * 0.5), s * (0.9 + rand() * 0.4));
    matrix.compose(posv, quat, scalev);
    bushList.push({ matrix: matrix.clone(), tint: 0.8 + rand() * 0.45 });
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
    bc.setRGB(item.tint * 0.95, item.tint, item.tint * 0.85);
    bushMesh.setColorAt(idx, bc);
  });
  bushMesh.instanceMatrix.needsUpdate = true;
  if (bushMesh.instanceColor) bushMesh.instanceColor.needsUpdate = true;
  bushMesh.castShadow = true;
  bushMesh.receiveShadow = true;
  bushMesh.frustumCulled = false;
  group.add(bushMesh);

  return { group, treeCount, rockCount, bushCount: bushList.length };
}
