import * as THREE from 'three';
import { WORLD, terrainHeight } from './heightfield.js';
import { U } from './environment.js';
import { SKY_UNIFORMS_GLSL, SKY_FUNCTION_GLSL } from './sky-glsl.js';

/** 8-bit height map of the island, used by the ocean for depth & foam. */
function buildHeightTexture(res = 256) {
  const data = new Uint8Array(res * res);
  const half = WORLD.size * 0.5;
  for (let j = 0; j < res; j++) {
    const z = -half + (j / (res - 1)) * WORLD.size;
    for (let i = 0; i < res; i++) {
      const x = -half + (i / (res - 1)) * WORLD.size;
      const h = terrainHeight(x, z);
      // encode -64 .. 64  ->  0 .. 255
      const v = Math.max(0, Math.min(255, Math.round((h + 64) / 128 * 255)));
      data[j * res + i] = v;
    }
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const vertexShader = /* glsl */`
varying vec3 vWorld;
varying float vDist;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */`
${SKY_UNIFORMS_GLSL}
uniform float uTime;
uniform float uMapSize;
uniform sampler2D uHeightMap;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;

varying vec3 vWorld;
varying float vDist;

${SKY_FUNCTION_GLSL}

float h21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vn2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Sum of directional waves; returns the surface normal via analytic derivatives.
vec3 waveNormal(vec2 p, float t, float dist) {
  vec2 d1 = vec2(0.86, 0.51);
  vec2 d2 = vec2(-0.34, 0.94);
  vec2 d3 = vec2(0.62, -0.78);
  vec2 d4 = vec2(-0.95, -0.31);
  vec2 d5 = vec2(0.24, 0.97);

  float f1 = 0.085, a1 = 0.55;
  float f2 = 0.165, a2 = 0.26;
  float f3 = 0.330, a3 = 0.11;
  float f4 = 0.720, a4 = 0.045;
  float f5 = 1.700, a5 = 0.014;

  float p1 = dot(p, d1) * f1 + t * 0.85;
  float p2 = dot(p, d2) * f2 + t * 1.25;
  float p3 = dot(p, d3) * f3 + t * 1.95;
  float p4 = dot(p, d4) * f4 + t * 2.90;
  float p5 = dot(p, d5) * f5 + t * 4.10;

  // Fade each wave band out with distance: without this, wavelengths far
  // below a pixel produce concentric moire rings on the open sea.
  a2 *= exp(-dist * 0.0011);
  a3 *= exp(-dist * 0.0048);
  a4 *= exp(-dist * 0.0170);
  a5 *= exp(-dist * 0.0620);

  vec2 grad = vec2(0.0);
  grad += d1 * (a1 * f1 * cos(p1));
  grad += d2 * (a2 * f2 * cos(p2));
  grad += d3 * (a3 * f3 * cos(p3));
  grad += d4 * (a4 * f4 * cos(p4));
  grad += d5 * (a5 * f5 * cos(p5));

  // Additional flattening on the far sea.
  grad *= mix(1.0, 0.45, smoothstep(300.0, 2600.0, dist));

  return normalize(vec3(-grad.x, 1.0, -grad.y));
}

void main() {
  vec2 uv = (vWorld.xz / uMapSize) + 0.5;
  float terrain = texture2D(uHeightMap, uv).r * 128.0 - 64.0;
  float depth = max(0.0, -terrain);

  vec3 N = waveNormal(vWorld.xz, uTime, vDist);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(dot(N, V), 0.0);

  // Water body colour.
  vec3 body = mix(uShallowColor, uDeepColor, smoothstep(0.0, 18.0, depth));

  // Sky reflection with Fresnel.
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.03;
  vec3 refl = skyBase(normalize(R));
  vec3 col = mix(body, refl, clamp(fres, 0.04, 0.92));

  // Sun glitter.
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.0);
  col += uSunColor * (pow(nh, 1400.0) * 8.0 + pow(nh, 120.0) * 0.22);

  // Shore foam.
  float band = smoothstep(2.2, 0.05, depth);
  float n = vn2(vWorld.xz * 0.72 + vec2(uTime * 0.22, -uTime * 0.16));
  float n2 = vn2(vWorld.xz * 2.6 - vec2(uTime * 0.35));
  float foam = smoothstep(0.34, 0.86, band * (0.62 + 0.55 * n + 0.22 * n2));
  col = mix(col, vec3(0.86, 0.92, 0.95), foam * 0.9);

  // Soft underwater scatter right at the waterline.
  col = mix(col, uShallowColor * 1.5, smoothstep(1.4, 0.0, depth) * 0.25);

  // Fog, matching the scene's exponential-squared fog.
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vDist * vDist);
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createWater() {
  const geometry = new THREE.PlaneGeometry(7000, 7000, 1, 1);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime,
      uSunDir: U.uSunDir,
      uSunColor: U.uSunColor,
      uSkyZenith: U.uSkyZenith,
      uSkyHorizon: U.uSkyHorizon,
      uSkyGround: U.uSkyGround,
      uFogColor: U.uFogColor,
      uFogDensity: U.uFogDensity,
      uHeightMap: { value: buildHeightTexture(256) },
      uMapSize: { value: WORLD.size },
      uShallowColor: { value: new THREE.Color(0x2f9a92) },
      uDeepColor: { value: new THREE.Color(0x072b45) },
    },
    vertexShader,
    fragmentShader,
    fog: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ocean';
  mesh.position.y = WORLD.waterLevel;
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;
  return mesh;
}
