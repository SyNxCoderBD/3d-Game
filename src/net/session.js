import { NetClient } from './net.js';

/**
 * Host-authoritative online duel.
 *
 *   guest -> host : input frames at ~45 Hz, tagged with a sequence number
 *   host -> guest : world snapshots at 20 Hz, tagged with the last input seq
 *                   that had been applied when the snapshot was taken
 *
 * The guest predicts only its own soldier (it applies its input locally and
 * replays anything the host has not acknowledged), and interpolates every
 * other actor. That keeps your own movement instant on a 60 ms connection
 * while remote bodies stay smooth instead of teleporting 20 times a second.
 *
 * Bullets, pickups, damage and kills are decided once, on the host, so both
 * players always agree about what happened.
 */

const SNAP_HZ = 20;
const INPUT_HZ = 45;
const INTERP_DELAY = 0.10;      // 100 ms of buffer: absorbs jitter without feeling laggy
const MAX_BUFFER = 20;

export class OnlineSession {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.net = new NetClient({
      onLobby: (room) => this._onLobby(room),
      onMessage: (msg) => this._onMessage(msg),
      onStatus: (st) => this._onStatus(st),
    });
    this.running = false;
    this.players = [];            // [{ id, name, isHost }]
    this.localFighter = null;
    this.remoteFighters = [];
    this.remoteState = new Map(); // id -> { buffer: [...], current: {...} }
    this.inputSeq = 0;
    this.ackedSeq = 0;
    this.inputHistory = [];
    this.snapAccum = 0;
    this.inputAccum = 0;
    this.ping = 0;
    this.latency = 0;
    this._sendTimer = 0;
    this.connected = false;
    this.seed = 0;
    this._lastSnapAt = 0;
  }

  get code() { return this.net.code; }
  /** Kills needed to win, as agreed when the room was created. */
  get killLimit() { return this.net.killLimit || 15; }
  set killLimit(v) { this.net.killLimit = v; }
  get isHost() { return this.net.isHost; }
  get id() { return this.net.id; }

  /* ------------------------------------------------------------- lobby --- */

  async host(name, { killLimit = 15, seed = 0 } = {}) {
    this.net.name = name;
    return this.net.createRoom(name, { killLimit, seed });
  }

  async join(code, name) {
    this.net.name = name;
    return this.net.joinRoom(code, name);
  }

  async leave() {
    this.running = false;
    this.players = [];
    this.remoteState.clear();
    await this.net.leave();
  }

  async start(seed) {
    this.seed = seed >>> 0 || Math.floor(Math.random() * 2 ** 31);
    const ok = await this.net.startRoom(this.seed);
    if (!ok) throw new Error('only the host can start the match');
    this._begin();
    // Announce immediately so the guest does not wait for the next snapshot.
    this.net.broadcast({ t: 'start', seed: this.seed });
    return this.seed;
  }

  _begin() {
    this.running = true;
    this.inputSeq = 0;
    this.ackedSeq = 0;
    this.inputHistory = [];
    this.remoteState.clear();
    this.snapAccum = 0;
    this.inputAccum = 0;
    this._lastSnapAt = 0;
    this.startAt = performance.now();
  }

  _onLobby(room) {
    if (!room) return;
    const list = (room.players || []).map((p) => ({
      id: p.id,
      name: p.name || 'PLAYER',
      isHost: !!p.host,
      at: p.at,
    }));
    this.players = list;
    this.killLimit = room.kill_limit;
    this.status = room.status;
    this.handlers.onLobby?.({ ...room, players: list });
  }

  _onStatus(status) {
    if (status.type === 'subscribed') this.connected = true;
    if (status.type === 'reconnecting') this.connected = false;
    this.handlers.onStatus?.(status);
  }

  _onMessage(msg) {
    // Every packet carries a timestamp; the round trip is measured by the
    // dedicated ping/pong exchange, not by these.
    if (this.net.handlePing(msg)) {
      this.ping = this.net.ping;
      return;
    }

    switch (msg.t) {
      case 'start':
        // Guest: the host started the room.
        this.seed = msg.seed;
        if (!this.running) {
          this._begin();
          this.handlers.onStart?.(msg.seed);
        }
        break;

      case 'in':
        // Host: a guest input frame.
        if (this.handlers.onRemoteInput) this.handlers.onRemoteInput(msg.from, msg.i, msg.ack);
        break;

      case 'snap':
        // Guest: authoritative world state.
        this._ingestSnapshot(msg);
        break;

      case 'bye':
        this.handlers.onPeerLeft?.(msg.from);
        break;

      case 'over':
        this.handlers.onRemoteOver?.(msg.winner);
        break;

      default:
        break;
    }
  }

  /* ---------------------------------------------------------- input ---- */

  /**
   * Called once per frame by the guest. Returns the local input to simulate
   * with — the same object it will send to the host.
   */
  clientInput(input, dt) {
    const seq = ++this.inputSeq;
    const frame = {
      forward: input.forward || 0,
      strafe: input.strafe || 0,
      lookX: input.lookX || 0,
      lookY: input.lookY || 0,
      jump: !!input.jump,
      sprint: !!input.sprint,
      crouch: !!input.crouch,
      fire: !!input.fire,
      aim: !!input.aim,
      reload: !!input.reload,
      swap: !!input.swap,
      med: !!input.med,
      slot: input.slot || 0,
      seq,
      dt,
    };
    this.inputHistory.push(frame);
    if (this.inputHistory.length > 240) this.inputHistory.shift();

    this.inputAccum += dt;
    if (this.inputAccum >= 1 / INPUT_HZ) {
      this.inputAccum = 0;
      this.net.sendInput(frame, this.ackedSeq);
    }
    return input;
  }

  /** Host: turn a packed input word back into an input object. */
  static unpackInput(word) {
    return {
      forward: word[0], strafe: word[1], lookX: word[2], lookY: word[3],
      jump: !!(word[4] & 1),
      sprint: !!(word[4] & 2),
      crouch: !!(word[4] & 4),
      fire: !!(word[4] & 8),
      aim: !!(word[4] & 16),
      reload: !!(word[4] & 32),
      swap: !!(word[4] & 64),
      med: !!(word[4] & 128),
      slot: (word[4] >> 8) & 7,
    };
  }

  /* -------------------------------------------------------- snapshots --- */

  hostTick(dt, fighters, extra = {}) {
    this.snapAccum += dt;
    if (this.snapAccum < 1 / SNAP_HZ) return;
    this.snapAccum = 0;
    const hostPing = this.net.ping;
    this.net.sendSnapshot(fighters, {
      ack: this.lastGuestAck || 0,
      hp: hostPing,
      ...extra,
    });
  }

  _ingestSnapshot(msg) {
    this._lastSnapAt = performance.now();
    if (typeof msg.ack === 'number') this.ackedSeq = Math.max(this.ackedSeq, msg.ack);
    if (typeof msg.hp === 'number' && msg.hp > 0) this.remotePing = msg.hp;

    const decoded = NetClient.decodeSnapshot(msg.s || []);
    const now = performance.now() / 1000;
    for (const st of decoded) {
      if (st.id === this.localId) {
        // Never interpolate yourself (that would fight local prediction), but
        // do accept the host's verdict on your health and score. Without this
        // the guest is invulnerable and bullets do nothing.
        this.selfState = st;
        this.handlers.onSelfState?.(st);
        continue;
      }
      let entry = this.remoteState.get(st.id);
      if (!entry) {
        entry = { buffer: [], current: st, prev: st };
        this.remoteState.set(st.id, entry);
      }
      entry.buffer.push({ t: now, ...st });
      if (entry.buffer.length > MAX_BUFFER) entry.buffer.shift();
    }
    // Drop the acknowledged part of the local input history. This is done once
    // per snapshot, not per fighter: a snapshot can ack input without carrying
    // any state for us.
    if (msg.ack) {
      while (this.inputHistory.length && this.inputHistory[0].seq <= msg.ack) {
        this.inputHistory.shift();
      }
    }
    this.latestSnapshot = msg;
  }

  /** Interpolated state for a remote fighter, `INTERP_DELAY` in the past. */
  sampledState(id) {
    const entry = this.remoteState.get(id);
    if (!entry) return null;
    const renderAt = performance.now() / 1000 - INTERP_DELAY;
    const buf = entry.buffer;
    if (buf.length === 0) return entry.current;
    if (buf.length === 1) return buf[0];

    // Walk back to the pair of samples that straddle renderAt.
    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = buf.length - 1; i > 0; i--) {
      if (buf[i - 1].t <= renderAt) { a = buf[i - 1]; b = buf[i]; break; }
    }
    if (b.t <= renderAt) return b;
    const span = b.t - a.t;
    const alpha = span > 1e-6 ? Math.min(1, Math.max(0, (renderAt - a.t) / span)) : 1;

    // Shortest-arc yaw so a turn past +/-pi does not spin the model.
    let dyaw = b.yaw - a.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));

    return {
      id,
      x: a.x + (b.x - a.x) * alpha,
      y: a.y + (b.y - a.y) * alpha,
      z: a.z + (b.z - a.z) * alpha,
      yaw: a.yaw + dyaw * alpha,
      pitch: a.pitch + (b.pitch - a.pitch) * alpha,
      health: b.health,
      alive: b.alive,
      crouch: b.crouch,
      aimT: b.aimT,
      speed: b.speed,
      slot: b.slot,
      armor: b.armor,
      kills: b.kills,
      deaths: b.deaths,
    };
  }

  /**
   * Guest: apply a snapshot to a remote fighter object. The interpolation is
   * visual only — the authoritative numbers (health, kills) are applied
   * directly so the HUD never lags a whole buffer behind.
   */
  applyRemote(fighter, state) {
    if (!fighter || !state) return;
    fighter.position.set(state.x, state.y, state.z);
    fighter._targetYaw = state.yaw;
    fighter._targetPitch = state.pitch;
    fighter.health = state.health;
    fighter.armor = state.armor;
    fighter.crouching = state.crouch;
    fighter.aimT = state.aimT;
    fighter.speed = state.speed;
    fighter.kills = state.kills;
    fighter.deaths = state.deaths;
    if (state.slot !== fighter.slot) {
      fighter.slot = state.slot;
      fighter.refreshWeaponModels(true);
    }
  }

  /** True when snapshots have stopped arriving (peer gone or network died). */
  get stale() {
    return this.running && this._lastSnapAt > 0 &&
      performance.now() - this._lastSnapAt > 3000;
  }

  get hasGuestSnapshot() {
    return this._lastSnapAt > 0;
  }
}
