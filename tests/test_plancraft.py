"""PlanCraft tests: quantities, scale reading, imports, Excel export and the HTTP API.

    python -m unittest discover -s tests -v      (from the plancraft folder)
"""
from __future__ import annotations

import io
import json
import math
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

import export_xlsx  # noqa: E402
import importers  # noqa: E402
import measure  # noqa: E402
from store import Store  # noqa: E402


class _Task:
    def progress(self, *a, **k):
        pass


def make_swiftjob(path: Path) -> None:
    """A small PlanSwift-style job: one 400x300 page at 10 px/m, a folder with a linear and a count item."""
    import xml.etree.ElementTree as ET
    import zipfile

    from PIL import Image

    def item(parent, props, extra=None):
        el = ET.SubElement(parent, "Item")
        pe = ET.SubElement(el, "Properties")
        for k, v in props.items():
            q = ET.SubElement(pe, "Property", Name=k, **((extra or {}).get(k, {})))
            q.text = v
        return ET.SubElement(el, "Items")

    def points(*pts):
        return '<?xml version="1.0"?><Points>' + "".join(f'<Point X="{x}" Y="{y}" PointType="Normal"/>' for x, y in pts) + "</Points>"

    page_guid, img_guid = "{11111111-1111-1111-1111-111111111111}", "{22222222-2222-2222-2222-222222222222}"
    root = ET.Element("Item")
    ET.SubElement(ET.SubElement(root, "Properties"), "Property", Name="Name").text = "Demo job"
    top = ET.SubElement(root, "Items")
    pages = item(top, {"Name": "Pages", "Type": "Folder", "OrderIndex": "0"})
    item(pages, {"Name": "GF POWER", "Type": ".TIFF Page", "GUID": page_guid, "Image": "", "ScaleX": "10",
                 "Scale Units": "M", "Measurement Type": "Metric"}, extra={"Image": {"GUID": img_guid}})
    takeoff = item(top, {"Name": "Takeoff", "Type": "Folder", "OrderIndex": "1"})
    power = item(takeoff, {"Name": "Power", "Type": "Folder", "OrderIndex": "0"})
    lin = item(power, {"Name": "LP1-3", "Type": "Linear", "Color": "255", "OrderIndex": "0"})
    item(lin, {"Name": "Section", "Type": "Linear Section", "PageGUID": page_guid,
               "DigitizerData": points((0, 0), (30, 40), (30, 100))})
    cnt = item(power, {"Name": "DUPLEX OUTLET", "Type": "Count", "Shape": "Square", "OrderIndex": "1"})
    item(cnt, {"Name": "Section", "Type": "Count Section", "PageGUID": page_guid,
               "DigitizerData": points((5, 5), (50, 50), (90, 20))})
    buf = io.BytesIO()
    Image.new("RGB", (400, 300), "white").save(buf, "TIFF", dpi=(150, 150))
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("XMLData.XML", ET.tostring(root, encoding="utf-8"))
        z.writestr(f"Pages/GF POWER/{img_guid}.tiff", buf.getvalue())


def _item(kind, name, sections, **props):
    return {"id": f"i-{name}", "kind": "item", "type": kind, "name": name, "color": "#ff0000", "visible": True,
            "props": {"allowance": 0, **props}, "sections": sections}


class MeasureTests(unittest.TestCase):
    pages = {"p1": {"id": "p1", "scale": {"pxPerM": 10}}, "p2": {"id": "p2", "scale": None}}

    def test_linear_length_uses_page_scale(self):
        it = _item("linear", "L", [{"page": "p1", "points": [[0, 0], [30, 40], [30, 100]]}])
        q = measure.item_quantities(it, self.pages)
        self.assertAlmostEqual(q["qty"], (50 + 60) / 10)
        self.assertEqual(q["unit"], "m")

    def test_unscaled_pages_are_reported_not_counted(self):
        it = _item("linear", "L", [{"page": "p2", "points": [[0, 0], [100, 0]]}])
        q = measure.item_quantities(it, self.pages)
        self.assertEqual(q["qty"], 0)
        self.assertEqual(q["unscaled"], 1)

    def test_area_with_deduct_perimeter_and_volume(self):
        it = _item("area", "A", [
            {"page": "p1", "points": [[0, 0], [100, 0], [100, 100], [0, 100]]},
            {"page": "p1", "points": [[0, 0], [50, 0], [50, 50], [0, 50]], "deduct": True},
        ], depth=0.5)
        q = measure.item_quantities(it, self.pages)
        self.assertAlmostEqual(q["qty"], 100 - 25)
        extra = {label: v for label, v, _ in q["extra"]}
        self.assertAlmostEqual(extra["Perimeter"], 40)
        self.assertAlmostEqual(extra["Volume"], 37.5)

    def test_manual_adjustment_is_added_to_the_total(self):
        it = _item("linear", "L", [{"page": "p1", "points": [[0, 0], [100, 0]]}], adjust=2.5)
        q = measure.item_quantities(it, self.pages)
        self.assertAlmostEqual(q["qty"], 12.5)
        self.assertAlmostEqual(q["adjust"], 2.5)
        self.assertIn(("Manual adjustment", 2.5, "m"), q["extra"])

    def test_count_needs_no_scale(self):
        it = _item("count", "C", [{"page": "p2", "points": [[1, 1], [2, 2], [3, 3]]}])
        self.assertEqual(measure.item_quantities(it, self.pages)["qty"], 3)

    def test_imperial_units(self):
        it = _item("linear", "L", [{"page": "p1", "points": [[0, 0], [3.048, 0]]}])
        q = measure.item_quantities(it, self.pages, "imperial")
        self.assertAlmostEqual(q["qty"], 1.0)
        self.assertEqual(q["unit"], "ft")

    def test_item_can_choose_its_own_unit(self):
        it = _item("linear", "L", [{"page": "p1", "points": [[0, 0], [100, 0]]}], unit="mm")
        q = measure.item_quantities(it, self.pages, "m")
        self.assertAlmostEqual(q["qty"], 10000)
        self.assertEqual(q["unit"], "mm")
        it["props"]["unit"] = "bogus"  # unknown units fall back to the project's
        self.assertEqual(measure.item_quantities(it, self.pages, "yd")["unit"], "yd")

    def test_area_units_and_volume(self):
        sq = [{"page": "p1", "points": [[0, 0], [100, 0], [100, 100], [0, 100]]}]
        q = measure.item_quantities(_item("area", "A", sq, depth=50), self.pages, "cm")  # 10 m x 10 m, 0.5 m deep
        self.assertAlmostEqual(q["qty"], 1_000_000)
        self.assertEqual(q["unit"], "cm²")
        vol = {label: (v, u) for label, v, u in q["extra"]}["Volume"]
        self.assertAlmostEqual(vol[0], 50)
        self.assertEqual(vol[1], "m³")
        q = measure.item_quantities(_item("area", "A", sq, depth=3), self.pages, "ft")
        self.assertAlmostEqual({label: v for label, v, _ in q["extra"]}["Volume"], q["qty"] * 3 / 27)

    def test_count_unit_label(self):
        it = _item("count", "C", [{"page": "p1", "points": [[1, 1], [2, 2]]}], unit="pcs")
        q = measure.item_quantities(it, self.pages, "ft")
        self.assertEqual((q["qty"], q["unit"]), (2, "pcs"))

    def test_allowance_rounds_up_like_the_sheets(self):
        self.assertEqual(measure.with_allowance(39.68, 20), 48)   # ROUNDUP(39.68*1.2, 0)
        self.assertEqual(measure.with_allowance(10, 20), 12)
        self.assertEqual(measure.with_allowance(12.34, 0), 12.34)


