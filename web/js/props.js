// Right-hand panel: properties of the selected item / folder, or of the open page and the project.
import {
  S, on, mutate, beginTx, live, commitTx, nodeById, currentPage, qtyOf, descendantItems, setPage, sectionsPerPage, ix, PALETTE,
} from './store.js';
import * as M from './measure.js';
import { h, fmt } from './util.js';
import { icon } from './icons.js';
import { addNode, deleteNode, duplicateNode, selectNode } from './tree.js';
import { scaleDialog, confirmAutoScale } from './scale.js';
import { deletePage, renamePage } from './pages.js';
import { copyPage, pastePage, hasClip, rotatePage } from './pageops.js';
import { openMaterials } from './materials.js';
import { assemblyFor, itemParts, costing, money } from './pricing.js';
import { toast } from './dialogs.js';

let el = null;
let A = {};               // actions from main: exportExcel, calibrate, reveal(sec)
const TYPE_NAME = { linear: 'Linear item', area: 'Area item', count: 'Count item' };
const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'cross'];

export function initProps(container, actions) {
  el = container;
  A = actions;
  on('select', render);
  on('page', render);
  on('load', render);
  on('clip', render);
  on('change', () => (el.contains(document.activeElement) && document.activeElement !== el ? refresh() : render()));
  on('live', refresh);
  on('draft', showDraft);
}

/** While a run is being drawn, the selected item's total includes it (marked as in progress). */
function showDraft(d) {
  const node = S.sel ? nodeById(S.sel.id) : null;
  const big = el?.querySelector('.qtybox .big');
  if (!big || node?.kind !== 'item') return;
  const add = d && d.itemId === node.id ? d.qty : 0;
  big.firstChild.textContent = fmt(qtyOf(node).qty + add, node.type === 'count' ? 0 : 2);
  big.classList.toggle('drawing', !!add);
  let line = el.querySelector('.qtybox .draft-line');
  if (!add) { line?.remove(); return; }
  if (!line) {
    line = h('div', { class: 'line draft-line' }, h('span', null, 'Drawing now'), h('span'));
    big.after(line);
  }
  line.lastChild.textContent = `${add > 0 ? '+' : ''}${fmt(add, 2)} ${qtyOf(node).unit}`;
}

// ---- field helpers ---------------------------------------------------------------------------------
function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

/** Text/number input that commits on change (one undo step per edit). */
function input(value, onCommit, attrs = {}) {
  const i = h('input', { type: 'text', value: value ?? '', ...attrs });
  i.addEventListener('change', () => onCommit(i.value));
  i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); e.stopPropagation(); });
  return i;
}

function numInput(value, onCommit, attrs = {}) {
  return input(value ?? '', v => {
    const t = String(v).trim().replace(',', '.');
    onCommit(t === '' ? null : Number(t));
  }, { type: 'number', step: 'any', ...attrs });
}

/** Range/colour: live preview while dragging, one undo step when released. */
function liveInput(type, value, apply, attrs = {}) {
  const i = h('input', { type, value, ...attrs });
  let started = false;
  i.addEventListener('input', () => {
    if (!started) { beginTx(); started = true; }
    apply(i.value);
    live();
  });
  i.addEventListener('change', () => { started = false; commitTx(); });
  return i;
}

function setProp(node, key, value) {
  mutate(() => { node.props[key] = value; });
}

/** Height and depth are typed in the item's unit: rescale them when that unit changes. */
function rescaleSizes(it, from, to) {
  const f = M.unitInfo(to).perM / M.unitInfo(from).perM;
  for (const k of ['height', 'depth']) {
    const v = Number(it.props?.[k]);
    if (v && isFinite(v)) it.props[k] = +(v * f).toPrecision(10);
  }
}

function unitField(it) {
  const p = it.props;
  if (it.type === 'count') {
    const sel = h('select', { onchange: e => setProp(it, 'unit', e.target.value === 'ea' ? undefined : e.target.value) },
      M.COUNT_UNITS.map(u => h('option', { value: u, selected: (M.COUNT_UNITS.includes(p.unit) ? p.unit : 'ea') === u }, u)));
    return field('Count unit', sel, 'The label shown with the count and in the Excel export.');
  }
  const own = M.UNIT_KEYS.includes(p.unit) ? p.unit : '';
  const proj = S.project.units;
  const sel = h('select', {
    onchange: e => mutate(() => {
      const v = e.target.value;
      rescaleSizes(it, M.itemUnits(it, proj), v || proj);
      if (v) p.unit = v; else delete p.unit;
    }),
  },
  h('option', { value: '', selected: !own }, `Project unit (${M.unitInfo(proj).len})`),
  M.UNIT_KEYS.map(k => h('option', { value: k, selected: own === k }, M.unitLabel(k))));
  return field('Measure in', sel, 'Takeoff on the plan is measured and totalled in this unit.');
}

