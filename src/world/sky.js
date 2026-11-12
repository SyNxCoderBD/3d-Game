import * as THREE from 'three';
import { U } from './environment.js';
import { SKY_UNIFORMS_GLSL, SKY_FUNCTION_GLSL } from './sky-glsl.js';

const vertexShader = /* glsl */`
// The view direction is passed as the raw local position and normalised per
// fragment. Normalising it here instead makes the GPU interpolate a *unit*
// vector across each triangle, which is not the same direction as the one to
// the interpolated point: on a 48x32 sphere that error is large enough to bend
// the horizon gradient into visible facets, which read as a giant hard-edged
// disc across the sky.
varying vec3 vLocal;

void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */`
precision highp float;
${SKY_UNIFORMS_GLSL}
uniform float uTime;
varying vec3 vLocal;

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
float fbm2(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vn2(p);
    p *= 2.07;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 d = normalize(vLocal);
  vec3 col = skyBase(d);

  // ---- cloud deck -------------------------------------------------------
  float up = max(d.y, 0.045);
  vec2 cp = d.xz / up * 0.42;
  cp += vec2(uTime * 0.0045, uTime * 0.0016);

  float base = fbm2(cp * 0.55);
  float detail = fbm2(cp * 1.7 + base * 1.2);
  float mask = smoothstep(0.44, 0.80, base * 0.72 + detail * 0.42);

  // Fade clouds out near the horizon and thin them at the zenith.
  mask *= smoothstep(0.02, 0.22, d.y);
  mask *= mix(1.0, 0.75, smoothstep(0.55, 1.0, d.y));

  // Shading: sunlit tops, cool shadowed undersides, silver rim toward the sun.
  float sunAmt = max(dot(d, uSunDir), 0.0);
  vec3 lit = mix(vec3(0.52, 0.57, 0.66), vec3(1.0), 0.35 + 0.65 * sunAmt);
  lit *= mix(vec3(1.0), uSunColor * 1.25, 0.65);
  float rim = pow(sunAmt, 12.0);
  lit += uSunColor * rim * 1.2;

  col = mix(col, lit, mask * 0.92);

  // Slight dithering to kill banding in the gradients.
  float dither = (h21(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.0035;
  gl_FragColor = vec4(col + dither, 1.0);
}
`;

export function createSky(radius = 5200) {
  const geometry = new THREE.SphereGeometry(radius, 64, 40);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime,
      uSunDir: U.uSunDir,
      uSunColor: U.uSunColor,
      uSkyZenith: U.uSkyZenith,
      uSkyHorizon: U.uSkyHorizon,
      uSkyGround: U.uSkyGround,
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';
  return mesh;
}
