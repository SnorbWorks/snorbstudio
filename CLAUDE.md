# SnorbStudio: notes for Claude Code

The shared working notes for this project, kept in the repo so every computer
works from the same picture. Read this first; update it when something here
changes (a decision, a rule, a hardware fact). **This repo is public**: no IP
addresses, account emails, keys, network names or other private details here.

## What it is

SnorbStudio is the owner's web app for their workshop machines, served by a
Raspberry Pi 4 (1 GB) that drives an **original Ender 3** (Creality V4.2.2
board, Klipper + Moonraker). The top bar holds the apps:

- **SnorbCAD** (`design/`): drafting-style CAD (orthographic views build a
  solid; replicad/OpenCASCADE in a web worker). Plan: `design/ROADMAP.md`;
  spec: `design/SPEC.md`.
- **SnorbCAM** (`design/src/cam/`): toolpaths + G-code for the owner's
  ShopBot 4'x8' CNC router.
- **SnorbPrint** (`web/js/`): the printer. Pages Prepare, Print, Control,
  Files, Maintenance. PrusaSlicer CLI slices on the Pi (`server/studio_server.py`).
- **SnorbCut** (`web/cut/index.html`): the ShopBot. One self-contained page
  shown in a frame; see "SnorbCut" below.

Brand: Snorb bunny logo (`web/img/snorb*.png`), **dark plum** theme
(bg #170e1a, bar #211427, cards #2a1a30/#33213a, line #452d4d, text #f4e9f5,
muted #a893ab, accent lilac #d9a3d8, pink #f7b6c8). The CAD sheet stays
white (selection orchid #b04aa5, hover #e58fc0); projection lines are blue
on purpose.

## Layout

| Path | What |
|---|---|
| `web/` | Static site nginx serves on the Pi (`index.html`, `js/`, `css/`) |
| `web/design/` | **Built** SnorbCAD/SnorbCAM bundles + wasm, **committed** (the Pi never builds) |
| `design/` | SnorbCAD/SnorbCAM TypeScript source, tests (`design/test/`), `build.mjs` |
| `server/` | `studio_server.py` (slicing + file API at `/studio-api/`), `updater.py` |
| `deploy/` | `install.sh`, `push.sh`, nginx + systemd files, `studio_macros.cfg` (PRINT_START etc.) |
| `profiles/` | PrusaSlicer profiles / filament presets |
| `klipper_extras/` | `z_guard.py` (Z safety switch extra) |

## Build, test, publish

- `cd design && npm test`: builds the bundles into `web/design/` and runs the
  node tests. **Chain it** (`npm test && git commit ...`): a failing test was
  pushed once. If the cache errors, use `npm --cache <some temp dir>`.
- Changing `design/src` means **committing the rebuilt** `web/design/*.js` too.
- **Never `git add -A`**: add the files you changed by name.
- Commits end with the co-author line the session asks for.
- Print files (STL/3MF/G-code) don't go in this repo.
- Local test: `python3 -m http.server 8765` in `web/`, then open
  `http://127.0.0.1:8765/index.html#design`. Hard-reload after builds
  (Chrome caches `design.js`). Debug handle: `window.__design = {st, sheet, checkPrint}`.

## How updates reach the printer

The Pi keeps a git checkout of this repo and follows **master on GitHub**.

- Publishing = commit, push to master. From the owner's home network,
  `sh deploy/push.sh` also pokes the Pi to check right away.
- **Owner rule: no periodic update checks.** The Pi checks once per start-up
  (after its services settle), when someone presses **Check now**
  (Maintenance > Software updates), or when `push.sh` pokes it. From another
  network the poke can't reach the Pi: tell the owner to press Check now.
- It installs only when the printer is idle (not printing, heaters off, not
  slicing), via `deploy/install.sh`, which rolls back if SnorbStudio or
  Klipper won't start. Never copy files into the Pi's checkout by hand: a
  dirty checkout blocks updates.
- So **every push to master goes live on the printer**: test first.

## Owner preferences

- Plain, everyday language in the UI and in explanations.
- Mac with mouse/trackpad. SnorbCAD follows design-app conventions
  (Photoshop / Illustrator / InDesign shortcuts and feel).
- **One name, one part**: a design `X.json` and a library `X.stl` are the
  same part; never let two files share a name.

## Printer facts (Klipper)

- Probe: CR Touch, offsets x −43, y −10. Bed travel 0–235 in X and Y;
  Z `position_min` −3.
- **Z offset convention:** calibrated hot (bed 75 °C, nozzle 150 °C) with a
  **0.05 mm feeler gauge**: "snug" = Z 0. Current probe `z_offset` 3.47
  (2026-11-15, new thinner mat).
- **Per-filament squish:** PRINT_START applies a Z offset per filament,
  relative to PLA (PLA = 0 = the probe offset; `+` = nozzle higher). Saved as
  `SAVE_VARIABLE squish_<material>`; clamped to ±0.3 mm. PETG is −0.05.
  A bigger change belongs in the probe `z_offset`, not the squish.
- **Z safety switch** (`z_guard`, pin PA7): set to click ~0.8 mm above the
  bed surface; refuses to home/probe if pressed (prints cancel with
  "Z guard switch is pressed"). It's also a **physical stop**: after a bed
  mat change, re-set its height or the gantry lands on it before the nozzle
  reaches the mat.
- **Levelling:** always with the bed **hot (75 °C)**, since the plate bows cold.
  The bed is twisted-prone: read heights at each knob (not a plane fit).
  Knobs: clockwise seen from above = raise. They move the bed different
  amounts per turn (two measured ~0.2–0.35 mm/turn, others ~0.67), so the
  Maintenance assistant learns each knob's rate. `SCREWS_TILT_CALCULATE` works
  now (right-hand points at X 235). The saved mesh is 9×9.
- Klipper refuses `BED_MESH_PROFILE SAVE=default` ("reserved"): calibrate
  straight into the default profile, then `SAVE_CONFIG`.
- Extruder: direct drive kit (since 2026-11-11), rotation_distance 32.15,
  retraction 0.5–1 mm. Older G-code files have 5 mm retraction: re-slice.
- `SAVE_CONFIG` restarts Klipper and **turns the heaters off**.

## SnorbCAM / ShopBot

The ShopBot is a router (no RPM control: no M3/S). Output matches the
Easel files the owner already runs: `G20`, `G90`, only `G0`/`G1` (arcs
linearised), no comments or M codes, 5 decimals, cuts F160, plunges F60,
safety Z 0.25", start/end Z 2.0", end `G0 X0 Y0` + `G4 P0.1`. Zero: X/Y at
the sheet's lower-left, Z on top of the material. Mostly 1/4" compression
bits. Tested in `design/test/cam.test.mjs`; **not yet air-cut on the real
machine**.

**Cut Order** (`design/src/cam/sequence.ts`, the side panel's second tab):
every cut in the order it runs, with **steps** between (pause, tool change,
material change, other). A step can send the head to Machine Home, Project
Home or a saved spot (names come from SnorbCut's `/cut-api/status`), ask for
a new Z zero, and always waits for the person at the machine. The automatic
order is holes, pockets, lines, inside cuts, then cut-outs last, with the
fewest bit changes; arranging by hand stores `job.seq`. A run of cuts between
steps is a **stage**: one bit, one G-code file. A tool change always sits
where the bit changes (added automatically). Tests: `design/test/sequence.test.mjs`.
Still to do: "Send to SnorbCut" so the bridge runs the stages and steps as one job.

## SnorbCut

The ShopBot keeps its own control software (SB3, on a Windows laptop at the
shop, on another network). A small bridge program on that laptop reads SB3's
position and state and can press its Stop/Pause; it is **not in this repo**.
The Pi relays `/cut-api/` to the bridge over Tailscale (`deploy/nginx-studio.conf`;
the laptop's address is only in `/etc/nginx/snippets/studio-cut.conf` on the Pi).

- `web/cut/index.html` is the **same file** the bridge serves on the laptop
  (there it talks to `/api/` directly). Keep it self-contained: plain JS, no
  imports, no build. Change it in one place and copy it to the other.
- **Owner safety rule:** from anywhere: watch, Pause, Stop, send a job file.
  **Only on the laptop itself** (the bridge checks the request is local, not
  the page): Start, Resume after a pause, moves, zeroing, router on/off.
  Never add a way around that through the Pi.

## Open items

- SnorbCAD: angled faces + spheres (ROADMAP "Later"); owner feedback on recent rounds.
- Known bug: a gear whose hub diameter **equals** the tooth OD, plus a bore,
  loses most of its hub (coincident faces in `gearExtras`). Workaround: hub 0.1 mm smaller.
- Print page **Save**: when a live Z adjustment is beyond ±0.3, offer to move
  the probe `z_offset` instead of refusing.
- Printer: re-fit the Z safety switch for the thinner mat; pressure advance
  not tuned yet.
