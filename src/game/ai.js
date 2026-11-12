import { sampleHeight } from '../world/heightgrid.js';
import { clamp } from '../util/math.js';

const EMPTY = () => ({
  forward: 0, strafe: 0, lookX: 0, lookY: 0,
  jump: false, sprint: false, crouch: false,
  fire: false, aim: false, reload: false, swap: false, med: false,
});

function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Rough line-of-sight test against the terrain. */
function canSee(from, to) {
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

    if (this.retarget <= 0) {
      this.retarget = 0.35;
      let best = null;
      let bestDist = Infinity;
      for (const other of ctx.fighters) {
        if (other === f || !other.alive) continue;
        const d = other.position.distanceTo(f.position);
        if (d < bestDist && d < 110) {
          if (canSee(
            { x: f.position.x, y: f.position.y + 1.5, z: f.position.z },
            { x: other.position.x, y: other.position.y + 1.3, z: other.position.z }
          )) {
            best = other;
            bestDist = d;
          }
        }
      }
      this.target = best;
    }

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

      // Wobble that fades as the bot settles on the target.
      this.aimErrorVel += (Math.random() - 0.5) * dt * (1.6 - this.skill);
      this.aimErrorVel *= Math.exp(-3 * dt);
      this.aimError = clamp(this.aimError + this.aimErrorVel, -0.14, 0.14) * (1.15 - this.skill);
    }

    const turnRate = 3.2 + this.skill * 4;
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
      out.strafe = this.strafeDir * (0.7 + Math.random() * 0.2);

      if (dist > 34) out.forward = 1;
      else if (dist < 9) out.forward = -1;
      else out.forward = Math.sin(this.think * 2) > 0.6 ? 1 : 0;

      out.sprint = dist > 45;

      // ---- shooting ---------------------------------------------------
      const wantFire = aimAligned && dist < 75 && f.slotData.ammo > 0;
      if (f.slotData.ammo === 0) out.reload = true;

      this.burstCooldown -= dt;
      if (wantFire && this.burstCooldown <= 0) {
        this.burst = 0.18 + Math.random() * 0.35;
        this.burstCooldown = 0.45 + (1 - this.skill) * 0.9 + Math.random() * 0.4;
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
