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
import unittest
import urllib.error
import urllib.request

import numpy as np
from pathlib import Path

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

    def test_count_needs_no_scale(self):
        it = _item("count", "C", [{"page": "p2", "points": [[1, 1], [2, 2], [3, 3]]}])
        self.assertEqual(measure.item_quantities(it, self.pages)["qty"], 3)

    def test_imperial_units(self):
        it = _item("linear", "L", [{"page": "p1", "points": [[0, 0], [3.048, 0]]}])
        q = measure.item_quantities(it, self.pages, "imperial")
        self.assertAlmostEqual(q["qty"], 1.0)
        self.assertEqual(q["unit"], "ft")

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
            self.assertEqual(job["units"], "metric")
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


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import server
        from http.server import ThreadingHTTPServer
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


if __name__ == "__main__":
    unittest.main()
