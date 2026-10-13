// Setting a page's scale: from a known length measured on the plan, or a standard drawing scale.
import { S, mutate, setTool, pageById } from './store.js';
import * as M from './measure.js';
import { h, fmt } from './util.js';
import { modal, toast } from './dialogs.js';

function applyTargets(page) {
  const all = S.project.pages;
  const sameSource = page.source ? all.filter(p => p.source === page.source) : [];
  const opts = [{ value: 'this', label: 'This page only' }];
  if (sameSource.length > 1) opts.push({ value: 'source', label: `All ${sameSource.length} pages from "${page.source}"` });
  if (all.length > 1) opts.push({ value: 'all', label: `All ${all.length} pages in the project` });
  return opts;
}

function targetPages(page, which) {
  if (which === 'all') return S.project.pages;
  if (which === 'source') return S.project.pages.filter(p => p.source === page.source);
  return [page];
}

function applyField(page) {
  const opts = applyTargets(page);
  const radios = opts.map((o, i) => h('label', null, h('input', { type: 'radio', name: 'scaleApply', value: o.value, checked: i === 0 }), o.label));
  const field = opts.length > 1 ? h('div', { class: 'field' }, h('div', { class: 'label' }, 'Apply to'), h('div', { class: 'radio-list' }, radios)) : null;
  return { field, value: () => (field ? field.querySelector('input:checked').value : 'this') };
}

/** Scale for pages that keep their own DPI: same paper scale, different pixels. */
function setScale(page, which, make) {
  const pages = targetPages(page, which);
  let skipped = 0;
  mutate(() => {
    for (const p of pages) {
      const sc = make(p);
      if (sc) p.scale = sc; else skipped++;
    }
  });
  if (skipped) toast(`${skipped} page(s) were skipped because their resolution is unknown. Calibrate those on the plan.`);
}

/** Dialog after clicking both ends of a known length (pxDist = pixels between them). */
export async function calibrateDialog(page, pxDist) {
  const units = S.project.units;
  const lenInput = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'e.g. 6' });
  const unitSel = h('select', null, Object.keys(M.LENGTH_UNITS).map(u => h('option', { value: u, selected: u === M.unitKey(units) }, u)));
  const apply = applyField(page);
  const preview = h('div', { class: 'note' });
  const update = () => {
    const v = Number(lenInput.value);
    if (!(v > 0)) { preview.textContent = ''; return; }
    const ppm = pxDist / (v * M.LENGTH_UNITS[unitSel.value]);
    const ratio = page.dpi ? Math.round(page.dpi / 0.0254 / ppm) : null;
    preview.textContent = `${fmt(ppm, 3)} pixels per metre${ratio ? ` (about 1:${ratio} at ${Math.round(page.dpi)} dpi)` : ''}`;
  };
  lenInput.addEventListener('input', update);
  unitSel.addEventListener('change', update);
  const ok = await modal({
    title: 'Set scale from a known length',
    body: [
      h('p', { style: { margin: 0 } }, `The line you drew is ${fmt(pxDist, 0)} pixels long. How long is it in reality?`),
      h('div', { class: 'field' }, h('label', null, 'Real length'),
        h('div', { class: 'inline' }, lenInput, h('div', { style: { width: '90px', flex: 'none' } }, unitSel))),
      preview,
      apply.field,
    ],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Set scale', value: true, primary: true }],
    validate: () => (Number(lenInput.value) > 0 ? null : 'Enter the real length of the line.'),
  });
  setTool('select');
  if (!ok) return;
  const metres = Number(lenInput.value) * M.LENGTH_UNITS[unitSel.value];
  const ppm = pxDist / metres;
  const label = `Calibrated (${lenInput.value} ${unitSel.value})`;
  const which = apply.value();
  if (which === 'this') setScale(page, which, () => ({ pxPerM: ppm, label, auto: false }));
  else {
    // other pages may be rendered at a different DPI: carry the paper scale over, not the pixels
    const paper = page.dpi ? ppm / page.dpi : null;
    setScale(page, which, p => (p.id === page.id ? { pxPerM: ppm, label, auto: false }
      : paper && p.dpi ? { pxPerM: paper * p.dpi, label, auto: false } : null));
  }
  toast('Scale set.');
}

/** Pick a standard scale, or go calibrate on the plan. */
export async function scaleDialog(pageId, { onCalibrate } = {}) {
  const page = pageById(pageId);
  if (!page) return;
  const imperial = M.unitInfo(S.project.units).imperial;
  const options = [];
  if (page.dpi) {
    for (const r of M.METRIC_RATIOS) options.push({ key: `r${r}`, label: `1:${r}`, make: p => (p.dpi ? M.ratioScale(p.dpi, r) : null) });
    for (const [label, ipf] of M.IMPERIAL_SCALES) options.push({ key: `i${ipf}`, label, make: p => (p.dpi ? M.imperialScale(p.dpi, ipf) : null) });
    if (imperial) options.sort((a, b) => (a.key[0] === 'i' ? -1 : 1) - (b.key[0] === 'i' ? -1 : 1));
  }
  const cur = page.scale?.label;
  const sel = h('select', { disabled: !options.length },
    h('option', { value: '' }, options.length ? 'Choose a drawing scale...' : 'Not available for this page'),
    options.map(o => h('option', { value: o.key, selected: o.label === cur }, o.label)));
  const apply = applyField(page);
  const r = await modal({
    title: `Scale for "${page.name}"`,
    body: [
      h('div', { class: page.scale?.pxPerM ? 'callout ok' : 'callout' },
        page.scale?.pxPerM ? `Current: ${page.scale.label || 'Calibrated'}${page.scale.auto ? ' (read from the drawing, not checked yet)' : ''}`
          : 'This page has no scale, so lengths and areas on it are not counted yet.'),
      h('div', { class: 'field' }, h('label', null, 'Drawing scale'), sel,
        h('div', { class: 'hint' }, page.dpi ? `Uses the page resolution (${Math.round(page.dpi)} dpi). Only right when the PDF is printed at its true paper size.`
          : 'This page has no known resolution, so calibrate on the plan instead.')),
      apply.field,
      h('p', { class: 'note', style: { margin: 0 } }, 'Most accurate: click "Calibrate on plan" and click both ends of a dimension you know.'),
    ],
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Calibrate on plan', value: 'calibrate' },
      { label: 'Use this scale', value: 'preset', primary: true },
    ],
    validate: v => (v === 'preset' && !sel.value ? 'Choose a scale first, or calibrate on the plan.' : null),
  });
  if (r === 'calibrate') { onCalibrate?.(); return; }
  if (r !== 'preset') return;
  const opt = options.find(o => o.key === sel.value);
  setScale(page, apply.value(), p => {
    const ppm = opt.make(p);
    return ppm ? { pxPerM: ppm, label: opt.label, auto: false } : null;
  });
  toast(`Scale set to ${opt.label}.`);
}

/** The user checked an auto-detected scale and it is right. */
export function confirmAutoScale(page) {
  mutate(() => { if (page.scale) page.scale.auto = false; });
}
