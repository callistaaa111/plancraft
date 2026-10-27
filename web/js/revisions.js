// Compare two projects as revisions and show the quantity deltas.
import * as api from './api.js';
import { h, fmt } from './util.js';
import { modal, toast } from './dialogs.js';

const LABEL = { added: 'Added', removed: 'Removed', changed: 'Changed', same: 'Unchanged' };
const TYPE = { linear: 'Linear', area: 'Area', count: 'Count' };

function badge(status) {
  return h('span', { class: 'badge ' + (status === 'added' ? 'ok' : status === 'removed' ? 'warn' : '') },
    LABEL[status] || status);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function openRevisionCompare(base) {
  let projects;
  try { projects = await api.listProjects(); } catch (err) { toast(err.message, 'error'); return; }
  const others = projects.filter(p => p.id !== base.id);
  if (!others.length) {
    toast('Create another copy or project first; there is nothing to compare this project with.', 'error');
    return;
  }

  const select = h('select', { 'aria-label': 'Other revision' },
    ...others.map(p => h('option', { value: p.id }, p.name + ' (' + p.pages + ' pages)')));
  const button = h('button', { class: 'btn primary', type: 'button' }, 'Compare');
  const result = h('div', { class: 'rev-result' });
  const intro = h('div', { class: 'field' },
    h('label', null, 'Compare with'),
    select,
    h('div', { class: 'hint' }, 'Items are matched by folder, type and name; pages by their source PDF/page, then by sheet name.'));

  const run = async () => {
    button.disabled = true;
    result.replaceChildren(h('div', { class: 'note' }, 'Comparing...'));
    try {
      const report = await api.compareProjects(base.id, select.value);
      result.replaceChildren(renderReport(report, select.value));
    } catch (err) {
      result.replaceChildren();
      toast(err.message, 'error');
    } finally { button.disabled = false; }
  };
  button.addEventListener('click', run);

  await modal({
    title: 'Compare revisions',
    size: 'xl',
    body: h('div', { class: 'rev-compare' }, intro, h('div', { class: 'rev-actions' }, button), result),
    buttons: [{ label: 'Close', value: null }],
  });
}

function renderReport(report, otherId) {
  const items = report.items || [];
  const summary = report.summary || {};
  const pages = report.pages || {};
  const showSame = h('input', { type: 'checkbox' });
  const filter = h('select', { 'aria-label': 'Show rows' },
    h('option', { value: 'changes' }, 'Changed, added and removed'),
    h('option', { value: 'all' }, 'All items'),
    h('option', { value: 'added' }, 'Only added'),
    h('option', { value: 'removed' }, 'Only removed'),
    h('option', { value: 'changed' }, 'Only changed'));
  const tbody = h('tbody');
  const table = h('table', { class: 'mat-table rev-table' },
    h('thead', null, h('tr', null, ['STATUS', 'ITEM', 'FOLDER', 'TYPE', 'OLD', 'NEW', 'DELTA', 'DELTA %', 'PAGES']
      .map(t => h('th', null, t)))),
    tbody);

  const draw = () => {
    const mode = filter.value;
    const rows = items.filter(r => mode === 'all' ? true : mode === 'changes' ? r.status !== 'same' : r.status === mode);
    tbody.replaceChildren(...(rows.length ? rows.map(r => h('tr', { class: 'rev-' + r.status },
      h('td', null, badge(r.status)),
      h('td', { title: r.name }, r.name),
      h('td', { class: 'muted', title: r.folder }, r.folder || '—'),
      h('td', null, TYPE[r.type] || r.type),
      h('td', { class: 'num' }, fmt(r.oldQty, 2)),
      h('td', { class: 'num' }, fmt(r.newQty, 2)),
      h('td', { class: 'num' }, (r.delta > 0 ? '+' : '') + fmt(r.delta, 2)),
      h('td', { class: 'num' }, r.pct == null ? '—' : (r.pct > 0 ? '+' : '') + fmt(r.pct, 1) + '%'),
      h('td', { class: 'muted', title: (r.pages || []).join(', ') }, (r.pages || []).join(', ') || '—')
    )) : [h('tr', null, h('td', { colSpan: 9, class: 'muted' }, 'No rows for this filter.'))]));
  };
  filter.addEventListener('change', draw);
  showSame.addEventListener('change', () => { filter.value = showSame.checked ? 'all' : 'changes'; draw(); });

  const pagesBox = h('details', { class: 'rev-pages' },
    h('summary', null, (summary.matchedPages || 0) + ' page(s) matched; ' +
      (pages.onlyOld || []).length + ' only in this revision; ' + (pages.onlyNew || []).length + ' only in the other'),
    h('div', { class: 'hint' }, 'Matched by ' + [...new Set((pages.pairs || []).map(p => p.how))].join(', ') || 'no pages'),
    h('ul', null, ...(pages.pairs || []).slice(0, 40).map(p => h('li', null, p.oldName + ' ↔ ' + p.newName))),
    (pages.onlyOld || []).length ? h('div', null, h('strong', null, 'Only here: '),
      (pages.onlyOld || []).map(p => p.name).join(', ')) : null,
    (pages.onlyNew || []).length ? h('div', null, h('strong', null, 'Only there: '),
      (pages.onlyNew || []).map(p => p.name).join(', ')) : null);

  const exportBtn = h('button', { class: 'btn', type: 'button' }, 'Export Excel');
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      const blob = await api.compareExcel(report.old.id, otherId);
      saveBlob(blob, (report.old.name || 'old') + ' vs ' + (report.new.name || 'new') + ' - revision.xlsx');
    } catch (err) { toast(err.message, 'error'); } finally { exportBtn.disabled = false; }
  });

  draw();
  return h('div', { class: 'rev-report' },
    h('div', { class: 'rev-head' },
      h('div', null, h('strong', null, report.old.name || 'Old'), ' → ', h('strong', null, report.new.name || 'New')),
      h('div', { class: 'rev-summary' },
        h('span', { class: 'badge warn' }, (summary.changed || 0) + ' changed'),
        h('span', { class: 'badge ok' }, (summary.added || 0) + ' added'),
        h('span', { class: 'badge' }, (summary.removed || 0) + ' removed'),
        h('span', { class: 'badge' }, (summary.same || 0) + ' unchanged'))),
    pagesBox,
    h('div', { class: 'row rev-tools' },
      h('label', { class: 'inline' }, filter, showSame, 'Show unchanged'),
      h('span', { class: 'spacer' }),
      exportBtn),
    table,
    h('div', { class: 'hint' }, 'A red/green row is an item that exists only in one revision. A changed row keeps the new name and shows both quantities. Always check quantities before using them in a bid.'));
}
