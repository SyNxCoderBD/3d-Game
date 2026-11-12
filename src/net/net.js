import { RealtimeClient } from '@supabase/realtime-js';

/**
 * AETHERIS online multiplayer.
 *
 * Transport: Supabase Realtime *broadcast* over a shared channel per room
 * code. Broadcast is used rather than postgres_changes because it is a direct
 * socket hop (no WAL decode), which is what keeps the snapshot rate smooth.
 * The room table is only used for the lobby (who is in the room, who hosts,
 * and the shared world seed).
 *
 * Authority: host-authoritative. The host runs the real simulation for both
 * players; the guest sends input and renders interpolated snapshots. That is
 * the only model that stays honest about cover, hit detection and pickups —
 * every client-side re-simulation of weapon fire would disagree eventually.
 */

// Filled in by the build. These are public client credentials (the anon key is
// designed to ship in a browser bundle) and every table is behind RLS with
// security-definer RPCs, so nothing here is a secret.
export const SUPABASE_URL = 'https://srugeztbfxcjuvokhumw.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNydWdlenRiZnhjanV2b2todW13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MTg0NjQsImV4cCI6MjEwMjI5NDQ2NH0.qhmd3rk7O7sii_P7LDbGTGxAxjTyF4B5wmMjQgJ9c3c';

const REST = `${SUPABASE_URL}/rest/v1/rpc`;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

export function randomRoomCode(len = 5) {
  let out = '';
  const bytes = new Uint8Array(len);
  (globalThis.crypto || globalThis.msCrypto).getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return out;
}

export function newPlayerId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for older engines: a v4-shaped id is enough for a room slot key.
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The lowest-latency Supabase region for a player, purely informational. */
export function clockMs() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

async function rpc(fn, body) {
  const res = await fetch(`${REST}/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${fn}: ${res.status} ${text.slice(0, 180)}`);
  }
  return res.json();
}

/* --------------------------------------------------------------- protocol
   States are sent 15x/sec from the host as a compact array-of-arrays so the
   snapshot stays small. Everything is quantised: positions in cm, angles in
   1/100 rad. A 4-player snapshot lands around 200 bytes.                     */

const Q_POS = 100;
const Q_ANG = 100;

function quantiseFighter(f, extra = {}) {
  return [
    f.id,                                 // 0 id
    Math.round(f.position.x * Q_POS),     // 1
    Math.round(f.position.y * Q_POS),     // 2
    Math.round(f.position.z * Q_POS),     // 3
    Math.round(f.yaw * Q_ANG),            // 4
    Math.round(f.pitch * Q_ANG),          // 5
    Math.round(f.health),                 // 6
    f.alive ? 1 : 0,                      // 7
    f.crouching ? 1 : 0,                  // 8
    Math.round((f.aimT || 0) * 100),      // 9
    extra.speed ? Math.round(extra.speed * 10) : 0,  // 10
    f.slot,                               // 11
    Math.round(f.armor),                  // 12
    f.kills,                              // 13
    f.deaths,                             // 14
  ];
}

function dequantiseFighter(a) {
  return {
    id: a[0],
    x: a[1] / Q_POS, y: a[2] / Q_POS, z: a[3] / Q_POS,
    yaw: a[4] / Q_ANG, pitch: a[5] / Q_ANG,
    health: a[6], alive: !!a[7], crouch: !!a[8],
    aimT: a[9] / 100, speed: (a[10] || 0) / 10,
    slot: a[11], armor: a[12], kills: a[13], deaths: a[14],
  };
}

/* ---------------------------------------------------------------- client */

export class NetClient {
  constructor({ onLobby, onMessage, onStatus } = {}) {
    this.id = newPlayerId();
    this.name = 'PLAYER';
    this.role = null;         // 'host' | 'guest'
    this.code = null;
    this.room = null;
    this.joined = false;
    this.client = null;
    this.channel = null;
    this.onLobby = onLobby || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ping = 0;
    this._pingSentAt = 0;
    this._pingSeq = 0;
    this._pingTimer = null;
    this._lobbyTimer = null;
    this._closed = false;
  }

  get isHost() { return this.role === 'host'; }

  /* --- socket ------------------------------------------------------------ */

