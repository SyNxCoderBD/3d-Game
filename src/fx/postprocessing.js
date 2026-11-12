import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.9 },
    uGrain: { value: 0.016 },
    uAberration: { value: 0.55 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);

      // Slight lateral chromatic aberration toward the frame edges.
      float ab = uAberration * 0.0016 * r2;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + d * ab).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - d * ab).b;

      // Vignette.
      float vig = 1.0 - uVignette * r2 * 0.85;
      col *= clamp(vig, 0.0, 1.0);

      // Film grain (very subtle).
      float g = rand(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export function createComposer(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();

  const target = new THREE.WebGLRenderTarget(
    Math.floor(size.width * pr),
    Math.floor(size.height * pr),
    { type: THREE.HalfFloatType, samples: 4 }
  );

  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pr);
  composer.setSize(size.width, size.height);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.width, size.height),
    0.42, // strength
    0.75, // radius
    0.92  // threshold
  );
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  const output = new OutputPass();
  composer.addPass(output);

  return {
    composer,
    bloom,
    grade,
    setSize(w, h) {
      composer.setSize(w, h);
    },
    render(dt) {
      grade.uniforms.uTime.value += dt;
      composer.render(dt);
    },
  };
}
