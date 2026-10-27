"""Project symbol library: save a boxed symbol once and count it on other pages."""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime
from pathlib import Path

import vision

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
MAX = 700


def _dir(store, pid: str) -> Path:
    d = store.project_dir(pid) / "symbols"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _path(store, pid: str, sid: str) -> Path:
    if not ID_RE.match(sid or ""):
        raise KeyError(sid)
    return _dir(store, pid) / f"{sid}.json"


def save(store, pid: str, name: str, image: str, rect) -> dict:
    from PIL import Image
    src = store.image_path(pid, image)
    if not src.is_file():
        raise KeyError(image)
    x, y, w, h = (float(v) for v in rect)
    if w < 4 or h < 4 or max(w, h) > MAX:
        raise ValueError("Draw a tight box around one symbol (at most 700 px).")
    Image.MAX_IMAGE_PIXELS = 400_000_000
    sid = "sym-" + secrets.token_hex(4)
    with Image.open(src) as im:
        crop = im.convert("L").crop((round(x), round(y), round(x + w), round(y + h)))
        out = _dir(store, pid) / f"{sid}.png"
        crop.save(out, "PNG")
    meta = {"id": sid, "name": (name or "Symbol").strip()[:80] or "Symbol", "width": round(w),
            "height": round(h), "method": "shape", "image": image,
            "created": datetime.now().isoformat(timespec="seconds")}
    _path(store, pid, sid).write_text(json.dumps(meta), encoding="utf-8")
    return meta


def list_symbols(store, pid: str) -> list[dict]:
    out = []
    for f in sorted(_dir(store, pid).glob("*.json")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    return out


def delete(store, pid: str, sid: str) -> dict:
    _path(store, pid, sid).unlink(missing_ok=True)
    (_dir(store, pid) / f"{sid}.png").unlink(missing_ok=True)
    return {"ok": True}


def count(store, pid: str, sid: str, pages: list[str]) -> dict:
    meta = json.loads(_path(store, pid, sid).read_text(encoding="utf-8"))
    tpl = _dir(store, pid) / f"{sid}.png"
    project = store.load(pid)
    by_id = {p["id"]: p for p in project.get("pages") or []}
    results = []
    for page_id in pages:
        page = by_id.get(page_id)
        if not page:
            continue
        try:
            r = vision.find_template(store.image_path(pid, page["image"]), tpl, min_score=0.4)
        except Exception as exc:  # report per page instead of failing the whole batch
            results.append({"pageId": page_id, "pageName": page.get("name"), "error": str(exc), "matches": []})
            continue
        results.append({"pageId": page_id, "pageName": page.get("name"), "matches": r["matches"],
                        "size": r["size"]})
    return {"symbol": meta, "pages": results, "total": sum(len(r["matches"]) for r in results)}