class ScaleTests(unittest.TestCase):
    def test_ratio_from_text(self):
        s = importers.detect_scale("PLAN\nSCALE 1:100\nNOTE 1:100", 200)
        self.assertEqual(s["label"], "1:100")
        self.assertTrue(s["auto"])
        self.assertAlmostEqual(s["pxPerM"], 200 / 0.0254 / 100)

    def test_times_and_odd_ratios_are_ignored(self):
        self.assertIsNone(importers.detect_scale("PLOTTED 11:30 PM, ratio 1:37", 200))

    def test_imperial_architectural_scale(self):
        s = importers.detect_scale("FLOOR PLAN  SCALE: 1/8\" = 1'-0\"", 150)
        self.assertEqual(s["label"], "1/8\" = 1'-0\"")
        self.assertAlmostEqual(s["pxPerM"], 150 * 0.125 / 0.3048)

    def test_page_ranges(self):
        self.assertEqual(importers.parse_pages("", 4), [0, 1, 2, 3])
        self.assertEqual(importers.parse_pages("1-2, 4", 5), [0, 1, 3])
        self.assertEqual(importers.parse_pages("3-", 5), [2, 3, 4])
        with self.assertRaises(ValueError):
            importers.parse_pages("7", 5)

    def test_planswift_colours(self):
        self.assertEqual(importers.tcolor_hex("255"), "#ff0000")
        self.assertEqual(importers.tcolor_hex("16711680"), "#0000ff")
        self.assertIsNone(importers.tcolor_hex("536870911"))


