// Quantities from takeoff geometry. Keep in step with measure.py (the Excel export uses that copy).
// Geometry is in page-image pixels; each page stores its scale as pixels per metre (page.scale.pxPerM).

// Length units takeoff can be measured in. Areas are the same unit squared; volumes are given in m³
// (metric) or yd³ (imperial). volF turns (unit² x unit) into that volume unit.
const U = (len, perM, imperial, volF, name) => ({ len, area: `${len}²`, vol: imperial ? 'yd³' : 'm³', count: 'ea', perM, imperial, volF, name });
export const UNITS = {
  m: U('m', 1, false, 1, 'Metres'),
  cm: U('cm', 100, false, 1e-6, 'Centimetres'),
  mm: U('mm', 1000, false, 1e-9, 'Millimetres'),
  ft: U('ft', 1 / 0.3048, true, 1 / 27, 'Feet'),
  in: U('in', 1 / 0.0254, true, 1 / 46656, 'Inches'),
  yd: U('yd', 1 / 0.9144, true, 1, 'Yards'),
};
UNITS.metric = UNITS.m; // older projects store the system name
UNITS.imperial = UNITS.ft;
export const UNIT_KEYS = ['m', 'cm', 'mm', 'ft', 'in', 'yd'];
export const COUNT_UNITS = ['ea', 'pcs', 'set', 'lot', 'unit', 'pair'];

export const unitInfo = key => UNITS[key] || UNITS.m;
/** 'metric' / 'imperial' from older projects become 'm' / 'ft'. */
export const unitKey = key => unitInfo(key).len;
export const unitLabel = key => { const u = unitInfo(key); return `${u.name} (${u.len}, ${u.area})`; };

/** The length unit an item is measured in: its own choice, else the project's. */
export function itemUnits(item, projectUnits) {
  const own = item?.type !== 'count' && item?.props?.unit;
  return own && UNIT_KEYS.includes(own) ? own : projectUnits;
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polyLength(pts) {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += dist(pts[i], pts[i + 1]);
  return s;
}

export function polyPerimeter(pts) {
  return pts.length < 2 ? 0 : polyLength(pts) + dist(pts[pts.length - 1], pts[0]);
}

export function polyArea(pts) {
  const n = pts.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function pxPerM(page) {
  const v = Number(page?.scale?.pxPerM);
  return v > 0 && isFinite(v) ? v : null;
}

const num = v => (isFinite(Number(v)) ? Number(v) : 0);

/** Totals for one item: {qty, unit, perPage: Map(pageId -> {qty, n}), extra: [{label, value, unit}], unscaled} */
export function itemQuantities(item, pagesById, units = 'm') {
  units = itemUnits(item, units);
  const u = unitInfo(units);
  const kind = item.type;
  const props = item.props || {};
  const perPage = new Map();
  let total = 0, perim = 0, unscaled = 0;
  for (const sec of item.sections || []) {
    const page = pagesById.get(sec.page);
    if (!page) continue;
    const pts = sec.points || [];
    let q;
    if (kind === 'count') q = pts.length;
    else {
      const ppm = pxPerM(page);
      if (!ppm) { unscaled++; const e = perPage.get(sec.page) || { qty: 0, n: 0 }; e.n++; perPage.set(sec.page, e); continue; }
      if (kind === 'linear') q = polyLength(pts) / ppm * u.perM;
      else {
        q = polyArea(pts) / ppm ** 2 * u.perM ** 2;
        if (sec.deduct) q = -q;
        else perim += polyPerimeter(pts) / ppm * u.perM;
      }
    }
    const e = perPage.get(sec.page) || { qty: 0, n: 0 };
    e.qty += q; e.n++;
    perPage.set(sec.page, e);
    total += q;
  }
  const unit = kind === 'linear' ? u.len : kind === 'area' ? u.area : COUNT_UNITS.includes(props.unit) ? props.unit : u.count;
  const extra = [];
  if (kind === 'linear') {
    const h = num(props.height);
    if (h) extra.push({ label: 'Wall area', value: total * h, unit: u.area });
  } else if (kind === 'area') {
    extra.push({ label: 'Perimeter', value: perim, unit: u.len });
    const d = num(props.depth);
    if (d) extra.push({ label: 'Volume', value: total * d * u.volF, unit: u.vol });
  }
  const adjust = num(props.adjust);
  if (adjust) {
    total += adjust;
    extra.push({ label: 'Manual adjustment', value: adjust, unit });
  }
  return { qty: total, unit, perPage, extra, unscaled, adjust };
}

/** Quantity plus allowance, rounded up to a whole number (=ROUNDUP(Q*1.2,0) in the takeoff sheets). */
export function withAllowance(qty, pct) {
  const p = num(pct);
  return p ? Math.ceil(qty * (1 + p / 100) - 1e-9) : qty;
}

/** Length in display units for a pixel distance on a page, or null when the page has no scale. */
export function lengthOf(px, page, units) {
  const ppm = pxPerM(page);
  return ppm ? px / ppm * unitInfo(units).perM : null;
}

export function areaOf(px2, page, units) {
  const ppm = pxPerM(page);
  return ppm ? px2 / ppm ** 2 * unitInfo(units).perM ** 2 : null;
}

// ---- scales --------------------------------------------------------------------------------------
export const METRIC_RATIOS = [1, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000];
export const IMPERIAL_SCALES = [
  ['1/32" = 1\'-0"', 1 / 32], ['1/16" = 1\'-0"', 1 / 16], ['3/32" = 1\'-0"', 3 / 32], ['1/8" = 1\'-0"', 1 / 8],
  ['3/16" = 1\'-0"', 3 / 16], ['1/4" = 1\'-0"', 1 / 4], ['3/8" = 1\'-0"', 3 / 8], ['1/2" = 1\'-0"', 1 / 2],
  ['3/4" = 1\'-0"', 3 / 4], ['1" = 1\'-0"', 1], ['1 1/2" = 1\'-0"', 1.5], ['3" = 1\'-0"', 3],
  ['1" = 10\'', 1 / 10], ['1" = 20\'', 1 / 20], ['1" = 30\'', 1 / 30], ['1" = 40\'', 1 / 40], ['1" = 50\'', 1 / 50], ['1" = 100\'', 1 / 100],
];

export const ratioScale = (dpi, ratio) => dpi / 0.0254 / ratio;
export const imperialScale = (dpi, inchesPerFoot) => dpi * inchesPerFoot / 0.3048;

/** Metres per unit for the length units offered when calibrating. */
export const LENGTH_UNITS = { m: 1, mm: 0.001, cm: 0.01, ft: 0.3048, in: 0.0254, yd: 0.9144 };

export function scaleLabel(page) {
  if (!pxPerM(page)) return 'No scale';
  return page.scale.label || 'Calibrated';
}
