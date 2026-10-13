# PlanCraft

A free, offline takeoff app that works like PlanSwift and runs in your browser.
Open plans, set the scale, click out counts, lengths and areas, and export the quantities to Excel.
It also opens your existing PlanSwift `.SwiftJob` files, including their pages, scales and takeoff.

## Start it

Double-click **`PlanCraft.bat`**. The first time, it installs the Python libraries it needs
(PyMuPDF, Pillow, openpyxl, OpenCV, numpy), which needs internet. After that it runs offline. PlanCraft opens in your browser at
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

## Auto count

1. Select a **count** item (or create one with **+ Count**) and pick **Auto count** (A).
2. Zoom to the area you are counting, then drag a box tightly around **one** symbol. PlanCraft finds the
   look-alikes (by default only in the part of the page on screen, so legends and title blocks don't get in the way).
3. Check the circles: green will be added, grey is already counted, and clicking a circle skips it (red).
   Drag a box over the plan to skip every circle in it (hold Shift to keep them instead).
   The **Match strength** slider finds more (lower) or fewer (higher).
4. Press **Add** (or Enter).

There are two methods, and **Automatic** picks one from your box:

- **Symbol shape** compares the whole symbol. Best for distinct symbols such as circled J boxes, panels and shaped
  fixtures. **Also find turned symbols** handles rotated ones.
- **Dots on wires** is for lights drawn as a filled dot on the circuit wire, solid or dithered grey, also inside
  hatched areas. It ignores the wire and the circuit number next to the dot. Results depend on how clean the
  sheet is, so always look over the circles before adding.

## Compare revisions

Open a page and press **Compare** (or right-click a page and choose **Compare with another revision**). Pick the other
page, for example the new revision you added with **Add plans**:

- **Red** is only on this page, **green** only on the other page, and **black** is on both (unchanged).
- If the sheets don't line up, press **Align** and click a point on the red drawing, then the same point on the green
  one. Do it twice (two points far apart) to fix size and rotation too.
- **Copy takeoff to the other page** puts this page's takeoff (and notes) on the new revision using the alignment.
  You can copy or move it. Then adjust whatever changed.
- **Swap** opens the other page with this one as the overlay.

## Notes and highlighter

- **Note** (N): click on the plan and type. Pick the font, font size, bold or italic, the text, note and pin colours,
  and the note width. Tick **Grow and shrink with the plan** to make it behave like text printed on the drawing.
  With **Select**: click a note to show its outline, then drag the note to move it, or drag any of the 8 handles to set
  its size by hand (the left and bottom handles also move the box away from its pin). Drag the little circle (the
  pin) to point the note at something else; the box stays put, and with **Snap** on the pin lands exactly on a takeoff point. Right-click and choose
  **Fit note to text** to go back to automatic sizing. Double-click to edit, and **Del** removes it. New notes reuse
  the last style.
- **Highlight** (H): drag to highlight, and hold Shift for a straight line. The colour box next to the tools sets the colour.
- The speech-bubble button shows or hides all notes and highlights. They are never counted as takeoff, and the
  notes are listed in a **Notes** sheet in the Excel export.

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

**Finding an item:** type in **Search items** and click a result. PlanCraft opens the page with its takeoff and zooms
to it. If the item is on several pages, click it again for the next one. Without a search, clicking an item that has
no takeoff on the open page also switches to its page.

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
- **Notes**: every note written on the plans, with its page.
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

## Disclaimer

PlanCraft is an independent project. It is not affiliated with, endorsed by, or sponsored by PlanSwift or its owners. "PlanSwift" is a trademark of its respective owner and is mentioned here only to describe compatibility with `.SwiftJob` files.

PlanCraft is provided "as is", without warranty of any kind (see [LICENSE](LICENSE)). Always check quantities before using them in an estimate, bid or order.