class ImportTests(unittest.TestCase):
    def test_pdf_render_and_scale(self):
        import pymupdf as fitz
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "plan.pdf"
            doc = fitz.open()
            page = doc.new_page(width=1190, height=842)
            page.insert_text((100, 100), "SCALE 1:100", fontsize=20)
            page.draw_line((200, 400), (1000, 400))
            doc.save(pdf)
            doc.close()
            res = importers.import_pdf(_Task(), pdf, Path(tmp), "plan.pdf", dpi=200)
            p = res["pages"][0]
            self.assertEqual((p["width"], p["height"]), (round(1190 / 72 * 200), round(842 / 72 * 200)))
            self.assertEqual(p["scale"]["label"], "1:100")
            # the 800 pt line is 28.22 m at 1:100
            px = 800 / 72 * 200
            self.assertAlmostEqual(px / p["scale"]["pxPerM"], 800 / 72 * 0.0254 * 100, places=6)
            self.assertTrue((Path(tmp) / p["image"]).is_file())

    def test_image_import_keeps_dpi(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "scan.png"
            Image.new("RGBA", (300, 200), (255, 0, 0, 128)).save(src, dpi=(150, 150))
            res = importers.import_image(_Task(), src, Path(tmp), "scan.png")
            p = res["pages"][0]
            self.assertEqual((p["width"], p["height"]), (300, 200))
            self.assertAlmostEqual(p["dpi"], 150, places=0)

    def test_swiftjob_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            job_path = Path(tmp) / "demo.SwiftJob"
            make_swiftjob(job_path)
            job = importers.read_swiftjob(job_path)
            self.assertEqual(job["units"], "m")
            self.assertEqual(len(job["pages"]), 1)
            self.assertTrue(job["pages"][0]["_member"].endswith(".tiff"))
            self.assertEqual(job["pages"][0]["scale"]["pxPerM"], 10)
            folder = job["tree"][0]
            self.assertEqual((folder["kind"], folder["name"]), ("folder", "Power"))
            lin, cnt = folder["children"]
            self.assertEqual((lin["name"], lin["type"], lin["color"]), ("LP1-3", "linear", "#ff0000"))
            self.assertEqual((cnt["type"], cnt["props"]["shape"]), ("count", "square"))

            store = Store(Path(tmp) / "data")
            res = importers.import_swiftjob(_Task(), job_path, store, filename="demo.SwiftJob")
            self.assertEqual((res["pages"], res["missingImages"]), (1, []))
            project = store.load(res["projectId"])
            self.assertEqual(project["name"], "demo")
            page = project["pages"][0]
            self.assertEqual((page["width"], page["height"], page["dpi"]), (400, 300, 150))
            self.assertTrue(store.image_path(res["projectId"], page["image"]).is_file())
            pages = {p["id"]: p for p in project["pages"]}
            lin, cnt = project["tree"][0]["children"]
            self.assertAlmostEqual(measure.item_quantities(lin, pages)["qty"], (50 + 60) / 10)
            self.assertEqual(measure.item_quantities(cnt, pages)["qty"], 3)


class VisionTests(unittest.TestCase):
    def _plan(self, tmp):
        """A white sheet with eight 'junction box' symbols (circle with a cross), one turned, plus noise lines."""
        import cv2
        import numpy as np
        img = np.full((600, 900), 255, np.uint8)
        spots = [(100, 100), (300, 120), (520, 90), (760, 140), (120, 420), (340, 470), (600, 400)]
        def symbol(x, y, turned=False):                           # a circle with a flag pointing right (or down)
            cv2.circle(img, (x, y), 14, 0, 2)
            if turned:
                cv2.rectangle(img, (x - 6, y), (x + 6, y + 12), 0, -1)
            else:
                cv2.rectangle(img, (x, y - 6), (x + 12, y + 6), 0, -1)
        for x, y in spots:
            symbol(x, y)
        symbol(800, 480, turned=True)                             # the same symbol turned 90 degrees
        for i in range(0, 900, 150):
            cv2.line(img, (i, 0), (i + 120, 600), 0, 1)           # wires and grid lines that are not symbols
        path = Path(tmp) / "plan.png"
        cv2.imencode(".png", img)[1].tofile(str(path))
        return path, spots

    def test_auto_count_finds_every_symbol(self):
        import vision
        with tempfile.TemporaryDirectory() as tmp:
            path, spots = self._plan(tmp)
            res = vision.find_symbols(path, [100 - 18, 100 - 18, 36, 36], method="shape")
            strong = [m for m in res["matches"] if m[2] >= 0.9]
            self.assertEqual(len(strong), len(spots))                  # every upright symbol, nothing else
            for x, y in spots:
                self.assertTrue(any(math.dist((x, y), m[:2]) < 4 for m in strong), (x, y))

            def score_at(matches, x, y):
                return max([m[2] for m in matches if math.dist((x, y), m[:2]) < 4] or [0])
            upright_only = score_at(res["matches"], 800, 480)
            turned = score_at(vision.find_symbols(path, [100 - 18, 100 - 18, 36, 36], rotations=True, method="shape")["matches"], 800, 480)
            self.assertLess(upright_only, 0.9)                           # the turned one is weaker without rotations
            self.assertGreater(turned, 0.9)                              # ... and found properly with them
            with self.assertRaises(ValueError):
                vision.find_symbols(path, [450, 300, 30, 30])         # empty paper

    def test_dots_on_wires(self):
        """Lights drawn as solid dots on their wires, among hatching, text and grey columns."""
        import cv2

        import vision
        with tempfile.TemporaryDirectory() as tmp:
            img = np.full((700, 1000), 255, np.uint8)
            img[200:450, 500:800][::4, :] = 0                       # hatched (shaded) area
            for k in range(250):
                cv2.line(img, (500 + k, 200), (500 + k - 120, 450), 255, 1) if k % 3 else None
            for xw in (150, 400, 650, 880):                          # vertical wires
                cv2.line(img, (xw, 40), (xw, 660), 0, 2)
            lights = [(xw, yy) for xw in (150, 400, 650, 880) for yy in (100, 260, 420, 580)]
            for x, y in lights:
                cv2.circle(img, (x, y), 9, 0, -1)
            for i, (x, y) in enumerate(lights):
                cv2.putText(img, str(i % 9 + 1), (x + 14, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 0, 2)
            cv2.rectangle(img, (250, 300), (290, 340), 110, -1)         # a grey column
            path = Path(tmp) / "lights.png"
            cv2.imencode(".png", img)[1].tofile(str(path))
            res = vision.find_symbols(path, [150 - 16, 100 - 16, 32, 32])
            self.assertEqual(res["method"], "dots")
            found = [m for m in res["matches"] if m[2] >= 0.7]
            hits = sum(1 for x, y in lights if any(math.dist((x, y), m[:2]) < 5 for m in found))
            self.assertEqual(hits, len(lights))
            self.assertEqual(len(found), len(lights))                 # no text, wire, column or hatch hits
            part = vision.find_symbols(path, [150 - 16, 100 - 16, 32, 32], area=[0, 0, 500, 700])
            self.assertEqual(len([m for m in part["matches"] if m[2] >= 0.7]), 8)    # only the left two wires

    def test_tinted_overlay_image(self):
        import cv2

        import vision
        with tempfile.TemporaryDirectory() as tmp:
            path, _ = self._plan(tmp)
            out = vision.tinted(path, "green", Path(tmp) / "cache")
            img = cv2.imdecode(np.fromfile(str(out), np.uint8), cv2.IMREAD_UNCHANGED)
            self.assertEqual(img.shape, (600, 900, 4))
            self.assertEqual(int(img[300, 450, 3]), 0)                # paper is transparent
            b, g, r, a = (int(v) for v in img[100, 106])              # on the flag: opaque green
            self.assertEqual((r, g, b, a), (0, 150, 60, 255))


class PricingTests(unittest.TestCase):
    def project(self):
        materials = [
            {"id": "w", "name": "3.5 mm2 THHN wire", "unit": "m", "price": 25, "category": "Wires"},
            {"id": "c", "name": "20 mm PVC conduit (3 m)", "unit": "pc", "price": 90, "category": "Conduits", "whole": True},
            {"id": "b", "name": "Junction box", "unit": "pc", "price": 40, "category": "Boxes"},
        ]
        assemblies = [
            {"id": "lc", "name": "Lighting circuit", "parts": [
                {"id": "1", "material": "w", "factor": 2, "basis": "qtyAllow"},
                {"id": "2", "material": "c", "factor": 1, "basis": "qty", "pack": 3},
            ]},
            {"id": "jb", "name": "Junction box", "parts": [{"id": "3", "material": "b", "factor": 1, "basis": "qty"}]},
        ]
        tree = [
            {"id": "f", "kind": "folder", "name": "Lighting", "assembly": "lc", "children": [
                _item("linear", "LP1-1", [{"page": "p1", "points": [[0, 0], [100, 0]]}], allowance=20),   # 10 m
                _item("linear", "LP1-2", [{"page": "p1", "points": [[0, 0], [0, 45]]}], allowance=20),   # 4.5 m
                _item("count", "JB", [{"page": "p1", "points": [[1, 1], [2, 2], [3, 3]]}], assembly="jb"),
            ]},
            _item("linear", "No materials", [{"page": "p1", "points": [[0, 0], [10, 0]]}]),
        ]
        return {"name": "T", "units": "metric", "pages": [{"id": "p1", "scale": {"pxPerM": 10}}], "tree": tree,
                "materials": materials, "assemblies": assemblies, "settings": {"markup": 10, "currency": "P"}}

    def test_bill_of_materials(self):
        import pricing
        c = pricing.costing(self.project())
        bom = {b["material"]["id"]: b for b in c["bom"]}
        # wire: 2 x ROUNDUP(10*1.2) + 2 x ROUNDUP(4.5*1.2) = 2 x 12 + 2 x 6 = 36 m
        self.assertAlmostEqual(bom["w"]["qty"], 36)
        # conduit: (10 + 4.5) / 3 = 4.83 -> 5 whole pieces
        self.assertAlmostEqual(bom["c"]["raw"], 14.5 / 3)
        self.assertEqual(bom["c"]["qty"], 5)
        self.assertEqual(bom["b"]["qty"], 3)                              # the count item uses its own assembly
        self.assertAlmostEqual(c["subtotal"], 36 * 25 + 5 * 90 + 3 * 40)
        self.assertAlmostEqual(c["total"], c["subtotal"] * 1.1)
        self.assertNotIn("No materials", [ln["item"]["name"] for ln in c["lines"]])

    def test_labour_and_quote_totals(self):
        import pricing
        project = {
            "name": "Labour", "units": "m", "pages": [{"id": "p1", "scale": {"pxPerM": 10}}],
            "tree": [_item("count", "POINT", [{"page": "p1", "points": [[1, 1]]}], assembly="a")],
            "materials": [{"id": "l", "name": "Electrician", "unit": "hr", "price": 500, "kind": "labour",
                           "whole": False, "category": "Labour"}],
            "assemblies": [{"id": "a", "name": "Point", "parts": [
                {"id": "p", "material": "l", "factor": 2, "basis": "each", "pack": 1}]}],
            "settings": {"overhead": 10, "contingency": 5, "markup": 20, "tax": 12, "currency": "P"},
        }
        c = pricing.costing(project)
        self.assertAlmostEqual(c["materials"], 0)
        self.assertAlmostEqual(c["labour"], 1000)
        self.assertAlmostEqual(c["subtotal"], 1000)
        self.assertAlmostEqual(c["overheadAmount"], 100)
        self.assertAlmostEqual(c["contingencyAmount"], 55)
        self.assertAlmostEqual(c["markupAmount"], 231)
        self.assertAlmostEqual(c["taxAmount"], 166.32)
        self.assertAlmostEqual(c["total"], 1552.32)

    def test_export_has_bill_of_materials(self):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(export_xlsx.build(self.project())))
        self.assertIn("Bill of Materials", wb.sheetnames)
        self.assertIn("Materials by Item", wb.sheetnames)
        ws = wb["Bill of Materials"]
        names = [ws.cell(r, 2).value for r in range(5, 8)]
        self.assertEqual(sorted(names), sorted(["3.5 mm2 THHN wire", "20 mm PVC conduit (3 m)", "Junction box"]))
        self.assertEqual(ws["F5"].value, "=D5*E5")
        self.assertEqual(ws["E8"].value, "Subtotal")
        self.assertIn("Quote", wb.sheetnames)
        self.assertEqual(wb["Quote"]["A5"].value, "Materials")

    def test_price_list_import(self):
        import openpyxl

        import pricelist
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prices.xlsx"
            wb = openpyxl.Workbook()
            ws = wb.active
            ws.append(["ABC Electrical Supply - price list"])
            ws.append([])
            ws.append(["ITEM NO.", "DESCRIPTION", "UNIT", "UNIT PRICE"])
            ws.append([None, "WIRES", None, None])
            ws.append([1, "3.5mm2 THHN wire", "m", 25.5])
            ws.append([2, "5.5mm2 THHN wire", "m", "₱38.00"])
            ws.append([None, "BOXES", None, None])
            ws.append([3, "Junction box 4x4", "pc", 45])
            wb.save(path)
            res = pricelist.parse(path, "prices.xlsx")
            self.assertEqual([(r["name"], r["unit"], r["price"], r["category"]) for r in res["rows"]], [
                ("3.5mm2 THHN wire", "m", 25.5, "WIRES"), ("5.5mm2 THHN wire", "m", 38.0, "WIRES"),
                ("Junction box 4x4", "pc", 45.0, "BOXES")])
            csv_path = Path(tmp) / "prices.csv"
            csv_path.write_text("Material,Unit,Price\nPVC conduit 20mm,pc,90\nPVC elbow,pc,12.5\n", encoding="utf-8")
            self.assertEqual(len(pricelist.parse(csv_path, "prices.csv")["rows"]), 2)


class PrintTests(unittest.TestCase):
    def _project(self, tmp):
        """An image page and a page kept as its original PDF, with takeoff, a note and a highlight."""
        import pymupdf as fitz
        from PIL import Image
        d = Path(tmp)
        (d / "pages").mkdir()
        (d / "sources").mkdir()
        Image.new("RGB", (1000, 700), "white").save(d / "pages" / "pgimg.png")
        src = fitz.open()
        sp = src.new_page(width=720, height=504)                  # 10 x 7 in, rendered at 100 dpi = 1000 x 700 px
        sp.draw_line((72, 72), (648, 432))
        src.save(d / "sources" / "plan.pdf")
        Image.new("RGB", (1000, 700), "white").save(d / "pages" / "pgvec.png")
        pages = [{"id": "p1", "name": "Image page", "image": "pgimg.png", "width": 1000, "height": 700, "dpi": 100,
                  "scale": {"pxPerM": 10, "label": "1:100"}},
                 {"id": "p2", "name": "Vector page", "image": "pgvec.png", "width": 1000, "height": 700, "dpi": 100,
                  "scale": {"pxPerM": 10, "label": "1:100"}, "src": {"file": "plan.pdf", "page": 0}}]
        tree = [_item("linear", "LP1-1", [{"page": "p1", "points": [[100, 100], [600, 100], [600, 500]]},
                                          {"page": "p2", "points": [[100, 100], [900, 600]]}]),
                _item("count", "Lights", [{"page": "p1", "points": [[200, 200], [300, 300]]}], shape="square"),
                _item("area", "Room", [{"page": "p1", "points": [[700, 100], [900, 100], [900, 300]]}])]
        marks = [{"id": "m1", "page": "p1", "kind": "note", "at": [500, 400], "text": "Check this", "color": "#ffd400"},
                 {"id": "m2", "page": "p1", "kind": "highlight", "points": [[100, 600], [800, 600]], "color": "#ffd400", "width": 20}]
        return d, {"name": "Print test", "units": "metric", "pages": pages, "tree": tree, "marks": marks, "settings": {}}

    def test_print_pages(self):
        import pymupdf as fitz

        import printpdf
        with tempfile.TemporaryDirectory() as tmp:
            d, project = self._project(tmp)
            out = Path(tmp) / "a3.pdf"
            res = printpdf.build(_Task(), project, d, {"paper": "A3"}, out)
            self.assertEqual(res["pages"], 2)
            doc = fitz.open(out)
            self.assertEqual((round(doc[0].rect.width), round(doc[0].rect.height)), (1191, 842))     # landscape A3
            text = doc[0].get_text()
            self.assertIn("LEGEND", text)
            self.assertIn("LP1-1", text)
            self.assertIn("90.00 m", text)                       # LP1-1 on page 1: 500 + 400 px at 10 px/m
            self.assertIn("Check this", text)
            self.assertIn("Print test", text)                    # title strip
            doc.close()
            plan = Path(tmp) / "plan.pdf"
            printpdf.build(_Task(), project, d, {"paper": "plan", "pages": ["p2"], "legend": False, "title": False}, plan)
            doc = fitz.open(plan)
            self.assertEqual((round(doc[0].rect.width), round(doc[0].rect.height)), (720, 504))       # the drawing's own size
            self.assertEqual(len(doc[0].get_images()), 0)                                             # vector, no picture
            doc.close()


class ExportTests(unittest.TestCase):
    def test_workbook_sheets_and_circuits(self):
        import openpyxl
        project = {
            "name": "Test", "units": "metric",
            "pages": [{"id": "p1", "name": "GF", "scale": {"pxPerM": 10, "label": "1:100"}}],
            "tree": [{"id": "f", "kind": "folder", "name": "Power", "children": [
                _item("linear", "LP1-3", [{"page": "p1", "points": [[0, 0], [100, 0]]}], allowance=20, spec="3.5 mm2 THHN"),
                _item("linear", "AB-LP1-1 (NO HOMERUN)", [{"page": "p1", "points": [[0, 0], [0, 55]]}], allowance=20),
                _item("count", "EXIT SIGN", [{"page": "p1", "points": [[1, 1], [2, 2]]}]),
            ]}],
        }
        wb = openpyxl.load_workbook(io.BytesIO(export_xlsx.build(project)))
        self.assertEqual(wb.sheetnames, ["Summary", "By Page", "Circuits", "Pages"])
        rows = list(wb["Summary"].iter_rows(min_row=5, values_only=True))
        self.assertEqual(rows[0][:7], ("Power", "LP1-3", "Linear", None, "3.5 mm2 THHN", 10, "m"))
        wc = wb["Circuits"]
        self.assertEqual(wc["B2"].value, "LP1")
        self.assertEqual([wc.cell(r, 1).value for r in (4, 5)], [1, 3])
        self.assertEqual(wc["C4"].value, 5.5)
        self.assertIn("NO HOMERUN", wc["B4"].value)
        self.assertEqual(wc["D5"].value, "=ROUNDUP(C5*1.2,0)")
        self.assertEqual((wc["G4"].value, wc["H4"].value), ("EXIT SIGN", 2))

    def test_text_starting_with_equals_stays_text(self):
        import openpyxl
        project = {"name": "=HYPERLINK(\"http://x\")", "units": "m",
                   "pages": [{"id": "p1", "name": "GF", "scale": {"pxPerM": 10}}],
                   "tree": [_item("linear", "= see detail 3", [{"page": "p1", "points": [[0, 0], [100, 0]]}], allowance=20)]}
        ws = openpyxl.load_workbook(io.BytesIO(export_xlsx.build(project)))["Summary"]
        self.assertEqual((ws["A1"].data_type, ws["A1"].value), ("s", '=HYPERLINK("http://x")'))
        self.assertEqual((ws["B5"].data_type, ws["B5"].value), ("s", "= see detail 3"))
        self.assertEqual(ws["I5"].data_type, "f")                               # our own ROUNDUP formula is kept

    def test_swiftjob_round_trip(self):
        import zipfile

        from PIL import Image

        import export_swiftjob
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "pages").mkdir()
            Image.new("RGB", (400, 300), "white").save(d / "pages" / "a.png")
            Image.new("L", (200, 100), 255).save(d / "pages" / "b.png")
            pages = [{"id": "p1", "name": "GF <power>", "image": "a.png", "dpi": 150, "group": "Plans/Level 1",
                      "scale": {"pxPerM": 10}},
                     {"id": "p2", "name": "Roof", "image": "b.png", "dpi": 150, "scale": None}]
            tree = [{"id": "f", "kind": "folder", "name": "Power & lights", "children": [
                        _item("linear", "LP1-1", [{"page": "p1", "points": [[0, 0], [100, 0], [100, 50]]}], height=3),
                        _item("count", "Lights", [{"page": "p1", "points": [[5, 5], [9, 9]]},
                                                  {"page": "p2", "points": [[1, 1]]}], shape="diamond")]},
                    _item("area", "Slab", [{"page": "p1", "points": [[0, 0], [100, 0], [100, 100], [0, 100]]},
                                           {"page": "p1", "points": [[0, 0], [10, 0], [10, 10]], "deduct": True}],
                          depth=0.15, unit="mm")]
            project = {"name": "Round trip", "units": "ft", "pages": pages, "tree": tree}
            out = d / "job.SwiftJob"
            res = export_swiftjob.build(_Task(), project, d, out)
            self.assertEqual((res["pages"], res["items"], res["deducts"]), (2, 4, 1))
            with zipfile.ZipFile(out) as z:
                tiffs = [n for n in z.namelist() if n.endswith(".tiff")]
                self.assertEqual(len(tiffs), 2)
                self.assertTrue(tiffs[0].startswith("Pages/Plans/Level 1/GF _power_/{"))
                with Image.open(io.BytesIO(z.read(tiffs[1]))) as im:
                    self.assertEqual((im.mode, im.size, im.info.get("compression")), ("RGB", (200, 100), "packbits"))
            job = importers.read_swiftjob(out)
            self.assertEqual(job["units"], "ft")
            self.assertEqual([(p["name"], p["group"]) for p in job["pages"]], [("GF <power>", "Plans/Level 1"), ("Roof", "")])
            self.assertAlmostEqual(job["pages"][0]["scale"]["pxPerM"], 10)
            self.assertIsNone(job["pages"][1]["scale"])
            folder, slab, cut = job["tree"]
            self.assertEqual(folder["name"], "Power & lights")
            lp, lights = folder["children"]
            pg = {p["id"]: p for p in job["pages"]}
            self.assertAlmostEqual(measure.item_quantities(lp, pg, "m")["qty"], 15)          # 150 px at 10 px/m
            self.assertEqual(lp["props"]["height"], 3)
            self.assertEqual(lp["color"], "#ff0000")
            self.assertEqual((measure.item_quantities(lights, pg)["qty"], lights["props"]["shape"]), (2 + 1, "diamond"))
            self.assertEqual(slab["name"], "Slab")
            self.assertAlmostEqual(measure.item_quantities(slab, pg, "m")["qty"], 100)        # 10 m x 10 m
            self.assertEqual((cut["name"], len(cut["sections"])), ("Slab (deduct)", 1))


