import * as THREE from 'three';
import { WORLD } from '../world/heightfield.js';
import { sampleHeight } from '../world/heightgrid.js';
import { WEAPONS, createWeaponModel, weaponMuzzle } from './weapons.js';
import { createCharacter, animateCharacter } from './character.js';
import { hitscan } from './combat.js';
import { clamp, damp, lerp } from '../util/math.js';

export const EYE_HEIGHT = 1.62;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

function setLayersDeep(obj, layer) {
  obj.traverse((o) => o.layers.set(layer));
}

function attachFlash(gunModel) {
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

    this.rig = createCharacter(opts.palette, opts.accent);
    this.bodyAnchor = new THREE.Group();
    this.bodyAnchor.add(this.rig.root);
    setLayersDeep(this.bodyAnchor, opts.bodyLayer ?? 0);
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
    this.hitFlash = 0;
    this.lastHitBy = null;

    this.slots = [
      { id: 'rifle', ammo: WEAPONS.rifle.magSize, reserve: WEAPONS.rifle.startReserve },
      { id: 'pistol', ammo: WEAPONS.pistol.magSize, reserve: WEAPONS.pistol.startReserve },
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
    this.refreshWeaponModels();
  }

  /* ------------------------------------------------------------ weapons */

  get weapon() { return WEAPONS[this.slots[this.slot].id]; }
  get slotData() { return this.slots[this.slot]; }

  refreshWeaponModels() {
    if (this.bodyGun) {
      this.rig.gunMount.remove(this.bodyGun);
      this.bodyGun = null;
    }
    this.bodyGun = createWeaponModel(this.weapon.id);
    this.bodyGun.position.set(0, 0, 0);
    this.rig.gunMount.add(this.bodyGun);
    this.bodyMuzzleFlash = attachFlash(this.bodyGun);

    if (this.viewPivot) {
      if (this.viewGun) this.viewPivot.remove(this.viewGun);
      this.viewGun = createWeaponModel(this.weapon.id);
      this.viewFlash = attachFlash(this.viewGun);
      setLayersDeep(this.viewGun, this.viewLayer);
      this.viewPivot.add(this.viewGun);
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
    // Replace the currently held weapon, or fill the empty slot.
    const target = this.slot === 0 ? 1 : 0;
    this.slots[target] = slot;
    this.slot = target;
    this.reloading = 0;
    this.swapTimer = 0.3;
    this.refreshWeaponModels();
    return true;
  }

  addAmmo(amount) {
    const def = this.weapon;
    const data = this.slotData;
    data.reserve = Math.min(def.maxReserve, data.reserve + amount);
  }

  swapWeapon() {
    if (this.swapTimer > 0 || this.reloading > 0) return;
    this.slot = this.slot === 0 ? 1 : 0;
    this.swapTimer = 0.35;
    this.reloading = 0;
    this.refreshWeaponModels();
  }

  startReload() {
    const def = this.weapon;
    const data = this.slotData;
    if (this.reloading > 0 || this.swapTimer > 0) return;
    if (data.ammo >= def.magSize || data.reserve <= 0) return;
    this.reloading = def.reloadTime;
  }

  useMedkit() {
    if (this.medkits <= 0 || this.medCooldown > 0 || this.health >= 100) return false;
    this.medkits--;
    this.health = Math.min(100, this.health + 55);
    this.medCooldown = 1.4;
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
    this.yaw = yaw;
    this.pitch = 0;
    this.rig.deathT = 0;
    this.rig.root.rotation.x = 0;
    this.bodyAnchor.visible = true;
    this.reloading = 0;
    this.cooldown = 0;
    this.slots[0].ammo = Math.min(this.slots[0].ammo || WEAPONS[this.slots[0].id].magSize, WEAPONS[this.slots[0].id].magSize);
    if (this.slots[0].ammo === 0) this.slots[0].ammo = WEAPONS[this.slots[0].id].magSize;
    this.slots[1].ammo = WEAPONS[this.slots[1].id].magSize;
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

    if (!this.alive) {
      this.respawnTimer -= dt;
      animateCharacter(this.rig, { dead: true, speed: 0, grounded: true, aiming: false }, dt);
      if (this.respawnTimer <= 0 && ctx) this.respawn(ctx);
      return;
    }

    // look
    if (input.lookX || input.lookY) {
      this.yaw -= input.lookX;
      this.pitch = clamp(this.pitch - input.lookY, -1.45, 1.45);
      this.lookKick += input.lookX * 2 + input.lookY * 1.2;
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

    animateCharacter(this.rig, {
      speed: this.speed,
      grounded: this.grounded,
      aiming: this.aimT > 0.35,
      aimPitch: this.pitch + this.recoilPitch,
      crouch: this.crouching,
      dead: false,
    }, dt);

    const moving = this.grounded && this.speed > 0.5;
    this.bobWeight = damp(this.bobWeight, moving ? Math.min(this.speed / 5.4, 1.2) : 0, 6, dt);
    this.bob += dt * (6.4 + this.speed * 0.9);

    if (this.camera) this.syncCamera(dt);
    if (this.viewPivot) this.updateViewmodel(dt);
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

    if (this.viewFlash) {
      this.viewFlash.visible = this.flashTimer > 0;
      if (this.flashTimer > 0) this.viewFlash.scale.setScalar(0.8 + Math.random() * 0.5);
    }
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

      const hit = hitscan(origin, dir, def.range, ctx.fighters, this);

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

    if (this.isLocal) {
      this.onShot?.(def);
    }
  }
}
