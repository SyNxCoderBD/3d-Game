#!/usr/bin/env node
/**
 * Tests for the input and aiming fixes.
 *
 * These cover the failures that only show up in the hands of a player:
 * a crash card over a healthy match, a controller that cannot hit anything,
 * and a lobby that looks hung after the host starts.
 */
import assert from 'node:assert/strict';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

/* ---------------------------------------------------------------- harness */

// A DOM small enough to reason about, with the event targets the input
// classes actually touch.
function makeDom() {
  const listeners = new Map();
  const el = {
    requestPointerLockCalls: 0,
    pointerLockImpl: () => Promise.resolve(),
    requestPointerLock(opts) {
      this.requestPointerLockCalls++;
      this.lastOpts = opts;
      return this.pointerLockImpl();
    },
    addEventListener(type, fn) {
      const k = `el:${type}`;
      if (!listeners.has(k)) listeners.set(k, []);
      listeners.get(k).push(fn);
    },
    removeEventListener() {},
  };
  const target = (key) => ({
    addEventListener(type, fn) {
      const k = `${key}:${type}`;
      if (!listeners.has(k)) listeners.set(k, []);
      listeners.get(k).push(fn);
    },
    removeEventListener() {},
  });
  return { el, window: target('window'), document: target('document'), listeners };
}

