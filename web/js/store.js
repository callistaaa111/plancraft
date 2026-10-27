// App state, undo/redo, autosave and takeoff-tree helpers.
import { uid, debounce } from './util.js';
import * as api from './api.js';
import { putDraft, dropDraft } from './recovery.js';
import { itemQuantities, unitKey } from './measure.js';

const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= new Set()).add(fn); return () => listeners[ev].delete(fn); }
export function emit(ev, data) { listeners[ev]?.forEach(fn => fn(data)); }

export const S = {
  project: null,
  pageId: null,
  sel: null,          // {type: 'item' | 'folder' | 'page', id}
  secSel: null,       // {itemId, secId, pt: index | null}
  tool: 'select',
  ortho: false,
  snap: true,
  labels: false,
  showProps: (() => { try { return localStorage.getItem('plancraft.props') === '1'; } catch { return false; } })(), // right-hand panel, closed until P
  focus: (() => { try { return localStorage.getItem('plancraft.focus') !== '0'; } catch { return true; } })(), // fade other takeoff while an item is selected
  deduct: false,
  qtyScope: 'all',
  showMarks: true,        // notes & highlights on the plan
  markColor: '#ffd400',
  version: 0,
  save: { state: 'saved', dirty: false, error: null },
};

export const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324',
  '#800000', '#469990', '#000075', '#bfef45', '#fabed4', '#dcbeff', '#ffd8b1', '#808000'];

// ---- index (rebuilt lazily whenever the project changes) -------------------------------------------
let _ix = null;
let _ixVersion = -1;

export function ix() {
  if (_ix && _ixVersion === S.version) return _ix;
  const nodes = new Map();
  const items = [];
  const pages = new Map();
  const pageIndex = new Map();
  (S.project?.pages || []).forEach((p, i) => { pages.set(p.id, p); pageIndex.set(p.id, i); });
  const walk = (list, parent, depth, hidden) => {
    for (const n of list) {
      const hid = hidden || n.visible === false;
      nodes.set(n.id, { node: n, parent, depth, hidden: hid });
      if (n.kind === 'folder') walk(n.children || (n.children = []), n, depth + 1, hid);
      else items.push(n);
    }
  };
  walk(S.project?.tree || [], null, 0, false);
  _ix = { nodes, items, pages, pageIndex, qty: new Map() };
  _ixVersion = S.version;
  return _ix;
}

export const pageById = id => ix().pages.get(id) || null;
export const nodeById = id => ix().nodes.get(id)?.node || null;
export const currentPage = () => pageById(S.pageId);
export const selectedItem = () => (S.sel?.type === 'item' ? nodeById(S.sel.id) : null);

export function qtyOf(item) {
  const x = ix();
  let q = x.qty.get(item.id);
  if (!q) { q = itemQuantities(item, x.pages, S.project.units); x.qty.set(item.id, q); }
  return q;
}

export function descendantItems(node) {
  if (node.kind !== 'folder') return [node];
  const out = [];
  const walk = list => list.forEach(n => (n.kind === 'folder' ? walk(n.children) : out.push(n)));
  walk(node.children);
  return out;
}

// ---- loading ---------------------------------------------------------------------------------------
let undoStack = [];
let redoStack = [];
let tx = null;

export function loadProject(p) {
  p.pages ||= [];
  p.tree ||= [];
  p.marks ||= [];
  p.materials ||= [];
  p.assemblies ||= [];
  p.settings ||= {};
  p.settings.allowance ||= { linear: 20, area: 0, count: 0 };
  p.units = unitKey(p.units); // 'metric' / 'imperial' from older projects -> 'm' / 'ft'
  S.project = p;
  S.pageId = p.pages[0]?.id || null;
  S.sel = null;
  S.secSel = null;
  S.tool = 'select';
  undoStack = [];
  redoStack = [];
  tx = null;
  S.save = { state: 'saved', dirty: false, error: null };
  S.version++;
  emit('load');
  emit('change');
}

export function closeProject() {
  S.project = null;
  S.pageId = null;
  S.sel = S.secSel = null;
  S.version++;
}

