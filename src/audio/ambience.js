/**
 * Procedural ambience: filtered noise for wind + a low drone so the island
 * never feels silent. Uses no external assets, so it packs into a single exe.
 */
export class Ambience {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.started = false;
  }

  start() {
    if (this.started) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.ctx = ctx;
      this.started = true;

      const master = ctx.createGain();
      master.gain.value = 0.0;
      master.connect(ctx.destination);
      this.master = master;

      // ---- wind: brown noise through a slowly sweeping lowpass ----------
      const seconds = 6;
      const buffer = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buffer.getChannelData(ch);
        let last = 0;
        for (let i = 0; i < data.length; i++) {
          const white = Math.random() * 2 - 1;
          last = (last + 0.02 * white) / 1.02;
          data[i] = last * 3.2;
        }
      }

      const wind = ctx.createBufferSource();
      wind.buffer = buffer;
      wind.loop = true;

      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 520;
      windFilter.Q.value = 0.6;

      const windGain = ctx.createGain();
      windGain.gain.value = 0.5;

      // Slow gust modulation.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.22;
      lfo.connect(lfoGain);
      lfoGain.connect(windGain.gain);
      lfo.start();

      // Filter sweep for movement in the air.
      const lfo2 = ctx.createOscillator();
      lfo2.frequency.value = 0.045;
      const lfo2Gain = ctx.createGain();
      lfo2Gain.gain.value = 260;
      lfo2.connect(lfo2Gain);
      lfo2Gain.connect(windFilter.frequency);
      lfo2.start();

      wind.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);
      wind.start();

      // ---- deep sea drone ----------------------------------------------
      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.055;
      droneGain.connect(master);

      [55, 82.5, 110].forEach((f, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f * (1 + (i - 1) * 0.002);
        const g = ctx.createGain();
        g.gain.value = i === 0 ? 1 : 0.35;
        osc.connect(g);
        g.connect(droneGain);
        osc.start();
      });

      this.volume ??= 0.5;
      master.gain.setTargetAtTime(this.volume, ctx.currentTime, 2.0);
    } catch (err) {
      console.warn('Audio unavailable:', err);
    }
  }

  setMuted(muted) {
    this.muted = muted;
    this._applyVolume(0.15);
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    this._applyVolume(0.15);
  }

  _applyVolume(tau) {
    this.volume ??= 0.5;
    if (this.master && this.ctx) {
      const target = this.muted ? 0 : this.volume;
      this.master.gain.setTargetAtTime(target, this.ctx.currentTime, tau);
    }
  }

  toggle() {
    this.setMuted(!this.muted);
    return this.muted;
  }
}