class CompareTests(unittest.TestCase):
    @staticmethod
    def page(pid, name, source, source_page=1):
        return {"id": pid, "name": name, "image": f"{pid}.png", "width": 100, "height": 100, "dpi": 150,
                "scale": {"pxPerM": 10}, "source": source, "sourcePage": source_page,
                "src": {"file": source, "page": 0}}

    def project(self, pid, page_id, items):
        return {"id": pid, "name": pid, "units": "m", "modified": "2026-10-27T00:00:00",
                "pages": [self.page(page_id, "E-301", "plan.pdf")], "tree": items, "marks": []}

    def test_quantity_deltas_and_matching(self):
        from compare import compare_projects
        old = self.project("old", "p1", [
            {"id": "f1", "kind": "folder", "name": "POWER", "children": [
                _item("linear", "L1", [{"page": "p1", "points": [[0, 0], [50, 0]]}]),
                _item("count", "OUTLET", [{"page": "p1", "points": [[1, 1]], "deduct": False},
                                          {"page": "p1", "points": [[2, 2]]},
                                          {"page": "p1", "points": [[3, 3]]}]),
                _item("count", "OLD DEVICE", [{"page": "p1", "points": [[4, 4]]}]),
            ]},
        ])
        new = self.project("new", "p2", [
            {"id": "f1", "kind": "folder", "name": "POWER", "children": [
                _item("linear", "L1", [{"page": "p2", "points": [[0, 0], [80, 0]]}]),
                _item("count", "OUTLET", [{"page": "p2", "points": [[1, 1]], "deduct": False},
                                          {"page": "p2", "points": [[2, 2]]},
                                          {"page": "p2", "points": [[3, 3]]},
                                          {"page": "p2", "points": [[4, 4]]}]),
                _item("count", "PANEL", [{"page": "p2", "points": [[5, 5]]}]),
            ]},
        ])
        rep = compare_projects(old, new)
        rows = {r["name"]: r for r in rep["items"]}
        self.assertEqual(rows["L1"]["status"], "changed")
        self.assertAlmostEqual(rows["L1"]["oldQty"], 5)
        self.assertAlmostEqual(rows["L1"]["newQty"], 8)
        self.assertAlmostEqual(rows["L1"]["delta"], 3)
        self.assertEqual(rows["OUTLET"]["status"], "changed")
        self.assertEqual(rows["OLD DEVICE"]["status"], "removed")
        self.assertEqual(rows["PANEL"]["status"], "added")
        self.assertEqual(rep["summary"]["changed"], 2)
        self.assertEqual(rep["summary"]["added"], 1)
        self.assertEqual(rep["summary"]["removed"], 1)
        self.assertEqual(len(rep["pages"]["pairs"]), 1)
        self.assertEqual(rep["pages"]["pairs"][0]["how"], "source")

    def test_compare_export_has_sheets(self):
        import io

        from openpyxl import load_workbook

        from compare import compare_projects
        old = self.project("old", "p1", [_item("count", "A", [{"page": "p1", "points": [[1, 1]]}])])
        new = self.project("new", "p2", [_item("count", "A", [{"page": "p2", "points": [[1, 1]]},
                                                               {"page": "p2", "points": [[2, 2]]}])])
        data = export_xlsx.build_compare(compare_projects(old, new))
        wb = load_workbook(io.BytesIO(data))
        self.assertIn("Revision", wb.sheetnames)
        self.assertIn("Totals", wb.sheetnames)
        self.assertIn("Pages", wb.sheetnames)
        self.assertEqual(wb["Revision"]["A6"].value, "CHANGED")
        self.assertEqual(wb["Revision"]["G6"].value, 2)


