# Changelog

All notable changes to PlanCraft. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **About PlanCraft** (projects screen and Ctrl+K): version, data folder, log file, library versions, and a
  **Copy diagnostics** button for bug reports (no plans, prices or takeoff).
- **Folder backup** (Storage): copies new and changed files of the data folder to a folder you choose (OneDrive, a
  USB drive) every 30 minutes and on demand. It never deletes there; a failed automatic backup is shown in Storage.
- The keyboard shortcuts list now includes Ctrl+K, Ctrl+Shift+F and project search.
- **Your own cost lines** (Materials → Quote → + Add cost line): permits, mobilization, bond... as a percent of the
  material + labour subtotal or a fixed amount. They come after contingency and before markup and tax, and appear on
  screen, in the Excel Bill of Materials and Quote sheets, and on the proposal PDF.
- **Proposal PDF (quote)** in the Export menu; **Text and button size** in About: type any size from 80% to 150%.

### Changed

- **More room for the plan.** The properties panel starts closed (P or its x toggles it) and slides over the plan on
  narrow windows; project settings (units, currency, markup, allowances, backups) moved to a **Project** window; notes,
  highlighter and Compare moved into a **More** pop-out, so the toolbar stays on one row. At 1366x768 the plan gets
  66% of the screen instead of 45%.
- Quote tab shows the totals before the proposal fields and Download button; the Materials tabs stay in view.
- Pale takeoff colours (yellow, lime, pastels) get a dark edge so they show on white paper; light-theme grey text and
  input borders are darker to meet WCAG AA.
- The demo prices its downlights through an assembly, so its quote shows real totals.

### Fixed

- Selecting a count item made its own markers vanish from the plan (and froze the status hint) when its sections had
  no id, as in the demo.
- Price list rows were three lines tall with the Labour column empty: a workspace style leaked into the table.

## [1.1.3] - 2026-10-27

### Fixed

- **Blank PlanCraft window after 1.1.2.** The new item clipboard module imported uid from store.js, where it is not
  exported, so the browser module graph failed before the UI could render. It now imports uid from util.js.
- Added scripts/check_js_imports.py to CI so a named import that does not exist fails the build.

## [1.1.2] - 2026-10-27

### Added

- **Page thumbnails** in the Pages list, generated on demand and cached in the project cache folder.
- **UI scaling** commands in the Ctrl+K palette (90%, 100%, 110%, 125%), remembered in the browser.

### Changed

- Version 1.1.2.

## [1.1.1] - 2026-10-27

### Added

- **Try demo:** creates a small electrical sample project with a plan, folders, materials, assemblies and a quote,
  then shows a short tour of the workflow.
- **Copy/paste items and folders:** copy a takeoff item or folder and paste it here or in another project. Sections
  are restored when the target project has a matching source/page or page name; unmatched sections are reported.

### Changed

- Version 1.1.1; the frozen build includes the demo module.

## [1.1.0] - 2026-10-27

The estimating and daily-work release: a proposal PDF, project templates, page management, bulk editing, optional OCR
and a saved-symbol library, plus the quick wins from the 1.0 feedback.

### Added

- **Proposal PDF:** the Quote tab now captures company, client, project address, validity and terms, and produces a
  one-page client proposal from the same cost build-up. Currency is written as PHP/EUR/GBP when the PDF font cannot
  show the symbol.
- **Project templates:** save the price list, assemblies, folder/item skeleton and settings from a project, then create
  new projects from them. Pages and takeoff sections are never copied.
- **Manage pages:** rename/group pages, reorder them, and tick several pages to apply a standard scale in one go.
- **Bulk edit:** select many items and change colour, unit, allowance, assembly or visibility. Items also have a
  manual plus/minus adjustment with a reason, included in totals, costs and exports.
- **Optional OCR:** when Tesseract is installed, the Search dialog can OCR scanned pages and store the text for search.
  The app remains fully usable without it.
- **Symbol library and batch count:** save a boxed symbol from Auto count, then match it across selected pages and add
  the reviewed matches to a count item.
- **QOL:** duplicate a project, storage/trash usage with empty trash, CSV summary export, copy a quantity, Ctrl+K
  command palette, light/dark theme, pinned projects, and a per-item "needs review" flag.

### Changed

- The version is 1.1.0; the ping endpoint reports whether OCR is available.
- The frozen build includes the new modules; the installer and portable zip are built from the tag by the release
  workflow.

## [1.0.0] - 2026-10-27

The first packaged release: PlanCraft now installs and runs without a separate Python installation.

### Added

- Windows installer (per-user, no administrator rights) and a portable zip, built with PyInstaller and Inno Setup.
- `PlanCraft.exe` opens the app window when double-clicked; installed projects live in
  `%LOCALAPPDATA%\PlanCraft\data` and survive upgrades and uninstalls. A `portable.txt` next to the executable keeps
  data beside it instead.
- The running version is returned by `/api/ping` and shown on the Projects screen; `python server.py --version` works
  for source runs.
- **Compare revisions:** the project card menu can compare two projects, match pages by source/sheet name, list
  old/new quantities, deltas and percentages for every item, and export the report as Excel.
- **Search project** (Ctrl+Shift+F): page names, items, notes and PDF text, with a jump to the matching page. PDF
  text is kept at import; older projects fall back to reading the retained source PDF.
- **Project archive export/import** (.plancraft.zip): project.json, page images and source PDFs in one zip; import
  creates a new project and checks sizes and paths before extracting.
- **Labour and quote build-up:** mark a price-list row as Labour, then use the new Quote tab for overhead,
  contingency, markup and VAT/tax. The properties panel and the Excel Quote sheet show the same arithmetic.
- GitHub Actions: tests on Python 3.10-3.13, ruff and a privacy gate on every push and pull request; tag-driven
  release builds.
- Ruff, coverage and development dependencies; issue forms, pull request template, Dependabot, contributing and
  security guides.

### Changed

- The default data folder is resolved once at startup: `./data` from source, `%LOCALAPPDATA%\PlanCraft\data` in the
  installed build, and `PLANCRAFT_DATA` still overrides both.
- The Python version check is 3.10+; the release build uses Python 3.12.
- Lint cleanup across the backend: sorted imports, explicit `raise ... from None`, strict `zip()`, and a closure
  fix in the supplier price-list parser.

### Fixed

- A supplier price-list row could be read with the wrong row in a deferred lambda (`pricelist.py`).
- The print legend annotation referred to a `fitz` module that is a parameter, which confused static analysis.
- The frozen build no longer computes its code stamp from `.py` files, which do not exist inside the executable.

### Security

- The local API refuses cross-site state-changing requests (Origin / Sec-Fetch-Site checks) and sends
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- Documented the local-only trust model, the Host-header check, and the lack of encryption at rest in
  [SECURITY.md](SECURITY.md).
- Added `scripts/privacy_scan.py` and a CI privacy job that block client documents, archives, large files, known
  credentials and private keys; the local data folder is checked to stay ignored. Results and guidance are in
  [docs/PRIVACY.md](docs/PRIVACY.md).
