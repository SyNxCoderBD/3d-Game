#!/usr/bin/env node
/**
 * Real-DOM checks against the *built* game.
 *
 * The other suites run against source and stub the browser. This one loads the
 * actual dist/index.html into jsdom so the inline boot watchdog and the shipped
 * bundle run in a real page, then verifies the two things reported as still
 * broken in the field:
 *
 *   1. A pointer-lock refusal must not paint the crash card, in any phase.
 *   2. A gamepad must survive a hostile navigator, a momentary null entry and a
 *      real disconnect, without throwing and without flickering away.
 *
 * jsdom is optional; if it is missing this exits 0 rather than failing a build
 * that cannot fetch it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  try {
    ({ JSDOM } = await import(join(root, 'node_modules/jsdom/lib/api.js')));
  } catch {
    console.log('jsdom not installed - skipping real-DOM checks');
    process.exit(0);
  }
}

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  FAIL ${name} - ${err.message}`);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const distIndex = join(root, 'dist/index.html');
if (!existsSync(distIndex)) {
  console.log('dist/index.html not built - run npm run build first');
  process.exit(0);
}

const html = readFileSync(distIndex, 'utf8');
const wire = html.match(/assets\/(index-[^"']+\.js)/);
const bundlePath = wire ? join(root, 'dist/assets', wire[1]) : null;
const bundle = bundlePath && existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : '';

/* ------------------------------------------------ crash card / watchdog */

function mount({ booted = false } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  if (booted) window.__aetherisBooted = true;
  const inline = html.match(/<script>([\s\S]*?)<\/script>/);
  if (inline) window.eval(inline[1]);
  return window;
}

function dispatchError(window, message, name = 'Error') {
  const err = new window.Error(message);
  err.name = name;
  window.dispatchEvent(new window.ErrorEvent('error', {
    error: err, message, cancelable: true,
  }));
}

function dispatchRejection(window, message, name = 'Error') {
  const err = new window.Error(message);
  err.name = name;
  const ev = new window.Event('unhandledrejection', { cancelable: true });
  ev.reason = err;
  ev.promise = Promise.resolve();   // already settled: no stray real rejection
  window.dispatchEvent(ev);
}

const LOCK_MSGS = [
  'Pointer lock cannot be acquired immediately after the user has exited the lock.',
  'The root document of this element is not valid for pointer lock.',
];
const REAL_MSG = 'Cannot read properties of null (reading "position")';

const cardShown = (window) => {
  const el = window.document.getElementById('fatal');
  return !!el && el.classList.contains('show');
};

console.log('* built page: crash card');
for (const msg of LOCK_MSGS) {
  const short = msg.slice(0, 32);
  check(`pre-boot error ignored: "${short}..."`, () => {
    const w = mount({ booted: false });
    dispatchError(w, msg, 'SecurityError');
    assert(!cardShown(w), 'the crash card must stay hidden');
  });
  check(`pre-boot rejection ignored: "${short}..."`, () => {
    const w = mount({ booted: false });
    dispatchRejection(w, msg, 'SecurityError');
    assert(!cardShown(w), 'the crash card must stay hidden');
  });
  check(`post-boot error ignored: "${short}..."`, () => {
    const w = mount({ booted: true });
    dispatchError(w, msg, 'SecurityError');
    assert(!cardShown(w), 'the crash card must stay hidden');
  });
}

check('a genuine startup failure still reports', () => {
  const w = mount({ booted: false });
  dispatchError(w, REAL_MSG);
  assert(cardShown(w), 'real errors must still be surfaced');
});

check('a genuine post-boot failure does not duplicate the card', () => {
  const w = mount({ booted: true });
  dispatchError(w, REAL_MSG);
  assert(!cardShown(w), 'watchdog must not re-report after boot');
});

/* ------------------------------------------------ shipped bundle sanity */

if (bundle) {
  console.log('* shipped bundle');
  check('fatal() filters benign messages before showing the card', () => {
    assert(/ignored benign error/.test(bundle), 'the guard must be in the shipped code');
    const i = bundle.indexOf('ignored benign error');
    const after = bundle.slice(i, i + 240);
    assert(/fatal"\)/.test(after) || /getElementById/.test(after),
      'the card lookup should only happen after the guard');
  });
  check('benign patterns survive minification', () => {
    for (const p of [/pointer \?lock/, /exited the lock/, /not valid for pointer lock/, /gamepad/]) {
      assert(p.test(bundle), `missing ${p}`);
    }
  });
  check('lock retry with backoff is present', () => {
    assert(/_retryTimer=setTimeout/.test(bundle), 'retry timer missing');
    assert(/<4&&/.test(bundle) || /< 4 &&/.test(bundle), 'retry bound missing');
  });
  check('pad latch is present', () => {
    assert(/_lastPad/.test(bundle), 'latched pad missing');
  });
}

/* ------------------------------------------------ gamepad, real navigator */

console.log('* gamepad detection');
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const { window } = dom;

  let navImpl = () => [];
  Object.defineProperty(window, 'navigator', {
    value: { getGamepads: () => navImpl() },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', {
    get: () => window.navigator,
    configurable: true,
  });

  const { GamepadInput } = await import('../src/game/input.js');
  const mk = (over = {}) => ({
    index: 0, connected: true,
    axes: [0, -1, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    ...over,
  });

  const g = new GamepadInput(0);
  g.enabled = true;

  check('a throwing getGamepads is survived', () => {
    navImpl = () => { throw new Error('blocked'); };
    const out = g.poll(1 / 60);
    assert(out.forward === 0, 'should read neutral');
    assert(g.connected === false, 'should report absent');
  });

  check('a null list is survived', () => {
    navImpl = () => null;
    g.poll(1 / 60);
  });

  check('all-null slots are survived', () => {
    navImpl = () => [null, null];
    g.poll(1 / 60);
  });

  check('a live pad is detected and drives the stick', () => {
    navImpl = () => [mk()];
    const out = g.poll(1 / 60);
    assert(g.connected, 'pad should be detected');
    assert(out.forward > 0.5, `forward=${out.forward}`);
  });

  check('a momentary null entry keeps the pad latched', () => {
    navImpl = () => [null];
    assert(g.connected, 'must not flicker out');
    const out = g.poll(1 / 60);
    assert(out.forward > 0.5, 'should still read the pad');
  });

  check('an explicit disconnect drops the pad', () => {
    navImpl = () => [mk({ connected: false })];
    g.poll(1 / 60);
    assert(g.connected === false, 'should drop');
  });

  check('a pad with no buttons array is survived', () => {
    navImpl = () => [{ index: 0, connected: true, axes: [0, 0, 0, 0] }];
    const out = g.poll(1 / 60);
    assert(out.fire === false, 'fire should be false');
  });

  check('a pad with no axes array is survived', () => {
    navImpl = () => [mk({ axes: undefined })];
    g.poll(1 / 60);
  });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n  ${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
