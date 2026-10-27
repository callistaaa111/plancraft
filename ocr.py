"""Optional OCR for scanned plan pages, using PyMuPDF's Tesseract integration.

Tesseract is not bundled: PlanCraft only offers OCR when tesseract.exe is on PATH. Pages that already have a text layer
are skipped. OCR text is stored on the page and is then searchable like a PDF text layer.
"""
from __future__ import annotations

import shutil


def _fitz():
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    return fitz


def available() -> bool:
    return bool(shutil.which("tesseract"))


def run(task, project: dict, store, pid: str) -> dict:
    if not available():
        raise ValueError("OCR needs Tesseract. Install it from https://github.com/UB-Mannheim/tesseract/wiki, "
                         "make sure tesseract.exe is on PATH, then try again.")
    fitz = _fitz()
    pages = project.get("pages") or []
    done = 0
    for i, page in enumerate(pages):
        task.progress(i, len(pages), f"OCR page {i + 1} of {len(pages)}")
        if page.get("text"):
            continue
        src = page.get("src") or {}
        if not src.get("file"):
            continue
        path = store.project_dir(pid) / "sources" / src["file"]
        if not path.is_file():
            continue
        doc = fitz.open(str(path))
        try:
            idx = int(src.get("page") or 0)
            if not (0 <= idx < doc.page_count):
                continue
            p = doc[idx]
            tp = p.get_textpage_ocr(language="eng", dpi=300)
            text = p.get_text("text", textpage=tp) if tp else ""
            if text.strip():
                page["text"] = text[:20000]
                done += 1
        finally:
            doc.close()
    task.progress(len(pages), len(pages), "Saving OCR text")
    store.save(pid, project, expect=project.get("modified"))
    return {"pages": len(pages), "ocrPages": done}
