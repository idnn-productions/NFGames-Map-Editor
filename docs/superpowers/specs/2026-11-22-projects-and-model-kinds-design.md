# Open any project, move between the editor and the viewer, models as palette kinds: design

Date: 2026-11-22. Status: approved by the user on 2026-11-22, section by section.

## Intent

The editor serves the one project it was started on, the editor and the model viewer do not link to each other,
and a game's models must be listed by hand in `kit.json` before they can be placed. The user wants to:

1. pick the project from inside the browser, by browsing the drive, in the editor and in the viewer;
2. move between the editor and the viewer;
3. have a project's models load into the editor's palette by themselves.

Decided by the user:

- The browser picks a **project folder** (not single files). Both pages follow the chosen project.
- It sees the **home folder** only, without hidden folders.
- Models become **palette kinds only** for now (sized from their bounds, still drawn as boxes). Real models in the
  3D view stays in `todo.md`.

## Goals

- A **project bar** on both pages: *Map editor | Model viewer*, the project's name, **📁 Open project…**.
- A folder browser under `~`: breadcrumbs, Up, folders marked *project* or *N models*, recent projects, Open.
- Switching project at run time; a project with no maps opens (the editor says so; the viewer works).
- A folder's `map-editor.config.mjs` runs only after the user trusts it; trust is kept per file and content hash.
- Every `.glb` under the project's models folder is a kind in the palette, named `model:<name>`, sized from the
  model's bounds read from its GLB header, cached by file version; `kit.json` entries of the same name win.
- The viewer keeps the open model in its address (`/viewer?model=…`); a model piece in the editor links to it.

## Non-goals

- Opening single files from outside a project. Browsing outside the home folder.
- Drawing real models in the editor's 3D view. Per-folder model scale. Thumbnails.
- Creating a new map from the editor (to `todo.md`).

## The design

### The current project (server)

`createEditor(project, { …, home, stateDir })` keeps the project in a variable that `POST /api/project` replaces.
The Apply jobs are re-created with it. `--project` sets the first; `bin` starts with no maps too, and trusts and
records the project it was started on.

### Browsing (`src/home.mjs`)

- `browse(home, path)`: the path's real path must be the real home folder or inside it (symlinks followed only
  when they land inside). Returns `{ path, name, parent, home, project, models, entries: [{ name, path, project,
  models }] }`: sub-folders only, none starting with `.`, at most 2000. `project`: the folder has a
  `map-editor.config.mjs`, `maps/` or `data/maps/`. `models`: `.glb` files directly in it.
- Trust: `~/.nfgames-editor/trusted.json` maps a config's real path to the SHA-256 of its contents.
  `configTrust` → `none` | `trusted` | `ask`. Recent: `~/.nfgames-editor/recent.json`, ten at most, existing only.

### Routes

- `GET /api/projects` → `{ current: { root, name, title, maps }, recent, home }`.
- `GET /api/browse?path=` → `browse(…)`; 400 outside home.
- `POST /api/project { root, trust }` (Origin and JSON checks): outside home → 400; an Apply job running → 409;
  a config not yet trusted and `trust` not true → `{ needsTrust: true, config }`, nothing runs; a config that
  throws → 400 and the current project stays; else switch and `{ ok, root, maps }`.

### Config defaults

- `models`: as given; `false` or `null` for none; when not given, `models/` if the project has one, else the
  project's own folder. `listModels` skips `node_modules`.
- `modelKinds: false` turns model kinds off.
- A config file is imported with a `?v=<modified time>` query, so a changed config is read again on a switch.

### Model kinds (`src/glb.mjs`, `src/modelkinds.mjs`)

- `glbJson(file)` reads only the GLB header and its JSON chunk. `sceneBounds(json)` walks the default scene's
  nodes (matrix, or translation, rotation, scale; children) and combines each mesh POSITION accessor's
  `min`/`max` corners: `{ min, max }` in glTF metres, Y up, the editor's own frame.
- Names: `model:` + the file name (lower case; other characters `_`; `m` in front of a leading digit). Names that
  collide get their parent folders added until they do not.
- A kind: `{ cls: 'model', group: 'Models · <folder>', label, model: <path>, size: [w, d, h], boxes: [[cx, cz,
  w, d]] }` (the box sits where the model is when its origin is not at its middle). Parsed once per file size and
  modified time; the folder is listed at most every 2 seconds.
- An unreadable GLB is a kind with no size (drawn 2 x 2 m) and a `model` problem naming the file.
- The class `model` is built in: teal, "a model from the models folder".

### Pages

- `src/nav.html`: the project bar and the folder dialog (markup, style, script), written into both pages where
  they say `<!--@nav-->`. Opening a folder asks before losing unsaved map changes, asks to trust a config, then
  reloads the page on the new project.
- Editor: the bar at the top of the left column; "no maps yet" when the project has none; a **View model** link on
  a selected model piece; a problem with no place is not focused.
- Viewer: the bar in its header; `?model=` opens that model on load and follows the open model.

### Security

Still loopback only, Host check, Origin and JSON on every POST. New: folder names under the home folder (no
hidden folders, no contents) can be listed by the editor's own page; a project switch runs a folder's config only
once the user has trusted that exact file.

## Tests

`node --test`: bounds (translation, rotation, scale, matrix, children, off-centre origin, broken file); names
(rules, collisions); model kinds (kit wins, cache, `modelKinds: false`, unreadable file → problem); browse (home
only, `..`, outside paths, symlinks out, hidden folders); trust (ask, trusted, changed asks again); switching over
HTTP (both pages' data follow, trust asked, job running refused, a throwing config keeps the old project, a project
with no maps opens). Browser: open Khairos through the dialog, see its models in the palette, place one, move
between the pages.
