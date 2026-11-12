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
    // Give the rejection, and the retries it schedules, time to run. The
    // refusal is only reported once the retries are exhausted, so nothing
    // should be announced immediately.
    await new Promise((r) => setTimeout(r, 0));
    check(`does not give up immediately on ${label}`, () => {
      assert.equal(kbm.lookMode, 'lock', 'must not silently switch to drag-look');
      assert.equal(refused, 0, 'should keep retrying before asking for a click');
      assert.equal(fellBack, 0, 'must not report a fallback for a cooldown');
    });
    // Let the backoff finish (120+240+360+480 ms) and confirm the mode held.
    await new Promise((r) => setTimeout(r, 1300));
    check(`survives ${label}`, () => {
      assert.equal(kbm.lookMode, 'lock', 'must never degrade to drag-look');
      assert.ok(refused >= 1, 'should ask for another click once retries fail');
      assert.equal(fellBack, 0, 'still not a fallback');
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

  /* -------------------------------------------------------------- pad safety */

  // navigator.getGamepads can throw, return null, or contain holes. None of
  // that may escape: it runs every frame.
  {
    const realNavigator = globalThis.navigator;
    const setNav = (getGamepads) => {
      Object.defineProperty(globalThis, 'navigator', { value: { getGamepads }, configurable: true });
    };

    const g = new GamepadInput(0);
    g.enabled = true;

    setNav(() => { throw new Error('getGamepads exploded'); });
    check('a throwing getGamepads does not escape poll()', () => {
      const out = g.poll(1 / 60);
      assert.equal(out.forward, 0);
      assert.equal(g.connected, false);
    });

    setNav(() => null);
    check('a null gamepad list is handled', () => {
      assert.equal(g.connected, false);
      assert.equal(g.poll(1 / 60).fire, false);
    });

    // A live pad with no buttons array must not throw.
    const halfPad = { index: 0, connected: true, axes: [0, 0, 0, 0] };
    setNav(() => [halfPad]);
    check('a pad missing its buttons array is handled', () => {
      const out = g.poll(1 / 60);
      assert.equal(typeof out.forward, 'number');
      assert.equal(out.fire, false);
    });

    // The latch: a momentary null in the list is not a disconnect.
    const goodPad = {
      index: 0, connected: true, axes: [0, -1, 0, 0],
      buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    };
    setNav(() => [goodPad]);
    g.poll(1 / 60);
    check('a present pad is detected', () => assert.equal(g.connected, true));

    setNav(() => [null, null, null, null]);
    check('a momentary null list does not lose the pad', () => assert.equal(g.connected, true));

    // An explicit disconnect does drop it. The browser signals this by listing
    // a *different* entry marked connected:false, so the latched object's own
    // flag is not what is consulted.
    setNav(() => [{ index: 0, connected: false, axes: [0, 0, 0, 0], buttons: [] }]);
    g.poll(1 / 60);
    check('a real disconnect is honoured', () => assert.equal(g.connected, false));

    Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true });
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

  /* ------------------------------------------------- the fatal card itself */

  // The screenshot was a crash card reading "Pointer lock cannot be acquired
  // immediately after the user has exited the lock." Filtering the error
  // handlers was not enough — anything calling fatal() directly, or a message
  // that slipped past one handler, still painted it. The filter belongs at the
  // choke point.
  {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    check('fatal() refuses benign messages at the choke point', () => {
      const fn = main.slice(main.indexOf('function fatal('), main.indexOf('function fatal(') + 600);
      assert.ok(/isBenign\(message\)/.test(fn), 'fatal() must test the message itself');
      assert.ok(/return;/.test(fn), 'and bail out before showing the card');
    });
    check('the benign list covers pointer lock and pads', () => {
      const block = main.slice(main.indexOf('NOISE_PATTERNS'), main.indexOf('NOISE_PATTERNS') + 500);
      for (const needle of ['pointer ?lock', 'exited the lock', 'not valid for pointer lock', 'gamepad']) {
        assert.ok(block.includes(needle), `missing pattern: ${needle}`);
      }
    });
    check('the boot watchdog filters the same messages', () => {
      const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
      const wd = html.slice(html.indexOf('function benign('), html.indexOf('function benign(') + 400);
      assert.ok(/pointer ?lock/.test(wd), 'watchdog must know pointer lock is benign');
      assert.ok(/if \(benign\(msg\)\) return;/.test(html), 'and drop them before reporting');
    });
    check('a lock refusal retries instead of failing outright', () => {
      const input = readFileSync(new URL('../src/game/input.js', import.meta.url), 'utf8');
      assert.ok(/_retryTimer = setTimeout/.test(input), 'should schedule a retry through the cooldown');
      assert.ok(/retries < 4/.test(input), 'and stop after a bounded number of attempts');
    });
  }

  /* -------------------------------------------------------------- sniper ADS */

  // The teal disc over the aim point was the sniper viewmodel's emissive lens
  // cap. At the scope's 26 deg FOV it sat 0.25 m from the eye and spanned half
  // the pane. The viewmodel must be hidden while scoped, and the hidden state
  // must line up with when the HUD shows the scope overlay, or there is a gap
  // with neither gun nor reticle.
  {
    const { readFileSync } = await import('node:fs');
    const fighter = readFileSync(new URL('../src/game/fighter.js', import.meta.url), 'utf8');
    const hud = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');
    const weapons = readFileSync(new URL('../src/game/weapons.js', import.meta.url), 'utf8');

    check('the viewmodel is hidden while scoped', () => {
      const fn = fighter.slice(fighter.indexOf('updateViewmodel(dt) {'), fighter.indexOf('updateViewmodel(dt) {') + 3000);
      assert.ok(/viewGun\.visible\s*=\s*!scoped/.test(fn), 'the gun must hide when scoped');
    });

    check('the scoped threshold matches the HUD overlay', () => {
      const fn = fighter.slice(fighter.indexOf('updateViewmodel(dt) {'), fighter.indexOf('updateViewmodel(dt) {') + 3000);
      const a = fn.match(/aimT > ([\d.]+)/);
      const b = hud.match(/aimT > ([\d.]+)/);
      assert.ok(a && b, 'both thresholds must be expressible');
      assert.equal(a[1], b[1], `fighter ${a?.[1]} vs hud ${b?.[1]}`);
    });

    check('the near plane is never entered by the viewmodel', () => {
      const fn = fighter.slice(fighter.indexOf('updateViewmodel(dt) {'), fighter.indexOf('updateViewmodel(dt) {') + 3000);
      // z must not be pulled closer than the 0.03 m near plane.
      const z = fn.match(/lerp\(-0\.38,\s*(-?[\d.]+),\s*this\.aimT\)/);
      assert.ok(z, 'viewmodel z lerp must be findable');
      assert.ok(Math.abs(Number(z[1])) > 0.03, `ends at z=${z[1]}, inside the near plane`);
    });

    check('the scope lens is emissive enough to need hiding', () => {
      // Guards the reason for the fix: if the lens is ever toned down this
      // assumption should be revisited rather than silently kept.
      assert.ok(/emissiveIntensity:\s*2\.2/.test(weapons), 'lens material changed - recheck the ADS fix');
    });
  }

  /* --------------------------------------------------------- bot difficulty */

  {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const ai = readFileSync(new URL('../src/game/ai.js', import.meta.url), 'utf8');

    check('bot difficulty is a setting with an easy default', () => {
      assert.ok(/botDifficulty:\s*'easy'/.test(main), 'easy must be the default');
      const bands = main.slice(main.indexOf('const BOT_SKILL'), main.indexOf('const BOT_SKILL') + 300);
      assert.ok(/easy:\s*\[[\d.]+, [\d.]+\]/.test(bands), 'easy band must be defined');
      const easy = bands.match(/easy:\s*\[([\d.]+), ([\d.]+)\]/);
      assert.ok(Number(easy[2]) <= 0.35, `easy tops out at ${easy[2]}, still too sharp`);
    });

    check('low-skill bots are actually weak', () => {
      // Reaction and settle time must both get materially worse at skill 0.
      const react = ai.match(/reactionSkill = ([\d.]+) - skill \* ([\d.]+)/);
      assert.ok(react, 'reaction formula must be present');
      const atZero = Number(react[1]);
      const atOne = Number(react[1]) - Number(react[2]);
      assert.ok(atZero >= 1.0, `a skill-0 bot reacts in only ${atZero}s`);
      assert.ok(atOne <= 0.5, `a skill-1 bot reacts in ${atOne}s, too slow to be hard`);
    });

    check('controller sensitivity is configurable', () => {
      assert.ok(/padSensitivity/.test(main), 'the setting must exist');
      assert.ok(/applyPadSensitivity/.test(main), 'and be applied to live pads');
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