class SearchTests(unittest.TestCase):
    def test_search_finds_pages_items_notes_and_text(self):
        import search
        page = CompareTests.page("p1", "E-301 POWER", "plan.pdf")
        page["text"] = "PANEL LP1 SCHEDULE\nCIRCUIT 3 - LIGHTING"
        project = {
            "pages": [page],
            "tree": [{"id": "f", "kind": "folder", "name": "POWER", "children": [
                _item("linear", "LP1-3", [{"page": "p1", "points": [[0, 0], [10, 0]]}]),
            ]}],
            "marks": [{"kind": "note", "page": "p1", "text": "Check the LP1 panel with site"}],
        }
        res = search.search(project, Path("."), "LP1")
        kinds = {r["type"] for r in res["results"]}
        self.assertIn("item", kinds)
        self.assertIn("text", kinds)
        self.assertIn("note", kinds)
        self.assertTrue(all(r["pageId"] == "p1" for r in res["results"]))
        self.assertEqual(search.search(project, Path("."), "x")["results"], [])


class ArchiveTests(unittest.TestCase):
    def _project(self, tmp):
        from PIL import Image
        store = Store(Path(tmp) / "data")
        p = store.create("Archive demo", "m")
        Image.new("RGB", (120, 80), "white").save(store.pages_dir(p["id"]) / "pg1.png", "PNG")
        p["pages"] = [{"id": "p1", "name": "E-1", "image": "pg1.png", "width": 120, "height": 80, "dpi": 150,
                       "scale": {"pxPerM": 10}, "source": "plan.pdf", "sourcePage": 1}]
        p["tree"] = [_item("count", "OUTLET", [{"page": "p1", "points": [[1, 1]]}])]
        store.save(p["id"], p)
        return store, p["id"]

    def test_export_import_roundtrip(self):
        import archive
        with tempfile.TemporaryDirectory() as tmp:
            store, pid = self._project(tmp)
            data = archive.export_project(store, pid)
            path = Path(tmp) / "job.plancraft.zip"
            path.write_bytes(data)
            other = Store(Path(tmp) / "restored")
            p = archive.import_project(other, path)
            self.assertNotEqual(p["id"], pid)
            self.assertEqual(p["name"], "Archive demo")
            self.assertEqual(len(p["pages"]), 1)
            self.assertTrue((other.pages_dir(p["id"]) / "pg1.png").is_file())
            self.assertEqual(p["tree"][0]["name"], "OUTLET")

    def test_unsafe_archive_is_refused(self):
        import zipfile

        import archive
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "data")
            path = Path(tmp) / "bad.zip"
            with zipfile.ZipFile(path, "w") as z:
                z.writestr("../evil.txt", "x")
                z.writestr("project.json", "{}")
            with self.assertRaises(ValueError):
                archive.import_project(store, path)


