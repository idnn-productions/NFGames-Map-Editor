# A 3D view for the map editor: design

Date: 2026-11-19. Status: approved by the user on 2026-11-19, including the file's `y` as the height the 3D view shows and edits.

## Intent

The editor shows a map's plan from above. Height is a typed number ("lift y"), and a lifted piece is
only a see-through rectangle, so stacking things (a tank on a roof, a crate on a stall) is done blind.

Add a **3D view** of the same plan where the user selects a piece, or picks a palette entry, and
moves or places it along X, Y and Z directly. The reference is the three.js editor
(https://threejs.org/editor/); ours should be simpler and fit map work better.

Decided by the user:

- The 3D view shows **boxes from the kinds' footprints** (`size: [w, d, h]`), not the game's models.
  Real models (glTF per kind) are a later step, not this one.
- It does not have to be complex. Select, then place or move.
- Ours rather than three.js's, where ours can be better.

## Goals

- A second view of the **same plan**: the same selection, undo and redo, save, palette, Problems and
  Selected panels as the top view. Switching views loses nothing.
- Move a selected piece along one axis (X, Y or Z) by dragging an arrow, or across the ground by
  dragging its body. Turn it about Y.
- Place a palette entry by clicking where it goes, on the ground or on top of another piece.
- Works for any project with no setup: it needs only what the top view already has.

## Non-goals (this version)

- The game's real models, textures, lighting or shadows.
- Turning about X or Z, or sizing per axis: the file format has `rot` about Y, `scale` and `stretch`
  only, and it stays that way. **No change to `layout.json`, the schemas or the server's API.**
- Box select in 3D (Shift drag stays a top-view tool; Shift or Ctrl click still adds to the selection).
- The project's own layers (`compile` overlays, `overlays`) in 3D. They stay in the top view.
- Editing doors' words and the like in a new way: the right column is unchanged.

## Anti-goals

- A runtime dependency, or any new file served. `CONTRIBUTING.md` asks for a dependency-free editor
  and an unchanged security model.
- A 3D view that disagrees with the top view or the fit check about where something is.
- Breaking the top view, or `npm run check:browser` (which fails on any console error or warning).

## Approaches

1. **3D drawn on the existing 2D canvas** (project the boxes, paint back to front). Least code, but
   no depth test: boxes that touch or stack can paint in the wrong order, which is the case this
   view exists for. Rejected.
2. **Our own small WebGL view. Chosen (the builder's call, the user left the how open).** A second
   canvas draws ground, grid and boxes with a depth buffer; a 2D canvas over it draws the arrows,
   labels and markers. No dependency, no new route, and room for map-specific behaviour (landing on
   the roof under the cursor).
3. **Vendor three.js.** Orbit and transform gizmos ready-made, but a large first dependency and a new
   static route, against the project's rules. Worth revisiting only when real models are wanted.

## The design

### Switching views

Two buttons over the map, top left of the middle column: **Top** and **3D**. Key **Tab** switches
(ignored while typing). `?view=3d` in the address opens in 3D. The left and right columns do not
change. If WebGL is not available, the 3D button is disabled and its tooltip says why.

```
+---------+--------------------------------------+-----------+
| palette | [Top] [3D]      x 2.00 y 3.50 z 2.50 | Save Undo |
| layers  |                                      | Problems  |
| legend  |        boxes on a ground disc,       | Selected  |
| keys    |        ring wall, metre grid         |  x, z     |
|         |             ^ y                      |  turn     |
|         |             |__ x    (on selection)  |  lift y   |
|         |            /                         |           |
|         |           z            N compass     |           |
+---------+--------------------------------------+-----------+
```

### What is drawn

All in the plan's metres, +X east, +Z south, Y up, the same frame as the file.

- **Ground**: a disc (ring map) or rectangle (bounds), with the metre grid when the grid layer is on.
- **Ring wall**: a low wall (2 m, the builder's call) with the gap at the gate.
- **Pieces and marks**: a box per solid part. A kind whose `boxes` cover the whole footprint is one
  box `w x d x h`; a kind with partial `boxes` (the open hall) is one box per entry at full height,
  plus the footprint's outline on the ground. Sizes use the same factors as the top view (`scale`,
  `kindScale`, `stretch`, and `display` scaling). Colour is the class colour (a preset's colour for
  preset pieces), with flat shading per face so shapes read. An unknown kind is a 2 x 2 x 2 m box.
  A short tick on the ground marks the front, as in the top view.
- **Height**: a piece's bottom is at its `y` (0 when absent).
- **Everything else** (where the player arrives, people, things, doors, rounds, hand-placed plants,
  exclusions): flat markers on the ground, drawn on the 2D layer with the same shapes and colours as
  the top view, honouring the Show checkboxes. Rule-made plants are not drawn in 3D.
- **Names**: piece ids, on the 2D layer, when the names layer is on.
- **Selection**: an orange outline box, and the handles below.
- A small **compass** (N and the three axes) in a corner, and the HUD shows x, y, z under the mouse.

### Camera

Orbit about a point on the ground. **Drag empty space** orbits; **right or middle drag** pans along
the ground; **wheel** zooms toward the mouse; **F** fits the map. The camera cannot go under the
ground. Each view keeps its own camera; switching to 3D the first time fits the map.

### Selecting and moving

- **Click** a box or a marker selects it (the nearest thing under the mouse). **Shift or Ctrl click**
  adds or removes. Clicking empty space clears, unless Ctrl is held.
- A single selected **piece** shows three arrows at its base, of fixed size on screen: **X red,
  Y green, Z blue**, and a **ring** on the ground for turning.
  - Drag an arrow: the selection moves along that axis only.
  - Drag the box itself: it slides on the ground at its current height (x and z), as in the top view.
  - Drag the ring: turns in 15 degree steps (Alt: 1 degree), as the top view's handle does.
- Markers (arrival, people, things, free doors, round points, plants) have no height in the file:
  they get the X and Z arrows only and can be dragged on the ground.
- With several selected, the arrows sit on the one clicked last and everything moves together.
- **Snap** is the existing checkbox and step, for all three axes.
- **Landing on things** (the part that is better than the reference): while a piece's Y arrow is
  dragged, its height also catches the top of the solid piece under its middle when within 0.3 m.
  "Top" is what the fit check uses (`deck`, else height, times the host's scale), so a piece landed
  this way raises no `float` warning. Dragging down stops at 0.
- A `y` of 0 is written as no `y` at all, as the panel's "lift y" field does.

### Placing

Pick a palette entry as now. In 3D a see-through box follows the mouse. Over the top of a solid
piece it sits on that top (and the new piece gets that `y`); otherwise it sits on the ground.
Click places it, and the entry stays picked. Plants and presets place on the ground only.

### Keys

All existing keys work in both views. Added: **Tab** switches views; **Page Up / Page Down** lift
or lower the selected pieces one snap step (Shift: 1 m), in both views. In 3D the arrow keys nudge
along the plan axis nearest to the screen direction pressed.

### Scaled maps (`display.planScale`, `kindScale`, `attach`)

The top view draws footprints at the game's size divided by the plan's scale. The 3D view uses the
same factor for a piece's width, depth and height. A lifted piece's `y` is drawn with the factor of
the piece under its middle (so it visibly sits on that roof), else with its own. Values written to
the file are always the plan's numbers, as the fit check reads them.

Scaled maps are **best effort** in this version: picking uses the drawn boxes, landing uses the
plan's geometry (below), and where the two disagree the plan's wins. No scaled fixture map is built;
one unit test covers the drawing factor.

### What a piece can land on (the builder's call)

Landing and placing use **exactly the fit check's hosts**, in the plan's own geometry: pieces on the
ground (`y <= 0.5`), of a known kind, not `solid: false`. Where several are under the point, the
first in file order, as `checkFit` takes. So anything landed this way passes the built-in check.

- Over a lifted piece, an unknown kind or a `solid: false` kind, the ghost and the Y catch ignore it
  and use the ground host under it, else the ground. **Stacking on a stacked piece is out of scope**
  (the fit check does not accept it either); the Y arrow can still put a piece at any height by hand.
- `view3d.mjs` carries its own copy of this small rule (the page cannot import `check.mjs`); a unit
  test holds the two together. `check.mjs` itself does not change.

### Projects whose compile sets heights (confirmed by the user)

A project's `compile` may return `seated` heights (Thoon Run's does, with the built-in check off).
Proposed for this version: **the 3D view is the file's `y`**, always. It draws at `y`, the Y arrow
and landing write `y` by the rules above, and the panel keeps showing "seated at" beside "lift y" as
now. `seated` is not drawn in 3D, because its frame is the project's own.

## How it is built

- **`src/view3d.mjs`** (new): one exported function holding the 3D view's pure parts and its WebGL
  drawing: camera matrices, project and unproject, ray against oriented box, the axis-drag maths,
  "top of what is under this point", and the box and line meshes. The server writes its source into
  the page at a marker, exactly as it does for `plantEditing` from `src/plan.mjs`, so the page stays
  one served file and the maths is unit-tested in Node.
- **`src/editor.html`**: the view switch, a second `<canvas>` (WebGL) under a transparent 2D canvas,
  and the 3D mouse handling. The existing `draw()`, selection, `handle()`, `remember()`, `changed()`
  and panels are reused; `draw()` dispatches on the current view. `window.__map` gains what the
  browser check needs (the view, a 3D `toScreen`, the handles' screen positions).
- **`src/server.mjs`**: only the extra substitution in `page()`.
- No change to `project.mjs`, `check.mjs`, `plan.mjs`, the schemas or the config options.

### Tests

- `test/view3d.test.mjs` (node:test): project then unproject round-trips; a ray picks the nearer of
  two boxes and respects `rot`; an axis drag moves only that axis and snaps; the landing height
  equals what `checkFit` accepts (no `float` warning for the sample's tank on its house).
- `scripts/browser-check.mjs`: switch to 3D, no console errors or warnings; select the crate, drag
  its Y arrow, check `y` rose and x, z did not; undo; place a crate on a house top and check its `y`.
  `--screenshot` also writes `docs/editor-3d.png`.
- `npm test` and `npm run check:browser` pass.

### Docs

README: the 3D view under "Using the editor" (mouse, keys, what is drawn), the Requirements line
("a 2D canvas" becomes "a 2D canvas, and WebGL for the 3D view"), and the screenshot.

## Left to the builder

- The exact shader, shading constants, wall height, arrow sizes and hit tolerances.
- Whether the 2D layer over the WebGL canvas is the existing canvas made transparent or a third one.
- How the camera eases (or does not) when fitting or focusing on a problem.
- Headless Chrome may log a WebGL warning (software rendering). If it does, the browser check may
  launch with flags that avoid it; it must not hide real console errors.
