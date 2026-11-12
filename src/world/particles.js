import * as THREE from 'three';
import { U } from '../world/environment.js';

/** Floating pollen / dust motes that follow the camera — cheap atmosphere. */
export function createMotes(count = 900, extent = 60) {
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * extent * 2;
    positions[i * 3 + 1] = (Math.random() - 0.2) * extent * 0.9;
    positions[i * 3 + 2] = (Math.random() - 0.5) * extent * 2;
    phases[i] = Math.random() * Math.PI * 2;
    sizes[i] = 0.12 + Math.random() * 0.42;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime,
      uSunColor: U.uSunColor,
      uExtent: { value: extent },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */`
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform float uExtent;
      uniform float uPixelRatio;
      varying float vAlpha;

      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.32 + aPhase) * 1.4;
        p.y += sin(uTime * 0.21 + aPhase * 1.7) * 0.9 + mod(uTime * 0.35 + aPhase * 3.0, 6.0) - 3.0;
        p.z += cos(uTime * 0.27 + aPhase * 0.8) * 1.4;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        vAlpha = smoothstep(uExtent * 1.15, 6.0, d) * 0.3;

        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uPixelRatio * (95.0 / max(d, 1.0)), 0.6, 9.0 * uPixelRatio);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uSunColor;
      varying float vAlpha;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.02, length(q));
        if (a <= 0.001) discard;
        gl_FragColor = vec4(uSunColor * 0.7 + 0.42, a * vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.name = 'motes';
  return points;
}
