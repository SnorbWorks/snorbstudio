// The geometry worker: OpenCASCADE runs here so the sheet never freezes.
// Messages in:  {id, type: 'build', project, views} | {id, type: 'stl', project}
// Messages out: {id, ok: true, result} | {id, ok: false, error}

import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { loadFont } from 'replicad';
import { bases, build, fonts, importMesh, stl } from './geometry.js';

const ready = (async () => {
  const OC = await (opencascade as any)({ locateFile: () => new URL('./replicad_single.wasm', import.meta.url).href });
  setOC(OC);
  // the text tool's fonts (DejaVu, free licence)
  await Promise.all([
    loadFont(new URL('./fonts/DejaVuSans.ttf', import.meta.url).href, 'sans').then(() => { fonts.sans = true; }),
    loadFont(new URL('./fonts/DejaVuSans-Bold.ttf', import.meta.url).href, 'bold').then(() => { fonts.bold = true; }),
  ]).catch(() => { /* text shapes report an error instead */ });
})();

/** A library model used as the body: fetched from the Pi once, then kept. */
const loading: Record<string, Promise<void>> = {};
function loadBase(name: string): Promise<void> {
  if (bases[name]) return Promise.resolve();
  loading[name] ||= (async () => {
    const r = await fetch(`/studio-api/models/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`Couldn't fetch “${name}” from the library (${r.status})`);
    bases[name] = importMesh(new Uint8Array(await r.arrayBuffer()));
  })().catch((e) => { delete loading[name]; throw e; });
  return loading[name];
}

// Only the newest build matters: older ones still queued are skipped.
let latestBuild = 0;

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    await ready;
    if (msg.project?.base?.model) await loadBase(msg.project.base.model);
    if (msg.type === 'build') {
      latestBuild = msg.id;
      await new Promise((r) => setTimeout(r, 0));     // let newer requests arrive
      if (msg.id !== latestBuild) return (self as any).postMessage({ id: msg.id, ok: false, skipped: true });
      const result = build(msg.project, msg.views, true, msg.edges !== false);
      (self as any).postMessage({ id: msg.id, ok: true, result });
    } else if (msg.type === 'stl') {
      const blob = stl(msg.project);
      if (!blob) throw new Error('There is nothing to export yet.');
      const buf = await blob.arrayBuffer();
      (self as any).postMessage({ id: msg.id, ok: true, result: buf }, [buf]);
    } else if (msg.type === 'ping') {
      (self as any).postMessage({ id: msg.id, ok: true, result: 'ready' });
    }
  } catch (e: any) {
    (self as any).postMessage({ id: msg.id, ok: false, error: String(e?.message || e) });
  }
};
