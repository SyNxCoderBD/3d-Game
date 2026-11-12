import * as THREE from 'three';
import { WORLD } from '../world/heightfield.js';
import { sampleHeight } from '../world/heightgrid.js';
import { WEAPONS, createWeaponModel, weaponMuzzle, weaponHands } from './weapons.js';
import { createCharacter, animateCharacter } from './character.js';
import { hitscan, hitboxDistances } from './combat.js';
import { clamp, damp, lerp } from '../util/math.js';

export const EYE_HEIGHT = 1.62;

/* Health regenerates on its own: wait a beat after the last hit, then refill a
   full bar over REGEN_TIME. A medkit is the instant option. */
export const REGEN_DELAY = 5.0;
export const REGEN_TIME = 15.0;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
// Dedicated to the reticle test, which runs after the weapon code.
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

function setLayersDeep(obj, layer) {
  obj.traverse((o) => o.layers.set(layer));
}

function attachFlash(gunModel, layer = null) {
  const muzzle = weaponMuzzle(gunModel);
  if (!muzzle) return null;
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  for (let i = 0; i < 2; i++) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.28), mat);
    plane.rotation.z = i * Math.PI * 0.5;
    group.add(plane);
  }
  group.visible = false;
  muzzle.add(group);
  // The flash is attached after the gun's layer pass, so it must be assigned
  // explicitly: a layer-0 flash would be drawn by every camera.
  if (layer !== null) setLayersDeep(group, layer);
  return group;
}

export class Fighter {
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name;
    this.isBot = !!opts.isBot;
    this.isLocal = !!opts.camera;
    this.scene = opts.scene;
    this.spawnPoints = opts.spawnPoints || [];
    this.respawnDelay = opts.respawnDelay ?? 3.2;

    this.bodyLayer = opts.bodyLayer ?? 0;
    this.rig = createCharacter(opts.palette, opts.accent);
    this.bodyAnchor = new THREE.Group();
    this.bodyAnchor.add(this.rig.root);
    setLayersDeep(this.bodyAnchor, this.bodyLayer);
    this.scene.add(this.bodyAnchor);

    this.position = new THREE.Vector3(0, 40, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.health = 100;
    this.armor = 0;
    this.alive = false;
    this.respawnTimer = 0;
    this.crouching = false;
    this.grounded = false;
    this.swimming = false;
    this.spawnProtect = 0;

    this.kills = 0;
    this.deaths = 0;
    this.medkits = 2;
    this.medCooldown = 0;
    // Passive regen: 5 s after the last hit, then a full bar over 15 s.
    this.regenDelay = 0;
    this.regenT = 0;
    this.onTarget = null;
    this.hitFlash = 0;
    this.lastHitBy = null;

    this.slots = [
      { id: 'rifle', ammo: WEAPONS.rifle.magSize, reserve: WEAPONS.rifle.startReserve },
      { id: 'pistol', ammo: WEAPONS.pistol.magSize, reserve: WEAPONS.pistol.startReserve },
      { id: 'smg', ammo: WEAPONS.smg.magSize, reserve: WEAPONS.smg.startReserve },
    ];
    this.slot = 0;
    this.cooldown = 0;
    this.reloading = 0;
    this.swapTimer = 0;
    this.firePrev = false;

    this.aiming = false;
    this.aimT = 0;
    this.recoilPitch = 0;
    this.recoilVel = 0;
    this.lookKick = 0;
    this.bob = 0;
    this.bobWeight = 0;
    this.speed = 0;
    this.onHit = null;
    this.onDamage = null;
    this.flashTimer = 0;
    this.viewLayer = opts.viewLayer ?? 0;

    this.baseFov = 78;

    if (opts.camera) {
      this.camera = opts.camera;
      this.camera.rotation.order = 'YXZ';
      this.camera.fov = this.baseFov;
      this.camera.near = 0.03;
      this.camera.far = WORLD.far;
      this.camera.updateProjectionMatrix();

      this.viewRoot = new THREE.Group();
      this.viewRoot.layers.set(opts.viewLayer);
      this.camera.add(this.viewRoot);
      this.viewPivot = new THREE.Group();
      this.viewPivot.position.set(0.21, -0.20, -0.38);
      this.viewRoot.add(this.viewPivot);
    }

    this.viewGun = null;
    this.bodyGun = null;
    this.viewFlash = null;
    this.bodyMuzzleFlash = null;
    this._hands = null;
    this.refreshWeaponModels();
  }

  /* ------------------------------------------------------------ weapons */