class DemoTests(unittest.TestCase):
    def test_demo_project_has_a_page_and_takeoff(self):
        import demo
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "data")
            p = demo.create(store)
            self.assertEqual(len(p["pages"]), 1)
            self.assertTrue((store.project_dir(p["id"]) / "pages" / p["pages"][0]["image"]).is_file())
            self.assertEqual(len(p["tree"]), 3)
            self.assertTrue(p["materials"])
            self.assertTrue(p["assemblies"])


class SymbolTests(unittest.TestCase):
    def test_save_and_count_a_symbol(self):
        from PIL import Image, ImageDraw

        import symbols
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "data")
            p = store.create("Symbols", "m")
            im = Image.new("RGB", (400, 300), "white")
            d = ImageDraw.Draw(im)
            for x, y in ((50, 50), (200, 50), (50, 200)):
                d.rectangle((x, y, x + 20, y + 20), fill="black")
            im.save(store.pages_dir(p["id"]) / "pg.png", "PNG")
            p["pages"] = [{"id": "p1", "name": "E-1", "image": "pg.png", "width": 400, "height": 300, "dpi": 150,
                           "scale": {"pxPerM": 10}}]
            store.save(p["id"], p)
            sym = symbols.save(store, p["id"], "Square", "pg.png", [50, 50, 20, 20])
            self.assertEqual(sym["name"], "Square")
            self.assertEqual(len(symbols.list_symbols(store, p["id"])), 1)
            out = symbols.count(store, p["id"], sym["id"], ["p1"])
            self.assertGreaterEqual(out["total"], 3)
            symbols.delete(store, p["id"], sym["id"])
            self.assertEqual(symbols.list_symbols(store, p["id"]), [])


class QolTests(unittest.TestCase):
    def test_duplicate_storage_csv_and_empty_trash(self):
        from PIL import Image

        import export_csv
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "data")
            p = store.create("Original job", "m")
            Image.new("RGB", (80, 60), "white").save(store.pages_dir(p["id"]) / "pg.png", "PNG")
            p["pages"] = [{"id": "p1", "name": "E-1", "image": "pg.png", "width": 80, "height": 60, "dpi": 150,
                           "scale": {"pxPerM": 10}}]
            p["tree"] = [_item("count", "OUTLET", [{"page": "p1", "points": [[1, 1]]}])]
            store.save(p["id"], p)

            copy = store.duplicate(p["id"], "Copy job")
            self.assertNotEqual(copy["id"], p["id"])
            self.assertEqual(copy["name"], "Copy job")
            self.assertEqual(copy["pages"][0]["image"], "pg.png")
            self.assertTrue((store.pages_dir(copy["id"]) / "pg.png").is_file())

            data = export_csv.build(copy)
            self.assertIn(b"Folder,Item,Type", data)
            self.assertIn(b"OUTLET", data)

            storage = store.storage()
            self.assertGreaterEqual(storage["projectCount"], 2)
            self.assertGreater(storage["total"], 0)

            store.delete(p["id"])
            self.assertGreaterEqual(store.storage()["trashCount"], 1)
            store.empty_trash()
            self.assertEqual(store.storage()["trashCount"], 0)


