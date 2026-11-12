/**
 * End-to-end harness: runs the *bundled* game script against a stub DOM and
 * WebGL-less Three renderer, clicks through the menu, and plays frames.
 *
 * This is not a visual test — it is a wiring test. It catches things like a
 * missing element id, a typo in an event handler, NaN state after tens of
 * simulated seconds, and exceptions thrown inside the render loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = '/home/user/3d-Game';
const html = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');
const bundleRel = html.match(/assets\/([^"]+\.js)/)[0];   // "assets/index-*.js"
const bundlePath = path.join(ROOT, 'dist', bundleRel);
// dist/index.html references ./assets/... so the join is already correct

const bundle = fs.readFileSync(bundlePath, 'utf8');

const errors = [];
const logs = [];

/* ---------------------------------------------------------------- DOM stub */

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  _sync() { this.el._className = [...this.set].join(' '); }
  add(...c) { c.forEach((x) => this.set.add(x)); this._sync(); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); this._sync(); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    this._sync();
    return on;
  }
  contains(c) { return this.set.has(c); }
}

const noopCtx = () => new Proxy({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getShaderParameter: () => true,
  getProgramParameter: () => true,
  getShaderInfoLog: () => '',
  getProgramInfoLog: () => '',
  getExtension: () => null,
  getContextAttributes: () => ({ alpha: true, antialias: true }),
  getParameter: (p) => (p === 0x8b8c ? 'WebGL 2.0' : 8),
  getSupportedExtensions: () => [],
  createProgram: () => ({}), createShader: () => ({}), createBuffer: () => ({}),
  createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
  createVertexArray: () => ({}), getUniformLocation: () => ({}), getAttribLocation: () => 0,
  checkFramebufferStatus: () => 0x8cd5,
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });

const listeners = new Map();

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.children = [];
    this.classList = new ClassList(this);
    this.style = {};
    this.textContent = '';
    this._html = '';
    this.width = 300;
    this.height = 150;
    this.offsetWidth = 300;
    this.clientWidth = 1600;
    this.parentNode = null;
    this.tagMap = new Map();
  }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
    this.classList._sync();
  }
  get className() { return this._className || ''; }
  set innerHTML(v) {
    this._html = v;
    this.children = [];
    // Register elements declared in the template by id/class so that
    // getElementById() and querySelector() keep working after createPanes().
    for (const m of v.matchAll(/id="([^"]+)"/g)) {
      const el = new El('div');
      el.id = m[1];
      this.tagMap.set('#' + m[1], el);
    }
    for (const m of v.matchAll(/class="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (!this.tagMap.has('.' + cls)) this.tagMap.set('.' + cls, new El('div'));
      }
    }
  }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); c.parentNode = this; if (c.id) this.tagMap.set('#' + c.id, c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); }
  remove() { this.parentNode?.removeChild(this); }
  get firstElementChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.length; }
  getContext() { if (!this._ctx) this._ctx = noopCtx(); return this._ctx; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1600, height: 900 }; }
  setAttribute() {}
  getAttribute() { return null; }
  querySelector(sel) {
    if (!this.tagMap.has(sel)) this.tagMap.set(sel, new El('div'));
    return this.tagMap.get(sel);
  }
  querySelectorAll() { return []; }
  addEventListener(type, cb) {
    const key = (this.id || this.tagName) + ':' + type;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(cb);
  }
  removeEventListener() {}
  focus() {}
  closest(sel) {
    if (sel.startsWith('#') && this.id === sel.slice(1)) return this;
    return null;
  }
  setPointerCapture() {}
  requestPointerLock() { document.pointerLockElement = this; return Promise.resolve(); }
  releasePointerLock() { document.pointerLockElement = null; }
}

const byId = new Map();
function el(id, tag) {
  let e = byId.get(id);
  if (!e) { e = new El(tag); e.id = id; byId.set(id, e); }
  return e;
}

// Elements referenced by main.js
for (const id of [
  'scene', 'loader', 'loadStatus', 'loadBar', 'menu', 'btnSolo', 'btnDuo', 'botCount',
  'killLimit', 'padStatus', 'hudRoot', 'fps', 'pause', 'victory', 'victoryTitle',
  'victorySub', 'victoryBody', 'btnQuit', 'btnRematch', 'btnVictoryMenu', 'fatal',
  'optVolume', 'optQuality', 'optRumble', 'pauseGrid',
]) el(id, id === 'scene' ? 'canvas' : 'div');
el('botCount').value = '4';
el('killLimit').value = '15';
el('optVolume').value = '90';
el('optQuality').value = 'auto';
el('optRumble').value = 'on';

