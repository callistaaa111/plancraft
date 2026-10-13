// The projects screen.
import * as api from './api.js';
import { h, timeAgo } from './util.js';
import { icon } from './icons.js';
import { openMenu, confirmBox, promptText, toast } from './dialogs.js';

let el = null;
let A = {};
let projects = [];
const tools = () => document.getElementById('homeTools');
const search = () => document.getElementById('projectSearch');

export function initHome(listEl, actions) {
  el = listEl;
  A = actions;
  const box = search();
  box.addEventListener('input', showList);
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape' && box.value) { e.preventDefault(); box.value = ''; showList(); }
    else if (e.key === 'Enter') el.querySelector('.card')?.click();
  });
  // Ctrl+F or / jumps to the search box while the projects screen is showing
  document.addEventListener('keydown', e => {
    if (tools().hidden || tools().closest('[hidden]') || document.querySelector('.modal-back')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
      e.preventDefault(); box.focus(); box.select();
    }
  });
}

export async function renderHome() {
  el.replaceChildren(h('div', { class: 'note' }, 'Loading projects...'));
  try {
    projects = await api.listProjects();
  } catch (err) {
    tools().hidden = true;
    el.replaceChildren(h('div', { class: 'empty-projects' }, h('strong', null, 'Could not load projects'), err.message));
    return;
  }
  tools().hidden = !projects.length;
  if (!projects.length) {
    el.replaceChildren(h('div', { class: 'empty-projects' },
      h('strong', null, 'No projects yet'),
      'Open one of your PlanSwift .SwiftJob files, or start a new takeoff from a PDF plan.'));
    return;
  }
  showList();
}

/** Every word typed must appear in the project name (any order, any case). */
function showList() {
  const words = search().value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = projects.filter(p => words.every(w => p.name.toLowerCase().includes(w)));
  const count = document.getElementById('projectCount');
  count.textContent = words.length ? `${shown.length} of ${projects.length}` : `${projects.length} project${projects.length === 1 ? '' : 's'}`;
  el.replaceChildren(...(shown.length ? shown.map(card)
    : [h('div', { class: 'empty-projects' }, h('strong', null, 'No matching projects'), `Nothing named like "${search().value.trim()}". Press Esc to clear the search.`)]));
}

function card(p) {
  const open = () => { location.hash = `#/p/${encodeURIComponent(p.id)}`; };
  const thumb = p.pages
    ? h('div', { class: 'thumb', style: { backgroundImage: `url("/api/projects/${encodeURIComponent(p.id)}/thumb.jpg")` } })
    : h('div', { class: 'thumb none', html: icon('page') });
  const more = h('button', {
    class: 'btn ghost small icon-only more', title: 'More', 'aria-label': `More actions for ${p.name}`, html: icon('more'),
    onclick: e => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, [
        { label: 'Open', icon: 'page', action: open },
        { label: 'Rename', icon: 'rename', action: () => rename(p) },
        { label: 'Export to Excel', icon: 'excel', action: () => A.exportProject(p.id) },
        { label: 'Export as PlanSwift job', icon: 'job', action: () => A.exportSwiftJob(p.id) },
        'sep',
        { label: 'Delete project', icon: 'trash', danger: true, action: () => remove(p) },
      ]);
    },
  });
  return h('div', {
    class: 'card', tabindex: '0', role: 'button', 'aria-label': `Open ${p.name}`,
    onclick: open, onkeydown: e => { if (e.key === 'Enter') open(); },
  },
  thumb,
  h('div', { class: 'body' },
    h('div', { class: 'name', title: p.name }, p.name),
    h('div', { class: 'meta' }, `${p.pages} page${p.pages === 1 ? '' : 's'} · ${p.items} item${p.items === 1 ? '' : 's'} · ${timeAgo(p.modified)}`)),
  more);
}

async function rename(p) {
  const name = await promptText('Rename project', 'Project name', p.name, { okLabel: 'Rename' });
  if (!name || name === p.name) return;
  try {
    const project = await api.getProject(p.id);
    project.name = name;
    await api.saveProject(p.id, project);
    renderHome();
  } catch (err) { toast(err.message, 'error'); }
}

async function remove(p) {
  const ok = await confirmBox('Delete project?',
    `"${p.name}" will be moved to PlanCraft's trash folder (data/trash) and disappear from this list.`,
    { okLabel: 'Delete project', danger: true });
  if (!ok) return;
  try {
    await api.deleteProject(p.id);
    toast('Project moved to the trash folder.');
    renderHome();
  } catch (err) { toast(err.message, 'error'); }
}
