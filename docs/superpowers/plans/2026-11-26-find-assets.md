# Find every asset, levels on top — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The model viewer lists every `.glb` in a project, with levels in a group of their own at the top, so a
designer opening Thoon Run sees the town, the town pieces and the characters, not only the 27 models of one folder.

**Architecture:** A project gains a second idea beside `modelsDir` (what the palette and New model use):
`assetsDir`, what the viewer browses, which is the project root unless the config says `assets: false`. One
function, `project.resolveAsset(rel)`, answers every request for a model by path, and falls back to `modelsDir` so
paths written before this still open. `listModels` learns to skip build folders and to mark levels.

**Tech Stack:** Node ≥ 20 with no dependencies (`node --test`); the viewer page is plain script in `src/viewer.html`.

**Spec:** `docs/superpowers/specs/2026-11-26-find-assets-design.md` (approved 2026-11-26).

**Branch:** `feature/find-assets`, cut from `feature/pipeline-guards`.

## Global Constraints

- Dependency-free Node ≥ 20, macOS and Windows. No new npm dependency, no process started through a shell.
- A path from a request never leaves the project: real paths are compared, links are not followed out (as
  `resolveModel` does today), and only `.glb` files are served as models.
- A project that works today shows no fewer models, and its open review jobs, drafts and links still work.
- The map editor's palette is unchanged: model kinds still come from `modelsDir` only.
- New model still writes to `models/<name>/`. `plugins/` is not touched.
- Searched: the project root to any depth. Skipped: folders whose name starts with a dot, `node_modules`, `dist`,
  `build`, `out`, `Library`, `Temp`, and links. At most 5,000 models. The list is kept for 2 seconds.
- A level is a `.glb` with a `.json` of the same name beside it, or one the config's `assets.levels` names.
- Commit messages are one plain sentence saying what is now true.

## Review Focus

1. A project with a `models/` folder and jobs written before this change (`job.model.path` is `ship/ship.glb`): the job list, the match and "Send to Claude" still find `models/ship/ship.glb`. Test in Task 3.
2. `assets.skip` or `assets.levels` naming something outside the project, or not a list: refused when the config is read, with the key named. Test in Task 2.
3. Two models with the same file name in different folders, one a level: each opens as itself, and the Levels group shows both names apart. Test in Task 1 (marking) and by hand in Task 4.
4. A project folder with a `.glb` directly in its root: listed, and openable by its bare name. Test in Task 3.
5. A `?model=` link written before (relative to `models`) for a model that now has a longer path: the page opens it. By hand in Task 4.

---

### Task 1: `listModels` skips build folders and marks levels

**Files:**
- Modify: `src/models.mjs` (`listModels`)
- Test: `test/models.test.mjs`

**Interfaces:**
- Produces: `listModels(dir, { skip = [], levels = [] } = {}) -> [{ path, size, mtime, level? }]`.
  `export const SKIPPED = ['node_modules', 'dist', 'build', 'out', 'Library', 'Temp']` (folder names skipped at any
  depth, with dot-folders and links, as today). `skip` is a list of folder paths from `dir`, with `/`, skipped with
  everything under them. `level: true` is set on a model when a file `<name>.json` is beside `<name>.glb`, or its
  path is in `levels`; the key is left out otherwise. Called with one argument it lists what it listed before,
  minus the `SKIPPED` folders.

- [ ] **Step 1: Write the failing tests** in `describe('models')`, on a folder made in the test:

```js
it('skips build and cache copies at any depth, and the folders it is told to', () => {
  // a/x.glb, web/dist/x.glb, web/.cache/x.glb, web/node_modules/p/x.glb, unity/Library/x.glb, art/raw/x.glb, art/town/t.glb
  assert.deepEqual(listModels(top).map((m) => m.path), ['a/x.glb', 'art/raw/x.glb', 'art/town/t.glb']);
  assert.deepEqual(listModels(top, { skip: ['art/raw'] }).map((m) => m.path), ['a/x.glb', 'art/town/t.glb']);
});
it('a model with a .json of its name beside it is a level, and so is one the config names', () => {
  // art/town/t.glb + art/town/t.json ; a/x.glb alone
  const by = Object.fromEntries(listModels(top, { levels: ['a/x.glb'] }).map((m) => [m.path, m.level]));
  assert.deepEqual(by, { 'a/x.glb': true, 'art/raw/x.glb': undefined, 'art/town/t.glb': true });
  assert.equal('level' in listModels(top).find((m) => m.path === 'a/x.glb'), false);
});
```

