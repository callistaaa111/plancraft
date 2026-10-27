// "Materials & prices": the price list and the assemblies (material recipes attached to items or folders).
import { S, ix, mutate, qtyOf } from './store.js';
import * as api from './api.js';
import { h, uid, pickFiles, fmt } from './util.js';
import { icon } from './icons.js';
import { modal, toast, confirmBox } from './dialogs.js';
import { BASES, costing, money } from './pricing.js';

let tab = 'prices';
let current = null;          // assembly being edited
let search = '';

const P = () => S.project;
function ensure() {
  P().materials ||= [];
  P().assemblies ||= [];
}

/** How many items use each assembly (directly or through a folder). */
function usage() {
  const x = ix();
  const count = new Map();
  for (const it of x.items) {
    for (let e = x.nodes.get(it.id); e; e = e.parent ? x.nodes.get(e.parent.id) : null) {
      const a = e.node.kind === 'folder' ? e.node.assembly : e.node.props?.assembly;
      if (a) { count.set(a, (count.get(a) || 0) + 1); break; }
    }
  }
  return count;
}

export async function openMaterials(startTab = null, assemblyId = null) {
  if (!P()) return;
  ensure();
  if (startTab) tab = startTab;
  if (assemblyId) { tab = 'assemblies'; current = assemblyId; }
  const content = h('div', { class: 'mat-body' });
  const tabs = h('div', { class: 'seg mat-tabs', role: 'tablist' });
  const render = () => {
    tabs.replaceChildren(
      h('button', { class: tab === 'prices' ? 'on' : '', role: 'tab', onclick: () => { tab = 'prices'; render(); } }, `Price list (${P().materials.length})`),
      h('button', { class: tab === 'assemblies' ? 'on' : '', role: 'tab', onclick: () => { tab = 'assemblies'; render(); } }, `Assemblies (${P().assemblies.length})`),
      h('button', { class: tab === 'quote' ? 'on' : '', role: 'tab', onclick: () => { tab = 'quote'; render(); } }, 'Quote'));
    content.replaceChildren(tab === 'prices' ? pricesTab(render) : tab === 'quote' ? quoteTab(render) : assembliesTab(render));
  };
  render();
  await modal({
    title: 'Materials & prices',
    size: 'xl',
    enterSubmits: false,
    body: [tabs, content],
    buttons: [{ label: 'Done', value: true, primary: true }],
  });
}

