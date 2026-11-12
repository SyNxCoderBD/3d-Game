# AETHERIS — Island Warfare

A split-screen FPS deathmatch on a procedurally sculpted island. Player 1 uses
keyboard + mouse, Player 2 uses a controller, and you can see each other's
position on the minimap and through the on-screen enemy tracker. Loot rifles,
SMGs, shotguns, sniper rifles, armour and med kits scattered across the island.
Or drop in solo against AI squads in bot practice.

It ships as **one self-contained web page**.

```
release/Aetheris-web-1.6.0.zip   ← unzip, serve index.html as a static site
release/Aetheris.html            ← the same file, opens in any browser
```

There is no install, no runtime, no server-side code and no API key. The zip
holds a single `index.html` with the game, its styles and its code inlined.

Everything below the menus was built from scratch: the island, the soldiers,
the guns, the hit detection, and every gunshot you hear.

---

## Run it

**Play locally.** Open `release/Aetheris.html` in a browser. Single-player,
split-screen and bot practice all work straight from disk.

**Play with someone else.** Online rooms need a real `http://` origin — a
`file://` page has an opaque origin and the browser blocks the cross-origin
calls. Serve the folder and share the address:

```bash
npm run build:web
cd release/aetheris-web-1.6.0 && python3 -m http.server 8080
```

**Put it online.** Unzip `release/Aetheris-web-<version>.zip` and deploy
`index.html` to any static host — Netlify, Vercel, GitHub Pages, Cloudflare
Pages, S3, nginx. There is nothing to configure; the folder is the whole site.
The zip's `README.txt` repeats these steps for whoever deploys it.

The build you are running is printed in the main menu, next to a **Change log**
button that lists every published release.

Runs in any modern browser with WebGL2: Chrome, Edge, Firefox or Safari. On a
deployed copy the game plays the version it was deployed as — the self-updater
belongs to the old Windows launcher, which is no longer part of this project.

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

## Changelog

### 1.6.0 — the game is a website now
- **The Windows executable is gone.** It was a launcher wrapped around the same
  web build, and every problem that survived into this release was a launcher
  problem: a server that stopped too early, a browser that refused to connect to
  it, an inliner that changed when the game's script ran. None of that exists
  when the game is just a page. `launcher/`, `tools/build-exe.mjs` and the tests
  that compiled C are removed.
- **`npm run build:web`** produces `release/Aetheris.html` and a deployable
  `release/Aetheris-web-<version>.zip`. Unzip it, serve `index.html` as a static
  site. Netlify, Vercel, GitHub Pages, Cloudflare Pages, S3 and nginx all work
  with nothing configured; the zip's README says so for whoever deploys it.
- The single-file inliner now lives in `tools/inline.mjs` and is shared, so the
  published artifact and the zip cannot drift apart. Its two hard-won rules —
  keep the bundle's execution timing, splice insertions by index instead of
  through `String.replace` — are documented where they are implemented.
- **Loose ends removed:** four stale release pairs, an out-of-date 1.3.0 pair
  and every `.exe` are deleted from Google Drive. The folder now holds one zip
  and one html for the current version.

### 1.5.3 — the game could not start at all from the exe
- **Fixed the frozen "Awakening" screen.** The .exe opened a window that sat on
  the loading text forever and then said "The game did not start", with no
  useful error. The server was fine — the page loaded, styled and titled
  correctly — but the game's own script never ran to completion.
- Cause: Vite emits the bundle as `<script type="module" src=...>` in the
  document head. A module script is deferred, so it runs after every element
  exists. The single-file packer replaced that tag with a plain `<script>`,
  which runs *immediately*, while the parser is still inside the head — at that
  moment `document.body` is `null`. The first `document.getElementById('scene')`
  returned null, the next line dereferenced it, and the game died on the way in.
  It could not even show its error card, because `#fatal` did not exist yet.
- The bundle is now placed at the end of `<body>`, where a deferred script
  would have run, so the DOM is complete before any of it executes.
