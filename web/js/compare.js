// Revision overlay: show the open page in red and another page (e.g. the new revision) in green on top of each other.
// Lines on both turn black. Align them with two pairs of clicks, then copy or move the takeoff across.
//
// The alignment is a similarity transform t = [a, b, tx, ty] from the other page's pixels to this page's pixels:
//   x' = a*x - b*y + tx,  y' = b*x + a*y + ty.   It is saved on the page as page.overlay = {page, t}.
import { S, on, ix, mutate, pageById, currentPage, setPage, setTool } from './store.js';
import * as M from './measure.js';
import * as api from './api.js';
import { h, uid } from './util.js';
import { icon } from './icons.js';
import { modal, toast } from './dialogs.js';

const r2 = v => Math.round(v * 100) / 100;

export function apply(t, p) { const [a, b, tx, ty] = t; return [a * p[0] - b * p[1] + tx, b * p[0] + a * p[1] + ty]; }
export function invert(t) {
  const [a, b, tx, ty] = t;
  const d = a * a + b * b;
  const ia = a / d, ib = -b / d;
  return [ia, ib, -(ia * tx - ib * ty), -(ib * tx + ia * ty)];
}

function defaultT(base, other) {
  const pb = M.pxPerM(base), po = M.pxPerM(other);
  const k = pb && po ? pb / po : base.dpi && other.dpi ? base.dpi / other.dpi : (base.width || 1) / (other.width || 1);
  return [k, 0, 0, 0];
}

