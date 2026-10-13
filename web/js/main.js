// PlanCraft: wiring of screens, toolbar, keyboard shortcuts, imports and export.
import {
  S, on, emit, loadProject, closeProject, undo, redo, canUndo, canRedo, flushSave, saveOnClose, setTool, select,
  currentPage, selectedItem, mutate, nodeById, markDirty,
} from './store.js';
import * as api from './api.js';
import * as M from './measure.js';
import { $, $$, h, isTyping, download, pickFiles, clamp } from './util.js';
import { icon } from './icons.js';
import { modal, progressBox, toast, promptText, openMenu, closeMenu } from './dialogs.js';
import { Viewer } from './viewer.js';
import { initTree, addNode } from './tree.js';
import { initPages, openPage } from './pages.js';
import { initProps } from './props.js';
import { initHome, renderHome } from './home.js';
import { scaleDialog, calibrateDialog, confirmAutoScale } from './scale.js';
import { cropToNewPage, copyPage, pastePage } from './pageops.js';
import { initMarkup } from './markup.js';
import { openMaterials } from './materials.js';
import { openPrint } from './printdialog.js';
import { getDraft, dropDraft, sameContent } from './recovery.js';
import { initAutoCount } from './autocount.js';
import { initCompare } from './compare.js';

const viewer = new Viewer($('#canvasHost'), $('#canvas'));
initMarkup(viewer);
initAutoCount(viewer, $('#canvasHost'));
const compare = initCompare(viewer, $('#canvasHost'));
const PLAN_TYPES = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.gif,.webp';
const enc = encodeURIComponent;

// ---- toolbar & buttons -----------------------------------------------------------------------------
const TOOLS = {
  select: ['select', 'Select'], takeoff: ['takeoff', 'Takeoff'], autocount: ['wand', 'Auto count'], measure: ['measure', 'Measure'],
  scale: ['scale', 'Scale'], crop: ['crop', 'Crop'], note: ['note', 'Note'], highlight: ['highlight', 'Highlight'],
};
for (const b of $$('#toolbar [data-tool]')) {
  const [ic, label] = TOOLS[b.dataset.tool];
  b.innerHTML = `${icon(ic)}<span class="lbl">${label}</span>${b.classList.contains('has-menu') ? icon('caret') : ''}`;
  b.addEventListener('click', () => (b.dataset.tool === 'takeoff' ? takeoffMenu() : chooseTool(b.dataset.tool)));
}
const TOGGLES = {
  tgOrtho: ['ortho', 'Ortho', 'ortho'], tgSnap: ['snap', 'Snap', 'snap'], tgDeduct: ['deduct', 'Deduct', 'deduct'],
  tgLabels: ['label', 'Labels', 'labels'], tgFocus: ['focus', 'Focus', 'focus'], tgProps: ['panel', '', 'showProps'], tgMarks: ['marks', '', 'showMarks'],
};
for (const [id, [ic, label, key]] of Object.entries(TOGGLES)) {
  const b = $(`#${id}`);
  b.innerHTML = `${icon(ic)}${label ? `<span class="lbl">${label}</span>` : ''}`;
  b.addEventListener('click', () => toggle(key));
}
$('#btnCompare').innerHTML = `${icon('compare')}<span class="lbl">Compare</span>`;
$('#btnCompare').addEventListener('click', () => compare.toggle());
$('#markColor').addEventListener('input', e => { S.markColor = e.target.value; });
const setBtn = (sel, ic, label) => { $(sel).innerHTML = `${icon(ic)}${label ? `<span class="lbl">${label}</span>` : ''}`; };
setBtn('#btnUndo', 'undo', '');
setBtn('#btnRedo', 'redo', '');
setBtn('#btnAddPlans', 'upload', 'Add plans');
setBtn('#btnMaterials', 'tag', 'Materials');
$('#btnExport').innerHTML = `${icon('download')}<span class="lbl">Export</span>${icon('caret')}`;
setBtn('#btnPrint', 'printer', 'Print / PDF');
setBtn('#btnHelp', 'help', '');
setBtn('#btnAddPages', 'plus', '');
setBtn('#btnPrevPage', 'left', '');
setBtn('#btnNextPage', 'right', '');
setBtn('#btnZoomIn', 'zoomIn', '');
setBtn('#btnZoomOut', 'zoomOut', '');
setBtn('#btnFit', 'fit', '');
setBtn('#btnImportJob', 'job', 'Open .SwiftJob');
setBtn('#btnNewFromPdf', 'pdf', 'New from PDF');
setBtn('#btnNewProject', 'plus', 'New project');
for (const b of $$('[data-new]')) {
  const k = b.dataset.new;
  b.innerHTML = k === 'folder' ? icon('folderPlus') : `${icon(k)}<span>${k[0].toUpperCase() + k.slice(1)}</span>`;
  b.addEventListener('click', () => addNode(k));
}

