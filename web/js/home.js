// The projects screen.
import * as api from './api.js';
import { h, timeAgo, pickFiles, download, applyUiScale, savedUiScale } from './util.js';
import { icon } from './icons.js';
import { modal, openMenu, confirmBox, promptText, toast, progressBox } from './dialogs.js';
import { openRevisionCompare } from './revisions.js';

let el = null;
let A = {};
let projects = [];
let pinned = new Set();
try { pinned = new Set(JSON.parse(localStorage.getItem('plancraft.pins') || '[]')); } catch { /* storage unavailable */ }
const savePins = () => { try { localStorage.setItem('plancraft.pins', JSON.stringify([...pinned])); } catch { /* storage unavailable */ } };
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
  document.getElementById('btnImportArchive')?.addEventListener('click', importArchive);
  document.getElementById('btnNewFromTemplate')?.addEventListener('click', openTemplates);
  document.getElementById('btnStorage')?.addEventListener('click', openStorage);
  document.getElementById('btnDemo')?.addEventListener('click', openDemo);
  document.getElementById('btnAbout')?.addEventListener('click', openAbout);
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
  const shown = projects.filter(p => words.every(w => p.name.toLowerCase().includes(w)))
    .slice().sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0));
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
        { label: pinned.has(p.id) ? 'Unpin from top' : 'Pin to top', icon: 'tag', action: () => { if (pinned.has(p.id)) pinned.delete(p.id); else pinned.add(p.id); savePins(); showList(); } },
        { label: 'Rename', icon: 'rename', action: () => rename(p) },
        { label: 'Export to Excel', icon: 'excel', action: () => A.exportProject(p.id) },
        { label: 'Export to CSV', icon: 'excel', action: () => download(api.csvUrl(p.id)) },
        { label: 'Export as PlanSwift job', icon: 'job', action: () => A.exportSwiftJob(p.id) },
        { label: 'Compare revisions...', icon: 'compare', action: () => openRevisionCompare(p) },
        { label: 'Export project archive (.zip)', icon: 'download', action: () => download(api.archiveUrl(p.id)) },
        { label: 'Save as template...', icon: 'copy', action: () => saveAsTemplate(p) },
        { label: 'Duplicate project', icon: 'copy', action: () => duplicateProject(p) },
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
    h('div', { class: 'meta' }, (pinned.has(p.id) ? '★ · ' : '') + `${p.pages} page${p.pages === 1 ? '' : 's'} · ${p.items} item${p.items === 1 ? '' : 's'} · ${timeAgo(p.modified)}`)),
  more);
}

async function openDemo() {
  let p;
  try { p = await api.createDemo(); } catch (err) { toast(err.message, 'error'); return; }
  await modal({
    title: 'Demo project',
    size: 'wide',
    body: h('div', { class: 'rev-compare' },
      h('p', null, 'A small electrical sheet with a price list, assemblies and a quote. Try:'),
      h('ol', { class: 'demo-steps' },
        h('li', null, 'Click a page and check its scale in the Pages list.'),
        h('li', null, 'Press T and add a linear, area or count item.'),
        h('li', null, 'Press A to auto count a symbol; use Save symbol to reuse it.'),
        h('li', null, 'Open Materials → Quote for the build-up and Download proposal PDF.'),
        h('li', null, 'Open the project card menu for Compare revisions, templates, CSV and the archive.')),
      h('p', { class: 'hint' }, 'You can delete the demo project at any time; it is a normal project in your data folder.')),
    buttons: [{ label: 'Open demo', value: true, primary: true }],
  });
  location.hash = '#/p/' + encodeURIComponent(p.id);
}

