import * as THREE from 'three';
import { sampleHeight } from '../world/heightgrid.js';

/* ------------------------------------------------------------- hitscan */

const _v = new THREE.Vector3();

/** Ray vs axis-aligned box (slab method). Returns entry distance or -1. */
function rayBox(origin, dir, min, max) {
  let tmin = 0;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? origin.x : i === 1 ? origin.y : origin.z;
    const d = i === 0 ? dir.x : i === 1 ? dir.y : dir.z;
    const lo = i === 0 ? min.x : i === 1 ? min.y : min.z;
    const hi = i === 0 ? max.x : i === 1 ? max.y : max.z;
    if (Math.abs(d) < 1e-6) {
      if (o < lo || o > hi) return -1;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/** Ray vs sphere, returns distance or -1. */
function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  const t1 = -b + sq;
  if (t0 > 0.001) return t0;
  if (t1 > 0.001) return t1;
  return -1;
}

/**
 * Cast a bullet through the world.
 * Returns { distance, point, victim, headshot, hitTerrain }
 */
export function hitscan(origin, dir, maxDist, fighters, shooter) {
  let bestDist = maxDist;
  let bestVictim = null;
  let bestHead = false;

  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f === shooter || !f.alive) continue;

    // head sphere
    const headY = f.position.y + (f.crouching ? 1.18 : 1.62);
    _v.set(f.position.x, headY, f.position.z);
    const headD = raySphere(origin, dir, _v, 0.19);
    if (headD > 0 && headD < bestDist) {
      bestDist = headD;
      bestVictim = f;
      bestHead = true;
    }

    // body box
    const h = f.crouching ? 1.25 : 1.75;
    const min = {
      x: f.position.x - 0.28,
      y: f.position.y + 0.05,
      z: f.position.z - 0.28,
    };
    const max = {
      x: f.position.x + 0.28,
      y: f.position.y + h,
      z: f.position.z + 0.28,
    };
    const bodyD = rayBox(origin, dir, min, max);
    if (bodyD > 0 && bodyD < bestDist) {
      bestDist = bodyD;
      bestVictim = f;
      bestHead = false;
    }
  }

  // Terrain / water occlusion, marched in 2.5 m steps.
  let terrainD = -1;
  const step = 2.5;
  for (let t = step; t < Math.min(bestDist, maxDist); t += step) {
    const x = origin.x + dir.x * t;
    const y = origin.y + dir.y * t;
    const z = origin.z + dir.z * t;
    if (y < sampleHeight(x, z)) { terrainD = t; break; }
  }

  if (terrainD > 0 && terrainD < bestDist) {
    return {
      distance: terrainD,
      point: new THREE.Vector3(
        origin.x + dir.x * terrainD,
        origin.y + dir.y * terrainD,
        origin.z + dir.z * terrainD
      ),
      victim: null,
      headshot: false,
      hitTerrain: true,
    };
  }

  const d = bestVictim ? bestDist : Math.min(maxDist, terrainD > 0 ? terrainD : maxDist);
  return {
    distance: d,
    point: new THREE.Vector3(
      origin.x + dir.x * d,
      origin.y + dir.y * d,
      origin.z + dir.z * d
    ),
    victim: bestVictim,
    headshot: bestHead,
    hitTerrain: !bestVictim,
  };
}

/* ------------------------------------------------------------- effects */

const TRACER_GEO = new THREE.CylinderGeometry(0.016, 0.016, 1, 6, 1, true);
const SPARK_GEO = new THREE.SphereGeometry(0.028, 6, 5);
const BLOOD_GEO = new THREE.SphereGeometry(0.035, 6, 5);

export class Effects {
  constructor(scene) {
    this.scene = scene;

    this.tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd98a, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffc074, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.bloodMat = new THREE.MeshBasicMaterial({ color: 0x9c1d1d, transparent: true, opacity: 0.95, depthWrite: false });

    this.pool = [];
    this.bits = [];

    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(TRACER_GEO, this.tracerMat.clone());
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 5;
      scene.add(m);
      this.pool.push({ mesh: m, life: 0, maxLife: 0.075 });
    }

    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(SPARK_GEO, this.bloodMat.clone());
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.bits.push({
        mesh: m,
        life: 0,
        maxLife: 0.5,
        vel: new THREE.Vector3(),
        kind: 'spark',
      });
    }
    this.tracerIdx = 0;
    this.bitIdx = 0;
  }

  tracer(from, to, color = 0xffd98a) {
    const item = this.pool[this.tracerIdx++ % this.pool.length];
    const mesh = item.mesh;
    const dist = from.distanceTo(to);
    if (dist < 0.05) return;

    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.scale.set(1, dist, 1);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      _v.copy(to).sub(from).normalize()
    );
    mesh.material.color.setHex(color);
    mesh.material.opacity = 0.9;
    mesh.visible = true;
    item.life = item.maxLife;
    item.thickness = 1;
  }

  impact(point, normal, kind = 'spark') {
    const n = kind === 'blood' ? 7 : 6;
    for (let i = 0; i < n; i++) {
      const item = this.bits[this.bitIdx++ % this.bits.length];
      const mesh = item.mesh;
      mesh.position.copy(point);
      const spread = kind === 'blood' ? 2.4 : 3.4;
      item.vel.set(
        (Math.random() - 0.5) * spread + normal.x * 1.6,
        Math.random() * spread * 0.8 + normal.y * 1.2,
        (Math.random() - 0.5) * spread + normal.z * 1.6
      );
      item.maxLife = kind === 'blood' ? 0.45 : 0.3;
      item.life = item.maxLife;
      item.kind = kind;
      const s = kind === 'blood' ? 0.9 + Math.random() * 0.8 : 0.5 + Math.random() * 0.7;
      mesh.scale.setScalar(s);
      mesh.material.color.setHex(kind === 'blood' ? 0x8f1a1a : 0xffb066);
      if (kind === 'blood') {
        mesh.geometry = BLOOD_GEO;
      } else {
        mesh.geometry = SPARK_GEO;
      }
      mesh.material.opacity = 1;
      mesh.visible = true;
    }
  }

  update(dt) {
    for (const item of this.pool) {
      if (item.life <= 0) continue;
      item.life -= dt;
      const t = Math.max(0, item.life / item.maxLife);
      item.mesh.material.opacity = 0.85 * t;
      item.mesh.scale.x = 0.35 + t * 0.9;
      item.mesh.scale.z = 0.35 + t * 0.9;
      if (item.life <= 0) item.mesh.visible = false;
    }

    for (const item of this.bits) {
      if (item.life <= 0) continue;
      item.life -= dt;
      item.vel.y -= 12 * dt;
      item.mesh.position.addScaledVector(item.vel, dt);
      item.mesh.material.opacity = Math.max(0, item.life / item.maxLife);
      if (item.life <= 0) item.mesh.visible = false;
    }
  }
}
