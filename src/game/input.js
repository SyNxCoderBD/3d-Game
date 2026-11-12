/**
 * Input sources. Both produce the same shape so a Fighter cannot tell whether
 * a human or a bot is driving it:
 *   { forward, strafe, lookX, lookY, jump, sprint, crouch, fire, aim,
 *     reload, swap, med }
 */

const EMPTY_INPUT = () => ({
  forward: 0, strafe: 0, lookX: 0, lookY: 0,
  jump: false, sprint: false, crouch: false,
  fire: false, aim: false, reload: false, swap: false, med: false,
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
    this.pulses = { reload: 0, swap: 0, med: 0 };

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (!this.enabled) return;
      if (e.code === 'KeyR') this.pulses.reload = 1;
      if (e.code === 'KeyQ') this.pulses.med = 1;
      if (e.code === 'Tab' || e.code === 'KeyF') this.pulses.swap = 1;
      if (e.code === 'Digit1' || e.code === 'Digit2') this.pulses.swap = 1;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseFire = false;
      this.mouseAim = false;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked && this.lookMode === 'lock') this.onLockLost?.();
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.lookMode === 'lock') {
        this.lookMode = 'drag';
        this.onFallbackMode?.();
      }
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

  requestLock() {
    try {
      const p = this.dom.requestPointerLock?.({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try { this.dom.requestPointerLock(); } catch (_) { this.lookMode = 'drag'; }
        });
      }
    } catch (_) {
      try { this.dom.requestPointerLock(); } catch (__) { this.lookMode = 'drag'; }
    }
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
    out.med = this.pulses.med > 0;
    this.pulses.reload = 0;
    this.pulses.swap = 0;
    this.pulses.med = 0;
    this.lookX = 0;
    this.lookY = 0;
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
    this.sprintLatch = false;
  }

  get pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (!pads) return null;
    // Prefer the requested index, fall back to the first connected pad.
    if (pads[this.index] && pads[this.index].connected) return pads[this.index];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  get connected() {
    return !!this.pad;
  }

  static dz(v, d) {
    return Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d);
  }

  poll(dt) {
    const out = EMPTY_INPUT();
    const pad = this.pad;
    if (!pad || !this.enabled) {
      this.prevButtons = [];
      return out;
    }

    const [lx = 0, ly = 0, rx = 0, ry = 0] = pad.axes;
    out.strafe = GamepadInput.dz(lx, this.deadzone);
    out.forward = -GamepadInput.dz(ly, this.deadzone);

    const lookX = GamepadInput.dz(rx, this.deadzone);
    const lookY = GamepadInput.dz(ry, this.deadzone);
    out.lookX = lookX * this.lookSpeed * dt * (1 + Math.abs(lookX) * 0.7);
    out.lookY = lookY * this.lookSpeed * dt * 0.8 * (1 + Math.abs(lookY) * 0.7);

    const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const val = (i) => (pad.buttons[i] ? pad.buttons[i].value : 0);
    const edge = (i) => btn(i) && !this.prevButtons[i];

    out.fire = val(7) > 0.35;
    out.aim = val(6) > 0.35;
    out.jump = btn(0);
    out.sprint = btn(10) || btn(4);
    out.crouch = btn(11);
    out.reload = edge(2);
    out.swap = edge(1) || edge(5);
    out.med = edge(3);

    this.prevButtons = pad.buttons.map((b) => b.pressed);
    return out;
  }
}
