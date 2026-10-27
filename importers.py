"""Turn plans into PlanCraft pages: PDFs and images are rendered to PNG, PlanSwift .SwiftJob files are
converted whole (page images, page scales and the takeoff tree).

Page geometry is in image pixels; a page's scale is stored as pixels per metre.
"""
from __future__ import annotations

import io
import math
import re
import shutil
import threading
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from math import gcd
from pathlib import Path

from store import DEFAULT_SETTINGS, new_id, new_project

MAX_SIDE = 10000          # px; larger sheets get a lower DPI so the browser stays responsive
INCH_M = 0.0254
FOOT_M = 0.3048
PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#9a6324",
           "#800000", "#469990", "#000075", "#bfef45", "#fabed4", "#dcbeff", "#ffd8b1", "#808000"]

METRIC_RATIOS = {5, 10, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 800, 1000,
                 1250, 1500, 2000, 2500, 5000}
RATIO_RE = re.compile(r"(?<![\d.:/])1\s*:\s*(\d{1,4})(?![\d:.])")
IMPERIAL_RE = re.compile(r"(\d+\s+\d+/\d+|\d+/\d+|\d+(?:\.\d+)?)\s*[\"″”]\s*=\s*1\s*['′’]\s*(?:-\s*0\s*[\"″”]?)?")


# ---- scales -------------------------------------------------------------------------------------------
def ratio_scale(dpi: float, ratio: float) -> float:
    """Pixels per metre for a 1:ratio drawing rendered at dpi."""
    return dpi / INCH_M / ratio


def imperial_scale(dpi: float, inches_per_foot: float) -> float:
    """Pixels per metre for an architectural scale like 1/8" = 1'-0" (inches_per_foot = 0.125)."""
    return dpi * inches_per_foot / FOOT_M


def _fraction(s: str) -> float:
    s = s.strip()
    total = 0.0
    for part in s.split():
        if "/" in part:
            a, b = part.split("/")
            total += float(a) / float(b)
        else:
            total += float(part)
    return total


def detect_scale(text: str, dpi: float) -> dict | None:
    """Most common drawing scale written on the sheet ("1:100", '1/8" = 1'-0"'), or None."""
    found: Counter = Counter()
    for m in RATIO_RE.finditer(text or ""):
        r = int(m.group(1))
        if r in METRIC_RATIOS:
            found[("ratio", r)] += 1
    for m in IMPERIAL_RE.finditer(text or ""):
        try:
            ipf = _fraction(m.group(1).replace(" /", "/").replace("/ ", "/"))
        except (ValueError, ZeroDivisionError):
            continue
        if 0 < ipf <= 3:
            found[("imperial", ipf)] += 1
    if not found:
        return None
    (kind, v), _ = found.most_common(1)[0]
    if kind == "ratio":
        return {"pxPerM": ratio_scale(dpi, v), "label": f"1:{v}", "auto": True}
    label = f"{_inch_label(v)}\" = 1'-0\""
    return {"pxPerM": imperial_scale(dpi, v), "label": label, "auto": True}


def _inch_label(ipf: float) -> str:
    whole = int(ipf)
    frac = ipf - whole
    for d in (2, 4, 8, 16, 32, 64):
        n = round(frac * d)
        if abs(frac * d - n) < 1e-6:
            if n == 0:
                return str(whole)
            g = gcd(n, d)
            f = f"{n // g}/{d // g}"
            return f"{whole} {f}" if whole else f
    return f"{ipf:g}"


# ---- page ranges --------------------------------------------------------------------------------------
def parse_pages(spec: str | None, count: int) -> list[int]:
    """'1-3, 5, 8-' -> [0, 1, 2, 4, 7, ...] (0-based). Empty means every page."""
    spec = (spec or "").strip()
    if not spec or spec.lower() == "all":
        return list(range(count))
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d*)\s*-\s*(\d*)", part)
        if m:
            a = int(m.group(1)) if m.group(1) else 1
            b = int(m.group(2)) if m.group(2) else count
        elif part.isdigit():
            a = b = int(part)
        else:
            raise ValueError(f"Can't read the page range '{part}'. Use something like 1-3, 5.")
        if a < 1 or b > count or a > b:
            raise ValueError(f"Page range '{part}' is outside 1-{count}.")
        out.update(range(a - 1, b))
    return sorted(out)


