import { WORLD, terrainHeight, terrainSlope } from '../world/heightfield.js';
import { heightGrid, sampleHeight, sampleSlope } from '../world/heightgrid.js';

// Prefer the rendered mesh surface; fall back to the analytic field if the
// terrain has not been built yet (e.g. tools running out of order).
const groundAt = (x, z) => (heightGrid.res ? sampleHeight(x, z) : terrainHeight(x, z));
const slopeAt = (x, z) => (heightGrid.res ? sampleSlope(x, z) : terrainSlope(x, z));

/** Scatter spawn points over flat, dry ground, spread across the island. */
export function buildSpawnPoints(count = 14) {
  const points = [];
  let tries = 0;
  const target = count;

  while (points.length < target && tries < 20000) {
    tries++;
    const a = Math.random() * Math.PI * 2;
    const r = 40 + Math.sqrt(Math.random()) * (WORLD.radius * 0.72);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = groundAt(x, z);
    if (h < 6 || h > 70) continue;
    if (slopeAt(x, z) > 0.22) continue;

    let tooClose = false;
    for (const p of points) {
      if (Math.hypot(p.position.x - x, p.position.z - z) < 55) { tooClose = true; break; }
    }
    if (tooClose) continue;

    points.push({
      position: { x, y: h, z },
      yaw: Math.atan2(-x, -z) + (Math.random() - 0.5) * 1.2,
    });
  }

  if (!points.length) {
    points.push({ position: { x: 0, y: groundAt(0, 0), z: 0 }, yaw: 0 });
  }
  return points;
}

/** Ground positions for pickups: flat, dry, away from the very edge. */
export function buildPickupSpots(count = 26) {
  const spots = [];
  let tries = 0;
  while (spots.length < count && tries < 30000) {
    tries++;
    const a = Math.random() * Math.PI * 2;
    const r = 25 + Math.sqrt(Math.random()) * (WORLD.radius * 0.75);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = groundAt(x, z);
    if (h < 4 || h > 72) continue;
    if (slopeAt(x, z) > 0.28) continue;

    let tooClose = false;
    for (const s of spots) {
      if (Math.hypot(s.x - x, s.z - z) < 26) { tooClose = true; break; }
    }
    if (tooClose) continue;
    spots.push({ x, y: h, z });
  }
  return spots;
}
