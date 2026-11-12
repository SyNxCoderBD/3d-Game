import * as THREE from 'three';
import { WORLD } from './world/heightfield.js';
import { U, applyPreset, PRESETS, envState } from './world/environment.js';
import { createSky } from './world/sky.js';
import { createTerrain } from './world/terrain.js';
import { createWater } from './world/water.js';
import { createGrass, createProps } from './world/vegetation.js';
import { createMotes } from './world/particles.js';
import { Effects } from './game/combat.js';
import { Fighter } from './game/fighter.js';
import { BotBrain } from './game/ai.js';
import { Pickups } from './game/pickups.js';
import { KeyboardMouseInput, GamepadInput } from './game/input.js';
import { buildSpawnPoints, buildPickupSpots } from './game/spawns.js';
import { Hud } from './ui/hud.js';
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

/* ------------------------------------------------------------- renderer */

const canvas = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    stencil: false,
    powerPreference: 'high-performance',
  });
} catch (err) {
  fatal('AETHERIS needs hardware-accelerated WebGL2 and it is not available here.\n\n' +
    'Update your graphics driver, or run the game in Edge / Chrome with hardware acceleration on.');
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xbcd7f0, 0.001);

const menuCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, WORLD.far);

/* ----------------------------------------------------------------- lights */

