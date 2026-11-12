# AETHERIS — The Verdant Isle

A high-fidelity first-person island explorer. No enemies, no objectives, no
loading screens: just you, a procedurally sculpted island, and an ocean that
moves. It ships as **one portable Windows executable**.

```
release/Aetheris.exe      ← double-click. That's it. (~0.6 MB)
release/Aetheris.html     ← same build, opens in any browser
```

---

## Run it

1. Download `release/Aetheris.exe` anywhere (Desktop, USB stick, wherever).
2. Double-click it.

Nothing is installed and no admin rights are needed. On launch the exe unpacks
its embedded world into `%TEMP%\AetherisIsle` and opens it in a borderless
app-mode window using the Edge / Chrome engine that already ships with Windows.

> **SmartScreen:** the binary is unsigned, so Windows may show
> *"Windows protected your PC"* the first time. Click **More info → Run anyway**.
> Some antivirus tools also flag unsigned self-extracting launchers; the source
> for the launcher is `launcher/launcher.c` — it is ~230 lines and does nothing
> except unpack the HTML payload and start the browser.

Works on Windows 10 / 11. Microsoft Edge is required (it is preinstalled on
both); Chrome, Brave and Vivaldi are also detected.

## Controls

| Key | Action |
| --- | --- |
| `W A S D` | Walk |
| `Shift` | Sprint |
| `Space` | Jump / swim up |
| `Ctrl` | Slow walk / swim down |
| `Mouse` | Look |
| `T` | Cycle time of day (Golden Hour → Midday → Dusk) |
| `M` | Mute / unmute ambience |
| `H` | Hide HUD |
| `P` | Save a screenshot (PNG) |
| `R` | Return to camp |
| `Esc` | Pause / release the mouse |

If a browser refuses pointer lock (some locked-down machines do), the game
falls back automatically: **hold the left mouse button and drag** to look.

---

## What is in the world

* **Terrain** — one analytic height field evaluated identically by the mesh,
  the player collision and every prop, so nothing floats or sinks. Landforms are
  built the way real ones read: a broad landmass, a single low-frequency massif
  with soft-shouldered ridges, spurs and crags at long wavelength with bounded
  amplitude, and mountains that fade out before the coast (no needle peaks, no
  vertical walls — the steepest ground is ~54°, and only ~13% of land is over
  40°). 148k vertices, vertex-coloured by biome/altitude/slope with baked
  concavity AO, plus per-pixel relief normals and crevice shading so the ground
  has surface texture instead of reading as smooth clay.
* **Ocean** — custom shader: analytic wave normals with per-band distance
  fade (no moiré on the open sea), Fresnel sky reflection, sun glitter,
  depth-tinted water body and shore foam from a height map of the sea floor.
* **Sky** — analytic atmosphere (horizon→zenith gradient, sun glow, sun disc)
  plus an animated multiple-octave cloud deck, shared by every shader that
  needs to reflect it.
* **Foliage** — a world-locked grass meadow that follows the player (12.5k
  instanced clumps in a 100 m field, ~0.8 clumps/m², updated one row/column at
  a time as you walk), 860 instanced trees in five procedural variants with
  layered canopies, 460 rocks, 1 100 bushes and drifting pollen motes.
* **Lighting** — cascaded-by-hand directional sun with 2048² PCF-soft shadows
  that follow the viewer, hemisphere ambient, ACES tone mapping.
* **Post** — MSAA 4× HDR pipeline → Unreal bloom → chromatic aberration +
  vignette + film grain grade → output pass.
* **Audio** — procedural wind (filtered brown noise with gust LFOs) and a low
  sea drone, synthesised at runtime with WebAudio. No audio files at all.
* **Adaptive quality** — if the frame rate drops under ~42 fps the renderer
  steps down resolution, then shadows, then bloom.

Everything — geometry, textures, sound — is generated at runtime, which is why
the whole game fits in 533 KB of executable payload.

## Development

```bash
npm install
npm run dev            # http://localhost:5173 (live preview)
npm run build:exe      # → release/Aetheris.exe + release/Aetheris.html
npm run verify         # headless world build smoke test (no GPU needed)
npm run verify:shaders # GLSL syntax check for every shader source
```

### How the portable exe is made

1. `vite build` produces one ES bundle.
2. `tools/build-exe.mjs` inlines the JS and CSS into a single `index.html`
   (no `import`, no `fetch`, so it runs from `file://`).
3. `launcher/launcher.c` is cross-compiled to `x86_64-windows-gnu` with Zig —
   a GUI-subsystem Win32 binary with no runtime dependencies.
4. The HTML is appended to the stub plus a 24-byte trailer
   (`"AETHERIS-PAYLOAD"` + payload length). The launcher reads its own file,
   finds the trailer, and extracts the payload on startup.

Requires Zig for the cross-compile (`pip install ziglang --target /tmp/zigpkg`
or set `ZIG=/path/to/zig`). The web build alone needs nothing but Node.

## Layout

```
index.html              shell + HUD + menus
src/main.js             bootstrap, loop, UI, quality scaling
src/world/heightfield.js  the island function (single source of truth)
src/world/terrain.js    mesh + vertex palette + material detail injection
src/world/water.js      ocean shader
src/world/sky.js        sky dome + clouds
src/world/vegetation.js instanced trees, rocks, bushes, grass
src/world/particles.js  drifting motes
src/world/environment.js shared uniforms + time-of-day presets
src/player/controller.js FPS controller (walk, sprint, jump, swim, bob)
src/fx/postprocessing.js bloom + grade passes
src/audio/ambience.js   procedural wind + drone
launcher/launcher.c     Win32 launcher (no dependencies)
tools/build-exe.mjs     single-file packager
```
