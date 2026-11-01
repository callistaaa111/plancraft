"""Reusable project templates: price list, assemblies, folder/item skeleton and settings.

A template never contains pages or takeoff sections, so applying one cannot copy measured quantities. IDs are new in
the created project; material and assembly IDs are preserved because they are referenced by the item props.
"""
from __future__ import annotations

import json
import re
import secrets

from store import new_id, now_iso

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def _strip_tree(nodes):
    out = []
    for n in nodes or []:
        if n.get("kind") == "folder":
            out.append({"kind": "folder", "name": n.get("name") or "Folder", "open": n.get("open", True),
                        "visible": n.get("visible", True), "assembly": n.get("assembly"),
                        "children": _strip_tree(n.get("children") or [])})
        else:
            out.append({"kind": "item", "type": n.get("type"), "name": n.get("name") or "Item",
                        "color": n.get("color"), "visible": n.get("visible", True),
                        "props": json.loads(json.dumps(n.get("props") or {})), "sections": []})
    return out


def _clone_tree(nodes):
    out = []
    for n in nodes or []:
        if n.get("kind") == "folder":
            out.append({"id": new_id("f-"), "kind": "folder", "name": n.get("name") or "Folder",
                        "open": n.get("open", True), "visible": n.get("visible", True),
                        "assembly": n.get("assembly"), "children": _clone_tree(n.get("children") or [])})
        else:
            out.append({"id": new_id("i-"), "kind": "item", "type": n.get("type"),
                        "name": n.get("name") or "Item", "color": n.get("color"),
                        "visible": n.get("visible", True), "props": json.loads(json.dumps(n.get("props") or {})),
                        "sections": []})
    return out


class Templates:
    def __init__(self, store):
        self.store = store
        self.dir = store.root / "templates"
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, tid):
        if not isinstance(tid, str) or not ID_RE.match(tid):
            raise KeyError(tid)
        return self.dir / f"{tid}.json"

    def list(self):
        out = []
        for f in sorted(self.dir.glob("*.json"), reverse=True):
            try:
                t = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            out.append({"id": f.stem, "name": t.get("name") or f.stem, "units": t.get("units"),
                        "materials": len(t.get("materials") or []), "assemblies": len(t.get("assemblies") or []),
                        "modified": t.get("modified") or ""})
        out.sort(key=lambda r: r["modified"], reverse=True)
        return out

    def get(self, tid):
        return json.loads(self._path(tid).read_text(encoding="utf-8"))

    def save(self, project, name=None):
        tname = (name or project.get("name") or "Template").strip() or "Template"
        tid = f"{re.sub(r'[^a-z0-9]+', '-', tname.lower()).strip('-')[:40] or 'template'}-{secrets.token_hex(3)}"
        data = {
            "id": tid, "name": tname, "units": project.get("units") or "m",
            "settings": json.loads(json.dumps(project.get("settings") or {})),
            "materials": json.loads(json.dumps(project.get("materials") or [])),
            "assemblies": json.loads(json.dumps(project.get("assemblies") or [])),
            "tree": _strip_tree(project.get("tree") or []), "modified": now_iso(),
        }
        (self.dir / f"{tid}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"id": tid, "name": tname}

    def delete(self, tid):
        p = self._path(tid)
        if p.is_file():
            p.unlink()
            return {"ok": True}
        raise KeyError(tid)

    def create_project(self, store, tid, name=None, units=None):
        t = self.get(tid)
        nm = (name or t.get("name") or "New project").strip() or "New project"
        project = store.create(nm, units or t.get("units") or "m")
        project["settings"] = json.loads(json.dumps(t.get("settings") or {}))
        project["materials"] = json.loads(json.dumps(t.get("materials") or []))
        project["assemblies"] = json.loads(json.dumps(t.get("assemblies") or []))
        project["tree"] = _clone_tree(t.get("tree") or [])
        project["pages"] = []
        project["template"] = tid
        store.save(project["id"], project)
        return store.load(project["id"])