- [ ] **Step 2: Run** `node --test test/models.test.mjs` — both fail.
- [ ] **Step 3: Implement.** The `.json` is looked for in the names `readdirSync` already returned for that folder (no extra call per model), compared without regard to case.
- [ ] **Step 4: Run** `node --test test/models.test.mjs` — pass, the earlier tests unchanged.
- [ ] **Step 5: Commit:** `Models: build and cache folders are skipped, and a model with its .json beside it is a level`

### Task 2: A project knows what the viewer browses

**Files:**
- Modify: `src/project.mjs` (beside `modelsDir`)
- Test: `test/project.test.mjs`

**Interfaces:**
- Consumes: `listModels(dir, { skip, levels })` (Task 1), `resolveModel(dir, rel)`.
- Produces, on the project object:
  - `assetsDir`: the project root; or `modelsDir` (which may be `null`) when the config has `assets: false`.
  - `assets() -> [{ path, size, mtime, level? }]`: `listModels(assetsDir, { skip, levels })`, kept for 2 seconds; `[]` when `assetsDir` is `null`.
  - `resolveAsset(rel) -> { file, path } | null`: `file` is the real path of the `.glb`; `path` is its path from `assetsDir` with `/`. Tried in this order: `rel` under `assetsDir`; `rel` under `modelsDir` when that is another folder. A skipped folder is still resolved (skipping is about the list, not about access).
  - Config `assets`: `undefined` (the defaults), `false`, or `{ skip?: string[], levels?: string[] }`. Each entry is a path inside the project (checked the way `models` is, with `fail('"assets.skip" …')`); a `levels` entry must end in `.glb`. With `assets: false`, `skip` and `levels` do not apply.

- [ ] **Step 1: Write the failing tests:**

```js
it('the viewer browses the whole project; the palette keeps the models folder', async () => {
  // root: models/ship/ship.glb, art/town/t.glb + t.json, dist/t.glb
  const p = await loadProject({ root, config: {} });
  assert.equal(p.assetsDir, root); assert.equal(p.modelsDir, join(root, 'models'));
  assert.deepEqual(p.assets().map((m) => [m.path, !!m.level]), [['art/town/t.glb', true], ['models/ship/ship.glb', false]]);
  assert.deepEqual(Object.keys(p.modelKinds().kinds), ['model:ship']);                       // the palette is as it was
});
it('a path from before this, from the models folder, still resolves, and comes back as it is now', async () => {
  const p = await loadProject({ root, config: {} });
  assert.equal(p.resolveAsset('ship/ship.glb').path, 'models/ship/ship.glb');
  assert.equal(p.resolveAsset('models/ship/ship.glb').file, realpathSync(join(root, 'models/ship/ship.glb')));
  assert.equal(p.resolveAsset('dist/t.glb').path, 'dist/t.glb');                             // not listed, still there
  for (const bad of ['../x.glb', 'nope.glb', 'art/town/t.json', '']) assert.equal(p.resolveAsset(bad), null);
});
it('assets: false keeps the models folder as the whole list; skip and levels are checked', async () => {
  const off = await loadProject({ root, config: { assets: false } });
  assert.equal(off.assetsDir, join(root, 'models')); assert.deepEqual(off.assets().map((m) => m.path), ['ship/ship.glb']);
  const cfg = await loadProject({ root, config: { assets: { skip: ['art'], levels: ['models/ship/ship.glb'] } } });
  assert.deepEqual(cfg.assets().map((m) => [m.path, !!m.level]), [['models/ship/ship.glb', true]]);
  for (const assets of [{ skip: ['../out'] }, { skip: 'art' }, { levels: ['art/town'] }, 'yes'])
    await assert.rejects(loadProject({ root, config: { assets } }), /assets/);
});
```

Adapt `modelKinds` and `loadProject`'s call to how `test/project.test.mjs` already uses them; keep the assertions.

- [ ] **Step 2: Run** `node --test test/project.test.mjs` — fail on `assetsDir` undefined.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit:** `A project knows every model in it for the viewer, and still finds one by its old path`

### Task 3: The viewer's routes, review jobs and the match use it

**Files:**
- Modify: `src/server.mjs` (`/api/viewer`, `/api/models`, `/api/model`, `/api/model/refs`, `/api/model/ref`), `src/match.mjs` (`plan`), `src/reviews.mjs` (creating a job, listing jobs), `bin/nfgames-map-editor.mjs` (the line it prints)
- Test: `test/viewer-server.test.mjs`, `test/match.test.mjs`, `test/reviews.test.mjs`

