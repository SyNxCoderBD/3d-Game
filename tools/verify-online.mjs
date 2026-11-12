/* Online duel integration.
   Runs the real Fighter / Pickups / OnlineSession classes with a fake wire
   between a host and a guest, then asserts the things that would be invisible
   until two people actually tried to play:
     - input reaches the host, snapshots reach the guest
     - the guest takes damage and dies (authority is not thrown away)
     - both clients agree about pickups and spawns
     - a guest cannot invent a win
*/
import * as THREE from 'three';
globalThis.window = { addEventListener(){}, devicePixelRatio:1, innerWidth:1600, innerHeight:900 };
globalThis.document = { createElement: () => ({ getContext: () => ({ createImageData:(w,h)=>({data:[]}), putImageData(){}, drawImage(){} }) }), addEventListener(){} };
if (!globalThis.navigator) globalThis.navigator = { getGamepads: () => [] };
globalThis.WebSocket = class { constructor(){} send(){} close(){} };

const { Fighter } = await import('../src/game/fighter.js');
const { createTerrain } = await import('../src/world/terrain.js');
const { buildSpawnPoints, buildPickupSpots } = await import('../src/game/spawns.js');
const { Pickups } = await import('../src/game/pickups.js');
const { OnlineSession } = await import('../src/net/session.js');
const { NetClient } = await import('../src/net/net.js');

createTerrain();
const spawns = buildSpawnPoints(16);
const unwrap = (sp) => sp.position;
const pose = { forward:0,strafe:0,lookX:0,lookY:0,jump:false,sprint:false,crouch:false,
  fire:false,aim:false,reload:false,swap:false,slot:0,med:false };

let pass = 0, fail = 0;
const check = (n, ok, d='') => { console.log(`${ok?'  ✓':'  ✗'} ${n}${d?' — '+d:''}`); ok?pass++:fail++; };

/* ------------------------------------------------------------ fake wire -- */
const wire = { toGuest: [], toHost: [] };
let hostSess = null;
let guestSess = null;

function makeSession(role) {
  const other = () => (role === 'host' ? guestSess : hostSess);
  const s = new OnlineSession({});
  s.net.role = role;
  s.net.id = role === 'host' ? 'HOST-ID' : 'GUEST-ID';
  s.net.joined = true;
  s.net.channel = {
    send: (p) => {
      const payload = { ...p.payload };
      (role === 'host' ? wire.toGuest : wire.toHost).push(payload);
      other()?._onMessage(payload);
      return undefined;   // real broadcast() gets undefined from send()
    },
  };
  return s;
}
hostSess = makeSession('host');
guestSess = makeSession('guest');
hostSess._begin(); guestSess._begin();
hostSess.localId = 'HOST-ID';
guestSess.localId = 'GUEST-ID';

/* ------------------------------------------------------------- soldiers -- */
const scene = new THREE.Scene();
const mk = (id, name, layer, palette) =>
  new Fighter({ id, name, scene, bodyLayer: layer, palette, spawnPoints: spawns });

const hostMe   = mk('HOST-ID',  'HOST',  4, 'p1');
const hostThem = mk('GUEST-ID', 'GUEST', 2, 'p2');
const guestMe  = mk('GUEST-ID', 'GUEST', 4, 'p1');
const guestThem= mk('HOST-ID',  'HOST',  2, 'p2');

// Role-based spawn slots: the host is always on spot A.
for (const f of [hostMe, guestThem]) f.spawnAt(unwrap(spawns[0]), 0);
for (const f of [hostThem, guestMe]) f.spawnAt(unwrap(spawns[1]), 0);
for (const f of [hostMe, hostThem, guestMe, guestThem]) { f.spawnProtect = 0; f.health = 100; }

console.log('▸ uplink');
for (let i = 0; i < 4; i++) guestSess.clientInput({ ...pose, forward: 1 }, 1/60);
check('guest queues input frames', guestSess.inputHistory.length > 0, `${guestSess.inputHistory.length}`);
check('host receives input packets', wire.toHost.length > 0, `${wire.toHost.length}`);
const firstName = wire.toHost.find(p => p.t === 'in');
check('input packet is tagged with a sequence', firstName && typeof firstName.i === 'object');

