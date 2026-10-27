// Search the open project: page names, items, notes and PDF text.
import { S, flushSave } from './store.js';
import * as api from './api.js';
import { h, debounce } from './util.js';
import { modal, toast, progressBox } from './dialogs.js';
import { openPage } from './pages.js';

const KIND = { page: 'Page', item: 'Item', note: 'Note', text: 'Plan text' };

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
      },
    },
    h('span', { class: 'badge' }, KIND[r.type] || r.type),
    h('span', { class: 'search-text' }, h('strong', null, r.title),
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