class TemplateTests(unittest.TestCase):
    def test_template_roundtrip_drops_takeoff_and_keeps_prices(self):
        import templates
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "data")
            p = store.create("Template source", "m")
            p["settings"] = {"markup": 12, "currency": "P", "overhead": 5}
            p["materials"] = [{"id": "w", "name": "Wire", "unit": "m", "price": 25}]
            p["assemblies"] = [{"id": "a", "name": "Circuit", "parts": [
                {"id": "p", "material": "w", "factor": 2, "basis": "qty", "pack": 1}]}]
            p["pages"] = [{"id": "pg", "name": "E-1", "scale": {"pxPerM": 10}}]
            p["tree"] = [{"id": "f", "kind": "folder", "name": "POWER", "children": [
                _item("linear", "L1", [{"page": "pg", "points": [[0, 0], [10, 0]]}], assembly="a")]}]
            store.save(p["id"], p)

            tpl = templates.Templates(store)
            saved = tpl.save(store.load(p["id"]), "Standard electrical")
            self.assertEqual(len(tpl.list()), 1)
            new = tpl.create_project(store, saved["id"], "New job")
            self.assertNotEqual(new["id"], p["id"])
            self.assertEqual(new["name"], "New job")
            self.assertEqual(new["materials"][0]["name"], "Wire")
            self.assertEqual(new["assemblies"][0]["id"], "a")
            self.assertEqual(new["tree"][0]["name"], "POWER")
            self.assertEqual(new["tree"][0]["children"][0]["sections"], [])
            self.assertEqual(new["pages"], [])
            self.assertEqual(new["settings"]["markup"], 12)
            tpl.delete(saved["id"])
            self.assertEqual(tpl.list(), [])


