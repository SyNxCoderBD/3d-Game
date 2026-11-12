import { sampleHeight } from '../world/heightgrid.js';
import { clamp } from '../util/math.js';

const EMPTY = () => ({
  forward: 0, strafe: 0, lookX: 0, lookY: 0,
  jump: false, sprint: false, crouch: false,
  fire: false, aim: false, reload: false, swap: false, slot: 0, med: false,
});

function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Line of sight. A bot only sees a target when the terrain *and* the solid
 * world props (tree trunks, boulders) are clear — that is what makes cover
 * work against them.
 */
function canSee(from, to, world) {
  if (world && world.blockedBetween(from, to, 0.4)) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  const steps = Math.min(24, Math.max(3, Math.floor(dist / 6)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const z = from.z + dz * t;
    if (sampleHeight(x, z) > y - 0.4) return false;
  }
  return true;
}

export class BotBrain {
  constructor(fighter, spawnPoints, skill = 0.5) {
    this.f = fighter;
    this.spawns = spawnPoints;
    this.skill = skill; // 0..1
    this.target = null;
    this.retarget = 0;
    this.aimError = 0;
    this.aimErrorVel = 0;
    this.aimDrift = 0;
    this.burst = 0;
    this.burstCooldown = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 1 + Math.random();
    this.waypoint = null;
    this.waypointTimer = 0;
    this.jumpTimer = 2 + Math.random() * 4;
    this.think = 0;
    this.stuckTimer = 0;
    this.lastPos = { x: 0, z: 0 };
    this.slotTimer = 0;

    // Reaction and accuracy state. Bots do not snap onto a target: they take
    // a moment to notice it, then their aim settles in over a beat or two.
    this.reaction = 0;          // seconds left before the bot may shoot
    this.acquire = 0;           // how settled the aim is, 0..1
    this.lastSeen = 0;          // grace period with a known target
    this.fireDiscipline = 0.6 + Math.random() * 0.7;
    // These are re-derived from skill every update; defaults describe skill 0.
    // A weak bot is slow to notice you and slow to settle its aim. Scaled so
    // that skill 0 is clearly beatable (over a second of reaction, a long
    // settle) and skill 1 is sharp but still human.
    this.reactionSkill = 1.35 - skill * 1.05;
    this.acquireRate = 0.85 + skill * 2.6;
    this.burstMin = 0.16;
    this.burstMax = 0.16 + 0.26;
    this.recoilPause = 0;       // forced trigger release after a burst
    this.lostTargetAt = -99;
    this.coverHint = 0;
  }

  /**
   * Pick the best gun for the current range: shotgun up close, sniper across
   * open ground, rifle/smg in between. Bots only carry what they've looted.
   */
  chooseSlot(dist) {
    const f = this.f;
    if (!dist) return;
    let wanted;
    if (dist < 14) wanted = 'shotgun';
    else if (dist > 55) wanted = 'sniper';
    else wanted = 'rifle';
    if (f.weapon.id === wanted) return;

    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < f.slots.length; i++) {
      const slot = f.slots[i];
      if (!slot || i === f.slot) continue;
      const base = { shotgun: 3, smg: 2, rifle: 4, sniper: 3, pistol: 1 }[slot.id] ?? 0;
      // Prefer the ideal gun, then whatever else is loaded and sensible.
      let score = slot.id === wanted ? 10 : base;
      if (slot.ammo + slot.reserve <= 0) score -= 20;
      if (dist < 18 && slot.id === 'sniper') score -= 8;
      if (dist > 45 && slot.id === 'shotgun') score -= 8;
      if (dist > 18 && dist < 45 && slot.id === 'shotgun') score -= 1.5;
      if (slot.id === 'pistol') score -= 2;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestScore > 0) f.selectSlot(bestIdx);
  }

  pickWaypoint() {
    const s = this.spawns[(Math.random() * this.spawns.length) | 0];
    this.waypoint = { x: s.position.x, y: s.position.y, z: s.position.z };
    this.waypointTimer = 14 + Math.random() * 10;
  }

  update(dt, ctx) {
    const out = EMPTY();
    const f = this.f;
    if (!f.alive) return out;

    this.retarget -= dt;
    this.think -= dt;
    this.strafeTimer -= dt;

    const world = ctx.effects?.world || null;
    if (this.retarget <= 0) {
      // Slower scanning than before: bots used to re-acquire every 0.35 s.
      this.retarget = 0.5;
      let best = null;
      let bestDist = Infinity;
      for (const other of ctx.fighters) {
        if (other === f || !other.alive) continue;
        const d = other.position.distanceTo(f.position);
        if (d < bestDist && d < 95) {
          if (canSee(
            { x: f.position.x, y: f.position.y + 1.5, z: f.position.z },
            { x: other.position.x, y: other.position.y + 1.3, z: other.position.z },
            world
          )) {
            best = other;
            bestDist = d;
          }
        }
      }
      if (best && best !== this.target) {
        // Fresh target: take a visible beat to react. Closing the distance
        // shortens it, so an ambush still feels dangerous.
        this.reactionSkill = 1.35 - this.skill * 1.05;
        this.reaction = this.reactionSkill;
        this.acquire = 0;
        this.fireDiscipline = 0.55 + Math.random() * 0.8;
      }
      this.target = best;
    }

    this.reaction -= dt;
    // Cover check runs every frame against the current target: stepping
    // behind a trunk forces the bot to lose lock and re-acquire afterwards.
    if (this.retarget > 0.4 && this.target && this.target.alive) {
      const clear = canSee(
        { x: f.position.x, y: f.position.y + 1.5, z: f.position.z },
        { x: this.target.position.x, y: this.target.position.y + 1.3, z: this.target.position.z },
        world
      );
      if (!clear) {
        this.retarget = 0;
        this.reaction = Math.max(this.reaction, 0.35);
      }
    }
    const seen = !!(this.target && this.target.alive);
    if (seen) this.lastSeen = 0.9;
    else this.lastSeen -= dt;

    // Lost sight for good: forget the target so they have to find you again.
    if (!seen && this.lastSeen <= 0) this.target = null;
    const target = this.target && this.target.alive ? this.target : null;

    // ---- aiming -------------------------------------------------------
    let desiredYaw = f.yaw;
    let desiredPitch = 0;
    let dist = 0;

    if (target) {
      const tx = target.position.x;
      const ty = target.position.y + (target.crouching ? 1.0 : 1.35);
      const tz = target.position.z;
      const dx = tx - f.position.x;
      const dy = ty - (f.position.y + 1.62);
      const dz = tz - f.position.z;
      dist = Math.hypot(dx, dz);
      desiredYaw = Math.atan2(-dx, -dz);
      desiredPitch = Math.atan2(dy, dist);

      // Aim settles over ~0.55 s instead of snapping on.
      this.acquire = Math.min(1, this.acquire + dt * this.acquireRate);

      // A real aim cone: it starts wide while the bot is still "finding" the
      // target, narrows as it settles, and opens up again while firing.
      const freshness = 1.55 - this.acquire * 1.05;
      const kick = this.recoilPause > 0 ? 1.35 : 1;
      // Aim wander. The old range (0.34 down to 0.18) was nearly flat, so a
      // "weak" bot was almost as accurate as a strong one. Spread it properly.
      const drift = (0.62 - this.skill * 0.46) * freshness * kick;
      // Low-frequency wander + per-frame jitter: reads as human aim, not noise.
      this.aimDrift += (Math.random() - 0.5) * dt * drift * 2.4;
      this.aimDrift *= Math.exp(-2.2 * dt);
      this.aimErrorVel += (Math.random() - 0.5) * dt * drift * 1.6;
      this.aimErrorVel *= Math.exp(-3.4 * dt);
      const errorLimit = 0.085 - this.skill * 0.045;
      this.aimError = clamp(this.aimError + this.aimErrorVel + this.aimDrift * dt,
        -errorLimit, errorLimit);
    }

    const turnRate = 1.15 + this.skill * 4.2;
    const yawDelta = angleDelta(f.yaw, desiredYaw + this.aimError);
    const pitchDelta = clamp(desiredPitch - f.pitch, -0.5, 0.5);

    out.lookX = -clamp(yawDelta, -turnRate * dt, turnRate * dt);
    out.lookY = -clamp(pitchDelta, -turnRate * 0.6 * dt, turnRate * 0.6 * dt);

    // ---- movement -----------------------------------------------------
    if (target) {
      const aimAligned = Math.abs(yawDelta) < 0.18;
      out.aim = dist > 12 && aimAligned;

      // Keep a fighting distance and circle-strafe.
      if (this.strafeTimer <= 0) {
        this.strafeDir *= -1;
        this.strafeTimer = 0.9 + Math.random() * 1.4;
      }
      out.strafe = this.strafeDir * (0.55 + Math.random() * 0.2);

      if (dist > 34) out.forward = 1;
      else if (dist < 9) out.forward = -1;
      else out.forward = Math.sin(this.think * 2) > 0.6 ? 1 : 0;

      out.sprint = dist > 45;
      out.aim = dist > 12 && aimAligned && this.reaction <= 0;

      // ---- weapon choice ----------------------------------------------
      this.slotTimer -= dt;
      if (this.slotTimer <= 0) {
        this.slotTimer = 1.5;
        this.chooseSlot(dist);
      }

      // ---- shooting ---------------------------------------------------
      this.recoilPause -= dt;
      const settled = this.acquire > 0.55;
      const wantFire = this.reaction <= 0 && settled && this.recoilPause <= 0 &&
        aimAligned && dist < f.weapon.range + 10 && f.slotData.ammo > 0;
      if (f.slotData.ammo === 0) {
        // Grab a loaded gun rather than standing still reloading under fire.
        const loaded = f.slots.some((s2, i2) => i2 !== f.slot && s2 && s2.ammo > 0);
        if (loaded && dist < 30) out.swap = true;
        else out.reload = true;
      }

      this.burstCooldown -= dt;
      if (wantFire && this.burstCooldown <= 0) {
        // Short bursts, then a real pause to recover from recoil. Low-skill
        // bots spray less and pause longer.
        this.burstMin = 0.16;
        this.burstMax = 0.16 + 0.26 * this.fireDiscipline;
        this.burst = this.burstMin + Math.random() * (this.burstMax - this.burstMin);
        this.burstCooldown = (0.34 + (1 - this.skill) * 0.85) * this.fireDiscipline + Math.random() * 0.35;
        this.recoilPause = 0.06 + Math.random() * 0.10 * (1 - this.skill);
      }
      if (this.burst > 0) {
        this.burst -= dt;
        out.fire = true;
        if (this.burstCooldown < 0.2) out.fire = false;
      }

      if (f.health < 45 && f.medkits > 0 && dist > 22) out.med = true;
    } else {
      // ---- patrol -----------------------------------------------------
      if (!this.waypoint || this.waypointTimer <= 0 ||
          Math.hypot(this.waypoint.x - f.position.x, this.waypoint.z - f.position.z) < 6) {
        this.pickWaypoint();
      }
      const dx = this.waypoint.x - f.position.x;
      const dz = this.waypoint.z - f.position.z;
      const wy = Math.atan2(-dx, -dz);
      const d = angleDelta(f.yaw, wy);
      out.lookX = -clamp(d, -2.6 * dt, 2.6 * dt);
      out.forward = Math.abs(d) < 1.1 ? 1 : 0.25;
      out.sprint = Math.abs(d) < 0.4;
      out.aim = false;

      if (f.slotData.ammo < f.weapon.magSize * 0.4) out.reload = true;
      if (f.health < 60 && f.medkits > 0) out.med = true;

      // Grab nearby pickups by walking to them.
      let near = null;
      let nearD = 30;
      for (const p of ctx.pickups?.items || []) {
        if (!p.active) continue;
        const pd = Math.hypot(p.position.x - f.position.x, p.position.z - f.position.z);
        if (pd < nearD) { nearD = pd; near = p; }
      }
      if (near && nearD < 26) {
        const wx = near.position.x - f.position.x;
        const wz = near.position.z - f.position.z;
        const wy2 = Math.atan2(-wx, -wz);
        const d2 = angleDelta(f.yaw, wy2);
        out.lookX = -clamp(d2, -2.6 * dt, 2.6 * dt);
        out.forward = Math.abs(d2) < 1.0 ? 1 : 0.2;
      }
    }

    // Unstick
    if (this.think <= 0) {
      this.think = 0.5;
      const moved = Math.hypot(f.position.x - this.lastPos.x, f.position.z - this.lastPos.z);
      if (moved < 0.4) {
        this.stuckTimer++;
        if (this.stuckTimer > 2) {
          out.jump = true;
          this.strafeDir *= -1;
          this.pickWaypoint();
          this.stuckTimer = 0;
        }
      } else {
        this.stuckTimer = 0;
      }
      this.lastPos = { x: f.position.x, z: f.position.z };
    }

    this.waypointTimer -= dt;
    return out;
  }
}
