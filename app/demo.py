"""Create the built-in sample project used by "Try demo"."""
from __future__ import annotations

from PIL import Image, ImageDraw


def create(store) -> dict:
    p = store.create("Demo - Level 3 Electrical", "m")
    pid = p["id"]
    W, H = 1200, 800
    im = Image.new("RGB", (W, H), "#fbfbf8")
    d = ImageDraw.Draw(im)
    d.rectangle((40, 40, W - 40, H - 40), outline="#222", width=8)
    d.rectangle((40, 300, W - 40, 380), outline="#222", width=5)
    for x in (380, 760):
        d.line((x, 40, x, 300), fill="#222", width=5)
        d.line((x, 380, x, H - 40), fill="#222", width=5)
    d.text((70, 60), "OFFICE 301", fill="#444")
    d.text((410, 60), "OFFICE 302", fill="#444")
    d.text((790, 60), "CONFERENCE", fill="#444")
    d.text((70, 330), "CORRIDOR 3", fill="#444")
    for x, y in ((150, 150), (260, 150), (600, 150), (710, 150), (900, 150), (1010, 150),
                 (150, 520), (300, 520), (500, 520), (650, 520), (850, 520), (1000, 520)):
        d.ellipse((x - 9, y - 9, x + 9, y + 9), outline="#111", width=2)
        d.line((x - 6, y, x + 6, y), fill="#111", width=1)
        d.line((x, y - 6, x, y + 6), fill="#111", width=1)
    for x, y in ((120, 70), (300, 70), (700, 70), (1000, 70), (120, 760), (500, 760), (900, 760)):
        d.ellipse((x - 6, y - 6, x + 6, y + 6), outline="#111", width=2)
    d.rectangle((1080, 700, 1140, 760), outline="#111", width=2)
    d.text((1092, 724), "LP1", fill="#111")
    img = store.pages_dir(pid) / "pg-demo.png"
    im.save(img, "PNG", dpi=(150, 150))
    page = {"id": "pg-demo", "name": "E-301 - DEMO", "image": "pg-demo.png", "width": W, "height": H,
            "dpi": 150, "scale": {"pxPerM": 30, "label": "1:100"}, "source": "demo"}

    def item(iid, kind, name, color, sections, **props):
        return {"id": iid, "kind": "item", "type": kind, "name": name, "color": color, "visible": True,
                "props": {"allowance": 0, **props}, "sections": [{"id": f"{iid}-s{i}", "page": page["id"], "points": p}
                                                                for i, p in enumerate(sections)]}

    p["pages"] = [page]
    p["tree"] = [
        {"id": "demo-power", "kind": "folder", "name": "POWER", "open": True, "children": [
            item("demo-lp1", "linear", "LP1-3", "#e4572e",
                 [[[80, 340], [1120, 340]], [[900, 340], [900, 720], [1100, 720]]], allowance=20, spec="3.5 mm² THHN"),
            item("demo-outlet", "count", "DUPLEX OUTLET", "#2e86de",
                 [[[x, y]] for x, y in ((120, 70), (300, 70), (700, 70), (1000, 70), (120, 760), (500, 760), (900, 760))]),
        ]},
        {"id": "demo-light", "kind": "folder", "name": "LIGHTING", "open": True, "assembly": "demo-a", "children": [
            item("demo-down", "count", "LED DOWNLIGHT", "#f1c40f",
                 [[[x, y]] for x, y in ((150, 150), (260, 150), (600, 150), (710, 150), (900, 150), (1010, 150),
                                        (150, 520), (300, 520), (500, 520), (650, 520), (850, 520), (1000, 520))]),
        ]},
        {"id": "demo-area", "kind": "folder", "name": "AREAS", "open": True, "children": [
            item("demo-slab", "area", "GF SLAB", "#27ae60", [[[50, 50], [1150, 50], [1150, 750], [50, 750]]], depth=0.1),
        ]},
    ]
    p["materials"] = [
        {"id": "demo-wire", "name": "THHN wire 3.5 mm²", "unit": "m", "price": 32, "category": "Wiring", "whole": False},
        {"id": "demo-conduit", "name": "PVC conduit 20 mm", "unit": "m", "price": 48, "category": "Wiring", "whole": False},
        {"id": "demo-outlet", "name": "Duplex outlet", "unit": "ea", "price": 185, "category": "Devices", "whole": True},
        {"id": "demo-light", "name": "LED downlight 12 W", "unit": "ea", "price": 640, "category": "Lighting", "whole": True},
        {"id": "demo-labour", "name": "Electrician", "unit": "hr", "price": 800, "category": "Labour", "kind": "labour", "whole": False},
    ]
    p["assemblies"] = [
        # per downlight: the fixture, a 6 m wire drop, 3 m of conduit (3 m lengths) and half an hour of labour
        {"id": "demo-a", "name": "Downlight, installed", "parts": [
            {"id": "p1", "material": "demo-light", "factor": 1, "basis": "qty", "pack": 1},
            {"id": "p2", "material": "demo-wire", "factor": 6, "basis": "qty", "pack": 1},
            {"id": "p3", "material": "demo-conduit", "factor": 3, "basis": "qty", "pack": 3},
            {"id": "p4", "material": "demo-labour", "factor": 0.5, "basis": "qty", "pack": 1},
        ]},
    ]
    p["settings"] = {"currency": "₱", "markup": 12, "overhead": 8, "contingency": 3, "tax": 12,
                     "companyName": "ACME Electrical Works", "companyContact": "0917 555 0100 · acme@example.com",
                     "clientName": "Sample Client", "projectAddress": "Level 3, Demo Tower",
                     "terms": "Sample project. This proposal is based on the demo plans. Valid for 30 days."}
    store.save(pid, p)
    return store.load(pid)