  get weapon() { return WEAPONS[this.slots[this.slot].id]; }
  get slotData() { return this.slots[this.slot]; }

  refreshWeaponModels(force = false) {
    const id = this.weapon.id;
    const needsBody = !this.bodyGun || this._gunId !== id;
    const needsView = !!this.viewPivot && (!this.viewGun || this._viewGunId !== id);
    if (!force && !needsBody && !needsView) return;

    if (force || !this.bodyGun || this._gunId !== id) {
      if (this.bodyGun) {
        this.rig.gunMount.remove(this.bodyGun);
        this.bodyGun = null;
      }
      // The body gun belongs to the character rig: it must sit on the same
      // layer as the body, or the owner's own camera renders it as a second
      // gun floating at chest height.
      this.bodyGun = createWeaponModel(this.weapon.id);
      this.bodyGun.position.set(0, 0, 0);
      setLayersDeep(this.bodyGun, this.bodyLayer);
      this.rig.gunMount.add(this.bodyGun);
      this.bodyMuzzleFlash = attachFlash(this.bodyGun, this.bodyLayer);
      // Anchor objects the arms are solved onto each frame.
      this._hands = weaponHands(this.bodyGun);
      this._gunId = id;
    }

    if (this.viewPivot && (force || !this.viewGun || this._viewGunId !== id)) {
      if (this.viewGun) this.viewPivot.remove(this.viewGun);
      this.viewGun = createWeaponModel(this.weapon.id);
      setLayersDeep(this.viewGun, this.viewLayer);
      this.viewFlash = attachFlash(this.viewGun, this.viewLayer);
      this.viewPivot.add(this.viewGun);
      this._viewGunId = id;
    }
  }

  giveWeapon(id, ammo = null, reserve = null) {
    const def = WEAPONS[id];
    if (!def) return false;
    const existing = this.slots.findIndex((s) => s.id === id);
    if (existing >= 0) {
      this.slots[existing].reserve = Math.min(
        def.maxReserve,
        this.slots[existing].reserve + (reserve ?? Math.round(def.magSize * 1.5))
      );
      return true;
    }
    const slot = {
      id,
      ammo: ammo ?? def.magSize,
      reserve: reserve ?? def.startReserve,
    };
    // Fill the first slot that isn't the one in your hands.
    let target = -1;
    for (let i = 0; i < this.slots.length; i++) {
      if (i !== this.slot) { target = i; break; }
    }
    if (target < 0) {
      this.slots[this.slot] = slot;
    } else {
      this.slots[target] = slot;
      this.slot = target;
    }
    this.reloading = 0;
    this.swapTimer = 0.3;
    this.refreshWeaponModels();
    return true;
  }

  selectSlot(index) {
    if (index === this.slot) return;
    if (index < 0 || index >= this.slots.length) return;
    if (!this.slots[index] || this.reloading > 0.55) return;
    if (this.swapTimer > 0) return;
    this.slot = index;
    this.swapTimer = 0.35;
    this.reloading = 0;
    this.refreshWeaponModels();
    this.onSwap?.();
  }

  addAmmo(amount) {
    const def = this.weapon;
    const data = this.slotData;
    data.reserve = Math.min(def.maxReserve, data.reserve + amount);
  }

  swapWeapon() {
    if (this.swapTimer > 0 || this.reloading > 0.55) return;
    const n = this.slots.length;
    for (let i = 1; i <= n; i++) {
      const next = (this.slot + i) % n;
      if (this.slots[next]) { this.slot = next; break; }
      // empty slots still need to be skipped, not held
    }
    this.swapTimer = 0.35;
    this.reloading = 0;
    this.refreshWeaponModels();
    this.onSwap?.();
  }

  startReload() {
    const def = this.weapon;
    const data = this.slotData;
    if (this.reloading > 0 || this.swapTimer > 0) return;
    if (data.ammo >= def.magSize || data.reserve <= 0) return;
    this.reloading = def.reloadTime;
    this.onReloadStart?.(def);
  }

  /**
   * Passive health regen. After REGEN_DELAY seconds without damage the bar
   * refills from wherever it is up to 100 at REGEN_TIME seconds per full bar.
   * `regenT` drives the HUD so the player can see it filling.
   */
  updateRegen(dt) {
    if (!this.alive || this.health >= 100) {
      this.regenT = this.health >= 100 ? 0 : this.regenT;
      return;
    }
    if (this.regenDelay > 0) {
      this.regenDelay = Math.max(0, this.regenDelay - dt);
      return;
    }
    this.regenT += dt;
    // A full 100-point bar takes REGEN_TIME seconds.
    this.health = Math.min(100, this.health + (100 / REGEN_TIME) * dt);
    if (this.health >= 100) {
      this.health = 100;
      this.regenT = 0;
    }
  }

