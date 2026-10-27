// Manage pages: rename/group, reorder, select several and apply a standard scale in one go.
import { S, mutate, pageById } from './store.js';
import * as M from './measure.js';
import { h } from './util.js';
import { modal, toast } from './dialogs.js';
import { openPage } from './pages.js';

function sectionCounts() {
  const counts = new Map();
  const walk = nodes => {
    for (const n of nodes || []) {
      if (n.kind === 'folder') walk(n.children);
      else for (const sec of n.sections || []) counts.set(sec.page, (counts.get(sec.page) || 0) + 1);
    }
  };
  walk(S.project?.tree || []);
  return counts;
}

function scaleOptions() {
  const out = [];
  for (const r of M.METRIC_RATIOS) out.push({ key: 'r' + r, label: '1:' + r, make: p => (p.dpi ? M.ratioScale(p.dpi, r) : null) });
  for (const [label, ipf] of M.IMPERIAL_SCALES) out.push({ key: 'i' + ipf, label, make: p => (p.dpi ? M.imperialScale(p.dpi, ipf) : null) });
  return out;
}

export function openPageManager() {
  if (!S.project) return;
  const selected = new Set();
  const counts = sectionCounts();
  const options = scaleOptions();
  const scaleSel = h('select', { 'aria-label': 'Scale to apply' },
    h('option', { value: '' }, 'Choose a standard scale...'),
    ...options.map(o => h('option', { value: o.key }, o.label)));
  const list = h('div', { class: 'page-manager-list' });
  const set = (p, key, value) => mutate(() => { const t = pageById(p.id); if (t) t[key] = value; });
  const move = (p, dir) => {
    mutate(() => {
      const pages = S.project.pages;
      const i = pages.findIndex(x => x.id === p.id);
      const j = i + dir;
      if (i >= 0 && j >= 0 && j < pages.length) [pages[i], pages[j]] = [pages[j], pages[i]];
    });
    render();
  };
  const render = () => {
    list.replaceChildren(...S.project.pages.map((p, i) => {
      const sc = p.scale?.pxPerM ? (p.scale.label || 'Set') + (p.scale.auto ? '?' : '') : 'No scale';
      const name = h('input', { type: 'text', value: p.name || '', 'aria-label': 'Page name' });
      name.addEventListener('change', () => set(p, 'name', name.value.trim() || p.name));
      const group = h('input', { type: 'text', value: p.group || '', placeholder: 'Sheet set / group', 'aria-label': 'Page group' });
      group.addEventListener('change', () => set(p, 'group', group.value.trim()));
      const cb = h('input', { type: 'checkbox', checked: selected.has(p.id), 'aria-label': 'Select page' });
      cb.addEventListener('change', () => { if (cb.checked) selected.add(p.id); else selected.delete(p.id); });
      return h('div', { class: 'page-manager-row' },
        cb,
        h('span', { class: 'page-manager-order' }, String(i + 1)),
        h('div', { class: 'page-manager-name' }, name, h('div', { class: 'hint' }, (p.source || '') + (counts.get(p.id) ? ' · ' + counts.get(p.id) + ' section(s)' : ''))),
        group,
        h('button', { class: 'btn ghost small', type: 'button', title: 'Open this page', onclick: () => { openPage(p.id); close?.(); } }, sc),
        h('button', { class: 'btn ghost small icon-only', type: 'button', title: 'Move up', disabled: i === 0, onclick: () => move(p, -1) }, '↑'),
        h('button', { class: 'btn ghost small icon-only', type: 'button', title: 'Move down', disabled: i === S.project.pages.length - 1, onclick: () => move(p, 1) }, '↓'));
    }));
  };
  const apply = () => {
    const opt = options.find(o => o.key === scaleSel.value);
    if (!opt) { toast('Choose a scale first.', 'error'); return; }
    if (!selected.size) { toast('Tick the pages to scale.', 'error'); return; }
    let skipped = 0;
    mutate(() => {
      for (const p of S.project.pages) {
        if (!selected.has(p.id)) continue;
        const ppm = opt.make(p);
        if (ppm) p.scale = { pxPerM: ppm, label: opt.label, auto: false };
        else skipped++;
      }
    });
    render();
    toast(skipped ? `Scale set; ${skipped} page(s) had no DPI and were skipped.` : 'Scale set on the selected pages.');
  };
  let close = null;
  render();
  modal({
    title: 'Manage pages',
    size: 'xl',
    body: h('div', { class: 'rev-compare' },
      h('div', { class: 'hint' }, 'Rename or group pages, reorder them, or tick several and apply one standard scale. Pages without a known resolution still need calibration.'),
      h('div', { class: 'page-manager-tools' },
        h('label', { class: 'inline' }, scaleSel,
          h('button', { class: 'btn small primary', type: 'button', onclick: apply }, 'Apply scale to ticked')),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => { selected.clear(); S.project.pages.forEach(p => selected.add(p.id)); render(); } }, 'Select all'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => { selected.clear(); render(); } }, 'Clear')),
      list),
    buttons: [{ label: 'Close', value: null }],
    onOpen: ({ close: c }) => { close = c; },
  });
}
