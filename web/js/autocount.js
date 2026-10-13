// Auto count: box one symbol, PlanCraft finds the look-alikes on the page, you review them and add them to a count item.
import { S, mutate, selectedItem, currentPage } from './store.js';
import * as api from './api.js';
import { h, uid } from './util.js';
import { icon } from './icons.js';
import { toast } from './dialogs.js';

const r2 = v => Math.round(v * 100) / 100;
const PREFS = 'plancraft.autocount';
const METHODS = { auto: 'Automatic', dots: 'Dots on wires (lights)', shape: 'Symbol shape' };

function loadPrefs() {
  try { return { method: 'auto', onScreen: true, rotations: false, ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; }
  catch { return { method: 'auto', onScreen: true, rotations: false }; }
}

export function initAutoCount(viewer, host) {
  let box = null;          // the symbol box while dragging, page px
  let sweep = null;        // a skip / keep box while reviewing
  let res = null;          // {itemId, pageId, rect, area, method, matches: [[x, y, score]], size, off: Set(index)}
  let busy = false;
  let threshold = 0.7;
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* storage unavailable */ } };
  const panel = h('div', { class: 'float-panel right', hidden: true, role: 'dialog', 'aria-label': 'Auto count' });
  host.append(panel);

  const item = () => (res ? findItem(res.itemId) : selectedItem());
  function findItem(id) {
    const walk = list => { for (const n of list) { if (n.id === id) return n; if (n.children) { const f = walk(n.children); if (f) return f; } } return null; };
    return walk(S.project.tree);
  }

  /** Markers this item already has on the page (to avoid counting twice). */
  function existing() {
    const it = item();
    if (!it || !res) return [];
    return it.sections.filter(s => s.page === res.pageId).flatMap(s => s.points);
  }

  function classify() {
    const near = Math.max(6, Math.min(res.size[0], res.size[1]) * 0.6);
    const have = existing();
    return res.matches.map((m, i) => {
      if (m[2] < threshold) return 'below';
      if (have.some(q => Math.hypot(q[0] - m[0], q[1] - m[1]) < near)) return 'counted';
      return res.off.has(i) ? 'off' : 'on';
    });
  }

  /** The part of the page on screen, in page pixels. */
  function screenArea(page) {
    const [W, H] = viewer.pageSize(page);
    const a = viewer.toImg(0, 0), b = viewer.toImg(viewer.w, viewer.h);
    const x0 = Math.max(0, a[0]), y0 = Math.max(0, a[1]), x1 = Math.min(W, b[0]), y1 = Math.min(H, b[1]);
    return x1 > x0 && y1 > y0 ? [r2(x0), r2(y0), r2(x1 - x0), r2(y1 - y0)] : null;
  }

  async function search(rect, area = undefined) {
    const it = selectedItem();
    const page = currentPage();
    if (!it || it.type !== 'count' || !page) return;
    if (area === undefined) area = prefs.onScreen ? screenArea(page) : null;
    busy = true;
    res = null;
    renderPanel(`Looking for matching symbols${area ? ' on screen' : ' on the whole page'}...`);
    viewer.render();
    try {
      const out = await api.autoCount(S.project.id, page.image, [rect.x, rect.y, rect.w, rect.h],
        { rotations: prefs.rotations, method: prefs.method, area });
      if (S.pageId !== page.id) return;
      res = { itemId: it.id, pageId: page.id, rect, area, method: out.method, matches: out.matches, size: out.size, off: new Set() };
      box = null;
    } catch (err) {
      toast(err.message, 'error');
      box = null;
      close();
      return;
    } finally {
      busy = false;
    }
    renderPanel();
    viewer.render();
  }

  function add() {
    if (!res) return;
    const it = findItem(res.itemId);
    const kinds = classify();
    const pts = res.matches.filter((m, i) => kinds[i] === 'on').map(m => [r2(m[0]), r2(m[1])]);
    if (!it || !pts.length) { toast('Nothing to add.'); return; }
    mutate(() => { it.sections.push({ id: uid('s'), page: res.pageId, points: pts }); });
    toast(`Added ${pts.length} to "${it.name}".`);
    close();
  }

  function close() {
    res = null;
    box = null;
    sweep = null;
    panel.hidden = true;
    viewer.render();
  }

  function renderPanel(message) {
    panel.hidden = false;
    const it = item();
    if (message || busy) {
      panel.replaceChildren(h('div', { class: 'fp-title', html: `${icon('wand')}<span>Auto count</span>` }),
        h('div', { class: 'progress indeterminate' }, h('div')), h('div', { class: 'note' }, message || 'Working...'));
      return;
    }
    const slider = h('input', { type: 'range', min: 40, max: 99, value: Math.round(threshold * 100), 'aria-label': 'Match strength' });
    const val = h('span', { class: 'val' }, `${Math.round(threshold * 100)}%`);
    slider.addEventListener('input', () => {
      threshold = Number(slider.value) / 100;
      val.textContent = `${slider.value}%`;
      updateCounts();
      viewer.render();
    });
    const method = h('select', { 'aria-label': 'Method' },
      Object.entries(METHODS).map(([k, label]) => h('option', { value: k, selected: k === prefs.method }, label)));
    method.addEventListener('change', () => { prefs.method = method.value; savePrefs(); search(res.rect); });
    const onScreen = h('input', { type: 'checkbox', checked: prefs.onScreen });
    onScreen.addEventListener('change', () => { prefs.onScreen = onScreen.checked; savePrefs(); search(res.rect); });
    const rot = h('input', { type: 'checkbox', checked: prefs.rotations });
    rot.addEventListener('change', () => { prefs.rotations = rot.checked; savePrefs(); search(res.rect); });
    const counts = h('div', { class: 'fp-counts' });
    const addBtn = h('button', { class: 'btn primary small', onclick: add });
    function updateCounts() {
      const k = classify();
      const c = x => k.filter(y => y === x).length;
      counts.replaceChildren(...[
        h('span', { class: 'chip on' }, `${c('on')} to add`),
        c('off') ? h('span', { class: 'chip off' }, `${c('off')} skipped`) : null,
        c('counted') ? h('span', { class: 'chip counted' }, `${c('counted')} already counted`) : null,
        !c('on') && !c('off') ? h('div', { class: 'note' }, 'Nothing new at this strength. Lower it, try the other method, or box the symbol more tightly.') : null,
      ].filter(Boolean));
      addBtn.textContent = `Add ${c('on')}`;
      addBtn.disabled = !c('on');
    }
    updateCounts();
    const used = res.method === 'dots' ? 'dots on wires' : 'symbol shape';
    panel.replaceChildren(...[
      h('div', { class: 'fp-title', html: `${icon('wand')}<span>Auto count: ${escapeText(it?.name || '')}</span>` }),
      counts,
      h('div', { class: 'field' }, h('label', null, 'Match strength'), h('div', { class: 'inline' }, slider, val),
        h('div', { class: 'hint' }, 'Lower finds more, and more wrong ones.')),
      h('div', { class: 'field' }, h('label', null, `Method (used: ${used})`), method),
      h('label', { class: 'inline', style: { fontSize: '12.5px' } }, onScreen, 'Only search what is on screen'),
      res.method === 'shape' ? h('label', { class: 'inline', style: { fontSize: '12.5px' } }, rot, 'Also find turned symbols (slower)') : null,
      h('div', { class: 'hint' }, 'Click a circle to skip or keep it. Drag a box over the plan to skip all circles in it (hold Shift to keep them).'),
      h('div', { class: 'btn-row' },
        addBtn,
        h('button', { class: 'btn small', onclick: () => { res = null; panel.hidden = true; viewer.render(); toast('Drag a box around one symbol.'); } }, 'New box'),
        h('button', { class: 'btn small', onclick: close }, 'Cancel')),
    ].filter(Boolean));
  }

  const escapeText = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ring(ctx, x, y, r, color, dashed, cross) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    if (dashed) ctx.setLineDash([4, 3]);
    ctx.stroke();
    if (cross) {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x - r * 0.6, y - r * 0.6); ctx.lineTo(x + r * 0.6, y + r * 0.6);
      ctx.moveTo(x + r * 0.6, y - r * 0.6); ctx.lineTo(x - r * 0.6, y + r * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  const markerRadius = () => Math.max(7, (Math.min(...res.size) * viewer.view.s) / 2 + 2);

  function candidateAt(x, y) {
    if (!res) return -1;
    const kinds = classify();
    const r = markerRadius() + 2;
    let best = -1, bd = r;
    res.matches.forEach((m, i) => {
      if (kinds[i] === 'below' || kinds[i] === 'counted') return;
      const [sx, sy] = viewer.toScr(m);
      const d = Math.hypot(sx - x, sy - y);
      if (d <= bd) { bd = d; best = i; }
    });
    return best;
  }

  function rectOf(a, b) {
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
  }

  function strokeRect(ctx, r, color, dash = [5, 3]) {
    const a = viewer.toScr([r.x, r.y]);
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(a[0], a[1], r.w * viewer.view.s, r.h * viewer.view.s);
    ctx.restore();
  }

  return viewer.use({
    tools: ['autocount'],

    drawOver(ctx, page) {
      if (S.tool !== 'autocount') return;
      if (box) strokeRect(ctx, box, '#7c3aed');
      if (!res || res.pageId !== page.id) return;
      if (res.area) strokeRect(ctx, { x: res.area[0], y: res.area[1], w: res.area[2], h: res.area[3] }, 'rgba(124,58,237,.6)', [10, 6]);
      const kinds = classify();
      const r = markerRadius();
      res.matches.forEach((m, i) => {
        const k = kinds[i];
        if (k === 'below') return;
        const [x, y] = viewer.toScr(m);
        if (x < -r || y < -r || x > viewer.w + r || y > viewer.h + r) return;
        if (k === 'on') ring(ctx, x, y, r, '#16a34a', false, false);
        else if (k === 'off') ring(ctx, x, y, r, '#dc2626', true, true);
        else ring(ctx, x, y, r, '#9ca3af', true, false);
      });
      strokeRect(ctx, res.rect, '#7c3aed', []);
      if (sweep) {
        ctx.save();
        const a = viewer.toScr([sweep.r.x, sweep.r.y]);
        ctx.fillStyle = sweep.keep ? 'rgba(22,163,74,.12)' : 'rgba(220,38,38,.12)';
        ctx.fillRect(a[0], a[1], sweep.r.w * viewer.view.s, sweep.r.h * viewer.view.s);
        ctx.restore();
        strokeRect(ctx, sweep.r, sweep.keep ? '#16a34a' : '#dc2626');
      }
    },

    down(e, x, y) {
      if (busy) return true;
      const it = selectedItem();
      const p = viewer.toImg(x, y);
      if (res) {
        const i = candidateAt(x, y);
        if (i >= 0) {
          if (res.off.has(i)) res.off.delete(i); else res.off.add(i);
          renderPanel();
          viewer.render();
          return true;
        }
        sweep = { start: p, r: { x: p[0], y: p[1], w: 0, h: 0 }, keep: e.shiftKey };
        viewer.extDrag(this, e, { what: 'sweep', sx: x, sy: y });
        return true;
      }
      if (!it || it.type !== 'count') {
        toast('Select a count item first (or create one with + Count), then box one symbol.');
        return true;
      }
      box = { x: p[0], y: p[1], w: 0, h: 0, sx: p[0], sy: p[1] };
      viewer.extDrag(this, e, { what: 'box', sx: x, sy: y });
      return true;
    },

    move(e, x, y, d) {
      if (!d) return false;
      const p = viewer.toImg(x, y);
      if (d.what === 'sweep' && sweep) {
        sweep.r = rectOf(sweep.start, p);
        sweep.keep = e.shiftKey;
      } else if (box) {
        Object.assign(box, rectOf([box.sx, box.sy], p));
      }
      viewer.render();
      return true;
    },

    up(e, d) {
      if (d?.what === 'sweep') {
        const s = sweep;
        sweep = null;
        if (!s || e.type !== 'pointerup') { viewer.render(); return; }
        if (s.r.w * viewer.view.s < 6 || s.r.h * viewer.view.s < 6) {
          toast('Click a circle to skip it, or drag a box to skip all circles in it. Press New box for another symbol.');
          viewer.render();
          return;
        }
        const kinds = classify();
        let n = 0;
        res.matches.forEach((m, i) => {
          const inside = m[0] >= s.r.x && m[0] <= s.r.x + s.r.w && m[1] >= s.r.y && m[1] <= s.r.y + s.r.h;
          if (!inside || kinds[i] === 'below' || kinds[i] === 'counted') return;
          if (s.keep) res.off.delete(i); else res.off.add(i);
          n++;
        });
        if (n) toast(`${s.keep ? 'Kept' : 'Skipped'} ${n} circle${n === 1 ? '' : 's'}.`);
        renderPanel();
        viewer.render();
        return;
      }
      if (!box) return;
      const ok = e.type === 'pointerup' && box.w * viewer.view.s >= 6 && box.h * viewer.view.s >= 6;
      if (!ok) { box = null; viewer.render(); if (e.type === 'pointerup') toast('Drag a box tightly around one symbol.'); return; }
      search({ x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h) });
    },

    key(e) {
      if (S.tool !== 'autocount') return false;
      if (e.key === 'Escape' && (res || box)) { close(); return true; }
      if (e.key === 'Enter' && res) { add(); return true; }
      return false;
    },

    hint() {
      if (S.tool !== 'autocount') return null;
      const it = selectedItem();
      if (busy) return 'Looking for matching symbols...';
      if (res) return 'Green = will be added, red = skipped, grey = already counted. Click a circle, or drag a box (Shift = keep), then Add (Enter).';
      if (!it || it.type !== 'count') return 'Auto count: select a count item in the Takeoff list first.';
      return `Auto count "${it.name}": zoom to the area to count, then drag a box tightly around ONE symbol.`;
    },

    reset() {
      if (S.tool !== 'autocount' || (res && res.pageId !== S.pageId)) close();
    },
  });
}
