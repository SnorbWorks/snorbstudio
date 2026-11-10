# Third-party software

SnorbStudio ships these unmodified, each under its own license:

| What | Where | License |
|---|---|---|
| [three.js](https://threejs.org/) | `web/vendor/three/`, bundled into `web/design/` | MIT |
| [replicad](https://replicad.xyz/) | bundled into `web/design/` | MIT |
| [OpenCASCADE](https://dev.opencascade.org/) via [opencascade.js](https://ocjs.org/) / replicad-opencascadejs | `web/design/replicad_single.wasm` | LGPL-2.1 (with the OCCT exception) |
| [DejaVu fonts](https://dejavu-fonts.github.io/) | `web/design/fonts/` (license alongside) | Bitstream Vera / public domain |

The OpenCASCADE WebAssembly file is the unmodified build from the
`replicad-opencascadejs` npm package, loaded at run time; its source is at
https://github.com/sgenoud/replicad (packages/replicad-opencascadejs) and
https://github.com/Open-Cascade-SAS/OCCT. You may replace it with your own
build of the same library.

Not shipped, but used on the Pi: [Klipper](https://www.klipper3d.org/) and
[Moonraker](https://github.com/Arksine/moonraker) (GPL-3.0), and
[PrusaSlicer](https://github.com/prusa3d/PrusaSlicer) (AGPL-3.0), which is run as
a separate command-line program.
