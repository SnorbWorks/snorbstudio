# What SnorbStudio is built from

SnorbStudio's own code is MIT (`LICENSE`), except `klipper_extras/`, which runs inside
Klipper and is GPL-3.0 like Klipper itself (`klipper_extras/COPYING`). It is built on the
free software below, each under its own license. Versions are those in SnorbStudio v1.0
(November 2026).

## Bundled in this repository

These ship unmodified. Each one's license text is next to it.

| What | Version | License | Where | License text |
|---|---|---|---|---|
| [three.js](https://threejs.org/) (3D view) and the addons SnorbStudio uses | r160 | MIT | `web/vendor/three/` | `web/vendor/three/LICENSE` |
| [fflate](https://github.com/101arrowz/fflate) (zip, used by three.js's 3MF loader) | 0.6.9 | MIT | `web/vendor/three/addons/libs/fflate.module.js` | `web/vendor/three/addons/libs/fflate-LICENSE` |
| Helvetiker Bold typeface (3D text), from the MgOpen fonts | as in three.js r160 | MgOpen license | `web/vendor/three/addons/fonts/` | `web/vendor/three/addons/fonts/LICENSE` |
| [replicad](https://replicad.xyz/) (SnorbCAD's solid modelling) | 1.2.1 | MIT | bundled into `web/design/worker.js` | `web/design/licenses/replicad-LICENSE.txt` |
| [OpenCASCADE](https://dev.opencascade.org/) via [replicad-opencascadejs](https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs) | 1.2.1 | LGPL-2.1 | `web/design/replicad_single.wasm`, its loader bundled into `web/design/worker.js` | `web/design/licenses/opencascade-LGPL-2.1.txt` |
| [Clipper](https://www.angusj.com/clipper2/Docs/Overview.htm) (clipper-lib, SnorbCAM's tool offsets), including Tom Wu's JSBN | 6.4.2 | Boost Software License 1.0; JSBN under its own permissive license | bundled into `web/design/cam.js` | `web/design/licenses/clipper-lib-LICENSE.txt` |
| [DejaVu Sans](https://dejavu-fonts.github.io/) fonts (SnorbCAD text and engraving) | 2.37 | Bitstream Vera / public domain | `web/design/fonts/` | `web/design/fonts/LICENSE` |

`design/build.mjs` copies the license texts of the bundled npm packages into
`web/design/licenses/` and `web/design/fonts/` on every build.

**OpenCASCADE (LGPL-2.1):** the WebAssembly file is the unmodified build from the
`replicad-opencascadejs` npm package, loaded at run time. Its source is at
https://github.com/sgenoud/replicad (packages/replicad-opencascadejs) and
https://github.com/Open-Cascade-SAS/OCCT. You may replace `replicad_single.wasm` with
your own build of the same library, and rebuild `worker.js` from `design/` with
`npm test`.

## Used to build SnorbCAD (not shipped)

From `design/package.json`: [esbuild](https://esbuild.github.io/) (MIT),
[TypeScript](https://www.typescriptlang.org/) (Apache-2.0) and `@types/three` (MIT).

## On the Raspberry Pi (not in this repository)

SnorbStudio runs next to these. They're installed separately, the usual Klipper way
(for example with KIAUH) or from Raspberry Pi OS, and keep their own licenses.

| Program | Does | License |
|---|---|---|
| Raspberry Pi OS (Debian) and its Linux kernel | The operating system | GPL-2.0 and others |
| [Klipper](https://www.klipper3d.org/) | Printer firmware and host | GPL-3.0 |
| [Moonraker](https://github.com/Arksine/moonraker) | Klipper's web API, which SnorbStudio talks to | GPL-3.0 |
| [Mainsail](https://github.com/mainsail-crew/mainsail) | Kept on port 8080 as a fallback | GPL-3.0 |
| [PrusaSlicer](https://github.com/prusa3d/PrusaSlicer) | Slicing; run as a separate command-line program | AGPL-3.0 |
| [nginx](https://nginx.org/) | Serves the web page | BSD-2-Clause |
| Python 3 | Runs `server/` (standard library only) | PSF License |
| [Tailscale](https://tailscale.com/) (optional) | Remote access | BSD-3-Clause |

SnorbStudio's server uses only Python's standard library, so there are no Python
packages to list.
