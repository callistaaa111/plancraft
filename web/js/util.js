// Small DOM and formatting helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div', {class: 'x', onclick: fn}, child, 'text', [more]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function uid(prefix = '') {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return prefix + [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.pending = () => t !== null;
  return d;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const nf = new Map();
export function fmt(v, dp = 2) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  if (!nf.has(dp)) nf.set(dp, new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  return nf.get(dp).format(Math.abs(v) < 0.5 * 10 ** -dp ? 0 : v);
}

export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  const s = (Date.now() - t.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return t.toLocaleDateString();
}

export function isTyping(e) {
  const t = e.target;
  if (!t || !t.tagName) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

/** Ask the browser to download a URL (used for the Excel export). */
export function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

export function pickFiles(accept, multiple = false) {
  return new Promise(resolve => {
    const input = document.getElementById('filePicker');
    input.value = '';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** UI scale (90-125%), remembered in this browser. Set from the About window or the command menu (Ctrl+K). */
export function applyUiScale(z) {
  document.documentElement.style.zoom = z;
  try { localStorage.setItem('plancraft.uiscale', String(z)); } catch { /* storage unavailable */ }
}
export function savedUiScale() {
  try {
    const z = Number(localStorage.getItem('plancraft.uiscale'));
    if (z >= 0.8 && z <= 1.5) return z;
  } catch { /* storage unavailable */ }
  return 1;
}
