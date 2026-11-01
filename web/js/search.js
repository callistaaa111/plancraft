// Search the open project: page names, items, notes and PDF text.
import { S, flushSave } from './store.js';
import * as api from './api.js';
import { h, debounce } from './util.js';
import { modal, toast, progressBox } from './dialogs.js';
import { openPage } from './pages.js';

const KIND = { page: 'Page', item: 'Item', note: 'Note', text: 'Plan text' };
let finder = null;

/** Outline a search's hits on the plan, zoom to one, and step through them with Enter (Shift+Enter goes back). */
export function initFind(viewer) {
  let hit = null;   // {pageId, rects: [[x, y, w, h] in page pixels], i, query}
  const here = () => hit && hit.pageId === S.pageId;
  const show = () => {
    const [x, y, w, hgt] = hit.rects[hit.i];
    viewer.showPoints([[x, y], [x + w, y + hgt]]);
  };
  finder = (pageId, rects, query) => {
    hit = rects.length ? { pageId, rects, i: 0, query } : null;
    if (hit) show();
  };
  viewer.use({
    drawOver(ctx) {
      if (!here()) return;
      hit.rects.forEach(([x, y, w, hgt], i) => {
        const cur = i === hit.i, pad = cur ? 4 : 2;
        const [x0, y0] = viewer.toScr([x, y]), [x1, y1] = viewer.toScr([x + w, y + hgt]);
        ctx.fillStyle = cur ? 'rgba(255, 196, 0, .45)' : 'rgba(255, 196, 0, .25)';
        ctx.fillRect(x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2);
        ctx.strokeStyle = cur ? '#d9480f' : 'rgba(217, 72, 15, .6)';
        ctx.lineWidth = cur ? 2.5 : 1.2;
        ctx.strokeRect(x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2);
      });
    },
    key(e) {
      if (!here() || S.tool !== 'select') return false;
      if (e.key === 'Escape') { hit = null; viewer.render(); return true; }
      if (e.key !== 'Enter') return false;
      hit.i = (hit.i + (e.shiftKey ? -1 : 1) + hit.rects.length) % hit.rects.length;
      show();
      return true;
    },
    hint() {
      return here() && S.tool === 'select'
        ? `"${hit.query}": ${hit.i + 1} of ${hit.rects.length} on this sheet. Enter = next, Shift+Enter = back, Esc = clear.` : null;
    },
    reset(why) { if (why === 'page' && !here()) hit = null; },
  });
}

export function openProjectSearch() {
  if (!S.project) return;
  const input = h('input', { type: 'search', placeholder: 'Search pages, items, notes and PDF text...', autocomplete: 'off' });
  const results = h('div', { class: 'search-results' });
  const note = h('div', { class: 'hint' }, 'Type at least two characters. Text search covers PDF pages that have a text layer; scanned plans can be OCRed if Tesseract is installed.');
  let closer = null;

  const render = (res) => {
    const rows = res.results || [];
    if (!rows.length) {
      results.replaceChildren(h('div', { class: 'empty-note' }, 'Nothing matched "' + res.query + '".'));
      return;
    }
    results.replaceChildren(...rows.map(r => h('button', {
      class: 'search-hit', type: 'button',
      onclick: () => {
        if (!r.pageId) { toast('That item has no takeoff on a page yet.'); return; }
        openPage(r.pageId);
        closer?.(null);
        finder?.(r.pageId, r.rects || [], res.query);
      },
    },
    h('span', { class: 'badge' }, KIND[r.type] || r.type),
    h('span', { class: 'search-text' }, h('strong', null, r.title + (r.rects?.length > 1 ? ` (${r.rects.length} on the sheet)` : '')),
      h('span', { class: 'hint' }, r.pageName + (r.snippet ? ' — ' + r.snippet : ''))))));
    if (res.truncated) results.append(h('div', { class: 'hint' }, 'Showing the first ' + rows.length + ' results.'));
  };

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.replaceChildren(); return; }
    try { render(await api.searchProject(S.project.id, q)); }
    catch (err) { results.replaceChildren(h('div', { class: 'err' }, err.message)); }
  }, 250);

  input.addEventListener('input', run);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(); }
  });

  modal({
    title: 'Search project',
    size: 'xl',
    body: h('div', { class: 'rev-compare' }, input, note, results,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => {
          const prog = progressBox('OCR scanned pages');
          try {
            await flushSave();         // OCR saves the project when it ends: a save still pending would make that a conflict
            const { task } = await api.ocrProject(S.project.id);
            const r = await api.waitTask(task, t => prog.set(t.total ? t.done / t.total : null, t.message));
            prog.close();
            toast('OCR finished on ' + r.ocrPages + ' page(s). Reloading...');
            setTimeout(() => location.reload(), 700);
          } catch (err) { prog.close(); toast(err.message, 'error'); }
        } }, 'OCR scanned pages (Tesseract)'))),
    buttons: [{ label: 'Close', value: null }],
    onOpen: ({ close }) => { closer = close; setTimeout(() => input.focus(), 40); },
  });
}
