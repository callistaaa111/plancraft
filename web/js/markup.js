// Notes and highlighter on the plan. They live in project.marks, are not takeoff and are never counted.
//   note:      {id, page, kind: 'note', at: [x, y], text, color, font, size, bold, italic, textColor, fill, width,
//               zoom (grow with the plan), refS (plan zoom when the size was set),
//               height (set when sized by hand; null = fit the text), ox / oy (box's bottom-left corner from the pin)}
//   highlight: {id, page, kind: 'highlight', points: [[x, y], ...], color, width}   (width in page pixels)
import { S, mutate, beginTx, live, commitTx, setTool } from './store.js';
import { h, uid, clamp } from './util.js';
import { modal, openMenu, toast } from './dialogs.js';

const HL_SCREEN_WIDTH = 18;     // highlighter width on screen when drawn
const r2 = v => Math.round(v * 100) / 100;
const FONTS = ['Segoe UI', 'Arial', 'Calibri', 'Tahoma', 'Verdana', 'Times New Roman', 'Georgia', 'Courier New', 'Consolas'];
const STYLE_KEY = 'plancraft.noteStyle';
const STYLE_DEFAULTS = { font: 'Segoe UI', size: 12, bold: false, italic: false, textColor: '#1c1c1c', fill: '#fffbe0', width: 230, zoom: false };

/** Last note style used, so new notes look like the previous one. */
function lastStyle() {
  try { return { ...STYLE_DEFAULTS, ...JSON.parse(localStorage.getItem(STYLE_KEY) || '{}') }; } catch { return { ...STYLE_DEFAULTS }; }
}
function rememberStyle(st) {
  try { localStorage.setItem(STYLE_KEY, JSON.stringify(st)); } catch { /* storage unavailable */ }
}
const styleOf = m => ({ ...STYLE_DEFAULTS, ...m });

