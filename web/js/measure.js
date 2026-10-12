// Quantities from takeoff geometry. Keep in step with measure.py (the Excel export uses that copy).
// Geometry is in page-image pixels; each page stores its scale as pixels per metre (page.scale.pxPerM).

export const UNITS = {
  metric: { len: 'm', area: 'm²', vol: 'm³', count: 'ea', perM: 1 },
  imperial: { len: 'ft', area: 'ft²', vol: 'yd³', count: 'ea', perM: 1 / 0.3048 },
};

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
export function itemQuantities(item, pagesById, units = 'metric') {
  const u = UNITS[units] || UNITS.metric;
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
  const unit = kind === 'linear' ? u.len : kind === 'area' ? u.area : u.count;
  const extra = [];
  if (kind === 'linear') {
    const h = num(props.height);
    if (h) extra.push({ label: 'Wall area', value: total * h, unit: u.area });
  } else if (kind === 'area') {
    extra.push({ label: 'Perimeter', value: perim, unit: u.len });
    const d = num(props.depth);
    if (d) extra.push({ label: 'Volume', value: units === 'imperial' ? total * d / 27 : total * d, unit: u.vol });
  }
  return { qty: total, unit, perPage, extra, unscaled };
}

/** Quantity plus allowance, rounded up to a whole number (=ROUNDUP(Q*1.2,0) in the takeoff sheets). */
export function withAllowance(qty, pct) {
  const p = num(pct);
  return p ? Math.ceil(qty * (1 + p / 100) - 1e-9) : qty;
}

/** Length in display units for a pixel distance on a page, or null when the page has no scale. */
export function lengthOf(px, page, units) {
  const ppm = pxPerM(page);
  return ppm ? px / ppm * (UNITS[units] || UNITS.metric).perM : null;
}

export function areaOf(px2, page, units) {
  const ppm = pxPerM(page);
  return ppm ? px2 / ppm ** 2 * (UNITS[units] || UNITS.metric).perM ** 2 : null;
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
export const LENGTH_UNITS = { m: 1, mm: 0.001, cm: 0.01, ft: 0.3048, in: 0.0254 };

export function scaleLabel(page) {
  if (!pxPerM(page)) return 'No scale';
  return page.scale.label || 'Calibrated';
}
