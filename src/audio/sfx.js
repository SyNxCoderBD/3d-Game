/**
 * Procedural combat audio.
 *
 * Every sound is synthesised from noise buffers and oscillators at runtime —
 * no audio files, so the whole thing still fits inside the single-file exe.
 *
 * Guns are built from three layers: a short noise "crack" through a bandpass,
 * a pitched body thump, and (for big calibers) a delayed tail. Shots fired by
 * remote fighters are attenuated and stereo-panned against the nearest local
 * camera, so a firefight on the far side of the island sounds far away and you
 * can hear which shoulder it came over.
 */
import * as THREE from 'three';
import { clamp } from '../util/math.js';

const NOISE_SECONDS = 2;

/* kind: [body f0, body f1, body length, body gain, crack cutoff, crack Q, crack gain, tail] */
const SHOT = {
  pistol: {
    f0: 340, f1: 90, len: 0.16, bodyGain: 0.34,
    cut: 2600, q: 0.9, crackGain: 0.5, crackLen: 0.10, tail: 0,
  },
  smg: {
    f0: 420, f1: 120, len: 0.11, bodyGain: 0.24,
    cut: 3200, q: 1.1, crackGain: 0.4, crackLen: 0.07, tail: 0,
  },
  rifle: {
    f0: 260, f1: 70, len: 0.2, bodyGain: 0.42,
    cut: 2200, q: 0.8, crackGain: 0.55, crackLen: 0.12, tail: 0.1,
  },
  shotgun: {
    f0: 150, f1: 46, len: 0.34, bodyGain: 0.6,
    cut: 1500, q: 0.7, crackGain: 0.6, crackLen: 0.2, tail: 0.16,
  },
  sniper: {
    f0: 190, f1: 44, len: 0.42, bodyGain: 0.55,
    cut: 3400, q: 0.6, crackGain: 0.7, crackLen: 0.16, tail: 0.34,
  },
};

