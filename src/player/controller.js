import * as THREE from 'three';
import { WORLD, terrainHeight } from '../world/heightfield.js';
import { clamp, damp } from '../util/math.js';

const EYE_HEIGHT = 1.66;
const GRAVITY = -25;
const WALK = 5.0;
const SPRINT = 10.5;
const SWIM = 3.2;

export class Player {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;

    camera.rotation.order = 'YXZ';

    this.position = new THREE.Vector3(0, 80, 0); // feet position
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.05;

    this.keys = new Set();
    this.grounded = false;
    this.swimming = false;
    this.underwater = false;

    this.bobPhase = 0;
    this.bobWeight = 0;
    this.roll = 0;

    this.fovBase = 73;
    this.fov = 73;

    this.locked = false;
    this.dragLook = false;
    this.pointerDown = false;
    this.sensitivity = 0.0021;

    this.onLockChange = null;
    this.onFallback = null;

    this._bind();
  }

  get eyePosition() {
    return new THREE.Vector3(
      this.position.x,
      this.position.y + EYE_HEIGHT,
      this.position.z
    );
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.onLockChange) this.onLockChange(this.locked);
    });

    document.addEventListener('pointerlockerror', () => {
      // Some contexts (e.g. file:// on certain builds) refuse pointer lock.
      this.dragLook = true;
      if (this.onFallback) this.onFallback();
    });

    this.dom.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.pointerDown = true;
    });
    window.addEventListener('mouseup', () => { this.pointerDown = false; });

    document.addEventListener('mousemove', (e) => {
      const active = this.locked || (this.dragLook && this.pointerDown);
      if (!active) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    });
  }

  requestLock() {
    const el = this.dom;
    try {
      const p = el.requestPointerLock?.({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try {
            el.requestPointerLock();
          } catch (_) {
            this.dragLook = true;
            if (this.onFallback) this.onFallback();
          }
        });
      }
    } catch (_) {
      this.dragLook = true;
      if (this.onFallback) this.onFallback();
    }
  }

  spawnAt(x, z, yaw = 0) {
    const h = terrainHeight(x, z);
    this.position.set(x, Math.max(h, WORLD.waterLevel) + 0.1, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = -0.03;
    this.syncCamera(0);
  }

  syncCamera() {
    this.camera.position.set(
      this.position.x,
      this.position.y + EYE_HEIGHT + Math.sin(this.bobPhase) * 0.035 * this.bobWeight,
      this.position.z
    );
    this.camera.rotation.set(
      this.pitch,
      this.yaw,
      Math.sin(this.bobPhase * 0.5) * 0.012 * this.bobWeight + this.roll,
      'YXZ'
    );
  }

  update(dt) {
    const k = this.keys;
    const forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const sprinting = (k.has('ShiftLeft') || k.has('ShiftRight')) && forward > 0;

    const groundY = terrainHeight(this.position.x, this.position.z);
    this.swimming = groundY < WORLD.waterLevel - 1.1 && this.position.y < WORLD.waterLevel + 0.9;

    let targetSpeed = this.swimming ? SWIM : sprinting ? SPRINT : WALK;
    if (k.has('ControlLeft') && !this.swimming) targetSpeed *= 0.45;

    // Direction from yaw only (walking, not flying).
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const dirX = -sinY * forward + cosY * strafe;
    const dirZ = -cosY * forward - sinY * strafe;
    const len = Math.hypot(dirX, dirZ);
    const normX = len > 0 ? dirX / len : 0;
    const normZ = len > 0 ? dirZ / len : 0;
    const wantsMove = len > 0.001;

    const accel = this.grounded ? 13 : this.swimming ? 6 : 3.2;
    const targetVX = normX * targetSpeed * (wantsMove ? 1 : 0);
    const targetVZ = normZ * targetSpeed * (wantsMove ? 1 : 0);

    this.velocity.x = damp(this.velocity.x, targetVX, accel, dt);
    this.velocity.z = damp(this.velocity.z, targetVZ, accel, dt);

    // Vertical motion
    if (this.swimming) {
      const surface = WORLD.waterLevel + 0.45;
      const up = k.has('Space') ? 1 : 0;
      const down = k.has('ControlLeft') ? 1 : 0;
      const desiredY = surface + up * 0.9 - down * 1.2;
      this.velocity.y = damp(this.velocity.y, (desiredY - this.position.y) * 3.2, 6, dt);
      this.position.y += this.velocity.y * dt;
      this.grounded = false;
    } else {
      this.velocity.y += GRAVITY * dt;
      if (this.grounded && k.has('Space')) {
        this.velocity.y = 7.4;
        this.grounded = false;
      }
      this.position.y += this.velocity.y * dt;
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // Keep the player inside the playable area.
    const limit = WORLD.size * 0.5 - 40;
    this.position.x = clamp(this.position.x, -limit, limit);
    this.position.z = clamp(this.position.z, -limit, limit);

    // Terrain collision
    if (!this.swimming) {
      const gy = terrainHeight(this.position.x, this.position.z);
      if (this.position.y <= gy) {
        this.position.y = gy;
        if (this.velocity.y < 0) this.velocity.y = 0;
        this.grounded = true;
      } else if (this.position.y > gy + 0.05) {
        this.grounded = false;
      }
    }

    // Head bob + FOV
    const speedNow = Math.hypot(this.velocity.x, this.velocity.z);
    const moving = this.grounded && speedNow > 0.6;
    this.bobWeight = damp(this.bobWeight, moving ? Math.min(speedNow / WALK, 1.35) : 0, 6, dt);
    this.bobPhase += dt * (6.4 + speedNow * 0.85);

    const targetFov = this.fovBase + (sprinting && moving ? 6.5 : 0) + (speedNow / SPRINT) * 1.5;
    this.fov = damp(this.fov, targetFov, 5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    this.syncCamera();
  }
}

/** Find a scenic, flat-ish ridge to start on. */
export function findSpawn() {
  let best = { x: 0, z: 0, score: -Infinity };
  const step = 18;
  for (let z = -WORLD.radius; z <= WORLD.radius; z += step) {
    for (let x = -WORLD.radius; x <= WORLD.radius; x += step) {
      const h = terrainHeight(x, z);
      if (h < 26 || h > 90) continue;
      const r = Math.hypot(x, z);
      if (r < 90 || r > 330) continue;
      const hx = terrainHeight(x + 6, z) - terrainHeight(x - 6, z);
      const hz = terrainHeight(x, z + 6) - terrainHeight(x, z - 6);
      const slope = Math.hypot(hx, hz) / 12;
      const score = h * 1.0 - slope * 120 - Math.abs(r - 210) * 0.06;
      if (score > best.score) best = { x, z, score };
    }
  }
  if (!isFinite(best.score)) best = { x: 0, z: 0 };
  return best;
}
