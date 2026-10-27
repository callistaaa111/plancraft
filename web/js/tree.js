// The Takeoff list: folders and items with their quantities.
import {
  S, on, ix, mutate, select, setTool, qtyOf, nodeById, moveNode, removeNode, insertNode, insertionPoint, newItem,
  newFolder, uniqueName, cloneNode, descendantItems, listOf, parentIdOf, PALETTE,
} from './store.js';
import { h, fmt } from './util.js';
import { icon } from './icons.js';
import { openMenu, confirmBox, modal } from './dialogs.js';
import { copyNode, hasNodeClip, pasteNode } from './itemclip.js';

const TYPE_NAME = { linear: 'Linear', area: 'Area', count: 'Count' };
let el = null;
let filter = '';
let renaming = null;
let dragId = null;
let lastSel = null;
let showItem = null;     // (id, {search}) -> jump to the page with the item's takeoff (set by main)

export function initTree(container, filterInput, actions = {}) {
  el = container;
  showItem = actions.showItem || null;
  filterInput.addEventListener('input', () => { filter = filterInput.value.trim().toLowerCase(); render(); });
  el.addEventListener('click', onClick);
  el.addEventListener('dblclick', onDbl);
  el.addEventListener('contextmenu', onContext);
  el.addEventListener('keydown', onKey);
  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) clearDrop(); });
  el.addEventListener('drop', onDrop);
  el.addEventListener('dragend', () => { dragId = null; clearDrop(); });
  on('change', render);
  on('select', render);
  on('page', () => { if (S.qtyScope === 'page' || S.project) render(); });
  on('scope', render);
  on('load', () => { filter = ''; filterInput.value = ''; render(); });
  on('draft', showDraft);
}

function qtyFor(item) {
  const q = qtyOf(item);
  if (S.qtyScope === 'page') return q.perPage.get(S.pageId)?.qty ?? 0;
  return q.qty;
}

const fmtQ = (item, v) => (item.type === 'count' ? fmt(v, 0) : fmt(v, 2));

let draftRow = null;   // id of the row showing a running total
/** Running total on the row of the item being drawn; the row goes back to its saved total afterwards. */
function showDraft(d) {
  if (draftRow && draftRow !== d?.itemId) setRowQty(draftRow, 0);
  draftRow = d?.itemId || null;
  if (d) setRowQty(d.itemId, d.qty);
}

function setRowQty(id, add) {
  const n = nodeById(id);
  const row = el?.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  const q = row?.querySelector('.qty');
  if (!n || !q) return;
  q.textContent = fmtQ(n, qtyFor(n) + add);
  row.classList.toggle('drawing', !!add);
}

