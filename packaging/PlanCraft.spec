# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller one-folder build for PlanCraft.

Build with:  python -m PyInstaller packaging/PlanCraft.spec --noconfirm --clean
Output:      dist/PlanCraft/PlanCraft.exe  (the whole folder is the portable app)
"""
import os
import re
from pathlib import Path

ROOT = Path(SPECPATH).resolve().parent
CONSOLE = os.environ.get("PLANCRAFT_CONSOLE") == "1"
APP_NAME = os.environ.get("PLANCRAFT_APP_NAME") or ("PlanCraftDebug" if CONSOLE else "PlanCraft")
VERSION_TEXT = (ROOT / "version.py").read_text(encoding="utf-8")
VERSION = re.search(r'__version__\s*=\s*"([^"]+)"', VERSION_TEXT).group(1)
VER = tuple(int(part) for part in VERSION.split(".")) + (0, 0, 0)
VER = VER[:4]

# Windows Explorer / installer file details.
VERSION_FILE = ROOT / "build" / "version_info.txt"
VERSION_FILE.parent.mkdir(parents=True, exist_ok=True)
VERSION_FILE.write_text(f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers={VER},
    prodvers={VER},
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable('040904B0', [
        StringStruct('CompanyName', 'PlanCraft'),
        StringStruct('FileDescription', 'PlanCraft - offline takeoff'),
        StringStruct('FileVersion', '{VERSION}'),
        StringStruct('InternalName', 'PlanCraft'),
        StringStruct('LegalCopyright', 'MIT License'),
        StringStruct('OriginalFilename', 'PlanCraft.exe'),
        StringStruct('ProductName', 'PlanCraft'),
        StringStruct('ProductVersion', '{VERSION}')
      ])
    ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
""", encoding="utf-8")

datas = [
    (str(ROOT / "web"), "web"),
    (str(ROOT / "PlanCraft.ico"), "."),
]

# Modules imported inside functions are easy for static analysis to miss; name the app's own modules and the
# native libraries explicitly. PyInstaller's bundled hooks collect the binaries for cv2, numpy, PIL and PyMuPDF.
hiddenimports = [
    "fitz",
    "pymupdf",
    "cv2",
    "numpy",
    "PIL",
    "openpyxl",
    "et_xmlfile",
    "importers",
    "measure",
    "store",
    "tasks",
    "vision",
    "version",
    "archive",
    "compare",
    "export_csv",
    "export_xlsx",
    "export_swiftjob",
    "ocr",
    "pricelist",
    "pricing",
    "printpdf",
    "quote",
    "search",
    "symbols",
    "templates",
]

a = Analysis(
    [str(ROOT / "server.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # PyMuPDF 1.x lists the optional layout/LLM stack, but PlanCraft only renders and writes PDFs.
    excludes=[
        "tkinter", "matplotlib", "pandas", "IPython", "pytest",
        "onnxruntime", "pymupdf4llm", "pymupdf_layout", "tabulate", "yaml", "psutil",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=CONSOLE,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "PlanCraft.ico"),
    version=str(VERSION_FILE),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=APP_NAME,
)
