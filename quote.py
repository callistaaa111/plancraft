"""Client-facing proposal PDF built from the project's quote build-up.

One A4 page for the summary and scope; a second page is added when the notes/terms are long. No logo upload yet.
"""
from __future__ import annotations

from datetime import date

import pricing


def _fitz():
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    return fitz


def _money(project: dict, value) -> str:
    cur = (project.get("settings") or {}).get("currency") or "\u20b1"
    # The built-in PDF fonts do not include the peso sign; use the ISO code rather than a missing glyph.
    code = {"\u20b1": "PHP", "\u20ac": "EUR", "\u00a3": "GBP"}.get(cur)
    if code:
        cur = code
    elif not str(cur).isascii():
        cur = ""
    return f"{cur} {float(value or 0):,.2f}".strip()


def _wrap(fitz, text: str, width: float, font: str = "helv", size: float = 9) -> list[str]:
    words = (text or "").replace("\r", "").split()
    lines, line = [], ""
    for word in words:
        candidate = (line + " " + word).strip()
        if fitz.get_text_length(candidate, fontname=font, fontsize=size) <= width or not line:
            line = candidate
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines or [""]


def build(project: dict, options: dict | None = None) -> bytes:
    fitz = _fitz()
    opts = options or {}
    settings = project.get("settings") or {}
    company = (settings.get("companyName") or opts.get("companyName") or "PlanCraft").strip()
    contact = (settings.get("companyContact") or "").strip()
    client = (settings.get("clientName") or opts.get("clientName") or "").strip() or "Client"
    address = (settings.get("projectAddress") or "").strip()
    terms = (settings.get("terms") or "This proposal is based on the plans and quantities listed above. "
             "Prices are valid for 30 days. Excluded: permits, temporary power, and work outside the shown scope.").strip()
    validity = str(settings.get("validity") or "30").strip()
    cost = pricing.costing(project)
    doc = fitz.open()
    W, H = 595, 842
    page = doc.new_page(width=W, height=H)
    ink = (0.12, 0.13, 0.16)
    muted = (0.38, 0.40, 0.44)
    accent = (0.10, 0.25, 0.42)

    def new_page():
        nonlocal page
        page = doc.new_page(width=W, height=H)
        page.draw_rect(fitz.Rect(0, 0, W, 6), color=None, fill=accent, width=0)

    def text(x, y, s, size=10, font="helv", color=ink):
        page.insert_text((x, y), str(s), fontname=font, fontsize=size, color=color)

    # Header
    page.draw_rect(fitz.Rect(0, 0, W, 112), color=None, fill=accent, width=0)
    text(48, 42, company[:60], 20, "hebo", (1, 1, 1))
    if contact:
        text(48, 62, contact[:90], 9, "helv", (0.85, 0.90, 0.96))
    text(W - 150, 42, "PROPOSAL", 18, "hebo", (1, 1, 1))
    text(W - 150, 62, date.today().isoformat(), 9, "helv", (0.85, 0.90, 0.96))

    y = 140
    text(48, y, "Prepared for", 9, "hebo", muted)
    text(48, y + 16, client[:80], 13, "hebo")
    text(48, y + 34, address[:100], 9, "helv", muted)

    text(330, y, "Project", 9, "hebo", muted)
    text(330, y + 16, (project.get("name") or "Takeoff")[:55], 11, "hebo")
    text(330, y + 34, f"{len(project.get('pages') or [])} page(s) - valid {validity} day(s)", 9, "helv", muted)

    y += 66
    page.draw_line(fitz.Point(48, y), fitz.Point(W - 48, y), color=(0.82, 0.84, 0.88), width=0.8)
    y += 20

    # Scope
    text(48, y, "Scope", 12, "hebo", accent)
    y += 16
    folders = [n for n in project.get("tree") or [] if n.get("kind") == "folder"]
    if folders:
        for folder in folders[:12]:
            count = len([1 for c in folder.get("children") or [] if c.get("kind") != "folder"])
            text(54, y, f"{folder.get('name') or 'Folder'} - {count} item(s)", 9)
            y += 13
    else:
        items = [n for n in project.get("tree") or [] if n.get("kind") != "folder"]
        text(54, y, f"{len(items)} takeoff item(s) across {len(project.get('pages') or [])} page(s)", 9)
        y += 13
    if y > 360:
        new_page()
        y = 60

    # Cost summary
    y += 10
    text(48, y, "Price summary", 12, "hebo", accent)
    y += 18
    rows = [("Materials", cost["materials"]), ("Labour", cost["labour"]), ("Subtotal", cost["subtotal"])]
    if cost.get("overheadAmount"):
        rows.append((f"Overhead ({cost['overhead']:g}%)", cost["overheadAmount"]))
    if cost.get("contingencyAmount"):
        rows.append((f"Contingency ({cost['contingency']:g}%)", cost["contingencyAmount"]))
    rows += [(e["label"], e["amount"]) for e in cost["extras"] if e["amount"]]
    if cost.get("markupAmount"):
        rows.append((f"Markup ({cost['markup']:g}%)", cost["markupAmount"]))
    if cost.get("taxAmount"):
        rows.append((f"Tax ({cost['tax']:g}%)", cost["taxAmount"]))
    rows.append(("TOTAL", cost["total"]))
    for label, value in rows:
        bold = label in ("Subtotal", "TOTAL")
        if y > H - 160:
            new_page()
            y = 60
        if label == "TOTAL":
            page.draw_rect(fitz.Rect(48, y - 12, W - 48, y + 6), color=None, fill=(0.93, 0.96, 1.0), width=0)
        text(54, y, label, 10 if bold else 9, "hebo" if bold else "helv")
        text(W - 150, y, _money(project, value), 10 if bold else 9, "hebo" if bold else "helv")
        y += 18

    # Notes / terms
    y += 12
    text(48, y, "Notes and terms", 12, "hebo", accent)
    y += 16
    for line in _wrap(fitz, terms, W - 100, "helv", 9):
        if y > H - 60:
            new_page()
            y = 60
        text(50, y, line, 9, "helv", muted)
        y += 12

    # Footer on every page.
    for i, p in enumerate(doc):
        p.insert_text((48, H - 28), "PlanCraft - proposal", fontname="helv", fontsize=8, color=muted)
        p.insert_text((W - 90, H - 28), f"Page {i + 1} of {doc.page_count}", fontname="helv", fontsize=8, color=muted)
    doc.set_metadata({"title": f"{project.get('name') or 'Proposal'} - proposal", "creator": "PlanCraft",
                      "producer": "PlanCraft"})
    data = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return data
