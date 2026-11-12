# AETHERIS — Island Warfare

A split-screen FPS deathmatch on a procedurally sculpted island. Player 1 uses
keyboard + mouse, Player 2 uses a controller, and you can see each other's
position on the minimap and through the on-screen enemy tracker. Loot rifles,
SMGs, shotguns, sniper rifles, armour and med kits scattered across the island.
Or drop in solo against AI squads in bot practice.

It ships as **one portable Windows executable**.

```
release/Aetheris.exe      ← double-click. That's it. (~0.7 MB)
release/Aetheris.html     ← same build, opens in any browser
```

Everything below the menus was built from scratch: the island, the soldiers,
the guns, the hit detection, and every gunshot you hear.

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

## Modes

* **1P · Bot Practice** — you against 2–8 AI soldiers. Bots patrol the island,
  take line-of-sight shots, circle-strafe, heal themselves, loot, and swap to
  the right gun for the range they're fighting at. The run ends when you do.
* **2P · Split Screen Duel** — Player 1 (keyboard + mouse) versus Player 2
  (controller, or IJKL + arrows if no pad is connected). Pick a score limit of
  10, 15, 20 or 30 and go; there is also an 8-minute clock, and if time runs out
  the scoreboard leader takes the match. Each half of the screen has its own
  camera, HUD, minimap, enemy tracker and damage direction.

## Controls

**Player 1 — keyboard + mouse**

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| `Mouse` | Look |
| `LMB` / `RMB` | Fire / aim down sights |
| `R` | Reload |
| `Shift` / `Space` / `Ctrl` | Sprint / jump / crouch |
| `Q` | Use med kit |
| `Tab` or `F` | Swap weapon |
| `Esc` | Pause (releases the mouse) |
| `T` / `M` | Time of day / mute |

**Player 2 — controller**

| Input | Action |
| --- | --- |
| Left stick / right stick | Move / look |
| `RT` / `LT` | Fire / aim down sights |
| `A` | Jump |
| `X` / `Y` / `B` | Reload / med kit / swap weapon |
| `LB` / `R3` | Sprint / crouch |
| `D-pad ← →` | Weapon slot 1 / 2 |

Rumble fires on shots, hits and death (toggle it in the pause menu). Aim assist
gives pad players a gentle pull toward visible enemies — it never snaps.

**Player 2 — no controller? keyboard fallback**

| Input | Action |
| --- | --- |
| `I J K L` | Move |
| `Arrow keys` | Look |
| `Enter` / `Right Shift` | Fire / aim |
| `'` | Jump |
| `\` / `Right Ctrl` | Sprint / crouch |
| `,` / `.` / `/` | Med kit / reload / swap weapon |

If a browser refuses pointer lock, the game falls back to **hold left mouse and
drag** to look.

## Weapons & loot

| Weapon | Damage | Fire rate | Magazine | Notes |
| --- | --- | --- | --- | --- |
| P-9 Sidearm | 23 | 420 rpm | 12 | semi-auto starter |
| VK-9 SMG | 16 | 900 rpm | 32 | spray, low recoil |
| AR-15 Rifle | 27 | 620 rpm | 30 | all-round |
| M870 Breacher | 12 × 9 | 75 rpm | 6 | devastating up close |
| AWM .338 | 88 | 48 rpm | 5 | 2.6× headshot, 26° scope |

Headshots multiply damage (1.6×–2.6×), damage falls off with range and every
fighter starts with spawn protection. Loot on the ground: weapons, ammo boxes,
med kits (+1 kit, heals 55 HP) and body armour (absorbs 55 % of incoming damage).
You carry three weapon slots (primary + sidearm + looted gun); `1 2 3` selects
one directly. When a fighter dies, the gun in their hands drops on the ground —
kill someone with a sniper and you can take it.

The AWM's scope is a real magnified lens: the 3D view is re-rendered at 2.7×
zoom through a circular scissor region, with black outside the lens, mildots
and reduced look sensitivity while zoomed.

If a browser refuses pointer lock (some locked-down machines do), the game
falls back automatically: **hold the left mouse button and drag** to look.

---

## How the combat works

* **Hitscan** bullets: analytic ray/sphere test for heads, ray/box for bodies,
  plus a marched terrain test so hills and cliffs actually block shots.
* **Character models** — hand-built rigged soldiers (rounded volumes, helmet,
  plate carrier, pouches, backpack, colour-coded arm patches) with a walk
  cycle, shouldered aim pose and a fall-over death animation.
* **Weapons** — modelled from 20–31 primitives each (receiver, handguard with
  rail slots, barrel, muzzle brake, optic with emissive glass, curved magazine,
  stock, grip, charging handle). Merged per material so a gun costs 4–5 draw
  calls instead of 30.
* **Feedback** — muzzle flash, tracer streaks, impact sparks, blood puffs,
  recoil kick, animated hit markers, kill feed, damage-direction chevrons,
  streaks ("RAMPAGE" at 5 kills) and a reload ring around the crosshair.
* **Audio** — every weapon has its own synthesised report (noise crack through
  a bandpass + pitched body thump + a delayed tail for big calibers), plus
  reload clicks, hit confirmations, damage, death, loot pickups and match
  stings. Distant gunfire is distance-attenuated and stereo-panned against the
  nearest split-screen camera, so you can hear which shoulder it came from.
* **Match flow** — score/time limits, live clock, per-fighter K/D/accuracy/
  damage/headshot/best-streak stats, and an end-of-match scoreboard with
  rematch.

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
the whole game fits in roughly 630 KB of executable payload.

## Development

```bash
npm install
npm run dev            # http://localhost:5173 (live preview)
npm run build:exe      # → release/Aetheris.exe + release/Aetheris.html
npm run verify         # headless world build smoke test (no GPU needed)
npm run verify:game    # headless combat/AI/pickup/match/audio simulation test
npm run verify:e2e     # runs the real bundle in a stub DOM: menu → match → pause
                       # → split screen → scoreboard → rematch
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
src/game/fighter.js     player/bot entity: physics, weapons, damage, models
src/game/character.js   procedural rigged soldier + animation
src/game/weapons.js     weapon stats + procedural gun models
src/game/combat.js      hitscan, damage, tracers/sparks/blood
src/game/ai.js          bot brains (patrol, engage, strafe, heal)
src/game/pickups.js     loot spawns, models and collection
src/game/input.js       keyboard/mouse, gamepad + P2 keyboard fallback
src/game/match.js       score/time limits, stats, streaks, standings
src/game/spawns.js      spawn & loot placement
src/ui/hud.js           per-player HUD, minimap, enemy tracker
src/audio/ambience.js   procedural wind + drone
src/audio/sfx.js        procedural guns, reloads, hits, match stings
launcher/launcher.c     Win32 launcher (no dependencies)
tools/build-exe.mjs     single-file packager
```
