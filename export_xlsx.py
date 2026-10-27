"""Excel export: item summary, quantities by page, the PANEL circuit summary and the page list."""
from __future__ import annotations

import io
import re
from collections import Counter, defaultdict
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

import pricing
from compare import _walk as walk_items
from measure import item_quantities, unit_info

THIN = Side(style="thin", color="000000")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD_FILL = PatternFill("solid", fgColor="D9E1F2")
WARN_FILL = PatternFill("solid", fgColor="FFF2CC")
BOLD = Font(bold=True)
NUM = "#,##0.00"
TYPE_LABEL = {"linear": "Linear", "area": "Area", "count": "Count"}

# Circuit names: optional 2-letter site prefix, panel, circuit number, then anything else (e.g. AB-LP1-3 (NO HOMERUN)).
CIRCUIT_NAME = re.compile(r"^(?:[A-Za-z]{2}-)?(?P<panel>.+?)-(?P<num>\d+(?:\s*&\s*\d+)?)\s*(?P<rest>.*)$")


def _header(ws, row, titles, widths=None):
    for c, t in enumerate(titles, start=1):
        cell = ws.cell(row, c, t)
        cell.font, cell.fill, cell.border = BOLD, HEAD_FILL, BORDER
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    if widths:
        for c, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(c)].width = w


def _title(ws, project, subtitle):
    ws["A1"] = project.get("name") or "Takeoff"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = subtitle
    ws["A2"].font = Font(italic=True, color="666666")


def _fmt(v):
    return f"{v:,.2f}"