- Also fixed two bugs in the packer found while chasing this: inserting the
  bundle with a replacement string expanded `$&` and `$'` sequences that occur
  throughout the minified code, which spliced a literal `</body>` into the
  middle of the JavaScript. All insertions now splice by index.
- The build now refuses to ship a payload with a classic script in the head, a
  bundle outside the body, spliced markup, or a script that does not parse, and
  the watchdog suite checks the same things on the shipped file.

### 1.5.2 — the open game keeps its server alive
- **Reloading the game, or downloading an update mid-session, could still hit
  `ERR_CONNECTION_REFUSED`.** 1.5.1 stopped shutting the server down with the
  browser process, but replaced that with "stop after a few idle seconds" —
  which is fine for the first paint and wrong for everything after it. A loaded
  game can sit in a menu, reload the page, or POST a downloaded build back to
  the launcher, and all of those need the server up.
- The page now checks in with the launcher every few seconds while it is open.
  Check-ins stop when the tab closes, and the launcher shuts down shortly after.
  A slower, throttled background tab is allowed for. A page too old to check in
  still falls back to the idle timeout.
- The build now proves the whole lifecycle against the real server: it stays up
  while a page checks in, survives a reload, and shuts down once it stops.

### 1.5.1 — the launcher stopped before the window opened
- **Fixed `ERR_CONNECTION_REFUSED at 127.0.0.1` when starting the exe.** The
  launcher started a local server, opened the browser at it, then waited for the
  browser *process* to exit and shut the server down. Chromium forwards the URL
  to an already-running instance and exits immediately, so the server was
  switched off while the real window was still opening. It now stays up while
  the page is being read and shuts down after a few idle seconds.

### 1.5.0 — the fixes that needed a screenshot
- **The scope works.** The sniper's teal disc is gone (it was the viewmodel's
  emissive lens sitting 25 cm from the eye), the reticle is sized to the lens
  instead of the whole screen, and the zoom is up from 3.5x to 4.4x.
- **The AR-15 aims.** Its optic was a tube with no rear element, so scoping put
  your eye inside an unlit cylinder — a black screen. It is a capped red-dot
  now, with a red-dot overlay while aiming.
- **Bots have a difficulty**, Easy by default, and Easy is genuinely easy.
- **Controller aim is usable**: far stronger aim assist, a sensitivity slider,
  and the stick no longer fights the mouse.
- **Gamepad for player 1**, in every mode including bot practice.
- **One controller no longer drives both players** in split-screen.
- **No more phantom crash cards.** Pointer-lock refusals are retried through the
  browser's cooldown instead of being reported as fatal errors, and the filter
  now sits at the choke point rather than in the two error handlers.
- **The controller stops vanishing.** Detection is latched, so a pad that is
  plugged in stays detected through the idle periods where the browser hides it.
- **The sky is smooth.** The dome rebuilt its view direction per fragment; the
  per-vertex version bent the horizon gradient into visible facets.
- **Guests leave the lobby** when the host starts, instead of sitting on
  "waiting" while the match runs without them.

### 1.4.0 — the game updates itself
- **New versions install themselves.** The exe is a launcher now, not a
  snapshot: it keeps one copy of the game so it can always start, and on every
  launch it checks whether a newer build has been published. If one has, it
  downloads it, verifies its SHA-256 and swaps it in for the next start. No
  re-downloading the exe, ever.
- **The version is in the menu**, next to a **Change log** panel listing every
  released version with its notes and the one you are running marked
  *you are here*.
- **Updates are verified, not trusted.** A build that does not hash to the
  published value is refused and the current one keeps working; so is a
  truncated download. The running game is never modified in place — a new build
  is written alongside it and only becomes the game on the next launch.
- **The changelog is live**: publishing a release is what makes it appear, for
  every player, without a new download.
- Publishing needs the database credential; the anon key inside the game can
  read releases but not write them, so nobody can ship a modified build to
  other players.

### 1.3.0 — ammo everywhere, online duels
- **Ammo respawns often.** Resupply crates are spread across the island and
  come back quickly, so running dry is a looting problem, not a match-ender.
