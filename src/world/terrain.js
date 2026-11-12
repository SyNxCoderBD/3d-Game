import * as THREE from 'three';
import { WORLD, terrainHeight } from './heightfield.js';
import { setHeightGrid } from './heightgrid.js';
import { smoothstep, saturate, clamp } from '../util/math.js';
import { createNoise2D, fbm } from '../util/noise.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

const PALETTE = {
  sandDry: C(0xdcc99b),
  sandWet: C(0xa2966f),
  seabed: C(0x4c5c42),
  grassDeep: C(0x2b4318),
  grassMid: C(0x3f5f21),
  grassLight: C(0x6f9435),
  dryGrass: C(0x938f47),
  forestFloor: C(0x27330f),
  rockLight: C(0x928779),
  rockMid: C(0x6b6459),
  rockDark: C(0x3d3931),
  scree: C(0x7d7568),
  snow: C(0xf4f8fc),
};

const nVar = createNoise2D(9182);
const nMacro = createNoise2D(3311);
const nPatch = createNoise2D(6612);

const COMMON_GLSL = /* glsl */`
varying vec3 vWorldPos;

// Cheap value-noise hash (no transcendentals: this runs per pixel).
float th21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float tvn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(th21(i), th21(i + vec2(1.0, 0.0)), f.x),
             mix(th21(i + vec2(0.0, 1.0)), th21(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec2 thash2(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(vec2(p.x * p.y, p.x + p.y));
}
// Multi-scale ground relief, sampled per pixel.
float reliefBase(vec2 p) {
  return tvn(p * 0.26) * 0.60
       + tvn(p * 1.15) * 0.26
       + tvn(p * 4.30) * 0.14;
}
vec2 reliefGrad(vec2 p) {
  const float e = 0.07;
  float gx = reliefBase(p + vec2(e, 0.0)) - reliefBase(p - vec2(e, 0.0));
  float gz = reliefBase(p + vec2(0.0, e)) - reliefBase(p - vec2(0.0, e));
  return vec2(gx, gz) / (2.0 * e);
}
`;

const COLOR_GLSL = /* glsl */`
float camDist = distance(vWorldPos, cameraPosition);
float fineFade = 1.0 - smoothstep(30.0, 140.0, camDist);

float gRelief = reliefBase(vWorldPos.xz);
float gMid = tvn(vWorldPos.xz * 0.045) * 0.62 + tvn(vWorldPos.xz * 0.11) * 0.38;

// Crevice shading + macro colour variation.
diffuseColor.rgb *= 0.76 + 0.34 * gRelief + 0.16 * (gMid - 0.5);
diffuseColor.rgb *= mix(vec3(1.07, 1.0, 0.89), vec3(0.91, 1.0, 1.08), gMid);

// Keep some saturation after all the multiplying.
float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
diffuseColor.rgb = max(mix(vec3(lum), diffuseColor.rgb, 1.12), vec3(0.0));
`;

const NORMAL_GLSL = /* glsl */`
{
  vec3 wn = inverseTransformDirection(normal, viewMatrix);
  float flatness = clamp(wn.y, 0.0, 1.0);
  float rocky = smoothstep(0.06, 0.5, 1.0 - flatness);
  vec2 g = reliefGrad(vWorldPos.xz) * mix(0.28, 1.0, fineFade);
  float strength = mix(0.16, 0.42, rocky) * mix(1.0, 0.4, smoothstep(40.0, 260.0, camDist));
  wn = normalize(wn + vec3(-g.x, 0.0, -g.y) * strength);
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}
`;

const ROUGH_GLSL = /* glsl */`
roughnessFactor = clamp(roughnessFactor * (0.86 + 0.26 * gRelief), 0.42, 1.0);
`;

