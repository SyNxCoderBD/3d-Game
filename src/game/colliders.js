/**
 * Static world collision.
 *
 * Trees (and the biggest rocks) are vertical cylinders. They need to do three
 * jobs:
 *
 *   1. stop the player and bots walking through them,
 *   2. stop bullets — this is what makes a tree usable as cover,
 *   3. block line of sight so bots cannot see or shoot through a trunk.
 *
 * With a few thousand trunks a linear scan per bullet is wasteful, so the
 * colliders live in a uniform XZ grid. Queries gather the handful of cells
 * they touch instead of walking the whole list.
 */

const CELL = 24;

export class WorldColliders {
  constructor(items = [], cell = CELL) {
    this.cell = cell;
    this.items = items;
    this.grid = new Map();
    this.empty = items.length === 0;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const minX = Math.floor((it.x - it.r) / cell);
      const maxX = Math.floor((it.x + it.r) / cell);
      const minZ = Math.floor((it.z - it.r) / cell);
      const maxZ = Math.floor((it.z + it.r) / cell);
      for (let cz = minZ; cz <= maxZ; cz++) {
        for (let cx = minX; cx <= maxX; cx++) {
          const key = cx + ',' + cz;
          let arr = this.grid.get(key);
          if (!arr) this.grid.set(key, arr = []);
          arr.push(i);
        }
      }
    }
  }

  _gather(x, z, r) {
    const out = [];
    const minX = Math.floor((x - r) / this.cell);
    const maxX = Math.floor((x + r) / this.cell);
    const minZ = Math.floor((z - r) / this.cell);
    const maxZ = Math.floor((z + r) / this.cell);
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const arr = this.grid.get(cx + ',' + cz);
        if (arr) for (const idx of arr) out.push(this.items[idx]);
      }
    }
    return out;
  }

  /**
   * Push a point out of every overlapping cylinder.
   * `pos` is a Vector3 (x/y/z); only x/z are modified. Returns the number of
   * colliders that were resolved, so callers can damp velocity.
   */
  pushOut(pos, radius = 0.3) {
    if (this.empty) return 0;
    const near = this._gather(pos.x, pos.z, radius + 1.2);
    let hits = 0;
    // Two passes so wedges between two trunks settle instead of oscillating.
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const it of near) {
        if (pos.y > it.y1 || pos.y + 1.7 < it.y0) continue;   // above / below it
        const dx = pos.x - it.x;
        const dz = pos.z - it.z;
        const rr = it.r + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 0.0001;
        const push = rr - d;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
        hits++;
        moved = true;
      }
      if (!moved) break;
    }
    return hits;
  }

  /**
   * Nearest collider hit along a ray, or Infinity.
   * Returns { t, item }.
   */
  raycast(origin, dir, maxDist) {
    if (this.empty) return { t: Infinity, item: null };

    // Vertical rays cannot hit a vertical cylinder.
    const a = dir.x * dir.x + dir.z * dir.z;
    if (a < 1e-8) return { t: Infinity, item: null };

    // Walk the ray cell by cell (Amanatides & Woo) so no trunk is ever
    // skipped, whatever the angle.
    let cx = Math.floor(origin.x / this.cell);
    let cz = Math.floor(origin.z / this.cell);

    const stepX = dir.x > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const invX = Math.abs(dir.x) > 1e-9 ? 1 / Math.abs(dir.x) : Infinity;
    const invZ = Math.abs(dir.z) > 1e-9 ? 1 / Math.abs(dir.z) : Infinity;

    const boundX = dir.x > 0 ? (cx + 1) * this.cell : cx * this.cell;
    const boundZ = dir.z > 0 ? (cz + 1) * this.cell : cz * this.cell;
    let tMaxX = Math.abs(dir.x) > 1e-9 ? (boundX - origin.x) * invX : Infinity;
    let tMaxZ = Math.abs(dir.z) > 1e-9 ? (boundZ - origin.z) * invZ : Infinity;
    const tDeltaX = this.cell * invX;
    const tDeltaZ = this.cell * invZ;

    let bestT = Infinity;
    let bestItem = null;
    const tested = new Set();

    for (let guard = 0; guard < 1024; guard++) {
      const key = cx + ',' + cz;
      if (!tested.has(key)) {
        tested.add(key);
        const arr = this.grid.get(key);
        if (arr) {
          for (const idx of arr) {
            const it = this.items[idx];
            const ox = origin.x - it.x;
            const oz = origin.z - it.z;
            const b = 2 * (ox * dir.x + oz * dir.z);
            const c = ox * ox + oz * oz - it.r * it.r;
            const disc = b * b - 4 * a * c;
            if (disc < 0) continue;
            const sq = Math.sqrt(disc);
            let th = (-b - sq) / (2 * a);
            if (th <= 0) th = (-b + sq) / (2 * a);   // origin inside the trunk
            if (th <= 0 || th >= bestT || th > maxDist) continue;
            const y = origin.y + dir.y * th;
            if (y < it.y0 || y > it.y1) continue;
            bestT = th;
            bestItem = it;
          }
        }
      }

      const tNext = Math.min(tMaxX, tMaxZ);
      // Nothing left inside range, or we already passed a hit.
      if (!(tNext <= maxDist) || bestT <= tNext) break;
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
    }

    return { t: bestT, item: bestItem };
  }

  /** True when the straight line between two points is blocked. */
  blockedBetween(from, to, margin = 0.35) {
    if (this.empty) return false;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return false;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = this.raycast(from, dir, len - margin);
    return hit.t < len - margin;
  }
}
