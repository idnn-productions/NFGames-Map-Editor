# Folding lists, workbench layout and New model: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the map and the model the workbench's width, make both left lists fold and filter, and add a three-step
"New model" screen that ends with an approved concept image and approved view images saved in the project.

**Architecture:** The map editor and model viewer stay pages in frames. `lend.js` grows from lending one column to
lending named parts to the workbench's side panel, Inspector and bottom panel. A shared classic script draws folding
lists. New model is a bundled plugin (`plugins/model-maker`) whose server part owns the drafts and whose page part
calls the existing `nfgames.codex-image/image` service; the plugin API gains what that needs.

**Tech Stack:** Node 20, no runtime dependencies, plain HTML/JS pages, `node:test`. Browser checks use
`playwright-core` (not a dependency: `npm i --no-save playwright-core`).

**Spec:** `docs/superpowers/specs/2026-11-23-layout-folders-and-new-model-design.md`. Read it first; this plan argues
from it.

## Global Constraints

- No new runtime dependency. No build step. The map page (`src/editor.html`) has no modules: anything it shares is a
  classic script that sets a global, like `src/shell/grid.js`.
- `/map?alone` and `/viewer?alone` (and any page not in a frame: `window.top === window`) keep both of their own
  columns and behave as today.
- The map is never narrower than today at any window width.
- Save, Problems and Selected each appear exactly once on screen.
- No generation runs without the user pressing a button for that run.
- Plugins reach the project only through `api.files` and declared `touches`. `model-maker` does not import `node:fs`.
- Code style follows the files around it (dense lines, a comment block at the top of each file saying what it is).
  User-facing text is plain words, sentence case.
- Work on a branch `layout-folders-new-model`. Run `npm test` before every commit; it must pass.
- Each part (1, 2, 3) updates `README.md` for what it changed, in the task that ends the part.

## Review Focus

1. **A project with thousands of models or kinds** (`listModels` allows 5000): folding and filtering stay responsive;
   the list is not rebuilt on every keystroke for closed folders. Test in Task 1.
2. **A narrow window (1024 px) with wide kept panel widths:** the document area keeps at least 320 px; kept widths are
   clamped on load and on window resize. Test in Task 6.
3. **A draft name that is not a safe folder name** (`../x`, emoji, empty, 300 characters, a name already taken): the
   slug is safe and unique, the shown name is kept as typed. Test in Task 10.
4. **The tab closes or the workbench reloads during a generation:** the round is pending on reopen, then done with its
   images or failed, never lost and never stuck pending. Test in Task 10 (`reconcile`) and Task 11.
5. **A symlink inside `.nfgames/` that points outside the project:** `api.files` and the image route refuse it. Test in
   Task 8.

---

## Part 1: Folding lists

### Task 1: `src/shell/tree.js`

**Files:**
- Create: `src/shell/tree.js`
- Test: `test/tree.test.mjs`
- Modify: `src/server.mjs` only if `/shell/tree.js` is not already served by the rule that serves `/shell/grid.js`

**Interfaces:**
- Produces: `globalThis.nfTree = { build, render, store }` (a classic script; the test loads it with
  `await import('../src/shell/tree.js')` and reads `globalThis.nfTree`).
  - `build(items, { filter = '', closed = new Set() }) → node[]`. `items`: `[{ path: 'a/b/name', ...rest }]`, already
    sorted. A node is `{ type: 'folder', path, label, count, open, children }` or `{ type: 'item', item, label }`.
    `count` is every item under the folder after filtering. A folder with exactly one child folder and no items of its
    own is joined to it (`label: 'a/b'`, `path: 'a/b'`). With a non-empty `filter` (matched case-insensitively against
    `item.path` and `item.search` when present) folders without a match are dropped and the rest have `open: true`
    regardless of `closed`. Items with no `/` in `path` sit at the top level, after `rootLabel` handling by the caller.
  - `render(box, nodes, { row, onToggle })`: draws into `box`. A folder is a `button.tree-folder` with
    `aria-expanded`, text `▸ label` or `▾ label` and a `.tree-count`; its children sit in a `.tree-kids` div, which is
    not built while the folder is closed. `row(item) → Element` draws an item. `onToggle(path, open)` is called on
    click and on Enter/Space.
  - `store(key) → { closed: Set, toggle(path, open) }`, kept in `localStorage` under `nfgames.tree.<key>`; a blocked
    `localStorage` gives a store that works for the page's life.

- [ ] **Step 1: Write the failing tests** in `test/tree.test.mjs`:

