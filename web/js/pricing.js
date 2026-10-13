// Materials and pricing. Keep in step with pricing.py (the Excel export uses that copy).
//   project.materials  = [{id, name, unit, price, category, whole}]   whole: sold in whole units (total rounded up)
//   project.assemblies = [{id, name, parts: [{id, material, factor, basis, pack}]}]
// An item uses props.assembly, or else the assembly of the nearest folder above it (folder.assembly).
// Part quantity for an item = basis value x factor / pack.
import { withAllowance } from './measure.js';

export const BASES = {
  qty: 'its quantity',
  qtyAllow: 'its quantity + allowance',
  perimeter: 'its perimeter (areas)',
  wallArea: 'its wall area (linear with height)',
  volume: 'its volume (areas with depth)',
  each: 'each item (1 per item)',
};
const EXTRA = { perimeter: 'Perimeter', wallArea: 'Wall area', volume: 'Volume' };

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);

export function basisValue(item, q, basis) {
  if (basis === 'qtyAllow') return withAllowance(q.qty, item.props?.allowance);
  if (basis === 'each') return q.qty ? 1 : 0;
  if (EXTRA[basis]) return q.extra.find(e => e.label === EXTRA[basis])?.value ?? 0;
  return q.qty;
}

/** [{material, qty, amount}] for one item, unrounded. */
export function itemParts(item, q, assembly, materials) {
  const out = [];
  for (const part of assembly?.parts || []) {
    const mat = materials.get(part.material);
    if (!mat) continue;
    const pack = num(part.pack, 1) || 1;
    const qty = basisValue(item, q, part.basis || 'qty') * num(part.factor, 1) / pack;
    out.push({ material: mat, qty, amount: qty * num(mat.price) });
  }
  return out;
}

/** The assembly in effect for a node: its own, or the nearest folder's above it. */
export function assemblyFor(nodeId, x, assemblies) {
  for (let e = x.nodes.get(nodeId); e; e = e.parent ? x.nodes.get(e.parent.id) : null) {
    const a = e.node.kind === 'folder' ? e.node.assembly : e.node.props?.assembly;
    if (a && assemblies.has(a)) return { assembly: assemblies.get(a), from: e.node };
  }
  return null;
}

/** Bill of materials for some items (all by default). */
export function costing(project, x, qtyOf, items = x.items) {
  const materials = new Map((project.materials || []).map(m => [m.id, m]));
  const assemblies = new Map((project.assemblies || []).map(a => [a.id, a]));
  const totals = new Map();
  for (const it of items) {
    const a = assemblyFor(it.id, x, assemblies);
    if (!a) continue;
    for (const p of itemParts(it, qtyOf(it), a.assembly, materials)) totals.set(p.material.id, (totals.get(p.material.id) || 0) + p.qty);
  }
  const bom = [...totals].map(([id, raw]) => {
    const material = materials.get(id);
    const qty = material.whole ? Math.ceil(raw - 1e-9) : raw;
    return { material, raw, qty, amount: qty * num(material.price) };
  });
  const subtotal = bom.reduce((s, b) => s + b.amount, 0);
  const markup = num(project.settings?.markup);
  return { bom, subtotal, markup, total: subtotal * (1 + markup / 100) };
}

export const money = (v, project) => `${project.settings?.currency ?? '₱'}${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
