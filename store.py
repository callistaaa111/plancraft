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

from measure import UNITS

SCHEMA = 1
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
IMAGE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.png$")
BACKUP_RE = re.compile(r"^\d{8}-\d{6}(-[a-z-]+)?\.json$")
BACKUP_EVERY_S = 600
BACKUPS_KEPT = 30

DEFAULT_SETTINGS = {"allowance": {"linear": 20, "area": 0, "count": 0}, "currency": "₱", "markup": 0}


class Conflict(Exception):
    """The project on disk changed since the browser loaded it (another window saved it)."""


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
        "schema": SCHEMA, "id": pid, "name": name or "Untitled", "units": units if units in UNITS else "m",
        "created": t, "modified": t, "settings": json.loads(json.dumps(DEFAULT_SETTINGS)),
        "pages": [], "tree": [], "marks": [], "materials": [], "assemblies": [],
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

    def cache_dir(self, pid: str) -> Path:
        return self.project_dir(pid) / "cache"

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

    def save(self, pid: str, project: dict, write_new: bool = False, expect: str | None = None) -> dict:
        """expect: the 'modified' the browser last loaded or saved; refuse if the file has changed since."""
        if not isinstance(project, dict) or not isinstance(project.get("pages"), list) \
                or not isinstance(project.get("tree"), list):
            raise ValueError("Not a PlanCraft project.")
        d = self.project_dir(pid, must_exist=not write_new)
        with self._lock:
            f = d / "project.json"
            if expect and f.is_file() and json.loads(f.read_text(encoding="utf-8")).get("modified") != expect:
                raise Conflict("This project was changed in another PlanCraft window, so this window's changes "
                               "were not saved. Reload (F5) to get the latest version.")
            project["id"] = pid
            project["schema"] = SCHEMA
            project["modified"] = datetime.now().isoformat(timespec="milliseconds")   # two saves in a second differ
            if f.is_file():
                self._backup(d, f)
            _write_json_atomic(f, project)
        return {"modified": project["modified"]}

    def _backup(self, d: Path, f: Path, force: bool = False, tag: str = "") -> None:
        """Keep a copy of the project as it was, at most every BACKUP_EVERY_S (unless forced)."""
        bdir = d / "backups"
        bdir.mkdir(exist_ok=True)
        existing = sorted(bdir.glob("*.json"))
        if not force and existing and time.time() - existing[-1].stat().st_mtime < BACKUP_EVERY_S:
            return
        shutil.copyfile(f, bdir / f"{datetime.now():%Y%m%d-%H%M%S}{tag}.json")   # copyfile: the backup gets today's time
        for old in existing[:max(0, len(existing) + 1 - BACKUPS_KEPT)]:
            old.unlink(missing_ok=True)

    def backups(self, pid: str) -> list[dict]:
        bdir = self.project_dir(pid) / "backups"
        out = []
        for f in sorted(bdir.glob("*.json"), reverse=True) if bdir.is_dir() else []:
            if not BACKUP_RE.match(f.name):
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
            out.append({"name": f.name, "at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="seconds"),
                        "saved": p.get("modified") or "", "pages": len(p.get("pages") or []), "items": items,
                        "sections": sections, "beforeRestore": "-before-restore" in f.name})
        return out

    def restore(self, pid: str, name: str) -> dict:
        """Put a backup back as the project (the current version is backed up first)."""
        if not BACKUP_RE.match(name or ""):
            raise KeyError(name)
        d = self.project_dir(pid)
        src = d / "backups" / name
        project = json.loads(src.read_text(encoding="utf-8"))
        with self._lock:
            self._backup(d, d / "project.json", force=True, tag="-before-restore")
        self.save(pid, project)
        return self.load(pid)

    def duplicate(self, pid: str, name: str | None = None) -> dict:
        """Copy a project (pages, sources and project.json, no backups/exports) into a new project."""
        src = self.load(pid)
        new_name = (name or f"{src.get('name') or 'Project'} (copy)").strip() or "Project (copy)"
        new_pid = self.allocate(new_name)
        dest = self.project_dir(new_pid, must_exist=False)
        shutil.copytree(self.project_dir(pid), dest, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("backups", "cache", "exports"))
        src["id"] = new_pid
        src["name"] = new_name
        src["created"] = now_iso()
        src["modified"] = now_iso()
        src["duplicatedFrom"] = pid
        _write_json_atomic(dest / "project.json", src)
        return self.load(new_pid)

    def storage(self) -> dict:
        """Sizes for the Storage screen. Walks the data folder; a 1 GB project set takes a moment."""
        def size(path: Path) -> int:
            if not path.exists():
                return 0
            return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())

        projects = self.projects if self.projects.is_dir() else None
        return {"path": str(self.root), "projects": size(projects) if projects else 0, "trash": size(self.trash),
                "templates": size(self.root / "templates"), "total": size(self.root),
                "projectCount": len(list(self.projects.iterdir())) if self.projects.is_dir() else 0,
                "trashCount": len(list(self.trash.iterdir())) if self.trash.is_dir() else 0}

    def empty_trash(self) -> dict:
        freed = 0
        if self.trash.is_dir():
            for item in list(self.trash.iterdir()):
                freed += sum(f.stat().st_size for f in item.rglob("*") if f.is_file()) if item.is_dir() else item.stat().st_size
                if item.is_dir():
                    shutil.rmtree(item, ignore_errors=True)
                else:
                    item.unlink(missing_ok=True)
        return {"ok": True, "freed": freed}

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

    def page_thumbnail(self, pid: str, image: str) -> Path:
        """Small JPEG for the page list, cached in the project's cache folder."""
        src = self.image_path(pid, image)
        if not src.is_file():
            raise KeyError(image)
        d = self.cache_dir(pid)
        d.mkdir(parents=True, exist_ok=True)
        out = d / f"thumb-{src.stem}.jpg"
        if out.is_file() and out.stat().st_mtime >= src.stat().st_mtime:
            return out
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 400_000_000
        with Image.open(src) as im:
            im.draft("RGB", (320, 240))
            im = im.convert("RGB")
            im.thumbnail((180, 140))
            tmp = out.with_suffix(".tmp")
            im.save(tmp, "JPEG", quality=75)
            os.replace(tmp, out)
        return out

    def prune_images(self, pid: str, project: dict) -> int:
        """Remove page images no page refers to (left by deleted pages or unfinished imports)."""
        used = {p.get("image") for p in project.get("pages") or []}
        pdir = self.project_dir(pid) / "pages"
        if not pdir.is_dir():
            return 0
        cutoff = time.time() - 3600   # never touch files an import may still be handing over
        unused = [f for f in pdir.glob("*.png") if f.name not in used and f.stat().st_mtime < cutoff]
        if unused:   # a backup may still show that page: restoring it must find its image
            for b in (self.project_dir(pid) / "backups").glob("*.json"):
                try:
                    used.update(re.findall(r'"image":\s*"([^"]+)"', b.read_text(encoding="utf-8")))
                except OSError:
                    pass
        removed = 0
        for f in unused:
            if f.name not in used:
                f.unlink(missing_ok=True)
                removed += 1
        return removed