**Interfaces:**
- Consumes: `project.assets()`, `project.resolveAsset(rel)`, `project.assetsDir` (Task 2).
- Produces:
  - `GET /api/models` → `{ models: project.assets() }` (each with `level: true` where it is one).
  - `GET /api/viewer` → as today, with `models` now `project.rel(assetsDir) || '.'` (or `null`), and a new `root`: the project folder's name.
  - `/api/model`, `/api/model/refs`, `/api/model/ref`, `match.plan(rel)` and review jobs resolve through `resolveAsset`, and use its `path` for everything keyed or stored by path: the references (`listRefs(assetsDir, path)`), the match's memo and result's `model`, and a new job's `model.path`. `job.model.file` stays the path from the project root.
  - The reviews error for a project with no models keeps its text, now when `assetsDir` is `null`.

- [ ] **Step 1: Write the failing tests:**
  - `viewer-server`: a project with `models/ship/ship.glb`, `art/town/t.glb` + `t.json`, `top.glb` in the root and `dist/t.glb`: `/api/models` lists `art/town/t.glb` (level), `models/ship/ship.glb` and `top.glb`, not `dist/t.glb`; `/api/model?path=` answers 200 for `models/ship/ship.glb`, for `ship/ship.glb` (the old path) and for `top.glb`, and 404 for `../x.glb` and `art/town/t.json`; `/api/model/refs?path=ship/ship.glb` lists the references in `models/ship/ship.refs/`; `/api/viewer` has `models: '.'` and `root`.
  - `reviews`: a job sent for `ship/ship.glb` is written with `model.path === 'models/ship/ship.glb'` and `model.file === 'models/ship/ship.glb'`; a job file written by hand with `model.path: 'ship/ship.glb'` is listed with its model found (not marked missing).
  - `match`: `matcher.status('ship/ship.glb')` and `matcher.status('models/ship/ship.glb')` give the same `key` and the same `references`.
- [ ] **Step 2: Run** the three files — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — pass. Tests elsewhere that assert a job's `model.path` for a project with a `models/` folder change to the new path; say which in the commit body.
- [ ] **Step 5: Commit:** `The model viewer, review jobs and the match find a model anywhere in the project`

### Task 4: The list shows levels on top; the docs say so; it is tried on Thoon Run

**Files:**
- Modify: `src/viewer.html` (`listModels`, `drawModelList`, `openModel`, the `?model=` start), `README.md` (the model viewer's section, the config table: `models`, new `assets`; "Opening a project"), `todo.md`

**Interfaces:**
- Consumes: `/api/models` with `level`, `/api/viewer`'s `models` and `root` (Task 3); `nfTree.build` and `nfTree.render` as they are.
- Produces, in the page:
  - A folder **Levels** first in the list, holding every model with `level: true`, each shown by its file name without `.glb` (two levels of one name: the folder is added, `town (art/town)`), its tooltip the path and size as today. A level is listed there only, not again under its folder. With no levels there is no Levels folder.
  - Models directly in the project root are listed under a folder named `root`.
  - Opening, the current-row mark, the remembered open and closed folders and the filter work for a level as for any model (the filter matches a level by its real path too: `search` in `nfTree.build`).
  - A `?model=` that is not in the list opens the one model whose path ends with `/<that>`; when none or several do, the page says `no such model: <that>`.
  - The empty text: `no .glb files in this project` (or, with `assets: false`, the folder's name as today).

- [ ] **Step 1: Implement** the list, the root folder and the `?model=` fallback.
- [ ] **Step 2: Try it on Thoon Run.** Start the editor on `../thoon-run-main` (`node bin/nfgames-map-editor.mjs --project ../thoon-run-main --port 8799`; its config is the game's own and is run). Then:
  - `curl -s http://127.0.0.1:8799/api/models` lists models from `web/thoon-run/public/assets/models`, `art/town/models`, `art/export/townsfolk` and `web/thoon-run/public/assets/town/town.glb` with `level: true`, and none from `dist/` or `.cache/`. Put the counts per folder in the commit body.
  - In the map editor, the palette's **Models** group holds the same pieces as on `feature/pipeline-guards` (the models of `web/thoon-run/public/assets/models` only).
  - Open `/viewer` in a browser: **Levels** is first with `town`; a character from `art/export/townsfolk` opens with its reference images; the filter `town` shows the level and the town pieces; `/viewer?model=barrel.glb` opens the barrel.
  Stop the editor afterwards.
- [ ] **Step 3: Write the words.** README: what the viewer lists and skips, what a level is, the `assets` key (`skip`, `levels`, `false`) in the config table, and that `models` is now what the palette and New model use. `todo.md`: tick nothing that is not done; add "a level opened with its sky, spawn and walk grid" and "levels that are not a .glb (Thoon Run's cave)" under Viewer.
- [ ] **Step 4: Run** `npm test` and `npm run check:browser` — pass.
- [ ] **Step 5: Commit:** `Model viewer: every model in the project, with levels first`
