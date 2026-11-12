import { createNoise2D, fbm, ridgeFbm } from '../util/noise.js';
import { smoothstep } from '../util/math.js';

export const WORLD = {
  size: 1700,          // terrain plane edge length
  segments: 392,       // terrain tessellation
  radius: 470,         // nominal island radius
  waterLevel: 0,
  far: 6000,
};

const nWarpA = createNoise2D(1337);
const nWarpB = createNoise2D(90210);
const nBase = createNoise2D(4242);
const nHills = createNoise2D(777);
const nRidge = createNoise2D(5150);
const nDetail = createNoise2D(2024);

/**
 * The single source of truth for the island shape.
 * Positive = land above sea level, negative = sea floor.
 */
export function terrainHeight(x, z) {
  // Domain warp so coastlines and ridges never look like noisy circles.
  const wx = x + 120 * nWarpA(x * 0.0013, z * 0.0013);
  const wz = z + 120 * nWarpB(x * 0.0013 + 41.7, z * 0.0013 - 18.3);

  const dist = Math.sqrt(wx * wx + wz * wz) / WORLD.radius;
  // Irregular coastline: distort the radial falloff with low frequency noise.
  const coast = dist * (2.0 + 0.55 * nWarpB(wx * 0.0022, wz * 0.0022)) * 0.5;

  const mask = 1 - smoothstep(0.46, 1.04, coast);

  const base = fbm(nBase, wx * 0.0021, wz * 0.0021, 5) * 0.5 + 0.5;
  const hills = fbm(nHills, wx * 0.0044 + 9.1, wz * 0.0044 - 3.7, 4) * 0.5 + 0.5;
  const ridge = ridgeFbm(nRidge, wx * 0.0017 - 6.2, wz * 0.0017 + 11.4, 4);

  const inland = 3.5 + 30 * base + 34 * hills * hills + 132 * Math.pow(ridge, 2.2) * mask;

  let h = inland * Math.pow(mask, 1.45) - (1 - mask) * 30;

  // Beach shelf: flatten the band just above the waterline.
  const shelf = smoothstep(9, 1.2, h);
  h -= shelf * 0.55;

  // Fine surface relief.
  h += 1.15 * fbm(nDetail, x * 0.028, z * 0.028, 3);
  h += 3.2 * fbm(nDetail, x * 0.006 + 3.3, z * 0.006 - 9.9, 3) * smoothstep(0, 12, h);

  return h;
}

const _n = { x: 0, y: 1, z: 0 };

/** Approximate surface normal of the height field (cheap finite difference). */
export function terrainNormal(x, z, eps = 1.0, out = _n) {
  const hL = terrainHeight(x - eps, z);
  const hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps);
  const hU = terrainHeight(x, z + eps);
  out.x = hL - hR;
  out.y = 2 * eps;
  out.z = hD - hU;
  const len = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= len; out.y /= len; out.z /= len;
  return out;
}

/** 0 = flat, 1 = vertical cliff. */
export function terrainSlope(x, z) {
  const n = terrainNormal(x, z, 1.5);
  return 1 - n.y;
}

export const isWater = (x, z) => terrainHeight(x, z) < WORLD.waterLevel;