// ---- price list --------------------------------------------------------------------------------------
function pricesTab(render) {
  const cur = P().settings?.currency ?? '₱';
  const used = new Map();
  for (const a of P().assemblies) for (const p of a.parts || []) used.set(p.material, (used.get(p.material) || 0) + 1);
  const q = search.toLowerCase();
  const list = P().materials.filter(m => !q || `${m.name} ${m.category || ''}`.toLowerCase().includes(q));
  const set = (m, key, value) => mutate(() => { const t = P().materials.find(x => x.id === m.id); if (t) t[key] = value; });
  const cell = (m, key, attrs = {}) => {
    const i = h('input', { type: 'text', value: m[key] ?? '', ...attrs });
    i.addEventListener('change', () => set(m, key, attrs.type === 'number' ? (i.value === '' ? 0 : Number(i.value)) : i.value.trim()));
    i.addEventListener('keydown', e => e.stopPropagation());
    return i;
  };
  const filter = h('input', { type: 'search', placeholder: 'Search materials', value: search, style: { maxWidth: '220px' } });
  filter.addEventListener('input', () => { search = filter.value; const pos = filter.selectionStart; render(); const f = document.querySelector('.mat-body input[type=search]'); f?.focus(); f?.setSelectionRange(pos, pos); });
  return h('div', { class: 'mat-tab' },
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small primary', onclick: () => { mutate(() => P().materials.push({ id: uid('mt'), name: 'New material', unit: 'm', price: 0, category: '', whole: false })); search = ''; render(); setTimeout(() => { const rows = document.querySelectorAll('.mat-table tbody tr'); rows[rows.length - 1]?.querySelector('input[data-k=name]')?.select(); }); }, html: `${icon('plus')}<span>Add material</span>` }),
      h('button', { class: 'btn small', onclick: () => importPrices(render), html: `${icon('upload')}<span>Import from Excel / CSV...</span>` }),
      h('span', { class: 'spacer' }), filter),
    list.length ? h('div', { class: 'mat-scroll' }, h('table', { class: 'mat-table' },
      h('thead', null, h('tr', null, h('th', null, 'Category'), h('th', null, 'Material'), h('th', null, 'Unit'), h('th', null, `Price (${cur})`),
        h('th', { title: 'Sold in whole units: the total is rounded up' }, 'Whole'),
        h('th', { title: 'Count this rate as labour, not material' }, 'Labour'), h('th', null, ''))),
      h('tbody', null, list.map(m => h('tr', null,
        h('td', null, cell(m, 'category', { placeholder: 'e.g. Wires' })),
        h('td', null, cell(m, 'name', { 'data-k': 'name' })),
        h('td', { class: 'narrow' }, cell(m, 'unit')),
        h('td', { class: 'narrow' }, cell(m, 'price', { type: 'number', step: 'any', min: 0 })),
        h('td', { class: 'center' }, (() => { const c = h('input', { type: 'checkbox', checked: !!m.whole, title: 'Round the total up to whole units' }); c.addEventListener('change', () => set(m, 'whole', c.checked)); return c; })()),
        h('td', { class: 'center' }, (() => { const c = h('input', { type: 'checkbox', checked: m.kind === 'labour', title: 'This is a labour rate (hours, crew-days)' }); c.addEventListener('change', () => set(m, 'kind', c.checked ? 'labour' : 'material')); return c; })()),
        h('td', { class: 'center' }, h('button', {
          class: 'btn ghost small icon-only', title: used.get(m.id) ? `Used in ${used.get(m.id)} assembly part(s)` : 'Delete', html: icon('trash'),
          onclick: async () => {
            if (used.get(m.id) && !(await confirmBox('Delete material?', `"${m.name}" is used in ${used.get(m.id)} assembly part(s); those parts will be removed too.`, { okLabel: 'Delete', danger: true }))) return;
            mutate(() => {
              P().materials = P().materials.filter(x => x.id !== m.id);
              for (const a of P().assemblies) a.parts = (a.parts || []).filter(p => p.material !== m.id);
            });
            render();
          },
        })))))))
      : h('div', { class: 'empty-note' }, q ? 'No materials match.' : 'No materials yet. Add them one by one, or import a supplier price list from Excel.'));
}

function quoteTab(render) {
  const s = (P().settings ||= {});
  const c = costing(P(), ix(), qtyOf);
  const set = (key, value) => mutate(() => { P().settings[key] = value; });
  const pct = (key, label, title) => h('tr', null,
    h('td', null, label),
    h('td', { class: 'num' }, (() => {
      const i = h('input', { type: 'number', step: '0.1', min: 0, value: s[key] ?? 0, title });
      i.addEventListener('change', () => { set(key, Number(i.value) || 0); render(); });
      return i;
    })()),
    h('td', { class: 'hint' }, title));
  const line = (label, value, strong = false) => h('div', { class: 'line' },
    h('span', { style: strong ? { fontWeight: 700 } : null }, label),
    h('span', { style: strong ? { fontWeight: 700 } : null }, money(value, P())));
  const cur = s.currency ?? '₱';
  return h('div', { class: 'mat-tab' },
    h('div', { class: 'hint' }, `Costs use the currency ${cur}. Mark a material as Labour to split it out; no separate labour table is needed.`),
    h('div', { class: 'mat-scroll' }, h('table', { class: 'mat-table' },
      h('thead', null, h('tr', null, h('th', null, 'Setting'), h('th', { class: 'narrow' }, 'Percent'), h('th', null, 'What it does'))),
      h('tbody', null,
        pct('overhead', 'Overhead', 'Office and site overhead on the material + labour subtotal'),
        pct('contingency', 'Contingency', 'Risk allowance on subtotal + overhead'),
        pct('markup', 'Markup', 'Profit on subtotal + overhead + contingency'),
        pct('tax', 'VAT / tax', 'Tax on subtotal + overhead + contingency + markup')))),
    h('div', { class: 'qtybox' },
      line('Materials', c.materials),
      line('Labour', c.labour),
      line('Subtotal', c.subtotal, true),
      c.overheadAmount ? line(`Overhead ${c.overhead}%`, c.overheadAmount) : null,
      c.contingencyAmount ? line(`Contingency ${c.contingency}%`, c.contingencyAmount) : null,
      c.markupAmount ? line(`Markup ${c.markup}%`, c.markupAmount) : null,
      c.taxAmount ? line(`Tax ${c.tax}%`, c.taxAmount) : null,
      line('Total', c.total, true),
      h('div', { class: 'line' }, h('span', null, 'Different priced lines'), h('span', null, String(c.bom.length)))),
    c.bom.length ? h('div', { class: 'hint' }, 'The Excel export has this breakdown in its Bill of Materials and Quote sheets.')
      : h('div', { class: 'hint' }, 'No assembled items yet: assign an assembly to an item or folder to see costs.'));
}