function bytes(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function backupStatus(b) {
  const last = b.last ? `Last backup ${new Date(b.last.at).toLocaleString()}: ${b.last.copied} changed file(s) copied, ${b.last.files} in total.`
    : 'No backup made yet.';
  return [h('div', { class: 'hint' }, b.folder ? last : 'Off. PlanCraft only keeps copies inside its own data folder.'),
    b.error && b.folder ? h('div', { class: 'hint', style: { color: 'var(--danger)' } },
      `The automatic backup failed ${new Date(b.error.at).toLocaleString()}: ${b.error.message}`) : null].filter(Boolean);
}

/** Optional copy of the whole data folder to OneDrive / a USB drive, every 30 minutes while PlanCraft runs. */
function backupSection(b) {
  const folder = h('input', { type: 'text', value: b.folder || '', placeholder: 'e.g. C:\\Users\\you\\OneDrive\\PlanCraft backup' });
  const status = h('div', null, backupStatus(b));
  const save = async () => {
    try { b = await api.setBackupFolder(folder.value.trim()); status.replaceChildren(...backupStatus(b)); toast(b.folder ? 'Backup folder saved.' : 'Folder backup turned off.'); return true; }
    catch (err) { toast(err.message, 'error'); return false; }
  };
  return h('div', { class: 'field' },
    h('label', null, 'Back up to another folder'),
    h('div', { class: 'btn-row' }, folder,
      h('button', { class: 'btn', type: 'button', onclick: save }, 'Save'),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        if (folder.value.trim() !== (b.folder || '') && !await save()) return;
        if (!b.folder) { toast('Type a backup folder first.', 'error'); return; }
        const prog = progressBox('Backing up');
        try {
          const { task } = await api.runBackup();
          const r = await api.waitTask(task, t => prog.set(null, t.message));
          prog.close();
          b = await api.getBackup();
          status.replaceChildren(...backupStatus(b));
          toast(`Backup done: ${r.copied} changed file(s) copied (${bytes(r.bytes)}).`);
        } catch (err) { prog.close(); toast(err.message, 'error'); }
      } }, 'Back up now')),
    status,
    h('div', { class: 'hint' }, 'Copies new and changed files every 30 minutes while PlanCraft is open, and never deletes anything there. ',
      'To restore a project, copy its folder from the backup\'s "projects" folder back into the data folder above.'));
}

async function openStorage() {
  let s, b;
  try { [s, b] = await Promise.all([api.storage(), api.getBackup()]); } catch (err) { toast(err.message, 'error'); return; }
  const body = h('div', { class: 'rev-compare' },
    h('p', { class: 'hint', style: { margin: 0 } }, 'Everything stays in this folder: ', h('code', null, s.path || '')),
    h('table', { class: 'pp-table' }, h('tbody', null,
      h('tr', null, h('td', null, 'Projects'), h('td', { class: 'n' }, bytes(s.projects) + ' · ' + s.projectCount + ' folder(s)')),
      h('tr', null, h('td', null, 'Templates'), h('td', { class: 'n' }, bytes(s.templates))),
      h('tr', null, h('td', null, 'Trash'), h('td', { class: 'n' }, bytes(s.trash) + ' · ' + s.trashCount + ' item(s)')),
      h('tr', null, h('td', { style: { fontWeight: 600 } }, 'Total'), h('td', { class: 'n', style: { fontWeight: 600 } }, bytes(s.total))))),
    h('div', { class: 'hint' }, 'Backups are kept inside each project (last 30, every 10 minutes). Emptying the trash is permanent.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn danger', type: 'button', disabled: !s.trashCount, onclick: async () => {
        if (!await confirmBox('Empty trash?', `Remove ${s.trashCount} deleted project folder(s)? This cannot be undone.`, { okLabel: 'Empty trash', danger: true })) return;
        try { const r = await api.emptyTrash(); toast('Trash emptied; ' + bytes(r.freed) + ' freed.'); openStorage(); }
        catch (err) { toast(err.message, 'error'); }
      } }, 'Empty trash')),
    backupSection(b));
  await modal({ title: 'Storage', size: 'wide', body, buttons: [{ label: 'Close', value: null }] });
}