# ---- PDF ----------------------------------------------------------------------------------------------
def import_pdf(task, pdf_path: str | Path, out_dir: Path, filename: str, dpi: float = 200,
               page_spec: str | None = None, sources_dir: Path | None = None) -> dict:
    """Render the pages to PNG. With sources_dir, the PDF itself is kept too, so printing can use its vector drawing."""
    try:
        import pymupdf as fitz
    except ImportError:          # PyMuPDF older than 1.24.3
        import fitz

    doc = fitz.open(str(pdf_path))
    try:
        if doc.needs_pass:
            raise ValueError("This PDF is password-protected. Remove the password and try again.")
        kept = None
        if sources_dir is not None:
            import hashlib
            digest = hashlib.sha1(Path(pdf_path).read_bytes()).hexdigest()[:16]
            Path(sources_dir).mkdir(parents=True, exist_ok=True)
            kept = f"{digest}.pdf"
            if not (Path(sources_dir) / kept).is_file():
                shutil.copyfile(pdf_path, Path(sources_dir) / kept)
        idx = parse_pages(page_spec, doc.page_count)
        stem = Path(filename).stem
        pages = []
        for n, i in enumerate(idx):
            task.progress(n, len(idx), f"Rendering page {i + 1} of {doc.page_count}")
            page = doc[i]
            long_in = max(page.rect.width, page.rect.height) / 72
            eff = min(float(dpi), MAX_SIDE / long_in) if long_in else float(dpi)
            pix = page.get_pixmap(matrix=fitz.Matrix(eff / 72, eff / 72), alpha=False)
            pid = new_id("pg")
            pix.save(str(out_dir / f"{pid}.png"))
            label = ""
            try:
                label = page.get_label() or ""
            except Exception:
                pass
            name = label or (stem if doc.page_count == 1 else f"{stem} - p{i + 1}")
            try:
                text = page.get_text("text")
            except Exception:
                text = ""
            pages.append({"id": pid, "name": name, "image": f"{pid}.png", "width": pix.width, "height": pix.height,
                          "dpi": round(eff, 3), "scale": detect_scale(text, eff), "source": filename,
                          "sourcePage": i + 1, "text": text[:20000] if text else None,
                          **({"src": {"file": kept, "page": i}} if kept else {})})
            pix = None
        task.progress(len(idx), len(idx), "Done")
        return {"pages": pages}
    finally:
        doc.close()


# ---- images -------------------------------------------------------------------------------------------
def _open_image_lib():
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 400_000_000
    return Image


def _normalise(im, resize: bool = True):
    """Return an image the browser and PNG can take: 1/L/RGB, at most MAX_SIDE*1.4 on the long side
    (unless resize is False, for pages whose takeoff points are tied to the original pixels)."""
    Image = _open_image_lib()
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, "white")
        bg.paste(im, mask=im.split()[-1])
        im = bg
    elif im.mode not in ("1", "L", "RGB", "P"):
        im = im.convert("RGB")
    factor = 1.0
    limit = int(MAX_SIDE * 1.4)
    if resize and max(im.size) > limit:
        factor = limit / max(im.size)
        if im.mode in ("1", "P"):
            im = im.convert("L")
        im = im.resize((max(1, round(im.width * factor)), max(1, round(im.height * factor))), Image.LANCZOS)
    return im, factor


def _dpi_of(im) -> float | None:
    dpi = im.info.get("dpi")
    try:
        v = float(dpi[0]) if isinstance(dpi, (tuple, list)) else float(dpi)
    except (TypeError, ValueError, IndexError):
        return None
    return v if 20 <= v <= 2400 and abs(v - 72) > 0.01 else None   # 72 is "unknown" in most writers


