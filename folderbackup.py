"""Optional folder backup: copy the data folder to a folder the user picks (OneDrive, a USB drive), changed files only.

Nothing is ever deleted from the backup folder, so a project deleted or broken here is still there.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path

from store import _write_json_atomic, now_iso

CONFIG = "backup.json"            # in the data folder: {"folder": ..., "last": {...}}
LAST = "last-backup.json"         # in the backup folder: when and from where it was made
SKIP_DIRS = {"trash", "cache", "exports"}      # deleted projects and files PlanCraft can rebuild
SKIP_FILES = {"plancraft.log", CONFIG}
EVERY_S = 1800
_lock = threading.Lock()


def config(root: Path) -> dict:
    try:
        return json.loads((Path(root) / CONFIG).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def check_folder(root: Path, folder: str) -> Path:
    dest = Path(folder or "").expanduser()
    if not dest.is_absolute():
        raise ValueError("Type the full path of the backup folder, e.g. C:\\Users\\you\\OneDrive\\PlanCraft backup.")
    if not dest.is_dir():
        raise ValueError(f"The folder {dest} does not exist (is the drive plugged in?).")
    dest, src = dest.resolve(), Path(root).resolve()
    if dest == src or dest.is_relative_to(src):
        raise ValueError("Pick a folder outside PlanCraft's own data folder.")
    return dest


def set_folder(root: Path, folder: str) -> dict:
    """Turn the backup on (a folder) or off (empty)."""
    cfg = config(root)
    cfg["folder"] = str(check_folder(root, folder)) if (folder or "").strip() else ""
    _write_json_atomic(Path(root) / CONFIG, cfg)
    return cfg


def run(task, root: Path) -> dict:
    """Copy every new or changed file. task.progress() gets the running count (task may be None)."""
    root = Path(root)
    cfg = config(root)
    if not cfg.get("folder"):
        raise ValueError("Choose a backup folder first.")
    dest = check_folder(root, cfg["folder"])
    if not _lock.acquire(blocking=False):
        raise ValueError("A backup is already running.")
    try:
        files = copied = size = 0
        for dirpath, dirnames, filenames in os.walk(root):
            rel = Path(dirpath).relative_to(root)
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                if (not rel.parts and name in SKIP_FILES) or name.endswith((".tmp", ".part")):
                    continue
                src, out = Path(dirpath) / name, dest / rel / name
                try:
                    s = src.stat()
                except FileNotFoundError:          # removed while we walked (a pruned image, a rotated backup)
                    continue
                files += 1
                # 2 s slack: OneDrive and FAT drives keep coarser times; copy2 keeps the source time
                if out.is_file() and out.stat().st_size == s.st_size and abs(out.stat().st_mtime - s.st_mtime) < 2:
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                part = out.with_name(name + ".part")
                shutil.copy2(src, part)
                os.replace(part, out)          # a cut-off copy never replaces a good one
                copied += 1
                size += s.st_size
                if task:
                    task.progress(copied, 0, f"Copied {copied} file(s)...")
        last = {"at": now_iso(), "files": files, "copied": copied, "bytes": size}
        _write_json_atomic(dest / LAST, {**last, "from": str(root)})
        cfg = config(root)
        cfg["last"] = last
        cfg.pop("error", None)
        _write_json_atomic(root / CONFIG, cfg)
        return last
    finally:
        _lock.release()


def auto(root: Path) -> None:
    """Background loop: back up every EVERY_S while a folder is set. A failure is kept for the Storage screen."""
    while True:
        time.sleep(60)
        if config(root).get("folder"):
            try:
                run(None, root)
            except Exception as exc:  # drive unplugged, disk full: show it, try again next time
                cfg = config(root)
                cfg["error"] = {"at": now_iso(), "message": str(exc)}
                _write_json_atomic(Path(root) / CONFIG, cfg)
        time.sleep(EVERY_S - 60)