```js
const items = (...paths) => paths.map((path) => ({ path }));
it('groups by folder, counts, and joins a chain of single folders', () => {
  const t = nfTree.build(items('web/run/public/models/a.glb', 'web/run/public/models/b.glb', 'art/town/c.glb'), {});
  assert.deepEqual(t.map((n) => [n.label, n.count]), [['art/town', 1], ['web/run/public/models', 2]]);
  assert.deepEqual(t[1].children.map((n) => n.label), ['a.glb', 'b.glb']);
});
it('nests folders that hold items and folders', () => {
  const t = nfTree.build(items('art/a.glb', 'art/town/b.glb'), {});
  assert.equal(t[0].label, 'art'); assert.equal(t[0].count, 2);
  assert.deepEqual(t[0].children.map((n) => n.type), ['folder', 'item']);
});
it('closed folders are closed; a filter opens matches and drops the rest', () => {
  const closed = new Set(['art']);
  assert.equal(nfTree.build(items('art/a.glb', 'kit/b.glb'), { closed })[0].open, false);
  const f = nfTree.build(items('art/a.glb', 'kit/b.glb'), { closed, filter: 'A.GL' });
  assert.deepEqual(f.map((n) => [n.label, n.open, n.count]), [['art', true, 1]]);
});
it('top-level items come through without a folder', () => {
  assert.deepEqual(nfTree.build(items('a.glb'), {}).map((n) => n.type), ['item']);
});
it('5000 items build in under 50 ms', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i % 50}/g${i % 7}/m${i}.glb` }));
  const t0 = performance.now(); nfTree.build(many, { filter: 'm49' }); assert.ok(performance.now() - t0 < 50);
});
```

- [ ] **Step 2: Run** `node --test test/tree.test.mjs`. Expected: FAIL, `nfTree` is undefined.
- [ ] **Step 3: Implement `build`, `render`, `store`** in `src/shell/tree.js`. `render` and `store` touch `document`
  and `localStorage` only when called, so the import in the test does not need a DOM.
- [ ] **Step 4: Run** `node --test test/tree.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "A folding list, shared by the viewer and the palette"`.

### Task 2: The viewer's model list folds

**Files:**
- Modify: `src/viewer.html` (`drawModelList`, the `.group` style, a `<script src="/shell/tree.js">`)
- Test: `test/viewer-server.test.mjs` (the page serves and names the script)

**Interfaces:**
- Consumes: `nfTree.build`, `nfTree.render`, `nfTree.store` (Task 1).

- [ ] **Step 1: Failing test:** `GET /viewer?alone` contains `/shell/tree.js`, and `GET /shell/tree.js` is 200 with a
  JavaScript content type.
- [ ] **Step 2: Run** `node --test test/viewer-server.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `drawModelList` builds from `models` (each already `{ path }`) with the filter box's text
  and `nfTree.store('viewer:' + <project root from /api/projects current.root>)`. All folders start open. The root
  folder's items (no `/`) are shown under a folder labelled `<info.models>/`. `openModel(m)` opens the folder holding
  `m` (removes its ancestors from `closed`) before drawing, so `/viewer?model=…` and **View model** show the current
  row. Keep `title` (path and size) and the `current` class on rows.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Then by hand: `npm start -- --port 8794`, open a project with
  models in two folders, close one, reload: it is still closed; type in the filter: matches show with folders open.
- [ ] **Step 5: Commit** `git commit -m "Model viewer: folders open and close"`.

### Task 3: The map palette folds and filters

**Files:**
- Modify: `src/editor.html` (`buildPalette`, `markPalette`, `#left` markup: an `<input id="palFilter"
  placeholder="filter pieces" autocomplete="off">` above `#palette`; a `<script src="/shell/tree.js">`)
