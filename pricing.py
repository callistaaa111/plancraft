"""Materials and pricing. Keep in step with web/js/pricing.js (same rules).

project.materials  = [{id, name, unit, price, category, whole}]      whole: sold in whole units (round the total up)
project.assemblies = [{id, name, parts: [{id, material, factor, basis, pack}]}]
An item uses props.assembly, or else the assembly of the nearest folder above it (folder.assembly).

Part quantity for one item = basis value x factor / pack, where basis is one of
  qty       the item's quantity (length, area or count)
  qtyAllow  the quantity with the item's allowance, rounded up like the takeoff sheets
  perimeter / wallArea / volume   the item's extra quantities
  each      1 for every item that has takeoff (e.g. one panel connector per circuit)

Cost build-up: subtotal -> overhead -> contingency -> the user's extra lines -> markup -> tax.
"""
from __future__ import annotations

import math
from collections import OrderedDict

from measure import item_quantities, with_allowance

BASES = ("qty", "qtyAllow", "perimeter", "wallArea", "volume", "each")
_EXTRA = {"perimeter": "Perimeter", "wallArea": "Wall area", "volume": "Volume"}


def num(v, default=0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f else default


def basis_value(item: dict, q: dict, basis: str) -> float:
    if basis == "qtyAllow":
        return with_allowance(q["qty"], (item.get("props") or {}).get("allowance"))
    if basis == "each":
        return 1.0 if q["qty"] else 0.0
    if basis in _EXTRA:
        return next((v for label, v, _ in q["extra"] if label == _EXTRA[basis]), 0.0)
    return q["qty"]


def walk(nodes, known, assembly=None, path=()):
    """Yield (folder_path, item, assembly id in effect) in tree order. An id not in known (e.g. on an item pasted
    from another project) is skipped and the folder's assembly applies, like assemblyFor in pricing.js."""
    for n in nodes:
        if n.get("kind") == "folder":
            own = n.get("assembly")
            yield from walk(n.get("children") or [], known, own if own in known else assembly,
                            path + (n.get("name") or "Folder",))
        else:
            own = (n.get("props") or {}).get("assembly")
            yield " / ".join(path), n, own if own in known else assembly


def item_parts(item: dict, q: dict, assembly: dict | None, materials: dict) -> list[dict]:
    """[{material, qty, amount}] for one item (unrounded)."""
    out = []
    for part in (assembly or {}).get("parts") or []:
        mat = materials.get(part.get("material"))
        if not mat:
            continue
        pack = num(part.get("pack"), 1.0) or 1.0
        qty = basis_value(item, q, part.get("basis") or "qty") * num(part.get("factor"), 1.0) / pack
        out.append({"material": mat, "qty": qty, "amount": qty * num(mat.get("price"))})
    return out


def extra_lines(settings: dict, subtotal: float) -> list[dict]:
    """The user's own cost lines (permits, mobilization, bond...), added after contingency and before markup.
    settings.extras = [{name, type: "pct" (of the material + labour subtotal) | "fixed", value}]"""
    out = []
    for e in settings.get("extras") or []:
        if not isinstance(e, dict):
            continue
        name = str(e.get("name") or "").strip() or "Other cost"
        value = num(e.get("value"))
        fixed = e.get("type") == "fixed"
        out.append({"name": name, "type": "fixed" if fixed else "pct", "value": value,
                    "label": name if fixed else f"{name} {value:g}%",
                    "amount": value if fixed else subtotal * value / 100})
    return out


def costing(project: dict) -> dict:
    """Bill of materials and costs for the whole project."""
    units = project.get("units") or "m"
    pages = {p["id"]: p for p in project.get("pages") or []}
    materials = {m["id"]: m for m in project.get("materials") or []}
    assemblies = {a["id"]: a for a in project.get("assemblies") or []}
    lines = []                       # per item and material
    totals: OrderedDict[str, float] = OrderedDict()
    for folder, item, aid in walk(project.get("tree") or [], assemblies):
        asm = assemblies.get(aid)
        if not asm:
            continue
        q = item_quantities(item, pages, units)
        for p in item_parts(item, q, asm, materials):
            lines.append({"folder": folder, "item": item, "assembly": asm, **p})
            totals[p["material"]["id"]] = totals.get(p["material"]["id"], 0.0) + p["qty"]
    bom = []
    for mid, raw in totals.items():
        mat = materials[mid]
        qty = math.ceil(raw - 1e-9) if mat.get("whole") else raw
        bom.append({"material": mat, "raw": raw, "qty": qty, "amount": qty * num(mat.get("price"))})
    order = {m["id"]: i for i, m in enumerate(project.get("materials") or [])}
    bom.sort(key=lambda b: ((b["material"].get("category") or "").lower(), order.get(b["material"]["id"], 0)))
    settings = project.get("settings") or {}
    materials_subtotal = sum(b["amount"] for b in bom if (b["material"].get("kind") or "material") != "labour")
    labour_subtotal = sum(b["amount"] for b in bom if (b["material"].get("kind") or "material") == "labour")
    subtotal = materials_subtotal + labour_subtotal
    overhead_pct = num(settings.get("overhead"))
    contingency_pct = num(settings.get("contingency"))
    markup_pct = num(settings.get("markup"))
    tax_pct = num(settings.get("tax"))
    overhead = subtotal * overhead_pct / 100
    contingency = (subtotal + overhead) * contingency_pct / 100
    extras = extra_lines(settings, subtotal)
    before_markup = subtotal + overhead + contingency + sum(e["amount"] for e in extras)
    markup = before_markup * markup_pct / 100
    before_tax = before_markup + markup
    tax = before_tax * tax_pct / 100
    return {
        "lines": lines, "bom": bom,
        "materials": materials_subtotal, "labour": labour_subtotal, "subtotal": subtotal,
        "overhead": overhead_pct, "overheadAmount": overhead,
        "contingency": contingency_pct, "contingencyAmount": contingency, "extras": extras,
        "markup": markup_pct, "markupAmount": markup,
        "tax": tax_pct, "taxAmount": tax,
        "total": before_tax + tax,
    }
