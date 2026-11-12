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
import { KeyboardMouseInput, GamepadInput, KeyboardSecondInput } from './game/input.js';
import { Match } from './game/match.js';
import { Sfx } from './audio/sfx.js';
import { WEAPONS } from './game/weapons.js';
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

const settings = {
  volume: 0.9,
  quality: 'auto',
  rumble: true,
};

try {
  const saved = JSON.parse(localStorage.getItem('aetheris.settings') || 'null');
  if (saved && typeof saved === 'object') Object.assign(settings, saved);
} catch (_) { /* private mode */ }

function saveSettings() {
  try { localStorage.setItem('aetheris.settings', JSON.stringify(settings)); } catch (_) { /* ignore */ }
}

const game = {
  mode: null,             // 'solo' | 'duo'
  fighters: [],
  locals: [],
  bots: [],
  brains: [],
  pickups: null,
  paused: true,
  running: false,
  over: false,
  spawnPoints: [],
  killLimit: 15,
  timeLimit: 0,           // 0 = no clock
  cam1: null,
  cam2: null,
  input1: null,
  input2: null,
  menuT: 0,
  match: null,
  spectate: [null, null],
  botCount: 4,
};

const ambience = new Ambience();
ambience.volume = settings.volume;
const sfx = new Sfx();
sfx.setMuted(false);
const hud = new Hud($('hudRoot'));

function makeCamera() {
  const cam = new THREE.PerspectiveCamera(78, 1, 0.03, WORLD.far);
  cam.rotation.order = 'YXZ';
  scene.add(cam);
  return cam;
}

function createMatchFor(mode, killLimit) {
  const match = new Match({
    mode,
    killLimit: mode === 'duo' ? killLimit : 0,
    timeLimit: mode === 'duo' ? 420 : 0,
  });
  return match;
}

/* ------------------------------------------------------------- match flow */

function clearMatch() {
  for (const f of game.fighters) {
    scene.remove(f.bodyAnchor);
    if (f.camera) scene.remove(f.camera);
  }
  game.fighters = [];
  game.locals = [];
  game.bots = [];
  game.brains = [];
  game.spectate = [null, null];
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
  game.match = null;
  if (effects) effects.clear?.();
  hud.destroy();
}

/** Attach every feedback hook a fighter can fire. `idx` is its HUD pane. */
function wireFighter(f, idx) {
  const match = game.match;

  f.onShot = (def, muzzle) => {
    if (match) match.shot(f);
    sfx.shot(def.kind, muzzle, f.isLocal);
    if (f.isLocal) {
      // Muzzle flash + controller kick for pad shooters.
      f.flashTimer = Math.max(f.flashTimer, 0.04);
      if (f.inputSource === 'pad' && settings.rumble) {
        const kick = def.kind === 'shotgun' || def.kind === 'sniper' ? 0.85 : 0.42;
        game.input2?.rumble(kick, 70, 0.3);
      }
    }
  };
  f.onEmpty = () => sfx.emptyClick();
  f.onReloadStart = (def) => { if (f.isLocal) sfx.reloadStart(def.kind); };
  f.onReloadEnd = () => { if (f.isLocal) sfx.reloadEnd(); };
  f.onHeal = () => { if (f.isLocal) sfx.heal(); };
  f.onSwap = () => { if (f.isLocal) sfx.reloadStart('pistol'); };

  f.onHit = (victim, headshot) => {
    if (idx >= 0 && idx < game.locals.length) {
      hud.flashHit(idx, headshot);
      sfx.hit(headshot);
      sfx.flesh();
    }
  };

  f.onDamage = (amount, from, headshot) => {
    if (match && from) match.hit(from, headshot, amount);
    if (idx >= 0 && idx < game.locals.length) {
      hud.flashDamage(idx);
      sfx.hurt();
      if (f.lastHitAngle !== undefined) hud.showDamageDirection(idx, f.lastHitAngle);
      if (f.inputSource === 'pad' && settings.rumble) game.input2?.rumble(0.7, 160, 0.5);
    }
  };

  f.onDeath = (killer) => {
    const res = match ? match.kill(killer, f) : null;
    // Leave the victim's gun behind as transient loot.
    if (game.pickups && f.slots[f.slot]) game.pickups.dropFrom(f);
    const local = game.locals.includes(f);
    const color = killer && game.locals.includes(killer) ? '#7ef7e4' : '#ffb0a0';
    const text = killer && killer !== f
      ? `${killer.name} ⟶ ${f.name}${res?.headshot ? ' ☠' : ''}`
      : `${f.name} ELIMINATED`;
    hud.addFeed(text, color);
    if (local) {
      sfx.death();
      if (f.inputSource === 'pad' && settings.rumble) game.input2?.rumble(1, 400, 0.8);
    }
    if (killer && game.locals.includes(killer)) {
      const kIdx = game.locals.indexOf(killer);
      if (res?.milestone) {
        hud.showStreak(kIdx, res.milestone);
        sfx.streak(res.streak);
      }
      if (res?.revenge) hud.toast(kIdx, 'REVENGE');
    }
    if (res?.over) endMatch();
  };
}