- **Online play over a room code**, with no split screen — each player gets a
  full-screen view. Host a room, read out the five-character code, and your
  friend joins from anywhere.
- **Live ping** in the HUD and in the lobby, so you can see the connection
  quality before the match starts.

### 1.2.0 — held weapons, regen, target feedback
- **The soldier actually holds the gun.** Upper and forearm bones are solved
  with analytic two-bone IK onto anchor points on the weapon itself (grip and
  foregrip), so the hands wrap the rifle in every stance, weapon and pose
  instead of leaving it welded to the chest with the arms hanging behind it.
- **Health regenerates.** Five seconds after the last hit the bar starts
  refilling and reaches full in fifteen seconds. The medkit is unchanged and
  still the instant top-up — it also resets the slow regen.
- **Reticle turns red** the moment an opponent is under the crosshair, using
  the same hitboxes the bullets use, and it will not go red through cover.
- **Red body outline** on the opponent you are aiming at.
- **The enemy locator is now tiny.** On screen it collapses to a 5 px dot and
  hides entirely when the reticle is already on the target; off screen it stays
  a small pill with the distance.
- **Pad aim assist** (player 2 on a controller): a light pull that eases the
  last few degrees of stick aim inside a ~9 degree cone. It never snaps and
  never tracks a target for you.

### 1.1.1 — cover & balance
- **Trees are real cover.** Trunks are a little wider with a flared base, they
  are solid to bullets, bodies and bot line-of-sight, and they are placed with
  enough room between them (median ~8 m) to fight in.
- **Fixed the second gun.** The body-held weapon and its muzzle flash were
  drawn in the owner's own camera, leaving a gun floating under the player.
  They now live on the body layer only.
- **Shadows.** The shadow pass was switched off globally and is now live, and
  every camera layer (including other players' bodies) casts and receives.
- **Bots are no longer lethal on sight.** They must notice you (0.32–0.78 s
  reaction), their aim settles in over half a second, they walk fire into
  targets in short bursts with recoil pauses, and they lose lock when you
  duck behind a trunk. Measured: 3.6 s to kill you → 7 s or more, and roughly
  a third of the old damage output.

## Development

```bash
npm install
npm run dev            # http://localhost:5173 (live preview)
npm run build:web      # → release/Aetheris.html + release/Aetheris-web-<v>.zip
npm run verify:all     # world, game, shaders, net, online, watchdog, update, e2e
npm run verify:update  # the page half of the self-updater
node tools/publish-release.mjs --dry-run   # validate a build without publishing
npm run verify         # headless world build smoke test (no GPU needed)
npm run verify:game    # headless combat/AI/pickup/match/audio simulation test
npm run verify:e2e     # runs the real bundle in a stub DOM: menu → match → pause
                       # → split screen → scoreboard → rematch
npm run verify:shaders # GLSL syntax check for every shader source
```

### How the web package is made

1. `vite build` produces one IIFE bundle plus one stylesheet.
2. `tools/inline.mjs` folds both into a single `index.html` — no external
   requests at all, so it runs from `file://` or any static host.
3. `tools/build-web.mjs` writes that file to `release/Aetheris.html` (the
   published artifact, committed so it has a stable URL) and packages a zip for
   deployment.

The one subtle rule lives in the inliner: a `type="module"` script in `<head>`
is deferred, and turning it into an inline script would run it before the DOM
exists. Deferred bundles are relocated to the end of `<body>` instead. Insertions
are spliced by index, never through `String.replace` — minified code is full of
`$&`, which a replacement string expands.

Requires nothing but Node and the `zip` command.

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
src/ui/menu-chrome.js   version badge, change log panel, update line
src/net/updater.js      release lookup, verified download, staging hand-off
src/audio/ambience.js   procedural wind + drone
src/audio/sfx.js        procedural guns, reloads, hits, match stings
tools/build-web.mjs     web packager: single file + deployable zip
tools/inline.mjs        shared single-file inliner (timing + escaping rules)
tools/publish-release.mjs  publishes a build so installed copies update
docs/RELEASING.md       how an update reaches every existing install
```
