import * as THREE from 'three';
import { WORLD, terrainHeight } from './world/heightfield.js';
import { U, applyPreset, PRESETS, envState } from './world/environment.js';
import { createSky } from './world/sky.js';
import { createTerrain } from './world/terrain.js';
import { createWater } from './world/water.js';
import { createGrass, createProps } from './world/vegetation.js';
import { createMotes } from './world/particles.js';
import { Player, findSpawn } from './player/controller.js';
import { createComposer } from './fx/postprocessing.js';
import { Ambience } from './audio/ambience.js';

const $ = (id) => document.getElementById(id);

function fatal(message) {
  const el = $('fatal');
  if (!el) return;
  el.querySelector('.msg').textContent = message;
  el.classList.add('show');
}

window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
  fatal(e.message || 'Unknown error');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  fatal(e.reason && e.reason.message ? e.reason.message : String(e.reason));
});

/* ------------------------------------------------------------------ setup */

const canvas = $('scene');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
} catch (err) {
  fatal(
    'AETHERIS needs hardware-accelerated WebGL2 and it is not available on this ' +
    'device.\n\nTry updating your graphics driver, or open the page in Microsoft ' +
    'Edge / Chrome with hardware acceleration enabled.'
  );
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xbcd7f0, 0.001);

const camera = new THREE.PerspectiveCamera(
  73,
  window.innerWidth / window.innerHeight,
  0.1,
  WORLD.far
);

/* ----------------------------------------------------------------- lights */

const sun = new THREE.DirectionalLight(0xffffff, 4.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 720;
sun.shadow.camera.left = -150;
sun.shadow.camera.right = 150;
sun.shadow.camera.top = 150;
sun.shadow.camera.bottom = -150;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
sun.shadow.radius = 2.6;
scene.add(sun);
scene.add(sun.target);

const hemi = new THREE.HemisphereLight(0x9db4c8, 0x3b3a2a, 1.1);
scene.add(hemi);

/* ------------------------------------------------------------------ world */

const world = new THREE.Group();
world.name = 'world';
scene.add(world);

let sky, terrain, water, grassInfo, propsInfo, motes, composer, player;
let intro = true;
let started = false;
let introT = 0;
let spawn = { x: 0, z: 0 };
const sunWorldColor = new THREE.Color();

applyPreset(0);
scene.fog.color.copy(U.uFogColor.value);
scene.fog.density = U.uFogDensity.value;
sun.color.copy(U.uSunColor.value);
sun.intensity = PRESETS[0].sunIntensity;
hemi.color.copy(U.uAmbientSky.value);
hemi.groundColor.copy(U.uAmbientGround.value);
hemi.intensity = PRESETS[0].hemiIntensity;

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function build() {
  const status = $('loadStatus');
  const bar = $('loadBar');

  const step = async (pct, label, fn) => {
    status.textContent = label;
    bar.style.width = pct + '%';
    await nextFrame();
    const t0 = performance.now();
    fn();
    console.log(`[build] ${label} ${(performance.now() - t0).toFixed(0)}ms`);
  };

  await step(8, 'Raising the sky', () => {
    sky = createSky(WORLD.far * 0.9);
    scene.add(sky);
  });

  await step(24, 'Sculpting the island', () => {
    terrain = createTerrain();
    world.add(terrain);
  });

  await step(46, 'Flooding the ocean', () => {
    water = createWater();
    world.add(water);
  });

  await step(62, 'Planting the forests', () => {
    propsInfo = createProps();
    world.add(propsInfo.group);
  });

  await step(84, 'Seeding the meadows', () => {
    grassInfo = createGrass();
    world.add(grassInfo.group);
  });

  await step(94, 'Lighting the sun', () => {
    motes = createMotes(900, 62);
    scene.add(motes);
  });

  await step(100, 'Ready', () => {
    try {
      composer = createComposer(renderer, scene, camera);
    } catch (err) {
      console.warn('Post-processing unavailable, falling back to direct rendering', err);
      composer = null;
    }
    player = new Player(camera, canvas);

    spawn = findSpawn();
    // Face outward from the island centre so the first thing you see is the sea.
    const r = Math.hypot(spawn.x, spawn.z) || 1;
    const yaw = Math.atan2(-(spawn.x / r), -(spawn.z / r));
    player.spawnAt(spawn.x, spawn.z, yaw);

    player.onLockChange = (locked) => {
      if (!started) return;
      if (locked) hideOverlay();
      else if (!player.dragLook) showOverlay('paused');
    };
    player.onFallback = () => {
      $('lookHint').classList.add('show');
      hideOverlay();
    };

    grassInfo.rebuild(spawn.x, spawn.z);

    console.log(
      `[world] trees=${propsInfo.treeCount} rocks=${propsInfo.rockCount} ` +
      `bushes=${propsInfo.bushCount} grass=${grassInfo.count} spawn=${spawn.x.toFixed(0)},${spawn.z.toFixed(0)}`
    );
  });

  setTimeout(() => {
    $('loader').classList.add('done');
    $('overlay').classList.add('show');
  }, 220);
}

/* -------------------------------------------------------------------- ui */

const overlay = $('overlay');
const enterBtn = $('enterBtn');
const menuPanel = $('menuPanel');
const pausePanel = $('pausePanel');
const toast = $('toast');
let toastTimer = 0;

function showOverlay(state) {
  overlay.classList.add('show');
  document.body.classList.remove('playing');
  if (state === 'paused') {
    menuPanel.style.display = 'none';
    pausePanel.style.display = 'flex';
  }
}

function hideOverlay() {
  overlay.classList.remove('show');
  document.body.classList.add('playing');
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1900);
}