def save_png(im, path: Path) -> None:
    im.save(path, "PNG", compress_level=3)


def import_image(task, path: str | Path, out_dir: Path, filename: str) -> dict:
    Image = _open_image_lib()
    pages = []
    with Image.open(path) as src:
        frames = getattr(src, "n_frames", 1)
        stem = Path(filename).stem
        for f in range(frames):
            task.progress(f, frames, f"Converting {filename}" + (f" page {f + 1}" if frames > 1 else ""))
            src.seek(f)
            dpi = _dpi_of(src)
            im, factor = _normalise(src.copy())
            pid = new_id("pg")
            save_png(im, out_dir / f"{pid}.png")
            pages.append({"id": pid, "name": stem if frames == 1 else f"{stem} - p{f + 1}", "image": f"{pid}.png",
                          "width": im.width, "height": im.height, "dpi": round(dpi * factor, 3) if dpi else None,
                          "scale": None, "source": filename, "sourcePage": f + 1})
    task.progress(frames, frames, "Done")
    return {"pages": pages}


def crop_page(src: Path, out_dir: Path, rect) -> dict:
    """Cut rect = [x, y, w, h] (page pixels) out of a page image into a new page image."""
    try:
        x, y, w, h = (float(v) for v in rect)
    except (TypeError, ValueError):
        raise ValueError("The crop area is not valid.") from None
    Image = _open_image_lib()
    with Image.open(src) as im:
        x0, y0 = max(0, math.floor(x)), max(0, math.floor(y))
        x1, y1 = min(im.width, math.ceil(x + w)), min(im.height, math.ceil(y + h))
        if x1 - x0 < 8 or y1 - y0 < 8:
            raise ValueError("The crop area is too small.")
        out = im.crop((x0, y0, x1, y1))
        pid = new_id("pg")
        save_png(out, out_dir / f"{pid}.png")
    return {"id": pid, "image": f"{pid}.png", "width": x1 - x0, "height": y1 - y0, "offset": [x0, y0]}


def rotate_page(src: Path, out_dir: Path, turns) -> dict:
    """Turn a page image by 90 degrees clockwise per turn (1, 2 or 3) into a new page image."""
    if turns not in (1, 2, 3):
        raise ValueError("Rotate by 1, 2 or 3 quarter turns.")
    Image = _open_image_lib()
    with Image.open(src) as im:
        out = im.transpose({1: Image.Transpose.ROTATE_270, 2: Image.Transpose.ROTATE_180, 3: Image.Transpose.ROTATE_90}[turns])
        name = f"{new_id('pg')}.png"
        save_png(out, out_dir / name)
    return {"image": name, "width": out.width, "height": out.height}


def copy_page_image(src: Path, out_dir: Path) -> dict:
    """Copy a page image (for a pasted page) and return its new name and size."""
    Image = _open_image_lib()
    pid = new_id("pg")
    dst = out_dir / f"{pid}.png"
    shutil.copyfile(src, dst)
    with Image.open(dst) as im:
        width, height = im.size
    return {"id": pid, "image": dst.name, "width": width, "height": height}


# ---- PlanSwift .SwiftJob ------------------------------------------------------------------------------
_PT = re.compile(r'X="([-\d.eE]+)" Y="([-\d.eE]+)"')
_UNIT_M = {"M": 1.0, "MM": 0.001, "CM": 0.01, "FT": FOOT_M, "IN": INCH_M, "YD": 0.9144}
_SHAPES = {"circle": "circle", "square": "square", "rectangle": "square", "triangle": "triangle",
           "diamond": "diamond", "cross": "cross", "x": "cross", "star": "star"}


def _props(el) -> dict[str, str]:
    p = el.find("Properties")
    if p is None:
        return {}
    return {q.get("Name"): (q.text or "").strip() for q in p.findall("Property")}