- Modify: `README.md` (Using the editor: the palette's filter and folders; Model review: folders)
- Test: `test/server.test.mjs` (the page serves and names the script and `palFilter`)

**Interfaces:**
- Consumes: `nfTree` (Task 1).

- [ ] **Step 1: Failing test:** `GET /map?alone` contains `id="palFilter"` and `/shell/tree.js`.
- [ ] **Step 2: Run** `node --test test/server.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `buildPalette` makes one item list and draws it with `nfTree`:
  - presets: `path: '<group>/<label>'`; plants: `path: 'Plants (plants.json)/<label>'`;
  - kinds with a group of the form `Models · a/b` (set in `src/modelkinds.mjs`): `path: 'Models/a/b/<label>'`;
    `Models · .` or a bare `Models` group: `path: 'Models/<label>'`;
  - other kinds: `path: '<group>/<label>'`, with the same `Other` / `Pieces` fallback as today, in today's group order
    (`UI.groups` first). Do not sort across groups; within a group keep today's order.
  - `search` on each item is its kind id, so the filter finds `kit:house` as well as "house".
  - `row(item)` returns the same button as today (title, swatch, size text, tag, `dataset.kind`, click to place).
  - store key `'palette:' + <project root>`; groups start open.
  `markPalette` opens the folder of the picked kind when it is closed. A folder's kids are laid out with the existing
  `.pal` grid class.
- [ ] **Step 4: Run** `npm test`, then `npm run check:browser`. Expected: both PASS (the browser check places a piece
  from the palette).
- [ ] **Step 5: Update `README.md`**, then commit `git commit -m "Map palette: a filter, and groups that open and close"`.

---

## Part 2: Layout

### Task 4: `lend.js` lends named parts; the Inspector and bottom panel take them

**Files:**
- Modify: `src/shell/lend.js`, `src/shell/workbench.js` (`renderSide`, `renderInspector`, `renderBottom`, the
  `nf:panel` listener), `src/shell/index.html` (an id on the Inspector's title: `inspectorTitle`),
  `src/shell/workbench.css`
- Create: `src/shell/core/lent.js` (pure: which lent part a region shows)
- Test: `test/shell-core.test.mjs`

**Interfaces:**
- Produces (page side): `window.nfLend(parts) → { byId(id), setTitle(region, title) }` where
  `parts = { side?: { el, title, css? }, inspector?: { el, title, css? }, bottom?: { el, title, key, css? } }`.
  It sets `window.__nfLent = { side?, inspector?, bottom? }`, each `{ title, key?, mount(host), unmount() }` with
  today's shadow-root behaviour. While a part is mounted the page's `body` has class `lent-<region>`. `byId` searches
  every mounted part. `setTitle` changes `title` and dispatches `nf:panel` on `window.top.document`.
  `window.nfLendPanel(aside, opts)` stays as `nfLend({ side: { el: aside, ...opts } })` and `__nfPanel` stays as
  `__nfLent.side`, until Tasks 5 and 7 stop using them; Task 7 removes both.
- Produces (workbench side): `lentFor(region, { activeTool, frame })` in `src/shell/core/lent.js` returns the lent part
  for `region` or `null`: `side` only when no tool is active (as today); `inspector` and `bottom` whenever the shown
  document is a frame that lends one.
- Workbench behaviour: with a lent `inspector`, `#inspectorTitle` shows its title and `#inspectorBody` mounts it; else
  the Inspector is as today. With a lent `bottom`, a tab `{ key: 'lent/' + part.key, title: part.title }` is added
  after Output and mounts the part when chosen. Parts are unmounted when the shown document changes, in the same place
  the side panel's is today (`workbench.js:220`).

- [ ] **Step 1: Failing tests** in `test/shell-core.test.mjs` for `lentFor`:

```js
const frame = { side: { title: 'S' }, inspector: { title: 'I' }, bottom: { title: 'B', key: 'reviews' } };
assert.equal(lentFor('side', { activeTool: null, frame }), frame.side);
assert.equal(lentFor('side', { activeTool: 'x/tool', frame }), null);
assert.equal(lentFor('inspector', { activeTool: 'x/tool', frame }), frame.inspector);
assert.equal(lentFor('bottom', { activeTool: null, frame: null }), null);
assert.equal(lentFor('inspector', { activeTool: null, frame: { side: frame.side } }), null);
```

- [ ] **Step 2: Run** `node --test test/shell-core.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `lent.js`, the new `lend.js`, and the workbench's use of both.
- [ ] **Step 4: Run** `npm test` and `npm run check:browser`. Expected: PASS; the pages look as before (nothing lends
  an Inspector yet).
- [ ] **Step 5: Commit** `git commit -m "Pages can lend parts to the Inspector and the bottom panel"`.

### Task 5: The map page: a toolbar, Selected in the Inspector, problems in the bottom tab

**Files:**
- Modify: `src/editor.html` (markup of `<main>` and `#right`, styles for `body.lent-inspector`, `note`,
  `renderProblems`, the **View model** link, the `nfLendPanel` call at line 114)
