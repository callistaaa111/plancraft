"""Write a project as a PlanSwift job (.SwiftJob) that PlanSwift can open.

A .SwiftJob is a zip holding XMLData.XML (the job tree: pages, takeoff folders and items with their sections) and
one TIFF image per page, stored at Pages/<page folders>/<page name>/{<image GUID>}.tiff. The page's Image property
carries that GUID. Section points are page-image pixels, the same as PlanCraft, and each page's scale is ScaleX /
ScaleY in pixels per Scale Unit. PlanSwift works the quantities out from the points itself, so none are written.

The reader in importers.read_swiftjob is the other half of this; tests round-trip through it.
"""
from __future__ import annotations

import io
import re
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

from measure import item_units, unit_info

# PlanCraft unit -> (PlanSwift Scale Units, metres per unit)
SCALE_UNITS = {"m": ("M", 1.0), "cm": ("CM", 0.01), "mm": ("MM", 0.001),
               "ft": ("FT", 0.3048), "in": ("IN", 0.0254), "yd": ("YD", 0.9144)}
SHAPES = {"circle": "Circle", "square": "Square", "triangle": "Triangle", "diamond": "Diamond", "cross": "Plus",
          "star": "Circle"}
CLEAR = 536870911          # PlanSwift's "no colour" (clNone)
EXPORT_DPI = 300           # what PlanSwift records for its own TIFF pages when the page does not say


def guid() -> str:
    return "{" + str(uuid.uuid4()).upper() + "}"


def tcolor(hex_color: str | None) -> int:
    """'#rrggbb' -> Delphi TColor (0x00BBGGRR)."""
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", hex_color or "")
    if not m:
        return 255
    v = int(m.group(1), 16)
    return ((v & 0xFF) << 16) | (v & 0xFF00) | (v >> 16)


def _num(v) -> str:
    """Numbers the way PlanSwift writes them: plain decimals, no exponent."""
    s = f"{float(v):.10f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def _safe(name: str, fallback: str) -> str:
    """A zip path component: no characters Windows forbids in file names."""
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", (name or "").strip()).strip(". ")
    return s[:120] or fallback


def _stamp() -> str:
    t = datetime.now()
    return f"{t.month}/{t.day}/{t.year} {t.strftime('%I:%M:%S %p').lstrip('0')}"


class _Xml:
    """Writes the job XML in PlanSwift's layout: <Item> with <Properties> and <Items>, two-space indents, CRLF."""

    def __init__(self):
        self.lines: list[str] = []
        self.stamp = _stamp()

    def open_item(self, cls: str, name: str, gid: str, depth: int):
        self.lines.append(f'{"  " * depth}<Item Class={quoteattr(cls)} Name={quoteattr(name)} GUID="{gid}">')
        self.lines.append(f'{"  " * (depth + 1)}<Properties>')

    def prop(self, depth: int, cls: str, name: str, text="", **attrs):
        a = "".join(f" {k}={quoteattr(str(v))}" for k, v in attrs.items())
        body = escape(str(text))
        self.lines.append(f'{"  " * (depth + 2)}<Property Class={quoteattr(cls)} GUID="{guid()}" Name={quoteattr(name)}'
                          f'{a}>{body}</Property>')

    def common(self, depth: int, gid: str, order: int):
        self.prop(depth, "Number", "OrderIndex", order, systemhidden="True")
        self.prop(depth, "Text", "GUID", gid, inheritaction="Ignore", systemlocked="True", systemhidden="True")
        self.prop(depth, "Text", "Created By", "", inheritaction="Flatten", group="Audit Trail")
        self.prop(depth, "Text", "Time Stamp", self.stamp, inheritaction="Flatten", group="Audit Trail")

    def children(self, depth: int):
        self.lines.append(f'{"  " * (depth + 1)}</Properties>')
        self.lines.append(f'{"  " * (depth + 1)}<Items>')

    def close_item(self, depth: int):
        self.lines.append(f'{"  " * (depth + 1)}</Items>')
        self.lines.append(f'{"  " * depth}</Item>')

    def folder(self, name: str, depth: int, order: int, gid: str | None = None) -> str:
        gid = gid or guid()
        self.open_item("Folder", name, gid, depth)
        self.prop(depth, "Text", "Name", name, inheritaction="Ignore", input="True", required="True", group="Item")
        self.prop(depth, "Type", "Type", "Folder", group="Item")
        self.prop(depth, "Color", "Color", CLEAR, group="Item")
        self.common(depth, gid, order)
        self.children(depth)
        return gid

    def text(self) -> str:
        return '<?xml version="1.0" encoding="Windows-1252" standalone="no"?>\r\n' + "\r\n".join(self.lines) + "\r\n"


def _digitizer(points) -> str:
    pts = "".join(f'<Point X="{_num(x)}" Y="{_num(y)}" PointType="Normal"/>' for x, y in points)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<Points>{pts}</Points>\n'


