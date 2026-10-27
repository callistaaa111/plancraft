# Changelog

All notable changes to PlanCraft. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-27

The first packaged release: PlanCraft now installs and runs without a separate Python installation.

### Added

- Windows installer (per-user, no administrator rights) and a portable zip, built with PyInstaller and Inno Setup.
- `PlanCraft.exe` opens the app window when double-clicked; installed projects live in
  `%LOCALAPPDATA%\PlanCraft\data` and survive upgrades and uninstalls. A `portable.txt` next to the executable keeps
  data beside it instead.
- The running version is returned by `/api/ping` and shown on the Projects screen; `python server.py --version` works
  for source runs.
- GitHub Actions: tests on Python 3.10-3.13 and ruff on every push and pull request; tag-driven release builds.
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
