"""Fail if the repository contains client documents, secrets or obvious personal data.

Run from a checkout:  python scripts/privacy_scan.py
Exit code 0 = clean, 1 = a tracked file or history entry needs attention.
The scan only prints paths and line numbers; it never prints the value of a suspected secret.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Documents that must never be committed: plans, estimates, price lists, job archives.
FORBIDDEN = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".dwg", ".dxf", ".swiftjob",
    ".tif", ".tiff", ".zip", ".7z", ".rar", ".log",
}
# Binary files that are legitimate in this repository.
ALLOWED_BINARY = {
    "PlanCraft.ico",
    "docs/screenshots/plan-with-takeoff.png",
}
MAX_SCAN_BYTES = 2 * 1024 * 1024
MAX_TRACKED_BYTES = 5 * 1024 * 1024

SECRET_PATTERNS = [
    ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("GitHub token", re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}")),
    ("GitHub fine-grained token", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("OpenAI-style key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("Slack token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("Google API key", re.compile(r"AIza[0-9A-Za-z_-]{35}")),
    ("Private key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
]
# Values that are obviously placeholders, not real credentials.
PLACEHOLDER = re.compile(r"(?i)example|dummy|fake|placeholder|your[_-]?token|xxx+")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?:\+63|0)9\d{9}")


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], check=True, capture_output=True, text=True).stdout


def tracked_files() -> list[str]:
    return [p for p in git("ls-files", "-z").split("\0") if p]


def history_paths() -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(ROOT), "log", "--all", "--pretty=format:", "--name-only", "--diff-filter=A"],
        check=True, capture_output=True, text=True,
    ).stdout
    return sorted({p for p in out.splitlines() if p.strip()})


def large_history_objects() -> list[tuple[str, int]]:
    """(path, bytes) for blobs over the size limit anywhere in history."""
    revs = subprocess.run(
        ["git", "-C", str(ROOT), "rev-list", "--objects", "--all"],
        check=True, capture_output=True, text=True,
    ).stdout.splitlines()
    if not revs:
        return []
    proc = subprocess.run(
        ["git", "-C", str(ROOT), "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize) %(rest)"],
        input="\n".join(revs) + "\n", check=True, capture_output=True, text=True,
    )
    found = []
    for line in proc.stdout.splitlines():
        parts = line.split(" ", 3)
        if len(parts) == 4 and parts[1] == "blob":
            size = int(parts[2])
            path = parts[3]
            if size > MAX_TRACKED_BYTES:
                found.append((path, size))
    return sorted(found, key=lambda x: x[1], reverse=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="machine-readable report")
    args = ap.parse_args()

    files = tracked_files()
    report: dict = {
        "tracked_files": len(files),
        "forbidden_documents": [],
        "large_tracked_files": [],
        "history_documents": [],
        "large_history_objects": [],
        "secrets": [],
        "emails": [],
        "phones": [],
        "data_folder": None,
        "result": "pass",
    }

    for name in files:
        path = ROOT / name
        suffix = path.suffix.lower()
        if suffix in FORBIDDEN or name.startswith("data/") or name.startswith("backups/"):
            report["forbidden_documents"].append(name)
        if suffix in {".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp"} and name not in ALLOWED_BINARY:
            report["forbidden_documents"].append(name)
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size > MAX_TRACKED_BYTES:
            report["large_tracked_files"].append({"path": name, "bytes": size})

    for name in history_paths():
        suffix = Path(name).suffix.lower()
        if name.startswith("data/") or name.startswith("backups/") or suffix in FORBIDDEN:
            report["history_documents"].append(name)

    report["large_history_objects"] = [{"path": p, "bytes": n} for p, n in large_history_objects()]

    for name in files:
        path = ROOT / name
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        if b"\0" in raw[:4096] or len(raw) > MAX_SCAN_BYTES:
            continue
        text = raw.decode("utf-8", errors="ignore")
        for i, line in enumerate(text.splitlines(), 1):
            for label, pattern in SECRET_PATTERNS:
                if pattern.search(line) and not PLACEHOLDER.search(line):
                    report["secrets"].append({"path": name, "line": i, "kind": label})
            for m in EMAIL.finditer(line):
                value = m.group(0)
                if value.lower().endswith("@users.noreply.github.com") or "example." in value.lower():
                    continue
                report["emails"].append({"path": name, "line": i})
            if PHONE.search(line):
                report["phones"].append({"path": name, "line": i})

    data = ROOT / "data"
    if data.exists():
        ignored = subprocess.run(["git", "-C", str(ROOT), "check-ignore", "-q", "data"], capture_output=True).returncode == 0
        count = sum(1 for p in data.rglob("*") if p.is_file())
        size = sum(p.stat().st_size for p in data.rglob("*") if p.is_file())
        report["data_folder"] = {"present": True, "ignored": ignored, "files": count, "bytes": size}
        if not ignored:
            report["forbidden_documents"].append("data/ (not ignored)")
    else:
        report["data_folder"] = {"present": False, "ignored": True, "files": 0, "bytes": 0}

    failed = bool(report["forbidden_documents"] or report["history_documents"] or report["secrets"]
                 or report["large_tracked_files"] or report["large_history_objects"])
    report["result"] = "fail" if failed else "pass"

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("PlanCraft privacy scan")
        print(f"  tracked files: {report['tracked_files']}")
        print(f"  forbidden documents: {len(report['forbidden_documents'])}")
        for name in report["forbidden_documents"]:
            print(f"    - {name}")
        print(f"  large tracked files (>5 MB): {len(report['large_tracked_files'])}")
        for item in report["large_tracked_files"]:
            print(f"    - {item['path']} ({item['bytes']} bytes)")
        print(f"  documents in git history: {len(report['history_documents'])}")
        for name in report["history_documents"][:20]:
            print(f"    - {name}")
        print(f"  large blobs in history: {len(report['large_history_objects'])}")
        for item in report["large_history_objects"][:10]:
            print(f"    - {item['path']} ({item['bytes']} bytes)")
        print(f"  secrets: {len(report['secrets'])}")
        for item in report["secrets"]:
            print(f"    - {item['kind']} at {item['path']}:{item['line']}")
        print(f"  emails outside noreply/example: {len(report['emails'])}")
        for item in report["emails"]:
            print(f"    - {item['path']}:{item['line']}")
        print(f"  phone-number patterns: {len(report['phones'])}")
        for item in report["phones"]:
            print(f"    - {item['path']}:{item['line']}")
        d = report["data_folder"]
        print(f"  data folder: present={d['present']} ignored={d['ignored']} files={d['files']} bytes={d['bytes']}")
        print(f"RESULT: {report['result'].upper()}")
    return 0 if report["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
