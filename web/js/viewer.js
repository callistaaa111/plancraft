// The plan viewer: draws the page and the takeoff, and handles drawing / editing on it.
import {
  S, on, ix, mutate, beginTx, live, commitTx, pageById, nodeById, currentPage, selectedItem, select, setTool,
} from './store.js';
import * as M from './measure.js';
import { pageUrl } from './api.js';
import { uid, fmt, clamp } from './util.js';
import { toast, openMenu } from './dialogs.js';

const MIN_SCALE = 0.01;
const MAX_SCALE = 16;
const SNAP_PX = 10;
const HIT_PX = 6;
const HANDLE_PX = 7;
const CACHE_PAGES = 3;

const r2 = v => Math.round(v * 100) / 100;

function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = clamp(t, 0, 1);
  return [Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t];
}

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.01) out.push(p);
  }
  return out;
}

/** Decode a page image off the main thread (img.decode() can stall while the tab is in the background). */
async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (window.createImageBitmap) return createImageBitmap(blob);
  const img = new Image();
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = URL.createObjectURL(blob); });
  return Object.assign(img, { close: () => URL.revokeObjectURL(img.src) });
}

export class Viewer {
  constructor(host, canvas) {
    this.host = host;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.view = { s: 1, tx: 0, ty: 0 };
    this.views = new Map();
    this.cache = new Map();
    this.hatches = new Map();
    this.mouse = null;
    this.cursorPt = null;
    this.snapHit = null;
    this.draft = null;
    this.measureDone = null;
    this.drag = null;
    this.countSec = null;
    this.space = false;
    this.shift = false;
    this.hover = null;
    this.shownPage = null;
    this.raf = 0;
    this.onScale = null;    // (pxDistance) => void, set by main
    this.onCrop = null;     // ({x, y, w, h}) => void, set by main
    this.cropRect = null;
    this.onView = null;     // () => void after zoom/pan
    this.ext = [];          // add-ons (markup, auto count, compare): see use()

    new ResizeObserver(() => this.resize()).observe(host);
    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', e => this.onUp(e));
    canvas.addEventListener('pointerleave', () => { this.mouse = null; this.cursorPt = null; this.snapHit = null; this.render(); });
    canvas.addEventListener('dblclick', e => this.onDbl(e));
    canvas.addEventListener('contextmenu', e => this.onContext(e));
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });

    on('load', () => { this.clearCache(); this.views.clear(); this.shownPage = null; this.draft = null; this.countSec = null; this.measureDone = null; this.showPage(); });
    on('page', () => this.showPage());
    on('change', () => { if (this.shownPage !== S.pageId || !pageById(this.shownPage)) this.showPage(); this.render(); });
    on('live', () => this.render());
    on('select', () => this.render());
    on('tool', () => { if (S.tool !== 'takeoff') this.countSec = null; this.draft = null; this.cropRect = null; this.ext.forEach(x => x.reset?.('tool')); this.canvas.style.cursor = ''; this.updateCursor(); this.render(); });
  }

  /**
   * Add-ons hook into drawing and input. Optional members: tools (tool names they own), drawPage(ctx, page) -> true if
   * they drew the page image themselves, drawUnder / drawOver(ctx, page), down / move / dbl(e, x, y) -> handled,
   * up(e), selectDown(e, x, y, 'before' | 'after') -> handled, rightClick(clientX, clientY, x, y) -> handled,
   * key(e) -> handled, hint() -> text, reset(why).
   */
  use(ext) {
    this.ext.push(ext);
    return ext;
  }

  extTool() { return this.ext.find(x => x.tools?.includes(S.tool)) || null; }

  // ---- geometry --------------------------------------------------------------------------------------
  toImg(sx, sy) { const v = this.view; return [(sx - v.tx) / v.s, (sy - v.ty) / v.s]; }
  toScr(p) { const v = this.view; return [p[0] * v.s + v.tx, p[1] * v.s + v.ty]; }
  local(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  pageSize(page) {
    const e = this.cache.get(page.id);
    return [page.width || e?.iw || 1000, page.height || e?.ih || 700];
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const firstSize = this.w <= 1;   // first layout, or the workspace was hidden
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    if (firstSize && this.shownPage) this.fit();
    if (this.pendingShow && this.w >= 120 && this.h >= 120) this.showPoints(this.pendingShow);
    this.renderNow();
  }

  // ---- pages & images ----------------------------------------------------------------------------------
  showPage() {
    if (this.shownPage) this.views.set(this.shownPage, { ...this.view });
    const page = currentPage();
    this.draft = null;
    this.countSec = null;
    this.measureDone = null;
    this.cropRect = null;
    this.ext.forEach(x => x.reset?.('page'));
    this.shownPage = page?.id || null;
    if (!page) { this.render(); return; }
    const v = this.views.get(page.id);
    if (v) this.view = { ...v };
    else this.fit();
    this.ensureImage(page);
    this.render();
  }

  fit() {
    const page = currentPage();
    if (!page || !this.w) return;
    const [W, H] = this.pageSize(page);
    const pad = 24;
    const s = clamp(Math.min((this.w - pad * 2) / W, (this.h - pad * 2) / H), MIN_SCALE, MAX_SCALE);
    this.view = { s, tx: (this.w - W * s) / 2, ty: (this.h - H * s) / 2 };
    this.onView?.();
    this.render();
  }

  zoomAt(factor, sx = this.w / 2, sy = this.h / 2) {
    const v = this.view;
    const s = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
    const k = s / v.s;
    this.view = { s, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k };
    if (this.mouse) this.updateCursorPt();
    this.onView?.();
    this.render();
  }

  zoomPercent() { return Math.round(this.view.s * 100); }

  clearCache() {
    for (const e of this.cache.values()) { e.mips.forEach(m => m.bmp.close?.()); e.img?.close?.(); }
    this.cache.clear();
  }

  async ensureImage(page) {
    let e = this.cache.get(page.id);
    if (e) { this.cache.delete(page.id); this.cache.set(page.id, e); return; }   // LRU: move to the end
    e = { img: null, mips: [], loading: true, error: null };
    this.cache.set(page.id, e);
    this.evict();
    try {
      e.img = await loadBitmap(pageUrl(S.project.id, page));
      e.iw = e.img.width;
      e.ih = e.img.height;
    } catch {
      e.error = 'This page image could not be loaded.';
    }
    e.loading = false;
    if (this.shownPage === page.id && !page.width) this.fit();
    this.render();
    if (e.img && window.createImageBitmap) this.buildMips(e).catch(() => {});
  }

  async buildMips(e) {
    let src = e.img;
    let w = e.iw, h = e.ih;
    while (w > 1800) {
      w = Math.round(w / 2);
      h = Math.round(h / 2);
      const bmp = await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      if (![...this.cache.values()].includes(e)) { bmp.close(); return; }
      e.mips.unshift({ bmp, w, h });   // smallest first
      src = bmp;
      this.render();
    }
  }

  evict() {
    while (this.cache.size > CACHE_PAGES) {
      const [id, e] = this.cache.entries().next().value;
      if (id === this.shownPage) break;
      e.mips.forEach(m => m.bmp.close?.());
      e.img?.close?.();
      this.cache.delete(id);
    }
  }

  // ---- rendering ---------------------------------------------------------------------------------------
  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.renderNow(); });
  }

  renderNow() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const page = currentPage();
    if (!page || !S.project) return;
    const { s, tx, ty } = this.view;
    const [W, H] = this.pageSize(page);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.25)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#fff';
    ctx.fillRect(tx, ty, W * s, H * s);
    ctx.restore();

    const e = this.cache.get(page.id);
    if (this.ext.some(x => x.drawPage?.(ctx, page))) { /* drawn by an add-on (revision overlay) */ }
    else if (e?.img) {
      const want = W * s * this.dpr;
      let src = e.img, sw = e.iw;
      for (const m of e.mips) if (m.w >= want) { src = m.bmp; sw = m.w; break; }
      const f = sw / W;
      const x0 = clamp(-tx / s, 0, W), y0 = clamp(-ty / s, 0, H);
      const x1 = clamp((this.w - tx) / s, 0, W), y1 = clamp((this.h - ty) / s, 0, H);
      if (x1 > x0 && y1 > y0) {
        ctx.imageSmoothingEnabled = s * this.dpr / f < 3;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, x0 * f, y0 * f, (x1 - x0) * f, (y1 - y0) * f, tx + x0 * s, ty + y0 * s, (x1 - x0) * s, (y1 - y0) * s);
      }
    } else {
      ctx.fillStyle = '#888';
      ctx.font = '14px Segoe UI, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(e?.error || 'Loading page...', clamp(tx + W * s / 2, 80, this.w - 80), clamp(ty + H * s / 2, 30, this.h - 30));
      ctx.textAlign = 'left';
    }

    for (const x of this.ext) x.drawUnder?.(ctx, page);
    this.drawTakeoff(page);
    this.drawDraft(page);
    this.drawCrop(page);
    for (const x of this.ext) x.drawOver?.(ctx, page);
    this.updateStatus(page);
  }

  visibleSections(page) {
    const x = ix();
    const out = { area: [], linear: [], count: [] };
    for (const it of x.items) {
      if (x.nodes.get(it.id)?.hidden) continue;
      for (const sec of it.sections) if (sec.page === page.id) out[it.type]?.push([it, sec]);
    }
    return out;
  }

  drawTakeoff(page) {
    const ctx = this.ctx;
    const vis = this.visibleSections(page);
    const selId = S.sel?.type === 'item' ? S.sel.id : null;
    const secSel = S.secSel;
    const later = [];
    const order = ['area', 'linear', 'count'];
    for (const t of order) {
      for (const [it, sec] of vis[t]) {
        if (it.id === selId) { later.push([it, sec]); continue; }
        this.drawSection(ctx, it, sec, false, false);
      }
    }
    for (const [it, sec] of later) this.drawSection(ctx, it, sec, true, secSel?.secId === sec.id);
    if (S.labels) {
      for (const t of ['area', 'linear']) for (const [it, sec] of vis[t]) this.drawSectionLabel(ctx, it, sec, page);
    }
    if (secSel) {
      const it = nodeById(secSel.itemId);
      const sec = it?.sections.find(s => s.id === secSel.secId);
      if (sec && sec.page === page.id && it.type !== 'count') this.drawHandles(ctx, it, sec);
    }
  }

  path(ctx, pts, close) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = this.toScr(pts[i]);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    if (close) ctx.closePath();
  }

  hatch(color) {
    let p = this.hatches.get(color);
    if (!p) {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const x = c.getContext('2d');
      x.strokeStyle = color;
      x.lineWidth = 1.4;
      x.beginPath();
      x.moveTo(0, 8); x.lineTo(8, 0);
      x.moveTo(-2, 2); x.lineTo(2, -2);
      x.moveTo(6, 10); x.lineTo(10, 6);
      x.stroke();
      p = this.ctx.createPattern(c, 'repeat');
      this.hatches.set(color, p);
    }
    return p;
  }

  drawSection(ctx, it, sec, selItem, selSec) {
    const pts = sec.points;
    const color = it.color || '#e6194b';
    const pr = it.props || {};
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (it.type === 'linear') {
      if (pts.length < 2) return;
      const lw = clamp(Number(pr.lineWidth) || 3, 1, 16);
      this.path(ctx, pts, false);
      if (selItem) {
        ctx.strokeStyle = selSec ? 'rgba(31,90,224,.55)' : 'rgba(255,255,255,.95)';
        ctx.lineWidth = lw + (selSec ? 7 : 5);
        ctx.stroke();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.stroke();
    } else if (it.type === 'area') {
      if (pts.length < 3) return;
      this.path(ctx, pts, true);
      ctx.globalAlpha = clamp(Number(pr.opacity) || 0.3, 0.05, 0.9);
      ctx.fillStyle = sec.deduct ? this.hatch(color) : color;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (selItem) {
        ctx.strokeStyle = selSec ? 'rgba(31,90,224,.55)' : 'rgba(255,255,255,.95)';
        ctx.lineWidth = selSec ? 7 : 5;
        ctx.setLineDash([]);
        ctx.stroke();
      }
      ctx.setLineDash(sec.deduct ? [6, 4] : []);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (it.type === 'count') {
      const r = this.markerRadius(it);
      const selPt = selSec ? S.secSel.pt : null;
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = this.toScr(pts[i]);
        if (x < -r * 2 || y < -r * 2 || x > this.w + r * 2 || y > this.h + r * 2) continue;
        this.marker(ctx, pr.shape, x, y, r, color, selItem);
        if (selSec && (selPt === i || selPt == null)) {
          ctx.beginPath();
          ctx.arc(x, y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = '#1f5ae0';
          ctx.lineWidth = selPt === i ? 2.5 : 1.5;
          ctx.stroke();
        }
      }
    }
  }

  /** Count markers grow a little as you zoom in and shrink when zoomed out, so dense counts stay readable. */
  markerRadius(it) {
    const size = clamp(Number(it.props?.size) || 9, 3, 30);
    return size * clamp(Math.sqrt(this.view.s / 0.4), 0.45, 1.6);
  }

  marker(ctx, shape, x, y, r, color, emphasise) {
    ctx.beginPath();
    switch (shape) {
      case 'square': ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8); break;
      case 'triangle': ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r, y + r * 0.85); ctx.lineTo(x - r, y + r * 0.85); ctx.closePath(); break;
      case 'diamond': ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.2, y); ctx.lineTo(x, y + r * 1.2); ctx.lineTo(x - r * 1.2, y); ctx.closePath(); break;
      case 'star':
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + i * Math.PI / 5;
          const rr = i % 2 ? r * 0.5 : r * 1.2;
          if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        ctx.closePath();
        break;
      case 'cross':
        ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = r * 0.7 + 3; ctx.stroke();
        ctx.strokeStyle = color; ctx.lineWidth = r * 0.7; ctx.stroke();
        return;
      default: ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = emphasise ? '#111' : '#fff';
    ctx.lineWidth = emphasise ? 2 : 1.5;
    ctx.stroke();
  }

  drawHandles(ctx, it, sec) {
    const hs = HANDLE_PX;
    sec.points.forEach((p, i) => {
      const [x, y] = this.toScr(p);
      ctx.fillStyle = S.secSel?.pt === i ? '#1f5ae0' : '#fff';
      ctx.strokeStyle = '#1f5ae0';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
    });
  }

  label(ctx, text, x, y, { bg = 'rgba(255,255,255,.92)', fg = '#111', border = 'rgba(0,0,0,.25)', align = 'left' } = {}) {
    ctx.font = '600 12px Segoe UI, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 12;
    const hgt = 20;
    let lx = align === 'center' ? x - w / 2 : x;
    lx = clamp(lx, 2, this.w - w - 2);
    const ly = clamp(y, 2, this.h - hgt - 2);
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(lx, ly, w, hgt, 4) : ctx.rect(lx, ly, w, hgt);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + 6, ly + hgt / 2 + 0.5);
    ctx.textBaseline = 'alphabetic';
  }

  drawSectionLabel(ctx, it, sec, page) {
    const pts = sec.points;
    let at;
    if (it.type === 'area') {
      at = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    } else {
      let best = -1;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = M.dist(pts[i], pts[i + 1]);
        if (d > best) { best = d; at = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]; }
      }
    }
    if (!at) return;
    const [x, y] = this.toScr(at);
    if (x < -50 || y < -20 || x > this.w + 50 || y > this.h + 20) return;
    const u = M.UNITS[S.project.units];
    let q = it.type === 'area' ? M.areaOf(M.polyArea(pts), page, S.project.units) : M.lengthOf(M.polyLength(pts), page, S.project.units);
    if (q != null && sec.deduct) q = -q;
    const qtxt = q == null ? '' : `  ${fmt(q)} ${it.type === 'area' ? u.area : u.len}`;
    this.label(ctx, `${it.name}${qtxt}`, x, y - 10, { align: 'center', border: it.color });
  }

  drawDraft(page) {
    const ctx = this.ctx;
    const units = S.project.units;
    const u = M.UNITS[units];
    if (this.measureDone && !this.draft) {
      const pts = this.measureDone.pts;
      this.path(ctx, pts, false);
      ctx.strokeStyle = '#ff6a00';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      const len = M.lengthOf(M.polyLength(pts), page, units);
      const [x, y] = this.toScr(pts[pts.length - 1]);
      this.label(ctx, len == null ? 'No scale on this page' : `${fmt(len)} ${u.len}`, x + 10, y + 8, { bg: '#ff6a00', fg: '#fff', border: '#ff6a00' });
    }
    const d = this.draft;
    if (d && d.pts.length) {
      const cur = this.cursorPt && !this.drag ? this.cursorPt : null;
      const pts = cur ? d.pts.concat([cur]) : d.pts;
      let color = '#ff6a00', lw = 2.5;
      if (d.kind === 'takeoff') {
        const it = nodeById(d.itemId);
        color = it?.color || color;
        lw = clamp(Number(it?.props?.lineWidth) || 3, 1, 16);
      } else if (d.kind === 'scale') color = '#d6008f';
      if (d.kind === 'takeoff' && d.type === 'area' && pts.length >= 3) {
        this.path(ctx, pts, true);
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = d.deduct ? this.hatch(color) : color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      this.path(ctx, d.pts, false);
      ctx.strokeStyle = color;
      ctx.lineWidth = d.kind === 'takeoff' && d.type === 'area' ? 2 : lw;
      ctx.setLineDash(d.deduct ? [6, 4] : []);
      ctx.stroke();
      if (cur) {
        ctx.beginPath();
        const a = this.toScr(d.pts[d.pts.length - 1]), b = this.toScr(cur);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        if (d.type === 'area' && d.pts.length >= 2) { const f = this.toScr(d.pts[0]); ctx.lineTo(f[0], f[1]); }
        ctx.setLineDash([6, 5]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const p of d.pts) {
        const [x, y] = this.toScr(p);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (cur) {
        const [x, y] = this.toScr(cur);
        this.label(ctx, this.liveText(page) || '', x + 14, y + 14);
      }
    }
    if (this.snapHit && (this.draft || S.tool === 'takeoff' || this.drag?.mode === 'vertex')) {
      const [x, y] = this.toScr(this.snapHit);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = '#1f5ae0';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  drawCrop(page) {
    const r = this.cropRect;
    if (!r) return;
    const ctx = this.ctx;
    const [W, H] = this.pageSize(page);
    const a = this.toScr([r.x, r.y]), b = this.toScr([r.x + r.w, r.y + r.h]);
    const p0 = this.toScr([0, 0]), p1 = this.toScr([W, H]);
    ctx.save();
    ctx.fillStyle = 'rgba(15, 20, 30, .45)';
    ctx.beginPath();
    ctx.rect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]);
    ctx.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.fill('evenodd');
    ctx.setLineDash([7, 4]);
    ctx.strokeStyle = '#1f5ae0';
    ctx.lineWidth = 2;
    ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.restore();
    const units = S.project.units;
    const wm = M.lengthOf(r.w, page, units), hm = M.lengthOf(r.h, page, units);
    const text = wm != null ? `${fmt(wm)} x ${fmt(hm)} ${M.UNITS[units].len}` : `${Math.round(r.w)} x ${Math.round(r.h)} px`;
    this.label(ctx, text, a[0], b[1] + 6, { bg: '#1f5ae0', fg: '#fff', border: '#1f5ae0' });
  }

  clearCrop() {
    this.cropRect = null;
    this.render();
  }

  liveText(page) {
    const d = this.draft;
    if (!d || !d.pts.length) return '';
    const units = S.project.units;
    const u = M.UNITS[units];
    const cur = this.cursorPt;
    const pts = cur ? d.pts.concat([cur]) : d.pts;
    if (d.kind === 'scale') {
      return pts.length >= 2 ? `${fmt(M.dist(pts[0], pts[1]), 0)} px - click the other end` : 'Click the other end';
    }
    if (!M.pxPerM(page)) return d.type === 'count' ? '' : 'No scale on this page';
    if (d.kind === 'takeoff' && d.type === 'area') {
      const a = M.areaOf(M.polyArea(pts), page, units);
      return `${d.deduct ? 'Deduct ' : ''}${fmt(a)} ${u.area}`;
    }
    const total = M.lengthOf(M.polyLength(pts), page, units);
    const seg = cur && d.pts.length ? M.lengthOf(M.dist(d.pts[d.pts.length - 1], cur), page, units) : null;
    return seg != null && pts.length > 2 ? `${fmt(seg)} ${u.len}  ·  total ${fmt(total)} ${u.len}` : `${fmt(total)} ${u.len}`;
  }

  updateStatus(page) {
    const live = document.getElementById('stLive');
    const hint = document.getElementById('stHint');
    if (live) live.textContent = this.liveText(page);
    if (hint) hint.textContent = this.hintText();
  }

  hintText() {
    for (const x of this.ext) { const h = x.hint?.(); if (h) return h; }
    const it = selectedItem();
    switch (S.tool) {
      case 'takeoff':
        if (!it) return 'Select or create an item in the Takeoff list, then click on the plan.';
        if (it.type === 'count') return this.countSec ? `Counting "${it.name}": click each one. Enter or right-click when done.` : `Click on the plan to count "${it.name}".`;
        if (this.draft) return `Click to add points. Double-click, Enter or right-click to finish${it.type === 'area' ? ' (or click the first point)' : ''}. Hold right button to pan. Backspace removes the last point.`;
        return `Click on the plan to start "${it.name}". Hold Shift for straight runs, hold right button to pan.`;
      case 'measure':
        return this.draft ? 'Click to add points, double-click or Enter to finish. Nothing is saved.' : 'Click points to measure a distance (not saved).';
      case 'scale':
        return this.draft ? 'Click the other end of the known length.' : 'Click both ends of a dimension whose length you know.';
      case 'crop':
        return 'Drag a box around the area you want as a new page. Esc cancels.';
      default:
        if (S.secSel) return 'Drag points to adjust. Alt+click a point to remove it, double-click a line to add one. Delete removes the selection.';
        return 'Click a takeoff to select it. Drag or hold right button to pan, scroll to zoom.';
    }
  }

  // ---- hit testing -----------------------------------------------------------------------------------
  hitTest(sx, sy) {
    const page = currentPage();
    if (!page) return null;
    const vis = this.visibleSections(page);
    const p = [sx, sy];
    for (const [it, sec] of [...vis.count].reverse()) {
      const r = this.markerRadius(it) + 3;
      for (let j = sec.points.length - 1; j >= 0; j--) {
        const q = this.toScr(sec.points[j]);
        if (Math.hypot(q[0] - sx, q[1] - sy) <= r) return { item: it, sec, pt: j };
      }
    }
    for (const t of ['linear', 'area']) {
      for (const [it, sec] of [...vis[t]].reverse()) {
        const lw = t === 'linear' ? clamp(Number(it.props?.lineWidth) || 3, 1, 16) : 2;
        const tol = Math.max(HIT_PX, lw / 2 + 3);
        const pts = sec.points.map(q => this.toScr(q));
        const n = t === 'area' ? pts.length : pts.length - 1;
        for (let i = 0; i < n; i++) {
          if (distToSeg(p, pts[i], pts[(i + 1) % pts.length])[0] <= tol) return { item: it, sec, seg: i };
        }
      }
    }
    const ip = this.toImg(sx, sy);
    for (const [it, sec] of [...vis.area].reverse()) if (pointInPoly(ip, sec.points)) return { item: it, sec };
    return null;
  }

  selectedSection() {
    const ss = S.secSel;
    if (!ss) return null;
    const it = nodeById(ss.itemId);
    const sec = it?.sections.find(s => s.id === ss.secId);
    return sec && sec.page === S.pageId ? { it, sec } : null;
  }

  vertexHit(sx, sy) {
    const sel = this.selectedSection();
    if (!sel || sel.it.type === 'count') return null;
    const pts = sel.sec.points;
    for (let i = pts.length - 1; i >= 0; i--) {
      const q = this.toScr(pts[i]);
      if (Math.abs(q[0] - sx) <= HANDLE_PX && Math.abs(q[1] - sy) <= HANDLE_PX) return { itemId: sel.it.id, secId: sel.sec.id, pt: i };
    }
    return null;
  }

  findSnap(sx, sy, exclude = null) {
    const page = currentPage();
    if (!page) return null;
    let best = null, bd = SNAP_PX;
    const test = (q, skip) => {
      if (skip) return;
      const s = this.toScr(q);
      const d = Math.hypot(s[0] - sx, s[1] - sy);
      if (d < bd) { bd = d; best = q; }
    };
    const vis = this.visibleSections(page);
    for (const t of ['linear', 'area', 'count']) {
      for (const [, sec] of vis[t]) {
        sec.points.forEach((q, i) => test(q, exclude && exclude.secId === sec.id && exclude.pt === i));
      }
    }
    if (this.draft) this.draft.pts.forEach(q => test(q));
    return best;
  }

  /** The image point under the cursor, after snapping and ortho. */
  pointFor(sx, sy, e, prev = this.draft?.pts[this.draft.pts.length - 1], exclude = null) {
    let p = this.toImg(sx, sy);
    this.snapHit = null;
    const ortho = prev && (S.ortho || e?.shiftKey || this.shift);
    let axis = null;
    if (ortho) axis = Math.abs(p[0] - prev[0]) >= Math.abs(p[1] - prev[1]) ? 'h' : 'v';
    const snap = S.snap && !e?.ctrlKey ? this.findSnap(sx, sy, exclude) : null;
    if (snap) {
      this.snapHit = snap;
      p = snap.slice();
    }
    if (axis === 'h') p = [p[0], prev[1]];
    else if (axis === 'v') p = [prev[0], p[1]];
    return [r2(p[0]), r2(p[1])];
  }

  updateCursorPt(e) {
    if (!this.mouse) return;
    const drawing = S.tool === 'takeoff' || S.tool === 'measure' || S.tool === 'scale';
    this.cursorPt = drawing ? this.pointFor(this.mouse.x, this.mouse.y, e) : null;
    if (!drawing && !this.drag) this.snapHit = null;
  }

  updateCursor() {
    const c = this.host.classList;
    c.remove('c-pan', 'c-panning', 'c-draw', 'c-move', 'c-pointer');
    if (this.drag?.mode === 'pan') c.add('c-panning');
    else if (this.space) c.add('c-pan');
    else if (S.tool === 'takeoff' || S.tool === 'measure' || S.tool === 'scale' || S.tool === 'crop' || this.extTool()) c.add('c-draw');
    else if (this.hover === 'vertex' || this.drag) c.add('c-move');
    else if (this.hover) c.add('c-pointer');
  }

  // ---- pointer input ---------------------------------------------------------------------------------
  onDown(e) {
    if (!S.project || !currentPage()) return;
    const { x, y } = this.local(e);
    this.mouse = { x, y };
    // hold the right (or middle) button to pan, also in the middle of a takeoff; a right-click without moving
    // still finishes the run / opens the menu (handled on release)
    if (e.button === 2) { e.preventDefault(); this.startPan(e, x, y, { right: true, cx: e.clientX, cy: e.clientY }); return; }
    if (e.button === 1 || (e.button === 0 && this.space)) { e.preventDefault(); this.startPan(e, x, y); return; }
    if (e.button !== 0) return;
    const ext = this.extTool();
    if (ext) { ext.down?.(e, x, y); return; }
    if (S.tool === 'select') this.selectDown(e, x, y);
    else if (S.tool === 'takeoff') this.takeoffDown(e, x, y);
    else if (S.tool === 'measure' || S.tool === 'scale') this.pointToolDown(e, x, y);
    else if (S.tool === 'crop') this.cropDown(e, x, y);
  }

  cropDown(e, x, y) {
    const [W, H] = this.pageSize(currentPage());
    const p = this.toImg(x, y);
    this.cropRect = null;
    this.drag = { mode: 'crop', sx: x, sy: y, start: [clamp(p[0], 0, W), clamp(p[1], 0, H)], moved: false };
    this.capture(e);
  }

  capture(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }

  startPan(e, x, y, extra = {}) {
    this.drag = { mode: 'pan', sx: x, sy: y, tx0: this.view.tx, ty0: this.view.ty, moved: false, ...extra };
    this.capture(e);
    this.updateCursor();
  }

  /** Start a drag that an add-on handles (its move / up get the events). */
  extDrag(ext, e, data = {}) {
    this.drag = { mode: 'ext', ext, ...data };
    this.capture(e);
  }

  selectDown(e, x, y) {
    if (this.ext.some(xt => xt.selectDown?.(e, x, y, 'before'))) return;
    const vh = this.vertexHit(x, y);
    if (vh) {
      if (e.altKey) { this.deleteVertex(vh); return; }
      select(S.sel, { ...vh });
      this.drag = { mode: 'vertex', ...vh, sx: x, sy: y, moved: false };
      this.capture(e);
      return;
    }
    const hit = this.hitTest(x, y);
    if (hit) {
      const already = S.secSel?.secId === hit.sec.id;
      select({ type: 'item', id: hit.item.id }, { itemId: hit.item.id, secId: hit.sec.id, pt: hit.pt ?? null });
      if (hit.pt != null) this.drag = { mode: 'vertex', itemId: hit.item.id, secId: hit.sec.id, pt: hit.pt, sx: x, sy: y, moved: false };
      else if (already) this.drag = { mode: 'section', itemId: hit.item.id, secId: hit.sec.id, sx: x, sy: y, moved: false, orig: hit.sec.points.map(p => p.slice()) };
      else this.drag = { mode: 'none', sx: x, sy: y };
      this.capture(e);
      return;
    }
    if (this.ext.some(xt => xt.selectDown?.(e, x, y, 'after'))) return;
    if (S.secSel) select(S.sel, null);
    this.startPan(e, x, y);
  }

  takeoffDown(e, x, y) {
    const it = selectedItem();
    if (!it) { toast('Select an item in the Takeoff list first, or create one with + Linear / + Area / + Count.'); return; }
    if (ix().nodes.get(it.id)?.hidden) { toast(`"${it.name}" is hidden. Show it (eye icon) to take off.`); return; }
    const p = this.pointFor(x, y, e, it.type === 'count' ? undefined : this.draft?.pts[this.draft.pts.length - 1]);
    if (it.type === 'count') { this.addCount(it, p); return; }
    if (!this.draft || this.draft.itemId !== it.id) {
      this.draft = { kind: 'takeoff', itemId: it.id, type: it.type, pts: [], deduct: it.type === 'area' && S.deduct };
    }
    const d = this.draft;
    if (d.type === 'area' && d.pts.length >= 3) {
      const f = this.toScr(d.pts[0]);
      if (Math.hypot(f[0] - x, f[1] - y) <= SNAP_PX) { this.finishDraft(); return; }
    }
    const last = d.pts[d.pts.length - 1];
    if (last) {
      const ls = this.toScr(last), ps = this.toScr(p);
      if (Math.hypot(ls[0] - ps[0], ls[1] - ps[1]) < 2) return;   // second click of a double-click
    }
    d.pts.push(p);
    this.render();
  }

  addCount(it, p) {
    const cs = this.countSec;
    let sec = cs && cs.itemId === it.id && cs.pageId === S.pageId ? it.sections.find(s => s.id === cs.secId) : null;
    mutate(() => {
      if (!sec) {
        sec = { id: uid('s'), page: S.pageId, points: [] };
        it.sections.push(sec);
        this.countSec = { itemId: it.id, secId: sec.id, pageId: S.pageId };
      }
      sec.points.push(p);
    });
  }

  pointToolDown(e, x, y) {
    if (S.tool === 'measure' && this.measureDone && !this.draft) this.measureDone = null;
    if (!this.draft || this.draft.kind !== S.tool) this.draft = { kind: S.tool, pts: [] };
    const p = this.pointFor(x, y, e);
    const d = this.draft;
    const last = d.pts[d.pts.length - 1];
    if (last) {
      const ls = this.toScr(last), ps = this.toScr(p);
      if (Math.hypot(ls[0] - ps[0], ls[1] - ps[1]) < 2) return;
    }
    d.pts.push(p);
    if (d.kind === 'scale' && d.pts.length === 2) {
      const px = M.dist(d.pts[0], d.pts[1]);
      this.render();
      setTimeout(() => this.onScale?.(px), 30);
      return;
    }
    this.render();
  }

  onMove(e) {
    const { x, y } = this.local(e);
    this.mouse = { x, y };
    this.shift = e.shiftKey;
    const d = this.drag;
    if (d?.mode === 'ext') { d.ext.move?.(e, x, y, d); return; }
    if (!d && this.extTool()?.move?.(e, x, y)) return;
    if (d) {
      if (d.mode === 'pan') {
        if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 4) return;   // a click, not a drag (yet)
        d.moved = true;
        this.view.tx = d.tx0 + (x - d.sx);
        this.view.ty = d.ty0 + (y - d.sy);
        if (this.draft) this.updateCursorPt(e);   // keep the rubber band under the cursor
        this.onView?.();
        this.render();
        return;
      }
      if (d.mode === 'crop') {
        if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 4) return;
        d.moved = true;
        const [W, H] = this.pageSize(currentPage());
        const p = this.toImg(x, y);
        const q = [clamp(p[0], 0, W), clamp(p[1], 0, H)];
        this.cropRect = { x: Math.min(d.start[0], q[0]), y: Math.min(d.start[1], q[1]), w: Math.abs(q[0] - d.start[0]), h: Math.abs(q[1] - d.start[1]) };
        this.render();
        return;
      }
      if (d.mode === 'none') return;
      if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 3) return;
      const it = nodeById(d.itemId);
      const sec = it?.sections.find(s => s.id === d.secId);
      if (!sec) return;
      if (!d.moved) { d.moved = true; beginTx(); this.updateCursor(); }
      if (d.mode === 'vertex') {
        const prev = it.type === 'count' ? undefined : sec.points[d.pt - 1];
        sec.points[d.pt] = this.pointFor(x, y, e, prev, { secId: sec.id, pt: d.pt });
      } else if (d.mode === 'section') {
        const dx = (x - d.sx) / this.view.s, dy = (y - d.sy) / this.view.s;
        d.orig.forEach((p, i) => { sec.points[i] = [r2(p[0] + dx), r2(p[1] + dy)]; });
      }
      live();
      return;
    }
    if (S.tool === 'select') {
      const extCursor = this.ext.map(xt => xt.hover?.(x, y)).find(Boolean) || '';
      if (this.canvas.style.cursor !== extCursor) this.canvas.style.cursor = extCursor;
      const prevHover = this.hover;
      this.hover = this.vertexHit(x, y) ? 'vertex' : this.hitTest(x, y) ? 'item' : null;
      if (prevHover !== this.hover) this.updateCursor();
      return;
    }
    this.updateCursorPt(e);
    this.render();
  }

  onUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d.mode === 'ext') d.ext.up?.(e, d);
    else if (d.mode === 'pan') {
      if (d.right && !d.moved && e.type === 'pointerup') this.rightClick(d.cx, d.cy);
    } else if (d.mode === 'crop') {
      const r = this.cropRect;
      if (r && r.w * this.view.s >= 8 && r.h * this.view.s >= 8 && e.type === 'pointerup') this.onCrop?.({ ...r });
      else { this.cropRect = null; if (e.type === 'pointerup') toast('Drag a box around the area you want as a new page.'); }
    } else if (d.moved) commitTx();
    this.snapHit = null;
    this.updateCursor();
    this.render();
  }

  onDbl(e) {
    const { x: lx, y: ly } = this.local(e);
    if (this.ext.some(xt => xt.dbl?.(e, lx, ly))) return;
    if (S.tool === 'takeoff' || S.tool === 'measure') { e.preventDefault(); this.finishDraft(); return; }
    if (S.tool === 'select') {
      const sel = this.selectedSection();
      if (!sel || sel.it.type === 'count') return;
      const { x, y } = this.local(e);
      const pts = sel.sec.points.map(q => this.toScr(q));
      const closed = sel.it.type === 'area';
      const n = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const [d, t] = distToSeg([x, y], pts[i], pts[(i + 1) % pts.length]);
        if (d <= HIT_PX + 2 && t > 0.02 && t < 0.98) {
          const p = this.toImg(x, y);
          mutate(() => sel.sec.points.splice(i + 1, 0, [r2(p[0]), r2(p[1])]));
          select(S.sel, { itemId: sel.it.id, secId: sel.sec.id, pt: i + 1 });
          return;
        }
      }
    }
  }

  onContext(e) {
    e.preventDefault();   // right button is handled on pointerdown/up (drag = pan, click = rightClick)
  }

  /** A right-click that did not move: finish the current run, or offer actions on a takeoff. */
  rightClick(clientX, clientY) {
    if (this.draft || this.countSec) { this.finishDraft(); return; }
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    if (this.ext.some(xt => xt.rightClick?.(clientX, clientY, x, y))) return;
    if (S.tool !== 'select') return;
    const vh = this.vertexHit(x, y);
    const hit = vh ? null : this.hitTest(x, y);
    if (!vh && !hit) return;
    const itemId = vh ? vh.itemId : hit.item.id;
    const secId = vh ? vh.secId : hit.sec.id;
    select({ type: 'item', id: itemId }, { itemId, secId, pt: vh ? vh.pt : hit.pt ?? null });
    const it = nodeById(itemId);
    openMenu(clientX, clientY, [
      vh && { label: 'Remove this point', icon: 'x', action: () => this.deleteVertex(vh) },
      it.type === 'count' && hit?.pt != null && { label: 'Remove this marker', icon: 'x', action: () => this.deleteSelection() },
      { label: it.type === 'count' ? 'Delete this group of markers' : 'Delete this section', icon: 'trash', danger: true, action: () => { S.secSel.pt = null; this.deleteSelection(); } },
    ]);
  }

  onWheel(e) {
    e.preventDefault();
    if (!currentPage()) return;
    const { x, y } = this.local(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    this.zoomAt(Math.exp(-clamp(dy, -300, 300) * 0.0016), x, y);
  }

  // ---- commands --------------------------------------------------------------------------------------
  finishDraft() {
    const d = this.draft;
    if (!d) {
      if (this.countSec) { this.countSec = null; this.render(); }
      return;
    }
    if (d.kind === 'measure') {
      this.measureDone = d.pts.length >= 2 ? { pts: d.pts } : null;
      this.draft = null;
      this.render();
      return;
    }
    if (d.kind !== 'takeoff') return;
    this.draft = null;
    const pts = dedupe(d.pts);
    const it = nodeById(d.itemId);
    if (!it || pts.length < (d.type === 'area' ? 3 : 2)) { this.render(); return; }
    const sec = { id: uid('s'), page: S.pageId, points: pts };
    if (d.type === 'area' && d.deduct) sec.deduct = true;
    mutate(() => it.sections.push(sec));
    if (d.deduct && S.deduct) { S.deduct = false; setTool(S.tool); document.dispatchEvent(new CustomEvent('plancraft:toggles')); }
  }

  cancelDraft() {
    const had = !!(this.draft || this.countSec);
    if (this.draft?.kind === 'scale' && S.tool === 'scale') setTool('select');
    this.draft = null;
    this.countSec = null;
    this.render();
    return had;
  }

  removeLastPoint() {
    if (!this.draft?.pts.length) return false;
    this.draft.pts.pop();
    if (!this.draft.pts.length) this.draft = null;
    this.render();
    return true;
  }

  deleteSelection() {
    const sel = this.selectedSection() || (() => {
      const ss = S.secSel;
      const it = ss && nodeById(ss.itemId);
      const sec = it?.sections.find(s => s.id === ss.secId);
      return sec ? { it, sec } : null;
    })();
    if (!sel) return false;
    const { it, sec } = sel;
    const pt = S.secSel.pt;
    mutate(() => {
      if (it.type === 'count' && pt != null && sec.points.length > 1) sec.points.splice(pt, 1);
      else it.sections.splice(it.sections.indexOf(sec), 1);
    });
    select(S.sel, null);
    return true;
  }

  deleteVertex(vh) {
    const it = nodeById(vh.itemId);
    const sec = it?.sections.find(s => s.id === vh.secId);
    if (!sec) return;
    const min = it.type === 'area' ? 3 : 2;
    mutate(() => {
      if (sec.points.length > min) sec.points.splice(vh.pt, 1);
      else it.sections.splice(it.sections.indexOf(sec), 1);
    });
    select(S.sel, it.sections.includes(sec) ? { itemId: it.id, secId: sec.id, pt: null } : null);
  }

  /** Keys the viewer owns. Returns true when handled. */
  handleKey(e) {
    if (this.ext.some(x => x.key?.(e))) return true;
    switch (e.key) {
      case 'Escape':
        if (this.cropRect) { this.clearCrop(); return true; }
        if (this.cancelDraft()) return true;
        if (this.measureDone) { this.measureDone = null; this.render(); return true; }
        if (S.secSel) { select(S.sel, null); return true; }
        if (S.tool !== 'select') { setTool('select'); return true; }
        return false;
      case 'Enter':
        if (this.draft || this.countSec) { this.finishDraft(); return true; }
        return false;
      case 'Backspace':
        if (this.removeLastPoint()) return true;
        return this.deleteSelection();
      case 'Delete':
        return this.deleteSelection();
      default:
        return false;
    }
  }

  setSpace(down) {
    if (this.space === down) return;
    this.space = down;
    this.updateCursor();
  }

  /** Zoom so that all these page points are in view (not closer than 100%, not further than the whole page). */
  showPoints(pts) {
    const page = currentPage();
    if (!page || !pts.length) return;
    if (this.w < 120 || this.h < 120) { this.pendingShow = pts; return; }   // not laid out yet: do it on resize
    this.pendingShow = null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const minSpan = 400;                                  // a single marker still shows its surroundings
    if (x1 - x0 < minSpan) { const c = (x0 + x1) / 2; x0 = c - minSpan / 2; x1 = c + minSpan / 2; }
    if (y1 - y0 < minSpan) { const c = (y0 + y1) / 2; y0 = c - minSpan / 2; y1 = c + minSpan / 2; }
    const [W, H] = this.pageSize(page);
    const pad = Math.min(60, this.w / 6, this.h / 6);
    const fitAll = Math.min((this.w - 48) / W, (this.h - 48) / H);
    const s = clamp(Math.min((this.w - pad * 2) / (x1 - x0), (this.h - pad * 2) / (y1 - y0)), Math.min(fitAll, 1), 1);
    this.view = { s, tx: this.w / 2 - ((x0 + x1) / 2) * s, ty: this.h / 2 - ((y0 + y1) / 2) * s };
    this.onView?.();
    this.render();
  }

  /** Center the view on a section (used from the properties panel). */
  reveal(sec) {
    if (!sec?.points?.length) return;
    const xs = sec.points.map(p => p[0]), ys = sec.points.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    this.view.tx = this.w / 2 - cx * this.view.s;
    this.view.ty = this.h / 2 - cy * this.view.s;
    this.onView?.();
    this.render();
  }
}