def _prop_attr(el, name: str, attr: str) -> str | None:
    p = el.find("Properties")
    if p is None:
        return None
    for q in p.findall("Property"):
        if q.get("Name") == name:
            return q.get(attr)
    return None


def _children(el) -> list:
    items = el.find("Items")
    if items is None:
        return []
    kids = list(items)

    def order(k):
        try:
            return int(_props(k).get("OrderIndex") or 0)
        except ValueError:
            return 0
    return sorted(kids, key=order)   # sort is stable, so ties keep the file order


def _float(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def tcolor_hex(v) -> str | None:
    """Delphi TColor (0x00BBGGRR) -> '#rrggbb'. System/default colours return None."""
    try:
        c = int(v)
    except (TypeError, ValueError):
        return None
    if c < 0 or c > 0xFFFFFF:
        return None
    return f"#{c & 0xFF:02x}{(c >> 8) & 0xFF:02x}{(c >> 16) & 0xFF:02x}"


def _points(text: str) -> list[list[float]]:
    return [[round(float(a), 2), round(float(b), 2)] for a, b in _PT.findall(text or "")]


def read_swiftjob(path: str | Path, filename: str | None = None) -> dict:
    """Parse the job XML (no images). Returns pages (with image member names), tree, units, name, skipped."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "XMLData.XML" not in names:
            raise ValueError("This is not a PlanSwift job (XMLData.XML is missing).")
        with z.open("XMLData.XML") as fh:
            root = ET.parse(fh).getroot()
    by_guid = {}
    for n in names:
        m = re.search(r"\{([0-9A-Fa-f-]{36})\}", n)
        if m:
            by_guid[m.group(1).upper()] = n

    jp = _props(root)
    top = {(_props(k).get("Name"), _props(k).get("Type")): k for k in _children(root)}

    # pages, in the order of the Pages folder
    pages, guid_to_page, metric_votes = [], {}, Counter()

    def walk_pages(el, group):
        for k in _children(el):
            p = _props(k)
            typ = p.get("Type", "")
            if typ == "Folder":
                walk_pages(k, group + [p.get("Name", "")])
            elif typ.endswith("Page"):
                img_guid = (_prop_attr(k, "Image", "GUID") or "").strip("{}").upper()
                member = by_guid.get(img_guid)
                ppm = None
                unit_m = _UNIT_M.get((p.get("Scale Units") or "M").upper(), 1.0)
                for key in ("ScaleX", "ScaleY"):
                    v = _float(p.get(key))
                    if v and v > 0:
                        ppm = v / unit_m
                        break
                if p.get("Measurement Type"):
                    metric_votes[p["Measurement Type"].lower() == "metric"] += 1
                pid = new_id("pg")
                page = {"id": pid, "name": p.get("Name") or f"Page {len(pages) + 1}", "image": f"{pid}.png",
                        "width": None, "height": None, "dpi": None,
                        "scale": {"pxPerM": ppm, "label": "From PlanSwift", "auto": False} if ppm else None,
                        "source": filename or Path(path).name, "group": "/".join(g for g in group if g),
                        "_member": member}
                pages.append(page)
                if p.get("GUID"):
                    guid_to_page[p["GUID"].upper()] = pid

    pages_folder = top.get(("Pages", "Folder"))
    if pages_folder is not None:
        walk_pages(pages_folder, [])

    # takeoff tree
    skipped: Counter = Counter()
    color_i = [0]

    def next_color():
        c = PALETTE[color_i[0] % len(PALETTE)]
        color_i[0] += 1
        return c

    def convert(el) -> dict | None:
        p = _props(el)
        typ = p.get("Type", "")
        if typ == "Folder":
            kids = [n for n in (convert(k) for k in _children(el)) if n]
            return {"id": new_id("f"), "kind": "folder", "name": p.get("Name") or "Folder", "open": True,
                    "visible": True, "children": kids}
        kind = {"Linear": "linear", "Area": "area", "Count": "count"}.get(typ)
        if not kind:
            skipped[typ or "unnamed"] += 1
            return None
        for u in ("Scale Units",):
            if p.get(u):
                metric_votes[p[u].upper() in ("M", "MM", "CM")] += 1
        props = {"description": p.get("Description", ""), "spec": "", "notes": "",
                 "allowance": DEFAULT_SETTINGS["allowance"][kind]}
        if kind == "linear":
            props.update(lineWidth=3, height=_float(p.get("Wall Height")) or None)
        elif kind == "area":
            props.update(opacity=0.3, depth=_float(p.get("Depth")) or None)
        else:
            props.update(shape=_SHAPES.get((p.get("Shape") or "").lower(), "circle"), size=9)
        sections = []
        for s in _children(el):
            sp = _props(s)
            if not sp.get("Type", "").endswith("Section"):
                continue
            page = guid_to_page.get((sp.get("PageGUID") or "").upper())
            pts = _points(sp.get("DigitizerData", ""))
            need = {"linear": 2, "area": 3, "count": 1}[kind]
            if page and len(pts) >= need:
                sections.append({"id": new_id("s"), "page": page, "points": pts})
        return {"id": new_id("i"), "kind": "item", "type": kind, "name": p.get("Name") or kind.title(),
                "color": tcolor_hex(p.get("Color")) or next_color(), "visible": True, "props": props,
                "sections": sections}

    takeoff = top.get(("Takeoff", "Folder"))
    tree = [n for n in (convert(k) for k in _children(takeoff))] if takeoff is not None else []
    tree = [n for n in tree if n]
    units = "ft" if metric_votes and metric_votes[False] > metric_votes[True] else "m"
    return {"name": jp.get("Name") or Path(path).stem, "description": jp.get("Description", ""),
            "pages": pages, "tree": tree, "units": units, "skipped": dict(skipped)}


def import_swiftjob(task, path: str | Path, store, name: str | None = None, filename: str | None = None) -> dict:
    """filename: the name the user knows the job by (uploads arrive as temp files)."""
    task.progress(0, 1, "Reading the job file")
    filename = filename or Path(path).name
    job = read_swiftjob(path, filename)
    name = name or Path(filename).stem
    pid = store.allocate(name or job["name"])
    out_dir = store.projects / pid / "pages"
    pages = job["pages"]
    total = len(pages)
    zlock = threading.Lock()
    done = [0]
    Image = _open_image_lib()

    with zipfile.ZipFile(path) as z:
        def convert(page):
            member = page.pop("_member")
            if not member:
                return page, "image missing"
            with zlock:
                data = z.read(member)
            with Image.open(io.BytesIO(data)) as src:
                dpi = _dpi_of(src)
                im, _ = _normalise(src, resize=False)
                save_png(im, out_dir / page["image"])
                page.update(width=im.width, height=im.height, dpi=dpi)
            with zlock:
                done[0] += 1
                task.progress(done[0], total, f"Converting page {done[0]} of {total}: {page['name']}")
            return page, None

        task.progress(0, total, f"Converting {total} pages")
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(convert, pages))

    missing = [p["name"] for p, err in results if err]
    kept = [p for p, err in results if not err]
    kept_ids = {p["id"] for p in kept}

    def drop_orphans(nodes):
        for n in nodes:
            if n["kind"] == "folder":
                drop_orphans(n["children"])
            else:
                n["sections"] = [s for s in n["sections"] if s["page"] in kept_ids]
    drop_orphans(job["tree"])

    project = new_project(pid, name or job["name"], job["units"])
    project["pages"] = kept
    project["tree"] = job["tree"]
    project["notes"] = job["description"]
    project["importedFrom"] = filename
    store.save(pid, project, write_new=True)
    return {"projectId": pid, "pages": len(kept), "missingImages": missing, "skipped": job["skipped"]}