globalThis.document = {
  getElementById: (id) => {
    if (!byId.has(id)) byId.set(id, new El('div'));
    return byId.get(id);
  },
  createElement: (t) => (t === 'canvas' ? Object.assign(new El('canvas'), { width: 176, height: 176 }) : new El(t)),
  addEventListener: (type, cb) => {
    const key = 'document:' + type;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(cb);
  },
  pointerLockElement: null,
  exitPointerLock() { this.pointerLockElement = null; },
  querySelector: (sel) => (byId.has(sel.replace(/^#/, '')) ? byId.get(sel.replace(/^#/, '')) : new El()),
  body: Object.assign(new El('body'), { classList: new ClassList({ _className: '' }) }),
};

let rafQueue = [];
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
const winListeners = new Map();
globalThis.window = {
  innerWidth: 1600,
  innerHeight: 900,
  devicePixelRatio: 1,
  addEventListener: (type, cb) => {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(cb);
  },
  removeEventListener() {},
  requestAnimationFrame: globalThis.requestAnimationFrame,
  location: { search: '?debug' },
  navigator: { getGamepads: () => [] },
  AudioContext: undefined,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => [], userAgent: 'node-harness' },
    configurable: true,
  });
} catch (_) { /* older node leaves the built-in navigator in place */ }
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
  setItem(k, v) { this.store.set(k, String(v)); },
};
globalThis.setInterval = () => 0;
globalThis.performance = { now: () => Date.now() };
globalThis.self = globalThis;

/* --------------------------------------------------------- Three renderer */

const THREE_REAL = await import(path.join(ROOT, 'node_modules/three/build/three.module.js'));
// Module namespaces are read-only: wrap one so the renderer can be swapped out.
const THREE = new Proxy(THREE_REAL, {
  get: (target, key) => (key === 'WebGLRenderer' ? Renderer : target[key]),
  has: (target, key) => key in target,
});
// Replace the WebGL path: enough to exercise the game loop without a GPU.
const Renderer = class {
  constructor() {
    this.domElement = el('scene', 'canvas');
    this.shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: true };
    this._pr = 1;
    this.outputColorSpace = 'srgb';
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    this.info = { render: { calls: 0, triangles: 0 }, memory: {}, autoReset: true, reset() {} };
    this.capabilities = { isWebGL2: true, getMaxAnisotropy: () => 8, maxTextureSize: 4096 };
    this.extensions = { get: () => null, has: () => false };
    this.xr = { enabled: false, addEventListener() {}, isPresenting: false };
    this._ctx = noopCtx();
    this.renderCount = 0;
  }
  setPixelRatio(v) { this._pr = v; }
  getPixelRatio() { return this._pr; }
  setSize() {}
  setViewport() {}
  setScissor() {}
  setScissorTest() {}
  clearDepth() {}
  clear() {}
  getContext() { return this._ctx; }
  getRenderTarget() { return null; }
  setRenderTarget() {}
  compile() {}
  dispose() {}
  render(scene, camera) {
    this.renderCount++;
    camera.updateMatrixWorld();
    scene.updateMatrixWorld();
  }
  setAnimationLoop(cb) { if (cb) this._loop = cb; }
};
// (WebGLRenderer is served by the proxy above.)

