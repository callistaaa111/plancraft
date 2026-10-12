// The projects screen.
import * as api from './api.js';
import { h, timeAgo } from './util.js';
import { icon } from './icons.js';
import { openMenu, confirmBox, promptText, toast } from './dialogs.js';

let el = null;
let A = {};

export function initHome(listEl, actions) {
  el = listEl;
  A = actions;
}

export async function renderHome() {
  el.replaceChildren(h('div', { class: 'note' }, 'Loading projects...'));
  let projects;
  try {
    projects = await api.listProjects();
  } catch (err) {
    el.replaceChildren(h('div', { class: 'empty-projects' }, h('strong', null, 'Could not load projects'), err.message));
    return;
  }
  if (!projects.length) {
    el.replaceChildren(h('div', { class: 'empty-projects' },
      h('strong', null, 'No projects yet'),
      'Open one of your PlanSwift .SwiftJob files, or start a new takeoff from a PDF plan.'));
    return;
  }
  el.replaceChildren(...projects.map(card));
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
