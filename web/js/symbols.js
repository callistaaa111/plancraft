// Project symbol library: save a symbol from Auto count, then count it across pages.
import { S, mutate, selectedItem } from './store.js';
import * as api from './api.js';
import { h, uid } from './util.js';
import { modal, toast, confirmBox } from './dialogs.js';

export async function openSymbolLibrary() {
  if (!S.project) return;
  let list;
  try { list = await api.listSymbols(S.project.id); } catch (err) { toast(err.message, 'error'); return; }
  if (!list.length) {
    toast('No saved symbols yet. Use Auto count, box a symbol, then press "Save symbol".', 'error');
    return;
  }
  const body = h('div', { class: 'rev-compare' },
    h('div', { class: 'hint' }, 'Saved symbols are matched by shape, page by page. Review the circles before adding.'),
    h('div', { class: 'symbol-list' }, ...list.map(s => h('div', { class: 'symbol-row' },
      h('div', { class: 'symbol-main' }, h('strong', null, s.name), h('div', { class: 'hint' }, `${s.width} × ${s.height} px`)),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => countOnPages(s) }, 'Count on pages'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
        if (!await confirmBox('Delete symbol?', `"${s.name}" will be removed from this project.`, { okLabel: 'Delete', danger: true })) return;
        try { await api.deleteSymbol(S.project.id, s.id); toast('Symbol removed.'); openSymbolLibrary(); }
        catch (err) { toast(err.message, 'error'); }
      } }, 'Delete')))));
  await modal({ title: 'Saved symbols', size: 'wide', body, buttons: [{ label: 'Close', value: null }] });
}

function countOnPages(symbol) {
  const checks = S.project.pages.map(p => {
    const cb = h('input', { type: 'checkbox', checked: true });
    return { page: p, cb, row: h('label', { class: 'inline symbol-page' }, cb, p.name || p.id) };
  });
  const body = h('div', { class: 'rev-compare' },
    h('div', { class: 'hint' }, 'Choose the pages to search. Pages with no saved image are skipped.'),
    h('div', { class: 'symbol-pages' }, ...checks.map(c => c.row)));
  modal({
    title: 'Count "' + symbol.name + '"',
    size: 'wide',
    body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Count', value: true, primary: true }],
  }).then(async ok => {
    if (!ok) return;
    const pages = checks.filter(c => c.cb.checked).map(c => c.page.id);
    if (!pages.length) { toast('Tick at least one page.'); return; }
    try {
      const res = await api.countSymbol(S.project.id, symbol.id, pages);
      showResults(symbol, res);
    } catch (err) { toast(err.message, 'error'); }
  });
}

function showResults(symbol, res) {
  const item = selectedItem();
  const usable = item && item.type === 'count';
  const rows = (res.pages || []).map(p => h('tr', null,
    h('td', null, p.pageName || p.pageId),
    h('td', { class: 'n' }, p.error || String((p.matches || []).length))));
  const body = h('div', { class: 'rev-compare' },
    h('p', null, `Found ${res.total} match(es) for "${symbol.name}".`),
    h('table', { class: 'pp-table' }, h('tbody', null, rows)),
    h('div', { class: 'hint' }, usable ? 'They will be added to "' + item.name + '" on their pages.'
      : 'Select a count item first if you want to add these matches.'));
  modal({
    title: 'Count results',
    size: 'wide',
    body,
    buttons: usable ? [{ label: 'Close', value: null }, { label: 'Add ' + res.total, value: true, primary: true }]
      : [{ label: 'Close', value: null }],
  }).then(ok => {
    if (!ok || !usable) return;
    mutate(() => {
      for (const p of res.pages || []) {
        const pts = (p.matches || []).map(m => [m[0], m[1]]);
        if (pts.length) item.sections.push({ id: uid('s'), page: p.pageId, points: pts });
      }
    });
    toast('Added ' + res.total + ' marker(s) to "' + item.name + '".');
  });
}
