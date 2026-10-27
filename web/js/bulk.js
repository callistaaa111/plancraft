// Bulk edit several takeoff items without changing the normal single-selection model.
import { S, ix, mutate, qtyOf } from './store.js';
import { h, fmt } from './util.js';
import { modal, toast } from './dialogs.js';

const COUNT_UNITS = ['ea', 'pcs', 'set', 'lot', 'unit', 'pair'];
const LENGTH_UNITS = ['m', 'cm', 'mm', 'ft', 'in', 'yd'];

export function openBulkEdit() {
  if (!S.project) return;
  const items = ix().items;
  if (!items.length) { toast('There are no items to edit yet.'); return; }
  const selected = new Set();
  const list = h('div', { class: 'bulk-list' });
  const filter = h('input', { type: 'search', placeholder: 'Filter items...' });
  const color = h('input', { type: 'color', value: '#e4572e' });
  const colorOn = h('input', { type: 'checkbox' });
  const unit = h('select', null,
    h('option', { value: '' }, 'Leave unit'),
    ...LENGTH_UNITS.map(u => h('option', { value: u }, u)),
    ...COUNT_UNITS.map(u => h('option', { value: u }, u)));
  const allowance = h('input', { type: 'number', step: '0.1', min: 0, placeholder: 'Leave' });
  const visibility = h('select', null,
    h('option', { value: '' }, 'Leave visibility'),
    h('option', { value: 'show' }, 'Show'),
    h('option', { value: 'hide' }, 'Hide'));
  const assembly = h('select', null,
    h('option', { value: '' }, 'Leave assembly'),
    h('option', { value: '__none' }, 'No assembly'),
    ...(S.project.assemblies || []).map(a => h('option', { value: a.id }, a.name)));

  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = items.filter(it => !q || (it.name + ' ' + (it.props?.description || '')).toLowerCase().includes(q));
    list.replaceChildren(...rows.map(it => {
      const cb = h('input', { type: 'checkbox', checked: selected.has(it.id) });
      cb.addEventListener('change', () => { if (cb.checked) selected.add(it.id); else selected.delete(it.id); });
      const qty = qtyOf(it);
      return h('label', { class: 'bulk-row' }, cb,
        h('span', { class: 'bulk-type' }, it.type),
        h('span', { class: 'bulk-name' }, it.name),
        h('span', { class: 'bulk-qty' }, qty ? fmt(qty.qty, it.type === 'count' ? 0 : 2) + ' ' + qty.unit : '—'));
    }));
  };
  filter.addEventListener('input', draw);
  draw();

  const body = h('div', { class: 'rev-compare' },
    h('div', { class: 'hint' }, 'Tick the items to change, set only the fields you want to change, then press Apply.'),
    h('div', { class: 'bulk-controls' },
      h('label', { class: 'inline' }, colorOn, color, 'Colour'),
      h('label', { class: 'inline' }, 'Unit', unit),
      h('label', { class: 'inline' }, 'Allowance %', allowance),
      h('label', { class: 'inline' }, 'Assembly', assembly),
      h('label', { class: 'inline' }, 'Visibility', visibility)),
    h('div', { class: 'bulk-tools' },
      filter,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { for (const it of items) selected.add(it.id); draw(); } }, 'Select all'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { selected.clear(); draw(); } }, 'Clear')),
    list);

  const ok = modal({
    title: 'Bulk edit items',
    size: 'xl',
    body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: true, primary: true }],
    validate: () => (selected.size ? null : 'Tick at least one item.'),
  });
  ok.then(applied => {
    if (!applied) return;
    mutate(() => {
      for (const it of items) {
        if (!selected.has(it.id)) continue;
        it.props ||= {};
        if (colorOn.checked) it.color = color.value;
        if (unit.value) it.props.unit = unit.value;
        if (allowance.value !== '') it.props.allowance = Math.max(0, Number(allowance.value) || 0);
        if (assembly.value === '__none') delete it.props.assembly;
        else if (assembly.value) it.props.assembly = assembly.value;
        if (visibility.value) it.visible = visibility.value === 'show';
      }
    });
    toast('Bulk update applied to ' + selected.size + ' item(s).');
  });
}