$('#btnUndo').onclick = () => undo();
$('#btnRedo').onclick = () => redo();
$('#btnAddPlans').onclick = () => addPlans();
$('#btnMaterials').onclick = () => openMaterials();
$('#btnAddPages').onclick = () => addPlans();
$('#btnExport').onclick = () => {
  const r = $('#btnExport').getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, [
    { label: 'Excel summary (.xlsx)', icon: 'excel', action: () => exportExcel() },
    { label: 'PlanSwift job (.SwiftJob)', icon: 'job', action: () => exportSwiftJob(S.project?.id) },
    { label: 'PDF of the plans...', icon: 'printer', kbd: 'Ctrl+P', action: () => printPlans() },
  ]);
};
$('#btnPrint').onclick = () => printPlans();

/** What is on screen now (page pixels), for printing just that part. */
function viewArea() {
  const page = currentPage();
  if (!page) return null;
  const [W, H] = viewer.pageSize(page);
  const a = viewer.toImg(0, 0), b = viewer.toImg(viewer.w, viewer.h);
  const x0 = Math.max(0, a[0]), y0 = Math.max(0, a[1]), x1 = Math.min(W, b[0]), y1 = Math.min(H, b[1]);
  return x1 > x0 && y1 > y0 ? { page: page.id, rect: [x0, y0, x1 - x0, y1 - y0] } : null;
}
const printPlans = () => openPrint({ viewArea });
$('#btnHelp').onclick = () => showHelp();
$('#btnPrevPage').onclick = () => stepPage(-1);
$('#btnNextPage').onclick = () => stepPage(1);
$('#btnZoomIn').onclick = () => viewer.zoomAt(1.25);
$('#btnZoomOut').onclick = () => viewer.zoomAt(0.8);
$('#btnFit').onclick = () => viewer.fit();
$('#zoomLabel').onclick = () => viewer.fit();
$('#btnImportJob').onclick = async () => { const [f] = await pickFiles('.SwiftJob,.swiftjob'); if (f) importSwiftJob(f); };
$('#btnNewFromPdf').onclick = async () => { const files = await pickFiles(PLAN_TYPES, true); if (files.length) newFromFiles(files); };
$('#btnNewProject').onclick = () => newProject();
for (const b of $$('#qtyScope button')) {
  b.addEventListener('click', () => {
    S.qtyScope = b.dataset.scope;
    $$('#qtyScope button').forEach(x => x.classList.toggle('on', x === b));
    emit('scope');
  });
}

/** The Takeoff button: carry on with the selected item, or start a new one of the chosen kind. */
function takeoffMenu() {
  if (!S.project) return;
  const r = $('#toolbar [data-tool="takeoff"]').getBoundingClientRect();
  const it = selectedItem();
  openMenu(r.left, r.bottom + 4, [
    it && { label: `Continue: ${it.name}`, icon: it.type, kbd: 'T', action: () => chooseTool('takeoff') },
    it && 'sep',
    { label: 'New linear item...', icon: 'linear', action: () => addNode('linear') },
    { label: 'New area item...', icon: 'area', action: () => addNode('area') },
    { label: 'New count item...', icon: 'count', action: () => addNode('count') },
  ]);
}

function chooseTool(tool) {
  if (!S.project) return;
  if (['scale', 'crop', 'autocount', 'note', 'highlight'].includes(tool) && !currentPage()) return;
  if (tool === 'autocount' && selectedItem()?.type !== 'count') toast('Auto count: select a count item first, then drag a box around one symbol.');
  if (tool === 'crop') toast('Drag a box around the area you want as a new page.');
  if (tool === 'takeoff' && !selectedItem()) toast('Select an item in the Takeoff list (or start one from the Takeoff button), then click on the plan.');
  setTool(tool);
}