// ---- materials -------------------------------------------------------------------------------------
const assemblies = () => new Map((S.project.assemblies || []).map(a => [a.id, a]));

/** Assembly picker for an item (empty = use the folder's) or a folder (empty = use the parent folder's). */
function assemblyField(node) {
  const isFolder = node.kind === 'folder';
  const own = isFolder ? node.assembly : node.props?.assembly;
  const x = ix();
  const parentId = x.nodes.get(node.id)?.parent?.id;
  const inherited = parentId ? assemblyFor(parentId, x, assemblies()) : null;
  const list = S.project.assemblies || [];
  const sel = h('select', { 'aria-label': 'Assembly' },
    h('option', { value: '' }, inherited ? `From folder "${inherited.from.name}": ${inherited.assembly.name}` : 'None'),
    list.map(a => h('option', { value: a.id, selected: a.id === own }, a.name)));
  sel.addEventListener('change', () => mutate(() => {
    if (isFolder) node.assembly = sel.value || null;
    else node.props.assembly = sel.value || null;
  }));
  return field(isFolder ? 'Assembly for items in this folder' : 'Assembly (materials)', h('div', { class: 'inline' }, sel,
    h('button', { class: 'btn small', title: 'Price list and assemblies', onclick: () => openMaterials(list.length ? 'assemblies' : 'prices', own || inherited?.assembly.id) }, 'Edit...')),
  list.length ? (isFolder ? 'Items inside without their own assembly use this one.' : null)
    : 'No assemblies yet: press Edit to add materials and make one.');
}

/** Materials and cost of one item. */
function itemCost(it) {
  const x = ix();
  const a = assemblyFor(it.id, x, assemblies());
  if (!a) return null;
  const parts = itemParts(it, qtyOf(it), a.assembly, new Map((S.project.materials || []).map(m => [m.id, m])));
  const total = parts.reduce((t, p) => t + p.amount, 0);
  return h('div', { style: { marginTop: '10px' } },
    h('div', { class: 'section-title' }, `Materials: ${a.assembly.name}`),
    parts.length ? h('table', { class: 'pp-table' }, h('tbody', null,
      parts.map(pt => h('tr', { style: { cursor: 'default' } },
        h('td', null, pt.material.name),
        h('td', { class: 'n' }, `${fmt(pt.qty)} ${pt.material.unit || ''}`),
        h('td', { class: 'n' }, money(pt.amount, S.project)))),
      h('tr', { style: { cursor: 'default' } }, h('td', { style: { fontWeight: 600 } }, 'Total'), h('td'), h('td', { class: 'n', style: { fontWeight: 600 } }, money(total, S.project)))))
      : h('div', { class: 'note' }, 'This assembly has no parts yet.'));
}

function costBox(items) {
  const c = costing(S.project, ix(), qtyOf, items);
  if (!c.bom.length) return null;
  const line = (label, value, strong = false) => h('div', { class: 'line' },
    h('span', { style: strong ? { fontWeight: 600 } : null }, label),
    h('span', { style: strong ? { fontWeight: 600 } : null }, money(value, S.project)));
  return h('div', { class: 'qtybox' },
    line('Materials', c.materials),
    c.labour ? line('Labour', c.labour) : null,
    line('Subtotal', c.subtotal, true),
    c.overheadAmount ? line(`Overhead ${c.overhead}%`, c.overheadAmount) : null,
    c.contingencyAmount ? line(`Contingency ${c.contingency}%`, c.contingencyAmount) : null,
    c.markupAmount ? line(`Markup ${c.markup}%`, c.markupAmount) : null,
    c.taxAmount ? line(`Tax ${c.tax}%`, c.taxAmount) : null,
    line('Total', c.total, true),
    h('div', { class: 'line' }, h('span', null, 'Different priced lines'), h('span', null, String(c.bom.length))));
}

// ---- render ----------------------------------------------------------------------------------------
export function render() {
  if (!el) return;
  if (!S.project) { el.replaceChildren(); return; }
  const node = S.sel && (S.sel.type === 'item' || S.sel.type === 'folder') ? nodeById(S.sel.id) : null;
  let body;
  if (node?.kind === 'item') body = itemPanel(node);
  else if (node?.kind === 'folder') body = folderPanel(node);
  else body = pagePanel();
  el.replaceChildren(body);
  if (S.draftQty) showDraft(S.draftQty);   // keep a running total across redraws
}