def build(project: dict) -> bytes:
    units = project.get("units") or "m"
    pages = {p["id"]: p for p in project.get("pages") or []}
    ours = set()   # cells holding formulas we wrote; any other text starting with "=" is the user's and stays text

    def formula(ws, r, c, f):
        ours.add((ws.title, r, c))
        return ws.cell(r, c, f)

    page_order = {p["id"]: i for i, p in enumerate(project.get("pages") or [])}
    rows = []
    for folder, item in walk_items(project.get("tree") or []):
        rows.append((folder, item, item_quantities(item, pages, units)))
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")

    wb = Workbook()

    # ---- Summary ------------------------------------------------------------------------------------
    ws = wb.active
    ws.title = "Summary"
    _title(ws, project, f"Takeoff summary  ·  measured in {unit_info(units)['len']}  ·  exported {stamp}")
    head = ["FOLDER", "ITEM", "TYPE", "DESCRIPTION", "SPEC", "QTY", "UNIT", "ALLOW %", "QTY + ALLOW", "NOTES"]
    _header(ws, 4, head, [22, 30, 8, 26, 26, 12, 7, 9, 12, 46])
    r = 5
    for folder, item, q in rows:
        props = item.get("props") or {}
        allow = props.get("allowance") or 0
        notes = [f"{label} {_fmt(v)} {u}" for label, v, u in q["extra"]]
        if q["unscaled"]:
            notes.append(f"{q['unscaled']} section(s) on pages without a scale are not counted")
        values = [folder, item.get("name"), TYPE_LABEL.get(item.get("type"), item.get("type")),
                  props.get("description") or "", props.get("spec") or "",
                  round(q["qty"], 4), q["unit"], allow, None, "; ".join(notes)]
        for c, v in enumerate(values, start=1):
            cell = ws.cell(r, c, v)
            cell.border = BORDER
        formula(ws, r, 9, f"=IF(H{r}>0,ROUNDUP(F{r}*(1+H{r}/100),0),F{r})")
        ws.cell(r, 6).number_format = "0" if item.get("type") == "count" else NUM
        ws.cell(r, 9).number_format = "0" if item.get("type") == "count" else NUM
        if q["unscaled"]:
            for c in (6, 10):
                ws.cell(r, c).fill = WARN_FILL
        r += 1
    ws.freeze_panes = "A5"
    if r > 5:
        ws.auto_filter.ref = f"A4:J{r - 1}"

    # ---- By page ------------------------------------------------------------------------------------
    wp = wb.create_sheet("By Page")
    _title(wp, project, "Quantities on each page")
    _header(wp, 4, ["PAGE", "FOLDER", "ITEM", "TYPE", "QTY", "UNIT"], [36, 22, 30, 8, 12, 7])
    entries = []
    for ti, (folder, item, q) in enumerate(rows):
        for pid, v in q["per_page"].items():
            entries.append((page_order.get(pid, 1e9), ti, pages[pid].get("name"), folder, item, v, q["unit"]))
    entries.sort(key=lambda e: (e[0], e[1]))
    r = 5
    for _, _, pname, folder, item, v, unit in entries:
        for c, val in enumerate([pname, folder, item.get("name"), TYPE_LABEL.get(item.get("type")), round(v, 4), unit],
                                start=1):
            wp.cell(r, c, val).border = BORDER
        wp.cell(r, 5).number_format = "0" if item.get("type") == "count" else NUM
        r += 1
    wp.freeze_panes = "A5"
    if r > 5:
        wp.auto_filter.ref = f"A4:F{r - 1}"

    # ---- Circuits (PANEL layout) --------------------------------------------------------------------
    circuits = defaultdict(dict)       # panel -> num -> [lm, desc, spec, allowance, flags]
    panel_order = []
    for _folder, item, q in rows:
        if item.get("type") != "linear":
            continue
        m = CIRCUIT_NAME.match((item.get("name") or "").strip())
        if not m:
            continue
        panel = m.group("panel").upper()
        num = re.sub(r"\s+", "", m.group("num"))
        rest = m.group("rest").strip()
        props = item.get("props") or {}
        if panel not in circuits:
            panel_order.append(panel)
        c = circuits[panel].setdefault(num, [0.0, "", "", props.get("allowance") or 0, set()])
        c[0] += q["qty"]
        c[1] = c[1] or (props.get("description") or "")
        c[2] = c[2] or (props.get("spec") or "")
        if rest:
            c[4].add(rest.strip("() ").upper())
        if q["unscaled"]:
            c[4].add("PAGE NOT SCALED")
    if circuits:
        wc = wb.create_sheet("Circuits")
        wc.merge_cells("A1:H1")
        wc["A1"] = project.get("name") or "Takeoff"
        wc["A1"].font = Font(bold=True, size=14)
        wc["A1"].alignment = Alignment(horizontal="center")
        allowances = Counter(c[3] for p in circuits.values() for c in p.values())
        common = allowances.most_common(1)[0][0] if allowances else 0
        row = 2
        for panel in panel_order:
            wc.cell(row, 1, "PANEL:").font = BOLD
            wc.merge_cells(start_row=row, start_column=2, end_row=row, end_column=5)
            cell = wc.cell(row, 2, panel)
            cell.font, cell.alignment = BOLD, Alignment(horizontal="center")
            row += 1
            for col, text in enumerate(("CKT NO", "DESCRIPTION", "LM", f"LM (*{common:g}%)", "TYPE OF WIRE"), start=1):
                cell = wc.cell(row, col, text)
                cell.font, cell.fill, cell.border = BOLD, HEAD_FILL, BORDER
                cell.alignment = Alignment(horizontal="center")
            row += 1

            def key(n):
                m = re.match(r"\d+", n)
                return int(m.group()) if m else 0
            for num in sorted(circuits[panel], key=key):
                lm, desc, spec, allow, flags = circuits[panel][num]
                if flags:
                    desc = f"{desc} ({', '.join(sorted(flags))})".strip()
                wc.cell(row, 1, int(num) if num.isdigit() else num)
                wc.cell(row, 2, desc)
                # full length, shown to 1 decimal: rounding the value first could round the allowance down a metre
                wc.cell(row, 3, round(lm, 4)).number_format = "0.0"
                formula(wc, row, 4, f"=ROUNDUP(C{row}*{1 + float(allow) / 100:g},0)")
                wc.cell(row, 5, spec)
                for col in range(1, 6):
                    wc.cell(row, col).border = BORDER
                if flags:
                    wc.cell(row, 3).fill = WARN_FILL
                row += 1
            row += 1
        # OTHERS: count items
        others = defaultdict(float)
        for _folder, item, q in rows:
            if item.get("type") == "count" and q["qty"]:
                others[(item.get("name") or "").upper()] += q["qty"]
        wc.merge_cells("G2:H2")
        wc["G2"] = "OTHERS"
        wc["G2"].font = BOLD
        wc["G2"].alignment = Alignment(horizontal="center")
        for col, text in ((7, "DESCRIPTION"), (8, "QTY")):
            cell = wc.cell(3, col, text)
            cell.font, cell.fill, cell.border = BOLD, HEAD_FILL, BORDER
        for i, (name, qty) in enumerate(others.items(), start=4):
            wc.cell(i, 7, name).border = BORDER
            wc.cell(i, 8, int(qty)).border = BORDER
        for col, w in zip("ABCDEFGH", (9, 28, 9, 12, 30, 3, 34, 8), strict=True):
            wc.column_dimensions[col].width = w

    # ---- Bill of materials and costs ----------------------------------------------------------------
    cost = pricing.costing(project)
    if cost["bom"]:
        cur = (project.get("settings") or {}).get("currency", "\u20b1")
        money = f'"{cur}"#,##0.00' if cur else "#,##0.00"
        wb_ = wb.create_sheet("Bill of Materials")
        _title(wb_, project, f"Bill of materials  ·  from the assemblies on each item  ·  exported {stamp}")
        _header(wb_, 4, ["CATEGORY", "MATERIAL", "UNIT", "QTY", "UNIT PRICE", "AMOUNT"], [20, 44, 8, 12, 14, 16])
        r = 5
        for b in cost["bom"]:
            m = b["material"]
            vals = [m.get("category") or "", m.get("name"), m.get("unit") or "", round(b["qty"], 4), pricing.num(m.get("price"))]
            for c, v in enumerate(vals, start=1):
                wb_.cell(r, c, v).border = BORDER
            formula(wb_, r, 6, f"=D{r}*E{r}").border = BORDER
            wb_.cell(r, 4).number_format = "0" if m.get("whole") else NUM
            wb_.cell(r, 5).number_format = money
            wb_.cell(r, 6).number_format = money
            r += 1
        last = r - 1
        r0 = r
        rows_ = [("Subtotal", f"=SUM(F5:F{last})"),
                 (f"Overhead {cost['overhead']:g}%", f"=F{r0}*{cost['overhead'] / 100:g}"),
                 (f"Contingency {cost['contingency']:g}%", f"=(F{r0}+F{r0 + 1})*{cost['contingency'] / 100:g}")]
        rows_ += [(e["label"], f"=F{r0}*{e['value'] / 100:g}" if e["type"] == "pct" else f"={e['value']:g}")
                  for e in cost["extras"]]
        end = r0 + len(rows_) - 1                       # last row before markup
        rows_ += [(f"Markup {cost['markup']:g}%", f"=SUM(F{r0}:F{end})*{cost['markup'] / 100:g}"),
                  (f"Tax {cost['tax']:g}%", f"=SUM(F{r0}:F{end + 1})*{cost['tax'] / 100:g}"),
                  ("TOTAL", f"=SUM(F{r0}:F{end + 2})")]
        for i, (label, f) in enumerate(rows_):
            wb_.cell(r + i, 5, label).font = BOLD
            c = formula(wb_, r + i, 6, f)
            c.font, c.number_format, c.border = BOLD, money, BORDER
        wb_.freeze_panes = "A5"

        wq = wb.create_sheet("Quote")
        _title(wq, project, "Cost build-up and quote summary")
        _header(wq, 4, ["LINE", "AMOUNT"], [44, 18])
        quote_rows = [
            ("Materials", cost["materials"]), ("Labour", cost["labour"]), ("Subtotal", cost["subtotal"]),
            (f"Overhead {cost['overhead']:g}%", cost["overheadAmount"]),
            (f"Contingency {cost['contingency']:g}%", cost["contingencyAmount"]),
            *((e["label"], e["amount"]) for e in cost["extras"]),
            (f"Markup {cost['markup']:g}%", cost["markupAmount"]),
            (f"Tax {cost['tax']:g}%", cost["taxAmount"]),
            ("TOTAL", cost["total"]),
        ]
        for i, (label, value) in enumerate(quote_rows, start=5):
            wq.cell(i, 1, label).border = BORDER
            c = wq.cell(i, 2, round(float(value or 0), 2))
            c.border, c.number_format = BORDER, money
            if label == "TOTAL":
                wq.cell(i, 1).font = BOLD
                c.font = BOLD

        wi = wb.create_sheet("Materials by Item")
        _title(wi, project, "Materials for each takeoff item (before rounding to whole units)")
        _header(wi, 4, ["FOLDER", "ITEM", "ASSEMBLY", "MATERIAL", "QTY", "UNIT", "UNIT PRICE", "AMOUNT"], [22, 28, 26, 40, 12, 8, 14, 16])
        r = 5
        for ln in cost["lines"]:
            m = ln["material"]
            vals = [ln["folder"], ln["item"].get("name"), ln["assembly"].get("name"), m.get("name"), round(ln["qty"], 4),
                    m.get("unit") or "", pricing.num(m.get("price"))]
            for c, v in enumerate(vals, start=1):
                wi.cell(r, c, v).border = BORDER
            formula(wi, r, 8, f"=E{r}*G{r}").border = BORDER
            wi.cell(r, 5).number_format = NUM
            wi.cell(r, 7).number_format = money
            wi.cell(r, 8).number_format = money
            r += 1
        wi.freeze_panes = "A5"
        if r > 5:
            wi.auto_filter.ref = f"A4:H{r - 1}"

    # ---- Notes (plan notes are not takeoff) ---------------------------------------------------------
    notes = [m for m in project.get("marks") or [] if m.get("kind") == "note" and (m.get("text") or "").strip()]
    if notes:
        wn = wb.create_sheet("Notes")
        _title(wn, project, "Notes written on the plans")
        _header(wn, 4, ["PAGE", "NOTE"], [36, 90])
        notes.sort(key=lambda m: page_order.get(m.get("page"), 1e9))
        for i, m in enumerate(notes, start=5):
            wn.cell(i, 1, (pages.get(m.get("page")) or {}).get("name", "")).border = BORDER
            c = wn.cell(i, 2, m["text"].strip())
            c.border = BORDER
            c.alignment = Alignment(wrap_text=True, vertical="top")
        wn.freeze_panes = "A5"

    # ---- Pages --------------------------------------------------------------------------------------
    wpg = wb.create_sheet("Pages")
    _title(wpg, project, "Pages and their scales")
    _header(wpg, 4, ["#", "PAGE", "GROUP", "SCALE", "PX PER M", "DPI", "WIDTH PX", "HEIGHT PX", "SOURCE", "SECTIONS"],
            [5, 36, 22, 22, 10, 8, 10, 10, 34, 10])
    sec_count = Counter()
    for _, item, _ in rows:
        for s in item.get("sections") or []:
            sec_count[s.get("page")] += 1
    for i, p in enumerate(project.get("pages") or [], start=1):
        sc = p.get("scale") or {}
        label = sc.get("label") or ""
        if sc.get("auto"):
            label += " (read from drawing, not checked)"
        values = [i, p.get("name"), p.get("group") or "", label if sc.get("pxPerM") else "NOT SET",
                  round(sc["pxPerM"], 4) if sc.get("pxPerM") else None, p.get("dpi"), p.get("width"), p.get("height"),
                  p.get("source") or "", sec_count.get(p["id"], 0)]
        for c, v in enumerate(values, start=1):
            wpg.cell(i + 4, c, v).border = BORDER
        if not sc.get("pxPerM") and sec_count.get(p["id"]):
            wpg.cell(i + 4, 4).fill = WARN_FILL
    wpg.freeze_panes = "A5"

    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.data_type == "f" and (ws.title, cell.row, cell.column) not in ours:
                    cell.data_type = "s"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_compare(report: dict) -> bytes:
    """Excel revision report: summary, item deltas, totals by type/unit and page matching."""
    old = report.get("old") or {}
    new = report.get("new") or {}
    wb = Workbook()
    ws = wb.active
    ws.title = "Revision"
    ws["A1"] = f"Revision comparison: {old.get('name') or 'Old'} -> {new.get('name') or 'New'}"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = (f"Old: {old.get('name') or ''} ({old.get('pages', 0)} pages)  ·  "
                f"New: {new.get('name') or ''} ({new.get('pages', 0)} pages)")
    ws["A2"].font = Font(italic=True, color="666666")
    s = report.get("summary") or {}
    ws["A3"] = (f"{s.get('changed', 0)} changed · {s.get('added', 0)} added · {s.get('removed', 0)} removed · "
                f"{s.get('same', 0)} unchanged · {s.get('matchedPages', 0)} pages matched")
    ws["A3"].font = Font(color="444444")

    head = ["STATUS", "FOLDER", "ITEM", "TYPE", "UNIT", "OLD QTY", "NEW QTY", "DELTA", "DELTA %", "PAGES", "NOTES"]
    _header(ws, 5, head, [11, 22, 32, 8, 7, 12, 12, 12, 9, 34, 40])
    fill = {
        "added": PatternFill("solid", fgColor="C6EFCE"),
        "removed": PatternFill("solid", fgColor="FFC7CE"),
        "changed": PatternFill("solid", fgColor="FFEB9C"),
    }
    r = 6
    for item in report.get("items") or []:
        notes = []
        if item.get("unscaled"):
            notes.append(f"{item['unscaled']} section(s) without a page scale")
        if item.get("oldSections") != item.get("newSections"):
            notes.append(f"sections {item.get('oldSections', 0)} -> {item.get('newSections', 0)}")
        values = [str(item.get("status") or "").upper(), item.get("folder") or "", item.get("name") or "",
                  TYPE_LABEL.get(item.get("type"), item.get("type")), item.get("unit") or "",
                  round(float(item.get("oldQty") or 0), 4), round(float(item.get("newQty") or 0), 4),
                  round(float(item.get("delta") or 0), 4),
                  (round(float(item["pct"]), 2) if item.get("pct") is not None else None),
                  ", ".join(item.get("pages") or []), "; ".join(notes)]
        for c, v in enumerate(values, start=1):
            cell = ws.cell(r, c, v)
            cell.border = BORDER
            if c in (6, 7, 8):
                cell.number_format = NUM
            if c == 9 and v is not None:
                cell.number_format = '0.00"%"'
        status = item.get("status")
        if status in fill:
            for c in range(1, len(head) + 1):
                ws.cell(r, c).fill = fill[status]
        r += 1
    if r > 6:
        ws.auto_filter.ref = f"A5:K{r - 1}"
    ws.freeze_panes = "A6"

    # Totals by type and unit.
    wt = wb.create_sheet("Totals")
    _title(wt, new, "Totals by type and unit")
    _header(wt, 4, ["TYPE", "UNIT", "OLD QTY", "NEW QTY", "DELTA", "DELTA %", "ITEMS"],
            [14, 10, 14, 14, 14, 10, 10])
    for i, t in enumerate(report.get("totals") or [], start=5):
        pct = (t["delta"] / t["oldQty"] * 100) if abs(t.get("oldQty") or 0) > 1e-9 else None
        vals = [TYPE_LABEL.get(t.get("type"), t.get("type")), t.get("unit"), round(t.get("oldQty") or 0, 4),
                round(t.get("newQty") or 0, 4), round(t.get("delta") or 0, 4),
                (round(pct, 2) if pct is not None else None), t.get("items", 0)]
        for c, v in enumerate(vals, start=1):
            cell = wt.cell(i, c, v)
            cell.border = BORDER
            if c in (3, 4, 5):
                cell.number_format = NUM
            if c == 6 and v is not None:
                cell.number_format = '0.00"%"'

    # Page matching.
    wp = wb.create_sheet("Pages")
    _title(wp, new, "Page matching")
    _header(wp, 4, ["STATUS", "OLD PAGE", "NEW PAGE", "MATCHED BY"], [14, 42, 42, 14])
    pages = report.get("pages") or {}
    r = 5
    for pair in pages.get("pairs") or []:
        for c, v in enumerate(["matched", pair.get("oldName"), pair.get("newName"), pair.get("how")], start=1):
            wp.cell(r, c, v).border = BORDER
        r += 1
    for p in pages.get("onlyOld") or []:
        for c, v in enumerate(["only old", p.get("name"), "", ""], start=1):
            wp.cell(r, c, v).border = BORDER
            wp.cell(r, c).fill = fill["removed"]
        r += 1
    for p in pages.get("onlyNew") or []:
        for c, v in enumerate(["only new", "", p.get("name"), ""], start=1):
            wp.cell(r, c, v).border = BORDER
            wp.cell(r, c).fill = fill["added"]
        r += 1

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
