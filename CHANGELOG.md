# Changelog

All notable changes to PlanCraft. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

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