function refresh() {
  if (!el || !S.project) return;
  const node = S.sel ? nodeById(S.sel.id) : null;
  const box = el.querySelector('[data-dyn]');
  if (!box) return;
  const title = el.querySelector('.props .title');
  if (title && node) title.textContent = node.name;
  if (node?.kind === 'item') { box.replaceWith(itemQty(node)); if (S.draftQty) showDraft(S.draftQty); }
  else if (node?.kind === 'folder') box.replaceWith(folderQty(node));
  else render();
}

function head(kind, iconName, title, color) {
  return h('div', null,
    h('div', { class: 'head' },
      color ? h('span', { class: 'swatch', style: { width: '12px', height: '12px', borderRadius: '3px', background: color } }) : null,
      h('span', { class: 'ticon', html: icon(iconName) }),
      h('span', { class: 'kind' }, kind)),
    h('div', { class: 'title' }, title));
}

// ---- item ------------------------------------------------------------------------------------------
function itemPanel(it) {
  const p = it.props || (it.props = {});
  const u = M.unitInfo(M.itemUnits(it, S.project.units));
  const color = liveInput('color', it.color, v => { it.color = v; });
  const swatches = h('div', { class: 'inline', style: { gap: '4px', flexWrap: 'wrap' } },
    PALETTE.slice(0, 10).map(c => h('button', {
      type: 'button', title: c, 'aria-label': `Colour ${c}`, style: { width: '18px', height: '18px', borderRadius: '4px', border: '1px solid rgba(0,0,0,.25)', background: c, cursor: 'pointer', padding: 0 },
      onclick: () => mutate(() => { it.color = c; }),
    })));
  const typeFields = [];
  if (it.type === 'linear') {
    const val = h('span', { class: 'val' }, `${p.lineWidth || 3}px`);
    typeFields.push(field('Line width on plan', h('div', { class: 'inline' },
      liveInput('range', p.lineWidth || 3, v => { p.lineWidth = Number(v); val.textContent = `${v}px`; }, { min: 1, max: 12, step: 1 }), val)));
    typeFields.push(field(`Height (${u.len})`, numInput(p.height, v => setProp(it, 'height', v), { placeholder: 'optional' }),
      'Fill in for wall area = length x height.'));
  } else if (it.type === 'area') {
    const val = h('span', { class: 'val' }, `${Math.round((p.opacity ?? 0.3) * 100)}%`);
    typeFields.push(field('Fill opacity', h('div', { class: 'inline' },
      liveInput('range', p.opacity ?? 0.3, v => { p.opacity = Number(v); val.textContent = `${Math.round(v * 100)}%`; }, { min: 0.05, max: 0.9, step: 0.05 }), val)));
    typeFields.push(field(`Depth / thickness (${u.len})`, numInput(p.depth, v => setProp(it, 'depth', v), { placeholder: 'optional' }),
      'Fill in for volume = area x depth.'));
  } else {
    const val = h('span', { class: 'val' }, `${p.size || 9}px`);
    const shape = h('select', { onchange: e => setProp(it, 'shape', e.target.value) },
      SHAPES.map(s => h('option', { value: s, selected: (p.shape || 'circle') === s }, s[0].toUpperCase() + s.slice(1))));
    typeFields.push(h('div', { class: 'field-row' },
      field('Marker', shape),
      field('Size', h('div', { class: 'inline' }, liveInput('range', p.size || 9, v => { p.size = Number(v); val.textContent = `${v}px`; }, { min: 4, max: 24, step: 1 }), val))));
  }
  return h('div', { class: 'props' },
    head(TYPE_NAME[it.type], it.type, it.name, it.color),
    itemQty(it),
    h('div', { class: 'btn-row' },
      h('button', { class: `btn small${S.tool === 'takeoff' ? ' primary' : ''}`, onclick: () => selectNode(it.id), html: `${icon('takeoff')}<span>Take off on plan</span>` }),
      h('button', { class: 'btn small', onclick: () => duplicateNode(it.id), html: `${icon('copy')}<span>Duplicate</span>` }),
      h('button', { class: 'btn small danger', onclick: () => deleteNode(it.id), html: `${icon('trash')}<span>Delete</span>` })),
    field('Name', input(it.name, v => { if (v.trim()) mutate(() => { it.name = v.trim(); }); })),
    field('Colour', h('div', { class: 'inline' }, color, swatches)),
    unitField(it),
    ...typeFields,
    field('Description', input(p.description, v => setProp(it, 'description', v), { placeholder: 'e.g. LIGHTING, POWER' })),
    field('Spec / type', input(p.spec, v => setProp(it, 'spec', v), { placeholder: 'e.g. 3.5 mm² THHN in 20 mm PVC' }),
      'Shown as TYPE OF WIRE in the Excel circuit sheet.'),
    field('Allowance %', numInput(p.allowance ?? 0, v => setProp(it, 'allowance', v ?? 0), { min: 0, step: 1 }),
      'Added on top and rounded up, like =ROUNDUP(LM*1.2,0).'),
    field('Manual adjustment', numInput(p.adjust ?? 0, v => setProp(it, 'adjust', v ?? 0), { step: 0.01 }),
      'A plus or minus on the total, for site conditions or an agreed omission.'),
    field('Adjustment reason', input(p.adjustNote, v => setProp(it, 'adjustNote', v), { placeholder: 'e.g. omit riser per RFI 12' })),
    assemblyField(it),
    field('Review', (() => {
      const cb = h('input', { type: 'checkbox', checked: !!p.check });
      cb.addEventListener('change', () => setProp(it, 'check', cb.checked));
      return h('label', { class: 'inline' }, cb, 'Flag this item for review');
    })()),
    field('Notes', (() => {
      const t = h('textarea', { rows: 3 }, p.notes || '');
      t.addEventListener('change', () => setProp(it, 'notes', t.value));
      t.addEventListener('keydown', e => e.stopPropagation());
      return t;
    })()),
  );
}

