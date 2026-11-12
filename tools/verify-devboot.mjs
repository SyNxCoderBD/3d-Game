/**
 * Dev-mode boot check: evaluates the *source* modules (what the Vite dev
 * server serves) against the same DOM stub the e2e harness uses. The bundle
 * can pass while dev fails, because dev uses native ESM with separate files.
 */
import fs from 'node:fs';
import path from 'node:path';
const ROOT = '/home/user/3d-Game';

/* Build a mirror of the dev server's module graph so the source can be
   evaluated locally. Skipped (not failed) when no dev server is running: this
   is a dev-only check, not part of shipping the build. */
import os from 'node:os';
import { spawn } from 'node:child_process';
const BASE = process.env.AETHERIS_DEV_URL || 'http://127.0.0.1:5173';
const MIRROR_ROOT = path.join(os.tmpdir(), 'aetheris-devmirror');

async function buildMirror() {
  const { rm, mkdir, writeFile, readFile } = await import('node:fs/promises');
  await rm(MIRROR_ROOT, { recursive: true, force: true });
  await mkdir(MIRROR_ROOT, { recursive: true });
  const seen = new Set();
  const queue = ['/src/main.js'];
  // Node's fetch internals touch performance.markResourceTiming, which the DOM
  // stub above replaces; plain http avoids that entirely.
  const { request } = await import('node:http');
  const get = (p) => new Promise((resolve, reject) => {
    const req = request(BASE + p, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${p} -> ${res.statusCode}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
  while (queue.length) {
    const p = queue.pop();
    const clean = p.split('?')[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    const body = await get(p);
    const fsPath = path.join(MIRROR_ROOT, clean);
    await mkdir(path.dirname(fsPath), { recursive: true });
    // rewrite absolute imports to relative so Node can resolve them offline
    const rewritten = body.replace(/(["'])(\/[^"']+)\1/g, (m, q, u) => {
      const rel = path.relative(path.dirname(fsPath), path.join(MIRROR_ROOT, u.split('?')[0]));
      return q + (rel.startsWith('.') ? rel : './' + rel) + q;
    });
    await writeFile(fsPath, rewritten);
    for (const m of body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (m[1].startsWith('/')) queue.push(m[1]);
    }
  }
  // swap the real renderer for the harness one, in the mirror only
  const mainPath = path.join(MIRROR_ROOT, 'src/main.js');
  const main = await readFile(mainPath, 'utf8');
  await writeFile(mainPath, main.replace('new THREE.WebGLRenderer(', 'new globalThis.__HarnessRenderer('));
  return mainPath;
}

const errors = [];
const logs = [];
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
    this._id = '';
    this.children = [];
    this._listenerTypes = new Set();
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
  get id() { return this._id; }
  set id(v) {
    this._id = v;
    // Re-key any listeners registered before the element had its id, which is
    // the normal case for elements declared in a template.
    if (this._listenerTypes.size) {
      for (const type of this._listenerTypes) {
        const stale = listeners.get(this.tagName + ':' + type);
        if (!stale) continue;
        const key = v + ':' + type;
        const existing = listeners.get(key) || [];
        listeners.set(key, [...existing, ...stale]);
        listeners.delete(this.tagName + ':' + type);
      }
    }
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
    this._listenerTypes.add(type);
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
// Elements the bundle binds handlers to at load time must exist with their id
// BEFORE the bundle runs, or every handler lands on the generic 'DIV:click'
// key and no button works. The real page has them in the markup; this stub has
// to be told.
for (const id of ['btnSolo', 'btnDuo', 'btnOnline', 'btnQuit', 'btnRematch',
                  'btnVictoryMenu', 'btnPause', 'btnResume', 'btnHost', 'btnJoin',
                  'btnStartOnline', 'btnRoomBack', 'btnCopyCode', 'playerName',
                  'roomCode', 'room', 'roomChooser', 'roomLobby', 'roomRoster',
                  'roomCodeValue', 'roomPingLine', 'roomLatencyHint', 'roomHint',
                  'roomError', 'roomKills', 'pause', 'menu', 'victory', 'loader',
                  'killLimit', 'optVolume', 'optQuality', 'optRumble',
                  'hudRoot', 'fps', 'victoryBody']) el(id);

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
globalThis.__HarnessRenderer = Renderer;



let MIRROR;
try {
  MIRROR = await buildMirror();
} catch (e) {
  console.log(`  … dev server not reachable at ${BASE} (${e.message}) — skipping dev boot check`);
  process.exit(0);
}
console.log('▸ importing dev source:', MIRROR);
try {
  await import(MIRROR);
} catch (e) {
  console.log('  ✗ import threw:', e.constructor.name, e.message);
  console.log((e.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
console.log('  ✓ module graph evaluated');

// buildWorld() yields through requestAnimationFrame between steps; the stub
// only drains that queue when frames are pumped, so pump them here.
const pump = async (frames, dtMs = 8) => {
  for (let f = 0; f < frames; f++) {
    const q = rafQueue.splice(0);
    const now = (globalThis.performance?.now ? performance.now() : Date.now());
    for (const cb of q) { try { cb(now); } catch (e) { errors.push('frame: ' + e.message); } }
    await new Promise((r) => setTimeout(r, dtMs));
  }
};

let stage = '', lastStage = '', ready = false;
for (let i = 0; i < 900; i++) {
  await pump(1, 5);
  stage = el('loadStatus').textContent;
  if (stage !== lastStage) { console.log(`    [${(i * 5 / 1000).toFixed(1)}s] ${JSON.stringify(stage)}`); lastStage = stage; }
  if (el('loader').classList.contains('done')) { ready = true; console.log(`  ✓ loader finished after ~${(i * 5 / 1000).toFixed(1)}s`); break; }
}
if (!ready) {
  console.log('  ✗ loader never finished; stuck at', JSON.stringify(stage));
  console.log('  errors:', errors.slice(0, 3).join(' | ') || 'none');
  process.exit(1);
}
const m = globalThis.window.__aetheris;
console.log('  ✓ menu shown:', el('menu').classList.contains('show'));
console.log('  ✓ debug handle:', !!m);
console.log(errors.length ? `  ! ${errors.length} error(s): ${errors.slice(0, 2).join(' | ')}` : '  ✓ no errors captured');
process.exit(0);
