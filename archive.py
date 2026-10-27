"""Portable project archives: one .zip with project.json, page images and source PDFs.

The archive is deliberately simple: no database, no absolute paths and no backups. Import always creates a new project,
so it cannot overwrite work that is already open.
"""
from __future__ import annotations

import io
import json
import shutil
import zipfile
from pathlib import Path

FORMAT = "plancraft-archive"
VERSION = 1
MAX_FILES = 20_000
MAX_TOTAL = 2 * 1024 ** 3          # 2 GB uncompressed
CHUNK = 1024 * 1024


def export_project(store, pid: str) -> bytes:
    d = store.project_dir(pid)
    project = store.load(pid)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.writestr("archive.json", json.dumps({"format": FORMAT, "version": VERSION, "project": pid}, indent=2))
        z.writestr("project.json", json.dumps(project, ensure_ascii=False, separators=(",", ":")))
        for sub in ("pages", "sources"):
            folder = d / sub
            if not folder.is_dir():
                continue
            for f in sorted(folder.rglob("*")):
                if f.is_file() and not f.name.endswith(".tmp"):
                    z.write(f, f"{sub}/{f.relative_to(folder).as_posix()}")
    return buf.getvalue()


def _safe_members(z: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    infos = z.infolist()
    if len(infos) > MAX_FILES:
        raise ValueError("That archive has too many files.")
    total = sum(i.file_size for i in infos)
    if total > MAX_TOTAL:
        raise ValueError("That archive is too large when unpacked (over 2 GB).")
    for info in infos:
        name = info.filename.replace("\\", "/")
        parts = Path(name).parts
        if not parts or name.startswith("/") or ".." in parts or ":" in parts[0]:
            raise ValueError("That archive contains an unsafe path.")
        if info.is_dir():
            continue
        if not (name == "project.json" or name == "archive.json" or name.startswith("pages/")
                or name.startswith("sources/")):
            raise ValueError("That archive contains an unexpected file.")
    return infos


def import_project(store, path: Path, name: str | None = None) -> dict:
    with zipfile.ZipFile(path) as z:
        infos = _safe_members(z)
        try:
            data = json.loads(z.read("project.json").decode("utf-8"))
        except (KeyError, ValueError) as exc:
            raise ValueError("That file is not a PlanCraft project archive.") from exc
        if not isinstance(data, dict) or not isinstance(data.get("pages"), list) \
                or not isinstance(data.get("tree"), list):
            raise ValueError("That archive does not contain a PlanCraft project.")

        display = (name or data.get("name") or "Imported project").strip() or "Imported project"
        pid = store.allocate(display)
        d = store.project_dir(pid, must_exist=False)
        try:
            for info in infos:
                n = info.filename.replace("\\", "/")
                if info.is_dir() or n in ("project.json", "archive.json"):
                    continue
                dest = (d / n).resolve()
                if not dest.is_relative_to(d.resolve()):
                    raise ValueError("That archive contains an unsafe path.")
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out, CHUNK)
            images = [p.get("image") for p in data.get("pages") or [] if p.get("image")]
            missing = [img for img in images if not (d / "pages" / img).is_file()]
            if missing:
                raise ValueError(f"The archive is missing {len(missing)} page image(s).")
            data["id"] = pid
            data["name"] = display
            data["importedFrom"] = Path(path).name
            store.save(pid, data, write_new=True)
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise
    return store.load(pid)
