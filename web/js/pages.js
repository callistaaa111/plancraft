// The Pages list.
import { S, on, mutate, select, setPage, setTool, pageById, sectionsPerPage, ix } from './store.js';
import { copyPage, pastePage, hasClip } from './pageops.js';
import * as M from './measure.js';
import { h } from './util.js';
import { icon } from './icons.js';
import { openMenu, confirmBox, promptText } from './dialogs.js';

let el = null;
let countEl = null;
let filter = '';
let actions = {};

export function initPages(listEl, filterInput, countElement, acts) {
  el = listEl;
  countEl = countElement;
  actions = acts;
  filterInput.addEventListener('input', () => { filter = filterInput.value.trim().toLowerCase(); render(); });
  el.addEventListener('click', e => {
    const r = e.target.closest('.row[data-id]');
    if (!r) return;
    if (e.target.closest('[data-act="scale"]')) { actions.scale(r.dataset.id); return; }
    openPage(r.dataset.id);
  });
  el.addEventListener('dblclick', e => {
    const r = e.target.closest('.row[data-id]');
    if (r && !e.target.closest('[data-act]')) renamePage(r.dataset.id);
  });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    const r = e.target.closest('.row[data-id]');
    if (!r) {
      openMenu(e.clientX, e.clientY, [
        { label: 'Add plans (PDF or images)...', icon: 'upload', action: () => actions.addPlans() },
        { label: 'Paste page', icon: 'paste', kbd: 'Ctrl+V', disabled: !hasClip(), action: () => pastePage() },
      ]);
      return;
    }
    const id = r.dataset.id;
    openPage(id);
    openMenu(e.clientX, e.clientY, [
      { label: 'Page details', icon: 'page', action: () => { select(null); } },
      { label: 'Set scale...', icon: 'scale', action: () => actions.scale(id) },
      { label: 'Rename', icon: 'rename', action: () => renamePage(id) },
      'sep',
      { label: 'Crop to a new page...', icon: 'crop', kbd: 'C', action: () => setTool('crop') },
      { label: 'Copy page', icon: 'copy', kbd: 'Ctrl+C', action: () => copyPage(id) },
      { label: 'Paste page after this one', icon: 'paste', kbd: 'Ctrl+V', disabled: !hasClip(), action: () => pastePage() },
      'sep',
      { label: 'Delete page', icon: 'trash', danger: true, action: () => deletePage(id) },
    ]);
  });
  el.addEventListener('keydown', e => {
    const list = visiblePages();
    const i = list.findIndex(p => p.id === S.pageId);
    if (e.key === 'ArrowDown' && i < list.length - 1) openPage(list[i + 1].id);
    else if (e.key === 'ArrowUp' && i > 0) openPage(list[i - 1].id);
    else if (e.key === 'F2' && S.pageId) renamePage(S.pageId);
    else if (e.key === 'Delete' && S.pageId) deletePage(S.pageId);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && S.pageId) copyPage(S.pageId);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') pastePage();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  on('change', render);
  on('page', render);
  on('load', () => { filter = ''; filterInput.value = ''; render(); });
}

function visiblePages() {
  const pages = S.project?.pages || [];
  if (!filter) return pages;
  return pages.filter(p => `${p.name} ${p.group || ''} ${p.source || ''}`.toLowerCase().includes(filter));
}

export function openPage(id) {
  setPage(id);
  el?.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

export function render() {
  if (!el || !S.project) return;
  const pages = visiblePages();
  const secs = sectionsPerPage();
  countEl.textContent = S.project.pages.length ? `(${S.project.pages.length})` : '';
  if (!S.project.pages.length) {
    el.replaceChildren(h('div', { class: 'empty-note' }, 'No plans yet. ',
      h('button', { class: 'btn small', onclick: () => actions.addPlans(), html: `${icon('upload')}<span>Add PDF or images</span>` })));
    return;
  }
  el.replaceChildren(...pages.map(p => {
    const scaled = M.pxPerM(p);
    const badge = !scaled ? h('span', { class: 'badge warn', dataset: { act: 'scale' }, title: 'No scale: click to set it' }, 'No scale')
      : p.scale.auto ? h('span', { class: 'badge warn', dataset: { act: 'scale' }, title: 'Read from the drawing text, not checked yet' }, `${p.scale.label}?`)
        : h('span', { class: 'badge ok', dataset: { act: 'scale' }, title: `Scale: ${p.scale.label || 'calibrated'}` }, shortLabel(p.scale.label));
    const n = secs.get(p.id) || 0;
    return h('div', {
      class: `row page-row${p.id === S.pageId ? ' sel' : ''}`, dataset: { id: p.id }, title: p.name,
    },
    h('span', { class: 'ticon', html: icon('page') }),
    h('span', { class: 'pname' }, p.name, p.group ? h('span', { class: 'pgroup' }, p.group) : null),
    n ? h('span', { class: 'secs', title: `${n} takeoff section(s) on this page` }, n) : null,
    badge);
  }));
  el.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}

function shortLabel(label) {
  if (!label) return 'Scaled';
  if (label.startsWith('Calibrated')) return 'Calibrated';
  if (label === 'From PlanSwift') return 'Scaled';
  return label;
}

export async function renamePage(id) {
  const page = pageById(id);
  if (!page) return;
  const name = await promptText('Rename page', 'Page name', page.name, { okLabel: 'Rename' });
  if (name && name !== page.name) mutate(() => { pageById(id).name = name; });
}

export async function deletePage(id) {
  const page = pageById(id);
  if (!page) return;
  const n = sectionsPerPage().get(id) || 0;
  const ok = await confirmBox('Delete page?',
    `"${page.name}" will be removed${n ? ` together with ${n} takeoff section(s) on it` : ''}. You can undo with Ctrl+Z.`,
    { okLabel: 'Delete page', danger: true });
  if (!ok) return;
  mutate(p => {
    const i = p.pages.findIndex(x => x.id === id);
    if (i < 0) return;
    p.pages.splice(i, 1);
    for (const it of ix().items) it.sections = it.sections.filter(s => s.page !== id);
    if (S.pageId === id) S.pageId = (p.pages[i] || p.pages[i - 1])?.id || null;
  });
}
