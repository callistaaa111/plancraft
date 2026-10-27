"""PlanCraft: an offline takeoff app (PlanSwift-style) that runs in your browser.

    python server.py [--port 8791] [--data DIR] [--open]
    python server.py import FILE.SwiftJob|FILE.pdf [--name NAME] [--dpi 200] [--data DIR]

Only listens on 127.0.0.1; projects are stored under ./data (or --data).
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

FROZEN = bool(getattr(sys, "frozen", False))

if FROZEN:
    # PyInstaller one-folder build: PlanCraft.exe lives in the install folder; the read-only program files
    # (web/, bundled modules) are unpacked to sys._MEIPASS.
    APP_DIR = Path(sys.executable).resolve().parent
    RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
else:
    APP_DIR = Path(__file__).resolve().parent
    RESOURCE_DIR = APP_DIR
sys.path.insert(0, str(RESOURCE_DIR))

import archive  # noqa: E402
import compare  # noqa: E402
import importers  # noqa: E402
import ocr  # noqa: E402
import quote as quote_pdf  # noqa: E402
import search  # noqa: E402
import symbols  # noqa: E402
import tasks  # noqa: E402
import templates  # noqa: E402
import vision  # noqa: E402
from store import Conflict, Store  # noqa: E402
from version import __version__  # noqa: E402

WEB_DIR = RESOURCE_DIR / "web"
DEFAULT_PORT = 8791
MAX_JSON = 300 * 1024 * 1024
# A newer launch replaces a server still running older code. In a frozen build there are no .py files:
# use the executable's timestamp, which changes with every release.
CODE_STAMP = (int(Path(sys.executable).stat().st_mtime) if FROZEN
              else int(max(f.stat().st_mtime for f in APP_DIR.glob("*.py"))))
CHUNK = 1024 * 1024


def same_origin(port: int, origin: str) -> bool:
    """Is this Origin the local app itself? Handles the omitted default port (http://127.0.0.1 for port 80)."""
    try:
        u = urlparse(origin)
        return u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost") and (u.port or 80) == port
    except ValueError:
        return False


def default_data_dir() -> Path:
    r"""Where projects live. Source checkout: ./data next to server.py. Installed app: %LOCALAPPDATA%\PlanCraft\data
    (survives upgrades and uninstall); a portable copy with portable.txt next to the exe keeps data beside it."""
    env = os.environ.get("PLANCRAFT_DATA")
    if env:
        return Path(env)
    if not FROZEN:
        return APP_DIR / "data"
    if (APP_DIR / "portable.txt").is_file():
        return APP_DIR / "data"
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "PlanCraft" / "data"

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


class Api(BaseHTTPRequestHandler):
    server_version = f"PlanCraft/{__version__}"
    store: Store = None  # set in main()
    last_beat = 0.0      # last heartbeat from an open window (for --idle-exit)
    httpd = None         # set in main(), so /api/quit can stop the server

    # ---- plumbing -----------------------------------------------------------------------------------
    def end_headers(self):
        # Small hardening for a local web app: never let a page sniff a different type, frame PlanCraft, or leak
        # the local URL through Referer.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, fmt, *args):
        if len(args) >= 2 and str(args[1])[:1] in ("4", "5"):     # only log failed requests
            sys.stderr.write("%s\n" % (fmt % args))

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def fail(self, status, message):
        self.send_json({"error": message}, status)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_JSON:
            raise ValueError("Request too large.")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8"))

    def read_to_temp(self, suffix: str) -> Path:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            raise ValueError("No file was sent.")
        fd, name = tempfile.mkstemp(prefix="plancraft-", suffix=suffix)
        left = n
        with os.fdopen(fd, "wb") as fh:
            while left > 0:
                chunk = self.rfile.read(min(CHUNK, left))
                if not chunk:
                    break
                fh.write(chunk)
                left -= len(chunk)
        if left:
            os.unlink(name)
            raise ValueError("The upload was interrupted.")
        return Path(name)

    def route(self, method):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        # only answer to our own address: blocks web pages that point their domain at this PC (DNS rebinding)
        port = self.server.server_address[1]
        if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            return self.fail(403, "Not allowed.")
        # Refuse state changes a different web page tries to make against the local API (CSRF). Same-origin fetches
        # and non-browser clients (no Origin, no Sec-Fetch-Site) still work.
        if method in ("POST", "PUT", "DELETE"):
            origin = self.headers.get("Origin")
            if origin and not same_origin(port, origin):
                return self.fail(403, "Cross-site request refused.")
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                return self.fail(403, "Cross-site request refused.")
        try:
            if path.startswith("/api/"):
                return self.api(method, path[5:], q)
            if method == "GET":
                return self.static(path)
            return self.fail(405, "Method not allowed")
        except KeyError:
            return self.fail(404, "Not found")
        except Conflict as exc:
            return self.fail(409, str(exc))
        except ValueError as exc:
            return self.fail(400, str(exc))
        except (ConnectionError, BrokenPipeError):
            return None
        except Exception as exc:  # keep the server alive, tell the browser
            import traceback
            traceback.print_exc()
            return self.fail(500, f"{exc.__class__.__name__}: {exc}")

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    # ---- static files -------------------------------------------------------------------------------
    def static(self, path):
        rel = path.lstrip("/") or "index.html"
        f = (WEB_DIR / rel).resolve()
        if not f.is_relative_to(WEB_DIR) or not f.is_file():
            f = WEB_DIR / "index.html" if "." not in rel.rsplit("/", 1)[-1] else None
            if f is None:
                return self.fail(404, "Not found")
        self.send_file(f, cache="no-cache")

    def send_file(self, f: Path, cache="no-cache", download_name=None):
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        size = f.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", cache)
        if download_name:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(download_name)}")
        self.end_headers()
        with open(f, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile, CHUNK)

    # ---- API ----------------------------------------------------------------------------------------
    def api(self, method, path, q):
        st = self.store
        parts = [p for p in path.split("/") if p]

        if parts == ["ping"]:
            if q.get("beat"):
                Api.last_beat = time.time()          # an open PlanCraft window says hello
            return self.send_json({"app": "PlanCraft", "code": CODE_STAMP, "version": __version__,
                                   "frozen": FROZEN, "ocr": ocr.available()})

        if parts == ["quit"] and method == "POST":
            # only PlanCraft's own launcher sends this header (a web page cannot without the server allowing it)
            if self.headers.get("X-PlanCraft") != "quit":
                return self.fail(403, "Not allowed.")
            if tasks.busy():
                return self.send_json({"ok": False, "busy": True}, 409)
            threading.Timer(0.2, Api.httpd.shutdown).start()
            return self.send_json({"ok": True})

        if parts == ["storage"] and method == "GET":
            return self.send_json(st.storage())
        if parts == ["trash"] and method == "DELETE":
            return self.send_json(st.empty_trash())

        if parts == ["projects"]:
            if method == "GET":
                return self.send_json(st.list())
            if method == "POST":
                body = self.read_json()
                raw_name = (body.get("name") or "").strip()
                if body.get("template"):
                    return self.send_json(templates.Templates(st).create_project(
                        st, body["template"], raw_name or None, body.get("units")), 201)
                return self.send_json(st.create(raw_name or "Untitled", body.get("units") or "m"), 201)

        if parts == ["templates"]:
            tpl = templates.Templates(st)
            if method == "GET":
                return self.send_json(tpl.list())
            if method == "POST":
                body = self.read_json()
                project_id = body.get("project")
                if not project_id:
                    raise ValueError("Pick a project to save as a template.")
                return self.send_json(tpl.save(st.load(project_id), body.get("name")), 201)
        if parts[:1] == ["templates"] and len(parts) == 2 and method == "DELETE":
            return self.send_json(templates.Templates(st).delete(parts[1]))

        if parts[:2] == ["import", "swiftjob"] and method == "POST":
            tmp = self.read_to_temp(".SwiftJob")
            name = (q.get("name") or "").strip() or None
            task = tasks.start("swiftjob", importers.import_swiftjob, tmp, st, name, q.get("filename"),
                               cleanup=lambda: tmp.unlink(missing_ok=True))
            return self.send_json({"task": task.id}, 202)

        if parts == ["import", "archive"] and method == "POST":     # restore a .zip made by Export archive
            tmp = self.read_to_temp(".zip")
            try:
                name = (q.get("name") or "").strip() or None
                return self.send_json(archive.import_project(st, tmp, name), 201)
            finally:
                tmp.unlink(missing_ok=True)

        if parts == ["pricelist", "parse"] and method == "POST":     # read a supplier price list
            import pricelist
            filename = q.get("filename") or "prices.xlsx"
            tmp = self.read_to_temp(Path(filename).suffix or ".xlsx")
            try:
                return self.send_json(pricelist.parse(tmp, filename))
            finally:
                tmp.unlink(missing_ok=True)

        if parts[:1] == ["tasks"] and len(parts) == 2 and method == "GET":
            t = tasks.get(parts[1])
            if not t:
                raise KeyError(parts[1])
            return self.send_json(t.as_dict())

        if parts[:1] == ["projects"] and len(parts) >= 2:
            pid = parts[1]
            rest = parts[2:]
            if not rest:
                if method == "GET":
                    project = st.load(pid)
                    st.prune_images(pid, project)
                    return self.send_json(project)
                if method == "PUT":
                    body = self.read_json()
                    return self.send_json(st.save(pid, body, expect=body.get("modified")))
                if method == "DELETE":
                    st.delete(pid)
                    return self.send_json({"ok": True})
            if rest == ["save"] and method == "POST":           # navigator.sendBeacon on page close
                body = self.read_json()
                return self.send_json(st.save(pid, body, expect=body.get("modified")))
            if rest == ["backups"] and method == "GET":
                return self.send_json(st.backups(pid))
            if rest == ["restore"] and method == "POST":
                return self.send_json(st.restore(pid, self.read_json().get("name")))
            if rest == ["symbols"]:
                if method == "GET":
                    return self.send_json(symbols.list_symbols(st, pid))
                if method == "POST":
                    body = self.read_json()
                    return self.send_json(symbols.save(st, pid, body.get("name"), body.get("image"),
                                                       body.get("rect")), 201)
            if rest[:1] == ["symbols"] and len(rest) == 3 and rest[2] == "count" and method == "POST":
                body = self.read_json()
                return self.send_json(symbols.count(st, pid, rest[1], body.get("pages") or []))
            if rest[:1] == ["symbols"] and len(rest) == 2 and method == "DELETE":
                return self.send_json(symbols.delete(st, pid, rest[1]))
            if rest == ["ocr"] and method == "POST":
                if not ocr.available():
                    raise ValueError("OCR needs Tesseract. Install it and make sure tesseract.exe is on PATH.")
                project = st.load(pid)
                return self.send_json({"task": tasks.start("ocr", ocr.run, project, st, pid).id}, 202)
            if rest == ["duplicate"] and method == "POST":
                body = self.read_json()
                return self.send_json(st.duplicate(pid, body.get("name")), 201)
            if rest == ["quote.pdf"] and method == "GET":
                project = st.load(pid)
                data = quote_pdf.build(project)
                name = re.sub(r'[\\/:*?"<>|]+', "_", "Quote - " + (project.get("name") or "project"))[:80] + ".pdf"
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return None
            if rest == ["archive"] and method == "GET":
                data = archive.export_project(st, pid)
                project = st.load(pid)
                name = re.sub(r'[\\/:*?"<>|]+', "_", (project.get("name") or "project"))[:60] + ".plancraft.zip"
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return None
            if rest == ["search"] and method == "GET":
                return self.send_json(search.search(st.load(pid), st.project_dir(pid), q.get("q") or ""))
            if rest == ["compare"] and method == "POST":
                body = self.read_json()
                other_id = body.get("other")
                if not other_id or other_id == pid:
                    raise ValueError("Pick another project to compare with.")
                return self.send_json(compare.compare_projects(st.load(pid), st.load(other_id)))
            if rest == ["compare.xlsx"] and method == "POST":
                import export_xlsx
                body = self.read_json()
                other_id = body.get("other")
                if not other_id or other_id == pid:
                    raise ValueError("Pick another project to compare with.")
                report = compare.compare_projects(st.load(pid), st.load(other_id))
                data = export_xlsx.build_compare(report)
                name = re.sub(r'[\\/:*?"<>|]+', "_", (report["old"]["name"] or "old") + " vs " +
                              (report["new"]["name"] or "new"))[:80] + " - revision.xlsx"
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return None
            if rest == ["print"] and method == "POST":              # build a PDF of plan pages (background job)
                import printpdf
                opts = self.read_json()
                project = st.load(pid)
                folder = st.project_dir(pid) / "exports"
                folder.mkdir(exist_ok=True)
                printpdf.clean_exports(folder)
                name = re.sub(r'[\\/:*?"<>|]+', "_", project.get("name") or "plans")[:60]
                out = folder / f"{name} - {time.strftime('%Y%m%d-%H%M%S')}.pdf"
                task = tasks.start("print", printpdf.build, project, st.project_dir(pid), opts, out)
                return self.send_json({"task": task.id}, 202)
            if rest == ["export.swiftjob"] and method == "POST":    # PlanSwift job (background job)
                import export_swiftjob
                import printpdf
                project = st.load(pid)
                folder = st.project_dir(pid) / "exports"
                folder.mkdir(exist_ok=True)
                printpdf.clean_exports(folder)
                name = re.sub(r'[\\/:*?"<>|]+', "_", project.get("name") or "job")[:60]
                out = folder / f"{name} - {time.strftime('%Y%m%d-%H%M%S')}.SwiftJob"
                task = tasks.start("swiftjob", export_swiftjob.build, project, st.project_dir(pid), out)
                return self.send_json({"task": task.id}, 202)
            if rest[:1] == ["exports"] and len(rest) == 2 and method == "GET":
                f = st.project_dir(pid) / "exports" / rest[1]
                if not re.fullmatch(r'[^\\/:*?"<>|]{1,120}\.(pdf|SwiftJob)', rest[1]) or not f.is_file():
                    raise KeyError(rest[1])
                return self.send_file(f, cache="no-store", download_name=rest[1] if q.get("download") else None)
            if rest == ["thumb.jpg"] and method == "GET":
                return self.send_file(st.thumbnail(pid), cache="no-cache")
            if rest == ["pages", "crop"] and method == "POST":     # new page from an area of a page
                body = self.read_json()
                return self.send_json(importers.crop_page(st.image_path(pid, body.get("image")), st.pages_dir(pid),
                                                          body.get("rect")))
            if rest == ["pages", "rotate"] and method == "POST":   # turn a page image (quarter turns, clockwise)
                body = self.read_json()
                return self.send_json(importers.rotate_page(st.image_path(pid, body.get("image")), st.pages_dir(pid),
                                                            body.get("turns")))
            if rest == ["pages", "copy"] and method == "POST":     # pasted page (maybe from another project)
                body = self.read_json()
                src = st.image_path(body.get("fromProject") or pid, body.get("image"))
                if not src.is_file():
                    raise ValueError("The copied page is no longer there (was it deleted?). Copy it again.")
                return self.send_json(importers.copy_page_image(src, st.pages_dir(pid)))
            if rest == ["autocount"] and method == "POST":           # find repeats of a symbol on a page
                body = self.read_json()
                return self.send_json(vision.find_symbols(st.image_path(pid, body.get("image")), body.get("rect"),
                                                          bool(body.get("rotations")), method=body.get("method") or "auto",
                                                          area=body.get("area")))
            if rest[:1] == ["pages"] and len(rest) == 3 and rest[2] == "tint" and method == "GET":   # revision overlay
                out = vision.tinted(st.image_path(pid, rest[1]), q.get("color") or "red", st.cache_dir(pid))
                return self.send_file(out, cache="no-cache")
            if rest[:1] == ["pages"] and len(rest) == 2 and method == "GET":
                return self.send_file(st.image_path(pid, rest[1]), cache="max-age=31536000, immutable")
            if rest == ["import", "pdf"] and method == "POST":
                out = st.pages_dir(pid)
                filename = q.get("filename") or "plan.pdf"
                dpi = max(72.0, min(400.0, float(q.get("dpi") or 200)))
                tmp = self.read_to_temp(".pdf")
                task = tasks.start("pdf", importers.import_pdf, tmp, out, filename, dpi, q.get("pages"),
                                   st.project_dir(pid) / "sources",
                                   cleanup=lambda: tmp.unlink(missing_ok=True))
                return self.send_json({"task": task.id}, 202)
            if rest == ["import", "image"] and method == "POST":
                out = st.pages_dir(pid)
                filename = q.get("filename") or "plan.png"
                tmp = self.read_to_temp(Path(filename).suffix or ".img")
                task = tasks.start("image", importers.import_image, tmp, out, filename,
                                   cleanup=lambda: tmp.unlink(missing_ok=True))
                return self.send_json({"task": task.id}, 202)
            if rest == ["export.xlsx"] and method == "GET":
                import export_xlsx
                project = st.load(pid)
                data = export_xlsx.build(project)
                name = re.sub(r'[\\/:*?"<>|]+', "_", project.get("name") or "takeoff") + " - takeoff.xlsx"
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return None
            if rest == ["export.csv"] and method == "GET":
                import export_csv
                project = st.load(pid)
                data = export_csv.build(project)
                name = re.sub(r'[\\/:*?"<>|]+', "_", project.get("name") or "takeoff") + " - takeoff.csv"
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return None
        raise KeyError(path)