  useMedkit() {
    if (this.medkits <= 0 || this.medCooldown > 0 || this.health >= 100) return false;
    this.medkits--;
    // The medkit is the fast refill: top up immediately and reset the slow
    // passive regen, so it does not double-dip.
    this.health = Math.min(100, this.health + 55);
    this.medCooldown = 1.4;
    this.regenDelay = 0;
    this.regenT = 0;
    this.onHeal?.();
    return true;
  }

  /* ------------------------------------------------------------- state */

  spawnAt(point, yaw = 0) {
    this.position.set(point.x, point.y + 0.05, point.z);
    this.velocity.set(0, 0, 0);
    this.health = 100;
    this.armor = 0;
    this.alive = true;
    this.respawnTimer = 0;
    this.spawnProtect = 1.2;
    this.regenDelay = 0;
    this.regenT = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.rig.deathT = 0;
    this.rig.root.rotation.x = 0;
    this.bodyAnchor.visible = true;
    this.reloading = 0;
    this.cooldown = 0;
    for (const s of this.slots) {
      if (!s) continue;
      const def = WEAPONS[s.id];
      s.ammo = s.ammo || def.magSize;
      s.reserve = Math.max(s.reserve, Math.round(def.magSize * 0.6));
    }
    this.slot = 0;
    this.refreshWeaponModels();
    this.medkits = Math.max(this.medkits, 1);
    this.syncCamera(0);
  }