function startMatch(mode, botCount = 4, killLimit = 15) {
  clearMatch();
  game.mode = mode;
  game.over = false;
  game.paused = false;
  game.running = true;
  game.botCount = botCount;
  game.killLimit = killLimit;
  game.match = createMatchFor(mode, killLimit);
  game.spawnPoints = buildSpawnPoints(mode === 'duo' ? 16 : 14);

  const spots = buildPickupSpots(mode === 'duo' ? 26 : 22);
  game.pickups = new Pickups(scene, spots);
  game.pickups.onCollect = (fighter, type) => {
    const idx = game.locals.indexOf(fighter);
    if (idx >= 0) {
      const label = type === 'medkit' ? 'MEDKIT +1'
        : type === 'ammo' ? 'AMMO RESUPPLY'
        : type === 'armor' ? 'BODY ARMOR'
        : `${(WEAPONS[type]?.short || type.toUpperCase())} EQUIPPED`;
      hud.toast(idx, label);
      sfx.pickup(type);
    }
  };

  // --- player 1 (keyboard + mouse)
  game.cam1 = makeCamera();
  game.cam1.layers.enable(1);   // own viewmodel + own grass
  game.cam1.layers.enable(2);   // player 2's body
  const p1 = new Fighter({
    id: 'p1', name: 'PLAYER 1', scene,
    camera: game.cam1, bodyLayer: 4, viewLayer: 1,
    palette: 'p1', spawnPoints: game.spawnPoints,
  });
  p1.inputSource = 'kbm';
  game.fighters.push(p1);
  game.locals.push(p1);

  game.input1 = new KeyboardMouseInput(canvas);
  game.input1.enabled = true;
  game.input1.onLockLost = () => {
    if (game.input1.lookMode === 'lock' && game.running && !game.over) pauseGame();
  };
  game.input1.onFallbackMode = () => hud.toast(0, 'HOLD LEFT MOUSE TO LOOK');

  // --- player 2 (controller, or the keyboard fallback)
  if (mode === 'duo') {
    game.cam2 = makeCamera();
    game.cam2.layers.enable(3);
    game.cam2.layers.enable(4);
    const p2 = new Fighter({
      id: 'p2', name: 'PLAYER 2', scene,
      camera: game.cam2, bodyLayer: 2, viewLayer: 3,
      palette: 'p2', spawnPoints: game.spawnPoints,
    });
    const pad = new GamepadInput(0);
    if (pad.connected) {
      game.input2 = pad;
      p2.inputSource = 'pad';
    } else {
      game.input2 = new KeyboardSecondInput();
      p2.inputSource = 'keys2';
      hud.toast(0, 'P2: NO CONTROLLER — IJKL + ARROWS');
    }
    // Pads are less precise than a mouse: give them a light aim assist.
    p2.aimAssist = p2.inputSource === 'pad';
    game.input2.enabled = true;
    game.fighters.push(p2);
    game.locals.push(p2);
  }

  // --- bots
  if (mode === 'solo') {
    const names = ['VIPER', 'RAVEN', 'GHOST', 'HAVOC', 'ONYX', 'JACKAL', 'SPECTRE', 'TALON'];
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

  // spawn everyone, keeping the two duelists apart
  const shuffled = [...game.spawnPoints].sort(() => Math.random() - 0.5);
  game.fighters.forEach((f, i) => {
    const sp = shuffled[i % shuffled.length];
    f.spawnAt(sp.position, sp.yaw);
  });
  game.match?.reset();
  game.fighters.forEach((f) => game.match.stat(f));

  // HUD
  hud.createPanes(game.locals.length);
  hud.setNames(game.locals.map((f) => f.name));
  hud.setClock(game.match?.clock ?? '∞');

  // wire feedback
  game.locals.forEach((f, idx) => {
    wireFighter(f, idx);
    f.onRespawn = () => {
      game.spectate[idx] = null;
      sfx.spawn();
    };
  });
  game.bots.forEach((f) => wireFighter(f, -1));

  // audio
  ambience.start();
  if (ambience.ctx) sfx.attach(ambience.ctx);
  sfx.setListeners([game.cam1, game.cam2]);
  sfx.setMuted(settings.volume <= 0);
  sfx.volume = settings.volume;

  $('menu').classList.remove('show');
  $('pause').classList.remove('show');
  $('victory').classList.remove('show');
  hud.root.classList.add('show');
  document.body.classList.add('playing');

  game.input1.requestLock();
  clock.getDelta();
}

function formatReasons(match, winner) {
  if (match.reason === 'time') return winner ? 'TIME UP · HIGHEST SCORE WINS' : 'TIME UP · DRAW';
  if (match.reason === 'eliminated') return 'YOU WERE ELIMINATED';
  return winner ? `${match.killLimit} ELIMINATIONS` : '';
}

function endMatch() {
  const match = game.match;
  if (!match || game.over) return;
  game.over = true;
  game.paused = true;           // freezes simulate(), keeps the arena rendered
  if (document.pointerLockElement) document.exitPointerLock();

  const winner = match.resolveTimeoutWinner(game.fighters);

  if (game.input1) game.input1.enabled = false;
  if (game.input2) game.input2.enabled = false;
  document.body.classList.remove('playing');

  // "me" marks all local players so a split-screen scoreboard reads clearly.
  const rows = match.results(game.fighters).map((r) => ({
    name: r.name,
    values: [
      r.kills,
      r.deaths,
      `${Math.round(r.accuracy * 100)}%`,
      r.damage,
      r.headshots,
      r.bestStreak,
    ],
    me: game.locals.includes(r.fighter),
  }));

  let headline;
  if (game.mode === 'duo') {
    headline = winner ? `${winner.name} WINS` : 'DRAW';
  } else {
    const you = match.results(game.fighters).find((r) => !r.fighter.isBot);
    headline = winner && winner.isBot ? `${winner.name} WINS` : 'RUN OVER';
    if (you) headline += ` · ${you.kills} KILLS`;
  }

  const sub = `${formatReasons(match, winner)}${game.mode === 'solo'
    ? `  ·  ${rows[0]?.values[0] ?? 0} KILLS` : ''}`;

  const body = $('victoryBody');
  body.innerHTML = hud.renderEndcard(
    headline, sub,
    ['K', 'D', 'ACC', 'DMG', 'HS', 'STREAK'],
    rows.slice(0, game.mode === 'duo' ? 2 : 8)
  );
  $('victory').classList.add('show');
  sfx.announce('victory');
}

function pauseGame() {
  if (game.over) return;
  game.paused = true;
  $('pause').classList.add('show');
  document.body.classList.remove('playing');
  if (game.input1) game.input1.enabled = false;
  if (game.input2) game.input2.enabled = false;
}

function resumeGame() {
  if (game.over) return;
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
  game.over = false;
  resetViews();
  clearMatch();
  hud.root.classList.remove('show');
  document.body.classList.remove('playing');
  $('pause').classList.remove('show');
  $('victory').classList.remove('show');
  $('menu').classList.add('show');
  if (document.pointerLockElement) document.exitPointerLock();
  updatePadStatus();
}

/* ------------------------------------------------------------------- loop */

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;

/* Adaptive render scale: split screen renders the world twice, so on modest
   GPUs we quietly drop resolution instead of dropping frames. */
const QUALITY_CAPS = { high: 1.5, balanced: 1.0, low: 0.7, auto: 1.5 };
const RENDER_SCALES = [1.5, 1.15, 0.9, 0.75, 0.6];
let scaleIndex = 0;
let slowSeconds = 0;
let fastSeconds = 0;

function applyQuality() {
  const cap = QUALITY_CAPS[settings.quality] ?? 1.5;
  scaleIndex = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, cap);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  slowSeconds = 0;
  fastSeconds = 0;
}

