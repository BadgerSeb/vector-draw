# Vector Draw

A vector drawing app in the browser, in the spirit of Illustrator, for Badger Metal & Machine
Fabrication: artwork, layouts and cut files drawn to scale. Plain HTML/CSS/ES modules, no build
step, no CDN. It installs as an app (PWA) and works offline. Files never leave the computer.

## Running it

    powershell -ExecutionPolicy Bypass -File tools\serve.ps1      # http://localhost:8132/

On localhost the service worker is off unless the address has `?sw`, so you always run the files
as they are on disk.

## What it does

- **Tools:** Selection (move, scale with handles, Shift keeps proportions, Alt from the center,
  rotate just outside a corner, Alt-drag copies), Direct Selection (anchors and Bézier handles,
  box-select anchors), Pen (corners, curves, close, continue an open path; click an anchor to
  delete it or a segment to add one), Add/Delete/Convert Anchor, Pencil (smoothed), Line,
  Rectangle, Rounded Rectangle, Ellipse, Polygon, Star, Type, Eyedropper, Hand, Zoom.
  Clicking with a shape tool asks for an exact size.
- **Appearance:** fill and stroke (color, none, linear/radial gradient fills), stroke weight in pt,
  dashes, caps, joins, opacity, swatches with the Badger colors.
- **Objects:** group/ungroup, arrange, lock/hide, layers (add, rename, reorder, show/hide, lock,
  move selection to layer), align and distribute (to selection or artboard), flip, rotate 90°,
  Move/Rotate/Scale by numbers, X/Y/W/H fields with a reference point, in document units.
  Number fields take fractions and sums (`3/16`, `1 1/2`, `2+0.125`).
- **Paths:** Unite, Minus Front, Intersect, Exclude, Offset Path (kerf), Round Corners, Join,
  Reverse, compound paths (holes). Every shape is an editable path.
- **View:** zoom and pan (wheel, Ctrl/Alt+wheel, Space-drag), rulers, grid, snap to grid, snap to
  points, smart guides.
- **Files:** .vdraw (the app's own JSON), open/place SVG and DXF and pictures, export SVG (real
  units), PDF (vector, gradients as shadings), PNG at any dpi, DXF R12 to scale (`$INSUNITS`,
  closed polylines, arcs as bulges, circles as CIRCLE).

Units: documents are stored in pixels at 96 per inch; the document's units (in, mm, px) are for
display, rulers, the grid and exports.

## Layout

| Path | What |
| --- | --- |
| `js/app.js` | start-up, menus, keyboard, open/save/export |
| `js/state.js` | shared state, settings (localStorage), events, undo commit |
| `js/doc.js` | document model, units, bounds, transforms, history |
| `js/geom.js` | matrices, Bézier maths, shape builders, flattening |
| `js/render.js` | model to SVG (canvas and SVG export) |
| `js/view.js` | zoom/pan, canvas drawing, selection overlay, grid, rulers |
| `js/tools.js` | what each tool does with the mouse |
| `js/ops.js` | commands on the selection, layers, clipboard |
| `js/pathops.js` | boolean operations and offset (Clipper) |
| `js/pathtools.js` | joining, anchors, reversing |
| `js/panels.js` | tool column, options bar, right-hand panels |
| `js/io/import.js` | SVG, DXF (exact lines/arcs/circles/ellipses/polylines), pictures |
| `js/io/export.js` | PDF, PNG, DXF |
| `js/dxf/` | DXF reader shared with PDF Combiner |
| `vendor/` | pdf-lib (MIT), Clipper 6.4.2 (Boost) |

## Testing

    powershell -ExecutionPolicy Bypass -File tests\ui-test.ps1

Runs an invisible Edge with its own profile, draws with synthesized mouse and keyboard input,
exports every format, re-opens them, checks the DXF scale and opens the DXFs in `tests\samples`
(not in the repo). Results and screenshots go to `tests\out\ui`.

## Publishing

`publish.ps1 "what changed"` stamps a new version into `sw.js`, commits and pushes. GitHub Pages
picks it up in about a minute and installed copies update themselves.
