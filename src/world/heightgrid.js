/**
 * A copy of the terrain mesh heights on its regular vertex grid.
 *
 * Anything that needs to sit exactly on the *rendered* surface (grass, props)
 * samples this instead of calling the analytic height function again: it is
 * bilinear-interpolated from the same triangles the player sees, so nothing
 * floats or sinks, and a lookup costs a few arithmetic ops instead of ~30
 * noise evaluations.
 */
export const heightGrid = {
  res: 0,        // vertices per side
  step: 1,       // metres between vertices
  half: 0,
  data: null,
};

export function setHeightGrid(res, size, data) {
  heightGrid.res = res;
  heightGrid.step = size / (res - 1);
  heightGrid.half = size * 0.5;
  heightGrid.data = data;
}

export function sampleHeight(x, z) {
  const g = heightGrid;
  if (!g.data) return 0;

  const row = g.res;
  let fx = (x + g.half) / g.step;
  let fz = (z + g.half) / g.step;

  if (fx < 0) fx = 0; else if (fx > row - 1.001) fx = row - 1.001;
  if (fz < 0) fz = 0; else if (fz > row - 1.001) fz = row - 1.001;

  const ix = fx | 0;
  const iz = fz | 0;
  const tx = fx - ix;
  const tz = fz - iz;

  const i0 = iz * row + ix;
  const d = g.data;
  const h00 = d[i0];
  const h10 = d[i0 + 1];
  const h01 = d[i0 + row];
  const h11 = d[i0 + row + 1];

  const a = h00 + (h10 - h00) * tx;
  const b = h01 + (h11 - h01) * tx;
  return a + (b - a) * tz;
}

/** Slope (0 flat .. 1 vertical) from the grid, cheap. */
export function sampleSlope(x, z) {
  const e = heightGrid.step;
  const hx = sampleHeight(x + e, z) - sampleHeight(x - e, z);
  const hz = sampleHeight(x, z + e) - sampleHeight(x, z - e);
  return 1 - (2 * e) / Math.hypot(hx, 2 * e, hz);
}