async function importPrices(render) {
  const [file] = await pickFiles('.xlsx,.xlsm,.csv', false);
  if (!file) return;
  let res;
  try { res = await api.upload(`/api/pricelist/parse?filename=${encodeURIComponent(file.name)}`, file); }
  catch (err) { toast(err.message, 'error'); return; }
  const rows = res.rows || [];
  if (!rows.length) { toast('No prices found in that file. It needs a description column and a price column.', 'error'); return; }
  const byName = new Map(P().materials.map(m => [m.name.trim().toLowerCase(), m]));
  const updates = rows.filter(r => byName.has(r.name.trim().toLowerCase())).length;
  const ok = await modal({
    title: `Import ${rows.length} prices`,
    body: [
      h('p', { style: { margin: 0 } }, `From "${file.name}"${res.sheet ? `, sheet "${res.sheet}"` : ''}: ${rows.length - updates} new material(s), ${updates} price update(s) for materials you already have (matched by name).`),
      h('div', { class: 'mat-scroll', style: { maxHeight: '260px' } }, h('table', { class: 'mat-table' },
        h('thead', null, h('tr', null, h('th', null, 'Category'), h('th', null, 'Material'), h('th', null, 'Unit'), h('th', null, 'Price'))),
        h('tbody', null, rows.slice(0, 200).map(r => h('tr', null, h('td', null, r.category || ''), h('td', null, r.name), h('td', null, r.unit || ''), h('td', { class: 'num' }, fmt(r.price))))))),
      rows.length > 200 ? h('div', { class: 'note' }, `...and ${rows.length - 200} more.`) : null,
    ],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import', value: true, primary: true }],
  });
  if (!ok) return;
  mutate(() => {
    for (const r of rows) {
      const m = byName.get(r.name.trim().toLowerCase());
      if (m) { m.price = r.price; if (r.unit) m.unit = r.unit; if (r.category && !m.category) m.category = r.category; }
      else {
        const n = { id: uid('mt'), name: r.name.trim(), unit: r.unit || 'pc', price: r.price, category: r.category || '', whole: false };
        P().materials.push(n);
        byName.set(n.name.toLowerCase(), n);
      }
    }
  });
  toast(`Imported ${rows.length} prices.`);
  render();
}