# ---- command line -----------------------------------------------------------------------------------
class _ConsoleTask:
    def __init__(self):
        self.last = 0.0

    def progress(self, done, total, message=None):
        if time.time() - self.last > 0.5 or done == total:
            self.last = time.time()
            print(f"  [{done}/{total}] {message or ''}", flush=True)


def cli_import(args, store: Store):
    f = Path(args.file)
    if not f.is_file():
        sys.exit(f"File not found: {f}")
    ext = f.suffix.lower()
    if ext == ".swiftjob":
        res = importers.import_swiftjob(_ConsoleTask(), f, store, args.name, f.name)
        print(json.dumps(res, indent=2))
        return
    project = store.create(args.name or f.stem)
    pid = project["id"]
    if ext == ".pdf":
        res = importers.import_pdf(_ConsoleTask(), f, store.pages_dir(pid), f.name, args.dpi,
                                   sources_dir=store.project_dir(pid) / "sources")
    else:
        res = importers.import_image(_ConsoleTask(), f, store.pages_dir(pid), f.name)
    project["pages"] = res["pages"]
    store.save(pid, project)
    print(json.dumps({"projectId": pid, "pages": len(res["pages"])}, indent=2))


def open_window(url: str, app: bool) -> None:
    """Open PlanCraft: in its own Edge / Chrome app window (no tabs or address bar) when asked, else a browser tab."""
    if app and sys.platform == "win32":
        import subprocess
        roots = [os.environ.get(k, "") for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
        for exe in (r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe"):
            for r in roots:
                path = Path(r) / exe
                if r and path.is_file():
                    subprocess.Popen([str(path), f"--app={url}"], close_fds=True)
                    return
    webbrowser.open(url)


def quiet_console(data_dir: str) -> None:
    """Started without a console (the installed app, pythonw, a desktop shortcut): send output and errors to
    data/plancraft.log. The frozen build always logs, because a windowed app has no console and a startup error
    would otherwise disappear."""
    if not FROZEN and sys.stdout is not None and sys.stderr is not None:
        return
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    log = open(Path(data_dir) / "plancraft.log", "a", encoding="utf-8", buffering=1)
    log.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} PlanCraft {__version__} starting ---\n")
    if FROZEN:
        sys.stdout = log
        sys.stderr = log
    else:
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log


def running_server(port) -> dict | None:
    """The ping reply of a PlanCraft server already on this port, or None."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1) as r:
            info = json.loads(r.read())
            return info if info.get("app") == "PlanCraft" else None
    except Exception:
        return None


def already_running(port) -> bool:
    return running_server(port) is not None


def replace_old_server(port, info) -> bool:
    """Stop a server that runs older program files (after an update). True when the port is free again."""
    if info.get("code", 0) >= CODE_STAMP - 1:
        return False
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/quit", data=b"{}", method="POST",
                                 headers={"X-PlanCraft": "quit", "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=3).close()
    except Exception:
        return False                       # too old to know /api/quit, or busy with an import / export
    for _ in range(50):
        time.sleep(0.1)
        if not already_running(port):
            time.sleep(0.3)                # let the socket close
            return True
    return False


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if FROZEN and not argv:
        # Double-clicking PlanCraft.exe: open the app window and stop the server about 10 minutes after it closes.
        argv = ["--open", "--app", "--idle-exit", "600"]
    ap = argparse.ArgumentParser(description="PlanCraft takeoff app")
    ap.add_argument("command", nargs="?", default="serve", choices=["serve", "import"])
    ap.add_argument("file", nargs="?")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PLANCRAFT_PORT", DEFAULT_PORT)))
    ap.add_argument("--version", action="version", version=f"PlanCraft {__version__}")
    ap.add_argument("--data", default=str(default_data_dir()))
    ap.add_argument("--open", action="store_true", help="open the app in the browser")
    ap.add_argument("--app", action="store_true", help="open it in its own app window (Edge or Chrome)")
    ap.add_argument("--idle-exit", type=int, default=0, metavar="SECONDS",
                    help="stop when no PlanCraft window has been open for this long (for the desktop shortcut)")
    ap.add_argument("--name")
    ap.add_argument("--dpi", type=float, default=200)
    args = ap.parse_args(argv)

    quiet_console(args.data)
    store = Store(args.data)
    if args.command == "import":
        if not args.file:
            ap.error("import needs a file")
        return cli_import(args, store)

    url = f"http://127.0.0.1:{args.port}/"
    info = running_server(args.port)
    if info and replace_old_server(args.port, info):
        print("Stopped an older PlanCraft server that was still running: starting the updated one.")
        info = None
    if info:
        print(f"PlanCraft is already running at {url}")
        if args.open:
            open_window(url, args.app)
        return
    Api.store = store
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Api)
    httpd.daemon_threads = True
    Api.httpd = httpd
    print(f"PlanCraft {__version__} ({'installed' if FROZEN else 'source'}) is running at {url}  (projects in {store.root})")
    print("Keep this window open while you work. Press Ctrl+C to stop.")
    if args.open:
        threading.Timer(0.6, lambda: open_window(url, args.app)).start()
    if args.idle_exit:
        def watch():
            # open windows send a heartbeat every 30 s; once none has for idle_exit seconds, stop
            Api.last_beat = time.time() + 60          # give the window time to open
            while True:
                time.sleep(15)
                if time.time() - Api.last_beat > args.idle_exit and not tasks.busy():
                    print("No PlanCraft window open any more: stopping.", flush=True)
                    httpd.shutdown()
                    return
        threading.Thread(target=watch, daemon=True, name="idle-exit").start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