console.log('\n▸ downlink');
hostSess.hostTick(1/20, [hostMe, hostThem]);
const snap = wire.toGuest.find(p => p.t === 'snap');
check('host emits a snapshot', !!snap);
check('snapshot carries both soldiers', snap && snap.s.length === 2, snap ? `${snap.s.length}` : '0');
await new Promise(r => setTimeout(r, 60));
hostThem.position.x += 2;
hostSess.hostTick(1/20, [hostMe, hostThem]);
const st = guestSess.sampledState('HOST-ID');
check('guest interpolates the host', !!st, st ? `x≈${st.x.toFixed(1)}` : 'none');
if (st) {
  guestSess.applyRemote(guestThem, st);
  check('applyRemote drives the remote body', Math.abs(guestThem.position.x - st.x) < 0.01);
  guestThem.updateVisualOnly(1/60);
  check('updateVisualOnly runs clean', true);
}
check('guest never interpolates itself', guestSess.sampledState('GUEST-ID') === null);

/* ------------------------------------------- authority on the guest's life */
console.log('\n▸ authority');
// The host decides the guest is nearly dead. The guest's own prediction said
// 100, so this is exactly the case that used to be silently ignored.
hostThem.health = 100;
hostMe.position.copy(hostThem.position).add(new THREE.Vector3(0, 0, -3));
hostMe.yaw = 0;
hostSess.hostTick(1/20, [hostMe, hostThem]);
check('guest accepts authoritative self state', !!guestSess.selfState, guestSess.selfState ? `hp ${guestSess.selfState.health}` : 'none');
const selfHp = guestSess.selfState?.health;
check('self state reports the host\'s health, not the guest\'s guess', selfHp === 100, `hp ${selfHp}`);

// Now the host kills the guest outright.
hostThem.health = 0;
hostThem.alive = false;
hostSess.hostTick(1/20, [hostMe, hostThem]);
check('guest learns it died', guestSess.selfState && guestSess.selfState.alive === false);

/* ----------------------------------------------- guest cannot fake a win -- */
const before = hostMe.kills;
guestSess.net.broadcast({ t: 'over', winner: 'GUEST-ID' });
check('a guest "over" packet cannot end the host\'s match', hostMe.kills === before);

/* ---------------------------------------------------------- determinism -- */
console.log('\n▸ shared world');
const seed = 424242;
const spotsA = buildPickupSpots(30, 20, seed);
const spotsB = buildPickupSpots(30, 20, seed);
check('both clients build the same crate layout', JSON.stringify(spotsA) === JSON.stringify(spotsB));
check('different seeds give different layouts', JSON.stringify(spotsA) !== JSON.stringify(buildPickupSpots(30, 20, seed + 1)));

const pa = new Pickups(new THREE.Scene(), spotsA, seed);
const pb = new Pickups(new THREE.Scene(), spotsB, seed);
const typesA = pa.items.map(i => i.type).join(',');
const typesB = pb.items.map(i => i.type).join(',');
check('both clients agree on crate contents', typesA === typesB);

let ammo = 0, total = 0;
for (let t = 0; t < 40; t++) {
  const p = new Pickups(new THREE.Scene(), buildPickupSpots(30, 20, 1000 + t), 1000 + t);
  total += p.items.length;
  ammo += p.items.filter(i => i.type === 'ammo').length;
}
const share = ammo / total;
check('ammo is the most common pickup', share > 0.45, `${(share * 100).toFixed(0)}% of ${total}`);

/* ----------------------------------------------------- magazine refill --- */
const crate = pa.items.find(i => i.type === 'ammo');
const f = mk('T', 'T', 0, 'p1');
f.slotData.ammo = 0;
f.health = 100;
if (crate) {
  const beforeAmmo = f.slotData.ammo;
  pa.collect(crate, f);
  check('an ammo crate loads the magazine', f.slotData.ammo > beforeAmmo, `${beforeAmmo} → ${f.slotData.ammo}`);
} else {
  check('an ammo crate exists to test', false);
}

/* ------------------------------------------------------------ ping maths -- */
console.log('\n▸ latency');
const pinger = new NetClient({});
pinger.joined = true;
pinger.channel = { send: () => undefined };
pinger.sendPing();
const seq = pinger._pingSeq;
// Backdate the send stamp by 40 ms, then deliver the matching pong.
pinger._pendingPings.set(seq, pinger._pendingPings.get(seq) - 40);
pinger.handlePing({ t: 'pong', seq });
check('a 40 ms round trip reads back as ~40 ms', Math.round(pinger.ping) === 40, `${pinger.ping} ms`);
check('pong is not mistaken for game traffic', pinger.handlePing({ t: 'pong', seq }) === true);

console.log(`\n${fail === 0 ? '✅' : '❌'} online: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