// ---- assemblies ----------------------------------------------------------------------------------------
function assembliesTab(render) {
  const list = P().assemblies;
  if (!list.find(a => a.id === current)) current = list[0]?.id || null;
  const uses = usage();
  const add = () => {
    const a = { id: uid('as'), name: 'New assembly', parts: [] };
    mutate(() => P().assemblies.push(a));
    current = a.id;
    render();
    setTimeout(() => document.querySelector('.asm-name')?.select());
  };
  const left = h('div', { class: 'asm-list' },
    h('button', { class: 'btn small primary', onclick: add, html: `${icon('plus')}<span>New assembly</span>` }),
    list.map(a => h('button', { class: `asm-row${a.id === current ? ' on' : ''}`, onclick: () => { current = a.id; render(); } },
      h('span', null, a.name), h('span', { class: 'note' }, uses.get(a.id) ? `${uses.get(a.id)} item(s)` : 'not used'))));
  const a = list.find(x => x.id === current);
  if (!a) {
    return h('div', { class: 'mat-tab asm' }, left, h('div', { class: 'empty-note' },
      'An assembly is a recipe of materials, for example "Lighting circuit" = 2 x 3.5 mm² wire per metre (with allowance) + 20 mm conduit per metre. ',
      'Attach it to an item or a whole folder in the right-hand panel, and PlanCraft works out the bill of materials.'));
  }
  const upd = fn => mutate(() => { const t = P().assemblies.find(x => x.id === a.id); if (t) fn(t); });
  const name = h('input', { type: 'text', class: 'asm-name', value: a.name });
  name.addEventListener('change', () => { upd(t => { t.name = name.value.trim() || 'Assembly'; }); render(); });
  name.addEventListener('keydown', e => e.stopPropagation());
  const mats = [...P().materials].sort((x, y) => `${x.category} ${x.name}`.localeCompare(`${y.category} ${y.name}`));
  const partRow = p => {
    const setPart = (k, v) => upd(t => { const q = t.parts.find(x => x.id === p.id); if (q) q[k] = v; });
    const mat = h('select', null, h('option', { value: '' }, 'Choose material...'),
      mats.map(m => h('option', { value: m.id, selected: m.id === p.material }, `${m.category ? `${m.category}: ` : ''}${m.name} (${m.unit})`)));
    mat.addEventListener('change', () => setPart('material', mat.value));
    const factor = h('input', { type: 'number', step: 'any', value: p.factor ?? 1, title: 'Multiply by' });
    factor.addEventListener('change', () => setPart('factor', factor.value === '' ? 1 : Number(factor.value)));
    const basis = h('select', null, Object.entries(BASES).map(([k, label]) => h('option', { value: k, selected: k === (p.basis || 'qty') }, label)));
    basis.addEventListener('change', () => setPart('basis', basis.value));
    const pack = h('input', { type: 'number', step: 'any', min: 0, value: p.pack ?? 1, title: 'Divide by (e.g. 3 for 3 m conduit pieces)' });
    pack.addEventListener('change', () => setPart('pack', pack.value === '' || Number(pack.value) <= 0 ? 1 : Number(pack.value)));
    [factor, pack].forEach(i => i.addEventListener('keydown', e => e.stopPropagation()));
    return h('tr', null, h('td', null, mat), h('td', { class: 'narrow' }, factor), h('td', { class: 'x' }, 'x'), h('td', null, basis),
      h('td', { class: 'x' }, '÷'), h('td', { class: 'narrow' }, pack),
      h('td', { class: 'center' }, h('button', { class: 'btn ghost small icon-only', title: 'Remove part', html: icon('trash'), onclick: () => { upd(t => { t.parts = t.parts.filter(x => x.id !== p.id); }); render(); } })));
  };
  const right = h('div', { class: 'asm-edit' },
    h('div', { class: 'field' }, h('label', null, 'Assembly name'), name),
    h('div', { class: 'note' }, 'Each part: material quantity = number x what it is based on ÷ pack size. Example: wire = 2 x its quantity + allowance ÷ 1 (two conductors); conduit pieces = 1 x its quantity ÷ 3 (3 m lengths, tick Whole on the material).'),
    mats.length ? null : h('div', { class: 'callout' }, 'Add materials to the price list first.'),
    h('div', { class: 'mat-scroll' }, h('table', { class: 'mat-table parts' },
      h('thead', null, h('tr', null, h('th', null, 'Material'), h('th', null, 'Number'), h('th'), h('th', null, 'Based on'), h('th'), h('th', null, 'Pack'), h('th'))),
      h('tbody', null, (a.parts || []).map(partRow)))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', disabled: !mats.length, onclick: () => { upd(t => { (t.parts ||= []).push({ id: uid('pt'), material: '', factor: 1, basis: 'qty', pack: 1 }); }); render(); }, html: `${icon('plus')}<span>Add part</span>` }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => { const c = JSON.parse(JSON.stringify(a)); c.id = uid('as'); c.name = `${a.name} copy`; c.parts.forEach(p => { p.id = uid('pt'); }); mutate(() => P().assemblies.push(c)); current = c.id; render(); }, html: `${icon('copy')}<span>Duplicate</span>` }),
      h('button', {
        class: 'btn small danger', html: `${icon('trash')}<span>Delete</span>`,
        onclick: async () => {
          const n = uses.get(a.id) || 0;
          if (n && !(await confirmBox('Delete assembly?', `"${a.name}" is used by ${n} item(s). They will have no materials until you choose another assembly.`, { okLabel: 'Delete', danger: true }))) return;
          mutate(() => {
            P().assemblies = P().assemblies.filter(x => x.id !== a.id);
            for (const e of ix().nodes.values()) {
              if (e.node.kind === 'folder' && e.node.assembly === a.id) e.node.assembly = null;
              if (e.node.props?.assembly === a.id) e.node.props.assembly = null;
            }
          });
          render();
        },
      })),
    h('div', { class: 'note' }, uses.get(a.id) ? `Used by ${uses.get(a.id)} item(s).` : 'Not used yet: pick it as the Assembly of an item or folder in the right-hand panel.'));
  return h('div', { class: 'mat-tab asm' }, left, right);
}