  respawn(ctx) {
    const pts = this.spawnPoints;
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 10; i++) {
      const p = pts[(Math.random() * pts.length) | 0];
      let score = Infinity;
      for (const other of ctx.fighters) {
        if (other === this || !other.alive) continue;
        score = Math.min(score, other.position.distanceTo(p.position));
      }
      if (score > bestScore) { bestScore = score; best = p; }
      if (bestScore > 60) break;
    }
    if (!best) best = pts[0];
    this.spawnAt(best.position, best.yaw);
    this.onRespawn?.();
  }

  takeDamage(amount, from, headshot = false) {
    if (!this.alive || this.spawnProtect > 0) return false;

    let dmg = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * 0.55);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    this.health -= dmg;
    this.hitFlash = 1;
    this.lastHitBy = from;
    // Getting shot restarts the regen wait and the fill clock.
    this.regenDelay = REGEN_DELAY;
    this.regenT = 0;
    if (from) {
      // Bearing of the incoming fire relative to where this fighter is
      // looking: 0 = dead ahead, +PI/2 = to the right.
      const dx = from.position.x - this.position.x;
      const dz = from.position.z - this.position.z;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      const fwd = -dx * sin - dz * cos;
      const right = dx * cos - dz * sin;
      this.lastHitAngle = Math.atan2(right, fwd);
    }
    this.onDamage?.(dmg, from, headshot);

    if (this.health <= 0) {
      this.health = 0;
      this.die(from);
      return true;
    }
    return false;
  }

  die(killer) {
    this.alive = false;
    this.respawnTimer = this.respawnDelay;
    this.deaths++;
    this.rig.deathT = 0;
    this.aiming = false;
    if (killer && killer !== this) killer.kills++;
    this.onDeath?.(killer);
  }

  /* -------------------------------------------------------------- tick */

  update(dt, input, ctx) {
    this.medCooldown = Math.max(0, this.medCooldown - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.2);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.swapTimer = Math.max(0, this.swapTimer - dt);
    this.spawnProtect = Math.max(0, this.spawnProtect - dt);
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0 && this.bodyMuzzleFlash) this.bodyMuzzleFlash.visible = false;
    }
    this.updateRegen(dt);

    if (!this.alive) {
      this.respawnTimer -= dt;
      animateCharacter(this.rig, { dead: true, speed: 0, grounded: true, aiming: false }, dt);
      if (this.respawnTimer <= 0 && ctx) this.respawn(ctx);
      return;
    }

    // Aim assist: pad players get a gentle magnetic pull toward the enemy
    // nearest the reticle. It is deliberately weak — it shortens the last few
    // degrees of stick work, it never snaps onto a target or tracks for you.
    let lookX = input.lookX || 0;
    let lookY = input.lookY || 0;
    if (this.aimAssist && ctx) {
      const assist = this.computeAimAssist(ctx.fighters);
      if (assist) {
        // Applied locally: the input objects are owned by the input devices
        // and must not be mutated, or a static object (a test, a replay) would
        // keep the assist for ever.
        lookX += assist.x;
        lookY += assist.y;
      }
    }

    // look
    if (lookX || lookY) {
      this.yaw -= lookX;
      this.pitch = clamp(this.pitch - lookY, -1.45, 1.45);
      this.lookKick += lookX * 2 + lookY * 1.2;
    }

    this.aiming = !!input.aim && this.swapTimer <= 0;
    this.aimT = damp(this.aimT, this.aiming ? 1 : 0, 12, dt);
    this.crouching = !!input.crouch;

    // movement
    const groundY = sampleHeight(this.position.x, this.position.z);
    this.swimming = groundY < WORLD.waterLevel - 1.2 && this.position.y < WORLD.waterLevel + 1.0;

    let speed = input.sprint ? 8.4 : 5.4;
    if (this.aiming) speed = 3.4;
    if (this.crouching) speed = 2.7;
    if (this.swimming) speed = 3.0;
    if (this.reloading > 0) speed *= 0.85;

    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    let dx = -sinY * input.forward + cosY * input.strafe;
    let dz = -cosY * input.forward - sinY * input.strafe;
    const len = Math.hypot(dx, dz);
    if (len > 1) { dx /= len; dz /= len; }
    if (len < 0.001) { dx = 0; dz = 0; }

    const accel = this.grounded ? 14 : this.swimming ? 6 : 3;
    this.velocity.x = damp(this.velocity.x, dx * speed, accel, dt);
    this.velocity.z = damp(this.velocity.z, dz * speed, accel, dt);

    // Solid world props: trunks and boulders block movement.
    const world = ctx?.effects?.world;
    if (world) {
      const hit = world.pushOut(this.position, 0.32);
      if (hit > 0) {
        // Kill the velocity component into the obstacle so you slide along it.
        this.velocity.x *= 0.45;
        this.velocity.z *= 0.45;
      }
    }

    if (this.swimming) {
      const surface = WORLD.waterLevel + 0.5;
      this.velocity.y = damp(this.velocity.y, (surface - this.position.y) * 3.4, 6, dt);
      this.grounded = false;
    } else {
      this.velocity.y += -25 * dt;
      if (this.grounded && input.jump) {
        this.velocity.y = 7.6;
        this.grounded = false;
      }
    }

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    const limit = WORLD.size * 0.5 - 60;
    this.position.x = clamp(this.position.x, -limit, limit);
    this.position.z = clamp(this.position.z, -limit, limit);

    if (!this.swimming) {
      const gy = sampleHeight(this.position.x, this.position.z);
      if (this.position.y <= gy) {
        this.position.y = gy;
        if (this.velocity.y < 0) this.velocity.y = 0;
        this.grounded = true;
      } else if (this.position.y > gy + 0.06) {
        this.grounded = false;
      }
    }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // weapon logic
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const def = this.weapon;
        const data = this.slotData;
        const need = def.magSize - data.ammo;
        const take = Math.min(need, data.reserve);
        data.ammo += take;
        data.reserve -= take;
        this.reloading = 0;
        this.onReloadEnd?.();
      }
    }

    const wantsFire = !!input.fire;
    const fresh = wantsFire && !this.firePrev;
    this.firePrev = wantsFire;

    if (this.reloading <= 0 && this.swapTimer <= 0 && (this.weapon.auto ? wantsFire : fresh)) {
      this.tryFire(ctx);
    }

    if (input.reload) this.startReload();
    if (input.swap) this.swapWeapon();
    if (input.slot) this.selectSlot(input.slot - 1);
    if (input.med) this.useMedkit();

    // recoil recovery
    this.recoilVel -= this.recoilPitch * 42 * dt;
    this.recoilVel *= Math.exp(-9 * dt);
    this.recoilPitch += this.recoilVel * dt;
    this.recoilPitch *= Math.exp(-6 * dt);
    this.lookKick = damp(this.lookKick, 0, 8, dt);

    // body + camera
    this.bodyAnchor.position.copy(this.position);
    this.bodyAnchor.rotation.y = this.yaw;
    this.bodyAnchor.updateMatrixWorld(true);

    // Where the hands must sit this frame: read the hand anchors off the
    // weapon that is actually in the body rig, so the arms follow the gun
    // through recoil, weapon swaps and the aim transition.
    const hands = this._hands
      ? { grip: this._hands.grip.getWorldPosition(_v1), foregrip: this._hands.foregrip.getWorldPosition(_v2) }
      : null;

    animateCharacter(this.rig, {
      speed: this.speed,
      grounded: this.grounded,
      aiming: this.aimT > 0.35,
      aimPitch: this.pitch + this.recoilPitch,
      crouch: this.crouching,
      dead: false,
      hands: hands ? { grip: hands.grip, foregrip: hands.foregrip, pitch: this.pitch + this.recoilPitch } : null,
    }, dt);

    const moving = this.grounded && this.speed > 0.5;
    this.bobWeight = damp(this.bobWeight, moving ? Math.min(this.speed / 5.4, 1.2) : 0, 6, dt);
    this.bob += dt * (6.4 + this.speed * 0.9);

    if (this.camera) this.syncCamera(dt);
    if (this.viewPivot) this.updateViewmodel(dt);

    // Is an enemy under the reticle? Drives the red crosshair and the body
    // outline. Cheap: one sphere/box test per living opponent, no raycast.
    this.onTarget = this.findReticleTarget(ctx.fighters, ctx?.effects?.world);
  }

  /**
   * The opponent whose body the crosshair is actually over, or null.
   * Uses the same volumes the hitscan does, so "red crosshair" means the next
   * bullet connects.
   */
  findReticleTarget(fighters, world = null) {
    if (!fighters || !this.alive) return null;
    const origin = this.getEyePosition(_c1);
    const dir = this.getAimDirection(_c2);
    let best = null;
    let bestD = this.weapon.range;
    for (const other of fighters) {
      if (other === this || !other.alive) continue;
      const { head, body } = hitboxDistances(origin, dir, other);
      const d = head > 0 && (body < 0 || head <= body) ? head : body;
      if (d > 0 && d < bestD) { bestD = d; best = other; }
    }
    // Cover counts: no red reticle through a tree.
    if (best && world && world.raycast(origin, dir, bestD).t < bestD) return null;
    return best;
  }

  syncCamera() {
    if (!this.camera) return;
    const eye = EYE_HEIGHT - (this.crouching ? 0.30 : 0);
    const bobY = Math.sin(this.bob) * 0.028 * this.bobWeight;
    const bobX = Math.cos(this.bob * 0.5) * 0.022 * this.bobWeight;
    this.camera.position.set(
      this.position.x + bobX * Math.cos(this.yaw),
      this.position.y + eye + bobY,
      this.position.z - bobX * Math.sin(this.yaw)
    );
    this.camera.rotation.set(
      this.pitch + this.recoilPitch,
      this.yaw,
      Math.sin(this.bob * 0.5) * 0.012 * this.bobWeight - this.lookKick * 0.05,
      'YXZ'
    );

    const targetFov = lerp(this.baseFov, this.weapon.adsFov, this.aimT);
    const sprintFov = this.speed > 7.2 ? 4 : 0;
    const fov = targetFov + sprintFov;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  updateViewmodel(dt) {
    const p = this.viewPivot;
    const target = _v1.set(
      lerp(0.21, 0.0, this.aimT),
      lerp(-0.20, -0.118, this.aimT) + Math.sin(this.bob) * 0.006 * this.bobWeight,
      lerp(-0.38, -0.02, this.aimT)
    );
    p.position.lerp(target, 1 - Math.exp(-16 * dt));
    p.rotation.y = lerp(-0.06, 0, this.aimT) - clamp(this.lookKick * 0.12, -0.12, 0.12);
    p.rotation.x = lerp(0.02, 0, this.aimT) - this.recoilPitch * 0.9;
    p.rotation.z = lerp(0.05, 0, this.aimT);

    const kick = this.cooldown > 0 ? this.cooldown * 6 : 0;
    p.position.z += kick * 0.02;

    if (this.viewGun) {
      const scoped = this.weapon.kind === 'sniper' && this.aimT > 0.9;
      this.viewGun.visible = !scoped;
    }

    if (this.viewFlash) {
      this.viewFlash.visible = this.flashTimer > 0;
      if (this.flashTimer > 0) this.viewFlash.scale.setScalar(0.8 + Math.random() * 0.5);
    }
  }

  computeAimAssist(fighters) {
    // Wider than a hair, narrower than a snap: only the cone right around the
    // crosshair is helped.
    const fovX = 0.16;           // ~9 deg: the outer edge of stick precision
    const fovY = 0.10;
    let best = null;
    let bestScore = Infinity;
    for (const other of fighters) {
      if (other === this || !other.alive) continue;
      const dx = other.position.x - this.position.x;
      const dz = other.position.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 40 || d < 1.5) continue;
      const desiredYaw = Math.atan2(-dx, -dz);
      let dy = desiredYaw - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      if (Math.abs(dy) > fovX) continue;
      const targetY = other.position.y + 1.2;
      const desiredPitch = Math.atan2(targetY - (this.position.y + EYE_HEIGHT), d);
      const dp = desiredPitch - this.pitch;
      if (Math.abs(dp) > fovY) continue;
      const score = Math.abs(dy) * 1.4 + Math.abs(dp) + d * 0.004;
      if (score < bestScore) { bestScore = score; best = { dy, dp, d }; }
    }
    if (!best) return null;
    // A constant, light pull applied every frame (input look is in radians per
    // frame for the pad), scaled down as the target gets further away.
    // Exponential damping of the error: it halves the miss over about a
    // second and then levels off, leaving the last degree to the player.
    const strength = this.aiming ? 0.022 : 0.012;
    const falloff = Math.max(0.25, 1 - best.d / 45);
    const k = strength * falloff;
    return { x: -best.dy * k, y: -best.dp * k };
  }

  getEyePosition(out = new THREE.Vector3()) {
    return out.set(
      this.position.x,
      this.position.y + EYE_HEIGHT - (this.crouching ? 0.30 : 0),
      this.position.z
    );
  }

  getAimDirection(out = new THREE.Vector3()) {
    const pitch = this.pitch + this.recoilPitch;
    const cp = Math.cos(pitch);
    return out.set(
      -Math.sin(this.yaw) * cp,
      Math.sin(pitch),
      -Math.cos(this.yaw) * cp
    ).normalize();
  }

  muzzleWorld(out = new THREE.Vector3()) {
    if (this.viewGun) {
      const m = weaponMuzzle(this.viewGun);
      if (m) { m.getWorldPosition(out); return out; }
    }
    if (this.bodyGun) {
      const m = weaponMuzzle(this.bodyGun);
      if (m) { m.getWorldPosition(out); return out; }
    }
    return this.getEyePosition(out);
  }

  tryFire(ctx) {
    const def = this.weapon;
    const data = this.slotData;
    if (this.cooldown > 0 || this.reloading > 0 || this.swapTimer > 0) return;

    if (data.ammo <= 0) {
      if (this.isLocal) this.onEmpty?.();
      this.startReload();
      return;
    }
    data.ammo--;
    this.cooldown = 60 / def.rpm;
    this.flashTimer = 0.045;
    if (this.bodyMuzzleFlash) this.bodyMuzzleFlash.visible = true;
    if (this.viewFlash) this.viewFlash.visible = true;

    const origin = this.getEyePosition(_v2);
    const baseDir = this.getAimDirection(new THREE.Vector3());
    const spread = this.aiming ? def.adsSpread : def.spread;
    const muzzlePos = this.muzzleWorld(new THREE.Vector3());

    // Moving / airborne penalty
    const movePenalty = clamp(this.speed / 9, 0, 1) * 0.012;
    const totalSpread = spread + movePenalty;

    for (let p = 0; p < def.pellets; p++) {
      const dir = baseDir.clone();
      dir.x += (Math.random() - 0.5) * totalSpread * 2;
      dir.y += (Math.random() - 0.5) * totalSpread * 2;
      dir.z += (Math.random() - 0.5) * totalSpread * 2;
      dir.normalize();

      const hit = hitscan(origin, dir, def.range, ctx.fighters, this, ctx.effects?.world);

      if (hit.victim) {
        const falloff = 1 - clamp((hit.distance - 25) / (def.range * 1.4), 0, 0.55);
        const dmg = def.damage * falloff * (hit.headshot ? def.headMul : 1);
        hit.victim.takeDamage(dmg, this, hit.headshot);
        ctx.effects.impact(hit.point, _v1.set(0, 1, 0), 'blood');
        this.onHit?.(hit.victim, hit.headshot, hit.distance);
      } else {
        ctx.effects.impact(hit.point, _v1.set(0, 1, 0), 'spark');
      }
      ctx.effects.tracer(muzzlePos, hit.point, def.kind === 'sniper' ? 0xfff2c8 : 0xffd08a);
    }

    this.recoilVel += def.recoil * 9;
    this.recoilPitch += def.recoil * 0.35;

    this.onShot?.(def, muzzlePos);
  }
}
