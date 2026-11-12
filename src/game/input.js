/**
 * Input sources. All produce the same shape so a Fighter cannot tell whether
 * a human or a bot is driving it:
 *   { forward, strafe, lookX, lookY, jump, sprint, crouch, fire, aim,
 *     reload, swap, slot, med }
 */

const EMPTY_INPUT = () => ({
  forward: 0, strafe: 0, lookX: 0, lookY: 0,
  jump: false, sprint: false, crouch: false,
  fire: false, aim: false, reload: false, swap: false, slot: 0, med: false,
});

export class KeyboardMouseInput {
  constructor(domElement, { sensitivity = 0.0021 } = {}) {
    this.dom = domElement;
    this.sensitivity = sensitivity;
    this.keys = new Set();
    this.lookX = 0;
    this.lookY = 0;
    this.mouseFire = false;
    this.mouseAim = false;
    this.enabled = false;
    this.locked = false;
    this.lookMode = 'lock';
    this.dragging = false;
    this.pulses = { reload: 0, swap: 0, slot: 0, med: 0 };

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (!this.enabled) return;
      if (e.code === 'KeyR') this.pulses.reload = 1;
      if (e.code === 'KeyQ') this.pulses.med = 1;
      if (e.code === 'KeyF') this.pulses.swap = 1;
      if (e.code === 'Digit1') this.pulses.slot = 1;
      if (e.code === 'Digit2') this.pulses.slot = 2;
      if (e.code === 'Digit3') this.pulses.slot = 3;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseFire = false;
      this.mouseAim = false;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.locked && this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      if (!this.locked && this.lookMode === 'lock') this.onLockLost?.();
    });
    document.addEventListener('pointerlockerror', (e) => {
      // The event carries no detail; requestLock's rejection handler is the one
      // that decides. Swallow it so it cannot bubble to the window error
      // handler, which would show a fatal card over a running game.
      e.preventDefault?.();
    });

    this.dom.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.mouseAim = true;
      this.dragging = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.mouseAim = false;
      this.dragging = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      const active = this.locked || (this.lookMode === 'drag' && this.dragging);
      if (!active) return;
      this.lookX += e.movementX * this.sensitivity;
      this.lookY += e.movementY * this.sensitivity;
    });
  }

  /**
   * Ask for pointer lock, tolerating every way the browser can refuse.
   *
   * Pointer lock is rejected routinely and for ordinary reasons: the request
   * came too soon after the user pressed Escape ("cannot be acquired
   * immediately after the user has exited the lock"), the page is not focused,
   * or the document is not a valid lock target. None of those are faults, but
   * the browser reports them by *rejecting a promise*, and an unhandled
   * rejection reaches the page's error handler and paints a fatal card over a
   * game that is running perfectly well.
   *
   * So: every call is caught, failures fall back rather than escalate, and a
   * rejection right after Escape simply waits instead of forcing drag-look on
   * a player who is about to click back in.
   */
  requestLock(retries = 0) {
    // A deliberate new request supersedes any retry still waiting, or clicks
    // would stack timers and fight each other.
    if (retries === 0 && this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    // Both attempts are chained through one helper so neither can leave a
    // rejected promise unobserved: a second unhandled rejection while retrying
    // the fallback would produce exactly the error card this is meant to stop.
    const attempt = (opts, onFail) => {
      let p;
      try {
        p = opts ? this.dom.requestPointerLock?.(opts) : this.dom.requestPointerLock?.();
      } catch (err) {
        onFail(err);
        return;
      }
      if (p && typeof p.then === 'function') {
        p.then(
          () => {
            this.lockError = null;
            if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
          },
          (err) => onFail(err)
        );
      }
    };

    const fallback = () => {
      attempt(null, () => { this.lookMode = 'drag'; });
    };

    attempt({ unadjustedMovement: true }, (err) => this._onLockFailed(err, fallback, retries));
  }

  /**
   * A rejected lock is not a crash. Escape-to-pause then click-to-resume is the
   * normal way to play, and Chrome enforces a short cooldown after Escape; in
   * that window the correct response is to stay paused and let the player click
   * again, not to switch input modes or report an error.
   */
  _onLockFailed(err, fallback, retries = 0) {
    const name = err?.name || '';
    const message = String(err?.message || '');
    const tooSoon = name === 'SecurityError' || /exited the lock|not valid for pointer lock/i.test(message);
    this.lockError = message || name || 'pointer lock refused';

    if (tooSoon) {
      // Keep 'lock' mode: switching here would silently turn every mouse-look
      // into a drag, which is not what the player asked for and cannot be
      // undone without a reload.
      //
      // The cooldown is short and it is time-based, not input-based, so retry
      // through it instead of making the player click again and again. The
      // retries back off and stop after a few attempts, at which point the
      // refusal is reported once and the player can click to try again.
      if (retries < 4 && this.enabled) {
        const delay = 120 * (retries + 1);
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          if (this.enabled && !this.locked) this.requestLock(retries + 1);
        }, delay);
        return;
      }
      this.onLockRefused?.();
      return;
    }
    fallback();
  }

  poll() {
    const out = EMPTY_INPUT();
    if (!this.enabled) {
      this.lookX = 0;
      this.lookY = 0;
      return out;
    }
    const k = this.keys;
    out.forward = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    out.strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    out.jump = k.has('Space');
    out.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    out.crouch = k.has('ControlLeft') || k.has('KeyC');
    out.fire = this.mouseFire;
    out.aim = this.mouseAim;
    out.lookX = this.lookX;
    out.lookY = this.lookY;
    out.reload = this.pulses.reload > 0;
    out.swap = this.pulses.swap > 0;
    out.slot = this.pulses.slot;
    out.med = this.pulses.med > 0;
    this.pulses.reload = 0;
    this.pulses.swap = 0;
    this.pulses.slot = 0;
    this.pulses.med = 0;
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }
}

