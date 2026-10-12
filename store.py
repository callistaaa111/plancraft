"""Project storage: one folder per project holding project.json, the page images and backups."""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

SCHEMA = 1
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
IMAGE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.png$")
BACKUP_EVERY_S = 600
BACKUPS_KEPT = 30

DEFAULT_SETTINGS = {"allowance": {"linear": 20, "area": 0, "count": 0}}


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def new_id(prefix: str = "") -> str:
    return prefix + secrets.token_hex(4)


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s[:40].strip("-") or "project"


def new_project(pid: str, name: str, units: str = "metric") -> dict:
    t = now_iso()
    return {
        "schema": SCHEMA, "id": pid, "name": name or "Untitled", "units": units if units in ("metric", "imperial") else "metric",
        "created": t, "modified": t, "settings": json.loads(json.dumps(DEFAULT_SETTINGS)),
        "pages": [], "tree": [],
    }


def _write_json_atomic(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


class Store:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.projects = self.root / "projects"
        self.trash = self.root / "trash"
        self.projects.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    # ---- paths --------------------------------------------------------------------------------------
    def project_dir(self, pid: str, must_exist: bool = True) -> Path:
        if not isinstance(pid, str) or not ID_RE.match(pid):
            raise KeyError(pid)
        d = self.projects / pid
        if must_exist and not (d / "project.json").is_file():
            raise KeyError(pid)
        return d

    def pages_dir(self, pid: str) -> Path:
        d = self.project_dir(pid) / "pages"
        d.mkdir(exist_ok=True)
        return d

    def image_path(self, pid: str, filename: str) -> Path:
        if not IMAGE_RE.match(filename or ""):
            raise KeyError(filename)
        return self.project_dir(pid) / "pages" / filename

    # ---- projects -----------------------------------------------------------------------------------
    def list(self) -> list[dict]:
        out = []
        for d in self.projects.iterdir():
            f = d / "project.json"
            if not f.is_file():
                continue
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            items = sections = 0
            stack = list(p.get("tree") or [])
            while stack:
                n = stack.pop()
                if n.get("kind") == "folder":
                    stack.extend(n.get("children") or [])
                else:
                    items += 1
                    sections += len(n.get("sections") or [])
            out.append({"id": d.name, "name": p.get("name") or d.name, "units": p.get("units"),
                        "pages": len(p.get("pages") or []), "items": items, "sections": sections,
                        "modified": p.get("modified") or "", "created": p.get("created") or "",
                        "thumb": (p.get("pages") or [{}])[0].get("image")})
        out.sort(key=lambda r: r["modified"], reverse=True)
        return out

    def allocate(self, name: str) -> str:
        """Reserve a new project folder and return its id."""
        with self._lock:
            while True:
                pid = f"{slug(name)}-{secrets.token_hex(3)}"
                d = self.projects / pid
                if not d.exists():
                    (d / "pages").mkdir(parents=True)
                    return pid

    def create(self, name: str, units: str = "metric") -> dict:
        pid = self.allocate(name)
        p = new_project(pid, name, units)
        _write_json_atomic(self.projects / pid / "project.json", p)
        return p

    def load(self, pid: str) -> dict:
        d = self.project_dir(pid)
        return json.loads((d / "project.json").read_text(encoding="utf-8"))

    def save(self, pid: str, project: dict, write_new: bool = False) -> dict:
        if not isinstance(project, dict) or not isinstance(project.get("pages"), list) \
                or not isinstance(project.get("tree"), list):
            raise ValueError("Not a PlanCraft project.")
        d = self.project_dir(pid, must_exist=not write_new)
        project["id"] = pid
        project["schema"] = SCHEMA
        project["modified"] = now_iso()
        with self._lock:
            f = d / "project.json"
            if f.is_file():
                self._backup(d, f)
            _write_json_atomic(f, project)
        return {"modified": project["modified"]}

    def _backup(self, d: Path, f: Path) -> None:
        bdir = d / "backups"
        bdir.mkdir(exist_ok=True)
        existing = sorted(bdir.glob("*.json"))
        if existing and time.time() - existing[-1].stat().st_mtime < BACKUP_EVERY_S:
            return
        shutil.copy2(f, bdir / f"{datetime.now():%Y%m%d-%H%M%S}.json")
        for old in existing[:max(0, len(existing) + 1 - BACKUPS_KEPT)]:
            old.unlink(missing_ok=True)

    def delete(self, pid: str) -> None:
        d = self.project_dir(pid)
        self.trash.mkdir(parents=True, exist_ok=True)
        shutil.move(str(d), str(self.trash / f"{pid}-{datetime.now():%Y%m%d-%H%M%S}"))

    def thumbnail(self, pid: str) -> Path:
        """Small JPEG of the first page for the projects screen, made once per first page."""
        project = self.load(pid)
        first = (project.get("pages") or [{}])[0].get("image")
        if not first:
            raise KeyError("no pages")
        d = self.project_dir(pid)
        thumb = d / f"thumb-{Path(first).stem}.jpg"
        if not thumb.is_file():
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = 400_000_000
            with Image.open(self.image_path(pid, first)) as im:
                im.draft("RGB", (640, 480))
                im = im.convert("RGB")
                im.thumbnail((640, 480))
                tmp = thumb.with_suffix(".tmp")
                im.save(tmp, "JPEG", quality=80)
                os.replace(tmp, thumb)
            for old in d.glob("thumb-*.jpg"):
                if old != thumb:
                    old.unlink(missing_ok=True)
        return thumb

    def prune_images(self, pid: str, project: dict) -> int:
        """Remove page images no page refers to (left by deleted pages or unfinished imports)."""
        used = {p.get("image") for p in project.get("pages") or []}
        removed = 0
        pdir = self.project_dir(pid) / "pages"
        if not pdir.is_dir():
            return 0
        cutoff = time.time() - 3600   # never touch files an import may still be handing over
        for f in pdir.glob("*.png"):
            if f.name not in used and f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
                removed += 1
        return removed