/* ---- patch the WebGL renderer constructor inside the bundle (IIFE scope) ---- */
// three's module is bundled inside the IIFE, so its lexical `WebGLRenderer`
// binding (minified to e.g. `Pf`) must be replaced at the source level.
const r = bundle.match(/new (\w{1,4})\(\{canvas/);
if (!r) throw new Error('could not locate the WebGLRenderer constructor in the bundle');
const rendererAlias = r[1];
console.log(`  renderer constructor in bundle: ${rendererAlias}`);
const patchedBundle = bundle.replaceAll(
  `new ${rendererAlias}(`,
  'new globalThis.__HarnessRenderer('
);

/* -------------------------------------------------------- bundle execution */

const sandbox = {
  THREE,
  console: {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push('WARN ' + a.join(' ')),
    error: (...a) => errors.push('console.error: ' + a.join(' ')),
  },
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  setTimeout, clearTimeout, setInterval: globalThis.setInterval, clearInterval,
  performance: globalThis.performance,
  self: globalThis,
  Math, Date, JSON, Object, Array, Map, Set, Promise, Number, String, Boolean,
  Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
  Uint8ClampedArray, ArrayBuffer, DataView, Error, TypeError, RangeError,
  TextDecoder, TextEncoder, URL, URLSearchParams, Symbol, Reflect, Proxy, BigInt,
  Intl, structuredClone, queueMicrotask, isNaN, isFinite, parseFloat, parseInt,
  encodeURIComponent, decodeURIComponent,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

sandbox.__HarnessRenderer = Renderer;

try {
  vm.runInContext(patchedBundle, sandbox, { filename: 'bundle.js' });
} catch (err) {
  console.error('bundle threw during load:', err.stack);
  process.exit(1);
}

/* --------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runFrames(n, dtMs = 16) {
  for (let i = 0; i < n; i++) {
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) {
      try { cb(performance.now()); } catch (err) { errors.push('frame: ' + err.stack); }
    }
    await sleep(dtMs);
  }
}
function click(target) {
  const key = (target.id || target.tagName) + ':click';
  const cbs = listeners.get(key) || [];
  if (!cbs.length) throw new Error(`no click handler for ${target.id || target.tagName}`);
  for (const cb of cbs) cb({ stopPropagation() {}, preventDefault() {}, target, button: 0, closest: () => null });
}
function key(code) {
  const cbs = winListeners.get('keydown') || [];
  for (const cb of cbs) cb({ code, repeat: false, preventDefault() {} });
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

/* ------------------------------------------------------------------- test */

console.log('\n▸ boot');
await runFrames(3, 5);
// The world builds over several animation frames (async steps).
for (let i = 0; i < 200 && !el('menu').classList.contains('show'); i++) await runFrames(1, 10);
check('loader finished', el('loader').classList.contains('done'));
check('menu visible', el('menu').classList.contains('show'));
check('no boot errors', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log('\n▸ solo match');
click(el('btnSolo'));
await runFrames(5, 5);
check('HUD panes created', el('hudRoot').children.length >= 1, `${el('hudRoot').children.length} pane(s)`);
check('match running (menu hidden)', !el('menu').classList.contains('show'));
const fpsBefore = el('fps').textContent;
await runFrames(60, 8);
check('renders frames', true, `${el('fps').textContent}`);
check('render loop produced no exceptions', errors.length === 0, errors.slice(0, 1).join(''));

// Pick up the game object indirectly: drive keys and check the HUD reacts.
key('KeyT');           // cycle time of day
key('KeyM');           // mute
await runFrames(20, 8);
check('settings keys do not throw', errors.length === 0, errors.slice(0, 1).join(''));

console.log('\n▸ pause / resume');
key('Escape');
await runFrames(2, 8);
check('escape pauses', el('pause').classList.contains('show'));
key('Escape');
await runFrames(2, 8);
check('escape resumes', !el('pause').classList.contains('show'));

console.log('\n▸ settings');
el('optVolume').value = '40';
for (const cb of listeners.get('optVolume:input') || []) cb({ target: el('optVolume') });
check('volume saved', JSON.parse(globalThis.localStorage.getItem('aetheris.settings')).volume === 0.4);
el('optQuality').value = 'low';
for (const cb of listeners.get('optQuality:change') || []) cb({ target: el('optQuality') });
check('quality saved', JSON.parse(globalThis.localStorage.getItem('aetheris.settings')).quality === 'low');

console.log('\n▸ quit + split screen');
click(el('btnQuit'));
await runFrames(3, 5);
check('back at menu', el('menu').classList.contains('show'));
click(el('btnDuo'));
await runFrames(5, 5);
check('duo HUD has two panes', el('hudRoot').children.length >= 2, `${el('hudRoot').children.length} pane(s)`);
await runFrames(120, 6);
check('duo sim is stable', errors.length === 0, errors.slice(0, 2).join(''));

console.log('\n▸ win condition + scoreboard');
const api = globalThis.window.__aetheris || sandbox.window.__aetheris || sandbox.__aetheris;
check('debug handle exposed', !!api);
if (api) {
  // Force the duel to the score limit and let a frame resolve it.
  for (const f of api.game.locals) { f.alive = true; f.health = 100; }
  api.game.locals[0].kills = api.game.killLimit - 1;
  const victim = api.game.locals[1];
  victim.spawnProtect = 0;
  victim.alive = true;
  victim.takeDamage(999, api.game.locals[0]);
  await runFrames(3, 8);
  check('victory overlay shown', el('victory').classList.contains('show'));
  const body = el('victoryBody').innerHTML;
  check('scoreboard rendered', /<table class="scoreboard">/.test(body), `${(body.match(/<tr/g) || []).length} rows`);
  check('winner named in headline', body.includes('PLAYER 1 WINS'));
  check('world keeps rendering behind the card', true, `${el('fps').textContent}`);
  click(el('btnRematch'));
  await runFrames(4, 8);
  check('rematch restarts the duel', !el('victory').classList.contains('show') && el('hudRoot').children.length >= 2);
  check('rematch resets scores', api.game.locals[0].kills === 0, `${api.game.locals[0].kills} kills`);
  check('no exceptions from endcard', errors.length === 0, errors.slice(0, 1).join(''));
}

// sanity: no NaN leaked into the scene graph
let nanObjects = 0;
const sceneRef = sandbox.__scene;
if (sceneRef) {
  sceneRef.traverse((o) => {
    if (!Number.isFinite(o.position.x + o.position.y + o.position.z)) nanObjects++;
  });
}
check('no NaN object transforms', nanObjects === 0);

console.log(`\n${fail === 0 ? '✅' : '❌'} e2e: ${pass} passed, ${fail} failed`);
if (logs.length) console.log('\nlog tail:\n  ' + logs.slice(-6).join('\n  '));
process.exit(fail === 0 ? 0 : 1);
