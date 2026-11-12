import * as THREE from 'three';

/**
 * Shared uniform objects. Because several materials (sky, ocean, grass, props)
 * reference the very same `{ value }` objects, a single write updates the whole
 * world — no per-material bookkeeping.
 */
export const U = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.42, 0.55, 0.22).normalize() },
  uSunColor: { value: new THREE.Color(1.0, 0.93, 0.82) },
  uSkyZenith: { value: new THREE.Color(0x2f6bb5) },
  uSkyHorizon: { value: new THREE.Color(0xbcd7f0) },
  uSkyGround: { value: new THREE.Color(0x5d7f96) },
  uFogColor: { value: new THREE.Color(0xbcd7f0) },
  uFogDensity: { value: 0.00085 },
  uAmbientSky: { value: new THREE.Color(0x8fb4d8) },
  uAmbientGround: { value: new THREE.Color(0x31402c) },
  uSunIntensity: { value: 4.2 },
  uAmbientIntensity: { value: 1.15 },
};

export const PRESETS = [
  {
    name: 'GOLDEN HOUR',
    elevation: 19,
    azimuth: 118,
    sunColor: 0xffbb82,
    zenith: 0x2461a8,
    horizon: 0xf2bb8a,
    ground: 0x63788a,
    ambientSky: 0x9ab6d4,
    ambientGround: 0x3a4028,
    sunIntensity: 5.2,
    hemiIntensity: 0.95,
    fogDensity: 0.00072,
    exposure: 1.05,
  },
  {
    name: 'MIDDAY',
    elevation: 52,
    azimuth: 205,
    sunColor: 0xfff6e8,
    zenith: 0x1f63c4,
    horizon: 0xcfe3f5,
    ground: 0x6f92a8,
    ambientSky: 0xa8cdf0,
    ambientGround: 0x40492f,
    sunIntensity: 5.6,
    hemiIntensity: 1.15,
    fogDensity: 0.0006,
    exposure: 1.0,
  },
  {
    name: 'DUSK',
    elevation: 6,
    azimuth: 292,
    sunColor: 0xff7a4a,
    zenith: 0x14264f,
    horizon: 0xe8875c,
    ground: 0x45485a,
    ambientSky: 0x7b87ad,
    ambientGround: 0x2a2830,
    sunIntensity: 4.0,
    hemiIntensity: 0.85,
    fogDensity: 0.0011,
    exposure: 1.1,
  },
];

export const envState = { presetIndex: 0, preset: PRESETS[0] };

const _sun = new THREE.Vector3();

export function applyPreset(index) {
  const p = PRESETS[index % PRESETS.length];
  envState.presetIndex = index % PRESETS.length;
  envState.preset = p;

  const el = THREE.MathUtils.degToRad(p.elevation);
  const az = THREE.MathUtils.degToRad(p.azimuth);
  _sun.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  U.uSunDir.value.copy(_sun);

  U.uSunColor.value.setHex(p.sunColor, THREE.SRGBColorSpace).multiplyScalar(1.0);
  U.uSkyZenith.value.setHex(p.zenith, THREE.SRGBColorSpace);
  U.uSkyHorizon.value.setHex(p.horizon, THREE.SRGBColorSpace);
  U.uSkyGround.value.setHex(p.ground, THREE.SRGBColorSpace);
  U.uFogColor.value.setHex(p.horizon, THREE.SRGBColorSpace);
  U.uFogDensity.value = p.fogDensity;
  U.uAmbientSky.value.setHex(p.ambientSky, THREE.SRGBColorSpace);
  U.uAmbientGround.value.setHex(p.ambientGround, THREE.SRGBColorSpace);
  U.uSunIntensity.value = p.sunIntensity;
  U.uAmbientIntensity.value = p.hemiIntensity;

  return p;
}
