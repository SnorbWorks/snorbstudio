// Build the Design tab into ../web/design (served as static files by nginx on
// the Pi; the Pi never builds anything). Also builds the geometry module for
// the node tests.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';

const out = '../web/design';
mkdirSync(out, { recursive: true });
const common = { bundle: true, format: 'esm', target: 'es2022', sourcemap: false, minify: true, logLevel: 'warning' };

await esbuild.build({ ...common, entryPoints: ['src/main.ts'], outfile: `${out}/design.js`, platform: 'browser',
  external: ['three', 'three/addons/*'] });
await esbuild.build({ ...common, entryPoints: ['src/worker.ts'], outfile: `${out}/worker.js`, platform: 'browser',
  external: ['module', 'fs', 'path', 'url', 'node:*'] });

const wasm = 'node_modules/replicad-opencascadejs/dist/replicad_single.wasm';
const dst = `${out}/replicad_single.wasm`;
let same = false;
try { same = statSync(dst).size === statSync(wasm).size; } catch { /* first build */ }
if (!same) copyFileSync(wasm, dst);
mkdirSync(`${out}/fonts`, { recursive: true });
for (const f of ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']) copyFileSync(`node_modules/dejavu-fonts-ttf/ttf/${f}`, `${out}/fonts/${f}`);
copyFileSync('node_modules/dejavu-fonts-ttf/LICENSE', `${out}/fonts/LICENSE`);

await esbuild.build({ ...common, minify: false, entryPoints: ['src/geometry.ts', 'src/model.ts', 'src/views.ts', 'src/gears.ts'],
  outdir: 'test/build', platform: 'node', outExtension: { '.js': '.mjs' }, external: ['replicad', 'replicad-opencascadejs'] });
console.log('built', out);
