// The geometry worker: OpenCASCADE runs here so the sheet never freezes.
// Messages in:  {id, type: 'build', project, views} | {id, type: 'stl', project}
// Messages out: {id, ok: true, result} | {id, ok: false, error}

import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build, stl } from './geometry.js';

const ready = (async () => {
  const OC = await (opencascade as any)({ locateFile: () => new URL('./replicad_single.wasm', import.meta.url).href });
  setOC(OC);
})();

// Only the newest build matters: older ones still queued are skipped.
let latestBuild = 0;

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    await ready;
    if (msg.type === 'build') {
      latestBuild = msg.id;
      await new Promise((r) => setTimeout(r, 0));     // let newer requests arrive
      if (msg.id !== latestBuild) return (self as any).postMessage({ id: msg.id, ok: false, skipped: true });
      const result = build(msg.project, msg.views, true);
      (self as any).postMessage({ id: msg.id, ok: true, result });
    } else if (msg.type === 'stl') {
      const blob = stl(msg.project);
      const buf = await blob.arrayBuffer();
      (self as any).postMessage({ id: msg.id, ok: true, result: buf }, [buf]);
    } else if (msg.type === 'ping') {
      (self as any).postMessage({ id: msg.id, ok: true, result: 'ready' });
    }
  } catch (e: any) {
    (self as any).postMessage({ id: msg.id, ok: false, error: String(e?.message || e) });
  }
};
