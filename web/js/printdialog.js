// Print / export PDF: choose pages, paper and what to include; the server builds a high-quality PDF.
import { S, flushSave, currentPage } from './store.js';
import * as api from './api.js';
import { h, download } from './util.js';
import { modal, progressBox, toast } from './dialogs.js';

const PREFS = 'plancraft.print';
const PAPERS = [['plan', 'Same size as the drawing'], ['A4', 'A4'], ['A3', 'A3'], ['A2', 'A2'], ['A1', 'A1'], ['A0', 'A0'],
  ['Letter', 'Letter'], ['Legal', 'Legal'], ['Tabloid', 'Tabloid (11 x 17 in)'], ['ARCH D', 'ARCH D (24 x 36 in)']];

function prefs() {
  const d = { scope: 'page', onScreen: false, paper: 'A3', orientation: 'auto', takeoff: true, legend: true, legendCorner: 'br', marks: true, title: true, hidden: false, quality: 'best' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; } catch { return d; }
}

/** viewArea() -> {page, rect} of what is on screen (from main). */
export async function openPrint({ viewArea } = {}) {
  if (!S.project?.pages.length) { toast('Add plans first.'); return; }
  const o = prefs();
  const page = currentPage();
  const radio = (name, value, label, checked) => h('label', null, h('input', { type: 'radio', name, value, checked }), label);
  const check = (key, label) => {
    const c = h('input', { type: 'checkbox', checked: !!o[key] });
    c.addEventListener('change', () => { o[key] = c.checked; sync(); });
    return h('label', { class: 'inline', style: { gap: '8px' } }, c, label);
  };
  // pages
  const scope = h('div', { class: 'radio-list' },
    radio('pscope', 'page', `This page (${page?.name || ''})`, o.scope === 'page'),
    radio('pscope', 'all', `All pages (${S.project.pages.length})`, o.scope === 'all'),
    radio('pscope', 'choose', 'Choose pages', o.scope === 'choose'));
  const picks = new Set(o.scope === 'choose' && Array.isArray(o.chosen) ? o.chosen.filter(id => S.project.pages.some(p => p.id === id)) : [page?.id].filter(Boolean));
  const chooser = h('div', { class: 'print-pages' }, S.project.pages.map(p => {
    const c = h('input', { type: 'checkbox', checked: picks.has(p.id) });
    c.addEventListener('change', () => { if (c.checked) picks.add(p.id); else picks.delete(p.id); });
    return h('label', { class: 'inline', style: { gap: '8px' } }, c, p.name);
  }));
  const onScreen = check('onScreen', 'Only the part of the page on screen');
  scope.addEventListener('change', e => { o.scope = e.target.value; sync(); });
  // paper
  const paper = h('select', null, PAPERS.map(([v, l]) => h('option', { value: v, selected: v === o.paper }, l)));
  paper.addEventListener('change', () => { o.paper = paper.value; sync(); });
  const orientation = h('select', null, [['auto', 'Automatic'], ['landscape', 'Landscape'], ['portrait', 'Portrait']]
    .map(([v, l]) => h('option', { value: v, selected: v === o.orientation }, l)));
  orientation.addEventListener('change', () => { o.orientation = orientation.value; });
  const corner = h('select', { 'aria-label': 'Legend position' }, [['br', 'bottom right'], ['bl', 'bottom left'], ['tr', 'top right'], ['tl', 'top left']]
    .map(([v, l]) => h('option', { value: v, selected: v === o.legendCorner }, l)));
  corner.addEventListener('change', () => { o.legendCorner = corner.value; });
  const quality = h('select', null, [['best', 'Best (full resolution)'], ['smaller', 'Smaller file (JPEG plan images)']]
    .map(([v, l]) => h('option', { value: v, selected: v === o.quality }, l)));
  quality.addEventListener('change', () => { o.quality = quality.value; });
  const legendRow = h('div', { class: 'inline', style: { gap: '8px' } }, check('legend', 'Legend with quantities on each page,'), corner);

  function sync() {
    chooser.hidden = o.scope !== 'choose';
    onScreen.hidden = o.scope !== 'page';
    orientation.disabled = o.paper === 'plan';
    legendRow.querySelector('input').disabled = !o.takeoff;
    corner.disabled = !o.takeoff || !o.legend;
  }
  sync();

  const action = await modal({
    title: 'Print / export PDF',
    wide: true,
    enterSubmits: false,
    body: [
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Pages'), scope, chooser, onScreen),
      h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', null, 'Paper'), paper),
        h('div', { class: 'field' }, h('label', null, 'Orientation'), orientation)),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Include'),
        check('takeoff', 'Takeoff (lines, areas and counts in their colours)'), legendRow,
        check('marks', 'Notes and highlights'), check('title', 'Title strip (project, page, scale, date)'),
        check('hidden', 'Also items that are hidden on screen')),
      h('div', { class: 'field' }, h('label', null, 'Plan quality'), quality,
        h('div', { class: 'hint' }, 'Plans you added from a PDF print from the original vector drawing, sharp at any size. Takeoff, notes and legend are always vector.')),
    ],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Open to print', value: 'print' }, { label: 'Download PDF', value: 'download', primary: true }],
    validate: () => (o.scope === 'choose' && !picks.size ? 'Tick at least one page.' : null),
  });
  if (!action) return;
  o.chosen = [...picks];
  try { localStorage.setItem(PREFS, JSON.stringify(o)); } catch { /* storage unavailable */ }

  const pages = o.scope === 'all' ? S.project.pages.map(p => p.id) : o.scope === 'choose' ? S.project.pages.filter(p => picks.has(p.id)).map(p => p.id) : [page.id];
  const body = {
    pages, paper: o.paper, orientation: o.orientation, takeoff: o.takeoff, legend: o.legend, legendCorner: o.legendCorner,
    marks: o.marks, title: o.title, hidden: o.hidden, quality: o.quality,
    area: o.scope === 'page' && o.onScreen ? viewArea?.() : null,
  };
  // a window opened straight from the click is not blocked as a pop-up; it shows the PDF when it is ready
  const win = action === 'print' ? window.open('', '_blank') : null;
  if (win) win.document.write('<p style="font:14px Segoe UI,sans-serif;padding:24px">Preparing the PDF...</p>');
  const prog = progressBox('Making the PDF');
  try {
    await flushSave();
    const { task } = await fetch(`/api/projects/${encodeURIComponent(S.project.id)}/print`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not make the PDF'); return j; });
    const res = await api.waitTask(task, t => prog.set(t.total ? t.done / t.total : null, t.message));
    prog.close();
    const url = `/api/projects/${encodeURIComponent(S.project.id)}/exports/${encodeURIComponent(res.file)}`;
    if (win) {
      win.location.href = url;
      toast('The PDF opened in a new tab: print it from there (Ctrl+P).');
    } else {
      download(`${url}?download=1`);
      toast(`PDF ready: ${res.pages} page(s), ${(res.size / 1048576).toFixed(1)} MB.`);
    }
  } catch (err) {
    prog.close();
    win?.close();
    toast(err.message, 'error');
  }
}