export function createTerrain() {
  const geometry = new THREE.PlaneGeometry(
    WORLD.size, WORLD.size, WORLD.segments, WORLD.segments
  );
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.attributes.position;
  const count = pos.count;
  const row = WORLD.segments + 1;

  for (let i = 0; i < count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  geometry.computeVertexNormals();

  // Publish the exact rendered surface for grass/prop placement.
  const heights = new Float32Array(count);
  for (let i = 0; i < count; i++) heights[i] = pos.array[i * 3 + 1];
  setHeightGrid(row, WORLD.size, heights);

  /* Ambient occlusion baked from the height grid: valleys and gully bottoms
     darken, ridges catch light. Free at render time, kills the "clay" look. */
  const arr = pos.array;
  const ao = new Float32Array(count);
  for (let iy = 0; iy < row; iy++) {
    for (let ix = 0; ix < row; ix++) {
      const i = iy * row + ix;
      const y = arr[i * 3 + 1];
      let sum = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const jy = iy + dy;
        if (jy < 0 || jy >= row) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const jx = ix + dx;
          if (jx < 0 || jx >= row) continue;
          if (dx === 0 && dy === 0) continue;
          sum += arr[(jy * row + jx) * 3 + 1];
          n++;
        }
      }
      const avg = n > 0 ? sum / n : y;
      ao[i] = clamp(1 + (y - avg) * 0.11, 0.58, 1.08);
    }
  }

  /* Vertex palette */
  const normals = geometry.attributes.normal;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  const tmp = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const slope = 1 - normals.getY(i);

    const macro = fbm(nMacro, x * 0.0024, z * 0.0024, 3) * 0.5 + 0.5;
    const patch = fbm(nPatch, x * 0.011, z * 0.011, 3) * 0.5 + 0.5;
    const micro = fbm(nVar, x * 0.062, z * 0.062, 3) * 0.5 + 0.5;

    c.copy(PALETTE.grassDeep).lerp(PALETTE.grassMid, smoothstep(0.18, 0.62, macro));
    c.lerp(PALETTE.grassLight, smoothstep(0.42, 0.88, patch) * 0.85);
    c.lerp(PALETTE.forestFloor, smoothstep(0.62, 0.96, 1 - patch) * 0.7);
    c.lerp(PALETTE.dryGrass, smoothstep(0.66, 1.0, micro) * 0.55);

    // Grass thins out above the treeline.
    const alpine = smoothstep(70, 112, y + (macro - 0.5) * 18);
    tmp.copy(PALETTE.scree).lerp(PALETTE.rockMid, micro);
    c.lerp(tmp, alpine * 0.85);

    // Rock on steep faces, with noisy edges.
    const rockAmt = smoothstep(0.30, 0.58, slope + (micro - 0.5) * 0.14 + alpine * 0.08);
    tmp.copy(PALETTE.rockMid).lerp(PALETTE.rockLight, smoothstep(0.35, 0.85, micro));
    tmp.lerp(PALETTE.rockDark, smoothstep(0.55, 1.0, patch) * 0.7);
    c.lerp(tmp, rockAmt * 0.94);

    // Snow caps.
    const snowAmt = smoothstep(96, 128, y + (macro - 0.5) * 12) * smoothstep(0.75, 0.32, slope);
    c.lerp(PALETTE.snow, snowAmt);

    // Beach + sea floor.
    c.lerp(PALETTE.sandDry, smoothstep(4.2, 0.5, y + (macro - 0.5) * 2.8));
    c.lerp(PALETTE.sandWet, smoothstep(0.4, -3.0, y));
    c.lerp(PALETTE.seabed, smoothstep(-2.5, -13.0, y));

    // Saturation nudge + baked occlusion.
    const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    c.setRGB(
      lum + (c.r - lum) * 1.18,
      lum + (c.g - lum) * 1.18,
      lum + (c.b - lum) * 1.18
    );
    const k = ao[i];
    colors[i * 3] = Math.max(0, c.r * k);
    colors[i * 3 + 1] = Math.max(0, c.g * k);
    colors[i * 3 + 2] = Math.max(0, c.b * k);
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;'
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + COLOR_GLSL)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + NORMAL_GLSL)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + ROUGH_GLSL);
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