function itemQty(it) {
  const q = qtyOf(it);
  const p = it.props || {};
  const dp = it.type === 'count' ? 0 : 2;
  const allow = Number(p.allowance) || 0;
  const pages = S.project.pages.filter(pg => q.perPage.has(pg.id));
  const lines = [];
  if (allow) lines.push(h('div', { class: 'line' }, h('span', null, `With ${allow}% allowance`), h('span', null, `${fmt(M.withAllowance(q.qty, allow), 0)} ${q.unit}`)));
  for (const e of q.extra) lines.push(h('div', { class: 'line' }, h('span', null, e.label), h('span', null, `${fmt(e.value)} ${e.unit}`)));
  if (p.adjustNote) lines.push(h('div', { class: 'line' }, h('span', null, 'Adjustment reason'), h('span', null, p.adjustNote)));
  const secs = it.sections.length;
  lines.push(h('div', { class: 'line' }, h('span', null, it.type === 'count' ? 'Markers' : 'Sections'),
    h('span', null, it.type === 'count' ? `${it.sections.reduce((a, s) => a + s.points.length, 0)} in ${secs} group(s)` : String(secs))));
  return h('div', { 'data-dyn': '' },
    h('div', { class: 'qtybox' },
      h('div', { class: 'big' }, fmt(q.qty, dp), h('small', null, q.unit),
        h('button', { class: 'btn ghost small', type: 'button', title: 'Copy the quantity', onclick: async () => {
          try { await navigator.clipboard.writeText(fmt(q.qty, dp)); toast('Quantity copied.'); }
          catch { toast('Could not copy the quantity.', 'error'); }
        } }, 'Copy')),
      lines,
      q.unscaled ? h('div', { class: 'warn' }, `${q.unscaled} section(s) are on pages without a scale and are not counted. Set the scale on those pages.`) : null,
      !secs ? h('div', { class: 'note' }, 'No takeoff yet. Click on the plan to start.') : null),
    pages.length ? h('div', { style: { marginTop: '10px' } },
      h('div', { class: 'section-title' }, 'By page'),
      h('table', { class: 'pp-table' }, h('tbody', null, pages.map(pg => {
        const e = q.perPage.get(pg.id);
        const scaled = it.type === 'count' || M.pxPerM(pg);
        return h('tr', {
          class: pg.id === S.pageId ? 'cur' : '', title: 'Show on plan',
          onclick: () => { setPage(pg.id); const sec = it.sections.find(s => s.page === pg.id); requestAnimationFrame(() => A.reveal?.(sec)); },
        },
        h('td', null, pg.name),
        h('td', { class: 'n' }, scaled ? `${fmt(e.qty, dp)} ${q.unit}` : 'no scale'));
      })))) : null,
    itemCost(it));
}