function toggle(key) {
  S[key] = !S[key];
  if (key === 'showProps') {
    $('#workspace').classList.toggle('no-props', !S.showProps);
    try { localStorage.setItem('plancraft.props', S.showProps ? '1' : '0'); } catch { /* storage unavailable */ }
  }
  if (key === 'focus') { try { localStorage.setItem('plancraft.focus', S.focus ? '1' : '0'); } catch { /* storage unavailable */ } }
  if (key === 'showMarks' && !S.showMarks && (S.tool === 'note' || S.tool === 'highlight')) setTool('select');
  if (key === 'deduct' && S.deduct && selectedItem()?.type !== 'area') toast('Deduct applies to area items: the next area you draw becomes a cut-out.');
  updateToolbar();
  viewer.updateCursorPt();
  viewer.render();
}

function updateToolbar() {
  for (const b of $$('#toolbar [data-tool]')) {
    b.classList.toggle('on', S.tool === b.dataset.tool);
    b.setAttribute('aria-pressed', S.tool === b.dataset.tool ? 'true' : 'false');
  }
  for (const [id, [, , key]] of Object.entries(TOGGLES)) {
    $(`#${id}`).classList.toggle('on', !!S[key]);
    $(`#${id}`).setAttribute('aria-pressed', S[key] ? 'true' : 'false');
  }
  $('#tgMarks').title = S.showMarks ? 'Hide notes and highlights' : 'Show notes and highlights';
  $('#btnCompare').classList.toggle('on', compare.isOpen());
  $('#btnCompare').setAttribute('aria-pressed', compare.isOpen() ? 'true' : 'false');
  const hasPage = !!currentPage();
  for (const b of $$('#toolbar button')) if (b.id !== 'zoomLabel') b.disabled = !hasPage;
  $('#markColor').disabled = !hasPage;
  $('#btnUndo').disabled = !canUndo();
  $('#btnRedo').disabled = !canRedo();
  const pages = S.project?.pages || [];
  const i = pages.findIndex(p => p.id === S.pageId);
  $('#btnPrevPage').disabled = i <= 0;
  $('#btnNextPage').disabled = i < 0 || i >= pages.length - 1;
}
document.addEventListener('plancraft:toggles', updateToolbar);

function stepPage(d) {
  const pages = S.project?.pages || [];
  const i = pages.findIndex(p => p.id === S.pageId);
  const next = pages[i + d];
  if (next) openPage(next.id);
}

viewer.onView = () => { $('#zoomLabel').textContent = `${viewer.zoomPercent()}%`; };
viewer.onCrop = async rect => {
  const page = currentPage();
  if (page) await cropToNewPage(page, rect);
  viewer.clearCrop();
};
viewer.onScale = px => {
  const page = currentPage();
  if (page) calibrateDialog(page, px);
};

function startCalibrate() {
  if (!currentPage()) return;
  setTool('scale');
  toast('Click both ends of a dimension whose length you know.');
}

function startMeasure() {
  setTool('measure');
}

// ---- banner, empty state, status ---------------------------------------------------------------------
function updateBanner() {
  const b = $('#banner');
  const page = currentPage();
  const it = selectedItem();
  if (!page) { b.hidden = true; return; }
  const needsScale = !M.pxPerM(page) && ((S.tool === 'takeoff' && it && it.type !== 'count') || S.tool === 'measure');
  if (needsScale) {
    b.replaceChildren(h('span', { html: icon('warn') }),
      h('span', null, 'This page has no scale yet, so lengths and areas can\'t be measured.'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: startCalibrate }, 'Calibrate on plan'),
      h('button', { class: 'btn small', onclick: () => scaleDialog(page.id, { onCalibrate: startCalibrate }) }, 'Set scale...'));
    b.hidden = false;
  } else if (page.scale?.auto && M.pxPerM(page)) {
    b.replaceChildren(h('span', { html: icon('warn') }),
      h('span', null, `Scale ${page.scale.label} was read from the drawing text. Measure a known dimension to check it.`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: startMeasure }, 'Measure'),
      h('button', { class: 'btn small', onclick: () => confirmAutoScale(currentPage()) }, 'It\'s correct'),
      h('button', { class: 'btn small', onclick: () => scaleDialog(page.id, { onCalibrate: startCalibrate }) }, 'Change'));
    b.hidden = false;
  } else b.hidden = true;
}

