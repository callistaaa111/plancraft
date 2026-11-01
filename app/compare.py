"""Compare two revisions of a takeoff: matched pages and per-item quantity deltas.

The comparison is deliberately explainable: items are matched by folder path, type and name; pages by their source
PDF/page, then by sheet name. Anything that cannot be matched is reported as added/removed rather than guessed.
"""
from __future__ import annotations

import re

from measure import item_quantities

_EPS = 1e-9


def _norm(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def _page_label(page) -> str:
    return page.get("name") or page.get("source") or page.get("id") or "Page"


def _page_key(page) -> str:
    src = page.get("src") or {}
    if src.get("file"):
        return f"src:{src['file']}:{src.get('page', 0)}"
    return f"name:{_norm(page.get('name'))}"


def match_pages(old: dict, new: dict) -> dict:
    """Pair old and new pages. Exact source/page first, then sheet name; never guess by position alone."""
    old_pages = list(old.get("pages") or [])
    new_pages = list(new.get("pages") or [])
    old_by = {_page_key(p): p for p in old_pages}
    new_by = {_page_key(p): p for p in new_pages}
    pairs = []
    for key in old_by:
        if key in new_by:
            pairs.append({"old": old_by[key], "new": new_by[key], "how": "source" if key.startswith("src:") else "name"})
    paired_old = {id(x["old"]) for x in pairs}
    paired_new = {id(x["new"]) for x in pairs}
    only_old = [p for p in old_pages if id(p) not in paired_old]
    only_new = [p for p in new_pages if id(p) not in paired_new]
    # Second pass: the same sheet renamed between issuances.
    by_name_new = {}
    for p in only_new:
        by_name_new.setdefault(_norm(p.get("name")), []).append(p)
    still_old = []
    for p in only_old:
        candidates = by_name_new.get(_norm(p.get("name"))) or []
        if candidates:
            q = candidates.pop(0)
            pairs.append({"old": p, "new": q, "how": "name"})
            only_new.remove(q)
        else:
            still_old.append(p)
    only_old = still_old
    return {
        "pairs": [{"oldId": x["old"]["id"], "newId": x["new"]["id"], "oldName": _page_label(x["old"]),
                   "newName": _page_label(x["new"]), "how": x["how"]} for x in pairs],
        "onlyOld": [{"id": p["id"], "name": _page_label(p)} for p in only_old],
        "onlyNew": [{"id": p["id"], "name": _page_label(p)} for p in only_new],
    }


def _walk(nodes, path=()):
    for node in nodes or []:
        if node.get("kind") == "folder":
            yield from _walk(node.get("children") or [], path + (node.get("name") or "Folder",))
        else:
            yield " / ".join(path), node


def quantity_map(project: dict) -> dict:
    """key -> a flat, comparable item snapshot. Duplicate names in a folder are suffixed #2, #3."""
    pages = {p["id"]: p for p in project.get("pages") or []}
    units = project.get("units") or "m"
    seen = {}
    out = {}
    for folder, item in _walk(project.get("tree") or []):
        kind = item.get("type") or "item"
        base = f"{folder}|{kind}|{_norm(item.get('name'))}"
        n = seen.get(base, 0) + 1
        seen[base] = n
        key = base if n == 1 else f"{base}#{n}"
        q = item_quantities(item, pages, units)
        page_names = []
        for sec in item.get("sections") or []:
            page = pages.get(sec.get("page"))
            if page:
                page_names.append(_page_label(page))
        out[key] = {
            "key": key, "folder": folder, "name": item.get("name") or "Item", "type": kind,
            "unit": q["unit"], "qty": q["qty"], "unscaled": q["unscaled"],
            "sections": len(item.get("sections") or []), "pages": sorted(set(page_names)),
            "hidden": not item.get("visible", True),
        }
    return out


def compare_projects(old: dict, new: dict) -> dict:
    """A JSON-safe report. old/new are full project dicts."""
    old_items = quantity_map(old)
    new_items = quantity_map(new)
    rows = []
    for key in sorted(set(old_items) | set(new_items), key=lambda k: (new_items.get(k, old_items.get(k))["folder"],
                                                                      new_items.get(k, old_items.get(k))["name"])):
        a = old_items.get(key)
        b = new_items.get(key)
        if a and b:
            delta = b["qty"] - a["qty"]
            pct = (delta / a["qty"] * 100) if abs(a["qty"]) > _EPS else None
            status = "same" if abs(delta) <= _EPS else "changed"
            row = {**b, "oldQty": a["qty"], "newQty": b["qty"], "delta": delta, "pct": pct, "status": status,
                   "oldSections": a["sections"], "newSections": b["sections"]}
        elif b:
            row = {**b, "oldQty": 0.0, "newQty": b["qty"], "delta": b["qty"], "pct": None, "status": "added",
                   "oldSections": 0, "newSections": b["sections"]}
        else:
            row = {**a, "oldQty": a["qty"], "newQty": 0.0, "delta": -a["qty"], "pct": None, "status": "removed",
                   "oldSections": a["sections"], "newSections": 0}
        rows.append(row)

    totals = {}
    for row in rows:
        k = f"{row['type']}|{row['unit']}"
        t = totals.setdefault(k, {"type": row["type"], "unit": row["unit"], "oldQty": 0.0, "newQty": 0.0,
                                  "delta": 0.0, "items": 0})
        t["oldQty"] += row["oldQty"]
        t["newQty"] += row["newQty"]
        t["delta"] += row["delta"]
        t["items"] += 1

    counts = {k: sum(1 for r in rows if r["status"] == k) for k in ("added", "removed", "changed", "same")}
    pages = match_pages(old, new)
    return {
        "old": {"id": old.get("id"), "name": old.get("name") or "Old revision", "modified": old.get("modified"),
                "pages": len(old.get("pages") or [])},
        "new": {"id": new.get("id"), "name": new.get("name") or "New revision", "modified": new.get("modified"),
                "pages": len(new.get("pages") or [])},
        "pages": pages,
        "items": rows,
        "totals": sorted(totals.values(), key=lambda t: (t["type"], t["unit"])),
        "summary": {**counts, "items": len(rows), "matchedPages": len(pages["pairs"]),
                    "unmatchedPages": len(pages["onlyOld"]) + len(pages["onlyNew"])},
    }