export function initMarkup(viewer) {
  let sel = null;          // selected mark id
  let stroke = null;       // highlight being drawn
  const noteBoxes = new Map();   // id -> screen rect of the drawn note, for clicking

  const marksOn = page => (S.showMarks ? (S.project.marks || []).filter(m => m.page === page.id) : []);
  const markById = id => (S.project?.marks || []).find(m => m.id === id) || null;

  function distToSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    const t = L ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L, 0, 1) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  function noteHit(x, y) {
    for (const [id, r] of [...noteBoxes].reverse()) {
      if (x >= r.x - 8 && x <= r.x + r.w && y >= r.y && y <= r.y + r.h + 8) return markById(id);
    }
    return null;
  }

  function highlightHit(x, y, page) {
    for (const m of marksOn(page).filter(m => m.kind === 'highlight').reverse()) {
      const pts = m.points.map(q => viewer.toScr(q));
      const tol = Math.max(5, (m.width * viewer.view.s) / 2);
      if (pts.length === 1 && Math.hypot(pts[0][0] - x, pts[0][1] - y) <= tol) return m;
      for (let i = 0; i < pts.length - 1; i++) if (distToSeg([x, y], pts[i], pts[i + 1]) <= tol) return m;
    }
    return null;
  }

  // ---- editing -------------------------------------------------------------------------------------
  async function editNote(note, isNew) {
    const st = styleOf(isNew ? { ...lastStyle(), ...note } : note);
    const text = h('textarea', { rows: 4, placeholder: 'e.g. Check panel location with site', style: { minHeight: '90px' } }, note.text || '');
    const font = h('select', { 'aria-label': 'Font' }, FONTS.map(f => h('option', { value: f, selected: f === st.font, style: { fontFamily: f } }, f)));
    const size = h('input', { type: 'number', min: 6, max: 72, step: 1, value: st.size, 'aria-label': 'Font size' });
    const bold = h('input', { type: 'checkbox', checked: st.bold });
    const italic = h('input', { type: 'checkbox', checked: st.italic });
    const textColor = h('input', { type: 'color', value: st.textColor, 'aria-label': 'Text colour' });
    const fill = h('input', { type: 'color', value: st.fill, 'aria-label': 'Note colour' });
    const pin = h('input', { type: 'color', value: st.color || S.markColor, 'aria-label': 'Pin and edge colour' });
    const width = h('input', { type: 'range', min: 80, max: 700, step: 10, value: st.width, 'aria-label': 'Note width' });
    const widthVal = h('span', { class: 'val' }, `${st.width}px`);
    const zoom = h('input', { type: 'checkbox', checked: st.zoom });
    const preview = h('canvas', { width: 380, height: 120, style: { width: '100%', height: '120px', border: '1px solid var(--border)', borderRadius: '6px', background: '#fff' } });
    const read = () => ({
      text: text.value, font: font.value, size: Math.max(6, Math.min(72, Number(size.value) || 12)), bold: bold.checked,
      italic: italic.checked, textColor: textColor.value, fill: fill.value, color: pin.value, width: Number(width.value), zoom: zoom.checked,
    });
    const drawPreview = () => {
      const v = read();
      widthVal.textContent = `${v.width}px`;
      const c = preview.getContext('2d');
      c.clearRect(0, 0, preview.width, preview.height);
      noteBox(c, { ...v, text: v.text || 'Your note' }, 14, preview.height - 12, 1, false, preview.width - 30);
    };
    [text, font, size, bold, italic, textColor, fill, pin, width, zoom].forEach(el => el.addEventListener('input', drawPreview));
    [font, bold, italic, zoom].forEach(el => el.addEventListener('change', drawPreview));
    const row = (...kids) => h('div', { class: 'inline', style: { flexWrap: 'wrap', gap: '10px' } }, ...kids);
    const lbl = (t, el) => h('label', { class: 'inline', style: { fontSize: '12.5px', gap: '6px' } }, el, t);
    const buttons = [{ label: 'Cancel', value: null }];
    if (!isNew) buttons.push({ label: 'Delete', value: 'delete', danger: true });
    buttons.push({ label: isNew ? 'Add note' : 'Save', value: 'save', primary: true });
    const r = await modal({
      title: isNew ? 'New note' : 'Edit note',
      wide: true,
      body: [
        h('div', { class: 'field' }, h('label', null, 'Note'), text),
        h('div', { class: 'field-row' },
          h('div', { class: 'field' }, h('label', null, 'Font'), font),
          h('div', { class: 'field' }, h('label', null, 'Font size'), size)),
        row(lbl('Bold', bold), lbl('Italic', italic), lbl('Text', textColor), lbl('Note', fill), lbl('Pin / edge', pin)),
        h('div', { class: 'field' }, h('label', null, 'Note width'), h('div', { class: 'inline' }, width, widthVal),
          h('div', { class: 'hint' }, 'Long text wraps to this width. You can also drag the corner of a selected note.')),
        lbl('Grow and shrink with the plan when zooming (like text printed on the drawing)', zoom),
        h('div', { class: 'field' }, h('label', null, 'Preview'), preview),
        h('p', { class: 'note', style: { margin: 0 } }, 'Notes are listed in the Excel export. They are not counted as takeoff.'),
      ],
      buttons,
      validate: v => (v === 'save' && !text.value.trim() ? 'Write something, or press Cancel.' : null),
      onOpen: () => { drawPreview(); text.focus(); },
    });
    if (r === 'delete') { removeMark(note.id); return; }
    if (r !== 'save') return;
    const v = read();
    v.text = v.text.trim();
    const { text: _t, ...style } = v;
    rememberStyle({ ...style, color: undefined });
    const refS = viewer.view.s;
    if (isNew) mutate(p => { p.marks.push({ ...note, ...v, refS }); });
    else {
      mutate(() => {
        const m = markById(note.id);
        if (!m) return;
        const keepRef = m.zoom && v.zoom && m.refS;
        Object.assign(m, v, { refS: keepRef ? m.refS : refS });
      });
    }
    sel = note.id;
    viewer.render();
  }

  function removeMark(id) {
    mutate(p => { p.marks = p.marks.filter(m => m.id !== id); });
    if (sel === id) sel = null;
  }

  function markMenu(m, cx, cy) {
    sel = m.id;
    viewer.render();
    openMenu(cx, cy, [
      m.kind === 'note' && { label: 'Edit note (text, font, size, colours)', icon: 'rename', action: () => editNote(m, false) },
      m.kind === 'note' && m.height != null && { label: 'Fit note to text', icon: 'fit', action: () => fitToText(m) },
      { label: m.kind === 'note' ? 'Delete note' : 'Delete highlight', icon: 'trash', danger: true, action: () => removeMark(m.id) },
    ]);
  }

  // ---- drawing -------------------------------------------------------------------------------------
  function drawHighlight(ctx, pts, color, widthPx, selected) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.38;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(2, widthPx);
    if (pts.length === 1) {
      const [x, y] = viewer.toScr(pts[0]);
      ctx.beginPath();
      ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      viewer.path(ctx, pts, false);
      ctx.stroke();
    }
    if (selected) {
      ctx.globalAlpha = 1;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#1f5ae0';
      viewer.path(ctx, pts, false);
      ctx.stroke();
    }
    ctx.restore();
  }

  function wrap(ctx, text, maxW) {
    const lines = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const t = line ? `${line} ${word}` : word;
        if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = word; } else line = t;
      }
      lines.push(line);
    }
    return lines.slice(0, 40);
  }

  /** Draw a note box with its pin at (ax, ay) on screen; f scales everything (zoom-following notes). */
  function noteBox(ctx, m, ax, ay, f, selected, maxWidth = Infinity) {
    const st = styleOf(m);
    const fs = Math.max(4, st.size * f);
    const pad = Math.max(3, 8 * f);
    ctx.save();
    ctx.font = `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : ''}${fs}px "${st.font}", system-ui, sans-serif`;
    const maxW = Math.min(maxWidth, st.width * f);
    const sized = m.height != null;                         // sized by hand: keep the box exactly as drawn
    const lines = wrap(ctx, m.text || '', maxW - pad * 2 - 4);
    const w = sized ? maxW : Math.min(maxW, Math.max(40 * f, ...lines.map(l => ctx.measureText(l).width + pad * 2 + 4)));
    const lh = fs * 1.3;
    const textH = lines.length * lh + pad * 1.2;
    const hgt = Math.max(textH, sized ? m.height * f : 0);
    const ox = (m.ox ?? 10) * f, oy = (m.oy ?? -8) * f;
    const x = ax + ox, y = ay + oy - hgt;
    const color = st.color || '#ffd400';
    // leader from the pin to the nearest point of the box
    const lx = Math.max(x, Math.min(ax, x + w)), ly = Math.max(y, Math.min(ay, y + hgt));
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 2 * f);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ax, ay, selected ? Math.max(6, 6 * f) : Math.max(2.5, 5 * f), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = selected ? '#1f5ae0' : 'rgba(0,0,0,.45)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.stroke();
    ctx.shadowColor = 'rgba(0,0,0,.25)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = st.fill;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, hgt, 4 * f) : ctx.rect(x, y, w, hgt);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.max(2, 4 * f), hgt);
    ctx.strokeStyle = selected ? '#1f5ae0' : 'rgba(0,0,0,.3)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.stroke();
    ctx.fillStyle = st.textColor;
    ctx.textBaseline = 'top';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, hgt);
    ctx.clip();
    lines.forEach((l, i) => ctx.fillText(l, x + pad + 2, y + pad * 0.6 + i * lh));
    ctx.restore();
    const box = { x, y, w, h: hgt, textH, ax, ay, f };
    if (selected) {                       // outline with handles for sizing by hand
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#1f5ae0';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x - 4, y - 4, w + 8, hgt + 8);
      ctx.setLineDash([]);
      for (const [, hx, hy] of handlesOf(box)) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#1f5ae0';
        ctx.lineWidth = 1.5;
        ctx.fillRect(hx - 4.5, hy - 4.5, 9, 9);
        ctx.strokeRect(hx - 4.5, hy - 4.5, 9, 9);
      }
    }
    ctx.restore();
    return box;
  }

  const noteScale = m => (m.zoom && m.refS ? viewer.view.s / m.refS : 1);

  /** The 8 sizing handles around a drawn note box: [name, x, y]. */
  function handlesOf(b) {
    const x0 = b.x - 4, y0 = b.y - 4, x1 = b.x + b.w + 4, y1 = b.y + b.h + 4, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    return [['nw', x0, y0], ['n', xm, y0], ['ne', x1, y0], ['e', x1, ym], ['se', x1, y1], ['s', xm, y1], ['sw', x0, y1], ['w', x0, ym]];
  }
  const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };

  function handleAt(x, y) {
    if (!sel) return null;
    const m = markById(sel);
    const b = noteBoxes.get(sel);
    if (!b || m?.kind !== 'note') return null;
    const hit = handlesOf(b).find(([, hx, hy]) => Math.abs(hx - x) <= 7 && Math.abs(hy - y) <= 7);
    return hit ? { m, b, name: hit[0] } : null;
  }

  /** The note whose pin (the little circle) is under the cursor. */
  function pinAt(x, y) {
    for (const [id, b] of [...noteBoxes].reverse()) {
      if (Math.hypot(b.ax - x, b.ay - y) <= Math.max(8, 7 * b.f)) return markById(id);
    }
    return null;
  }

  function fitToText(m) {
    mutate(() => { const n = markById(m.id); if (n) { n.height = null; n.ox = null; n.oy = null; } });
  }

  function drawNote(ctx, m, selected) {
    const [ax, ay] = viewer.toScr(m.at);
    noteBoxes.set(m.id, noteBox(ctx, m, ax, ay, noteScale(m), selected));
  }

  // ---- add-on ----------------------------------------------------------------------------------------
  return viewer.use({
    tools: ['note', 'highlight'],

    drawUnder(ctx, page) {
      for (const m of marksOn(page)) {
        if (m.kind === 'highlight') drawHighlight(ctx, m.points, m.color, m.width * viewer.view.s, m.id === sel);
      }
      if (stroke && stroke.page === page.id) drawHighlight(ctx, stroke.points, stroke.color, stroke.width * viewer.view.s, false);
    },

    drawOver(ctx, page) {
      noteBoxes.clear();
      for (const m of marksOn(page)) if (m.kind === 'note') drawNote(ctx, m, m.id === sel);
      if (viewer.drag?.what === 'pin' && viewer.snapHit) {
        const [sx, sy] = viewer.toScr(viewer.snapHit);
        ctx.beginPath();
        ctx.arc(sx, sy, 9, 0, Math.PI * 2);
        ctx.strokeStyle = '#1f5ae0';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    },

    down(e, x, y) {
      const page = viewer.shownPage;
      const p = viewer.toImg(x, y).map(r2);
      if (S.tool === 'note') {
        if (!S.showMarks) { S.showMarks = true; document.dispatchEvent(new CustomEvent('plancraft:toggles')); }
        editNote({ id: uid('m'), page, kind: 'note', at: p, text: '', color: S.markColor }, true);
        return true;
      }
      if (!S.showMarks) { S.showMarks = true; document.dispatchEvent(new CustomEvent('plancraft:toggles')); }
      stroke = { id: uid('m'), page, kind: 'highlight', points: [p], color: S.markColor, width: r2(HL_SCREEN_WIDTH / viewer.view.s) };
      viewer.extDrag(this, e, { what: 'stroke', sx: x, sy: y });
      viewer.render();
      return true;
    },

    move(e, x, y, d) {
      if (!d) return false;
      if (d.what === 'stroke' && stroke) {
        const p = viewer.toImg(x, y).map(r2);
        if (e.shiftKey) stroke.points = [stroke.points[0], p];
        else {
          const last = viewer.toScr(stroke.points[stroke.points.length - 1]);
          if (Math.hypot(last[0] - x, last[1] - y) >= 3) stroke.points.push(p);
        }
        viewer.render();
      } else if (d.what === 'resize') {
        const m = markById(d.id);
        if (!m) return true;
        if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 2) return true;
        if (!d.moved) { d.moved = true; beginTx(); }
        const b = d.box;
        let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
        const dx = x - d.sx, dy = y - d.sy;
        if (d.name.includes('w')) x0 = Math.min(x1 - 40, b.x + dx);
        if (d.name.includes('e')) x1 = Math.max(x0 + 40, b.x + b.w + dx);
        if (d.name.includes('n')) y0 = Math.min(y1 - 20, b.y + dy);
        if (d.name.includes('s')) y1 = Math.max(y0 + 20, b.y + b.h + dy);
        const f = b.f;
        m.width = Math.round((x1 - x0) / f);
        m.height = Math.round((y1 - y0) / f);
        m.ox = Math.round((x0 - b.ax) / f);
        m.oy = Math.round((y1 - b.ay) / f);
        live();
      } else if (d.what === 'pin') {
        const m = markById(d.id);
        if (!m) return true;
        if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 2) return true;
        if (!d.moved) { d.moved = true; beginTx(); }
        const snap = S.snap && !e.ctrlKey ? viewer.findSnap(x, y) : null;     // land exactly on a takeoff point
        viewer.snapHit = snap;
        const at = snap ? snap.slice() : viewer.toImg(x, y);
        m.at = at.map(r2);
        const [px, py] = viewer.toScr(m.at);
        m.ox = Math.round(d.ox - (px - d.box.ax) / d.f);
        m.oy = Math.round(d.oy - (py - d.box.ay) / d.f);
        live();
      } else if (d.what === 'note') {
        const m = markById(d.id);
        if (!m) return true;
        if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 3) return true;
        if (!d.moved) { d.moved = true; beginTx(); }
        const dx = (x - d.sx) / viewer.view.s, dy = (y - d.sy) / viewer.view.s;
        m.at = [r2(d.orig[0] + dx), r2(d.orig[1] + dy)];
        live();
      }
      return true;
    },

    up(e, d) {
      if (d.what === 'stroke' && stroke) {
        const m = stroke;
        stroke = null;
        if (e.type === 'pointerup') mutate(p => { p.marks.push(m); });
        viewer.render();
      } else if ((d.what === 'note' || d.what === 'resize' || d.what === 'pin') && d.moved) {
        viewer.snapHit = null;
        commitTx();
      }
    },

    selectDown(e, x, y, phase) {
      const page = { id: viewer.shownPage };
      const pin = phase === 'before' ? pinAt(x, y) : null;
      if (pin) {
        sel = pin.id;
        viewer.extDrag(this, e, {
          what: 'pin', id: pin.id, sx: x, sy: y, f: noteScale(pin), ox: pin.ox ?? 10, oy: pin.oy ?? -8,
          box: noteBoxes.get(pin.id), moved: false,
        });
        viewer.render();
        return true;
      }
      if (phase === 'before' && sel) {
        const hit = handleAt(x, y);
        if (hit) {
          viewer.extDrag(this, e, { what: 'resize', id: hit.m.id, name: hit.name, box: { ...hit.b }, sx: x, sy: y, moved: false });
          return true;
        }
      }
      const m = phase === 'before' ? noteHit(x, y) : highlightHit(x, y, page);
      if (!m) {
        if (phase === 'after' && sel) { sel = null; viewer.render(); }
        return false;
      }
      sel = m.id;
      if (m.kind === 'note') viewer.extDrag(this, e, { what: 'note', id: m.id, sx: x, sy: y, orig: m.at.slice(), moved: false });
      viewer.render();
      return true;
    },

    hover(x, y) {
      if (S.tool !== 'select') return null;
      if (pinAt(x, y)) return 'crosshair';
      const hit = handleAt(x, y);
      return hit ? CURSORS[hit.name] : null;
    },

    dbl(e, x, y) {
      if (S.tool !== 'select' && S.tool !== 'note') return false;
      const m = noteHit(x, y);
      if (!m) return false;
      e.preventDefault();
      editNote(m, false);
      return true;
    },

    rightClick(cx, cy, x, y) {
      if (S.tool !== 'select' && S.tool !== 'note' && S.tool !== 'highlight') return false;
      const m = noteHit(x, y) || highlightHit(x, y, { id: viewer.shownPage });
      if (!m) return false;
      markMenu(m, cx, cy);
      return true;
    },

    key(e) {
      if (!sel) return false;
      if (e.key === 'Delete' || e.key === 'Backspace') { removeMark(sel); return true; }
      if (e.key === 'Escape') { sel = null; viewer.render(); return true; }
      return false;
    },

    hint() {
      if (S.tool === 'note') return 'Click where the note goes. Drag a note in the Select tool to move it; double-click to edit.';
      if (S.tool === 'highlight') return 'Drag to highlight. Hold Shift for a straight line. Pick the colour next to the tool.';
      if (sel && S.tool === 'select') return 'Drag the note to move it, drag the little circle to point it somewhere else, drag the handles to size it, double-click to edit. Delete removes it.';
      return null;
    },

    reset() {
      stroke = null;
      sel = null;
    },
  });
}

/** Turn plan notes / highlights on or off. */
export function toggleMarks() {
  S.showMarks = !S.showMarks;
  if (!S.showMarks && (S.tool === 'note' || S.tool === 'highlight')) setTool('select');
  toast(S.showMarks ? 'Notes and highlights shown.' : 'Notes and highlights hidden.');
}
