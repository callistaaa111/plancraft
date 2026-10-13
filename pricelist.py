"""Read a supplier price list (Excel or CSV) into [{name, unit, price, category}].

Finds the header row by its column names (description / unit / price), reads the rows below it, and treats a row with
a description but no price as a category heading for the rows that follow.
"""
from __future__ import annotations

import csv
import io
import re
from pathlib import Path

DESC_BEST = re.compile(r"(description|desc\b|particulars|materials?\b|product)", re.I)
DESC_OK = re.compile(r"^(items?|name|item name)$", re.I)
NUMBER_COL = re.compile(r"(\bno\b|\bno\.|#|number|code|qty|quantity)", re.I)
UNIT = re.compile(r"^(unit|units|uom|u/m|u\.m\.?|unit of measure)$", re.I)
PRICE_BEST = re.compile(r"(unit\s*(price|cost)|price|cost|rate|srp)", re.I)
PRICE_LAST = re.compile(r"(amount|total)", re.I)
CAT = re.compile(r"^(category|group|type|class|section)$", re.I)


def _text(v) -> str:
    return "" if v is None else str(v).strip()


def _number(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    t = re.sub(r"[^\d.\-]", "", _text(v).replace(",", ""))
    try:
        return float(t) if t not in ("", "-", ".") else None
    except ValueError:
        return None


def _rows_from(path: Path, filename: str):
    """[(sheet name, rows as lists of cell values)] for every sheet in the file."""
    ext = Path(filename).suffix.lower()
    if ext == ".csv":
        raw = path.read_bytes()
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t") if text.strip() else csv.excel
        return [("", list(csv.reader(io.StringIO(text), dialect)))]
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        return [(ws.title, [list(r) for r in ws.iter_rows(values_only=True)]) for ws in wb.worksheets]
    finally:
        wb.close()


def _find_header(rows):
    for i, row in enumerate(rows[:40]):
        cells = [_text(c) for c in row]
        desc = next((j for j, c in enumerate(cells) if DESC_BEST.search(c) and not NUMBER_COL.search(c)), None)
        if desc is None:
            desc = next((j for j, c in enumerate(cells) if DESC_OK.match(c)), None)
        price = next((j for j, c in enumerate(cells) if PRICE_BEST.search(c)), None)
        if price is None:
            price = next((j for j, c in enumerate(cells) if PRICE_LAST.search(c)), None)
        if desc is not None and price is not None and desc != price:
            unit = next((j for j, c in enumerate(cells) if UNIT.match(c)), None)
            cat = next((j for j, c in enumerate(cells) if CAT.match(c)), None)
            return i, desc, unit, price, cat
    return None


def parse(path: Path, filename: str) -> dict:
    best = None
    for sheet, rows in _rows_from(Path(path), filename):
        found = _find_header(rows)
        if not found:
            continue
        hi, dc, uc, pc, cc = found
        out, heading = [], ""
        for row in rows[hi + 1:]:
            cell = lambda j: row[j] if j is not None and j < len(row) else None   # noqa: E731
            name = _text(cell(dc))
            if not name:
                continue
            price = _number(cell(pc))
            unit = _text(cell(uc))
            if price is None:
                if not unit:
                    heading = name            # a heading line between groups
                continue
            out.append({"name": name, "unit": unit, "price": round(price, 4),
                        "category": _text(cell(cc)) or heading})
        if out and (not best or len(out) > len(best["rows"])):
            best = {"sheet": sheet, "rows": out}
    if not best:
        raise ValueError("Couldn't find the prices. The file needs a header row with a description column "
                         "(Description / Item / Material) and a price column (Unit price / Price / Cost).")
    return best