const sun = new THREE.DirectionalLight(0xffffff, 5.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 760;
sun.shadow.camera.left = -160;
sun.shadow.camera.right = 160;
sun.shadow.camera.top = 160;
sun.shadow.camera.bottom = -160;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
sun.shadow.radius = 2.4;
scene.add(sun);
scene.add(sun.target);

const hemi = new THREE.HemisphereLight(0x9db4c8, 0x3b3a2a, 1.1);
scene.add(hemi);

applyPreset(0);
scene.fog.color.copy(U.uFogColor.value);
scene.fog.density = U.uFogDensity.value;
sun.color.copy(U.uSunColor.value);
sun.intensity = PRESETS[0].sunIntensity;
hemi.color.copy(U.uAmbientSky.value);
hemi.groundColor.copy(U.uAmbientGround.value);
hemi.intensity = PRESETS[0].hemiIntensity;

/* ------------------------------------------------------------------ world */

const worldGroup = new THREE.Group();
scene.add(worldGroup);

let sky, terrain, water, propsInfo, motes, effects;
let grassP1, grassP2;

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function buildWorld() {
  const status = $('loadStatus');
  const bar = $('loadBar');
  const step = async (pct, label, fn) => {
    status.textContent = label;
    bar.style.width = pct + '%';
    await nextFrame();
    fn();
  };

  await step(10, 'Raising the sky', () => {
    sky = createSky(WORLD.far * 0.9);
    scene.add(sky);
  });
  await step(28, 'Sculpting the island', () => {
    terrain = createTerrain();
    worldGroup.add(terrain);
  });
  await step(46, 'Flooding the ocean', () => {
    water = createWater();
    worldGroup.add(water);
  });
  await step(62, 'Planting the forests', () => {
    propsInfo = createProps();
    worldGroup.add(propsInfo.group);
  });
  await step(80, 'Seeding the meadows', () => {
    grassP1 = createGrass();
    grassP1.group.traverse((o) => o.layers && o.layers.set(1));
    worldGroup.add(grassP1.group);

    grassP2 = createGrass();
    grassP2.group.traverse((o) => o.layers && o.layers.set(3));
    worldGroup.add(grassP2.group);
  });
  await step(94, 'Loading weapons', () => {
    motes = createMotes(900, 62);
    scene.add(motes);
    effects = new Effects(scene);
  });
  await step(100, 'Ready', () => {});
}

/* ------------------------------------------------------------- game state */

const game = {
  mode: null,             // 'solo' | 'duo'
  fighters: [],
  locals: [],
  bots: [],
  brains: [],
  pickups: null,
  hud: null,
  paused: true,
  running: false,
  over: false,
  spawnPoints: [],
  killLimit: 15,
  cam1: null,
  cam2: null,
  input1: null,
  input2: null,
  menuT: 0,
};

const ambience = new Ambience();
const hud = new Hud($('hudRoot'));

function makeCamera() {
  const cam = new THREE.PerspectiveCamera(78, 1, 0.03, WORLD.far);
  cam.rotation.order = 'YXZ';
  scene.add(cam);
  return cam;
}

function clearMatch() {
  for (const f of game.fighters) {
    scene.remove(f.bodyAnchor);
    if (f.camera) scene.remove(f.camera);
  }
  game.fighters = [];
  game.locals = [];
  game.bots = [];
  game.brains = [];
  if (game.pickups) {
    scene.remove(game.pickups.group);
    game.pickups = null;
  }
  if (game.input1) game.input1.enabled = false;
  if (game.input2) game.input2.enabled = false;
  game.cam1 = null;
  game.cam2 = null;
  game.input1 = null;
  game.input2 = null;
  hud.destroy();
}

function startMatch(mode, botCount = 4) {
  clearMatch();
  game.mode = mode;
  game.over = false;
  game.paused = false;
  game.running = true;
  game.spawnPoints = buildSpawnPoints(mode === 'duo' ? 16 : 14);

  const spots = buildPickupSpots(20);
  game.pickups = new Pickups(scene, spots);
  game.pickups.onCollect = (fighter, type) => {
    const idx = game.locals.indexOf(fighter);
    if (idx >= 0) {
      const label = type === 'medkit' ? 'MEDKIT'
        : type === 'ammo' ? 'AMMO'
        : type === 'armor' ? 'BODY ARMOR'
        : `${type.toUpperCase()} PICKED UP`;
      hud.toast(idx, label);
    }
  };

  // --- player 1 (keyboard + mouse)
  game.cam1 = makeCamera();
  game.cam1.layers.enable(1);   // own viewmodel + own grass
  game.cam1.layers.enable(2);   // player 2's body
  const p1 = new Fighter({
    id: 'p1', name: 'PLAYER 1 👾', scene,
    camera: game.cam1, bodyLayer: mode === 'duo' ? 4 : 4, viewLayer: 1,
    palette: 'p1', spawnPoints: game.spawnPoints,
  });
  p1.slot = 0;
  game.cam1.position.set(0, 0, 0);
  game.fighters.push(p1);
  game.locals.push(p1);

  game.input1 = new KeyboardMouseInput(canvas);
  game.input1.enabled = true;
  game.input1.onLockLost = () => {
    if (game.input1.lookMode === 'lock' && game.running && !game.over) pauseGame();
  };
  game.input1.onFallbackMode = () => hud.toast(0, 'HOLD LEFT MOUSE TO LOOK');

  // --- player 2 (controller)
  if (mode === 'duo') {
    game.cam2 = makeCamera();
    game.cam2.layers.enable(3);
    game.cam2.layers.enable(4);
    const p2 = new Fighter({
      id: 'p2', name: 'PLAYER 2 🎮', scene,
      camera: game.cam2, bodyLayer: 2, viewLayer: 3,
      palette: 'p2', spawnPoints: game.spawnPoints,
    });
    game.fighters.push(p2);
    game.locals.push(p2);
    game.input2 = new GamepadInput(0);
    game.input2.enabled = true;
  }

  // --- bots
  if (mode === 'solo') {
    const names = ['VIPER', 'RAVEN', 'GHOST', 'HAVOC', 'ONYX', 'JACKAL', 'SPECTRE'];
    for (let i = 0; i < botCount; i++) {
      const bot = new Fighter({
        id: `bot${i}`, name: names[i % names.length], scene, isBot: true,
        bodyLayer: 0, palette: i % 2 === 0 ? 'botA' : 'botB',
        spawnPoints: game.spawnPoints, respawnDelay: 4,
      });
      game.fighters.push(bot);
      game.bots.push(bot);
      game.brains.push(new BotBrain(bot, game.spawnPoints, 0.35 + (i / botCount) * 0.5));
    }
  }

  // spawn everyone
  const shuffled = [...game.spawnPoints].sort(() => Math.random() - 0.5);
  game.fighters.forEach((f, i) => {
    const sp = shuffled[i % shuffled.length];
    f.spawnAt(sp.position, sp.yaw);
  });

  // HUD
  hud.createPanes(game.locals.length);
  hud.setNames(game.locals.map((f) => f.name));

  // wire feedback
  game.locals.forEach((f, idx) => {
    f.onHit = (victim, headshot) => hud.flashHit(idx, headshot);
    f.onDamage = () => hud.flashDamage(idx);
    f.onDeath = (killer) => {
      const text = killer && killer !== f ? `${killer.name} ⟶ ${f.name}` : `${f.name} ELIMINATED`;
      hud.addFeed(text, killer === game.locals[0] ? '#7ef7e4' : '#ffb0a0');
    };
  });
  game.fighters.forEach((f) => {
    if (!f.isBot) return;
    f.onDeath = (killer) => {
      hud.addFeed(
        killer ? `${killer.name} ⟶ ${f.name}` : `${f.name} ELIMINATED`,
        killer && game.locals.includes(killer) ? '#7ef7e4' : '#ffb9a8'
      );
    };
  });

  $('menu').classList.remove('show');
  $('pause').classList.remove('show');
  $('victory').classList.remove('show');
  hud.root.classList.add('show');
  document.body.classList.add('playing');

  if (mode === 'duo') {
    game.input1.requestLock();
  } else {
    game.input1.requestLock();
  }
  ambience.start();
  clock.getDelta();
}

function pauseGame() {
  game.paused = true;
  $('pause').classList.add('show');
  document.body.classList.remove('playing');
  if (game.input1) game.input1.enabled = false;
  if (game.input2) game.input2.enabled = false;
}

function resumeGame() {
  game.paused = false;
  $('pause').classList.remove('show');
  document.body.classList.add('playing');
  if (game.input1) game.input1.enabled = true;
  if (game.input2) game.input2.enabled = true;
  if (game.input1) game.input1.requestLock();
  clock.getDelta();
}

function quitToMenu() {
  game.running = false;
  game.paused = true;
  clearMatch();
  hud.root.classList.remove('show');
  document.body.classList.remove('playing');
  $('pause').classList.remove('show');
  $('victory').classList.remove('show');
  $('menu').classList.add('show');
  if (document.pointerLockElement) document.exitPointerLock();
}

/* ------------------------------------------------------------------- loop */

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;

/* Adaptive render scale: split screen renders the world twice, so on modest
   GPUs we quietly drop resolution instead of dropping frames. */
const RENDER_SCALES = [1.5, 1.15, 0.9, 0.75, 0.6];
let scaleIndex = 0;
let slowSeconds = 0;

function ctx() {
  return { fighters: game.fighters, effects, pickups: game.pickups };
}

function simulate(dt) {
  const c = ctx();

  for (let i = 0; i < game.locals.length; i++) {
    const f = game.locals[i];
    const input = i === 0 ? game.input1.poll() : game.input2.poll(dt);
    f.update(dt, input, c);
  }

  for (let i = 0; i < game.bots.length; i++) {
    const bot = game.bots[i];
    const input = game.brains[i].update(dt, c);
    bot.update(dt, input, c);
  }

  // soft body collision so fighters cannot stand inside each other
  for (let i = 0; i < game.fighters.length; i++) {
    for (let j = i + 1; j < game.fighters.length; j++) {
      const a = game.fighters[i];
      const b = game.fighters[j];
      if (!a.alive || !b.alive) continue;
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.001 && d < 0.72) {
        const push = (0.72 - d) * 0.5;
        a.position.x -= (dx / d) * push;
        a.position.z -= (dz / d) * push;
        b.position.x += (dx / d) * push;
        b.position.z += (dz / d) * push;
      }
    }
  }

  game.pickups.update(dt, game.fighters);
  effects.update(dt);

  // grass follows its own player
  grassP1.rebuild(game.locals[0].position.x, game.locals[0].position.z);
  if (game.locals[1]) grassP2.rebuild(game.locals[1].position.x, game.locals[1].position.z);

  // win condition
  if (game.mode === 'duo' && !game.over) {
    const winner = game.locals.find((f) => f.kills >= game.killLimit);
    if (winner) {
      game.over = true;
      game.paused = true;
      $('victory').classList.add('show');
      $('victoryTitle').textContent = `${winner.name} WINS`;
      $('victorySub').textContent = `${game.locals.map((f) => `${f.name} ${f.kills}`).join('   ·   ')}`;
      document.body.classList.remove('playing');
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }
}

function updateHud(dt) {
  if (!game.running) return;
  for (let i = 0; i < game.locals.length; i++) {
    const cam = i === 0 ? game.cam1 : game.cam2;
    hud.update(dt, i, game.locals[i], game.fighters, game.pickups, cam);
  }
  for (let i = 0; i < game.locals.length; i++) {
    if (i === 1 && game.input2 && !game.input2.connected) {
      hud.setSpectating(1, true);
    }
  }
}

function renderView(camera, x, y, w, h) {
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.setScissorTest(true);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  sky.position.copy(camera.position);
  motes.position.copy(camera.position);
  renderer.render(scene, camera);
}

function render() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  if (!game.running) {
    // menu flyover
    const t = game.menuT;
    const ang = 2.1 + t * 0.03;
    menuCamera.aspect = w / h;
    menuCamera.position.set(Math.cos(ang) * 660, 235, Math.sin(ang) * 660);
    menuCamera.lookAt(0, 45, 0);
    menuCamera.updateProjectionMatrix();
    sky.position.copy(menuCamera.position);
    motes.position.copy(menuCamera.position);
    sun.position.copy(menuCamera.position).addScaledVector(U.uSunDir.value, 300);
    sun.target.position.copy(menuCamera.position);
    sun.target.updateMatrixWorld();
    sun.shadow.needsUpdate = true;
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);
    renderer.setScissorTest(true);
    renderer.render(scene, menuCamera);
    return;
  }

  // shadow frustum centred between the local players
  const p1 = game.locals[0];
  const p2 = game.locals[1];
  const cx = p2 ? (p1.position.x + p2.position.x) * 0.5 : p1.position.x;
  const cy = p2 ? (p1.position.y + p2.position.y) * 0.5 : p1.position.y;
  const cz = p2 ? (p1.position.z + p2.position.z) * 0.5 : p1.position.z;
  sun.target.position.set(cx, cy, cz);
  sun.target.updateMatrixWorld();
  sun.position.set(cx, cy, cz).addScaledVector(U.uSunDir.value, 320);
  sun.shadow.needsUpdate = true;

  if (game.mode === 'duo' && game.cam2) {
    const half = Math.floor(w / 2);
    renderView(game.cam1, 0, 0, half, h);
    renderView(game.cam2, half, 0, w - half, h);
  } else {
    renderView(game.cam1, 0, 0, w, h);
  }
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  U.uTime.value += dt;
  game.menuT += dt;

  if (game.running && !game.paused) simulate(dt);
  render();
  updateHud(dt);

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum > 0.5) {
    const fps = Math.round(fpsFrames / fpsAccum);
    const el = $('fps');
    if (el) el.textContent = `${fps} FPS`;

    if (game.running && fps < 46 && scaleIndex < RENDER_SCALES.length - 1) {
      slowSeconds += fpsAccum;
      if (slowSeconds > 2.5) {
        scaleIndex++;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, RENDER_SCALES[scaleIndex]));
        renderer.setSize(window.innerWidth, window.innerHeight);
        slowSeconds = 0;
        console.log(`[quality] render scale → ${RENDER_SCALES[scaleIndex]}`);
      }
    } else if (fps >= 46) {
      slowSeconds = 0;
    }
    fpsAccum = 0;
    fpsFrames = 0;
  }
}

