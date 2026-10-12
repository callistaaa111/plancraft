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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))

import importers  # noqa: E402
import tasks  # noqa: E402
from store import Store  # noqa: E402

WEB_DIR = APP_DIR / "web"
DEFAULT_PORT = 8791
MAX_JSON = 300 * 1024 * 1024
CHUNK = 1024 * 1024

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


class Api(BaseHTTPRequestHandler):
    server_version = "PlanCraft/1.0"
    store: Store = None  # set in main()

    # ---- plumbing -----------------------------------------------------------------------------------
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
        try:
            if path.startswith("/api/"):
                return self.api(method, path[5:], q)
            if method == "GET":
                return self.static(path)
            return self.fail(405, "Method not allowed")
        except KeyError:
            return self.fail(404, "Not found")
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
            return self.send_json({"app": "PlanCraft"})

        if parts == ["projects"]:
            if method == "GET":
                return self.send_json(st.list())
            if method == "POST":
                body = self.read_json()
                name = (body.get("name") or "").strip() or "Untitled"
                return self.send_json(st.create(name, body.get("units") or "metric"), 201)

        if parts[:2] == ["import", "swiftjob"] and method == "POST":
            tmp = self.read_to_temp(".SwiftJob")
            name = (q.get("name") or "").strip() or None
            task = tasks.start("swiftjob", importers.import_swiftjob, tmp, st, name, q.get("filename"),
                               cleanup=lambda: tmp.unlink(missing_ok=True))
            return self.send_json({"task": task.id}, 202)

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
                    return self.send_json(st.save(pid, self.read_json()))
                if method == "DELETE":
                    st.delete(pid)
                    return self.send_json({"ok": True})
            if rest == ["save"] and method == "POST":           # navigator.sendBeacon on page close
                return self.send_json(st.save(pid, self.read_json()))
            if rest == ["thumb.jpg"] and method == "GET":
                return self.send_file(st.thumbnail(pid), cache="no-cache")
            if rest == ["pages", "crop"] and method == "POST":     # new page from an area of a page
                body = self.read_json()
                return self.send_json(importers.crop_page(st.image_path(pid, body.get("image")), st.pages_dir(pid),
                                                          body.get("rect")))
            if rest == ["pages", "copy"] and method == "POST":     # pasted page (maybe from another project)
                body = self.read_json()
                src = st.image_path(body.get("fromProject") or pid, body.get("image"))
                if not src.is_file():
                    raise ValueError("The copied page is no longer there (was it deleted?). Copy it again.")
                return self.send_json(importers.copy_page_image(src, st.pages_dir(pid)))
            if rest[:1] == ["pages"] and len(rest) == 2 and method == "GET":
                return self.send_file(st.image_path(pid, rest[1]), cache="max-age=31536000, immutable")
            if rest == ["import", "pdf"] and method == "POST":
                out = st.pages_dir(pid)
                filename = q.get("filename") or "plan.pdf"
                dpi = max(72.0, min(400.0, float(q.get("dpi") or 200)))
                tmp = self.read_to_temp(".pdf")
                task = tasks.start("pdf", importers.import_pdf, tmp, out, filename, dpi, q.get("pages"),
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
        res = importers.import_pdf(_ConsoleTask(), f, store.pages_dir(pid), f.name, args.dpi)
    else:
        res = importers.import_image(_ConsoleTask(), f, store.pages_dir(pid), f.name)
    project["pages"] = res["pages"]
    store.save(pid, project)
    print(json.dumps({"projectId": pid, "pages": len(res["pages"])}, indent=2))


def already_running(port) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1) as r:
            return json.loads(r.read()).get("app") == "PlanCraft"
    except Exception:
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description="PlanCraft takeoff app")
    ap.add_argument("command", nargs="?", default="serve", choices=["serve", "import"])
    ap.add_argument("file", nargs="?")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PLANCRAFT_PORT", DEFAULT_PORT)))
    ap.add_argument("--data", default=os.environ.get("PLANCRAFT_DATA", str(APP_DIR / "data")))
    ap.add_argument("--open", action="store_true", help="open the app in the browser")
    ap.add_argument("--name")
    ap.add_argument("--dpi", type=float, default=200)
    args = ap.parse_args(argv)

    store = Store(args.data)
    if args.command == "import":
        if not args.file:
            ap.error("import needs a file")
        return cli_import(args, store)

    url = f"http://127.0.0.1:{args.port}/"
    if already_running(args.port):
        print(f"PlanCraft is already running at {url}")
        if args.open:
            webbrowser.open(url)
        return
    Api.store = store
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Api)
    httpd.daemon_threads = True
    print(f"PlanCraft is running at {url}  (projects in {store.root})")
    print("Keep this window open while you work. Press Ctrl+C to stop.")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