function updateEmpty() {
  const e = $('#emptyState');
  if (S.project && !S.project.pages.length) {
    e.replaceChildren(h('div', { class: 'box' },
      h('strong', null, 'Add your plans to start'),
      h('div', null, 'PDF drawings or images (PNG, JPG, TIFF). You can also drop files here.'),
      h('button', { class: 'btn primary', onclick: () => addPlans(), html: `${icon('upload')}<span>Add PDF or images</span>` })));
    e.hidden = false;
  } else e.hidden = true;
}

function updateStatusScale() {
  const page = currentPage();
  $('#stScale').textContent = page ? `Scale: ${M.scaleLabel(page)}${page.scale?.auto ? ' (unchecked)' : ''}` : '';
}

function updateCrumb() {
  const c = $('#crumb');
  if (!S.project) { c.replaceChildren(); return; }
  c.replaceChildren(h('span', { html: icon('chevron') }),
    h('button', { class: 'proj-name', title: 'Rename project', onclick: renameProject }, S.project.name));
  document.title = `${S.project.name} - PlanCraft`;
}

function updateSaveState() {
  const el = $('#saveState');
  if (!S.project) { el.textContent = ''; return; }
  const st = S.save.state;
  el.textContent = { saved: 'Saved', pending: 'Saving soon...', saving: 'Saving...', error: 'Not saved!' }[st] || '';
  el.classList.toggle('error', st === 'error');
  el.title = st === 'error' ? `Could not save: ${S.save.error}. Retrying...` : 'Changes are saved automatically';
}

on('load', () => { updateCrumb(); updateToolbar(); updateBanner(); updateEmpty(); updateStatusScale(); updateSaveState(); });
on('change', () => { updateCrumb(); updateToolbar(); updateBanner(); updateEmpty(); updateStatusScale(); });
on('page', () => { updateToolbar(); updateBanner(); updateStatusScale(); });
on('tool', () => { updateToolbar(); updateBanner(); });
on('select', () => { updateToolbar(); updateBanner(); });
on('save', updateSaveState);

async function renameProject() {
  const name = await promptText('Rename project', 'Project name', S.project.name, { okLabel: 'Rename' });
  if (name && name !== S.project.name) mutate(p => { p.name = name; });
}

// ---- panels ------------------------------------------------------------------------------------------
initTree($('#tree'), $('#treeFilter'), { showItem });

/**
 * Jump to the page that has this item's takeoff and show it. From a search, it always zooms to the item; clicking the
 * same item again moves on to its next page. Without a search it only switches page when the item is not on this one.
 */
function showItem(id, { search = false, again = false } = {}) {
  const it = nodeById(id);
  if (!it?.sections?.length) {
    if (search) toast(`"${it?.name || 'This item'}" has no takeoff yet.`);
    return;
  }
  const pages = S.project.pages.filter(p => it.sections.some(s => s.page === p.id));
  if (!pages.length) return;
  const here = pages.findIndex(p => p.id === S.pageId);
  if (!search && here >= 0) return;
  let target = pages[here >= 0 ? here : 0];
  if (search && again && here >= 0 && pages.length > 1) target = pages[(here + 1) % pages.length];
  if (target.id !== S.pageId) openPage(target.id);
  viewer.showPoints(it.sections.filter(s => s.page === target.id).flatMap(s => s.points));
  if (pages.length > 1) {
    const n = pages.indexOf(target) + 1;
    toast(`"${it.name}": page ${n} of ${pages.length} with takeoff (${target.name}).${search ? ' Click it again for the next page.' : ''}`);
  }
}
initPages($('#pageList'), $('#pageFilter'), $('#pageCount'), {
  addPlans: () => addPlans(),
  scale: id => { openPage(id); scaleDialog(id, { onCalibrate: startCalibrate }); },
  compare: id => { openPage(id); if (!compare.isOpen()) compare.open(); },
});
initProps($('#props'), {
  exportExcel: () => exportExcel(),
  backups: () => showBackups(),
  calibrate: startCalibrate,
  measure: startMeasure,
  crop: () => chooseTool('crop'),
  reveal: sec => viewer.reveal(sec),
});
initHome($('#projectList'), { exportProject: id => download(api.exportUrl(id)), exportSwiftJob: id => exportSwiftJob(id) });

