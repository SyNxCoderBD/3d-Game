import * as THREE from 'three';
import { WORLD, terrainHeight } from './heightfield.js';
import { smoothstep, saturate } from '../util/math.js';
import { createNoise2D, fbm } from '../util/noise.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

const PALETTE = {
  sandLight: C(0xd9c9a2),
  sandDeep: C(0x8d8663),
  seabed: C(0x54614a),
  grassA: C(0x6d8c46),
  grassB: C(0x3f5c31),
  moss: C(0x2f4a26),
  rock: C(0x6f6b63),
  rockDark: C(0x484540),
  snow: C(0xe8eef4),
};

const nVar = createNoise2D(9182);
const nMacro = createNoise2D(3311);

export function createTerrain() {
  const geometry = new THREE.PlaneGeometry(
    WORLD.size, WORLD.size, WORLD.segments, WORLD.segments
  );
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.attributes.position;
  const count = pos.count;

  for (let i = 0; i < count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  geometry.computeVertexNormals();

  const normals = geometry.attributes.normal;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  const tmp = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ny = normals.getY(i);
    const slope = 1 - ny;

    const macro = fbm(nMacro, x * 0.0035, z * 0.0035, 3) * 0.5 + 0.5;
    const micro = fbm(nVar, x * 0.05, z * 0.05, 3) * 0.5 + 0.5;

    // Base grass, varied by two noise scales.
    c.copy(PALETTE.grassA).lerp(PALETTE.grassB, saturate(macro * 1.15 + micro * 0.35 - 0.15));
    c.lerp(PALETTE.moss, smoothstep(0.55, 0.9, micro) * 0.35);

    // Beach / shoreline sand.
    const beach = smoothstep(5.0, 0.6, y + (macro - 0.5) * 2.6);
    c.lerp(PALETTE.sandLight, beach);

    // Seabed.
    c.lerp(PALETTE.sandDeep, smoothstep(0.5, -3.5, y));
    c.lerp(PALETTE.seabed, smoothstep(-3.0, -14.0, y));

    // Cliffs and exposed rock on steep faces.
    const rockAmt = smoothstep(0.26, 0.52, slope + (micro - 0.5) * 0.12);
    tmp.copy(PALETTE.rock).lerp(PALETTE.rockDark, micro * 0.7);
    c.lerp(tmp, rockAmt * 0.92);

    // Snow caps on high, flatter ground.
    const snowAmt = smoothstep(96, 132, y + (macro - 0.5) * 14) * smoothstep(0.62, 0.22, slope);
    c.lerp(PALETTE.snow, snowAmt);

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.93,
    metalness: 0.0,
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vWorldPos;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;'
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorldPos;
        float th21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
        float tvn(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(th21(i), th21(i + vec2(1.0, 0.0)), f.x),
                     mix(th21(i + vec2(0.0, 1.0)), th21(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float tfbm(vec2 p) {
          float a = 0.5; float s = 0.0;
          for (int i = 0; i < 4; i++) { s += a * tvn(p); p *= 2.06; a *= 0.5; }
          return s;
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float dMacro = tfbm(vWorldPos.xz * 0.0022);
        float dMid = tfbm(vWorldPos.xz * 0.037);
        float dFine = tvn(vWorldPos.xz * 0.55);
        float detail = 0.70 + 0.46 * dMacro + 0.22 * dMid + 0.10 * dFine;
        diffuseColor.rgb *= clamp(detail, 0.32, 1.55);
        // break up the palette with gentle warmth/coolness
        diffuseColor.rgb *= mix(vec3(1.04, 1.0, 0.92), vec3(0.94, 1.0, 1.05), dMid);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * (0.88 + 0.24 * dMid), 0.45, 1.0);`
      );
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
