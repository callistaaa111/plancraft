# Performance and security audit — PlanCraft 1.0.0

**Date:** 27 October 2026
**Scope:** the Python server and storage, the canvas UI, imports/exports, and the packaged Windows build.
**Method:** code review, the 46-test suite, targeted measurements against the local projects (no client data was
changed), and a build/smoke test of the frozen executable. This is a practical audit, not a formal penetration test.

## Executive summary

No critical remote vulnerability was found. PlanCraft is a single-user local app; the realistic browser attack
surface is a malicious web page targeting 127.0.0.1, and the existing Host check plus the new Origin/Sec-Fetch-Site
check close the practical CSRF path.

The two issues that will actually bite users are **memory on large sheets** (three cached 10,000 px pages can approach
1 GB) and **whole-project JSON saves** as jobs grow. Neither is urgent for the current 817 KB project, but both belong
in the v2.0 storage work.

| Area | Finding | Severity | Status |
|---|---|---|---|
| Frontend memory | 3 cached full-resolution sheets ~0.8–0.9 GB decoded | High (large jobs) | Open, v2.0 |
| Storage | Every save rewrites and re-parses the whole project JSON | Medium | Open, v2.0 |
| Browser security | Cross-site simple requests could mutate the local API | Medium | **Fixed in 1.0.0** |
| Browser security | Missing nosniff / frame / referrer headers | Low | **Fixed in 1.0.0** |
| Imports | SwiftJob ZIP/XML member sizes are not capped | Low–Medium | Open |
| Build | Unsigned installer, no published checksums | Medium (distribution) | Open |
| Data | Projects are not encrypted at rest | Informational | Documented |
| Local API | No authentication; any local process can read/write | Accepted | Documented |
| Dependencies | Lower bounds only; no lockfile | Low | Mitigated by Dependabot |

## What was measured

Machine: the developer's Windows PC, Python 3.14, PyMuPDF 1.28.2, local files.

| Measurement | Result |
|---|---|
| Store.list() on the 5 real projects | 31–34 ms per call |
| Largest project JSON | 817 KB, 16 pages, 5,505 sections |
| json.loads that project | 21 ms |
| json.dumps that project | 37 ms |
| Second largest | 115 KB, 64 pages, 494 sections (4 ms load / 3 ms dump) |
| Page images | 163 PNGs, 580 MB total; largest are 15.6 MB and 10,000 × 7,143 px |
| Decoded memory for one 10,000 px page | ~272 MB RGBA |
| Viewer page cache | 3 pages (CACHE_PAGES = 3) plus mipmaps |

A save is therefore roughly: read and parse for the conflict check (21 ms), maybe copy a backup, serialise (37 ms),
write — about 60–100 ms for the largest current project, plus HTTP transfer. That is fine today and explains why the
1-second autosave feels instant. At 5–10× the geometry it becomes 0.5–1 s of work per change; the browser also sends
the whole project each time.

## Performance findings

### P1 — Full-resolution page cache (High for large sheets)

web/js/viewer.js caches up to 3 page images and builds mipmaps from each. A 10,000 × 7,143 PNG decodes to about
272 MB before mipmaps; three pages plus mipmaps is roughly 0.8–0.9 GB in the tab. A 16 GB machine can survive it; an
8 GB laptop will swap or crash. The 10,000 px cap in importers.py bounds the worst case but does not make it small.

Recommendations:

1. Cap the cache by **decoded pixels**, not page count (for example 350 MP total), and evict the least-recently used
   page.
2. Keep the full-resolution bitmap only while the view is zoomed past the largest mipmap; otherwise drop it and
   reload on demand.
3. Longer term, serve **tiles** (256/512 px) or a pre-built pyramid and draw only visible tiles. This also makes the
   first paint on a 10k sheet much faster.
4. Re-check CACHE_PAGES = 3 against the pixel budget; 2 pages is a safer default until tiling exists.

### P2 — Whole-project JSON saves (Medium)

store.save validates, reads the file again for the optimistic-concurrency check, copies a backup when due, serialises
the whole project and replaces the file. The browser sends the full project on every debounced change.

Recommendations:

1. Store the modified stamp in a tiny sidecar (or SQLite) so the conflict check does not parse the whole JSON.
2. Add a delta endpoint (PATCH /api/projects/:id) with the changed node ids and apply it in a transaction. This is the
   v2.0 storage work in docs/ROADMAP.md.
3. Keep the current full-snapshot endpoint for compatibility and for sendBeacon on close.

### P3 — Projects screen parses every project and decodes thumbnails (Low–Medium)

Store.list parses every project.json to count items and sections; 32 ms for 5 projects, dominated by the 817 KB one.
Extrapolated to 50 projects this is a few hundred ms. The first thumbnail request for a 10k page decodes the full PNG
before downscaling.

Recommendations: write a small index.json summary on save (name, counts, modified, thumb), or a SQLite view. Generate
thumbnails at import time (or from the mipmap) so the home screen never decodes a 10k image.

### P4 — Auto count is a full-page template match (Medium on big sheets)

vision.find_symbols runs cv2.matchTemplate over the page region, optionally at rotations, and can return up to 5,000
matches / 30,000 peaks. There is no cancellation or progress in the HTTP request. On a 10k sheet this can take seconds
and block the request thread (the UI stays responsive, but the request does not).

Recommendations: tile the search, downscale for the first pass and refine candidates at full resolution, return
progress through the existing task system, and add a Cancel button. Keep the current review step.

### P5 — Print/image decode can spike memory (Medium)

