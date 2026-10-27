# PlanCraft roadmap

This is the plan for everything after **v1.0** (the packaged release and CI work). It is written for a small
project: each milestone is shippable on its own, keeps the app offline-first, and avoids new services unless the
feature genuinely needs one.

## How the estimates work

Effort below is in **focused build days** for one developer who knows the codebase — the same unit I used for
"1–2 days" for packaging. It includes implementation, tests and a local check, but not calendar time for reviews,
code signing, waiting on CI, or a beta with real estimators. A coding agent can compress the build part into hours;
the calendar time is still dominated by review and real-plan testing, which is where quantity bugs are found.

## Principles

1. **Offline first.** No account, no cloud dependency, no telemetry. Sync is opt-in and file-based.
2. **Quantities must be explainable.** Every total can be traced to a page, a section and a scale.
3. **Do not break the takeoff file.** Projects are the user's work: schema migrations are one-way with a backup.
4. **The UI stays plain.** No bundler or framework unless it removes more code than it adds.
5. **One killer feature per minor release**, with the quality-of-life fixes that make it usable.

## v1.1 — Revision intelligence

**Problem:** today Compare is page-to-page and visual. An estimator still has to work out *which quantities changed*
between two issuances, which is the slowest and most error-prone part of a revision.

**Scope**

- **Compare two projects or two backups** (not only two pages). Match pages automatically by `source` +
  `sourcePage`, then by sheet name, and let the user fix the pairs.
- **Quantity delta table:** per item, old qty, new qty, difference and percent; added and removed items; items whose
  scale or page changed. Group by folder and show a project total.
- **Change report export:** Excel sheet and a one-page PDF, with project/revision labels, date, and the page matches.
- **Carry takeoff across revisions** using the existing alignment transform; offer "copy", "move" or "merge".
- **Change log view:** notes, highlights and page additions/removals included in the report.

**Data/API**

- Add optional `revision` metadata to a project (`label`, `issued`, `sourceProject`).
- New endpoint `POST /api/projects/:id/compare` with `{other: projectId | backupName, pairs?: [...]}`; returns
  matched pages and item deltas. Do the maths on the server so the same rules apply to exports.
- Reuse `measure.item_quantities`; add `measure.quantity_map(project)` and `compare.py` with pure functions and tests.

**Acceptance**

- Two copies of the demo project with one moved wall and two added outlets produce the expected deltas and zero
  false "removed" items.
- Every row links to the page and item, the same way Search items does.
- A 60-page, 250-item project compares in under 2 seconds and exports in under 5 seconds.

**Tests:** matching by source/page/name, unmatched pages, moved item between folders, scale change, deduct areas,
deleted page, export formulas.

**Estimate:** 3–4 days. **Risk:** page matching is fuzzy; keep a manual pair editor and never silently guess.

## v1.2 — Estimate and proposal layer

**Problem:** PlanCraft stops at quantities and material cost. An estimator still rebuilds labour, overheads, tax and
the client quote in Excel.

**Scope**

- **Labour rates** per trade (electrician, helper, apprentice), with productivity per unit (m, m², ea) and a
  crew/labour-hours calculation. Reuse the assembly model: a part can be a material *or* a labour rate.
- **Project pricing settings:** overhead %, contingency %, markup %, VAT/tax %, currency, round-up rules, and a
  per-item override.
- **Quote/proposal PDF:** company name/logo, project and revision, scope summary, exclusions, validity, terms,
  subtotal → overhead → contingency → markup → tax → total. Optionally attach the marked-up plan.
- **Client-facing and internal views:** hide cost/markup on the client copy.
- **Excel export additions:** Labour, Cost Build-up, Quote Summary; keep existing BOM sheets.
- **Import a takeoff from Excel/CSV** (item, type, qty, unit, rate) for jobs priced elsewhere.

**Data**

- Extend `project.materials` with `kind` or add `project.labour`; assembly parts get `kind` and `rate`.
- Put rates and markup in `project.settings` with defaults; keep `pricing.js` and `pricing.py` in lockstep.
- A quote is generated, not stored; store only the chosen options and a snapshot hash.

**Acceptance**

- A 3-item demo with one assembly produces a quote whose arithmetic matches a hand calculation to the cent.
- Changing a quantity updates every downstream total without a reload.
- Currency and rounding behave for ₱, $, € and £.