function ctx() {
  return { fighters: game.fighters, effects, pickups: game.pickups };
}

function simulate(dt) {
  const c = ctx();
  game.match?.update(dt);

  for (let i = 0; i < game.locals.length; i++) {
    const f = game.locals[i];
    if (!f.alive) {
      // Dead players spectate the action instead of staring at terrain.
      updateSpectator(i, dt);
      f.update(dt, { forward: 0, strafe: 0, lookX: 0, lookY: 0, jump: false, sprint: false, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }, c);
      continue;
    }
    game.spectate[i] = null;
    const input = i === 0 ? game.input1.poll() : game.input2.poll(dt);
    // Zoomed snipers get proportionally slower look, or the reticle jumps.
    if (f.weapon.kind === 'sniper' && f.aimT > 0.5) {
      const k = 1 - f.aimT * 0.62;
      input.lookX *= k;
      input.lookY *= k;
    }
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

  if (game.match && !game.over) {
    const m = game.match;
    hud.setClock(m.clock);
    hud.setClockWarning(m.timeLimit > 0 && m.remaining < 30);
    if (m.over) endMatch();
  }
}

/**
 * Dead players ride behind a living fighter. Dead local players for a moment
 * see the killer, then the whole island from above.
 */
function updateSpectator(idx, dt) {
  const cam = idx === 0 ? game.cam1 : game.cam2;
  if (!cam) return;
  if (!game.spectate[idx]) {
    const candidates = game.fighters.filter((f) => f.alive && f !== game.locals[idx]);
    game.spectate[idx] = { target: candidates[0] || null, t: 0, orbit: Math.random() * Math.PI * 2 };
  }
  const sp = game.spectate[idx];
  sp.t += dt;
  const target = sp.target && sp.target.alive ? sp.target : null;
  if (target) {
    const h = Math.sin(sp.t * 0.3) * 0.4;
    cam.position.set(
      target.position.x + Math.sin(sp.orbit + sp.t * 0.15) * 6,
      target.position.y + 3.2 + h,
      target.position.z + Math.cos(sp.orbit + sp.t * 0.15) * 6
    );
    cam.lookAt(target.position.x, target.position.y + 1.4, target.position.z);
  }
  // Respawn resets the orbit.
}

function updateHud(dt) {
  if (!game.running && !game.over) return;
  for (let i = 0; i < game.locals.length; i++) {
    const cam = i === 0 ? game.cam1 : game.cam2;
    hud.update(dt, i, game.locals[i], game.fighters, game.pickups, cam);
  }
  for (let i = 0; i < game.locals.length; i++) {
    if (i === 1 && game.input2 && game.input2 instanceof GamepadInput && !game.input2.connected) {
      hud.setSpectating(1, true);
    }
  }
}

function resetViews() {
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.setScissor(0, 0, window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY_CAPS[settings.quality] ?? 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
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

  // Split screen: paint the non-scoped pane first, so the scoped pane's
  // black-out cannot erase it, then render the scoped pane.
  const half = Math.floor(w / 2);
  if (game.mode === 'duo' && game.cam2) {
    if (isScoped(game.locals[0]) && !isScoped(game.locals[1])) {
      renderView(game.cam2, half, 0, w - half, h);
      renderPlayerView(game.cam1, game.locals[0], 0, 0, half, h);
    } else {
      renderPlayerView(game.cam1, game.locals[0], 0, 0, half, h);
      renderPlayerView(game.cam2, game.locals[1], half, 0, w - half, h);
    }
  } else {
    renderPlayerView(game.cam1, game.locals[0], 0, 0, w, h);
  }
}

function isScoped(fighter) {
  return !!(fighter && fighter.weapon?.kind === 'sniper' && fighter.aimT > 0.82);
}

/**
 * Draw one player's view. While a sniper is fully scoped the image is shown
 * through a circular lens (stencil-free: scissor + oversized camera fov), so
 * what you see inside the scope is genuinely magnified. The HTML overlay then
 * blacks out everything outside that same circle.
 */
function renderPlayerView(camera, fighter, x, y, w, h) {
  const scoped = isScoped(fighter);
  if (!scoped) {
    renderView(camera, x, y, w, h);
    return;
  }

  // The lens is the same circle the HTML overlay masks: min(64vh, 88% of pane).
  const lens = Math.min((h * 64) / 100, w * 0.88);
  const zoom = Math.min(3, w / lens);
  const zoomedFov = THREE.MathUtils.radToDeg(
    2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fighter.adsFov) / 2) / zoom)
  );

  const dpr = renderer.getPixelRatio();
  const prevFov = camera.fov;
  camera.fov = zoomedFov;
  camera.aspect = w / h;                      // never squash the magnified image
  camera.updateProjectionMatrix();

  // Render the lens square, centered on the pane centre, with the camera
  // projection centered inside it (no half-pane offset).
  sky.position.copy(camera.position);
  motes.position.copy(camera.position);
  renderer.setScissorTest(true);
  renderer.setScissor(
    Math.round((x + w / 2 - lens / 2) * dpr),
    Math.round((y + h / 2 - lens / 2) * dpr),
    Math.round(lens * dpr),
    Math.round(lens * dpr)
  );
  renderer.setViewport(
    Math.round((x + w / 2 - lens / 2) * dpr),
    Math.round((y + h / 2 - lens / 2) * dpr),
    Math.round(lens * dpr),
    Math.round(lens * dpr)
  );
  renderer.clearDepth();
  renderer.render(scene, camera);

  camera.fov = prevFov;
  camera.updateProjectionMatrix();

  // Fill the rest of this pane with black; the round mask is drawn by HTML.
  const px = Math.round(x * dpr);
  const py = Math.round(y * dpr);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  renderer.setScissor(px, py, pw, ph);
  renderer.setViewport(px, py, pw, ph);
  const gl = renderer.getContext();
  gl.enable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  renderer.setScissorTest(false);
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  U.uTime.value += dt;
  game.menuT += dt;

  if (game.running && !game.paused && !game.over) simulate(dt);
  render();
  updateHud(dt);

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum > 0.5) {
    const fps = Math.round(fpsFrames / fpsAccum);
    const el = $('fps');
    if (el) el.textContent = `${fps} FPS  ·  ${game.running ? (game.mode === 'duo' ? 'SPLIT' : 'SOLO') : 'MENU'}`;

    if (settings.quality === 'auto' && game.running && fps < 46 && scaleIndex < RENDER_SCALES.length - 1) {
      slowSeconds += fpsAccum;
      if (slowSeconds > 2.5) {
        scaleIndex++;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, RENDER_SCALES[scaleIndex]));
        renderer.setSize(window.innerWidth, window.innerHeight);
        slowSeconds = 0;
        console.log(`[quality] render scale → ${RENDER_SCALES[scaleIndex]}`);
      }
    } else if (settings.quality === 'auto' && game.running && fps >= 56) {
      // Recover resolution after a dip (e.g. the first few seconds of a match).
      fastSeconds += fpsAccum;
      if (fastSeconds > 6 && scaleIndex > 0) {
        scaleIndex--;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, RENDER_SCALES[scaleIndex]));
        renderer.setSize(window.innerWidth, window.innerHeight);
        fastSeconds = 0;
      }
    } else {
      slowSeconds = 0;
      fastSeconds = 0;
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
  if (e.code === 'KeyT' && !e.repeat) {
    applyPreset(envState.presetIndex + 1);
    applyEnvironment();
  }
  if (e.code === 'KeyM' && !e.repeat) {
    const muted = ambience.toggle();
    sfx.setMuted(muted);
    hud.toast(0, muted ? 'SOUND OFF' : 'SOUND ON');
    if (game.locals[1] && game.mode === 'duo') hud.toast(1, muted ? 'SOUND OFF' : 'SOUND ON');
  }
  if (e.code === 'Escape') {
    if (game.over) quitToMenu();
    else if (game.running && !game.paused) {
      pauseGame();
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (game.running && game.paused) {
      resumeGame();
    }
  }
  if (game.over && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
    startMatch(game.mode, game.botCount, game.killLimit);
  }
});