// resizable panels, remembered in this browser
const ws = $('#workspace');
function loadLayout() {
  try {
    const l = JSON.parse(localStorage.getItem('plancraft.layout') || '{}');
    for (const [k, v] of Object.entries(l)) ws.style.setProperty(k, v);
  } catch { /* storage unavailable */ }
}
function saveLayout() {
  try {
    const l = {};
    for (const k of ['--left-w', '--right-w', '--pages-h']) if (ws.style.getPropertyValue(k)) l[k] = ws.style.getPropertyValue(k);
    localStorage.setItem('plancraft.layout', JSON.stringify(l));
  } catch { /* storage unavailable */ }
}
function splitter(handle, onMove) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const move = ev => onMove(ev);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      saveLayout();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
splitter($('#splitLeft'), e => ws.style.setProperty('--left-w', `${clamp(e.clientX, 200, 560)}px`));
splitter($('#splitRight'), e => ws.style.setProperty('--right-w', `${clamp(innerWidth - e.clientX, 230, 560)}px`));
splitter($('#splitPages'), e => {
  const r = $('#leftSide').getBoundingClientRect();
  ws.style.setProperty('--pages-h', `${clamp(e.clientY - r.top, 90, r.height - 160)}px`);
});
loadLayout();
ws.classList.toggle('no-props', !S.showProps);

// ---- screens & routing -------------------------------------------------------------------------------
function showView(v) {
  $('#home').hidden = v !== 'home';
  $('#workspace').hidden = v !== 'workspace';
  $('#topActions').hidden = v !== 'workspace';
  if (v === 'home') { $('#crumb').replaceChildren(); $('#saveState').textContent = ''; document.title = 'PlanCraft'; }
}

async function route() {
  closeMenu();
  const m = location.hash.match(/^#\/p\/(.+)$/);
  const id = m ? decodeURIComponent(m[1]) : null;
  if (S.project && S.project.id !== id) {
    try { await flushSave(); } catch (err) { toast(`Could not save before leaving: ${err.message}`, 'error'); }
    closeProject();
  }
  if (id) await openProject(id);
  else { showView('home'); renderHome(); }
}

async function openProject(id) {
  if (S.project?.id === id) return;
  showView('workspace');
  let p;
  try {
    p = await api.getProject(id);
  } catch (err) {
    toast(err.message, 'error');
    location.hash = '#/';
    return;
  }
  // work that never reached the disk (PlanCraft, the browser or the PC went down): offer it back
  let recovered = false;
  const draft = await getDraft(id);
  if (draft) {
    let saved = null;
    try { saved = JSON.parse(draft.json); } catch { /* broken copy */ }
    if (saved && !sameContent(saved, p)) {
      const when = new Date(draft.at).toLocaleString();
      const choice = await modal({
        title: 'Recover unsaved work?',
        body: [h('p', { style: { margin: 0 } }, `PlanCraft closed before your last changes to "${p.name}" were saved. `,
          `A copy from ${when} was kept.`),
        h('p', { class: 'note', style: { margin: 0 } }, 'Recover brings those changes back. Discard opens the project as it was last saved.')],
        buttons: [{ label: 'Discard', value: 'discard' }, { label: 'Recover', value: 'recover', primary: true }],
        dismissable: false,
      });
      if (choice === 'recover') { p = { ...saved, id: p.id }; recovered = true; }
    }
    if (!recovered) dropDraft(id);
  }
  viewer.resize();
  loadProject(p);
  if (recovered) { markDirty(); toast('Unsaved work recovered and saved.'); }
}

window.addEventListener('hashchange', route);
// heartbeat: tells a desktop-shortcut PlanCraft (started with --idle-exit) that a window is still open
setInterval(() => fetch('/api/ping?beat=1').catch(() => {}), 30000);
fetch('/api/ping?beat=1').catch(() => {});
window.addEventListener('pagehide', saveOnClose);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveOnClose(); });