class QuoteTests(unittest.TestCase):
    def test_proposal_pdf_contains_company_client_and_total(self):
        import pymupdf

        import quote
        project = {
            "name": "Proposal demo", "units": "m", "pages": [{"id": "p1", "scale": {"pxPerM": 10}}],
            "tree": [_item("count", "POINT", [{"page": "p1", "points": [[1, 1]]}], assembly="a")],
            "materials": [{"id": "l", "name": "Electrician", "unit": "hr", "price": 500, "kind": "labour"}],
            "assemblies": [{"id": "a", "name": "Point", "parts": [
                {"id": "p", "material": "l", "factor": 1, "basis": "each", "pack": 1}]}],
            "settings": {"companyName": "ACME Electrical", "companyContact": "0917 000 0000",
                         "clientName": "Sample Client", "projectAddress": "Makati", "terms": "Valid for 30 days.",
                         "currency": "P", "markup": 10, "tax": 12},
        }
        data = quote.build(project)
        self.assertTrue(data.startswith(b"%PDF"))
        doc = pymupdf.open(stream=data, filetype="pdf")
        text = "\n".join(page.get_text() for page in doc)
        self.assertIn("ACME Electrical", text)
        self.assertIn("Sample Client", text)
        self.assertIn("TOTAL", text)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        import server
        cls.tmp = tempfile.TemporaryDirectory()
        server.Api.store = Store(cls.tmp.name)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Api)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_ping_reports_version(self):
        from version import __version__
        st, info = self.call("GET", "/api/ping")
        self.assertEqual(st, 200)
        self.assertEqual(info["app"], "PlanCraft")
        self.assertEqual(info["version"], __version__)
        self.assertIn("code", info)
        with urllib.request.urlopen(self.base + "/api/ping") as r:
            self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(r.headers["X-Frame-Options"], "DENY")

    def test_same_origin_helper(self):
        import server
        self.assertTrue(server.same_origin(80, "http://127.0.0.1"))
        self.assertTrue(server.same_origin(8791, "http://localhost:8791"))
        self.assertFalse(server.same_origin(8791, "http://127.0.0.1:8792"))
        self.assertFalse(server.same_origin(8791, "https://127.0.0.1:8791"))
        self.assertFalse(server.same_origin(8791, "null"))

    def test_cross_site_writes_are_refused(self):
        body = json.dumps({"name": "csrf"}).encode()
        for headers in ({"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
            req = urllib.request.Request(self.base + "/api/projects", data=body, method="POST",
                                         headers={"Content-Type": "text/plain", **headers})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(req)
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
        # the real app posts from its own origin, and that is still allowed
        req = urllib.request.Request(self.base + "/api/projects", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Origin": self.base})
        with urllib.request.urlopen(req) as r:
            self.assertEqual(r.status, 201)
            project_id = json.loads(r.read())["id"]
        self.call("DELETE", f"/api/projects/{project_id}")

    def test_search_endpoint(self):
        page = CompareTests.page("p1", "E-301", "plan.pdf")
        page["text"] = "PANEL LP1 SCHEDULE"
        st, p = self.call("POST", "/api/projects", {"name": "Search test"})
        p.update(pages=[page], tree=[_item("count", "OUTLET", [{"page": "p1", "points": [[1, 1]]}])])
        self.assertEqual(self.call("PUT", f"/api/projects/{p['id']}", p)[0], 200)
        st, res = self.call("GET", f"/api/projects/{p['id']}/search?q=LP1")
        self.assertEqual(st, 200)
        self.assertTrue(any(r["type"] == "text" for r in res["results"]))
        self.assertEqual(self.call("GET", f"/api/projects/{p['id']}/search?q=x")[1]["results"], [])

    def test_compare_endpoint(self):
        page = CompareTests.page("p1", "E-301", "plan.pdf")
        st, old = self.call("POST", "/api/projects", {"name": "Rev A"})
        old.update(pages=[page], tree=[_item("count", "OUTLET", [{"page": "p1", "points": [[1, 1]]}])])
        self.assertEqual(self.call("PUT", f"/api/projects/{old['id']}", old)[0], 200)
        st, new = self.call("POST", "/api/projects", {"name": "Rev B"})
        new.update(pages=[page], tree=[_item("count", "OUTLET", [{"page": "p1", "points": [[1, 1]]},
                                                               {"page": "p1", "points": [[2, 2]]}])])
        self.assertEqual(self.call("PUT", f"/api/projects/{new['id']}", new)[0], 200)
        st, rep = self.call("POST", f"/api/projects/{old['id']}/compare", {"other": new["id"]})
        self.assertEqual(st, 200)
        self.assertEqual(rep["summary"]["changed"], 1)
        self.assertEqual(rep["items"][0]["delta"], 1)
        self.assertEqual(self.call("POST", f"/api/projects/{old['id']}/compare", {"other": old["id"]})[0], 400)

    def test_project_roundtrip_and_delete(self):
        st, p = self.call("POST", "/api/projects", {"name": "Office Lighting", "units": "metric"})
        self.assertEqual(st, 201)
        p["tree"].append(_item("linear", "L1", []))
        self.assertEqual(self.call("PUT", f"/api/projects/{p['id']}", p)[0], 200)
        st, back = self.call("GET", f"/api/projects/{p['id']}")
        self.assertEqual(back["tree"][0]["name"], "L1")
        self.assertIn(p["id"], [x["id"] for x in self.call("GET", "/api/projects")[1]])
        self.assertEqual(self.call("DELETE", f"/api/projects/{p['id']}")[0], 200)
        self.assertEqual(self.call("GET", f"/api/projects/{p['id']}")[0], 404)

    def test_backups_and_restore(self):
        import store as store_mod
        st, p = self.call("POST", "/api/projects", {"name": "Backup test"})
        old_every = store_mod.BACKUP_EVERY_S
        store_mod.BACKUP_EVERY_S = 0                       # back up on every save for this test
        try:
            for name in ("v1", "v2", "v3"):
                p["name"] = name
                st, res = self.call("PUT", f"/api/projects/{p['id']}", p)
                self.assertEqual(st, 200)
                p["modified"] = res["modified"]            # like the browser: the next save proves it saw this one
                time.sleep(1.05)                           # backups are named by the second
        finally:
            store_mod.BACKUP_EVERY_S = old_every
        st, backups = self.call("GET", f"/api/projects/{p['id']}/backups")
        self.assertGreaterEqual(len(backups), 3)           # the empty start, v1 and v2
        v1 = next(b for b in backups if b["items"] == 0 and b["saved"]) if backups else None
        st, restored = self.call("POST", f"/api/projects/{p['id']}/restore", {"name": backups[1]["name"]})
        self.assertEqual(st, 200)
        self.assertEqual(restored["name"], "v1")
        st, after = self.call("GET", f"/api/projects/{p['id']}/backups")
        self.assertTrue(any(b["beforeRestore"] for b in after))   # the version before restoring is kept too
        self.assertEqual(self.call("POST", f"/api/projects/{p['id']}/restore", {"name": "../project.json"})[0], 404)
        self.assertIsNotNone(v1)

    def test_crop_and_copy_page_images(self):
        from PIL import Image
        st, a = self.call("POST", "/api/projects", {"name": "A"})
        st, b = self.call("POST", "/api/projects", {"name": "B"})
        store = Store(self.tmp.name)
        im = Image.new("RGB", (400, 300), "white")
        im.putpixel((150, 120), (255, 0, 0))
        im.save(store.pages_dir(a["id"]) / "pgsource.png")
        st, crop = self.call("POST", f"/api/projects/{a['id']}/pages/crop", {"image": "pgsource.png", "rect": [100.4, 100, 120, 50.5]})
        self.assertEqual(st, 200)
        self.assertEqual((crop["width"], crop["height"], crop["offset"]), (121, 51, [100, 100]))
        with Image.open(store.image_path(a["id"], crop["image"])) as c:
            self.assertEqual(c.getpixel((50, 20)), (255, 0, 0))      # same pixel, shifted by the offset
        self.assertEqual(self.call("POST", f"/api/projects/{a['id']}/pages/crop", {"image": "pgsource.png", "rect": [0, 0, 3, 3]})[0], 400)
        st, copy = self.call("POST", f"/api/projects/{b['id']}/pages/copy", {"fromProject": a["id"], "image": "pgsource.png"})
        self.assertEqual((st, copy["width"], copy["height"]), (200, 400, 300))
        self.assertTrue(store.image_path(b["id"], copy["image"]).is_file())
        self.assertEqual(self.call("POST", f"/api/projects/{b['id']}/pages/copy", {"fromProject": a["id"], "image": "pgmissing.png"})[0], 400)

    def test_rotate_page_image(self):
        from PIL import Image
        st, p = self.call("POST", "/api/projects", {"name": "Rotate"})
        store = Store(self.tmp.name)
        im = Image.new("RGB", (40, 30), "white")
        im.putpixel((10, 5), (255, 0, 0))                                        # W = 40, H = 30
        im.save(store.pages_dir(p["id"]) / "pgrot.png")
        # same rule as rotatePage in web/js/pageops.js: right (x, y) -> (H - 1 - y, x), left (y, W - 1 - x) in pixels
        for turns, size, red in ((1, (30, 40), (24, 10)), (3, (30, 40), (5, 29)), (2, (40, 30), (29, 24))):
            st, res = self.call("POST", f"/api/projects/{p['id']}/pages/rotate", {"image": "pgrot.png", "turns": turns})
            self.assertEqual((st, (res["width"], res["height"])), (200, size), turns)
            with Image.open(store.image_path(p["id"], res["image"])) as out:
                self.assertEqual(out.getpixel(red), (255, 0, 0), turns)
        self.assertEqual(self.call("POST", f"/api/projects/{p['id']}/pages/rotate", {"image": "pgrot.png", "turns": 5})[0], 400)

    def test_bad_ids_and_paths_are_refused(self):
        self.assertEqual(self.call("GET", "/api/projects/..%2F..%2Fsecret")[0], 404)
        st, p = self.call("POST", "/api/projects", {"name": "x"})
        self.assertEqual(self.call("GET", f"/api/projects/{p['id']}/pages/..%2Fproject.json")[0], 404)
        self.assertEqual(self.call("PUT", f"/api/projects/{p['id']}", {"nope": 1})[0], 400)
        for path in ("/../server.py", "/%2E%2E/server.py", "/js/../../store.py"):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(self.base + path)
            self.assertEqual(cm.exception.code, 404, path)
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn(b"PlanCraft", r.read())

    def test_foreign_host_and_quit_are_refused(self):
        port = self.base.rsplit(":", 1)[1]
        for path, method, headers in (("/api/projects", "GET", {"Host": f"evil.example:{port}"}),   # DNS rebinding
                                      ("/api/quit", "POST", {})):                                   # no launcher header
            req = urllib.request.Request(self.base + path, data=b"{}" if method == "POST" else None, method=method, headers=headers)
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req)
            self.assertEqual(cm.exception.code, 403, path)
        self.assertEqual(self.call("GET", "/api/ping")[0], 200)                  # still running

    def test_stale_window_cannot_overwrite(self):
        st, p = self.call("POST", "/api/projects", {"name": "Two windows"})
        a, b = dict(p), dict(p)                                                  # both windows loaded the same version
        a["name"] = "saved by A"
        st, res = self.call("PUT", f"/api/projects/{p['id']}", a)
        self.assertEqual(st, 200)
        b["name"] = "saved by B"
        self.assertEqual(self.call("PUT", f"/api/projects/{p['id']}", b)[0], 409)
        self.assertEqual(self.call("POST", f"/api/projects/{p['id']}/save", b)[0], 409)   # the close-time save too
        a["modified"] = res["modified"]
        self.assertEqual(self.call("PUT", f"/api/projects/{p['id']}", a)[0], 200)   # A keeps saving normally
        self.assertEqual(self.call("GET", f"/api/projects/{p['id']}")[1]["name"], "saved by A")

    def test_prune_keeps_images_a_backup_needs(self):
        import os
        store = Store(self.tmp.name)
        p = store.create("Prune")
        d = store.project_dir(p["id"])
        (d / "backups").mkdir()
        (d / "backups" / "20260101-000000.json").write_text(json.dumps({"pages": [{"image": "pgold.png"}]}), encoding="utf-8")
        old = time.time() - 7200
        for name in ("pgold.png", "pgjunk.png"):
            (d / "pages" / name).write_bytes(b"x")
            os.utime(d / "pages" / name, (old, old))
        self.assertEqual(store.prune_images(p["id"], p), 1)
        self.assertTrue((d / "pages" / "pgold.png").is_file())                  # a backup still shows this page
        self.assertFalse((d / "pages" / "pgjunk.png").is_file())


if __name__ == "__main__":
    unittest.main()