def _page_tree(pages: list[dict]) -> dict:
    """Nest pages by their group path ('A/B') -> {'pages': [...], 'folders': {name: subtree}}."""
    root = {"pages": [], "folders": {}}
    for p in pages:
        node = root
        for part in [s for s in (p.get("group") or "").split("/") if s.strip()]:
            node = node["folders"].setdefault(part.strip(), {"pages": [], "folders": {}})
        node["pages"].append(p)
    return root


def build(task, project: dict, project_dir: Path, out_path: Path) -> dict:
    """Write project as a .SwiftJob at out_path. Returns {file, pages, items, deducts, size}."""
    from PIL import Image

    pages = [p for p in project.get("pages") or [] if (project_dir / "pages" / p["image"]).is_file()]
    units = project.get("units") or "m"
    page_unit = unit_info(units)["len"] if unit_info(units)["len"] in SCALE_UNITS else "m"
    su, su_m = SCALE_UNITS[page_unit]
    measurement = "English" if unit_info(page_unit)["imperial"] else "Metric"
    x = _Xml()
    job_gid = guid()
    name = project.get("name") or "PlanCraft job"

    # ---- job ----------------------------------------------------------------------------------------
    x.open_item("Item", name, job_gid, 0)
    x.prop(0, "Text", "Name", name, inheritaction="Ignore", required="True", group="Item")
    x.prop(0, "Type", "Type", "Job", group="Item")
    x.common(0, job_gid, 0)
    x.prop(0, "Text", "Description", "")
    x.prop(0, "Text", "Notes", project.get("notes") or "")
    x.prop(0, "Text", "Measurement Type", measurement)
    x.children(0)

    # ---- pages: TIFF images and Page items, in folders like PlanCraft's page groups -------------------
    page_gid: dict[str, str] = {}
    images: list[tuple[str, dict]] = []      # (zip member, page)

    def write_pages(node, depth, path):
        order = 0
        for fname, sub in node["folders"].items():
            x.folder(fname, depth, order)
            write_pages(sub, depth + 1, path + [_safe(fname, "Folder")])
            x.close_item(depth)
            order += 1
        for p in node["pages"]:
            gid, img_gid = guid(), guid()
            page_gid[p["id"]] = gid
            pname = p.get("name") or "Page"
            images.append(("/".join(["Pages", *path, _safe(pname, "Page"), f"{img_gid}.tiff"]), p))
            x.open_item("Page", pname, gid, depth)
            x.prop(depth, "Text", "Name", pname, inheritaction="Ignore", input="True", required="True", group="Item")
            x.prop(depth, "Type", "Type", ".TIFF Page", group="Item")
            # the Image property's own GUID names the TIFF in the zip
            x.lines.append(f'{"  " * (depth + 2)}<Property Class="Large Image" GUID="{img_gid}" Name="Image" '
                           f'required="True" Transparent="0" ImageType="TTiffGraphic"></Property>')
            x.prop(depth, "Number", "PageWidth", "[!PageWidth]", systemlocked="True")
            x.prop(depth, "Number", "PageHeight", "[!PageHeight]", systemlocked="True")
            ppm = (p.get("scale") or {}).get("pxPerM")
            if ppm:
                x.prop(depth, "Number", "ScaleX", _num(float(ppm) * su_m), systemhidden="True")
                x.prop(depth, "Number", "ScaleY", _num(float(ppm) * su_m), systemhidden="True")
            x.prop(depth, "Text", "Measurement Type", measurement)
            x.prop(depth, "Text", "Scale Units", su, group="Takeoff Data")
            x.common(depth, gid, order)
            x.children(depth)
            x.close_item(depth)
            order += 1

    x.folder("Pages", 1, 0)
    write_pages(_page_tree(pages), 2, [])
    x.close_item(1)

    links = guid()
    x.open_item("Item", "Links", links, 1)
    x.prop(1, "Text", "Name", "Links", inheritaction="Ignore", required="True", group="Item")
    x.prop(1, "Type", "Type", "", group="Item")
    x.common(1, links, 1)
    x.children(1)
    x.close_item(1)

    # ---- takeoff --------------------------------------------------------------------------------------
    counts = {"items": 0, "deducts": 0}

    def item(it, depth, order, sections, name_suffix=""):
        kind = it["type"]
        cls = {"linear": "Linear", "area": "Area", "count": "Count"}[kind]
        gid = guid()
        props = it.get("props") or {}
        iu = item_units(it, units)
        iu = iu if iu in SCALE_UNITS else unit_info(iu)["len"]
        isu = SCALE_UNITS.get(iu, SCALE_UNITS["m"])[0]
        iname = (it.get("name") or cls) + name_suffix
        x.open_item(cls, iname, gid, depth)
        x.prop(depth, "Text", "Name", iname, inheritaction="Ignore", input="True", required="True", group="Item")
        x.prop(depth, "Text", "Description", props.get("description") or "", group="Item")
        x.prop(depth, "Type", "Type", cls, group="Item")
        x.prop(depth, "Text", "Item #", "", group="Item")
        qty_units = {"linear": "[Scale Units]", "area": "SQ [Scale Units]", "count": "EA"}[kind]
        x.prop(depth, "Number", "Qty", "[Takeoff]", inputunits=qty_units, group="Estimating")
        x.prop(depth, "Color", "Color", tcolor(it.get("color")), inheritaction="Flatten", input="True", group="Fill")
        x.prop(depth, "Text", "Fill Type", "Solid", input="True", group="Fill")
        if kind == "linear" and props.get("height"):
            x.prop(depth, "Number", "Wall Height", _num(props["height"]), inputunits="[Scale Units]", group="Takeoff Data")
        if kind == "area" and props.get("depth"):
            x.prop(depth, "Number", "Depth", _num(props["depth"]), units="[Scale Units]", inputunits="[Scale Units]",
                   group="Takeoff Data")
        if kind == "count":
            x.prop(depth, "Text", "Symbol Type", "Shape", group="Symbol Properties")
            x.prop(depth, "Text", "Shape", SHAPES.get(props.get("shape") or "circle", "Circle"), input="True",
                   group="Symbol Properties")
        x.prop(depth, "Text", "Scale Units", isu, inheritaction="Flatten", calculatebefore="-1", group="Takeoff Data")
        x.prop(depth, "Text", "DoubleClickAction", "Record", inheritaction="Inherit Formula", group="Other")
        x.prop(depth, "Text", "DragDropAction", "SubItem", inheritaction="Inherit Formula", group="Other")
        x.prop(depth, "Text", "LaunchAction", "Record", inheritaction="Inherit Formula", group="Other")
        x.common(depth, gid, order)
        x.children(depth)
        for si, sec in enumerate(sections):
            sgid = guid()
            scls = f"{cls} Section"
            x.open_item(scls, "Section", sgid, depth + 1)
            x.prop(depth + 1, "Text", "Name", "Section", inheritaction="Ignore", input="True", required="True", group="Item")
            x.prop(depth + 1, "Type", "Type", scls, group="Item")
            x.prop(depth + 1, "Text", "Page", "[[PageGUID]\\Name]", group="Item")
            x.prop(depth + 1, "Text", "PageGUID", page_gid[sec["page"]])
            x.prop(depth + 1, "Number", "ZOrder", 0)
            x.prop(depth + 1, "CheckBox", "Visible", "True")
            x.prop(depth + 1, "Text", "Box Mode", "None")
            x.prop(depth + 1, "Text", "DigitizerData", _digitizer(sec.get("points") or []))
            x.common(depth + 1, sgid, si)
            x.children(depth + 1)
            x.close_item(depth + 1)
        x.close_item(depth)
        counts["items"] += 1

    def write_tree(nodes, depth):
        order = 0
        for n in nodes:
            if n.get("kind") == "folder":
                x.folder(n.get("name") or "Folder", depth, order)
                write_tree(n.get("children") or [], depth + 1)
                x.close_item(depth)
                order += 1
                continue
            if n.get("type") not in ("linear", "area", "count"):
                continue
            secs = [s for s in n.get("sections") or [] if s.get("page") in page_gid]
            keep = [s for s in secs if not s.get("deduct")]
            item(n, depth, order, keep)
            order += 1
            cut = [s for s in secs if s.get("deduct")]
            if cut:   # PlanSwift has no cut-out flag we can set from a file: carry them as their own item
                item(n, depth, order, cut, " (deduct)")
                counts["deducts"] += 1
                order += 1

    x.folder("Takeoff", 1, 2)
    write_tree(project.get("tree") or [], 2)
    x.close_item(1)
    x.close_item(0)

    # ---- zip --------------------------------------------------------------------------------------------
    out_path = Path(out_path)
    tmp = out_path.with_suffix(".part")
    total = len(images)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for i, (member, p) in enumerate(images):
            if task:
                task.progress(i, total, f"Page {i + 1} of {total}: {p.get('name')}")
            with Image.open(project_dir / "pages" / p["image"]) as im:
                im = im.convert("RGB")
                dpi = float(p.get("dpi") or EXPORT_DPI)
                buf = io.BytesIO()
                im.save(buf, "TIFF", compression="packbits", dpi=(dpi, dpi))
            z.writestr(member, buf.getvalue())
        z.writestr("XMLData.XML", x.text().encode("cp1252", "xmlcharrefreplace"))
    tmp.replace(out_path)
    return {"file": out_path.name, "pages": total, "items": counts["items"], "deducts": counts["deducts"],
            "size": out_path.stat().st_size}