// ---- changes & history -----------------------------------------------------------------------------
const snap = () => {
  const p = S.project;
  return JSON.stringify({
    name: p.name, units: p.units, settings: p.settings, notes: p.notes, pages: p.pages, tree: p.tree, marks: p.marks,
    materials: p.materials, assemblies: p.assemblies,
  });
};
const restore = str => Object.assign(S.project, JSON.parse(str));

function pushUndo(before) {
  undoStack.push(before);
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}

/** Change the project. history:false for view state (folder open, visibility) that should not be undone. */
export function mutate(fn, { history = true } = {}) {
  if (!S.project) return undefined;
  const before = history && !tx ? snap() : null;
  const r = fn(S.project);
  if (before !== null) pushUndo(before);
  changed();
  return r;
}

/** Group a drag into one undo step: beginTx() on press, live() while moving, commitTx() on release. */
export function beginTx() { if (!tx) tx = snap(); }
export function live() { S.version++; emit('live'); }
export function commitTx() {
  if (!tx) return;
  const before = tx;
  tx = null;
  if (before !== snap()) { pushUndo(before); changed(); }
  else { S.version++; emit('change'); }
}
export function inTx() { return tx !== null; }

export function undo() {
  if (!undoStack.length || tx) return false;
  redoStack.push(snap());
  restore(undoStack.pop());
  fixSelection();
  changed();
  return true;
}
export function redo() {
  if (!redoStack.length || tx) return false;
  undoStack.push(snap());
  restore(redoStack.pop());
  fixSelection();
  changed();
  return true;
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

function changed() {
  S.version++;
  scheduleSave();
  emit('change');
}

function fixSelection() {
  S.version++;
  const x = ix();
  if (S.sel?.type === 'page' ? !x.pages.has(S.sel.id) : S.sel && !x.nodes.has(S.sel.id)) S.sel = null;
  if (S.secSel) {
    const it = x.nodes.get(S.secSel.itemId)?.node;
    const sec = it?.sections?.find(s => s.id === S.secSel.secId);
    if (!sec) S.secSel = null;
    else if (S.secSel.pt != null && S.secSel.pt >= sec.points.length) S.secSel.pt = null;
  }
  if (!x.pages.has(S.pageId)) S.pageId = S.project.pages[0]?.id || null;
}

// ---- selection (not saved, not undoable) ------------------------------------------------------------
export function select(sel, secSel = null) {
  S.sel = sel;
  S.secSel = secSel;
  emit('select');
}

export function setPage(id) {
  if (!pageById(id) || id === S.pageId) return;
  S.pageId = id;
  if (S.secSel) S.secSel = null;
  emit('page');
}

export function setTool(tool) {
  if (S.tool === tool) return;
  S.tool = tool;
  emit('tool');
}

// ---- autosave --------------------------------------------------------------------------------------
const saveSoon = debounce(() => saveNow(), 700);
const draftSoon = debounce(() => { if (S.project && S.save.dirty) putDraft(S.project); }, 150);
let saving = null;

function setSaveState(state, error = null) {
  S.save.state = state;
  S.save.error = error;
  emit('save');
}

function scheduleSave() {
  if (!S.project) return;
  S.save.dirty = true;
  if (S.save.state !== 'error') setSaveState('pending');
  draftSoon();          // crash copy in the browser first, then the real save
  saveSoon();
}

/** Mark the open project as changed so it gets saved (used after recovering unsaved work). */
export function markDirty() { scheduleSave(); }

export async function saveNow() {
  if (saving) await saving;
  if (!S.project || !S.save.dirty) return;
  S.save.dirty = false;
  setSaveState('saving');
  const pid = S.project.id;
  saving = api.saveProject(pid, S.project)
    .then(res => {
      if (S.project?.id === pid) S.project.modified = res.modified;   // the next save proves it saw this one
      setSaveState(S.save.dirty ? 'pending' : 'saved');
      if (!S.save.dirty) { draftSoon.cancel(); dropDraft(pid); }     // on disk now: the crash copy is not needed
    })
    .catch(err => {
      S.save.dirty = true;
      setSaveState('error', err.message);
      if (err.status !== 409) setTimeout(() => { if (S.save.dirty) saveSoon(); }, 4000);   // 409: reload, retrying cannot help
    })
    .finally(() => { saving = null; });
  await saving;
}

/** Make sure everything is on disk (before export, leaving the project, ...). Throws if it can't. */
export async function flushSave() {
  saveSoon.cancel();
  await saveNow();
  if (S.save.dirty) await saveNow();
  if (S.save.state === 'error') throw new Error(S.save.error || 'Could not save');
}

export function saveOnClose() {
  // saving: the save started when the window was hidden may be cut off by the close, so send it again
  if (S.project && (S.save.dirty || saveSoon.pending() || saving)) {
    saveSoon.cancel();
    api.beaconSave(S.project.id, S.project);
  }
}

// ---- tree editing ----------------------------------------------------------------------------------
export function listOf(parentId) {
  if (!parentId) return S.project.tree;
  const n = nodeById(parentId);
  return n?.kind === 'folder' ? n.children : S.project.tree;
}

export function parentIdOf(id) {
  return ix().nodes.get(id)?.parent?.id || null;
}

/** Where a new node goes: inside the selected folder, after the selected item, or at the end. */
export function insertionPoint() {
  if (S.sel?.type === 'folder') return { parentId: S.sel.id, index: null };
  if (S.sel?.type === 'item') {
    const parentId = parentIdOf(S.sel.id);
    const list = listOf(parentId);
    return { parentId, index: list.findIndex(n => n.id === S.sel.id) + 1 };
  }
  return { parentId: null, index: null };
}

export function insertNode(node, parentId, index) {
  const list = listOf(parentId);
  list.splice(index == null ? list.length : index, 0, node);
}

export function removeNode(id) {
  const list = listOf(parentIdOf(id));
  const i = list.findIndex(n => n.id === id);
  return i >= 0 ? list.splice(i, 1)[0] : null;
}

/** Move a node before/after another node, or into a folder. Returns false if not allowed. */
export function moveNode(id, targetId, where) {
  if (id === targetId) return false;
  const x = ix();
  // no dropping a folder into itself or its own children
  for (let p = x.nodes.get(targetId); p; p = p.parent ? x.nodes.get(p.parent.id) : null) {
    if (p.node.id === id) return false;
  }
  mutate(() => {
    const node = removeNode(id);
    if (where === 'inside') {
      const folder = nodeById(targetId);
      folder.children.push(node);
      folder.open = true;
    } else {
      const list = listOf(x.nodes.get(targetId).parent?.id || null);
      const i = list.findIndex(n => n.id === targetId);
      list.splice(where === 'after' ? i + 1 : i, 0, node);
    }
  });
  return true;
}

export function uniqueName(base) {
  const names = new Set(ix().items.map(i => i.name).concat([...ix().nodes.values()].map(e => e.node.name)));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function newItem(type, name) {
  const p = S.project;
  const count = ix().items.length;
  const props = { description: '', spec: '', notes: '', allowance: p.settings.allowance?.[type] ?? 0 };
  if (type === 'linear') Object.assign(props, { lineWidth: 3, height: null });
  if (type === 'area') Object.assign(props, { opacity: 0.3, depth: null });
  if (type === 'count') Object.assign(props, { shape: 'circle', size: 9 });
  return { id: uid('i'), kind: 'item', type, name, color: PALETTE[count % PALETTE.length], visible: true, props, sections: [] };
}

export function newFolder(name) {
  return { id: uid('f'), kind: 'folder', name, open: true, visible: true, children: [] };
}

export function cloneNode(node, withTakeoff = false) {
  const c = JSON.parse(JSON.stringify(node));
  const reid = n => {
    n.id = uid(n.kind === 'folder' ? 'f' : 'i');
    if (n.kind === 'folder') n.children.forEach(reid);
    else n.sections = withTakeoff ? n.sections.map(s => ({ ...s, id: uid('s') })) : [];
  };
  reid(c);
  return c;
}

/** Number of takeoff sections each page holds (for the pages list). */
export function sectionsPerPage() {
  const x = ix();
  if (x.secCount) return x.secCount;
  const m = new Map();
  for (const it of x.items) for (const s of it.sections) m.set(s.page, (m.get(s.page) || 0) + 1);
  x.secCount = m;
  return m;
}
