"""Print / export plan pages as a high-quality PDF.

Each sheet is the plan (the original vector PDF page when PlanCraft kept it, else the full-resolution page image) with
the takeoff, highlights and notes drawn on top as vector graphics, plus an optional legend and title strip.
Geometry is in page-image pixels; it is mapped onto the paper with one scale per page.
"""
from __future__ import annotations

import io
import math
import re
import time
from datetime import datetime
from pathlib import Path

from measure import item_quantities

PAPER = {  # points, portrait
    "A4": (595, 842), "A3": (842, 1191), "A2": (1191, 1684), "A1": (1684, 2384), "A0": (2384, 3370),
    "Letter": (612, 792), "Legal": (612, 1008), "Tabloid": (792, 1224), "ARCH D": (1728, 2592),
}
MARGIN = 24
TITLE_H = 20
FONTS = {  # PlanCraft note font -> PDF base-14 font family (regular, bold, italic, bold italic)
    "times": ("tiro", "tibo", "tiit", "tibi"),
    "courier": ("cour", "cobo", "coit", "cobi"),
    "helv": ("helv", "hebo", "heit", "hebi"),
}


def _fitz():
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    return fitz


def rgb(hexcolor, default=(0.9, 0.1, 0.3)):
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(hexcolor or ""))
    if not m:
        return default
    v = int(m.group(1), 16)
    return ((v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255)


def _font(st):
    f = (st.get("font") or "").lower()
    fam = "times" if ("times" in f or "georgia" in f) else "courier" if ("courier" in f or "consolas" in f) else "helv"
    return FONTS[fam][(1 if st.get("bold") else 0) + (2 if st.get("italic") else 0)]


def walk_items(nodes, hidden=False):
    for n in nodes:
        h = hidden or n.get("visible") is False
        if n.get("kind") == "folder":
            yield from walk_items(n.get("children") or [], h)
        else:
            yield n, h


# ---- one sheet ---------------------------------------------------------------------------------------------
class Sheet:
    def __init__(self, fitz, page, region, scale, k):
        self.fitz, self.page, self.sc, self.k = fitz, page, scale, k
        self.rx, self.ry = region[0], region[1]

    def T(self, p):
        return self.fitz.Point((p[0] - self.rx) * self.sc, (p[1] - self.ry) * self.sc)


def _marker(shape, fitz, c, r, kind):
    x, y = c.x, c.y
    if kind == "square":
        shape.draw_rect(fitz.Rect(x - r * 0.9, y - r * 0.9, x + r * 0.9, y + r * 0.9))
    elif kind == "triangle":
        shape.draw_polyline([fitz.Point(x, y - r * 1.15), fitz.Point(x + r, y + r * 0.85), fitz.Point(x - r, y + r * 0.85), fitz.Point(x, y - r * 1.15)])
    elif kind == "diamond":
        shape.draw_polyline([fitz.Point(x, y - r * 1.2), fitz.Point(x + r * 1.2, y), fitz.Point(x, y + r * 1.2), fitz.Point(x - r * 1.2, y), fitz.Point(x, y - r * 1.2)])
    elif kind == "star":
        pts = []
        for i in range(11):
            a = -math.pi / 2 + i * math.pi / 5
            rr = r * 0.5 if i % 2 else r * 1.2
            pts.append(fitz.Point(x + math.cos(a) * rr, y + math.sin(a) * rr))
        shape.draw_polyline(pts)
    else:
        shape.draw_circle(c, r)


def draw_takeoff(sh: Sheet, project, page, include_hidden=False):
    fitz, k = sh.fitz, sh.k
    pg = sh.page
    items = [(it, hid) for it, hid in walk_items(project.get("tree") or [])]
    order = {"area": 0, "linear": 1, "count": 2}
    for it, hid in sorted(items, key=lambda x: order.get(x[0].get("type"), 3)):
        if hid and not include_hidden:
            continue
        secs = [s for s in it.get("sections") or [] if s.get("page") == page["id"] and s.get("points")]
        if not secs:
            continue
        col = rgb(it.get("color"))
        props = it.get("props") or {}
        shape = pg.new_shape()
        if it["type"] == "linear":
            w = max(0.35, float(props.get("lineWidth") or 3) * 0.45 * k)
            for s in secs:
                if len(s["points"]) >= 2:
                    shape.draw_polyline([sh.T(p) for p in s["points"]])
            shape.finish(color=col, width=w, lineCap=1, lineJoin=1, closePath=False, stroke_opacity=0.92)
        elif it["type"] == "area":
            op = min(0.9, max(0.05, float(props.get("opacity") or 0.3)))
            for s in secs:
                if len(s["points"]) < 3:
                    continue
                shape.draw_polyline([sh.T(p) for p in s["points"]] + [sh.T(s["points"][0])])
                shape.finish(color=col, fill=col, width=max(0.3, 0.8 * k), closePath=True,
                             fill_opacity=op * (0.4 if s.get("deduct") else 1), dashes="[3 2] 0" if s.get("deduct") else None)
        else:
            r = max(1.2, float(props.get("size") or 9) * 0.42 * k)
            kind = props.get("shape") or "circle"
            for s in secs:
                for p in s["points"]:
                    c = sh.T(p)
                    if kind == "cross":
                        shape.draw_line(fitz.Point(c.x - r, c.y - r), fitz.Point(c.x + r, c.y + r))
                        shape.draw_line(fitz.Point(c.x + r, c.y - r), fitz.Point(c.x - r, c.y + r))
                    else:
                        _marker(shape, fitz, c, r, kind)
            if kind == "cross":
                shape.finish(color=col, width=r * 0.7, lineCap=1)
            else:
                shape.finish(color=(1, 1, 1), fill=col, width=max(0.25, 0.4 * k), fill_opacity=0.88)
        shape.commit()


def _wrap(fitz, text, font, size, maxw):
    lines = []
    for para in (text or "").split("\n"):
        line = ""
        for word in para.split():
            t = f"{line} {word}" if line else word
            if fitz.get_text_length(t, fontname=font, fontsize=size) > maxw and line:
                lines.append(line)
                line = word
            else:
                line = t
        lines.append(line)
    return lines[:40]


def draw_marks(sh: Sheet, project, page, kind):
    """kind 'highlight' (drawn under the takeoff) or 'note' (on top)."""
    fitz, k = sh.fitz, sh.k
    pg = sh.page
    marks = [m for m in project.get("marks") or [] if m.get("page") == page["id"] and m.get("kind") == kind]
    for m in marks:
        if m.get("kind") != "highlight" or not m.get("points"):
            continue
        shape = pg.new_shape()
        pts = [sh.T(p) for p in m["points"]]
        w = max(1.0, float(m.get("width") or 20) * sh.sc)
        if len(pts) == 1:
            shape.draw_circle(pts[0], w / 2)
            shape.finish(color=None, fill=rgb(m.get("color"), (1, 0.83, 0)), fill_opacity=0.38)
        else:
            shape.draw_polyline(pts)
            shape.finish(color=rgb(m.get("color"), (1, 0.83, 0)), width=w, lineCap=1, lineJoin=1, stroke_opacity=0.38, closePath=False)
        shape.commit()
    for m in marks:
        if m.get("kind") != "note" or not (m.get("text") or "").strip():
            continue
        st = {"font": "Segoe UI", "size": 12, "textColor": "#1c1c1c", "fill": "#fffbe0", "width": 230, **{k_: v for k_, v in m.items() if v is not None}}
        # note sizes are screen pixels; a zoom-following note keeps its size relative to the plan
        f = (sh.sc / float(st["refS"])) if st.get("zoom") and st.get("refS") else 0.75 * k
        font = _font(st)
        fs = max(3.0, float(st["size"]) * f)
        pad = max(2.0, 8 * f)
        maxw = float(st["width"]) * f
        lines = _wrap(fitz, st["text"], font, fs, maxw - pad * 2 - 4)
        sized = m.get("height") is not None
        w = maxw if sized else min(maxw, max(40 * f, max(fitz.get_text_length(l, fontname=font, fontsize=fs) for l in lines) + pad * 2 + 4))
        lh = fs * 1.3
        text_h = len(lines) * lh + pad * 1.2
        h = max(text_h, float(m["height"]) * f if sized else 0)
        a = sh.T(m["at"])
        ox = float(m.get("ox") if m.get("ox") is not None else 10) * f
        oy = float(m.get("oy") if m.get("oy") is not None else -8) * f
        box = fitz.Rect(a.x + ox, a.y + oy - h, a.x + ox + w, a.y + oy)
        col = rgb(st.get("color"), (1, 0.83, 0))
        shape = pg.new_shape()
        lx, ly = max(box.x0, min(a.x, box.x1)), max(box.y0, min(a.y, box.y1))
        shape.draw_line(a, fitz.Point(lx, ly))
        shape.finish(color=col, width=max(0.5, 2 * f))
        shape.draw_circle(a, max(1.5, 5 * f))
        shape.finish(color=(0.3, 0.3, 0.3), fill=col, width=0.4)
        shape.draw_rect(box)
        shape.finish(color=(0.6, 0.6, 0.6), fill=rgb(st["fill"], (1, 0.98, 0.88)), width=0.5)
        shape.draw_rect(fitz.Rect(box.x0, box.y0, box.x0 + max(1.5, 4 * f), box.y1))
        shape.finish(color=None, fill=col)
        for i, line in enumerate(lines):
            y = box.y0 + pad * 0.6 + i * lh + fs * 0.85
            if y > box.y1:
                break
            shape.insert_text(fitz.Point(box.x0 + pad + 2, y), line, fontname=font, fontsize=fs, color=rgb(st["textColor"], (0.1, 0.1, 0.1)))
        shape.commit()


def legend_rows(project, page, include_hidden=False):
    units = project.get("units") or "m"
    pages = {p["id"]: p for p in project.get("pages") or []}
    rows = []
    for it, hid in walk_items(project.get("tree") or []):
        if hid and not include_hidden:
            continue
        if not any(s.get("page") == page["id"] for s in it.get("sections") or []):
            continue
        q = item_quantities(it, pages, units)
        v = q["per_page"].get(page["id"], 0.0)
        txt = f"{v:,.0f} {q['unit']}" if it["type"] == "count" else (f"{v:,.2f} {q['unit']}" if pages[page["id"]].get("scale") else "no scale")
        rows.append((it, txt))
    return rows


def draw_legend(fitz, pg, rows, area: "fitz.Rect", corner: str, k: float):
    if not rows:
        return
    fs = max(5.0, 7 * k)
    lh = fs * 1.55
    pad = 5 * k
    sw = 16 * k
    name_w = max(fitz.get_text_length(it.get("name") or "", fontname="helv", fontsize=fs) for it, _ in rows)
    qty_w = max(fitz.get_text_length(t, fontname="helv", fontsize=fs) for _, t in rows)
    col_w = sw + 6 * k + name_w + 10 * k + qty_w
    max_rows = max(4, int((area.height * 0.7 - pad * 2 - lh) / lh))
    ncols = math.ceil(len(rows) / max_rows)
    per_col = math.ceil(len(rows) / ncols)
    w = ncols * col_w + (ncols - 1) * 12 * k + pad * 2
    h = (per_col + 1) * lh + pad * 2
    x0 = area.x1 - w - 6 * k if "r" in corner else area.x0 + 6 * k
    y0 = area.y1 - h - 6 * k if "b" in corner else area.y0 + 6 * k
    shape = pg.new_shape()
    shape.draw_rect(fitz.Rect(x0, y0, x0 + w, y0 + h))
    shape.finish(color=(0.4, 0.4, 0.4), fill=(1, 1, 1), width=0.6, fill_opacity=0.94)
    shape.insert_text(fitz.Point(x0 + pad, y0 + pad + fs), "LEGEND", fontname="hebo", fontsize=fs)
    for i, (it, txt) in enumerate(rows):
        c, r_ = divmod(i, per_col)
        cx = x0 + pad + c * (col_w + 12 * k)
        cy = y0 + pad + (r_ + 1) * lh + fs * 0.4
        col = rgb(it.get("color"))
        mid = cy + fs * 0.1
        if it["type"] == "linear":
            shape.draw_line(fitz.Point(cx, mid), fitz.Point(cx + sw, mid))
            shape.finish(color=col, width=max(0.8, 1.6 * k), lineCap=1)
        elif it["type"] == "area":
            shape.draw_rect(fitz.Rect(cx, mid - fs * 0.45, cx + sw, mid + fs * 0.45))
            shape.finish(color=col, fill=col, fill_opacity=0.35, width=0.6)
        else:
            shape.draw_circle(fitz.Point(cx + sw / 2, mid), fs * 0.42)
            shape.finish(color=(1, 1, 1), fill=col, width=0.3)
        shape.insert_text(fitz.Point(cx + sw + 6 * k, cy + fs * 0.45), it.get("name") or "", fontname="helv", fontsize=fs)
        tw = fitz.get_text_length(txt, fontname="helv", fontsize=fs)
        shape.insert_text(fitz.Point(cx + col_w - tw, cy + fs * 0.45), txt, fontname="helv", fontsize=fs, color=(0.25, 0.25, 0.25))
    shape.commit()


def draw_title(fitz, pg, project, page, rect, k):
    fs = max(6.0, 7.5 * k * 0.9)
    sc = page.get("scale") or {}
    parts = [project.get("name") or "", page.get("name") or "", f"Scale: {sc.get('label') or ('calibrated' if sc.get('pxPerM') else 'not set')}",
             datetime.now().strftime("%Y-%m-%d %H:%M"), "PlanCraft"]
    shape = pg.new_shape()
    shape.draw_line(fitz.Point(rect.x0, rect.y0), fitz.Point(rect.x1, rect.y0))
    shape.finish(color=(0.5, 0.5, 0.5), width=0.5)
    x = rect.x0
    gap = (rect.width - sum(fitz.get_text_length(p, fontname="helv", fontsize=fs) for p in parts)) / max(1, len(parts) - 1)
    for i, p in enumerate(parts):
        shape.insert_text(fitz.Point(x, rect.y0 + (rect.height + fs) / 2), p, fontname="hebo" if i == 0 else "helv", fontsize=fs)
        x += fitz.get_text_length(p, fontname="helv", fontsize=fs) + max(10, gap)
    shape.commit()


# ---- the document ---------------------------------------------------------------------------------------------
def build(task, project: dict, project_dir: Path, opts: dict, out_path: Path) -> dict:
    fitz = _fitz()
    pages_by_id = {p["id"]: p for p in project.get("pages") or []}
    ids = [i for i in (opts.get("pages") or []) if i in pages_by_id] or [p["id"] for p in project.get("pages") or []]
    paper = opts.get("paper") or "plan"
    orient = opts.get("orientation") or "auto"
    area = opts.get("area")                # {"page": id, "rect": [x, y, w, h]} = only what was on screen
    smaller = opts.get("quality") == "smaller"
    doc = fitz.open()
    sources = {}
    try:
        for n, pid in enumerate(ids):
            page = pages_by_id[pid]
            task.progress(n, len(ids), f"Page {n + 1} of {len(ids)}: {page.get('name')}")
            W, H = float(page.get("width") or 1000), float(page.get("height") or 700)
            rx, ry, rw, rh = 0.0, 0.0, W, H
            if area and area.get("page") == pid and area.get("rect"):
                ax, ay, aw, ah = (float(v) for v in area["rect"])
                rx, ry = max(0.0, ax), max(0.0, ay)
                rw, rh = min(W, ax + aw) - rx, min(H, ay + ah) - ry
            dpi = float(page.get("dpi") or 150)
            title_h = TITLE_H if opts.get("title", True) else 0
            if paper == "plan":
                pw, ph = rw * 72 / dpi, rh * 72 / dpi
                margin = 0.0
                ph_total = ph + title_h * max(1, max(pw, ph) / 1190)
                sheet_w, sheet_h = pw, ph_total
            else:
                sheet_w, sheet_h = PAPER.get(paper, PAPER["A3"])
                land = orient == "landscape" or (orient == "auto" and rw > rh)
                if land:
                    sheet_w, sheet_h = sheet_h, sheet_w
                margin = MARGIN
            k = max(sheet_w, sheet_h) / 1190                      # line weights relative to an A3 sheet
            strip = title_h * k if title_h else 0
            avail = fitz.Rect(margin, margin, sheet_w - margin, sheet_h - margin - strip)
            sc = min(avail.width / rw, avail.height / rh)
            plan_rect = fitz.Rect(avail.x0 + (avail.width - rw * sc) / 2, avail.y0 + (avail.height - rh * sc) / 2,
                                  avail.x0 + (avail.width + rw * sc) / 2, avail.y0 + (avail.height + rh * sc) / 2)
            if paper == "plan":
                plan_rect = fitz.Rect(0, 0, rw * sc, rh * sc)

            # the plan with its overlays, drawn on a page of its own and then placed (clipped) on the sheet
            tmp = fitz.open()
            tp = tmp.new_page(width=rw * sc, height=rh * sc)
            src = page.get("src") or {}
            src_file = project_dir / "sources" / src.get("file", "") if src.get("file") else None
            if src_file and src_file.is_file():
                key = (src["file"], src.get("page", 0), src.get("turns", 0))   # turned once, when first opened
                if key not in sources:
                    sd = fitz.open(str(src_file))
                    sp = sd[src.get("page", 0)]
                    sp.set_rotation((sp.rotation + 90 * src.get("turns", 0)) % 360)
                    if sp.rotation:
                        sp.remove_rotation()                  # match the image PlanCraft rendered (and turned)
                    sources[key] = sd
                sd = sources[key]
                f = 72.0 / dpi                                # image px -> source points
                clip = fitz.Rect(rx * f, ry * f, (rx + rw) * f, (ry + rh) * f)
                tp.show_pdf_page(tp.rect, sd, src.get("page", 0), clip=clip)
            else:
                from PIL import Image
                Image.MAX_IMAGE_PIXELS = None
                img_path = project_dir / "pages" / page["image"]
                with Image.open(img_path) as im:
                    whole = rx == 0 and ry == 0 and rw == W and rh == H
                    if whole and not smaller:
                        tp.insert_image(tp.rect, filename=str(img_path))
                    else:
                        part = im if whole else im.crop((int(rx), int(ry), int(rx + rw), int(ry + rh)))
                        buf = io.BytesIO()
                        if smaller:
                            part.convert("RGB").save(buf, "JPEG", quality=82)
                        else:
                            part.save(buf, "PNG", compress_level=6)
                        tp.insert_image(tp.rect, stream=buf.getvalue())
            sh = Sheet(fitz, tp, (rx, ry, rw, rh), sc, k)
            if opts.get("marks", True):
                draw_marks(sh, project, page, "highlight")
            if opts.get("takeoff", True):
                draw_takeoff(sh, project, page, opts.get("hidden", False))
            if opts.get("marks", True):
                draw_marks(sh, project, page, "note")

            out = doc.new_page(width=sheet_w, height=sheet_h)
            out.show_pdf_page(plan_rect, tmp, 0)
            tmp.close()
            if opts.get("legend", True) and opts.get("takeoff", True):
                draw_legend(fitz, out, legend_rows(project, page, opts.get("hidden", False)), plan_rect, opts.get("legendCorner") or "br", k)
            if strip:
                draw_title(fitz, out, project, page, fitz.Rect(avail.x0 if margin else 6 * k, sheet_h - margin - strip,
                                                             sheet_w - (margin if margin else 6 * k), sheet_h - margin), k)
        doc.set_metadata({"title": f"{project.get('name')} - plans", "creator": "PlanCraft", "producer": "PlanCraft"})
        task.progress(len(ids), len(ids), "Saving the PDF")
        doc.save(str(out_path), garbage=3, deflate=True)
    finally:
        doc.close()
        for sd in sources.values():
            sd.close()
    return {"file": out_path.name, "pages": len(ids), "size": out_path.stat().st_size}


def clean_exports(folder: Path, keep_s: int = 6 * 3600) -> None:
    if not folder.is_dir():
        return
    for f in [*folder.glob("*.pdf"), *folder.glob("*.SwiftJob"), *folder.glob("*.part")]:
        if time.time() - f.stat().st_mtime > keep_s:
            f.unlink(missing_ok=True)