export function render() {
  if (!el || !S.project || renaming) return;
  const x = ix();
  // "This page" shows only items with takeoff on the open page (and a selected item or folder that has no takeoff
  // anywhere yet, so a new one stays visible; one selected on another page is not carried over)
  const pageOnly = S.qtyScope === 'page';
  const keep = new Set();
  if (filter || pageOnly) {
    const textHit = n => !filter || n.name.toLowerCase().includes(filter) || (n.props?.description || '').toLowerCase().includes(filter);
    const onPage = n => !pageOnly || qtyOf(n).perPage.has(S.pageId);
    const isNew = n => (n.kind === 'folder' ? !descendantItems(n).some(i => i.sections.length) : !n.sections?.length);
    const walk = list => list.reduce((any, n) => {
      const hit = (n.id === S.sel?.id && isNew(n)) || (n.kind === 'folder'
        ? walk(n.children) || (!pageOnly && textHit(n))
        : textHit(n) && onPage(n));
      if (hit) keep.add(n.id);
      return any || hit;
    }, false);
    walk(S.project.tree);
  }
  const rows = [];
  const add = (list, depth) => {
    for (const n of list) {
      if ((filter || pageOnly) && !keep.has(n.id)) continue;
      rows.push(n.kind === 'folder' ? folderRow(n, depth, x) : itemRow(n, depth, x));
      if (n.kind === 'folder' && (n.open || filter)) add(n.children, depth + 1);
    }
  };
  add(S.project.tree, 0);
  if (!rows.length) {
    rows.push(h('div', { class: 'empty-note' }, filter ? 'No items match your search.'
      : pageOnly && x.items.length ? 'No takeoff on this page yet. Pick an item and click on the plan, or switch to "All pages".'
        : 'No takeoff items yet. Press Takeoff in the toolbar and pick Linear, Area or Count, then click on the plan.'));
  }
  el.replaceChildren(...rows);
  if (S.draftQty) setRowQty(S.draftQty.itemId, S.draftQty.qty);   // keep a running total across redraws
  if (S.sel?.id && S.sel.id !== lastSel) {
    el.querySelector(`.row[data-id="${CSS.escape(S.sel.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  lastSel = S.sel?.id || null;
}

const appendKids = (el, ...kids) => el.append(...kids.filter(Boolean));

function baseRow(n, depth, x, extraClass) {
  const sel = S.sel && S.sel.id === n.id;
  const hidden = x.nodes.get(n.id)?.hidden;
  return h('div', {
    class: `row${sel ? ' sel' : ''}${hidden ? ' hidden-node' : ''}${extraClass}`, draggable: 'true',
    dataset: { id: n.id }, style: `--d:${depth}`, role: 'treeitem', 'aria-selected': sel ? 'true' : 'false',
  });
}

function eyeBtn(n) {
  return h('button', { class: 'eye', dataset: { act: 'eye' }, title: n.visible === false ? 'Show on plan' : 'Hide on plan', html: icon(n.visible === false ? 'eyeOff' : 'eye') });
}

function folderRow(n, depth, x) {
  const r = baseRow(n, depth, x, n.open || filter ? ' open' : '');
  const items = descendantItems(n);
  const units = new Set(items.map(i => qtyOf(i).unit));
  let qty = '';
  let unit = '';
  if (items.length && units.size === 1) {
    const sum = items.reduce((a, i) => a + qtyFor(i), 0);
    qty = fmtQ(items[0], sum);
    unit = [...units][0];
  }
  appendKids(r,
    h('span', { class: 'twisty', dataset: { act: 'twisty' }, html: icon('chevron') }),
    h('span', { class: 'ticon', html: icon('folder') }),
    h('span', { class: 'name', title: n.name }, n.name),
    h('span', { class: 'qty' }, qty),
    h('span', { class: 'unit' }, unit),
    eyeBtn(n),
  );
  return r;
}

function itemRow(n, depth, x) {
  const r = baseRow(n, depth, x, '');
  const q = qtyOf(n);
  const onPage = q.perPage.has(S.pageId);
  appendKids(r,
    h('span', { class: 'twisty' }),
    h('span', { class: 'swatch', style: { background: n.color } }),
    h('span', { class: 'ticon', html: icon(n.type), title: TYPE_NAME[n.type] }),
    h('span', { class: `name${onPage ? ' on-page' : ''}`, title: `${n.name}${n.props?.description ? ` - ${n.props.description}` : ''}${onPage ? '\n(has takeoff on this page)' : ''}` }, n.name),
    q.unscaled ? h('span', { class: 'warn-dot', title: `${q.unscaled} section(s) are on pages without a scale and are not counted`, html: icon('warn') }) : null,
    n.props?.check ? h('span', { class: 'warn-dot', title: 'Flagged for review', html: icon('warn') }) : null,
    h('span', { class: 'qty' }, fmtQ(n, qtyFor(n))),
    h('span', { class: 'unit' }, q.unit),
    eyeBtn(n),
  );
  return r;
}

// ---- actions ---------------------------------------------------------------------------------------
export function selectNode(id, { takeoff = true } = {}) {
  const n = nodeById(id);
  if (!n) return;
  select({ type: n.kind === 'folder' ? 'folder' : 'item', id });
  if (n.kind === 'item' && takeoff) setTool('takeoff');
}

/** Folders are named in the list; items first get a small window for their name and colour. */
export async function addNode(kind) {
  if (!S.project) return;
  const { parentId, index } = insertionPoint();
  let node;
  if (kind === 'folder') node = newFolder(uniqueName('New folder'));
  else {
    node = newItem(kind, uniqueName(TYPE_NAME[kind]));
    const picked = await itemDialog(kind, node);
    if (!picked) return;
    Object.assign(node, picked);
  }
  mutate(() => {
    insertNode(node, parentId, index);
    if (parentId) nodeById(parentId).open = true;
  });
  selectNode(node.id, { takeoff: kind !== 'folder' });
  if (kind === 'folder') startRename(node.id);   // the row was rendered synchronously by the change above
}

const TYPE_HINT = { linear: 'lengths (wires, conduits, cable trays)', area: 'areas (floors, rooms, ceilings)', count: 'counts (lights, outlets, switches)' };

/** Name and colour for a new item. Resolves {name, color} or null. */
async function itemDialog(kind, node) {
  let color = node.color;
  const name = h('input', { type: 'text', value: node.name, maxlength: 120 });
  const custom = h('input', { type: 'color', value: color, title: 'Any colour', 'aria-label': 'Any colour' });
  const preview = h('span', { class: 'new-item-preview', html: icon(kind) });
  const swatches = PALETTE.map(c => h('button', {
    type: 'button', class: 'swatch-btn', title: c, 'aria-label': `Colour ${c}`, style: { background: c },
    onclick: () => setColor(c),
  }));
  function setColor(c) {
    color = c;
    custom.value = c;
    preview.style.color = c;
    swatches.forEach(b => b.classList.toggle('on', b.title === c));
  }
  custom.addEventListener('input', () => setColor(custom.value));
  setColor(color);
  const ok = await modal({
    title: `New ${TYPE_NAME[kind].toLowerCase()} item`,
    body: [
      h('p', { class: 'note', style: { margin: 0 } }, `For ${TYPE_HINT[kind]}.`),
      h('div', { class: 'field' }, h('label', null, 'Name'), h('div', { class: 'inline' }, preview, name)),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Colour'),
        h('div', { class: 'swatch-grid' }, swatches, custom)),
    ],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create and take off', value: true, primary: true }],
    validate: () => (name.value.trim() ? null : 'Give the item a name.'),
  });
  return ok ? { name: name.value.trim(), color } : null;
}

export async function deleteNode(id) {
  const node = nodeById(id);
  if (!node) return;
  const items = descendantItems(node);
  const secs = items.reduce((a, i) => a + i.sections.length, 0);
  if (secs || (node.kind === 'folder' && items.length)) {
    const what = node.kind === 'folder' ? `The folder "${node.name}" and its ${items.length} item(s)` : `"${node.name}"`;
    const ok = await confirmBox(`Delete ${node.kind === 'folder' ? 'folder' : 'item'}?`,
      `${what} will be deleted${secs ? `, including ${secs} takeoff section(s)` : ''}. You can undo with Ctrl+Z.`,
      { okLabel: 'Delete', danger: true });
    if (!ok) return;
  }
  mutate(() => removeNode(id));
  if (S.sel && !nodeById(S.sel.id)) select(null);
}

export function duplicateNode(id) {
  const node = nodeById(id);
  if (!node) return;
  const copy = cloneNode(node, false);
  copy.name = uniqueName(`${node.name} copy`);
  const parentId = parentIdOf(id);
  const list = listOf(parentId);
  mutate(() => insertNode(copy, parentId, list.indexOf(node) + 1));
  selectNode(copy.id, { takeoff: false });
}

function toggleVisible(id) {
  const n = nodeById(id);
  mutate(() => { n.visible = n.visible === false; }, { history: false });
}

function toggleOpen(id, open) {
  const n = nodeById(id);
  if (n?.kind !== 'folder') return;
  mutate(() => { n.open = open ?? !n.open; }, { history: false });
}

export function startRename(id) {
  const rowEl = el.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  const node = nodeById(id);
  if (!rowEl || !node) return;
  rowEl.scrollIntoView({ block: 'nearest' });
  const nameEl = rowEl.querySelector('.name');
  const input = h('input', { type: 'text', value: node.name, 'aria-label': 'Name' });
  renaming = id;
  rowEl.draggable = false;
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    renaming = null;
    const v = input.value.trim();
    if (commit && v && v !== node.name) mutate(() => { node.name = v; });
    else render();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); el.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); el.focus(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('dblclick', e => e.stopPropagation());
}

// ---- events ----------------------------------------------------------------------------------------
function rowOf(e) { return e.target.closest('.row[data-id]'); }

function onClick(e) {
  const r = rowOf(e);
  if (!r) return;
  const id = r.dataset.id;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'eye') { toggleVisible(id); return; }
  if (act === 'twisty') { toggleOpen(id); return; }
  const again = S.sel?.id === id;
  selectNode(id);
  if (nodeById(id)?.kind === 'item') showItem?.(id, { search: !!filter, again });
}

function onDbl(e) {
  const r = rowOf(e);
  if (!r || e.target.closest('[data-act]')) return;
  const n = nodeById(r.dataset.id);
  if (n?.kind === 'folder' && !e.target.closest('.name')) { toggleOpen(n.id); return; }
  startRename(r.dataset.id);
}

function onContext(e) {
  e.preventDefault();
  const r = rowOf(e);
  if (!r) {
    select(null);
    openMenu(e.clientX, e.clientY, [
      { label: 'New linear item', icon: 'linear', action: () => addNode('linear') },
      { label: 'New area item', icon: 'area', action: () => addNode('area') },
      { label: 'New count item', icon: 'count', action: () => addNode('count') },
      { label: 'New folder', icon: 'folderPlus', action: () => addNode('folder') },
      hasNodeClip() && 'sep',
      hasNodeClip() && { label: 'Paste item/folder', icon: 'paste', action: () => pasteNode(null) },
    ].filter(Boolean));
    return;
  }
  const n = nodeById(r.dataset.id);
  selectNode(n.id, { takeoff: false });
  const isFolder = n.kind === 'folder';
  openMenu(e.clientX, e.clientY, [
    isFolder && { label: 'New linear item here', icon: 'linear', action: () => addNode('linear') },
    isFolder && { label: 'New area item here', icon: 'area', action: () => addNode('area') },
    isFolder && { label: 'New count item here', icon: 'count', action: () => addNode('count') },
    isFolder && { label: 'New folder here', icon: 'folderPlus', action: () => addNode('folder') },
    isFolder && 'sep',
    !isFolder && { label: 'Take off on plan', icon: 'takeoff', kbd: 'T', action: () => selectNode(n.id) },
    { label: 'Rename', icon: 'rename', kbd: 'F2', action: () => startRename(n.id) },
    { label: isFolder ? 'Copy folder' : 'Copy item', icon: 'copy', action: () => copyNode(n.id) },
    hasNodeClip() && { label: 'Paste here', icon: 'paste', action: () => pasteNode(n.id) },
    { label: isFolder ? 'Duplicate (items without takeoff)' : 'Duplicate (without takeoff)', icon: 'copy', action: () => duplicateNode(n.id) },
    { label: n.visible === false ? 'Show on plan' : 'Hide on plan', icon: n.visible === false ? 'eye' : 'eyeOff', action: () => toggleVisible(n.id) },
    'sep',
    { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, action: () => deleteNode(n.id) },
  ]);
}

function onKey(e) {
  if (renaming) return;
  const rows = [...el.querySelectorAll('.row[data-id]')];
  const i = rows.findIndex(r => r.dataset.id === S.sel?.id);
  const id = S.sel?.id;
  const n = id && nodeById(id);
  let handled = true;
  switch (e.key) {
    case 'ArrowDown': if (rows.length) selectNode(rows[Math.min(rows.length - 1, i + 1)].dataset.id, { takeoff: false }); break;
    case 'ArrowUp': if (rows.length) selectNode(rows[Math.max(0, i - 1)].dataset.id, { takeoff: false }); break;
    case 'ArrowRight': if (n?.kind === 'folder') toggleOpen(id, true); else handled = false; break;
    case 'ArrowLeft':
      if (n?.kind === 'folder' && n.open) toggleOpen(id, false);
      else if (n && parentIdOf(id)) selectNode(parentIdOf(id), { takeoff: false });
      else handled = false;
      break;
    case 'F2': if (n) startRename(id); break;
    case 'Delete': if (n) deleteNode(id); else handled = false; break;
    case 'Enter': if (n?.kind === 'item') selectNode(id); else if (n) toggleOpen(id); break;
    default: handled = false;
  }
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

function zone(r, e) {
  const rect = r.getBoundingClientRect();
  const rel = (e.clientY - rect.top) / rect.height;
  if (nodeById(r.dataset.id)?.kind === 'folder') return rel < 0.28 ? 'before' : rel > 0.72 ? 'after' : 'inside';
  return rel < 0.5 ? 'before' : 'after';
}

function clearDrop() {
  el.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach(r => r.classList.remove('drop-before', 'drop-after', 'drop-inside'));
}

function onDragStart(e) {
  const r = rowOf(e);
  if (!r || renaming) { e.preventDefault(); return; }
  dragId = r.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-plancraft-node', dragId);
}

function onDragOver(e) {
  if (!dragId) return;
  e.preventDefault();
  e.stopPropagation();
  clearDrop();
  const r = rowOf(e);
  if (r && r.dataset.id !== dragId) r.classList.add(`drop-${zone(r, e)}`);
}

function onDrop(e) {
  if (!dragId) return;
  e.preventDefault();
  e.stopPropagation();
  const r = rowOf(e);
  const id = dragId;
  dragId = null;
  clearDrop();
  if (r && r.dataset.id !== id) moveNode(id, r.dataset.id, zone(r, e));
  else if (!r) {
    mutate(() => { const node = removeNode(id); S.project.tree.push(node); });
  }
}