async function main() {
  console.log('▸ input and aiming');

  // Node has no window/document until we install them; input.js registers
  // listeners on import.
  const dom = makeDom();
  globalThis.window = dom.window;
  globalThis.document = { ...dom.document, pointerLockElement: null };
  // navigator is getter-only on Node 22, and performance.now comes from node.
  if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };

  const { KeyboardMouseInput, HybridInput, GamepadInput } = await import('../src/game/input.js');

  /* ------------------------------------------------- pointer lock refusal */

  // Both messages from the reported crash cards must be survivable.
  for (const [label, err] of [
    ['"not valid for pointer lock"', Object.assign(new Error('The root document of this element is not valid for pointer lock.'), { name: 'SecurityError' })],
    ['"exited the lock" cooldown', Object.assign(new Error('Pointer lock cannot be acquired immediately after the user has exited the lock.'), { name: 'SecurityError' })],
  ]) {
    const kbm = new KeyboardMouseInput(dom.el);
    kbm.enabled = true;
    let refused = 0;
    let fellBack = 0;
    kbm.onLockRefused = () => refused++;
    kbm.onFallbackMode = () => fellBack++;
    dom.el.pointerLockImpl = () => Promise.reject(err);
    kbm.requestLock();
    // Give the rejection a tick to run.
    await new Promise((r) => setTimeout(r, 0));
    check(`survives ${label}`, () => {
      assert.equal(kbm.lookMode, 'lock', 'must not silently switch to drag-look');
      assert.equal(refused, 1, 'should ask for another click');
      assert.equal(fellBack, 0, 'must not report a fallback for a cooldown');
    });
  }

  // A rejection must never escape as an unhandled rejection.
  {
    const kbm = new KeyboardMouseInput(dom.el);
    kbm.enabled = true;
    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on('unhandledRejection', onUnhandled);
    dom.el.pointerLockImpl = () => Promise.reject(new Error('Pointer lock failed'));
    kbm.requestLock();
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);
    check('a rejected lock is not an unhandled rejection', () => assert.equal(unhandled, 0));
  }

  // A synchronous throw from requestPointerLock also has to be contained.
  {
    const kbm = new KeyboardMouseInput(dom.el);
    kbm.enabled = true;
    dom.el.requestPointerLock = () => { throw new Error('boom'); };
    let threw = false;
    try { kbm.requestLock(); } catch { threw = true; }
    check('a throwing requestPointerLock does not propagate', () => assert.equal(threw, false));
  }

  // Success is silent.
  {
    const kbm = new KeyboardMouseInput(dom.el);
    kbm.enabled = true;
    let refused = 0;
    kbm.onLockRefused = () => refused++;
    dom.el.requestPointerLock = (opts) => { dom.el.lastOpts = opts; return Promise.resolve(); };
    kbm.requestLock();
    await new Promise((r) => setTimeout(r, 0));
    check('a successful lock is not reported as a refusal', () => assert.equal(refused, 0));
    check('lock still asks for unadjusted movement', () => assert.deepEqual(dom.el.lastOpts, { unadjustedMovement: true }));
  }

  /* ----------------------------------------------------------- hybrid input */

  // A resting stick must contribute nothing, so the mouse keeps full control.
  {
    const kbm = { enabled: true, poll: () => ({ forward: 0, strafe: 0, lookX: 0, lookY: 0, jump: false, sprint: false, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }) };
    const pad = {
      enabled: false, connected: true,
      poll: () => ({ forward: 0, strafe: 0, lookX: 0, lookY: 0, jump: false, sprint: false, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }),
      rumble() {}, requestLock() {},
    };
    const hybrid = new HybridInput(kbm, pad);
    hybrid.enabled = true;
    const out = hybrid.poll(1 / 60);
    check('hybrid: an idle pad changes nothing', () => {
      assert.equal(out.forward, 0);
      assert.equal(out.lookX, 0);
      assert.equal(out.fire, false);
    });
  }

  // Movement and buttons from either device are accepted together.
  {
    const kbm = {
      enabled: true,
      poll: () => ({ forward: 1, strafe: 0, lookX: 0, lookY: 0, jump: false, sprint: true, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }),
    };
    const pad = {
      enabled: true, connected: true,
      poll: () => ({ forward: 0, strafe: 1, lookX: 0, lookY: 0, jump: true, sprint: false, crouch: false, fire: true, aim: true, reload: false, swap: false, slot: 2, med: false }),
      rumble() {},
    };
    const hybrid = new HybridInput(kbm, pad);
    hybrid.enabled = true;
    const out = hybrid.poll(1 / 60);
    check('hybrid: keyboard and pad combine', () => {
      assert.equal(out.forward, 1, 'W still moves forward');
      assert.equal(out.strafe, 1, 'stick still strafes');
      assert.equal(out.jump, true, 'pad jump works');
      assert.equal(out.fire, true, 'pad trigger works');
      assert.equal(out.slot, 2, 'd-pad slot works');
    });
  }

  // Once the controller is used, a stick drives the look.
  {
    const kbm = { enabled: true, poll: () => ({ forward: 0, strafe: 0, lookX: 0, lookY: 0, jump: false, sprint: false, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }) };
    const pad = {
      enabled: true, connected: true,
      poll: () => ({ forward: 0, strafe: 0, lookX: 0.05, lookY: -0.02, jump: false, sprint: false, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }),
      rumble() {},
    };
    const hybrid = new HybridInput(kbm, pad);
    hybrid.enabled = true;
    const out = hybrid.poll(1 / 60);
    check('hybrid: the stick can look, with no mouse movement', () => {
      assert.equal(out.lookX, 0.05);
      assert.equal(out.lookY, -0.02);
    });
  }

  // While the mouse is moving, the mouse owns the look.
  {
    const kbm = { enabled: true, poll: () => ({ forward: 0, strafe: 0, lookX: 0.2, lookY: 0.1, jump: false, sprint: false, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }) };
    const pad = {
      enabled: true, connected: true,
      poll: () => ({ forward: 0, strafe: 0, lookX: 0.9, lookY: 0.9, jump: false, sprint: false, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }),
      rumble() {},
    };
    const hybrid = new HybridInput(kbm, pad);
    hybrid.enabled = true;
    const out = hybrid.poll(1 / 60);
    check('hybrid: the mouse wins the look while it moves', () => {
      assert.equal(out.lookX, 0.2);
      assert.equal(out.lookY, 0.1);
    });
    check('hybrid: mouseActive() reports recent mouse input', () => assert.equal(hybrid.mouseActive(1200), true));
  }

  // Enabling the hybrid enables both devices; disabling silences both.
  {
    let kbmEnabled = false;
    let padEnabled = false;
    const kbm = {
      get enabled() { return kbmEnabled; }, set enabled(v) { kbmEnabled = v; },
      poll: () => ({ forward: 0, strafe: 0, lookX: 0, lookY: 0, jump: false, sprint: false, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }),
    };
    const pad = {
      connected: true,
      get enabled() { return padEnabled; }, set enabled(v) { padEnabled = v; },
      poll: () => ({ forward: 0, strafe: 0, lookX: 0, lookY: 0, jump: false, sprint: false, crouch: false, fire: false, aim: false, reload: false, swap: false, slot: 0, med: false }),
      rumble() {},
    };
    const hybrid = new HybridInput(kbm, pad);
    hybrid.enabled = true;
    check('hybrid: enabling turns on both devices', () => assert.ok(kbmEnabled && padEnabled));
    hybrid.enabled = false;
    check('hybrid: disabling turns off both devices', () => assert.ok(!kbmEnabled && !padEnabled));
  }

  /* ------------------------------------------------------------ aim assist */

  // The assist maths, isolated from the scene: verify the properties that make
  // it an assist rather than an aimbot.
  {
    const { Fighter, EYE_HEIGHT } = await import('../src/game/fighter.js');
    const assistOn = Fighter.prototype.computeAimAssist;

    const makeSelf = (yaw = 0, pitch = 0, aiming = false) => ({
      position: { x: 0, y: 0, z: 0 },
      yaw, pitch, aiming, alive: true,
      getEyePosition: (out) => out.set(0, 1.62, 0),
      _coverBetween: () => false,
    });

    // Enemy almost dead ahead (yaw 0 looks toward -Z).
    const near = { position: { x: 0.25, y: 0, z: -20 }, alive: true };

    const nearPitch = Math.atan2(1.2 - EYE_HEIGHT, 20);
    const res = assistOn.call(makeSelf(0, nearPitch, false), [near], 1 / 60, null);
    check('assist engages on a target near the reticle', () => assert.ok(res, 'expected an assist result'));
    check('assist slows the look scale below 1', () => assert.ok(res.slow < 1, `slow=${res.slow}`));
    check('assist never speeds the look up', () => assert.ok(res.slow > 0, `slow=${res.slow}`));
    check('assist pull is tiny', () => {
      assert.ok(Math.abs(res.x) < 0.002, `pullX=${res.x}`);
      assert.ok(Math.abs(res.y) < 0.002, `pullY=${res.y}`);
    });

    // No target inside the cone: no assist at all.
    const far = { position: { x: 40, y: 0, z: 0 }, alive: true };
    check('no assist when nothing is near the reticle',
      () => assert.equal(assistOn.call(makeSelf(0, 0, false), [far], 1 / 60, null), null));

    // A target truly centred — right yaw *and* the pitch its chest needs —
    // gets no pull at all. (A target straight ahead but level with the feet
    // still needs a little downward pitch, so it is legitimately not "centred";
    // that case is checked below.)
    const chestPitch = Math.atan2(1.2 - EYE_HEIGHT, 20);   // chest height vs eye
    const centred = { position: { x: 0, y: 0, z: -20 }, alive: true };
    const c = assistOn.call(makeSelf(0, chestPitch, false), [centred], 1 / 60, null);
    check('dead-centre target gets no pull', () => {
      assert.ok(Math.abs(c.x) < 1e-6, `pullX=${c.x}`);
      assert.ok(Math.abs(c.y) < 1e-6, `pullY=${c.y}`);
      assert.ok(c.centred > 0.999, `centred=${c.centred}`);
    });

    // Aiming down sights widens the cone.
    const edge = { position: { x: Math.tan(0.24) * -20 * -1, y: 0, z: -20 }, alive: true };
    const hip = assistOn.call(makeSelf(0, 0, false), [edge], 1 / 60, null);
    const ads = assistOn.call(makeSelf(0, 0, true), [edge], 1 / 60, null);
    check('aiming down sights widens the assist cone', () => assert.ok(ads && !hip));

    // Cover is respected.
    const blockedSelf = { ...makeSelf(0, 0, false), _coverBetween: () => true };
    check('assist does not help through cover',
      () => assert.equal(assistOn.call(blockedSelf, [near], 1 / 60, {}), null));

    // A dead target is ignored.
    check('assist ignores the dead',
      () => assert.equal(assistOn.call(makeSelf(0, 0, false), [{ ...near, alive: false }], 1 / 60, null), null));
  }

  /* ------------------------------------------------- world shader stability */

  // The giant hard-edged disc across the sky came from normalising the view
  // direction per vertex: the GPU then interpolates a unit vector across each
  // triangle, which is not the direction to the interpolated point, so the
  // horizon gradient bends along every facet edge. The direction has to be
  // reconstructed per fragment from the raw local position.
  {
    const { readFileSync } = await import('node:fs');
    const sky = readFileSync(new URL('../src/world/sky.js', import.meta.url), 'utf8');
    check('sky direction is normalised per fragment', () => {
      assert.ok(/varying vec3 vLocal/.test(sky), 'vertex stage should pass raw position');
      assert.ok(/normalize\(vLocal\)/.test(sky), 'fragment stage should normalise it');
      assert.ok(!/varying vec3 vDir/.test(sky), 'the interpolated unit vector must be gone');
    });
  }

  /* ------------------------------------------------------------- lobby hint */

  // The guest's lobby must stop saying "waiting" the moment the host starts.
  {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    check('lobby hint keys off room.started', () => {
      const fn = main.slice(main.indexOf('function renderLobby'), main.indexOf('function renderLobby') + 4000);
      assert.ok(/room\.started/.test(fn), 'the hint must react to the host starting');
      assert.ok(/Starting|STARTING|loading the island/i.test(fn), 'and say that the match is starting');
    });
    check('an idle lobby does not claim the match is starting', () => {
      const fn = main.slice(main.indexOf('function renderLobby'), main.indexOf('function renderLobby') + 4000);
      // The starting message must be conditional, never the only branch.
      assert.ok(/\?\s*$|\?\s*['"`]|\?\s*\n/m.test(fn) || /if \(room\.started\)/.test(fn),
        'the starting text must be behind a room.started check');
    });
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n  ${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nverify-input failed:', err.message);
  process.exit(1);
});