export function initCompare(viewer, host) {
  let active = false;
  let align = null;        // {pairs: [[red, green]], pending: red point | null}
  const tints = new Map(); // `${image}:${color}` -> {bmp} | {loading} | {error}
  const panel = h('div', { class: 'float-panel left', hidden: true, role: 'dialog', 'aria-label': 'Compare revisions' });
  host.append(panel);

  const base = () => currentPage();
  const other = () => { const b = base(); return b?.overlay ? pageById(b.overlay.page) : null; };
  const transform = () => base()?.overlay?.t || null;

  function tint(page, color) {
    const key = `${page.image}:${color}`;
    const e = tints.get(key);
    if (e) return e.bmp || null;
    tints.set(key, { loading: true });
    fetch(api.tintUrl(S.project.id, page.image, color))
      .then(r => { if (!r.ok) return r.json().then(j => { throw new Error(j.error || `HTTP ${r.status}`); }); return r.blob(); })
      .then(b => createImageBitmap(b))
      .then(bmp => { tints.set(key, { bmp }); renderPanel(); viewer.render(); })
      .catch(err => { tints.set(key, { error: err.message }); toast(`Overlay: ${err.message}`, 'error'); });
    return null;
  }

  function setOther(id, keepT = false) {
    const b = base(), o = pageById(id);
    if (!b || !o || o.id === b.id) return;
    mutate(() => { b.overlay = { page: o.id, t: keepT && b.overlay?.t ? b.overlay.t : defaultT(b, o) }; }, { history: false });
  }

  function open() {
    const b = base();
    if (!b) return;
    if (S.project.pages.length < 2) { toast('Add the other revision as a page first (Add plans), then compare.'); return; }
    if (!b.overlay || !pageById(b.overlay.page)) {
      const pages = S.project.pages;
      const i = pages.indexOf(b);
      setOther((pages[i + 1] || pages[i - 1]).id);
    }
    active = true;
    renderPanel();
    viewer.render();
    document.dispatchEvent(new CustomEvent('plancraft:toggles'));
  }

  function close() {
    active = false;
    align = null;
    if (S.tool === 'align') setTool('select');
    panel.hidden = true;
    viewer.render();
    document.dispatchEvent(new CustomEvent('plancraft:toggles'));
  }

  function startAlign() {
    align = { pairs: [], pending: null };
    setTool('align');
    renderPanel();
    viewer.render();
  }

  function finishAlignStep() {
    const b = base();
    const t = transform();
    const [r1, g1] = align.pairs[align.pairs.length - 1];
    // g was clicked where the other page's feature shows now: map it back into the other page's own pixels
    const o1 = apply(invert(t), g1);
    let nt;
    if (align.pairs.length === 1) {
      const [a, bb] = t;
      nt = [a, bb, r1[0] - (a * o1[0] - bb * o1[1]), r1[1] - (bb * o1[0] + a * o1[1])];
    } else {
      const [r0, g0] = align.pairs[0];
      const o0 = apply(invert(t), g0);
      const zx = o1[0] - o0[0], zy = o1[1] - o0[1];
      const wx = r1[0] - r0[0], wy = r1[1] - r0[1];
      const d = zx * zx + zy * zy;
      if (d < 1) { toast('Pick two points further apart.'); align.pairs.pop(); return; }
      const a = (wx * zx + wy * zy) / d, bb = (wy * zx - wx * zy) / d;
      nt = [a, bb, r0[0] - (a * o0[0] - bb * o0[1]), r0[1] - (bb * o0[0] + a * o0[1])];
    }
    mutate(() => { b.overlay = { ...b.overlay, t: nt.map(v => Math.round(v * 1e6) / 1e6) }; });
    if (align.pairs.length >= 2) {
      align = null;
      setTool('select');
      toast('Pages aligned. Fine-tune by aligning again if needed.');
    } else {
      // after the first pair the green layer moved; later clicks on green are in the new position
      align.pairs = [[r1, apply(nt, o1)]];
    }
    renderPanel();
    viewer.render();
  }

  async function transfer() {
    const b = base(), o = other(), t = transform();
    if (!b || !o || !t) return;
    const x = ix();
    const items = x.items.filter(it => it.sections.some(s => s.page === b.id));
    const nSecs = items.reduce((n, it) => n + it.sections.filter(s => s.page === b.id).length, 0);
    const marks = (S.project.marks || []).filter(m => m.page === b.id);
    if (!nSecs && !marks.length) { toast('There is no takeoff on this page to copy.'); return; }
    const already = x.items.reduce((n, it) => n + it.sections.filter(s => s.page === o.id).length, 0);
    const mode = { value: 'copy' };
    const radios = [['copy', 'Copy (keep it on this page too)'], ['move', 'Move (take it off this page)']].map(([v, label]) =>
      h('label', null, h('input', { type: 'radio', name: 'xferMode', value: v, checked: v === 'copy', onchange: () => { mode.value = v; } }), label));
    const ok = await modal({
      title: `Copy takeoff to "${o.name}"`,
      body: [
        h('p', { style: { margin: 0 } }, `${nSecs} takeoff section(s) in ${items.length} item(s)${marks.length ? ` and ${marks.length} note(s)/highlight(s)` : ''} will be placed on "${o.name}" using the current alignment.`),
        h('div', { class: 'radio-list' }, radios),
        already ? h('div', { class: 'callout' }, `"${o.name}" already has ${already} section(s). Copying adds to them, so check you are not counting twice.`) : null,
        h('p', { class: 'note', style: { margin: 0 } }, 'Check the result on the other page: where the drawing changed, adjust or redraw those runs.'),
      ],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Copy takeoff', value: true, primary: true }],
    });
    if (!ok) return;
    const inv = invert(t);
    const move = mode.value === 'move';
    const map = p => apply(inv, p).map(r2);
    mutate(p => {
      for (const it of items) {
        const secs = it.sections.filter(s => s.page === b.id);
        for (const s of secs) it.sections.push({ ...s, id: uid('s'), page: o.id, points: s.points.map(map) });
        if (move) it.sections = it.sections.filter(s => s.page !== b.id);
      }
      for (const m of marks) {
        const c = { ...m, id: uid('m'), page: o.id };
        if (m.kind === 'note') c.at = map(m.at); else { c.points = m.points.map(map); c.width = r2(m.width / Math.hypot(t[0], t[1])); }
        p.marks.push(c);
      }
      if (move) p.marks = p.marks.filter(m => m.page !== b.id);
    });
    toast(`${move ? 'Moved' : 'Copied'} ${nSecs} section(s) to "${o.name}". Use "Swap" to look at it.`);
  }

  function swap() {
    const b = base(), o = other(), t = transform();
    if (!b || !o || !t) return;
    mutate(() => { o.overlay = { page: b.id, t: invert(t).map(v => Math.round(v * 1e6) / 1e6) }; }, { history: false });
    setPage(o.id);
  }

  function renderPanel() {
    if (!active) { panel.hidden = true; return; }
    const b = base(), o = other();
    panel.hidden = false;
    if (!b) return;
    const sel = h('select', { 'aria-label': 'Compare with page', onchange: e => { setOther(e.target.value); renderPanel(); viewer.render(); } },
      S.project.pages.filter(p => p.id !== b.id).map(p => h('option', { value: p.id, selected: p.id === o?.id }, p.name)));
    if (o) { tint(b, 'red'); tint(o, 'green'); }   // start preparing the overlay images straight away
    const loading = o && (!tints.get(`${b.image}:red`)?.bmp || !tints.get(`${o.image}:green`)?.bmp);
    const steps = !align ? null : align.pending
      ? 'Now click the SAME point on the GREEN drawing.'
      : align.pairs.length ? 'Second pair (for size and rotation): click a point on the RED drawing, far from the first.'
        : 'Click a clear point on the RED drawing (a column, a corner, a grid line crossing).';
    panel.replaceChildren(...[
      h('div', { class: 'fp-title' }, h('span', { html: icon('compare') }), h('span', null, 'Compare revisions'),
        h('button', { class: 'btn ghost small icon-only', style: { marginLeft: 'auto' }, title: 'Close', onclick: close, html: icon('x') })),
      h('div', { class: 'field' }, h('label', null, 'Compare this page with'), sel),
      h('div', { class: 'legend' },
        h('span', null, h('i', { style: { background: '#d21919' } }), 'Only on this page'),
        h('span', null, h('i', { style: { background: '#00963c' } }), `Only on "${o?.name || ''}"`),
        h('span', null, h('i', { style: { background: '#111' } }), 'On both (no change)')),
      loading ? h('div', { class: 'note' }, 'Preparing the overlay...') : null,
      steps ? h('div', { class: 'callout' }, steps) : null,
      h('div', { class: 'btn-row' },
        align ? h('button', { class: 'btn small', onclick: () => { align = null; setTool('select'); renderPanel(); viewer.render(); } }, 'Stop aligning')
          : h('button', { class: 'btn small', onclick: startAlign, html: `${icon('align')}<span>Align</span>` }),
        h('button', { class: 'btn small', onclick: () => { setOther(o.id); renderPanel(); viewer.render(); }, title: 'Back to the automatic alignment' }, 'Reset'),
        h('button', { class: 'btn small', onclick: swap, title: `Open "${o?.name || ''}" with this page as the overlay` }, 'Swap')),
      h('button', { class: 'btn small primary', onclick: transfer, html: `${icon('copy')}<span>Copy takeoff to "${o?.name || ''}"...</span>` }),
    ].filter(Boolean));
  }

  on('change', () => { if (active) renderPanel(); });
  on('load', () => { tints.forEach(e => e.bmp?.close?.()); tints.clear(); active = false; align = null; panel.hidden = true; });

  const ext = viewer.use({
    tools: ['align'],

    drawPage(ctx, page) {
      if (!active) return false;
      const o = other(), t = transform();
      if (!o || !t) return false;
      const red = tint(page, 'red'), green = tint(o, 'green');
      if (!red || !green) return false;           // the normal page shows until both overlay images are ready
      const { s, tx, ty } = viewer.view;
      const d = viewer.dpr;
      const [W, H] = viewer.pageSize(page);
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.imageSmoothingEnabled = true;
      ctx.setTransform(d * s, 0, 0, d * s, d * tx, d * ty);
      ctx.drawImage(red, 0, 0, W, H);
      const [a, b, ox, oy] = t;
      ctx.setTransform(d * s * a, d * s * b, -d * s * b, d * s * a, d * (s * ox + tx), d * (s * oy + ty));
      ctx.drawImage(green, 0, 0, o.width || green.width, o.height || green.height);
      ctx.restore();
      ctx.setTransform(d, 0, 0, d, 0, 0);
      return true;
    },

    drawOver(ctx) {
      if (!align) return;
      const dot = (p, color) => {
        const [x, y] = viewer.toScr(p);
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
      };
      for (const [r] of align.pairs) dot(r, '#d21919');
      if (align.pending) dot(align.pending, '#d21919');
    },

    down(e, x, y) {
      if (!align) { setTool('select'); return true; }
      const p = viewer.toImg(x, y);
      if (!align.pending) { align.pending = p; renderPanel(); viewer.render(); return true; }
      align.pairs.push([align.pending, p]);
      align.pending = null;
      finishAlignStep();
      return true;
    },

    key(e) {
      if (e.key === 'Escape' && align) { align = null; setTool('select'); renderPanel(); viewer.render(); return true; }
      return false;
    },

    hint() {
      if (!align) return null;
      return align.pending ? 'Align: click the same point on the GREEN drawing.' : 'Align: click a clear point on the RED drawing. Esc stops.';
    },

    reset(why) {
      if (why === 'page' && active) {
        align = null;
        const b = base();
        if (b && (!b.overlay || !pageById(b.overlay.page))) {
          const pages = S.project.pages;
          const i = pages.indexOf(b);
          const nb = pages[i + 1] || pages[i - 1];
          if (nb) setTimeout(() => { setOther(nb.id); renderPanel(); viewer.render(); });
        }
        setTimeout(renderPanel);
      }
      if (why === 'tool' && S.tool !== 'align' && align) { align = null; setTimeout(renderPanel); }
    },
  });

  return { open, close, toggle: () => (active ? close() : open()), isOpen: () => active, ext };
}
