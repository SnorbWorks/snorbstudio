// Filament presets (served by the slicing helper) shared by the Prepare,
// Control, Print and Maintenance pages, plus the per-filament first-layer
// "squish" the printer remembers (SAVE_VARIABLE squish_<key>).
//
// Squish is a Z change relative to PLA: + raises the nozzle (less squish),
// - lowers it.  PLA is the reference, so its squish is always 0 and its
// tuning lives in the probe Z offset.

import { mr } from './moonraker.js';

const SETTINGS_KEY = 'studio.printSettings';
let info = null;

export async function loadInfo() {
  if (!info) info = fetch('/studio-api/info').then((r) => r.json()).catch((e) => { info = null; throw e; });
  return info;
}

export async function materials() {
  try { return (await loadInfo()).materials || {}; } catch (e) { return {}; }
}

export function savedSquish(key) {
  const v = mr.printer.save_variables?.variables?.[`squish_${key}`];
  return v == null ? null : +v;
}

export function squishFor(mats, key) {
  if (key === 'pla') return 0;
  const s = savedSquish(key);
  return s != null ? s : (mats[key]?.squish ?? 0);
}

export function fmtSquish(z) {
  if (Math.abs(z) < 0.0005) return '±0 (same as PLA)';
  return `${z > 0 ? '+' : '−'}${Math.abs(z).toFixed(2)} mm (${z > 0 ? 'less' : 'more'} squish)`;
}

// The filament picked on the Prepare page (remembered in the browser).
export function selectedMaterial() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}').material || 'pla'; } catch (e) { return 'pla'; }
}

// What the running print's PRINT_START applied ({material, squish}).
export function activeFilament() {
  const f = mr.printer['gcode_macro _STUDIO_FILAMENT'] || {};
  return { material: f.material || '', squish: +(f.squish || 0) };
}