- Modify: `src/shell/workbench.js` (`window.nfWorkbench`, the Problems tab's rows)
- Modify: `scripts/browser-check.mjs` (find Save and Selected where they now are when run through the workbench; add a
  check that a problem row in the bottom tab selects on the map)
- Test: `test/shell-core.test.mjs` (problems store), `test/server.test.mjs`

**Interfaces:**
- Consumes: `nfLend` (Task 4).
- Produces: `window.nfWorkbench` on the workbench's window:
  - `setProblems(source, list, goTo)`: `source` a string (`'map'`), `list` `[{ kind, text }]`, `goTo(index)` called
    when a row is clicked. `setProblems(source, [])` clears. Counted with plugins' problems in the tab title and the
    status bar. Cleared for a source when its frame's document closes.
  - `openView(view, query)`: `view` is `'map'` or `'viewer'`; shows that view's tab (opening it if needed) and, when
    `query` is given, sets the frame's address to `/<view>?<query as search params>` if it differs.
- Page behaviour when embedded (`window.top !== window`):
  - `#toolbar` over the canvas, beside `#viewBar`: Save, Undo, Redo, snap, the map picker (`#maps`), then `#status` as
    one line, ellipsised, with the full text as its `title`. These elements keep their ids. They are in `<main>`, not
    lent.
  - Lent to the Inspector: one element holding `#applyBox`, `#statusPanels`, `#helpBox`, `#log` (under an `h2` "Map")
    and `#sel`. The lent title is `Selected` when something is selected, else `Map` (`setTitle` from
    `renderSelected`).
  - `renderProblems` calls `top.nfWorkbench.setProblems('map', list, goTo)` and does not draw `#problems`; the
    Problems heading and list are not in the lent element.
  - **View model** is a button calling `top.nfWorkbench.openView('viewer', { model: k.model })`.
  - `body.lent-side.lent-inspector` gives `<main>` the whole page.
- Not embedded: the right column is as today, except `note()`.
- `note(text)` returns an empty `DocumentFragment` when there is no text (so `append` prints nothing).

- [ ] **Step 1: Failing tests.** In `test/shell-core.test.mjs`, a pure `createProblems()` moved to
  `src/shell/core/problems.js`: `set('map', [{kind:'door',text:'x'}], goTo)`, `count() === 1`,
  `all()[0].source === 'map'`, `go(0)` calls `goTo(0)`, `set('map', [])` → `count() === 0`, `drop('map')`. In
  `test/server.test.mjs`: `GET /map?alone` contains `id="toolbar"`.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. Plugins' `api.problems.set` (`workbench.js:48`) uses the same store with
  the plugin's id as source and no `goTo`.
- [ ] **Step 4: Run** `npm test`; update and run `npm run check:browser`. Expected: PASS. By hand at 1440 x 900 on a
  project with problems: no `null` under the ring fields; Save works from the toolbar and with ⌘S; clicking a problem
  in the bottom tab pans and selects; **View model** shows the viewer tab on that model; `/map?alone` is as before.
- [ ] **Step 5: Commit** `git commit -m "Map editor: a toolbar over the map, Selected in the Inspector, problems in one place"`.

### Task 6: The bottom strip, and panel widths

**Files:**
- Create: `src/shell/core/layout.js`
- Modify: `src/shell/workbench.js` (`togglePanel`, `renderBottom`, the `LAYOUT_KEY` load at line 140),
  `src/shell/workbench.css`, `src/shell/index.html` (two handles: `#sideGrip`, `#inspectorGrip`)
- Test: `test/shell-core.test.mjs`

**Interfaces:**
- Produces: in `src/shell/core/layout.js`:
  - `DEFAULTS = { side: 260, inspector: 280, bottom: 'strip', bottomHeight: 220 }`
  - `clampWidths({ side, inspector }, windowWidth) → { side, inspector }`: each at least 200; the two together leave
    at least 320 for the documents (plus the 46 px activity bar); when they do not fit, both shrink in proportion, not
    below 200; when even 200 + 200 does not fit, the Inspector is 0 (hidden).
  - `readLayout(text) → layout` and `writeLayout(layout) → text`: bad or missing JSON gives `DEFAULTS`.
- Behaviour: `#bottom` has two states, `strip` (tabs only, one line, the default) and `open`. Clicking a tab opens it
  on that tab; clicking the shown tab, or the bar's existing bottom toggle, returns to the strip. It never opens by
  itself. While a job runs (`jobs/started` until `jobs/done`) the Jobs tab shows a `●`. The existing hide toggles
  still hide a region entirely. Grips drag to set widths (pointer events, `col-resize`); widths, the bottom's state and
  height are kept under the existing `LAYOUT_KEY` object (migrate today's array of hidden keys: read it as
  `{ hidden: [...] }`). Widths are clamped on load and on `resize`. Frames get `pointer-events: none` while dragging.

- [ ] **Step 1: Failing tests:**

```js
assert.deepEqual(clampWidths({ side: 260, inspector: 280 }, 1440), { side: 260, inspector: 280 });
assert.deepEqual(clampWidths({ side: 100, inspector: 900 }, 1440), { side: 200, inspector: 874 });
{ const w = clampWidths({ side: 500, inspector: 500 }, 1024); assert.ok(w.side >= 200 && w.inspector >= 200 && 1024 - 46 - w.side - w.inspector >= 320); }
assert.deepEqual(clampWidths({ side: 260, inspector: 280 }, 700), { side: 200, inspector: 0 });
assert.deepEqual(readLayout('not json'), DEFAULTS);
assert.deepEqual(readLayout('["bottom"]').hidden, ['bottom']);
```

- [ ] **Step 2: Run** `node --test test/shell-core.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run check:browser`. By hand: at 1440 x 900 the map is about 850 px wide and
  runs to the strip; drag both grips, reload: widths are kept; shrink the window to 1024: the map keeps its room.
- [ ] **Step 5: Commit** `git commit -m "Workbench: the bottom panel rests as a strip; side panel and Inspector resize"`.

### Task 7: The viewer page lends its right column; Part 2's docs

**Files:**
- Modify: `src/viewer.html` (the `nfLendPanel` call at line 83, styles for `body.lent-inspector`, `#right` markup
  split into a review element and a jobs element), `src/shell/lend.js` (remove `nfLendPanel` and `__nfPanel`),
  `src/shell/workbench.js` (stop reading `__nfPanel`)
- Modify: `README.md` (Opening a project / Using the editor / Model review: where things are now), `docs/editor.png`,
  `docs/editor-3d.png`, `docs/viewer.png` (retake: `npm run screenshot`; the viewer's by hand at the same size)
- Test: `test/viewer-server.test.mjs`

**Interfaces:**
- Consumes: `nfLend` (Task 4).
- Behaviour when embedded: Pins, Note, Workflow, the warning and **Send to Claude** are lent to the Inspector with
  title `Review`; the review jobs list (`#jobs` and its heading's content) is lent to the bottom as
  `{ key: 'reviews', title: 'Reviews' }`. `/viewer?alone` is as today.

- [ ] **Step 1: Failing test:** `GET /shell/lend.js` no longer contains `nfLendPanel`; `GET /viewer?alone` contains
  `nfLend(`.
- [ ] **Step 2: Run** `node --test test/viewer-server.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run check:browser`. By hand: open a model, drop a pin, write a note in the
  Inspector, switch to the Map tab and back: the pin and note are still there; the Reviews tab lists the jobs.
- [ ] **Step 5: Retake the screenshots, update `README.md`, commit**
  `git commit -m "Model viewer: review in the Inspector, its jobs in the bottom panel"`.

---

## Part 3: New model

### Task 8: Plugin API 1.1.0: file answers, `files.remove`, real paths

**Files:**
- Modify: `src/plugins/manifest.mjs` (`API_VERSION = '1.1.0'`), `src/plugins/manager.mjs` (`makeApi`, `route`),
  `src/server.mjs` (the `/api/p/` handler at line 171), `docs/plugins.md`
- Test: `test/plugins-manager.test.mjs`, `test/plugins-server.test.mjs`

**Interfaces:**
- Produces:
  - `api.files.remove(rel)`: removes a file or a folder with its contents; same checks as `write`; a missing path is
    not an error. The project root itself and a glob's own top folder named exactly cannot be removed unless the path
    matches a declared glob (as for `write`).
  - `api.files.*` all check the **real** path: after the glob check, the nearest existing ancestor of the target is
    resolved with `realpathSync` and must be inside `realpathSync(project.root)`; else
    `Error('<id>: <rel> is outside the project')`.
  - `api.routes.file(rel) → answer`: a value a route handler may return. `route()` then returns
    `{ status: 200, file: { path, type } }` and the server sends the bytes with `Content-Type` from the extension
    (`.png` `image/png`, `.jpg`/`.jpeg` `image/jpeg`, `.webp` `image/webp`, `.json` `application/json`, `.txt`
    `text/plain; charset=utf-8`, else `application/octet-stream`), `X-Content-Type-Options: nosniff`,
    `Cache-Control: no-store`. A missing file is 404 `{ error: 'not here' }`.
  - Plugins declaring `engines.nfgames: "^1.0.0"` still load.

- [ ] **Step 1: Failing tests.**
  - manager: a plugin declaring `touches.files: ['.x/**']` can `write('.x/a/b.txt')`, `remove('.x/a')`, then
    `exists('.x/a') === false`; `remove('maps/plaza/layout.json')` throws `/did not declare/`; with `.x/link` a
    symlink to a folder outside the project, `read('.x/link/secret.txt')`, `write('.x/link/new.txt', 'x')` and
    `remove('.x/link/secret.txt')` each throw `/outside the project/` and the outside file is unchanged.
  - server: a route returning `api.routes.file('.x/p.png')` answers 200 with `content-type: image/png`,
    `x-content-type-options: nosniff` and the file's exact bytes; for a missing file, 404. `GET /api/plugins` gives
    `api: '1.1.0'`.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Update `docs/plugins.md`** (the API list, a "Since 1.1.0" note), commit
  `git commit -m "Plugin API 1.1.0: routes can answer with a file, files.remove, real paths checked"`.

### Task 9: `codex-image` takes a folder name

**Files:**
- Modify: `plugins/codex-image/server.mjs`, `plugins/codex-image/plugin.json` (`version: 1.1.0`)
- Test: `test/services.test.mjs` (where the stand-in `codex` is used today)

**Interfaces:**
- Produces: service `nfgames.codex-image/image`, action `generate`, input
  `{ prompt, count = 1, references = [], folder? }`. `folder` is one path segment matching `/^[a-z0-9][a-z0-9-]{0,79}$/`;
  images go to `.nfgames/images/<folder>/`. Anything else: `Error('folder: a short name of letters, digits and dashes')`.
  A folder that already holds images: `Error('folder: <name> is already used')`. Without `folder`, the time-stamped
  name as today. Result `{ images, folder }` as today (`folder` is the full project-relative path). On failure the
  thrown error has `error.folder` set to that path, and the service's `services/done` event and the HTTP error body
  carry it as `folder` (check how `src/services.mjs` and `src/server.mjs` pass error fields; add `folder` there).

- [ ] **Step 1: Failing tests:** a call with `folder: 'lantern-concept-1'` saves under
  `.nfgames/images/lantern-concept-1/` and returns that folder; `folder: '../x'` and `folder: 'A B'` are refused
  with `/folder:/` and nothing is written; a second call with the same folder is refused with `/already used/`; when
  the stand-in `codex` exits non-zero, the HTTP error body has `folder: '.nfgames/images/lantern-concept-2'`.
- [ ] **Step 2: Run** `node --test test/services.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Codex image: the caller can name the folder; a failure says where it was saving"`.

### Task 10: `model-maker`: the draft's rules

**Files:**
- Create: `plugins/model-maker/draft.mjs`
- Test: `test/model-maker-draft.test.mjs`

**Interfaces:**
- Produces (all pure; functions return a new draft and do not change their argument):
  - `VIEWS = ['front', 'back', 'left', 'right']`, `EXTRA_VIEWS = ['three-quarter', 'top']`
  - `slugOf(name, taken = new Set()) → string`: lower case, runs of anything outside `[a-z0-9]` become `-`, trimmed
    of `-`, at most 40 characters, `'model'` when empty; `-2`, `-3`… appended while taken.
  - `newDraft({ slug, name, description = '', style = '' }) → draft`:
    ```js
    { version: 1, slug, name, description, style, status: 'concept', refs: [],
      concept: { rounds: [], pick: null, approved: null },          // approved: the image path that was approved
      views: { list: [...VIEWS], prompts: {}, rounds: {}, picks: {}, approved: false } }
    ```
    A round is `{ id, folder, prompt, count, state: 'pending' | 'done' | 'failed', images: [], error: null, at }`.
    `name` is trimmed and cut to 200 characters; an empty name throws `/name/`.
  - `viewPrompt(draft, view) → string`: `draft.views.prompts[view]` when set, else the description, the style when
    present, and a fixed part naming the view (same object as the reference image, seen from that side, orthographic,
    plain neutral background, even light, whole object in frame, no text).
  - `folderFor(draft, step, now) → string`: `<slug>-<step>-<time>` fitting Task 9's pattern (at most 80 characters).
  - `startRound(draft, step, { prompt, count, folder, at }) → { draft, round }`: `step` is `'concept'` or a name in
    `views.list`, else throws `/step/`. A view step needs `concept.approved`, else throws `/concept/`. `count` is
    clamped to 1–8. Starting a view round when `status === 'ready'` sets `status: 'views'`, `views.approved: false`.
  - `settleRound(draft, step, id, { images = [], error = null }) → draft`: `state` is `'done'` when there is at least
    one image and no error, else `'failed'`; images are kept either way. Unknown id throws `/round/`.
  - `reconcile(draft, { imagesIn, busy }) → draft`: for each pending round, `imagesIn(round.folder)` (a list of
    paths); with images and not `busy` → `done`; none and not `busy` → `failed` with
    `error: 'This run was interrupted.'`; while `busy` it stays pending.
  - `pickConcept(draft, image)`, `pickView(draft, view, image)`: the image must be in one of that step's rounds, else
    throws `/image/`. `pickView` when `status === 'ready'` sets it back to `'views'`.
  - `approveConcept(draft, { confirm = false }) → draft`: needs a pick, else throws `/pick/`. When
    `concept.approved` is another image and any view has a round or a pick: without `confirm` throws an error with
    `code: 409` and `needsConfirm: true`; with it, `views.picks = {}`, `views.approved = false`, and the views'
    rounds are kept. Sets `concept.approved = pick`, `status: 'views'`.
  - `setViews(draft, { list, prompts })`: `list` is a non-empty subset of `VIEWS` and `EXTRA_VIEWS`, in that order;
    picks of removed views are dropped; `status` `'ready'` → `'views'`.
  - `approveViews(draft) → draft`: every view in `list` has a pick, else throws `/every view/`. Sets
    `views.approved: true`, `status: 'ready'`.
  - `filesToKeep(draft) → { concept: path | null, views: { [view]: path } }`: what the server copies to
    `concept.png` and `views/<view>.png`; `views` is empty unless `views.approved`.

- [ ] **Step 1: Write the failing tests** in `test/model-maker-draft.test.mjs`, one `it` per rule above, including:

```js
assert.equal(slugOf('Brass Lantern!'), 'brass-lantern');
assert.equal(slugOf('../../etc'), 'etc'); assert.equal(slugOf('🏮'), 'model'); assert.equal(slugOf(''), 'model');
assert.equal(slugOf('x'.repeat(300)).length, 40);
assert.equal(slugOf('Brass lantern', new Set(['brass-lantern', 'brass-lantern-2'])), 'brass-lantern-3');
assert.equal(newDraft({ slug: 'a', name: '  Brass 🏮 ' }).name, 'Brass 🏮');
// a tab closed mid-run
let { draft, round } = startRound(newDraft({ slug: 'a', name: 'A' }), 'concept', { prompt: 'p', count: 4, folder: 'a-concept-1', at: 1 });
assert.equal(reconcile(draft, { imagesIn: () => [], busy: true }).concept.rounds[0].state, 'pending');
assert.equal(reconcile(draft, { imagesIn: () => ['.nfgames/images/a-concept-1/image-1.png'], busy: false }).concept.rounds[0].state, 'done');
assert.match(reconcile(draft, { imagesIn: () => [], busy: false }).concept.rounds[0].error, /interrupted/);
// a new concept clears the approved views, only after a yes
// (build a draft at status 'ready', pick another concept image)
assert.throws(() => approveConcept(ready2), (e) => e.code === 409 && e.needsConfirm === true);
const back = approveConcept(ready2, { confirm: true });
assert.equal(back.status, 'views'); assert.deepEqual(back.views.picks, {}); assert.deepEqual(filesToKeep(back).views, {});
assert.throws(() => startRound(newDraft({ slug: 'a', name: 'A' }), 'front', { prompt: 'p', count: 1, folder: 'f', at: 1 }), /concept/);
assert.throws(() => approveViews(oneViewUnpicked), /every view/);
```

- [ ] **Step 2: Run** `node --test test/model-maker-draft.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `draft.mjs`.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Model maker: a draft's steps and rules"`.

### Task 11: `model-maker`: the server part

**Files:**
- Create: `plugins/model-maker/plugin.json`, `plugins/model-maker/server.mjs`
- Test: `test/model-maker-server.test.mjs` (a host as in `test/plugins-server.test.mjs`, with the real
  `plugins/model-maker` and `plugins/codex-image` as built-ins and the stand-in `codex` on the PATH)

**Interfaces:**
- Consumes: `draft.mjs` (Task 10); `api.files.remove`, `api.routes.file` (Task 8).
- Produces: plugin `nfgames.model-maker`, `engines.nfgames: "^1.1.0"`, `server: "server.mjs"`, `web: "web/index.js"`,
  `touches: { files: ['.nfgames/drafts/**', '.nfgames/images/**'] }`,
  `contributes: { editors: [{ id: 'new-model', title: 'New model' }], commands: [{ id: 'new-model', title: 'New model' }] }`,
  `activation: ['onRoute', 'onEditor:new-model', 'onCommand:new-model']`.
- Routes under `/api/p/nfgames.model-maker/` (JSON unless said; errors as `{ error }` with the rule's message):

| Route | Body or query | Answer |
|---|---|---|
| `GET /drafts` | | `{ drafts: [{ slug, name, status }], style }` (`style` from `.nfgames/drafts/style.txt`, `''` when none) |
| `POST /drafts` | `{ name, description, style }` | `{ draft }`; writes `draft.json`, and `style.txt` when `style` is not empty |
| `GET /draft` | `?slug` | `{ draft }`, reconciled (and saved when reconciling changed it) |
| `POST /draft/save` | `{ slug, name?, description?, style?, views?: { list, prompts } }` | `{ draft }` |
| `POST /draft/ref` | `{ slug, name, data }` (`data`: a `data:image/(png\|jpeg\|webp);base64,` URL) | `{ draft }`; saved as `refs/ref-<n>.<ext>`; at most 8, else 400 |
| `POST /draft/unref` | `{ slug, ref }` | `{ draft }` |
| `POST /draft/round` | `{ slug, step, prompt, count }` | `{ draft, round, input }` where `input` is the image service's input: `{ prompt, count, references, folder }`. `references`: the draft's refs for `concept`; `[<slug>/concept.png path]` plus nothing else for a view |
| `POST /draft/settle` | `{ slug, step, round, images?, error? }` | `{ draft }` |
| `POST /draft/pick` | `{ slug, step, image }` | `{ draft }` |
| `POST /draft/approve` | `{ slug, step: 'concept' \| 'views', confirm? }` | `{ draft }`; `{ needsConfirm: true, error }` with 409 when Task 10 says so. Copies per `filesToKeep`: `concept.png`; `views/<view>.png`; removes `views/` when the picks were cleared or a view left the list |
| `POST /draft/delete` | `{ slug }` | `{}`; removes `.nfgames/drafts/<slug>/` only |
| `GET /image` | `?path` (under `.nfgames/images/` or `.nfgames/drafts/`, an image extension) | the file (`api.routes.file`) |

  `slug` in every route must match `/^[a-z0-9][a-z0-9-]{0,45}$/` and name an existing draft, else 404. A `draft.json`
  with a `version` other than 1, or unreadable, is listed as `{ slug, name: slug, status: 'unreadable' }` and refused
  by the other routes with 422.
  For `reconcile`, `busy` is whether the host's current job is running: check how a plugin can learn that
  (`GET /api/job` is the page's way); if the server API has no way, the page passes `busy` to `GET /draft` as
  `?busy=1` after asking `/api/job`. Say which in the task's commit message.
  Plugin routes that throw an error with a `code` of 409: check that `manager.route` passes the status and extra
  fields through (today every throw is a 500, `src/plugins/manager.mjs:138-139`); extend it so an error's `code`
  (400–499) and `needsConfirm` reach the answer, with a test in `test/plugins-server.test.mjs`.

- [ ] **Step 1: Failing tests:** create → list shows it; a name `'../x'` gives slug `x` and writes only under
  `.nfgames/drafts/x/`; round → `input.folder` matches Task 9's pattern → call `/api/services/call` with
  `{ key: 'nfgames.codex-image/image', action: 'generate', input, confirmed: true }` → settle with its images → pick →
  approve concept → `.nfgames/drafts/<slug>/concept.png` has the picked image's bytes; a view round's
  `input.references` is `['.nfgames/drafts/<slug>/concept.png']`; approve views before every pick is 400; after all
  picks, `views/front.png` exists and status is `ready`; picking another concept then approve is 409 with
  `needsConfirm`, and with `confirm: true` `views/` is gone; a round left pending whose folder has an image comes back
  `done` from `GET /draft`; `GET /image?path=.nfgames/drafts/<slug>/concept.png` is the PNG; `?path=maps/plaza/layout.json`
  and `?path=.nfgames/../package.json` are refused; a 3 MB `data` is refused by the body limit with a 4xx; delete
  removes the draft folder and leaves `.nfgames/images/`.
- [ ] **Step 2: Run** `node --test test/model-maker-server.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Model maker: drafts kept in the project, over the plugin's routes"`.

### Task 12: `model-maker`: the screen, and where it starts

**Files:**
- Create: `plugins/model-maker/web/index.js`, `plugins/model-maker/web/steps.js` (the three steps' drawing),
  `plugins/model-maker/web/shrink.js` (an image file → a JPEG data URL, longest side 2048 px, quality stepped down
  from 0.9 until the URL is under 1.8 MB), `plugins/model-maker/web/style.css`
- Modify: `src/viewer.html` (a **＋ New model** button above the filter and a "Drafts" folder above the models, both
  only when embedded and when `GET /api/plugins` lists `nfgames.model-maker` as usable), `src/shell/workbench.js`
  (`nfWorkbench.run(commandId, args)` so a framed page can run a workbench command)
- Modify: `README.md` (a "New model" section; the plugin in the Plugins list), `todo.md` (add "Generate the model from
  a draft's `concept.png` and `views/`: step ③ of New model"; tick nothing), `docs/plugins.md` if it lists bundled plugins
- Test: `test/model-maker-server.test.mjs` (the web part is served), `scripts/browser-check.mjs` (a New model run with
  the stand-in `codex`)

**Interfaces:**
- Consumes: Task 11's routes; `api.services.call('nfgames.codex-image/image', 'generate', input)`;
  `api.documents.open`, `api.editors.register`, `api.commands.register` (as `plugins/classic/web/index.js` uses them);
  `nfTree` (Task 1) for the Drafts folder.
- Produces: command `new-model` with optional `{ slug }`: no slug opens a tab `New model` on step ①; a slug opens
  `New model: <name>` at the draft's step. One tab per draft (opening it again shows the existing tab).
  `window.nfWorkbench.run('nfgames.model-maker/new-model', { slug })` from the viewer page (check the id form commands
  take when registered by a plugin and use that).
- The screen, per the spec's "New model" section:
  - Step bar `① Concept — ② Views — ③ Model`; ② is reachable when `concept.approved`, ③ when `status === 'ready'`.
  - ① Name, Describe it, Style (prefilled from `/drafts`' `style`), References (file picker, drop, paste; each
    through `shrink.js` then `/draft/ref`; a remove button on each), How many (1–8, default 4), **Generate**. The
    draft is created (`POST /drafts`) on the first Generate, with the name as typed. Then: `/draft/round` →
    `api.services.call` with its `input` → `/draft/settle`. Candidates of the newest round as a grid; earlier rounds
    under a closed "earlier rounds" fold; a failed round shows its error and any images it has. Clicking a candidate
    picks it (`/draft/pick`); **Use this one → Views** approves. On 409 `needsConfirm`: `confirmDialog` saying the
    approved views will be cleared; yes sends `confirm: true`.
  - ② The approved concept on the left. One row per view: its name, its prompt (a textarea showing `viewPrompt`'s text
    from the server's draft; editing saves through `/draft/save`), a count (default 2), **Generate** for that view,
    its candidates, the pick. Checkboxes for which views are listed. **Generate views** runs every listed view that
    has no round yet, one after another. **Approve views** is enabled when every listed view has a pick.
  - ③ The concept and the approved views, the line `Saved in .nfgames/drafts/<slug>/`, a disabled **Generate model**
    button, and the text "Model generation comes in a later update." **Delete draft** (with `confirmDialog`) is on
    every step.
  - While a run is going its Generate button shows "Generating…" and is disabled; other steps' inputs stay usable.
  - A `busy` refusal from the service shows the service's message on the step ("busy: … is running") and settles the
    round as failed with that error.
  - When `GET /api/services` shows `nfgames.codex-image/image` missing or not `connected`: every Generate button is
    disabled with the line "Image generation is not connected." and a button **Open Services** (command
    `core/services`). Drafts still open and read.
  - On opening a draft with a pending round: show it as "Generating…" and ask `GET /draft` again every 5 s until no
    round is pending.
- The viewer's "Drafts" folder lists `/drafts` as rows `<name> · <status>`; a click runs the command with the slug.
  It refreshes on the plugin's `nfgames.model-maker/changed` event (emit it from the server after each change:
  `api.events.emit('changed', { slug })`; check how a framed page can hear host events, else refresh on tab focus).

- [ ] **Step 1: Failing tests:** `GET /plugins/nfgames.model-maker/web/index.js` (the path form plugin web parts are
  served under; see `test/plugins-server.test.mjs`) is 200. In `scripts/browser-check.mjs`, with the stand-in `codex`:
  open the viewer, press ＋ New model, type a name and description, Generate, pick the first candidate, Use this one,
  Generate views, pick one per view, Approve views; then `.nfgames/drafts/<slug>/concept.png` and
  `views/front.png`, `back.png`, `left.png`, `right.png` exist, step ③ shows a disabled Generate model, no console
  errors. Reload the workbench, open the draft from Drafts: it is on step ③.
- [ ] **Step 2: Run** `node --test test/model-maker-server.test.mjs` and `npm run check:browser`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run check:browser`. Expected: PASS. By hand, with the real Codex signed in,
  make one model through to step ③; close the tab during a view generation and reopen the draft: the round arrives.
- [ ] **Step 5: Update `README.md` and `todo.md`, commit** `git commit -m "New model: concept, then views, kept as a draft for the model step to come"`.

---

## After the last task

Run `npm test` and `npm run check:browser` once more on the whole branch. Read the spec's Goals and Anti-goals against
the running workbench at 1440 x 900 and at 1024 x 768, on `examples/sample` and on a project with models.