// ---- folder ----------------------------------------------------------------------------------------
function folderPanel(f) {
  return h('div', { class: 'props' },
    head('Folder', 'folder', f.name),
    folderQty(f),
    field('Name', input(f.name, v => { if (v.trim()) mutate(() => { f.name = v.trim(); }); })),
    assemblyField(f),
    h('div', { class: 'section-title' }, 'Add to this folder'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => addNode('linear'), html: `${icon('linear')}<span>Linear</span>` }),
      h('button', { class: 'btn small', onclick: () => addNode('area'), html: `${icon('area')}<span>Area</span>` }),
      h('button', { class: 'btn small', onclick: () => addNode('count'), html: `${icon('count')}<span>Count</span>` }),
      h('button', { class: 'btn small', onclick: () => addNode('folder'), html: `${icon('folderPlus')}<span>Folder</span>` })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => duplicateNode(f.id), html: `${icon('copy')}<span>Duplicate</span>` }),
      h('button', { class: 'btn small danger', onclick: () => deleteNode(f.id), html: `${icon('trash')}<span>Delete folder</span>` })));
}

function folderQty(f) {
  const items = descendantItems(f);
  const byUnit = new Map();
  for (const it of items) {
    const q = qtyOf(it);
    byUnit.set(q.unit, (byUnit.get(q.unit) || 0) + q.qty);
  }
  return h('div', { 'data-dyn': '' },
    h('div', { class: 'qtybox' },
      h('div', { class: 'line' }, h('span', null, 'Items'), h('span', null, String(items.length))),
      [...byUnit].map(([unit, v]) => h('div', { class: 'line' }, h('span', null, `Total ${unit}`), h('span', null, `${fmt(v, unit === 'ea' ? 0 : 2)} ${unit}`)))),
    costBox(items));
}

// ---- page & project ----------------------------------------------------------------------------------
function pagePanel() {
  const page = currentPage();
  const parts = [];
  if (page) {
    const sc = page.scale;
    const n = sectionsPerPage().get(page.id) || 0;
    const itemsOnPage = ix().items.filter(it => it.sections.some(s => s.page === page.id)).length;
    let scaleBox;
    if (!M.pxPerM(page)) scaleBox = h('div', { class: 'callout' }, 'No scale yet: lengths and areas on this page are not counted.');
    else if (sc.auto) {
      scaleBox = h('div', { class: 'callout' }, `${sc.label} was read from the drawing text. Measure a known dimension to check it.`,
        h('div', { class: 'btn-row', style: { marginTop: '8px' } },
          h('button', { class: 'btn small', onclick: () => A.measure?.(), html: `${icon('measure')}<span>Measure</span>` }),
          h('button', { class: 'btn small', onclick: () => confirmAutoScale(currentPage()), html: `${icon('check')}<span>It's correct</span>` })));
    } else scaleBox = h('div', { class: 'callout ok' }, `Scale: ${sc.label || 'Calibrated'}`);
    parts.push(
      head('Page', 'page', page.name),
      field('Name', input(page.name, v => { if (v.trim()) mutate(() => { currentPage().name = v.trim(); }); })),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Scale'), scaleBox,
        h('div', { class: 'btn-row', style: { marginTop: '6px' } },
          h('button', { class: 'btn small', onclick: () => scaleDialog(page.id, { onCalibrate: A.calibrate }), html: `${icon('scale')}<span>Set scale...</span>` }),
          h('button', { class: 'btn small', onclick: () => A.calibrate?.(), html: `${icon('measure')}<span>Calibrate on plan</span>` }))),
      h('div', { class: 'stat-grid' },
        h('span', null, 'Takeoff here'), h('span', null, `${n} section(s), ${itemsOnPage} item(s)`),
        h('span', null, 'Image'), h('span', null, `${page.width || '?'} x ${page.height || '?'} px`),
        h('span', null, 'Resolution'), h('span', null, page.dpi ? `${Math.round(page.dpi)} dpi` : 'unknown'),
        page.source ? [h('span', null, 'Source'), h('span', { title: page.source, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '150px' } }, `${page.source}${page.sourcePage ? ` p.${page.sourcePage}` : ''}`)] : null,
        page.group ? [h('span', null, 'Group'), h('span', null, page.group)] : null),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => A.crop?.(), title: 'Drag a box on the plan to make it a new page (C)', html: `${icon('crop')}<span>Crop to new page</span>` }),
        h('button', { class: 'btn small', onclick: () => copyPage(page.id), title: 'Ctrl+C', html: `${icon('copy')}<span>Copy</span>` }),
        hasClip() ? h('button', { class: 'btn small', onclick: () => pastePage(), title: 'Ctrl+V', html: `${icon('paste')}<span>Paste</span>` }) : null),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => rotatePage(page.id, 3), title: 'Turn the page 90° to the left', html: `${icon('undo')}<span>Rotate left</span>` }),
        h('button', { class: 'btn small', onclick: () => rotatePage(page.id, 1), title: 'Turn the page 90° to the right', html: `${icon('redo')}<span>Rotate right</span>` }),
        h('button', { class: 'btn small', onclick: () => renamePage(page.id), html: `${icon('rename')}<span>Rename</span>` }),
        h('button', { class: 'btn small danger', onclick: () => deletePage(page.id), html: `${icon('trash')}<span>Delete page</span>` })),
      h('hr', { style: { border: 0, borderTop: '1px solid var(--border)', margin: '6px 0', width: '100%' } }));
  }
  parts.push(projectPanel());
  return h('div', { class: 'props' }, parts);
}