function beginPlay() {
  if (!player) return;
  started = true;
  intro = false;
  $('loader').classList.add('done');
  $('hud').classList.add('show');
  document.body.classList.add('playing');
  player.syncCamera();
  ambience.start();
  setTimeout(() => $('controlsHint').classList.add('fade'), 9000);
}

overlay.addEventListener('click', () => {
  if (!player) return;
  if (!started) beginPlay();
  player.requestLock();
  if (player.dragLook) hideOverlay();
  setTimeout(() => {
    if (started && (player.locked || player.dragLook)) hideOverlay();
  }, 300);
});

canvas.addEventListener('click', () => {
  if (started && !player.locked && !player.dragLook) player.requestLock();
});

const ambience = new Ambience();

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyT') {
    applyPreset(envState.presetIndex + 1);
    applyEnvironment();
    showToast(envState.preset.name);
  }
  if (e.code === 'KeyM') {
    const muted = ambience.toggle();
    showToast(muted ? 'AUDIO OFF' : 'AUDIO ON');
  }
  if (e.code === 'KeyH') {
    $('hud').classList.toggle('hidden');
  }
  if (e.code === 'KeyR' && started) {
    player.spawnAt(spawn.x, spawn.z, player.yaw);
    showToast('RETURNED TO CAMP');
  }
  if (e.code === 'KeyP') {
    // quick screenshot to the clipboard-less fallback: open in a new tab
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'aetheris.png';
      a.click();
      showToast('SCREENSHOT SAVED');
    }, 'image/png');
  }
});

function applyEnvironment() {
  const p = envState.preset;
  sun.color.copy(U.uSunColor.value);
  sun.intensity = p.sunIntensity;
  hemi.color.copy(U.uAmbientSky.value);
  hemi.groundColor.copy(U.uAmbientGround.value);
  hemi.intensity = p.hemiIntensity;
  scene.fog.color.copy(U.uFogColor.value);
  scene.fog.density = U.uFogDensity.value;
  renderer.toneMappingExposure = p.exposure;
}

/* ------------------------------------------------------------------ loop */

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;
let hudTimer = 0;

/* ---- adaptive quality: keep the frame rate playable on modest GPUs ---- */
let qualityLevel = 0;
let perfTimer = 0;
let perfFrames = 0;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  if (composer) composer.setSize(w, h);
}

function applyQuality(level) {
  if (level === 1) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  } else if (level === 2) {
    renderer.setPixelRatio(1);
  } else if (level >= 3) {
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = false;
    scene.traverse((o) => {
      if (o.isMesh) o.castShadow = false;
    });
    sun.castShadow = false;
    if (composer && composer.bloom) composer.bloom.strength = 0.24;
  }
  resize();
  console.log(`[quality] level ${level}`);
}

function watchPerformance(dt) {
  perfTimer += dt;
  perfFrames++;
  if (perfTimer < 3) return;
  const fps = perfFrames / perfTimer;
  perfTimer = 0;
  perfFrames = 0;
  if (fps < 42 && qualityLevel < 3) {
    qualityLevel++;
    applyQuality(qualityLevel);
  }
}

const headingEl = $('heading');
const fpsEl = $('fps');

const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function updateIntro(dt) {
  introT += dt;
  const ang = 2.1 + introT * 0.035;
  const r = 660;
  camera.position.set(Math.cos(ang) * r, 235 + Math.sin(introT * 0.12) * 12, Math.sin(ang) * r);
  camera.lookAt(0, 45, 0);
}

function tick() {
  requestAnimationFrame(tick);

  const dt = Math.min(clock.getDelta(), 0.05);
  U.uTime.value += dt;

  if (player) {
    if (intro) updateIntro(dt);
    else {
      player.update(dt);
      grassInfo.rebuild(player.position.x, player.position.z);
    }
  }

  // Keep the sky dome and motes centred on the camera.
  sky.position.copy(camera.position);
  motes.position.copy(camera.position);

  // Sun + shadow frustum follow the viewer.
  sunWorldColor.copy(U.uSunColor.value);
  sun.position.copy(camera.position).addScaledVector(U.uSunDir.value, 300);
  sun.target.position.copy(camera.position);
  sun.target.updateMatrixWorld();

  if (composer) composer.render(dt);
  else renderer.render(scene, camera);
  watchPerformance(dt);

  // HUD
  fpsAccum += dt;
  fpsFrames++;
  hudTimer += dt;
  if (hudTimer > 0.4) {
    const fps = fpsFrames / fpsAccum;
    fpsEl.textContent = fps.toFixed(0);
    fpsAccum = 0;
    fpsFrames = 0;
    hudTimer = 0;

    if (player) {
      let deg = (-player.yaw * 180) / Math.PI;
      deg = ((deg % 360) + 360) % 360;
      const idx = Math.round(deg / 45) % 8;
      headingEl.textContent = `${DIRECTIONS[idx]} ${deg.toFixed(0).padStart(3, '0')}`;
    }
  }
}

window.addEventListener('resize', resize);

build().then(() => {
  clock.start();
  tick();
});

console.log('%c AETHERIS ', 'background:#1d3b2f;color:#d8e8c0;font-weight:bold');