printpdf opens the full page image (or the source PDF) for each page. It processes one page at a time, which is good,
but Image.MAX_IMAGE_PIXELS = None removes Pillow's decompression-bomb guard. For a local file this is acceptable; a
corrupt or malicious image could still exhaust memory.

Recommendation: keep a high but finite limit (for example 400 MP, matching the importer), and fail with a clear
message.

### P6 — Frontend redraw work grows with sections (Low)

The viewer uses requestAnimationFrame and mipmaps, which is the right shape. But visibleSections filters the whole
tree on each frame, and count markers are drawn one by one. At 5,505 sections it is still smooth; at 20k+ it will
show. Pre-index sections by page when the project loads, and skip off-screen bounds before drawing.

### P7 — Server has no request timeouts or connection limits (Low, local)

ThreadingHTTPServer accepts unbounded threads, and there is no per-request read timeout. A local misbehaving client
can exhaust threads; a remote attacker cannot reach the loopback socket. This is acceptable for a desktop app, but a
max-threads option or a small semaphore is cheap insurance.

## Security findings

### S1 — Cross-site request forgery against the local API (Medium, fixed)

The server already rejects a foreign Host (DNS rebinding). It did not check Origin or Sec-Fetch-Site, so a malicious
page could send a **simple** cross-origin request (for example Content-Type: text/plain with a JSON body) to
POST /api/projects or /save. The response is unreadable without CORS, but the side effect can still happen.

**Fix applied:** server.route now refuses POST/PUT/DELETE when Origin is present and not the app's own origin, or
when Sec-Fetch-Site is cross-site. Same-origin requests and non-browser clients (no Origin header) still work. Two
tests cover the refusal and the allowed same-origin case.

**Residual:** a local process, or a browser extension with host permissions, can still call the API. That is inherent
to a loopback app with no accounts; the app is documented as single-user.

### S2 — Missing security headers (Low, fixed)

Responses now send X-Content-Type-Options: nosniff, X-Frame-Options: DENY and Referrer-Policy: no-referrer. This stops
MIME confusion and clickjacking of the local UI.

**Not added:** a Content-Security-Policy. The UI writes inline style attributes and opens a print window with
document.write; a CSP needs a careful pass and a manual print test. Add it with the next UI release, starting with
default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors
'none'.

### S3 — SwiftJob ZIP/XML parsing (Low–Medium, open)

read_swiftjob accepts any ZIP with XMLData.XML, parses the XML with ElementTree.parse, and later reads image members.
There is no cap on the uncompressed member size or the number of pages. A malicious .SwiftJob could be a ZIP bomb or
an XML entity-expansion file.

Recommendations: reject members over a sane limit (for example 50 MB each, 500 MB total), cap the page count (for
example 2,000), and parse with defusedxml if it is available (or reject DTDs). This is a local file-open action, so
the severity is limited, but estimators do receive jobs from other people.

### S4 — Unsigned distribution (Medium for distribution)

The installer and executable are unsigned, so Windows SmartScreen will warn, and users cannot verify the download.
Publish SHA-256 checksums with each release (GitHub can show them), and sign with an Authenticode certificate when
available. Add the signing step to the release workflow behind repository secrets; do not put a certificate in the
repo.

### S5 — Dependency drift (Low)

requirements.txt uses lower bounds. A new PyMuPDF minor could change rendering; a new OpenCV could change auto count.
Dependabot is enabled, and the tests cover the important paths, but the build is not reproducible.

Recommendations: keep a tested constraint file for release builds (or pip-compile output), pin PyInstaller in CI, and
run the release build only from a tag after CI. PyMuPDF is now pinned below 2.0 because 2.x pulls the layout/LLM
stack that PlanCraft does not use.

### S6 — Data at rest and local trust (Informational)

Projects contain client plans and prices and are stored as plain JSON/PNG. Anyone with the Windows account (or a
backup copy) can read them. There is no encryption, no account, and no cloud upload. Document BitLocker for
confidential work, and use encrypted archives if projects leave the machine. If sync is added, encrypt the archive,
not just the transport.

### S7 — Local API authentication (Accepted)

There is no token. Loopback binding, the Host check and the new Origin check are the boundary. A second Windows user
cannot reach the port by default; a process running as the same user can. Do not run PlanCraft on a shared account
with untrusted software. A per-launch token in the URL is possible later but adds friction for bookmarks and the
desktop shortcut.

## Fixes included in 1.0.0

- Origin / Sec-Fetch-Site checks on state-changing requests, with tests.
- X-Content-Type-Options, X-Frame-Options, Referrer-Policy.
- PyMuPDF pinned to 1.x, removing the unused onnxruntime/layout stack from the installer (a smaller build and a
  smaller attack surface).
- Frozen build always logs to plancraft.log, so a windowed startup error is diagnosable.
- Path validation retained (project ids, image names, backup names, export names, static files).
- Packaged build avoids the old installer's runtime download of Python and PyPI packages.

## Recommended order

1. **Now:** publish checksums, sign the installer if possible, add the SwiftJob size caps.
2. **v1.1:** a pixel-budget page cache and on-demand full-resolution reload (fixes the worst user-visible crash).
3. **v2.0:** SQLite/incremental saves and a project index; then tile serving if 10k sheets remain common.
4. **Later:** CSP with a print-window test, auto-count tiling/cancel, optional API token.

## Verification

~~~powershell
python -m unittest discover -s tests -v      # 54 tests
ruff check .
.\venv\Scripts\python.exe -m PyInstaller packaging/PlanCraft.spec --noconfirm --clean
# smoke test the frozen app: & dist\PlanCraft\PlanCraft.exe --port 8798 --data dist\smoke-data
# GET /api/ping, then POST /api/quit with X-PlanCraft: quit
~~~
