"""Check that named imports in web/js point at exported names (a cheap module-graph guard for CI)."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "web" / "js"
IMPORT = re.compile(r"import\s+(?:\*\s+as\s+\w+|\{([^}]*)\})\s+from\s+['\"](\.[^'\"]+)['\"]", re.S)
EXPORT = re.compile(r"export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)")
EXPORT_LIST = re.compile(r"export\s*\{([^}]*)\}")


def exports(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    names = set(EXPORT.findall(text))
    for block in EXPORT_LIST.findall(text):
        for part in block.split(","):
            part = part.strip()
            if part:
                names.add(part.split(" as ")[-1].strip())
    return names


def main() -> int:
    problems = []
    for f in sorted(ROOT.glob("*.js")):
        text = f.read_text(encoding="utf-8")
        for block, target in IMPORT.findall(text):
            target_path = (f.parent / target).resolve()
            if not target_path.is_file():
                problems.append(f"{f.name}: missing module {target}")
                continue
            if not block.strip():
                continue
            available = exports(target_path)
            for part in block.split(","):
                name = part.strip().split(" as ")[0].strip()
                if name and name not in available:
                    problems.append(f"{f.name}: imports {name!r} from {target}, but it is not exported")
    if problems:
        print("\n".join(problems))
        return 1
    print("JS named imports: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
