# The takeoff-software landscape, and what PlanCraft should borrow

**Research date:** 27 October 2026. Prices and features change; treat the numbers as a snapshot and check the vendor
page before quoting them. PlanCraft is compared as it exists in 1.0.0.

## Why this matters

PlanCraft is not trying to be a cheaper PlanSwift. It is trying to be the takeoff tool an electrical estimator can
**own**: offline, MIT-licensed, no subscription, and compatible with the PlanSwift jobs they already have. The
competitors below show which features buyers now expect, which ones are table stakes, and which ones PlanCraft can
deliberately skip.

## The short version

| Tool | Best for | Model | 2026 price (published) | The lesson for PlanCraft |
|---|---|---|---|---|
| **PlanCraft** | Electricians and small estimators who want an offline, owned tool | Windows desktop, local server | Free, MIT | Keep the offline/SwiftJob niche; add the estimate layer |
| **PlanSwift** | General takeoff and assemblies, all trades | Windows desktop | ~$1,749/year per license | Assemblies and auto tools are the bar; SwiftJob compatibility is an asset |
| **Bluebeam Revu** | GCs and teams already living in PDFs | Desktop + cloud | ~$330/user/year (Core) | PDF markup and measurement in one place; Excel export is expected |
| **STACK** | Cloud teams that need collaboration | Browser | Free tier; paid from ~$2,599/year | Version compare and integrated estimating; a free tier drives adoption |
| **Togal.AI** | High-volume AI takeoff | Browser | ~$1,999–2,999/user/year | AI takeoff is real, but accuracy claims need a review workflow |
| **On-Screen Takeoff** | Commercial subcontractors | Windows, bundled with Quick Bid | Quote only | Takeoff-to-bid workflow; AI "BOOST" is now the headline |
| **Countfire** | Electrical and mechanical estimators | Browser | Quote-based, ~$99/user/month | Symbol counting across the whole project, Smart Select naming, revision re-count |
| **OpenTakeoff** | Developers and estimators who want an open, browser-only engine | Browser, AGPL-3.0 | Free | Local-first canvas, per-sheet calibration, provenance, MCP/AI, tiled PDFs |
| **OpenConstructionERP** | Companies wanting a full open-source ERP | Self-hosted / desktop | Free, AGPL-3.0 | BOQ, cost databases, 44 languages, signed releases |

