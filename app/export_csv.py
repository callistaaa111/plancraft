"""CSV export of the takeoff summary (the same columns as the Excel Summary sheet)."""
from __future__ import annotations

import csv
import io

from export_xlsx import TYPE_LABEL, walk_items
from measure import item_quantities, with_allowance


def build(project: dict) -> bytes:
    pages = {p["id"]: p for p in project.get("pages") or []}
    units = project.get("units") or "m"
    out = io.StringIO(newline="")
    w = csv.writer(out)
    w.writerow(["Folder", "Item", "Type", "Description", "Spec", "Qty", "Unit", "Allowance %", "Qty + Allow", "Pages"])
    for folder, item in walk_items(project.get("tree") or []):
        props = item.get("props") or {}
        q = item_quantities(item, pages, units)
        allow = float(props.get("allowance") or 0)
        page_names = []
        for sec in item.get("sections") or []:
            page = pages.get(sec.get("page"))
            if page:
                page_names.append(page.get("name") or page.get("id") or "")
        w.writerow([folder, item.get("name") or "", TYPE_LABEL.get(item.get("type"), item.get("type")),
                    props.get("description") or "", props.get("spec") or "",
                    round(q["qty"], 4), q["unit"], allow,
                    round(with_allowance(q["qty"], allow), 4) if allow else round(q["qty"], 4),
                    "; ".join(sorted(set(page_names)))])
    return out.getvalue().encode("utf-8-sig")
