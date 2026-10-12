# PlanCraft

A free, offline takeoff app that works like PlanSwift and runs in your browser.
Open plans, set the scale, click out counts, lengths and areas, and export the quantities to Excel.
It also opens your existing PlanSwift `.SwiftJob` files, including their pages, scales and takeoff.

## Start it

Double-click **`PlanCraft.bat`**. The first time, it installs three Python libraries
(PyMuPDF, Pillow, openpyxl), which needs internet. After that it runs offline. PlanCraft opens in your browser at
<http://127.0.0.1:8791/>. Keep the black window open while you work; close it to stop PlanCraft.

Projects are saved automatically to `data/projects/` in this folder: one folder per project with
`project.json`, the page images and timed backups. Deleted projects go to `data/trash/`.

## Getting plans in

| From | How |
|---|---|
| PlanSwift job | **Open .SwiftJob** on the projects screen, or drop the file on the page. The pages, their scales, folders and Linear / Area / Count items with all takeoff points are imported. |
| PDF | **New from PDF**, or **Add plans** inside a project. Pick the quality (150 / 200 / 300 dpi) and the page range. If a sheet says its scale (for example `1:100` or `1/8" = 1'-0"`), PlanCraft uses it and asks you to check it. |
| Images | PNG, JPG, TIFF (multi-page too), BMP, GIF and WebP. |

## Taking off

1. **Set the scale** on each page (badge in the Pages list): **Set scale...** for a standard scale, or
   **Calibrate on plan** to click both ends of a dimension you know (most accurate).
2. Create an item with **+ Linear**, **+ Area** or **+ Count**. Selecting an item switches on the Takeoff tool.
3. Click on the plan. Lines and areas: double-click, Enter or right-click finishes, and Backspace removes the last
   point. Counts: every click is one, and Enter ends the group.
4. **Hold the right mouse button and drag to pan**, even in the middle of a run (a right-click without moving still
   finishes it). Scroll to zoom. Hold **Shift** (or turn on **Ortho**) for straight horizontal or vertical runs. **Snap** catches existing points. **Deduct**
   makes the next area a cut-out.
5. To edit, use **Select (V)**: click a takeoff, drag its points, Alt+click a point to remove it, double-click a line to add
   one, and **Del** deletes. Ctrl+Z / Ctrl+Y undo and redo. Press **?** for all shortcuts.

## Working with pages

- **Crop to a new page:** use the **Crop** tool (C), or right-click a page and choose **Crop to a new page**. Drag a box
  around an area (an EE room, a stair core, and so on) and name it. The new page is inserted after the original and keeps
  its scale. Takeoff is not copied, so nothing is counted twice.
- **Copy / paste a page:** right-click a page and choose **Copy page** (or Ctrl+C), then **Paste** (Ctrl+V). This also
  works into another project, because the copy stays available when you switch projects. When pasting you choose:
  - **Page only:** a blank copy for a new takeoff.
  - **Page with its takeoff:** the sections are added to items with the same name. If the target project doesn't have
    them, the items (and their folders) are created. Within the same project this counts the takeoff again, which is
    handy for typical floors.

The Takeoff list has two views. **All pages** shows every item with its total. **This page** shows only the items that
have takeoff on the open page, with their quantity on that page. The panel on the right shows the selected item's
quantity, its allowance and its quantity on each page.

## Excel export

**Export Excel** downloads a workbook with:

- **Summary**: every item with folder, type, description, spec, quantity, unit, allowance %, and
  `QTY + ALLOW` (a live `ROUNDUP` formula).
- **By Page**: quantity of each item on each page.
- **Circuits**: the `PANEL:` layout (`CKT NO | DESCRIPTION | LM | LM (*20%) | TYPE OF WIRE`) for linear items
  named like `LP1-3` or `PPA2-12`, plus the **OTHERS** device counts. The item's *Spec* fills
  TYPE OF WIRE.
- **Pages**: every page with its scale, so you can see which pages are not scaled.

New linear items get a 20% allowance, and area and count items get 0%. Change these defaults in the project panel,
or set the allowance per item.

## Notes

- Lengths and areas are only counted on pages that have a scale. Items with takeoff on unscaled pages show a warning.
- PlanSwift pages that only have a vertical scale use it for both directions.
- Very large sheets are rendered at most 10,000 pixels on the long side.
- Command line: `python server.py import FILE.SwiftJob|FILE.pdf` imports without the browser.
  `python -m unittest discover -s tests` runs the tests.

## License

MIT. See [LICENSE](LICENSE). You are free to use, change and share PlanCraft, including for work.