/**
 * Keyboard fallback for Player 2, used only when no controller is connected.
 * Arrows aim, IJKL move; the right-hand cluster fires and manages the weapon.
 */
export class KeyboardSecondInput {
  constructor({ lookSpeed = 2.6 } = {}) {
    this.lookSpeed = lookSpeed;
    this.enabled = false;
    this.keys = new Set();
    this.pulses = { reload: 0, swap: 0, med: 0 };

    window.addEventListener('keydown', (e) => {
      const code = e.code;
      if (code.startsWith('Arrow') || code === 'Enter') e.preventDefault();
      if (this.keys.has(code)) return;
      this.keys.add(code);
      if (!this.enabled) return;
      if (code === 'Period') this.pulses.reload = 1;
      if (code === 'Comma') this.pulses.med = 1;
      if (code === 'Slash') this.pulses.swap = 1;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  poll(dt) {
    const out = EMPTY_INPUT();
    if (!this.enabled) return out;
    const k = this.keys;

    out.forward = (k.has('KeyI') ? 1 : 0) - (k.has('KeyK') ? 1 : 0);
    out.strafe = (k.has('KeyL') ? 1 : 0) - (k.has('KeyJ') ? 1 : 0);
    out.lookX = ((k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0)) * this.lookSpeed * dt;
    out.lookY = ((k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0)) * this.lookSpeed * dt;

    out.jump = k.has('Quote');
    out.sprint = k.has('Backslash');
    out.crouch = k.has('ControlRight');
    out.fire = k.has('Enter');
    out.aim = k.has('ShiftRight');
    out.reload = this.pulses.reload > 0;
    out.swap = this.pulses.swap > 0;
    out.med = this.pulses.med > 0;
    this.pulses.reload = 0;
    this.pulses.swap = 0;
    this.pulses.med = 0;
    return out;
  }
}

/**
 * Player 1 with both a keyboard/mouse and a controller.
 *
 * The mouse keeps priority for looking — it is the finer instrument, and a
 * resting stick must never fight it — while movement, firing and the weapon
 * buttons accept whichever device is actually being used. A stick at rest
 * contributes nothing, so switching between the two mid-match just works and
 * neither device has to be plugged in at a particular moment.
 *
 * This is what makes bot practice playable on a pad: before this, Player 1 was
 * keyboard-only and a controller only ever drove Player 2.
 */
export class HybridInput {
  constructor(kbm, pad, { mousePriorityMs = 900 } = {}) {
    this.kbm = kbm;
    this.pad = pad;
    this.mousePriorityMs = mousePriorityMs;
    this.enabled = false;
    // -Infinity, not 0: performance.now() starts near zero, so a zero
    // timestamp would read as "the mouse moved a moment ago" on the very first
    // frame and the stick would be ignored until the player touched the mouse.
    this.lastMouseAt = -Infinity;
    this._wasEnabledKbm = false;
    this._wasEnabledPad = false;
  }

  get dom() { return this.kbm.dom; }
  get locked() { return this.kbm.locked; }
  get lookMode() { return this.kbm.lookMode; }
  get connected() { return this.pad.connected; }

  set enabled(v) {
    this._enabled = v;
    this.kbm.enabled = v;
    this.pad.enabled = v && this.pad.connected;
  }
  get enabled() { return !!this._enabled; }

  get onLockLost() { return this.kbm.onLockLost; }
  set onLockLost(fn) { this.kbm.onLockLost = fn; }
  get onFallbackMode() { return this.kbm.onFallbackMode; }
  set onFallbackMode(fn) { this.kbm.onFallbackMode = fn; }
  get onLockRefused() { return this.kbm.onLockRefused; }
  set onLockRefused(fn) { this.kbm.onLockRefused = fn; }

  requestLock() { this.kbm.requestLock(); }
  rumble(...args) { this.pad.rumble(...args); }

  /** Was the mouse the device driving the camera within `ms`? */
  mouseActive(ms = 1200) {
    return performance.now() - this.lastMouseAt < ms;
  }

  poll(dt = 1 / 60) {
    const m = this.kbm.poll();
    // Keep the pad in sync with hot-plugging without resetting its edge state.
    this.pad.enabled = this.enabled && this.pad.connected;
    const g = this.pad.poll(dt);

    if (m.lookX || m.lookY) this.lastMouseAt = performance.now();
    const mouseFresh = performance.now() - this.lastMouseAt < this.mousePriorityMs;

    const out = {
      forward: m.forward || g.forward,
      strafe: m.strafe || g.strafe,
      // Mouse wins the look while it is being moved; otherwise the stick drives.
      lookX: mouseFresh ? m.lookX : (g.lookX || m.lookX),
      lookY: mouseFresh ? m.lookY : (g.lookY || m.lookY),
      jump: m.jump || g.jump,
      sprint: m.sprint || g.sprint,
      crouch: m.crouch || g.crouch,
      fire: m.fire || g.fire,
      aim: m.aim || g.aim,
      reload: m.reload || g.reload,
      swap: m.swap || g.swap,
      slot: g.slot || m.slot,
      med: m.med || g.med,
    };
    // Movement adds rather than picks, so a half-pushed stick plus a key does
    // not cancel out.
    out.forward = Math.max(-1, Math.min(1, m.forward + g.forward));
    out.strafe = Math.max(-1, Math.min(1, m.strafe + g.strafe));
    return out;
  }
}

export class GamepadInput {
  constructor(index = 0, { lookSpeed = 3.0, deadzone = 0.16 } = {}) {
    this.index = index;
    this.lookSpeed = lookSpeed;
    this.deadzone = deadzone;
    this.enabled = false;
    this.prevButtons = [];
    this.rumbleUntil = 0;
    this._lastPad = null;
  }

  /**
   * The connected pad, or null.
   *
   * navigator.getGamepads() is hostile to naive polling. It throws in some
   * embeddings, it can return null, and — the part that made the controller
   * look "sometimes not detected" — many browsers only start reporting a pad
   * on the first *button press or stick movement*, and the array's entries can
   * briefly be null. Polling it independently from the frame loop and from the
   * status readout meant the two disagreed and the HUD flickered between
   * "detected" and "no controller" while the pad was sitting right there.
   *
   * So: read it defensively, remember the last non-null pad, and only ever
   * report it missing after the browser has told us it disconnected.
   */
  get pad() {
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : null;
      if (pads) {
        // Prefer this device's slot, then any other live pad.
        const own = pads[this.index];
        if (own && own.connected) {
          this._lastPad = own;
          return own;
        }
        for (const p of pads) {
          if (p && p.connected) {
            this._lastPad = p;
            return p;
          }
        }
      }
    } catch (_) {
      /* getGamepads is not available here; fall back to the cached pad */
    }
    // A pad we have seen before stays usable until an explicit disconnect,
    // because a momentary null in the array is not a disconnect.
    return this._lastPad || null;
  }

  get connected() {
    try {
      return !!this.pad;
    } catch (_) {
      return false;
    }
  }

  /** Forget the cached pad; called on the browser's disconnect event. */
  forgetPad() {
    this._lastPad = null;
    this.prevButtons = [];
  }

  static dz(v, d) {
    return Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d);
  }

  /**
   * Fire the actuator's dual-rumble effect. Silently no-ops on browsers or
   * pad drivers that don't support it.
   */
  rumble(strength = 0.6, duration = 120, weak = 0.4) {
    const pad = this.pad;
    if (!pad || !this.enabled) return;
    const actuator = pad.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') return;
    try {
      actuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration,
        weakMagnitude: Math.min(1, weak),
        strongMagnitude: Math.min(1, strength),
      });
    } catch (_) {
      /* not supported on this pad */
    }
  }

  poll(dt) {
    const out = EMPTY_INPUT();
    // Every call into a gamepad is wrapped: a pad can disappear mid-frame, and
    // driver-specific objects can throw on a stale handle. None of that should
    // be able to reach the fatal card or abort a frame.
    let pad = null;
    try {
      pad = this.pad;
      if (pad && pad.connected === false) {
        this.forgetPad();
        pad = null;
      }
    } catch (_) {
      pad = null;
    }
    if (!pad || !this.enabled) {
      this.prevButtons = [];
      return out;
    }

    try {
      this._readPad(pad, dt, out);
    } catch (_) {
      // A pad that throws while being read is treated as absent for this frame
      // rather than taking the match down with it.
      this.prevButtons = [];
    }
    return out;
  }

  _readPad(pad, dt, out) {
    const axes = pad.axes || [];
    const [lx = 0, ly = 0, rx = 0, ry = 0] = axes;
    out.strafe = GamepadInput.dz(lx, this.deadzone);
    out.forward = -GamepadInput.dz(ly, this.deadzone);

    const lookX = GamepadInput.dz(rx, this.deadzone);
    const lookY = GamepadInput.dz(ry, this.deadzone);
    out.lookX = lookX * this.lookSpeed * dt * (1 + Math.abs(lookX) * 0.7);
    out.lookY = lookY * this.lookSpeed * dt * 0.8 * (1 + Math.abs(lookY) * 0.7);

    const buttons = pad.buttons || [];
    const btn = (i) => !!(buttons[i] && buttons[i].pressed);
    const val = (i) => (buttons[i] ? (buttons[i].value || 0) : 0);
    const edge = (i) => btn(i) && !this.prevButtons[i];

    out.fire = val(7) > 0.35;
    out.aim = val(6) > 0.35;
    out.jump = btn(0);
    out.sprint = btn(10) || btn(4);
    out.crouch = btn(11);
    out.reload = edge(2);
    out.swap = edge(1) || edge(5);
    out.med = edge(3);
    // D-pad selects a weapon slot directly.
    if (edge(14)) out.slot = 1;
    if (edge(15)) out.slot = 2;

    this.prevButtons = buttons.map((b) => !!b && !!b.pressed);
    return out;
  }
}