$('btnSolo').addEventListener('click', (e) => {
  e.stopPropagation();
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
  const bots = parseInt($('botCount').value, 10) || 4;
  startMatch('solo', bots);
});
$('btnDuo').addEventListener('click', (e) => {
  e.stopPropagation();
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
  const limit = parseInt($('killLimit').value, 10) || 15;
  startMatch('duo', 0, limit);
});

$('pause').addEventListener('click', (e) => {
  if (e.target.closest('#pauseGrid')) return;
  resumeGame();
});
$('btnQuit').addEventListener('click', (e) => { e.stopPropagation(); quitToMenu(); });
$('btnRematch').addEventListener('click', (e) => {
  e.stopPropagation();
  startMatch(game.mode, game.botCount, game.killLimit);
});
$('btnVictoryMenu').addEventListener('click', (e) => { e.stopPropagation(); quitToMenu(); });

// pause settings
$('optVolume').addEventListener('input', (e) => {
  settings.volume = parseInt(e.target.value, 10) / 100;
  ambience.setVolume(settings.volume);
  sfx.volume = settings.volume;
  sfx.setMuted(settings.volume <= 0.001);
  saveSettings();
});
$('optQuality').addEventListener('change', (e) => {
  settings.quality = e.target.value;
  applyQuality();
  saveSettings();
});
$('optRumble').addEventListener('change', (e) => {
  settings.rumble = e.target.value === 'on';
  saveSettings();
});
$('optVolume').value = String(Math.round(settings.volume * 100));
$('optQuality').value = settings.quality;
$('optRumble').value = settings.rumble ? 'on' : 'off';

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
  el.textContent = count > 0
    ? `CONTROLLER DETECTED (${count}) — PLAYER 2 READY`
    : 'NO CONTROLLER — PLAYER 2 CAN USE IJKL + ARROWS';
  el.classList.toggle('ok', count > 0);
}
setInterval(updatePadStatus, 800);
window.addEventListener('gamepadconnected', updatePadStatus);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  menuCamera.aspect = window.innerWidth / window.innerHeight;
  menuCamera.updateProjectionMatrix();
});

/* Dev handle: lets the automated harness drive match outcomes. Never active
   in a normal launch (only with ?debug in the URL). */
try {
  if (new URLSearchParams(window.location.search).has('debug')) {
    window.__aetheris = {
      game,
      startMatch,
      endMatch,
      pauseGame,
      resumeGame,
      quitToMenu,
      get match() { return game.match; },
    };
  }
} catch (_) { /* no location (headless) */ }

buildWorld().then(() => {
  updatePadStatus();
  applyQuality();
  $('loader').classList.add('done');
  $('menu').classList.add('show');
  clock.start();
  tick();
});
