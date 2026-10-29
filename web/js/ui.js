// Small shared helpers: DOM lookup, toasts, confirm dialogs, formatting.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : String(kid));
  return e;
}

export function toast(msg, kind = '', ms = 4500) {
  const t = el('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// Show the error and keep going; used around every printer command.
export async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message || String(e), 'err', 7000);
    return undefined;
  }
}

export function confirmBox(title, body, yes = 'OK', danger = false) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    const b = $('#modal-body');
    b.replaceChildren();
    if (typeof body === 'string') b.append(el('p', {}, body)); else if (body) b.append(body);
    const yesBtn = $('#modal-yes'), noBtn = $('#modal-no');
    yesBtn.textContent = yes;
    yesBtn.className = danger ? 'btn danger solid' : 'btn primary';
    noBtn.classList.toggle('hidden', yes === null);
    $('#modal').classList.remove('hidden');
    const done = (v) => {
      $('#modal').classList.add('hidden');
      yesBtn.onclick = noBtn.onclick = null;
      resolve(v);
    };
    yesBtn.onclick = () => done(true);
    noBtn.onclick = () => done(false);
  });
}

export function fmtDuration(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function fmtDate(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function fmtFilament(mm) {
  if (!mm) return '–';
  return mm > 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm.toFixed(0)} mm`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