const _camPos = new THREE.Vector3();
const _right = new THREE.Vector3();
const _to = new THREE.Vector3();

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.listeners = [];
    this.muted = false;
    this.voices = 0;
    this.volume = 0.9;
  }

  /** Share the AudioContext that Ambience already created. */
  attach(ctx) {
    if (!ctx || this.ctx === ctx) return;
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volume;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.22;

    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;

    // One shared noise buffer, created lazily but only once.
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      // A little low-pass shaping makes the noise read as "air" rather than hiss.
      last = last * 0.36 + white * 0.64;
      data[i] = last;
    }
    this.noise = buffer;
  }

  get ready() {
    return !!this.ctx && this.ctx.state !== 'closed' && !this.muted;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
  }

  setListeners(cams) {
    this.listeners = cams.filter(Boolean);
  }

  /** World position -> { gain, pan } relative to whichever local player is closest. */
  spatial(pos) {
    if (!pos || !this.listeners.length) return { gain: 1, pan: 0 };
    let bestD = Infinity;
    let bestCam = null;
    for (const cam of this.listeners) {
      const d = cam.position.distanceTo(pos);
      if (d < bestD) { bestD = d; bestCam = cam; }
    }
    if (!bestCam) return { gain: 1, pan: 0 };

    _camPos.copy(bestCam.position);
    _right.set(1, 0, 0).applyQuaternion(bestCam.quaternion);
    _to.copy(pos).sub(_camPos);
    const dist = Math.max(0.001, _to.length());
    _to.divideScalar(dist);
    const pan = clamp(_to.dot(_right), -1, 1) * 0.82;
    // Inverse-ish falloff with a floor so distant fights still carry.
    const gain = clamp(14 / (14 + dist), 0.06, 1);
    return { gain, pan };
  }

  /* --------------------------------------------------------------- utils */

  _out(gain, pan) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  _noiseBurst(out, t, { dur, cut, q = 1, gain = 0.4, rate = 1 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = cut;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(out);
    src.start(t, Math.random() * (NOISE_SECONDS - dur - 0.05), dur + 0.02);
    src.stop(t + dur + 0.03);
  }

  _tone(out, t, { f0, f1 = f0, dur, gain = 0.2, type = 'sine', slide = 0.3 }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur * slide);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /* --------------------------------------------------------------- guns */

  shot(kind = 'rifle', pos = null, own = false) {
    if (!this.ready || this.voices > 26) return;
    const cfg = SHOT[kind] || SHOT.rifle;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.002;
    const { gain, pan } = own ? { gain: 1, pan: 0 } : this.spatial(pos);
    const out = this._out(gain * 0.95, pan);

    this.voices++;
    setTimeout(() => { this.voices = Math.max(0, this.voices - 1); }, 600);

    this._noiseBurst(out, t, {
      dur: cfg.crackLen,
      cut: cfg.cut,
      q: cfg.q,
      gain: cfg.crackGain,
      rate: 0.9 + Math.random() * 0.2,
    });
    this._tone(out, t, {
      f0: cfg.f0, f1: cfg.f1, dur: cfg.len, gain: cfg.bodyGain, type: 'triangle', slide: 0.45,
    });

    if (cfg.tail) {
      // A softer, darker repeat: the sound bouncing back off the hills.
      this._noiseBurst(out, t + 0.11, {
        dur: cfg.tail, cut: cfg.cut * 0.45, q: 0.5, gain: cfg.crackGain * 0.22,
      });
      this._tone(out, t + 0.12, {
        f0: cfg.f0 * 0.6, f1: cfg.f1 * 0.6, dur: cfg.tail, gain: cfg.bodyGain * 0.2,
        type: 'sine', slide: 0.9,
      });
    }
    if (kind === 'shotgun' && own) this._pump(t + 0.34, out);
  }

  _pump(t, out) {
    this._noiseBurst(out, t, { dur: 0.05, cut: 1800, q: 2.5, gain: 0.2 });
    this._noiseBurst(out, t + 0.09, { dur: 0.06, cut: 1200, q: 2.5, gain: 0.24 });
  }

  /* -------------------------------------------------------------- clicks */

  reloadStart(kind = 'rifle') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.6, 0);
    this._noiseBurst(out, t, { dur: 0.045, cut: 2400, q: 3, gain: 0.35 });
    this._tone(out, t + 0.02, { f0: 190, f1: 120, dur: 0.08, gain: 0.12, type: 'square' });
    if (kind === 'shotgun') this._pump(t + 0.08, out);
  }

  reloadEnd() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.6, 0);
    this._noiseBurst(out, t, { dur: 0.05, cut: 3000, q: 3.5, gain: 0.4 });
    this._noiseBurst(out, t + 0.06, { dur: 0.05, cut: 2000, q: 3, gain: 0.32 });
  }

  emptyClick() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._noiseBurst(this._out(0.5, 0), t, { dur: 0.03, cut: 4200, q: 5, gain: 0.3 });
  }

  /* ------------------------------------------------------------ feedback */

  hit(headshot = false) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.5, 0);
    if (headshot) {
      this._tone(out, t, { f0: 1480, f1: 1980, dur: 0.1, gain: 0.16, type: 'triangle' });
      this._tone(out, t + 0.03, { f0: 2100, dur: 0.07, gain: 0.09, type: 'sine' });
    } else {
      this._tone(out, t, { f0: 720, f1: 540, dur: 0.06, gain: 0.1, type: 'triangle' });
    }
  }

  flesh() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.55, 0);
    this._noiseBurst(out, t, { dur: 0.09, cut: 420, q: 1.2, gain: 0.28 });
    this._tone(out, t, { f0: 120, f1: 70, dur: 0.1, gain: 0.12, type: 'sine' });
  }

  hurt() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.8, 0);
    this._tone(out, t, { f0: 140, f1: 62, dur: 0.22, gain: 0.24, type: 'sine' });
    this._noiseBurst(out, t, { dur: 0.11, cut: 700, q: 0.8, gain: 0.16 });
  }

  death() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.75, 0);
    this._tone(out, t, { f0: 240, f1: 48, dur: 0.55, gain: 0.22, type: 'sawtooth' });
    this._noiseBurst(out, t, { dur: 0.3, cut: 500, q: 0.7, gain: 0.2 });
  }

  pickup(type = 'weapon') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.45, 0);
    const base = type === 'medkit' ? 660 : type === 'armor' ? 520 : 760;
    this._tone(out, t, { f0: base, dur: 0.1, gain: 0.13, type: 'sine' });
    this._tone(out, t + 0.075, { f0: base * 1.5, dur: 0.14, gain: 0.11, type: 'sine' });
  }

  heal() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.5, 0);
    this._tone(out, t, { f0: 420, f1: 640, dur: 0.24, gain: 0.1, type: 'sine', slide: 1 });
    this._tone(out, t + 0.12, { f0: 640, f1: 880, dur: 0.24, gain: 0.08, type: 'sine', slide: 1 });
  }

  spawn() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.5, 0);
    this._tone(out, t, { f0: 300, f1: 620, dur: 0.3, gain: 0.1, type: 'sine', slide: 1 });
  }

  streak(level = 3) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.55, 0);
    const notes = [523, 659, 784, 1046];
    for (let i = 0; i < Math.min(4, level - 1); i++) {
      this._tone(out, t + i * 0.07, { f0: notes[i], dur: 0.16, gain: 0.1, type: 'triangle' });
    }
  }

  announce(sting = 'victory') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(0.65, 0);
    const notes = sting === 'victory' ? [392, 523, 659, 784] : [392, 330, 262, 196];
    notes.forEach((f, i) => {
      this._tone(out, t + i * 0.13, { f0: f, dur: 0.5, gain: 0.11, type: 'triangle', slide: 1 });
      this._tone(out, t + i * 0.13, { f0: f * 0.5, dur: 0.5, gain: 0.06, type: 'sine', slide: 1 });
    });
  }
}
