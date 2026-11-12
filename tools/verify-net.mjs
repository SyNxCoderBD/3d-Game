/* Protocol-level test with an in-memory transport standing in for the socket.
   The sandbox blocks *.supabase.co, so the WebSocket hop itself has to be
   verified in the browser; everything above it is testable here. */
globalThis.WebSocket = class { constructor(){} send(){} close(){} addEventListener(){} };

const { NetClient } = await import('../src/net/net.js');
const { OnlineSession } = await import('../src/net/session.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/* --- quantisation round trip ------------------------------------------- */
const fighter = {
  id: 'abc', position: { x: 12.345, y: 5.678, z: -9.012 }, yaw: 0.785, pitch: -0.21,
  health: 88.4, alive: true, crouching: true, aimT: 0.437, speed: 3.21,
  slot: 1, armor: 42.6, kills: 3, deaths: 2,
};
const enc = [];
// Reach into the module's encoder through a snapshot send.
const s1 = new NetClient({});
let sent = null;
s1.channel = { send: (p) => { sent = p.payload; } };
s1.joined = true;
s1.sendSnapshot([fighter]);
const dec = NetClient.decodeSnapshot(sent.s)[0];

check('position quantised to cm', Math.abs(dec.x - 12.35) < 0.01 && Math.abs(dec.z - -9.01) < 0.01, `${dec.x}, ${dec.z}`);
check('yaw/pitch quantised to 0.01 rad', Math.abs(dec.yaw - 0.785) < 0.011 && Math.abs(dec.pitch - -0.21) < 0.011);
check('health + armor survive', dec.health === 88 && dec.armor === 43, `${dec.health}/${dec.armor}`);
check('flags survive', dec.alive === true && dec.crouch === true);
check('slot survives', dec.slot === 1);
check('kills/deaths survive', dec.kills === 3 && dec.deaths === 2);
console.log('  snapshot size:', JSON.stringify(sent).length, 'bytes');

/* --- input packing ------------------------------------------------------ */
const inputWord = [
  0.5, -0.25, 0.01, -0.02,
  (true?1:0) | 0 | 4 | 8 | 16 | 0 | 0 | 128 | (2 << 8),
];
const unpacked = OnlineSession.unpackInput(inputWord);
check('input bitfield unpacks', unpacked.jump && unpacked.crouch && unpacked.fire
  && unpacked.aim && unpacked.med && !unpacked.sprint && !unpacked.reload && unpacked.slot === 2);

/* --- interpolation ------------------------------------------------------ */
const sess = new OnlineSession({});
sess.localId = 'me';
sess.running = true;
sess._ingestSnapshot({ s: [[ 'peer', 1000, 0, 0, 0, 0, 100, 1, 0, 0, 0, 0, 0, 0, 0 ]], ack: 0 });
const now = performance.now() / 1000;
const entry = sess.remoteState.get('peer');
entry.buffer = [
  { t: now - 0.2, id:'peer', x: 0,  y: 0, z: 0,  yaw: 0,   pitch: 0, health: 100, alive: true, crouch: false, aimT: 0, speed: 0, slot: 0, armor: 0, kills: 0, deaths: 0 },
  { t: now + 0.2, id:'peer', x: 10, y: 0, z: 0,  yaw: 3.14, pitch: 0, health: 100, alive: true, crouch: false, aimT: 0, speed: 0, slot: 0, armor: 0, kills: 0, deaths: 0 },
];
const mid = sess.sampledState('peer');
check('interpolates between snapshots', mid.x > 0 && mid.x < 10, `x ≈ ${mid.x.toFixed(2)}`);
check('yaw uses shortest arc', Math.abs(mid.yaw) > 0.5, `yaw ≈ ${mid.yaw.toFixed(2)}`);

/* --- ack handling ------------------------------------------------------- */
sess.inputHistory = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
sess._ingestSnapshot({ s: [], ack: 2 });
check('acknowledged inputs are dropped', sess.inputHistory.length === 1 && sess.inputHistory[0].seq === 3);

/* --- lost pongs must not accumulate ------------------------------------ */
const lossy = new NetClient({});
lossy.joined = true;
lossy.channel = { send: () => undefined };
for (let i = 0; i < 400; i++) {
  // Pretend every ping was sent ~2 minutes ago and never answered.
  lossy.sendPing();
  const seq = lossy._pingSeq;
  lossy._pendingPings.set(seq, lossy._pendingPings.get(seq) - 120000);
}
check('lost pings are pruned, not accumulated', lossy._pendingPings.size <= 12, `${lossy._pendingPings.size} pending`);

console.log(`\n${fail === 0 ? '✅' : '❌'} protocol: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