/* -------------------------------------------------------------------- ui */

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

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyT') {
    applyPreset(envState.presetIndex + 1);
    applyEnvironment();
  }
  if (e.code === 'KeyM') ambience.toggle();
});

$('btnSolo').addEventListener('click', (e) => {
  e.stopPropagation();
  const bots = parseInt($('botCount').value, 10) || 4;
  startMatch('solo', bots);
});
$('btnDuo').addEventListener('click', (e) => {
  e.stopPropagation();
  startMatch('duo');
});

$('pause').addEventListener('click', () => resumeGame());
$('btnQuit').addEventListener('click', (e) => { e.stopPropagation(); quitToMenu(); });
$('victory').addEventListener('click', () => {
  $('victory').classList.remove('show');
  startMatch(game.mode, game.bots.length || 4);
});
$('btnVictoryMenu').addEventListener('click', (e) => { e.stopPropagation(); quitToMenu(); });

canvas.addEventListener('click', () => {
  if (game.running && !game.paused && game.input1 && !game.input1.locked) {
    game.input1.requestLock();
  }
});

function updatePadStatus() {
  const el = $('padStatus');
  if (!el) return;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let count = 0;
  for (const p of pads) if (p && p.connected) count++;
  el.textContent = count > 0 ? `CONTROLLER DETECTED (${count})` : 'NO CONTROLLER — PLAYER 2 NEEDS ONE';
  el.classList.toggle('ok', count > 0);
}
setInterval(updatePadStatus, 800);
window.addEventListener('gamepadconnected', updatePadStatus);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  menuCamera.aspect = window.innerWidth / window.innerHeight;
  menuCamera.updateProjectionMatrix();
});

buildWorld().then(() => {
  updatePadStatus();
  $('loader').classList.add('done');
  $('menu').classList.add('show');
  clock.start();
  tick();
});