Sources: [Contractor Guide Pro's 2026 comparison](https://contractorguidepro.com/best-takeoff-software-contractors-2026/),
[PlanSwift electrical](https://planswiftactivations.app.constructconnect.com/estimating/electrical),
[Bluebeam takeoff](https://www.bluebeam.com/solutions/takeoff/),
[ConstructConnect On-Screen Takeoff](https://www.constructconnect.com/onscreen-takeoff),
[STACK](https://www.stackct.com/), [Togal.AI](https://www.togal.ai/), [Countfire](https://www.countfire.com/),
[OpenTakeoff](https://github.com/Kentucky-ai/opentakeoff),
[OpenConstructionERP](https://github.com/datadrivenconstruction/OpenConstructionERP).

## What the competitors actually sell

### PlanSwift

Still the reference for general takeoff. The 2026 pitch is **Auto Takeoff, Auto Count, Auto Scale and Auto
Bookmark**, plus the assembly builder: draw a wall and get drywall, studs and fasteners. The electrical page sells
"counts your devices and prices the job in the same pass" — quantities, runs and labour in one place. The perpetual
licence is gone; it is now a subscription around $1,749/year. Its installed base and the SwiftJob format are why
PlanCraft's import/export matters.

**Borrow:** the assembly builder is already in PlanCraft but needs labour; auto-scale/bookmark are good automation
targets; a one-click "turn this measurement into a priced line" is the core promise.

### Bluebeam Revu

The cheapest big-name option (~$330/year) and the default for GCs who already mark up PDFs. Strength: 2D/3D PDF
markup + measurement + custom tool sets + cloud collaboration + export to Excel or bidding software. It is not an
estimating system; it is a PDF workspace with measurement.

**Borrow:** measurement must feel native on a PDF, not only on a rendered image; export to Excel is expected; cloud
collaboration is a team feature, not a solo one.

### STACK

Browser-based takeoff with AI takeoff, trade tools, **version compare**, integrated estimating and assemblies, ERP
connectors, mobile plan viewing, and a genuine free tier (paid from ~$2,599/year). The free tier is a smart
acquisition channel.

**Borrow:** version compare is a headline feature, not a page tool; a free tier/portable edition is how you get
trial users; mobile viewing matters on site.

### Togal.AI

AI takeoff with a claimed 98% accuracy on floor plans and "5x faster" positioning, cloud collaboration, instant
drawing-set comparison and a chat feature. The useful lesson is not the accuracy number; it is that **AI output is
reviewed**, and that comparison is one click.

**Borrow:** every automated measurement needs a confidence/review state; compare should accept two sets, not two
pages; a chat/search over the plan is a natural extension of OCR.

### On-Screen Takeoff (ConstructConnect)

Commercial subcontractor takeoff bundled with Quick Bid. The 2026 push is **Takeoff BOOST**: upload a plan, get an
AI first pass with auto-name, auto-scale and auto-takeoff, in the browser. It confirms the direction of travel:
automation is becoming the default first pass, with the estimator correcting it.

**Borrow:** auto-name from the title block/room labels; make the first pass fast and reviewable; keep the estimating
link tight.

### Countfire

Purpose-built for electrical and mechanical. It counts symbols **across every drawing in a project**, uses Smart
Select to name and organise items as it counts, auto-counts revised drawings, and moves from takeoff to estimate and
spec comparison. Browser-based, PC or Mac, used in 20+ countries, quote-based around $99/user/month.

**Borrow:** counting across a whole project, not one page; naming/organising during the count; re-count only what
changed in a revision; spec comparison is a real electrical workflow.

### OpenTakeoff (open source, AGPL-3.0)

The closest open-source cousin. A client-only browser app with a canvas and an MCP agent interface, no upload,
per-sheet calibration, measurements with geometry/method/author and review status, tile workers that release closed
PDFs and fonts, and device-aware PDF cache limits. It has a user manual, agent manual, features map and public
benchmark.

**Borrow:** provenance and review status per measurement; calibration changes recompute quantities and report scale
conflicts; browser-only deployment (no Python) reaches Mac/Linux; tile/LRU memory discipline; documentation as a
first-class feature.

### OpenConstructionERP (open source, AGPL-3.0)

A full construction ERP: BOQ, PDF/CAD/BIM takeoff, 4D/5D, tendering, 120k+ cost items, 44 languages, 190+ modules,
self-hosted and desktop builds, signed releases. It shows what a mature open-source construction product looks like:
cost databases, localisation, signed artifacts, security scanning.

**Borrow:** a regional cost database is a moat; localisation multiplies adoption; signed releases and supply-chain
hygiene are expected of a serious installer.

## Feature matrix

Legend: **Yes** = first-class; **Partial** = exists with limits; **—** = not a product feature; **Add-on** = via a
partner/plugin. This is a practical comparison, not a vendor audit.

| Capability | PlanCraft | PlanSwift | Bluebeam | STACK | Togal | Countfire | OpenTakeoff |
|---|---|---|---|---|---|---|---|
| Offline / local data | **Yes** | **Yes** | Partial | — | — | — | **Yes** |
| Windows installer, no Python | **Yes (1.0)** | **Yes** | **Yes** | — | — | — | — (browser) |
| PDF / image import | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |
| PlanSwift .SwiftJob import/export | **Yes** | native | — | — | — | — | — |
| Scale calibration / printed scale | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |
| Linear / area / count / deduct | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |
| Auto count (CV) | **Yes** | **Yes** | Partial | **Yes** | **Yes (AI)** | **Yes (AI)** | Partial |
| AI / learned takeoff | — | Auto Takeoff | — | **Yes** | **Yes** | **Yes** | Partial |
| Auto scale / auto name | Partial | **Yes** | Partial | **Yes** | **Yes** | **Yes** | Partial |
| Assemblies / recipes | **Yes** | **Yes** | — | **Yes** | — | **Yes** | — |
| Labour rates and quote | — | **Yes** | — | **Yes** | — | **Yes** | — |
| Excel export | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |
| Live Excel link | — | Add-on | Quantity Link | STACK for Excel | — | — | — |
| Revision / drawing-set compare | Partial (page) | Partial | Overlay | **Yes** | **Yes** | **Yes** | Partial |
| Cloud collaboration | — | — | **Yes** | **Yes** | **Yes** | **Yes** | — |
| Mobile / tablet | — | — | Partial | **Yes** | **Yes** | **Yes** | **Yes (browser)** |
| Localisation | — (English) | Partial | Partial | Partial | Partial | Partial | **Yes (docs)** |
| Free / open source | **Yes (MIT)** | — | — | Free tier | — | — | **Yes (AGPL)** |
| Price | **Free** | ~$1,749/yr | ~$330/yr | Free / ~$2,599/yr | ~$1,999–2,999/yr | ~$99/user/mo | Free |

## What PlanCraft should add (QOL and features)

Ordered by the ratio of user value to build cost, and grouped by the releases in docs/ROADMAP.md.

### Do next (v1.1): make the daily loop faster

1. **A sample project and a two-minute tour.** The empty state is the hardest screen. Ship the demo sheet used in
   the README (or a simplified one) with a "Try the demo" button, and a short coach-mark sequence: set scale, draw a
   line, count outlets, export. Competitors all invest in onboarding; PlanCraft currently has none.
2. **Project-wide search and a command palette.** Search items, pages, notes and sheet numbers from one box; jump to
   the page and zoom. Add Ctrl+K for "new linear", "set scale", "export Excel", "go to page". Search is the most
   common navigation pain after 20 pages.
3. **Page organisation.** Rename pages, group by sheet set/discipline, reorder by drag, show a page label next to the
   number. Keep the filter. A 64-page project needs this more than another measuring tool.
4. **Batch scale review.** A "Scales" sheet listing every page, its scale source (manual/auto/none), and inline
   editing; flag pages with geometry but no scale. This is the scale-conflict lesson from OpenTakeoff.
5. **Quantity adjustments and notes per item.** A manual plus/minus adjustment with a reason, and a per-item note.
   Estimators always carry a "check this" number; do not force them into Excel.
6. **Copy/paste items and folders between projects.** Page copy already exists; item copy is the missing half.
7. **CSV export and copy-to-clipboard** for the Summary; Excel is not always wanted.
8. **Trash management and storage usage.** Show how much the data folder uses, let the user empty trash and prune
   old backups from the UI. A 1 GB data folder is normal; silent growth is not.
9. **Better count editing.** Type a quantity directly, split/merge count sections, nudge a point with arrow keys.
10. **A proper About/Diagnostics dialog** with version, data folder, log path, and a "copy diagnostics" button.

### Then (v1.2): turn quantities into a bid

11. **Labour rates, crews and productivity.** The assembly model already has parts; add labour as a part type with a
    rate and a productivity basis. Electrical estimators think in "hours per point" and "hours per 100 m".
12. **Overhead, contingency, tax and markup** with a transparent build-up, not a hidden multiplier.
13. **A client-ready quote PDF** with company details, scope, exclusions, validity, terms and a signature block.
14. **Import a takeoff from Excel/CSV** so a job priced elsewhere can be checked in PlanCraft.
15. **Spec comparison** (Countfire's lesson): attach a specification PDF to a project and search/compare clauses
    against the takeoff descriptions. Even a simple text diff is useful.

### Then (v1.3): plan intelligence without the cloud

16. **Text search / OCR** over PDF text and, optionally, Tesseract for scans. Jump to the word on the sheet.
17. **Auto-scale and auto-name** from the title block; offer candidates, never silently accept.
18. **A project symbol library** and **batch auto count** across selected pages, with a single review queue.
19. **Room/area detection** (flood fill) as a first pass, clearly marked unreviewed; Togal/OpenTakeoff show the
    demand, but the review step is what makes it trustworthy.
20. **Provenance and review status** per measurement: who/what created it (manual, auto count, imported), when, and
    whether a human checked it. This is OpenTakeoff's best idea and cheap to add to the section model.

### Later (v2.0): reach and durability

21. **SQLite/incremental saves and tiled page rendering** — the performance work in docs/AUDIT.md.
22. **Archive export/import (.plancraft.zip)** and optional folder backup to OneDrive/Drive; no account, no server.
23. **Cross-platform packaging** (macOS/Linux) or a browser-only build. The Python backend and plain JS UI could run
    on all three; the Windows installer is the only blocker.
24. **Touch/tablet UI** for site walk-throughs: pinch zoom, palm rejection, large hit targets.
25. **Dark mode, UI scaling and screen-reader labels**; 44-language localisation is the long-term bar set by
    OpenConstructionERP, but start with English/Spanish/Filipino if the user base is regional.
26. **Signed releases and published checksums**; CodeQL/Dependabot are already in place.
27. **An optional MCP/AI interface** to the project (read quantities, propose takeoff, never write without review).
    OpenTakeoff proves the demand; PlanCraft's offline data model is a good fit, and it is a differentiator no
    subscription tool can match.

## What not to copy

- **Cloud-only collaboration.** PlanCraft's advantage is ownership and offline work. Add file-based sync/archives,
  not an account system.
- **AI accuracy marketing.** Do not claim a percentage; show the review queue and the provenance instead.
- **A giant module marketplace.** Stay a takeoff tool. Integrations (Excel, PlanSwift, CSV, MCP) are enough.
- **Subscription pricing.** MIT and free are the point; a paid support/installation service is compatible, a
  per-seat licence is not.

## Positioning sentence

> PlanCraft is the free, offline takeoff app that opens your PlanSwift jobs, runs on your own PC, and turns a plan
> into quantities, materials and a priced bid without a subscription or an upload.

That sentence is the filter for the roadmap: if a feature does not make that sentence more true, it is not a
priority.
