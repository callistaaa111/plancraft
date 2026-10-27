"""Search a project: page names, items, notes and the text of PDF pages (no OCR)."""
from __future__ import annotations

from pathlib import Path

from compare import _walk

MAX_RESULTS = 200
MAX_TEXT = 200_000


def _fitz():
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    return fitz


def _page_text(project_dir: Path, page: dict) -> str:
    """The PDF's own text layer (full length), else text stored on the page (OCR, or older projects)."""
    return _pdf_text(project_dir, page) or page.get("text") or ""


def _pdf_text(project_dir: Path, page: dict) -> str:
    src = page.get("src") or {}
    if not src.get("file"):
        return ""
    path = Path(project_dir) / "sources" / src["file"]
    if not path.is_file():
        return ""
    try:
        fitz = _fitz()
        doc = fitz.open(str(path))
        try:
            idx = int(src.get("page") or 0)
            if 0 <= idx < doc.page_count:
                return (doc[idx].get_text("text") or "")[:MAX_TEXT]
        finally:
            doc.close()
    except Exception:
        return ""
    return ""


def _snippet(text: str, query: str, width: int = 90) -> str:
    flat = " ".join((text or "").split())
    i = flat.lower().find(query.lower())
    if i < 0:
        return flat[: width * 2]
    start = max(0, i - width)
    end = min(len(flat), i + len(query) + width)
    return ("..." if start else "") + flat[start:end] + ("..." if end < len(flat) else "")


def search(project: dict, project_dir: Path, query: str) -> dict:
    q = (query or "").strip()
    if len(q) < 2:
        return {"query": q, "results": [], "truncated": False}
    pages = list(project.get("pages") or [])
    page_by_id = {p["id"]: p for p in pages}
    results = []
    seen = set()

    def add(kind, page_id, title, snippet, score=0):
        key = (kind, page_id, title, snippet)
        if key in seen or len(results) >= MAX_RESULTS:
            return
        seen.add(key)
        page = page_by_id.get(page_id) or {}
        results.append({"type": kind, "pageId": page_id, "pageName": page.get("name") or "",
                        "title": title, "snippet": snippet, "score": score})

    for p in pages:
        hay = " ".join(str(p.get(k) or "") for k in ("name", "group", "source"))
        if q.lower() in hay.lower():
            add("page", p["id"], p.get("name") or "Page", p.get("group") or p.get("source") or "", 3)

    for folder, item in _walk(project.get("tree") or []):
        props = item.get("props") or {}
        hay = " ".join(str(v) for v in (item.get("name"), folder, props.get("description"), props.get("spec")) if v)
        if q.lower() in hay.lower():
            page_id = next((s.get("page") for s in item.get("sections") or [] if s.get("page") in page_by_id), None)
            add("item", page_id, (folder + " / " if folder else "") + (item.get("name") or "Item"),
                (props.get("description") or props.get("spec") or item.get("type") or ""), 3)

    for mark in project.get("marks") or []:
        if mark.get("kind") == "note" and q.lower() in (mark.get("text") or "").lower():
            add("note", mark.get("page"), "Note", _snippet(mark.get("text") or "", q), 2)

    for p in pages:
        text = _page_text(project_dir, p)
        if not text:
            continue
        if q.lower() in text.lower():
            add("text", p["id"], "Text on " + (p.get("name") or "page"), _snippet(text, q), 1)

    results.sort(key=lambda r: (r["score"], r["pageName"], r["title"]), reverse=True)
    return {"query": q, "results": results[:MAX_RESULTS], "truncated": len(results) >= MAX_RESULTS}