/** Version and folders, plus a text block to paste into a bug report (no plans or takeoff in it). */
export async function openAbout() {
  let a;
  try { a = await api.about(); } catch (err) { toast(err.message, 'error'); return; }
  const rows = [['Version', `${a.version} (${a.frozen ? 'installed' : 'running from source'})`], ['Data folder', a.data],
    ['Log file', a.log || 'none (only the installed app writes one)'], ['Program folder', a.app],
    ['Projects', `${a.projects} · ${bytes(a.dataBytes)}`], ['OCR (Tesseract)', a.ocr ? 'installed' : 'not installed'],
    ['Folder backup', a.backup.folder ? `${a.backup.folder}${a.backup.last ? ` · last ${new Date(a.backup.last.at).toLocaleString()}` : ''}` : 'off'],
    ['Windows', a.os], ['Python', a.python], ['Libraries', Object.entries(a.libs).map(([k, v]) => `${k} ${v}`).join(', ')]];
  const text = ['PlanCraft diagnostics', ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(a.logTail ? ['', 'End of the log:', a.logTail] : [])].join('\n');
  await modal({
    title: 'About PlanCraft',
    size: 'wide',
    body: h('div', { class: 'rev-compare' },
      h('p', { style: { margin: 0 } }, 'Free, offline construction takeoff. MIT licence. Your projects never leave this computer.'),
      h('table', { class: 'pp-table' }, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, h('code', null, v)))))),
      h('label', { class: 'inline' }, 'Text and button size',
        h('select', { style: { width: 'auto' }, onchange: e => applyUiScale(Number(e.target.value)) },
          [0.9, 1, 1.1, 1.25].map(z => h('option', { value: z, selected: z === savedUiScale() }, `${Math.round(z * 100)}%`)))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(text); toast('Diagnostics copied. Paste them into your bug report.'); }
          catch { toast('Could not reach the clipboard.', 'error'); }
        } }, 'Copy diagnostics')),
      h('div', { class: 'hint' }, 'Diagnostics hold the versions, folders and the end of the log: no plans, prices or takeoff. Check them before sending.')),
    buttons: [{ label: 'Close', value: null }],
  });
}

async function duplicateProject(p) {
  const name = await promptText('Duplicate project', 'New project name', p.name + ' (copy)');
  if (!name) return;
  try {
    const copy = await api.duplicateProject(p.id, name);
    toast('Project duplicated.');
    renderHome();
    location.hash = `#/p/${encodeURIComponent(copy.id)}`;
  } catch (err) { toast(err.message, 'error'); }
}

async function openTemplates() {
  let list;
  try { list = await api.listTemplates(); } catch (err) { toast(err.message, 'error'); return; }
  if (!list.length) {
    toast('No templates yet. Open a project, use its ... menu, and choose "Save as template...".', 'error');
    return;
  }
  const body = h('div', { class: 'template-list' },
    h('p', { class: 'hint' }, 'Templates copy the price list, assemblies, folders/items and settings. They never copy pages or takeoff.'),
    ...list.map(t => h('div', { class: 'template-row' },
      h('div', { class: 'template-main' },
        h('strong', null, t.name),
        h('div', { class: 'hint' }, `${t.materials} material(s) · ${t.assemblies} assembly(ies) · ${t.units}`)),
      h('button', { class: 'btn small', type: 'button', onclick: async () => {
        const name = await promptText('New project from template', 'Project name', t.name);
        if (!name) return;
        try {
          const p = await api.createProjectFromTemplate(name, t.id);
          location.hash = `#/p/${encodeURIComponent(p.id)}`;
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Use'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
        if (!await confirmBox('Delete template?', `"${t.name}" will be removed. Projects made from it are not affected.`, { okLabel: 'Delete', danger: true })) return;
        try { await api.deleteTemplate(t.id); toast('Template removed.'); openTemplates(); }
        catch (err) { toast(err.message, 'error'); }
      } }, 'Delete'))));
  await modal({ title: 'New from template', size: 'wide', body, buttons: [{ label: 'Cancel', value: null }] });
}

async function saveAsTemplate(p) {
  const name = await promptText('Save as template', 'Template name', `${p.name} template`);
  if (!name) return;
  try {
    const t = await api.saveTemplate(p.id, name);
    toast(`Template "${t.name}" saved.`);
  } catch (err) { toast(err.message, 'error'); }
}

async function importArchive() {
  const [file] = await pickFiles('.zip', false);
  if (!file) return;
  try {
    const p = await api.upload(`/api/import/archive?filename=${encodeURIComponent(file.name)}`, file);
    toast(`Imported "${p.name}".`);
    renderHome();
  } catch (err) { toast(err.message, 'error'); }
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
