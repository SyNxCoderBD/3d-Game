import { createNoise2D, fbm } from '../util/noise.js';
import { smoothstep } from '../util/math.js';

export const WORLD = {
  size: 1500,          // terrain plane edge length
  segments: 384,       // terrain tessellation (~3.6 m quads)
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
 *
 * Built the way real landforms read:
 *   - one broad, low-frequency landmass (no high-octave ridging),
 *   - a single mountain range from a *softened* ridge field, so crests are
 *     rounded shoulders instead of needles,
 *   - gentle multi-scale relief on top (a couple of metres at most),
 *   - a shallow coastal shelf and a beach that flattens at the waterline.
 */
export function terrainHeight(x, z) {
  // Domain warp: keeps coastlines and ridge lines from looking like circles.
  const wx = x + 170 * nWarpA(x * 0.0008, z * 0.0008);
  const wz = z + 170 * nWarpB(x * 0.0008 + 41.7, z * 0.0008 - 18.3);

  const dist = Math.sqrt(wx * wx + wz * wz) / WORLD.radius;
  const coast = dist * (2.0 + 0.45 * nWarpB(wx * 0.0018, wz * 0.0018)) * 0.5;
  const mask = 1 - smoothstep(0.42, 1.28, coast);

  // Broad landmass and rolling foothills (low frequency, gentle gradients).
  const base = fbm(nBase, wx * 0.0012, wz * 0.0012, 3) * 0.5 + 0.5;
  const hills = fbm(nHills, wx * 0.0034, wz * 0.0034, 3) * 0.5 + 0.5;

  // One massif, described by a very smooth field so its flanks stay walkable.
  const massif = smoothstep(0.38, 0.82, fbm(nRidge, wx * 0.00075, wz * 0.00075, 2) * 0.5 + 0.5);

  // Spurs and crags ride on top of the massif at long wavelengths and with
  // bounded amplitude: this is what gives a mountain its shape without ever
  // producing a needle-thin peak.
  const spurs = fbm(nHills, wx * 0.0023 + 71.3, wz * 0.0023 - 12.9, 2) - 0.5;
  const crags = fbm(nDetail, wx * 0.0060 - 5.1, wz * 0.0060 + 3.7, 2) - 0.5;

  // Mountains stay inland: they fade out well before the coastline so the
  // shore is a gentle shelf instead of a wall.
  const mountainMask = Math.pow(mask, 2.4);

  let inland = 3.5
    + 20 * base
    + 16 * hills * hills
    + 106 * massif * mountainMask
    + 26 * spurs * massif * mountainMask
    + 7 * crags * massif * mountainMask;

  let h = inland * Math.pow(mask, 1.12) - (1 - mask) * 34;

  // Beach: flatten the band just above the waterline so shores are walkable.
  h -= smoothstep(6.5, 1.0, h) * 0.9;

  // Gentle relief: a few metres of undulation, never spikes.
  h += 2.2 * fbm(nDetail, x * 0.0040, z * 0.0040, 2) * smoothstep(-2, 10, h);
  h += 0.8 * fbm(nDetail, x * 0.016 + 5.1, z * 0.016 - 3.3, 2) * smoothstep(0, 6, h);
  h += 0.18 * fbm(nDetail, x * 0.060 - 1.7, z * 0.060 + 8.4, 2) * smoothstep(2, 8, h);
  // Soft sand ripples below the waterline.
  h += 0.45 * fbm(nDetail, x * 0.05 - 7.7, z * 0.05 + 2.2, 2) * smoothstep(0, -6, h);

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
