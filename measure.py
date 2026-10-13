"""Quantities from takeoff geometry. Keep in step with web/js/measure.js (same rules, same units).

Geometry is stored in page-image pixels; each page carries its own scale as pixels per metre.
"""
from __future__ import annotations

import math

def _unit(length: str, per_m: float, imperial: bool, vol_f: float) -> dict:
    # areas are the unit squared; volumes are m³ (metric) or yd³ (imperial); vol_f turns unit³ into that
    return {"len": length, "area": f"{length}²", "vol": "yd³" if imperial else "m³", "count": "ea",
            "per_m": per_m, "imperial": imperial, "vol_f": vol_f}


UNITS = {
    "m": _unit("m", 1.0, False, 1.0),
    "cm": _unit("cm", 100.0, False, 1e-6),
    "mm": _unit("mm", 1000.0, False, 1e-9),
    "ft": _unit("ft", 1 / 0.3048, True, 1 / 27),
    "in": _unit("in", 1 / 0.0254, True, 1 / 46656),
    "yd": _unit("yd", 1 / 0.9144, True, 1.0),
}
UNITS["metric"] = UNITS["m"]  # older projects store the system name
UNITS["imperial"] = UNITS["ft"]
UNIT_KEYS = ("m", "cm", "mm", "ft", "in", "yd")
COUNT_UNITS = ("ea", "pcs", "set", "lot", "unit", "pair")


def unit_info(key) -> dict:
    return UNITS.get(key) or UNITS["m"]


def item_units(item: dict, project_units: str) -> str:
    """The length unit an item is measured in: its own choice, else the project's."""
    own = (item.get("props") or {}).get("unit")
    return own if item.get("type") != "count" and own in UNIT_KEYS else project_units


def poly_length(pts) -> float:
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def poly_perimeter(pts) -> float:
    if len(pts) < 2:
        return 0.0
    return poly_length(pts) + math.dist(pts[-1], pts[0])


def poly_area(pts) -> float:
    n = len(pts)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def px_per_m(page) -> float | None:
    scale = (page or {}).get("scale") or {}
    v = scale.get("pxPerM")
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def item_quantities(item: dict, pages: dict, units: str = "m") -> dict:
    """Totals for one takeoff item.

    Returns qty (primary quantity), unit, per_page {page_id: qty}, extra [(label, value, unit)] and
    unscaled (sections skipped because their page has no scale).
    """
    units = item_units(item, units)
    u = unit_info(units)
    kind = item.get("type")
    props = item.get("props") or {}
    per_page: dict[str, float] = {}
    total = perim = 0.0
    unscaled = 0
    for sec in item.get("sections") or []:
        page = pages.get(sec.get("page"))
        if page is None:
            continue
        pts = sec.get("points") or []
        if kind == "count":
            q = float(len(pts))
        else:
            ppm = px_per_m(page)
            if not ppm:
                unscaled += 1
                continue
            if kind == "linear":
                q = poly_length(pts) / ppm * u["per_m"]
            else:
                q = poly_area(pts) / ppm ** 2 * u["per_m"] ** 2
                if sec.get("deduct"):
                    q = -q
                else:
                    perim += poly_perimeter(pts) / ppm * u["per_m"]
        per_page[sec["page"]] = per_page.get(sec["page"], 0.0) + q
        total += q

    count_unit = props.get("unit") if props.get("unit") in COUNT_UNITS else u["count"]
    unit = {"linear": u["len"], "area": u["area"]}.get(kind, count_unit)
    extra = []
    if kind == "linear":
        h = num(props.get("height"))
        if h:
            extra.append(("Wall area", total * h, u["area"]))
    elif kind == "area":
        extra.append(("Perimeter", perim, u["len"]))
        d = num(props.get("depth"))
        if d:
            extra.append(("Volume", total * d * u["vol_f"], u["vol"]))
    return {"qty": total, "unit": unit, "per_page": per_page, "extra": extra, "unscaled": unscaled}


def with_allowance(qty: float, pct) -> float:
    """Quantity plus allowance, rounded up to a whole number like the takeoff sheets (=ROUNDUP(Q*1.2,0))."""
    p = num(pct)
    if not p:
        return qty
    return float(math.ceil(qty * (1 + p / 100) - 1e-9))