// ---- projects, imports, export -----------------------------------------------------------------------
async function newProject() {
  const name = h('input', { type: 'text', placeholder: 'e.g. 2F office lighting' });
  const units = h('select', null, M.UNIT_KEYS.map(k => h('option', { value: k }, M.unitLabel(k))));
  const ok = await modal({
    title: 'New project',
    body: [h('div', { class: 'field' }, h('label', null, 'Project name'), name), h('div', { class: 'field' }, h('label', null, 'Measure takeoff in'), units)],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: true, primary: true }],
    validate: () => (name.value.trim() ? null : 'Give the project a name.'),
  });
  if (!ok) return;
  try {
    const p = await api.createProject(name.value.trim(), units.value);
    location.hash = `#/p/${enc(p.id)}`;
  } catch (err) { toast(err.message, 'error'); }
}

async function newFromFiles(files) {
  const plans = files.filter(f => !/\.swiftjob$/i.test(f.name));
  if (!plans.length) return;
  try {
    const p = await api.createProject(plans[0].name.replace(/\.[^.]+$/, ''), 'm');
    await openProject(p.id);
    history.replaceState(null, '', `#/p/${enc(p.id)}`);
    await addPlans(plans);
  } catch (err) { toast(err.message, 'error'); }
}

async function importSwiftJob(file) {
  const prog = progressBox(`Opening ${file.name}`);
  try {
    prog.set(0, 'Uploading...');
    const { task } = await api.upload(`/api/import/swiftjob?filename=${enc(file.name)}`, file, f => prog.set(f, `Uploading... ${Math.round(f * 100)}%`));
    prog.set(null, 'Reading the job...');
    const res = await api.waitTask(task, t => prog.set(t.total ? t.done / t.total : null, t.message));
    prog.close();
    let msg = `Opened ${file.name}: ${res.pages} page(s).`;
    if (res.missingImages?.length) msg += ` ${res.missingImages.length} page image(s) were missing in the file.`;
    toast(msg);
    location.hash = `#/p/${enc(res.projectId)}`;
  } catch (err) {
    prog.close();
    toast(err.message, 'error');
  }
}

async function pdfOptions(pdfs) {
  const dpi = [['150', 'Light (150 dpi): faster, less detail'], ['200', 'Standard (200 dpi)'], ['300', 'Sharp (300 dpi): more detail, slower']];
  const radios = dpi.map(([v, label]) => h('label', null, h('input', { type: 'radio', name: 'dpi', value: v, checked: v === '200' }), label));
  const range = h('input', { type: 'text', placeholder: 'All pages, or e.g. 1-3, 5' });
  const ok = await modal({
    title: pdfs.length === 1 ? `Add "${pdfs[0].name}"` : `Add ${pdfs.length} PDFs`,
    body: [
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Quality'), h('div', { class: 'radio-list' }, radios),
        h('div', { class: 'hint' }, 'Very large sheets are capped at 10,000 pixels so they stay fast.')),
      pdfs.length === 1 ? h('div', { class: 'field' }, h('label', null, 'Pages'), range) : null,
      h('p', { class: 'note', style: { margin: 0 } }, 'If a sheet says its scale (like 1:100), PlanCraft uses it. Check it before trusting quantities.'),
    ],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add', value: true, primary: true }],
    validate: () => (/^[\d\s,\-]*$/.test(range.value) ? null : 'Pages: use numbers like 1-3, 5'),
  });
  if (!ok) return null;
  return { dpi: Number(radios.find(r => r.querySelector('input').checked).querySelector('input').value), pages: range.value.trim() };
}

