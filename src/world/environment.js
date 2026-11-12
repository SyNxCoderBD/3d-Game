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
    elevation: 11,
    azimuth: 118,
    sunColor: 0xffb173,
    zenith: 0x2a5b96,
    horizon: 0xf0b784,
    ground: 0x6d7f86,
    ambientSky: 0x9db4c8,
    ambientGround: 0x3b3a2a,
    sunIntensity: 4.2,
    hemiIntensity: 1.10,
    fogDensity: 0.00105,
    exposure: 1.02,
  },
  {
    name: 'MIDDAY',
    elevation: 54,
    azimuth: 205,
    sunColor: 0xfff4e2,
    zenith: 0x2e6fc4,
    horizon: 0xc9dcf0,
    ground: 0x6f92a8,
    ambientSky: 0x9fc6ea,
    ambientGround: 0x3e4a34,
    sunIntensity: 4.8,
    hemiIntensity: 1.40,
    fogDensity: 0.00068,
    exposure: 1.0,
  },
  {
    name: 'DUSK',
    elevation: 5.5,
    azimuth: 292,
    sunColor: 0xff7a4d,
    zenith: 0x1b2f5e,
    horizon: 0xe98a63,
    ground: 0x4a4a58,
    ambientSky: 0x7f8bb0,
    ambientGround: 0x2c2a2c,
    sunIntensity: 3.1,
    hemiIntensity: 0.95,
    fogDensity: 0.00135,
    exposure: 1.08,
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