**Estimate:** 4–6 days. **Risk:** pricing rules vary by country; keep the model explicit and configurable, and do not
pretend to be an accounting system.

## v1.3 — Plan intelligence

**Problem:** finding a panel, a room or a symbol still means zooming and reading the sheet. Auto count is one page
and one symbol at a time.

**Scope**

- **Text layer search:** extract text from PDF pages (PyMuPDF) and keep an index per page; for scans, use OCR only
  when Tesseract is installed (optional, detected at startup). Search results jump to the word on the plan.
- **Scale suggestions:** parse title-block text for `1:100`, `1/8" = 1'-0"`, `1/4" = 1'`, and offer a one-click
  scale confirmation. Show the candidates and the source text.
- **Symbol library:** save the boxed template from Auto count as a named project symbol (e.g. "Duplex outlet,
  square") and reuse it on other pages. Store thumbnails in `data/projects/<id>/symbols/`.
- **Batch auto count:** run a symbol over selected pages, deduplicate overlapping matches, and present one review
  queue with page thumbnails. Add a confidence floor and an "unreviewed" badge on the item.
- **Legend awareness:** ignore the legend/title-block region by default, with a per-page mask the user can draw.

**Acceptance**

- Searching "LP1" on a 60-page set returns the panel schedule and every plan that mentions it in under a second.
- A saved symbol counts the same 12 outlets on the demo sheet with ≥ 95% precision at the default strength.
- OCR is optional: the app still starts and works when Tesseract is not installed.

**Estimate:** 7–10 days. **Risk:** OCR quality and false positives; keep every automated count reviewable and never
write counts without confirmation.

## v2.0 — Storage, archives and sync

**Problem:** a project is one JSON file rewritten on every save. At 800 KB it is invisible; at 100+ pages and 1,000+
items it becomes the bottleneck. Projects also cannot move between PCs except by copying the whole data folder.

**Scope**

- **SQLite store** (WAL, one transaction per save) with tables for projects, pages, tree nodes, sections, marks,
  materials, assemblies and backups. Keep the HTTP API shape: the server assembles the same project JSON for the UI.
- **Incremental saves:** the browser sends a patch (changed pages/items/marks) instead of the whole project; the
  server applies it in a transaction and returns the new `modified`. Start with full snapshots behind the same API,
  then switch the UI.
- **Archive export/import:** `.plancraft.zip` containing `project.json`, page images, sources and a manifest.
  Import creates a new project and reports missing images.
- **Optional folder backup:** a background copy of the data folder to a user-chosen folder (OneDrive/Drive), with
  `last-backup.json` and a restore screen. No background network calls.
- **Optional encryption:** password-protected archives (7-Zip or age), not transparent database encryption.
- **Schema migrations:** `schema` version, a migration runner, automatic backup before migration, and a
  "downgrade not supported" message. Keep reading v1 JSON.

**Acceptance**

- A 100-page project saves a moved point in under 100 ms and opens in under 2 seconds on the demo machine.
- Killing the process during 100 saves never leaves a corrupt project; the backup restore works.
- A v1 project opens, migrates, and exports/imports through the archive without losing takeoff or notes.

**Estimate:** 8–12 days. **Risk:** the migration is the highest-risk change in the project; do it behind a copy and
run the full test suite against both stores.

## Quality-of-life backlog (slot into any release)

- Page labels/renames in the page list; group pages by sheet set.
- CSV export of the Summary sheet; copy a quantity to the clipboard.
- Dark mode and a larger UI scale (accessibility; the canvas colours need care).
- Touch/pen support for tablet takeoff (pinch zoom, palm rejection).
- Multi-page box select and "select all on page" for counts.
- A first-run sample project and a 2-minute guided tour.
- Spanish/Filipino UI strings (the app is English-only; strings are in JS/HTML).
- A proper "About" dialog with version, data folder and log path.
- Crash reporting that writes a local log only, with a "copy diagnostics" button.

## Release checklist

1. Tests and ruff green on Python 3.10–3.13.
2. Version bumped in `version.py` and `CHANGELOG.md`; installer version comes from the tag.
3. Built installer smoke-tested on a clean Windows user (no Python installed).
4. Open and save a v1 project; export Excel, PDF and SwiftJob.
5. Sign the installer if a certificate is available; publish the GitHub release with the portable zip.