  _connect() {
    if (this.client) return this.client;
    const url = `${SUPABASE_URL}/realtime/v1`;
    this.client = new RealtimeClient(url, {
      params: { apikey: SUPABASE_ANON_KEY },
      // Reconnect aggressively: a dropped socket mid-firefight should recover
      // in a few hundred ms, not thirty seconds.
      reconnectAfterMs: (tries) => [300, 600, 1200, 2500, 5000, 8000][Math.min(tries, 5)],
      heartbeatIntervalMs: 12000,
      timeout: 12000,
    });
    // RealtimeClient's logger is chatty by default (console.log on every join).
    this.client.logger = () => {};
    return this.client;
  }

  _openChannel() {
    if (this.channel) {
      this.channel.unsubscribe();
      this.channel = null;
    }
    const ch = this.client.channel(`aetheris:${this.code}`, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: this.id },
      },
    });

    ch.on('broadcast', { event: 'msg' }, (packet) => {
      const payload = packet?.payload;
      if (!payload || typeof payload !== 'object') return;
      if (payload.from === this.id) return;
      this.onMessage(payload);
    });

    // Presence tells us who is actually connected, so the lobby can show
    // "connected" separately from "on the roster".
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() || {};
      const ids = Object.keys(state);
      this.onStatus({ type: 'presence', ids });
    });

    ch.on('presence', { event: 'leave' }, ({ key }) => {
      this.onStatus({ type: 'peer-left', id: key });
    });

    this._channelAttempts = 0;
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this._channelAttempts = 0;
        ch.track({ id: this.id, name: this.name, at: Date.now() }).catch(() => {});
        this.onStatus({ type: 'subscribed' });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        this._channelAttempts = (this._channelAttempts || 0) + 1;
        // Report the first failure straight away so the lobby can say
        // "connecting…", then give up loudly: a player waiting on a code that
        // will never connect is worse than an error message.
        this.onStatus({
          type: this._channelAttempts >= 4 ? 'connect-failed' : 'reconnecting',
          attempts: this._channelAttempts,
        });
      }
    });
    this.channel = ch;
  }

  /* --- lobby ------------------------------------------------------------- */

  async createRoom(name, { killLimit = 15, seed = 0 } = {}) {
    this.name = name || 'PLAYER 1';
    this.role = 'host';
    // Retry a few times in the unlikely event a code is already taken.
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomRoomCode();
      try {
        const room = await this._join(code, true, killLimit, seed);
        if (!room) continue;
        this.code = code;
        this.room = room;
        this.joined = true;
        this._connect();
        this._openChannel();
        this._startLobbySync();
        this._startPing();
        return room;
      } catch (err) {
        // A duplicate primary key means the code raced: try another.
        if (attempt === 5) throw err;
      }
    }
    throw new Error('could not allocate a room code');
  }

  async joinRoom(code, name) {
    this.name = name || 'PLAYER 2';
    this.role = 'guest';
    this.code = String(code).trim().toUpperCase();
    const room = await this._join(this.code, false, 0, 0);
    if (!room) throw new Error('ROOM NOT FOUND');
    this.room = room;
    this.joined = true;
    this._connect();
    this._openChannel();
    this._startLobbySync();
    this._startPing();
    return room;
  }

  async _join(code, isHost, killLimit, seed) {
    const rows = await rpc('aetheris_join_room', {
      p_code: code, p_player: this.id, p_name: this.name, p_host: isHost,
    });
    const room = Array.isArray(rows) ? rows[0] : rows;
    if (!room) return null;
    this.killLimit = killLimit || room.kill_limit || 15;
    this.seed = seed || room.seed || 0;
    return room;
  }

  async startRoom(seed) {
    if (!this.isHost) return false;
    const ok = await rpc('aetheris_start_room', {
      p_code: this.code, p_player: this.id, p_seed: seed,
    });
    return Array.isArray(ok) ? ok[0] : ok;
  }

  async leave() {
    if (this._closed) return;
    this._closed = true;
    if (this._lobbyTimer) clearInterval(this._lobbyTimer);
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this.channel) {
      try { this.channel.untrack(); } catch (_) { /* already gone */ }
      this.channel.unsubscribe();
      this.channel = null;
    }
    if (this.client) {
      try { this.client.disconnect(); } catch (_) { /* already gone */ }
      this.client = null;
    }
    if (this.code && this.joined) {
      try {
        await rpc('aetheris_leave_room', { p_code: this.code, p_player: this.id });
      } catch (_) { /* best effort: the room is reaped anyway */ }
    }
    this.joined = false;
  }

  _startLobbySync() {
    if (this._lobbyTimer) clearInterval(this._lobbyTimer);
    const tick = async () => {
      if (!this.joined) return;
      try {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/aetheris_rooms?code=eq.${encodeURIComponent(this.code)}&select=*`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
        );
        const rows = await res.json();
        if (Array.isArray(rows) && rows[0]) {
          this.room = rows[0];
          this.goneTicks = 0;
          this.onLobby(rows[0]);
        } else if (this.role === 'guest') {
          // The host deleted the room (they left). Wait two polls so a single
          // bad request does not kick anyone out, then tell the UI.
          this.goneTicks = (this.goneTicks || 0) + 1;
          if (this.goneTicks >= 2) this.onStatus({ type: 'room-gone' });
        }
      } catch (_) { /* keep the last good lobby */ }
    };
    tick();
    this._lobbyTimer = setInterval(tick, 1500);
  }

  /* --- ping -------------------------------------------------------------- */

  _startPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => this.sendPing(), 1000);
    this.sendPing();
  }

  sendPing() {
    if (!this.channel || !this.joined) return;
    this._pingSeq += 1;
    const seq = this._pingSeq;
    const sentAt = clockMs();
    this._pendingPings = this._pendingPings || new Map();
    this._pendingPings.set(seq, sentAt);
    // Drop samples that never came back. A lost pong is exactly what happens
    // when the link is bad, so without this the map only grows while the game
    // is least healthy — thousands of entries over a long session.
    if (this._pendingPings.size > 12) {
      const cutoff = sentAt - 10000;
      for (const [k, at] of this._pendingPings) {
        if (at < cutoff) this._pendingPings.delete(k);
      }
    }
    this.broadcast({ t: 'ping', seq });
  }

  handlePing(payload) {
    if (payload.t === 'ping') {
      this.broadcast({ t: 'pong', seq: payload.seq });
      return true;
    }
    if (payload.t === 'pong') {
      const sentAt = this._pendingPings && this._pendingPings.get(payload.seq);
      if (sentAt !== undefined) {
        this._pendingPings.delete(payload.seq);
        // Smoothed so the HUD number does not jitter every second.
        const sample = clockMs() - sentAt;
        this.ping = this.ping ? Math.round(this.ping * 0.6 + sample * 0.4) : Math.round(sample);
      }
      return true;
    }
    return false;
  }

  /* --- messaging --------------------------------------------------------- */

  broadcast(payload, { reliable = false } = {}) {
    if (!this.channel || !this.joined) return;
    try {
      // send() returns a promise only when the channel promises acks; it is
      // undefined otherwise, so it must not be chained blindly.
      const p = this.channel.send({
        type: 'broadcast',
        event: 'msg',
        payload: { ...payload, from: this.id },
      });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      // A dead socket must never take the frame loop down with it.
    }
    void reliable;
  }

  sendInput(input, ack) {
    this.broadcast({
      t: 'in',
      ack,
      i: [
        +input.forward.toFixed(3), +input.strafe.toFixed(3),
        +input.lookX.toFixed(4), +input.lookY.toFixed(4),
        (input.jump ? 1 : 0) | (input.sprint ? 2 : 0) | (input.crouch ? 4 : 0) |
        (input.fire ? 8 : 0) | (input.aim ? 16 : 0) | (input.reload ? 32 : 0) |
        (input.swap ? 64 : 0) | (input.med ? 128 : 0) | ((input.slot || 0) << 8),
      ],
    });
  }

  sendSnapshot(fighters, extra = {}) {
    this.broadcast({
      t: 'snap',
      s: fighters.map((f) => quantiseFighter(f, f.speed ? { speed: f.speed } : {})),
      ...extra,
    });
  }

  static decodeSnapshot(arr) {
    return arr.map(dequantiseFighter);
  }
}