function projectPanel() {
  const p = S.project;
  const x = ix();
  const secs = x.items.reduce((a, i) => a + i.sections.length, 0);
  const allow = p.settings.allowance;
  const allowInput = type => numInput(allow[type] ?? 0, v => mutate(() => { p.settings.allowance[type] = v ?? 0; }), { min: 0, step: 1, 'aria-label': `Default allowance for ${type} items` });
  const unitsSel = h('select', {
    onchange: e => mutate(() => {
      for (const it of x.items) if (!M.UNIT_KEYS.includes(it.props?.unit)) rescaleSizes(it, p.units, e.target.value);
      p.units = e.target.value;
    }),
  }, M.UNIT_KEYS.map(k => h('option', { value: k, selected: M.unitKey(p.units) === k }, M.unitLabel(k))));
  return h('div', { class: 'props', style: { padding: 0 } },
    head('Project', 'job', p.name),
    h('div', { class: 'stat-grid' },
      h('span', null, 'Pages'), h('span', null, String(p.pages.length)),
      h('span', null, 'Items'), h('span', null, String(x.items.length)),
      h('span', null, 'Takeoff sections'), h('span', null, String(secs)),
      p.importedFrom ? [h('span', null, 'Imported from'), h('span', { title: p.importedFrom, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '150px' } }, p.importedFrom)] : null),
    field('Measure takeoff in', unitsSel, 'Items can also pick their own unit under Measure in.'),
    h('div', { class: 'field' }, h('div', { class: 'label' }, 'Materials & prices'),
      costBox(x.items) || h('div', { class: 'note' }, 'Add a price list and assemblies to get a bill of materials and costs.'),
      h('div', { class: 'field-row', style: { marginTop: '6px' } },
        h('div', null, h('div', { class: 'hint' }, 'Currency'), input(p.settings.currency ?? '₱', v => mutate(() => { p.settings.currency = v.trim(); }), { maxlength: 4 })),
        h('div', null, h('div', { class: 'hint' }, 'Markup %'), numInput(p.settings.markup ?? 0, v => mutate(() => { p.settings.markup = v ?? 0; }), { min: 0, step: 1 }))),
      h('button', { class: 'btn small', style: { marginTop: '6px' }, onclick: () => openMaterials(), html: `${icon('tag')}<span>Materials & prices...</span>` })),
    h('div', { class: 'field' }, h('div', { class: 'label' }, 'Default allowance % for new items'),
      h('div', { class: 'field-row', style: { gridTemplateColumns: '1fr 1fr 1fr' } },
        h('div', null, h('div', { class: 'hint' }, 'Linear'), allowInput('linear')),
        h('div', null, h('div', { class: 'hint' }, 'Area'), allowInput('area')),
        h('div', null, h('div', { class: 'hint' }, 'Count'), allowInput('count')))),
    h('button', { class: 'btn primary', onclick: () => A.exportExcel?.(), html: `${icon('excel')}<span>Export to Excel</span>` }),
    h('button', { class: 'btn small', onclick: () => A.backups?.(), title: 'Earlier versions of this project, saved automatically', html: `${icon('undo')}<span>Backups...</span>` }),
    h('p', { class: 'note', style: { margin: 0 } }, 'The workbook has a summary of every item, quantities by page, a PANEL circuit sheet (for items named like PANEL-1), the bill of materials with costs, and the page scales.'));
}