async function addPlans(files) {
  if (!S.project) return;
  files ||= await pickFiles(PLAN_TYPES, true);
  files = files.filter(f => !/\.swiftjob$/i.test(f.name));
  if (!files.length) return;
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
  let opts = { dpi: 200, pages: '' };
  if (pdfs.length) { opts = await pdfOptions(pdfs); if (!opts) return; }
  const pid = S.project.id;
  const prog = progressBox('Adding plans');
  const added = [];
  try {
    for (const f of files) {
      const isPdf = /\.pdf$/i.test(f.name);
      const url = `/api/projects/${enc(pid)}/import/${isPdf ? 'pdf' : 'image'}?filename=${enc(f.name)}${isPdf ? `&dpi=${opts.dpi}&pages=${enc(opts.pages)}` : ''}`;
      const { task } = await api.upload(url, f, frac => prog.set(frac, `Uploading ${f.name}... ${Math.round(frac * 100)}%`));
      const res = await api.waitTask(task, t => prog.set(t.total ? t.done / t.total : null, `${f.name}: ${t.message}`));
      added.push(...res.pages);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
  prog.close();
  if (!added.length || S.project?.id !== pid) return;
  mutate(p => { p.pages.push(...added); });
  openPage(added[0].id);
  const auto = added.filter(p => p.scale?.auto).length;
  const none = added.filter(p => !p.scale).length;
  toast(`Added ${added.length} page(s).${auto ? ` ${auto} took the scale written on the drawing: please check it.` : ''}${none ? ` ${none} need a scale.` : ''}`);
}

/** Earlier versions of the project (kept automatically) and putting one back. */
async function showBackups() {
  if (!S.project) return;
  const pid = S.project.id;
  let list;
  try {
    await flushSave();
    list = await api.listBackups(pid);
  } catch (err) { toast(err.message, 'error'); return; }
  const pick = { name: null };
  const rows = list.map(b => {
    const radio = h('input', { type: 'radio', name: 'backup', value: b.name, onchange: () => { pick.name = b.name; } });
    return h('label', { class: 'inline', style: { gap: '10px', padding: '4px 0' } }, radio,
      h('span', { style: { minWidth: '170px' } }, new Date(b.at).toLocaleString()),
      h('span', { class: 'note' }, `${b.pages} pages, ${b.items} items, ${b.sections} sections${b.beforeRestore ? ' (before a restore)' : ''}`));
  });
  const ok = await modal({
    title: 'Backups',
    wide: true,
    body: [
      h('p', { style: { margin: 0 } }, 'PlanCraft saves by itself as you work, and keeps a copy of the project every 10 minutes (the last 30).'),
      list.length ? h('div', { class: 'radio-list', style: { maxHeight: '320px', overflow: 'auto' } }, rows)
        : h('div', { class: 'note' }, 'No backups yet. The first one is made 10 minutes after you start changing this project.'),
      h('p', { class: 'note', style: { margin: 0 } }, 'Restoring keeps a copy of the current version too, so you can always come back.'),
    ],
    buttons: [{ label: 'Close', value: null }, ...(list.length ? [{ label: 'Restore selected', value: true, primary: true }] : [])],
    validate: () => (pick.name ? null : 'Choose a backup first.'),
  });
  if (!ok || S.project?.id !== pid) return;
  try {
    const restored = await api.restoreBackup(pid, pick.name);
    loadProject(restored);
    toast(`Restored the version from ${new Date(list.find(b => b.name === pick.name).at).toLocaleString()}.`);
  } catch (err) { toast(err.message, 'error'); }
}

async function exportExcel() {
  if (!S.project) return;
  try {
    await flushSave();
    download(api.exportUrl(S.project.id));
  } catch (err) { toast(`Export failed: ${err.message}`, 'error'); }
}

/** Save a project as a PlanSwift job that opens in PlanSwift: pages, folders and takeoff with its points. */
async function exportSwiftJob(pid) {
  if (!pid) return;
  const prog = progressBox('Making the PlanSwift job');
  try {
    if (S.project?.id === pid) await flushSave();
    const res = await api.exportSwiftJob(pid, (f, msg) => prog.set(f, msg));
    prog.close();
    download(res.url);
    toast(`PlanSwift job ready: ${res.pages} page(s), ${res.items} item(s), ${(res.size / 1048576).toFixed(1)} MB.`
      + (res.deducts ? ` ${res.deducts} cut-out area(s) went in as separate "(deduct)" items.` : ''));
  } catch (err) {
    prog.close();
    toast(`PlanSwift export failed: ${err.message}`, 'error');
  }
}

function showHelp() {
  const rows = [
    ['V', 'Select / edit takeoff'], ['T', 'Take off the selected item'], ['M', 'Measure (not saved)'], ['K', 'Set scale from a known length'],
    ['C', 'Crop: drag a box to make it a new page'],
    ['A', 'Auto count: select a count item, box one symbol, review the matches, Add'],
    ['N / H', 'Note / highlighter on the plan (not counted)'], ['Ctrl+C / Ctrl+V', 'Copy the open page / paste it (also into another project)'],
    ['Click', 'Add a point (or a marker for counts)'], ['Double-click, Enter, right-click', 'Finish the run / area / count'],
    ['Backspace', 'Remove the last point while drawing'], ['Esc', 'Cancel drawing / clear selection'],
    ['Shift (hold) or O', 'Ortho: straight horizontal / vertical'], ['S', 'Snap to existing points (hold Ctrl to skip)'],
    ['D', 'Deduct: next area is a cut-out'], ['L', 'Show names on the plan'], ['G', 'Focus: fade other takeoff while an item is selected'], ['P', 'Show or hide the properties panel'],
    ['Scroll', 'Zoom at the cursor'], ['Hold right button and drag', 'Pan (works while drawing, too)'], ['Middle-drag, Space+drag, drag empty space', 'Pan'], ['F', 'Fit the page'], ['+ / -', 'Zoom in / out'],
    ['Page Up / Page Down', 'Previous / next page'],
    ['Del', 'Delete the selected section (or marker)'], ['Alt+click a point', 'Remove that point'], ['Double-click a line', 'Insert a point (Select tool)'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+P', 'Print / export the plans as PDF'], ['F2', 'Rename the selected item (in the list)'], ['Ctrl+S', 'Save now (it also saves by itself)'],
  ];
  modal({
    title: 'Keyboard and mouse',
    wide: true,
    body: h('table', { class: 'keys' }, h('tbody', null, rows.map(([k, v]) => h('tr', null,
      h('td', null, k.split(' / ').map((x, i) => [i ? ' / ' : '', h('kbd', null, x)])), h('td', null, v))))),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

// ---- keyboard ----------------------------------------------------------------------------------------
document.addEventListener('keydown', e => {
  if (!S.project || $('#workspace').hidden || document.querySelector('.modal-back')) return;
  if (isTyping(e)) return;
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl) {
    const lk = k.toLowerCase();
    if (lk === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (lk === 'y' || (lk === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (lk === 's') { e.preventDefault(); flushSave().then(() => toast('Saved.')).catch(err => toast(err.message, 'error')); }
    else if (lk === 'p') { e.preventDefault(); printPlans(); }
    else if (lk === 'c' && !window.getSelection()?.toString() && S.pageId) { e.preventDefault(); copyPage(S.pageId); }
    else if (lk === 'v') { e.preventDefault(); pastePage(); }
    return;
  }
  if (e.altKey) return;
  if (k === ' ') { e.preventDefault(); viewer.setSpace(true); return; }
  if (k === 'Shift') { viewer.shift = true; viewer.updateCursorPt(e); viewer.render(); return; }
  if (viewer.handleKey(e)) { e.preventDefault(); return; }
  const map = {
    v: () => chooseTool('select'), t: () => (selectedItem() ? chooseTool('takeoff') : takeoffMenu()), m: () => chooseTool('measure'), k: () => chooseTool('scale'), c: () => chooseTool('crop'),
    a: () => chooseTool('autocount'), n: () => chooseTool('note'), h: () => chooseTool('highlight'),
    o: () => toggle('ortho'), s: () => toggle('snap'), d: () => toggle('deduct'), l: () => toggle('labels'), g: () => toggle('focus'), p: () => toggle('showProps'),
    f: () => viewer.fit(), '+': () => viewer.zoomAt(1.25), '=': () => viewer.zoomAt(1.25), '-': () => viewer.zoomAt(0.8),
    pageup: () => stepPage(-1), pagedown: () => stepPage(1), '?': showHelp,
  };
  const fn = map[k.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});
document.addEventListener('keyup', e => {
  if (e.key === ' ') viewer.setSpace(false);
  if (e.key === 'Shift') { viewer.shift = false; viewer.updateCursorPt(e); viewer.render(); }
});
window.addEventListener('blur', () => { viewer.setSpace(false); viewer.shift = false; });

// ---- drag & drop files -------------------------------------------------------------------------------
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  const job = files.find(f => /\.swiftjob$/i.test(f.name));
  if (job) importSwiftJob(job);
  else if (S.project && !$('#workspace').hidden) addPlans(files);
  else newFromFiles(files);
});

window.plancraft = { S, viewer };   // handy from the browser console

route();
