# Model Generation in New Model: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In New model, any image opens large, can be marked with notes and sent back for another round, a bottom view exists, and step ③ generates the 3D model through ComfyUI and Blender.

**Architecture:** The draft rules stay pure in `plugins/model-maker/draft.mjs`; its server routes meet the files; the page gains two small modules (large view, notes). A new built-in plugin `nfgames.comfy-model` provides a `model` service that talks to ComfyUI over HTTP and runs Blender as a job step, reading the workflow and the finish script from the user's checkout of the workflows repository. That repository gains an API-format workflow, a `pipeline.json` and a status route, and is published last.

**Tech Stack:** Node ≥ 20 with no dependencies (`node:test`, global `fetch`, `FormData`, `Blob`); browser ES modules and canvas; Python (ComfyUI custom node, `aiohttp` routes via `PromptServer`); Blender headless.

**Spec:** `docs/superpowers/specs/2026-11-23-model-generation-design.md`

Two repositories: **E** = this repository (branch `model-generation`), **W** = the local checkout of the workflows repository (branch `main`).

## Global Constraints

- Dependency-free Node ≥ 20, macOS and Windows; no new npm dependency; no process started through a shell.
- Tests pass on both systems without ComfyUI, Blender or Codex installed (`npm test` in E: 0 failures).
- Plugins touch project files only under `touches.files` and programs only from `touches.commands`.
- Draft files stay `version: 1`; every added field is optional and older drafts open unchanged.
- No GPU run starts without a button press; real generations are run one at a time, only when ComfyUI's queue is empty.
- Limits: pins ≤ 12, pin note ≤ 300 characters, overall note ≤ 1000, count 1 to 8 (default 2 for a revision), generation wait ≤ 30 minutes, triangles default 60000.
- Nothing published carries this machine's paths, user name or install names.
- Commits in E are authored as the earlier ones on the branch; commit messages end with the Claude co-author line.

## Review Focus

1. A pin placed at the very edge or corner (x or y of 0 or 1), or sent as a string or NaN: clamped or refused with a 400, never written into the draft as is. (Task 1)
2. A revision asked for an image whose file was tidied away: refused with a plain message before a round is started. (Task 2)
3. ComfyUI answering slowly, with HTML, or not at all during `status`: each check fails on its own with its own text within 5 seconds; `status` never throws. (Task 6)
4. ComfyUI finishing "success" with no GLB in its outputs, or `/view` answering 404: the job fails saying so and nothing is written under `models/`. (Task 7)
5. The draft's name giving a slug whose model folder already holds other files: only `<slug>.glb` and `<slug>.refs/` are replaced, nothing else there is removed. (Task 7)

---

### Task 1: Draft rules: bottom view, revisions, the model record

**Files:**
- Modify: `plugins/model-maker/draft.mjs`
- Test: `test/model-maker-draft.test.mjs`

**Interfaces:**
- Produces:
  - `EXTRA_VIEWS = ['three-quarter', 'top', 'bottom']`; `MODEL_SIDES = ['front', 'left', 'back', 'right']`, `MODEL_POLES = ['top', 'bottom']` (exported).
  - `whereOf(x, y) -> string`: one of nine phrases from a 3×3 grid, thirds at 1/3 and 2/3: `'upper left' | 'top centre' | 'upper right' | 'left side' | 'centre' | 'right side' | 'lower left' | 'bottom centre' | 'lower right'`.
  - `cleanNotes({ pins, note }) -> { pins: [{ x, y, note }], note }`: x and y numbers clamped to 0..1 (a non-number refuses `pins: …`), pin note trimmed and cut to 300, pins without a note dropped, at most 12 (more refuses), note trimmed and cut to 1000; refuses `notes: say what to change` when nothing is left.
  - `revisionPrompt(draft, step, round, { pins, note }) -> string`: the round's own prompt, a blank line, then the revision text (exact copy in Step 3).
  - `startRevision(draft, step, { image, pins, note, count, folder, at, marked }) -> { draft, round }`: as `startRound`, the round also has `from: image`, `pins`, `note`, `marked` (path of the marked copy or null); count default 2.
  - `modelViews(draft) -> { views: [view], missing: [view] }`: `views` = MODEL_SIDES that are picked (when `views.approved`) plus both MODEL_POLES when both are picked; `missing` = MODEL_SIDES not in the draft's list or not picked.
  - `setModel(draft, { path, length, at }) -> draft` with `draft.model = { path, length, at }`; refuses unless `status === 'ready'`.

- [ ] **Step 1: Write the failing tests** in `test/model-maker-draft.test.mjs` (new `describe('revisions and the model step')`):

```js
it('bottom is a view that can be listed, after top', () => {
  const d = setViews(base(), { list: ['bottom', 'front', 'top'] });
  assert.deepEqual(d.views.list, ['front', 'top', 'bottom']);
  assert.match(viewPrompt(d, 'bottom'), /straight up from below/);
  assert.match(viewPrompt(d, 'top'), /nose|front of the object pointing to the top of the picture/i);
});
it('whereOf names the ninth of the picture', () => {
  assert.equal(whereOf(0, 0), 'upper left'); assert.equal(whereOf(0.5, 0.5), 'centre');
  assert.equal(whereOf(1, 1), 'lower right'); assert.equal(whereOf(0.5, 0.1), 'top centre'); assert.equal(whereOf(0.9, 0.5), 'right side');
});
it('cleanNotes clamps, cuts and refuses', () => {
  const c = cleanNotes({ pins: [{ x: -1, y: 2, note: ' wrong window ' }, { x: 0.5, y: 0.5, note: '' }], note: 'x'.repeat(1200) });
  assert.deepEqual(c.pins, [{ x: 0, y: 1, note: 'wrong window' }]); assert.equal(c.note.length, 1000);
  assert.throws(() => cleanNotes({ pins: [{ x: 'a', y: 0, note: 'n' }] }), /pins/);
  assert.throws(() => cleanNotes({ pins: Array.from({ length: 13 }, () => ({ x: 0, y: 0, note: 'n' })) }), /at most 12/);
  assert.throws(() => cleanNotes({ pins: [], note: '  ' }), /say what to change/);
});
it('a revision is a new round of the step, made from the image', () => {
  const d0 = withConceptRound(base());                      // helper: one done concept round with images a.png, b.png
  const { draft, round } = startRevision(d0, 'concept', { image: 'a.png', pins: [{ x: 0.1, y: 0.1, note: 'no antenna' }], note: '', folder: 'f2', at: 2, marked: 'm.png' });
  assert.equal(round.from, 'a.png'); assert.equal(round.count, 2); assert.equal(round.state, 'pending'); assert.equal(round.marked, 'm.png');
  assert.match(round.prompt, /1 \(upper left\): no antenna/); assert.match(round.prompt, /markers are not part of the picture/);
  assert.equal(draft.concept.rounds.length, 2);
  assert.throws(() => startRevision(d0, 'concept', { image: 'zzz.png', pins: [], note: 'n', folder: 'f', at: 1 }), /not an image/);
});
it('a view from an earlier concept cannot be revised', () => { /* round.concept !== approved -> /made from the approved concept/ */ });
it('modelViews: four sides needed, the poles only as a pair', () => {
  assert.deepEqual(modelViews(ready(['front', 'back', 'left', 'right', 'top'])), { views: ['front', 'left', 'back', 'right'], missing: [] });
  assert.deepEqual(modelViews(ready(['front', 'back', 'left', 'right', 'top', 'bottom'])).views, ['front', 'left', 'back', 'right', 'top', 'bottom']);
  assert.deepEqual(modelViews(ready(['front', 'back', 'three-quarter'])).missing, ['left', 'right']);
});
it('setModel records the model on a ready draft only', () => { /* ready -> draft.model deepEqual {path,length,at}; concept-status draft throws */ });
```

- [ ] **Step 2: Run** `node --test test/model-maker-draft.test.mjs`. Expected: the new tests fail (functions not exported).

- [ ] **Step 3: Implement** in `draft.mjs`. Exact copy:
  - `SIDES.bottom = 'straight up from below'`.
  - The drafted view prompt's last paragraph becomes: `The same object as in the reference image, unchanged in shape, proportions, colours and materials, seen ${SIDES[view]} (${view} view). Orthographic, no perspective. The whole object in frame with nothing cropped, centred, on a plain neutral grey background, in even soft light, with no shadow on the ground, no text and nothing else in the picture.` and, for `top` and `bottom` only, one more sentence: `The front of the object pointing to the top of the picture, and its length and width in the same proportion as the reference shows.`
  - Revision text: `Revise the first reference image: make the same picture again with only the changes listed here, and leave everything not mentioned exactly as it is.` then one line per pin `N (where): note`, then `Also: <note>` when there is one, then `The second reference image is the first with numbered markers showing where each change belongs. The markers are not part of the picture and must not appear in the result.` (omit that last paragraph when `marked` is null), and for a view `The last reference image is the concept the object comes from.`

- [ ] **Step 4: Run** `node --test test/model-maker-draft.test.mjs`. Expected: all pass.
- [ ] **Step 5: Commit** `New model: a bottom view, revisions with notes, and the model record, as draft rules`.

### Task 2: Routes: revise, model

**Files:**
- Modify: `plugins/model-maker/server.mjs`
- Test: `test/model-maker-server.test.mjs`

**Interfaces:**
- Consumes: Task 1's `startRevision`, `cleanNotes`, `setModel`, `modelViews`.
- Produces:
  - `POST /draft/revise { slug, step, image, pins, note, count, marked }` → as `/draft/round`: `{ draft, prompts, round, input: { prompt, count, references, folder } }`. `marked` is a `data:image/png;base64,…` URL of at most 6 MB decoded, or absent; saved as `.nfgames/drafts/<slug>/marks/<round folder>.png`. `references` = `[image, marked path (if any), …(a view: '<draft dir>/concept.png')]`.
  - `POST /draft/model { slug, path, length }` → `{ draft, prompts }`; 400 unless `path` is exactly `models/<slug>/<slug>.glb` and `length` a number > 0. (The plugin cannot read `models/`: the page calls this only after the service answered with that path.)
  - `GET /draft` answers also `model: modelViews(draft)`.

- [ ] **Step 1: Write the failing tests:**
  - `revise`: after one concept round, revise its first image with one pin and `marked: PNG_1PX` → 200; `input.references` is `[image, '.nfgames/drafts/<slug>/marks/<folder>.png']`, that file exists, `input.prompt` matches `/1 \(upper left\)/`; running `input` through the image service and settling gives a second done round with `from`.
  - `revise` of an image whose file was removed from disk → 400 matching `/no longer there/`, and the draft's round count is unchanged.
  - `revise` with `marked: 'data:image/svg+xml;base64,AAAA'` → 400; with no pins and an empty note → 400.
  - `revise` of a view image → `references` ends with `…/concept.png`.
  - `model`: on a ready draft, `path: 'models/<slug>/<slug>.glb', length: 40` → 200 and `draft.model.length === 40`; `path: 'models/other/x.glb'` → 400; a draft not ready → 400.
- [ ] **Step 2: Run** `node --test test/model-maker-server.test.mjs`. Expected: new tests fail with 404.
- [ ] **Step 3: Implement** the two routes and the `model` field of `GET /draft`.
- [ ] **Step 4: Run** the file again. Expected: all pass.
- [ ] **Step 5: Commit** `New model: routes to revise an image from notes and to record the model`.

### Task 3: The page: large view, and picking by a control

**Files:**
- Create: `plugins/model-maker/web/large.js`
- Modify: `plugins/model-maker/web/steps.js`, `plugins/model-maker/web/style.css`, `scripts/browser-check.mjs`

**Interfaces:**
- Produces: `openLarge({ host, images: [{ path, src, caption, pickable, picked }], index, onPick: async (path) => void, extra: (image, close) => Node | null }) -> close()`. Overlay `div.mm-large` appended to `host`; `img.mm-large-img`; buttons `.mm-large-prev`, `.mm-large-next`, `.mm-large-close`, `.mm-large-pick` (only when `pickable`); ← → Esc keys while open; a click on the backdrop closes. `extra` is where Task 4 puts its notes panel.
- In `steps.js`: every `pic(...)` opens the large view on click, over the images of its own round (references and summary images: over their own group). A pickable tile gets `button.mm-pick` in its corner (text `Pick`, `Picked` with class `on` when it is the pick); the tile keeps class `on` when picked.

- [ ] **Step 1: Change the browser check first** (`scripts/browser-check.mjs`, the New model section): picking uses `.mm-pic .mm-pick` instead of a click on `.mm-pic`; add: click the first concept tile → `.mm-large` is visible, `.mm-large-next` changes `.mm-large-img`'s `src`, Escape removes `.mm-large`; `.mm-large-pick` picks (the tile gets `on`).
- [ ] **Step 2: Run** `npm run check:browser`. Expected: fails at the first `.mm-pick`.
- [ ] **Step 3: Implement** `large.js` and the `steps.js` and `style.css` changes, in the shell's theme variables.
- [ ] **Step 4: Run** `npm run check:browser` and `npm test`. Expected: both pass.
- [ ] **Step 5: Commit** `New model: every image opens large; picking is its own control`.

### Task 4: The page: notes on an image, and sending it back

**Files:**
- Create: `plugins/model-maker/web/notes.js`
- Modify: `plugins/model-maker/web/steps.js`, `plugins/model-maker/web/style.css`, `scripts/browser-check.mjs`

**Interfaces:**
- Consumes: Task 3's `openLarge` (`extra`), Task 2's `/draft/revise`.
- Produces:
  - `notesPanel({ image: HTMLImageElement, onSend: async ({ pins, note, count, marked }) => void }) -> Node`: button `.mm-notes-add` (`Add notes`) turns the mode on; a click on the image adds a pin (`.mm-pin`, numbered, positioned by percentage over the image); list `.mm-notes-list` with one `textarea` (maxlength 300) and a remove button per pin; `textarea.mm-notes-all` (maxlength 1000); number field (1 to 8, default 2); `.mm-notes-send` (`Regenerate from this`), off until a pin has a note or the overall note has text; the 13th click adds nothing and says `At most 12 pins`.
  - `markedCopy(image, pins) -> Promise<string>`: PNG data URL: the image drawn on a canvas at most 1536 px on its longer side, each pin a filled circle (radius 2.2% of the longer side, `#ff2d55`, white 3 px ring) with its number in white bold centred.
  - In `steps.js`: `revise(where, image, notes)` runs like `generate` (busy check, `running`, service call, settle) but starts the round with `/draft/revise`. A round with `from` shows `revised from` with a small copy of that image and its notes, as a list.

- [ ] **Step 1: Extend the browser check:** open a concept candidate large, click `Add notes`, click the image once, type `no antenna` into the pin's note, click `Regenerate from this` → the large view closes, and a new round appears whose block contains `revised from` and `no antenna`.
- [ ] **Step 2: Run** `npm run check:browser`. Expected: fails at `.mm-notes-add`.
- [ ] **Step 3: Implement** `notes.js`, the `revise` path in `steps.js`, and the styles.
- [ ] **Step 4: Run** `npm run check:browser` and `npm test`. Expected: both pass.
- [ ] **Step 5: By hand, once, with the real image service** (the editor on the review project, a throwaway draft): a concept, one pin with a note, regenerate; look at the result. If the marks leak into the picture or the change is ignored, adjust the revision text in `draft.mjs` (and its test) and repeat. Record what was tried in the commit message.
- [ ] **Step 6: Commit** `New model: pin notes on an image and regenerate from it`.

### Task 5: The workflows repository: sides settled, API workflow, pipeline.json, status route, licence, clean paths

**Files (in W):**
- Create: `LICENSE`, `pipeline.json`, `workflows/api/asset3d-pixal3d-multiview-ultrashape.json`
- Modify: `tools/build_workflows.py` or `tools/queue_workflow.py` (an `--export-api <file>` that writes the API prompt with `_meta.title` on every node), `tools/check_workflows.py`, `custom_nodes/asset3d_ultrashape/__init__.py`, `README.md`, `SETUP.md`, `docs/*.md`

**Interfaces:**
- Produces:
  - `pipeline.json`: `{ "pipeline": "asset3d", "version": 1, "multiview": "workflows/api/asset3d-pixal3d-multiview-ultrashape.json", "finish": "tools/blender_finish.py", "setup": "https://github.com/idnn-productions/comfy-ui-model-workflows/blob/main/SETUP.md" }`.
  - The API workflow: ComfyUI's `{ "<id>": { class_type, inputs, _meta: { title } } }`, with nodes titled `in_front_image`, `in_left_image`, `in_back_image`, `in_right_image`, `in_top_image`, `in_bottom_image` (input `image`), `in_use_top_bottom_views` and `in_use_ultrashape` (input `value`), `in_target_faces` (input `target_face_count`), `out_model`, `out_preview_textured`, `out_preview_clay` (input `filename_prefix`).
  - `GET /asset3d/status` on ComfyUI → `{ "version": 1, "ultrashape": { "code": bool, "packages": [missing module names], "checkpoints": [file names] } }`, registered only when `server.PromptServer.instance` exists; it must not import torch-heavy UltraShape code (`importlib.util.find_spec` for packages, `find_ultrashape_dir` and `list_checkpoints` guarded by try).
  - A written answer to "which side is `in_left_image`": one sentence in `README.md` under the inputs table, in the form "`in_left_image` is the object seen from its own left side (the viewer stands at the object's left)" or the opposite, whichever is true.

- [ ] **Step 1: Settle left and right.** Render the finished ship (the test project's `models/ship6/ship6.glb`) with `tools/blender_inspect.py` and compare its `left.png` render and the reference `ship6.refs/left.png` (both were made with the current mapping) against the prompts the references were generated with; decide which physical side `in_left_image` is, write the sentence in the README, and note for Task 7 whether the editor's `left` goes to `in_left_image` or to `in_right_image`.
- [ ] **Step 2: Write the check first:** `tools/check_workflows.py` fails unless `pipeline.json` parses, both files it names exist, and the API workflow has every title listed above with the named input. Run `python tools/check_workflows.py`. Expected: fails (no `pipeline.json`).
- [ ] **Step 3: Implement** the export (needs the running ComfyUI's `/object_info`; no GPU), commit the exported file, add `pipeline.json` and `LICENSE` (MIT, `Copyright (c) 2026 IDNN Productions`, text as in `idnn-productions/comfy-ui-video-workflows`). Run the check. Expected: passes.
- [ ] **Step 4: Add the status route** to the node pack, copy the file to the installed node folder, and ask Jacek to restart ComfyUI; then `curl http://127.0.0.1:8188/asset3d/status`. Expected: `code: true`, `packages: []`, one checkpoint.
- [ ] **Step 5: Clean the files for publishing:** no paths of this computer, user name or install names, or "measured on our machine" notes naming it (hardware and timings stay, as "on an RTX 4090"); SETUP's stale "none of this has been run" header corrected; a README section "Use from the NFGames Map Editor" (set the plugin's workflows folder to this checkout; what step ③ checks). Verify: a `git grep` for the user name, the install names and `Users/` paths prints nothing.
- [ ] **Step 6: Commit** (in W) `API workflow, pipeline.json and a status route for the editor; MIT; machine notes removed`.

### Task 6: Plugin `nfgames.comfy-model`: settings and `status`

**Files:**
- Create: `plugins/comfy-model/plugin.json`, `plugins/comfy-model/server.mjs`, `plugins/comfy-model/comfy.mjs`, `test/comfy-model.test.mjs`, `test/fake-comfy.mjs`
- Modify: `src/plugins/manager.mjs:86` (the program-name check), `test/plugins-manager.test.mjs`

**Interfaces:**
- `plugin.json`: id `nfgames.comfy-model`, `engines.nfgames` as the current core version requires, `touches: { files: ['.nfgames/drafts/**', 'models/**'], commands: ['blender'], network: true }`, settings `comfyUrl` (string, default `http://127.0.0.1:8188`), `workflowsDir` (string, default `''`), `blender` (string, default `''`); service `model` (title `3D model generation`, provider `ComfyUI on your computer`, no `needs`), actions `status` (cost estimate 0) and `generate` (cost `{ estimate: 0, note: 'runs on your GPU' }`); activation `['onService:model']`.
- `comfy.mjs` (no editor API in it, so it is tested alone):
  - `readPipeline(dir) -> { dir, version, multiview: object, finish: absolute path, setup }`, throwing an Error whose message is the user's text (`Set the workflows folder…`, `…has no pipeline.json`, `…is version N; this editor knows version 1`).
  - `findBlender(setting, { env, platform, exists, list }) -> string | null`.
  - `comfy(url) -> { objectInfo(), queueLength(), asset3dStatus(), upload(name, subfolder, bytes), prompt(graph), history(id), view({ filename, subfolder, type }) }`: every call with a timeout (5 s; `view` and `upload` 120 s) and an Error naming ComfyUI and the URL on anything but JSON 200.
  - `checksOf({ pipeline, pipelineError, info, infoError, a3d, blender, ultrashape }) -> [{ id, ok, text, help }]` for ids `workflows`, `comfy`, `nodes`, `models`, `blender`, in that order; `ok` is `true`, `false`, or `null` (not checked).
  - `missingModels(graph, info) -> [{ node, input, value }]`: for each node input whose value is a string and whose `/object_info` spec for that input is a list of options, the value must be among them; inputs under titles starting `in_` and ending `_image` are skipped (the views are uploaded later).
- Service action `status({ ultrashape = true })` → `{ ready: boolean, checks, queue: number | null, setup }`; `ready` when no check is `false`.
- Core: `basename(command).replace(/\.exe$/i, '').toLowerCase()` compared with the declared names lower-cased.
- `test/fake-comfy.mjs`: `fakeComfy({ nodes, models, queue, a3d, outcome }) -> { url, calls, close() }`, an `http` server with `/object_info`, `/queue`, `/asset3d/status`, `/upload/image`, `/prompt`, `/history/<id>`, `/view`; `outcome`: `'success' | 'reject' | 'error' | 'no-glb' | 'view-404'`.

- [ ] **Step 1: Write the failing tests** (`test/comfy-model.test.mjs`), each with a temporary workflows folder holding a three-node API workflow and a `pipeline.json`:
  - everything present → `ready: true`, five checks all `ok: true`, `queue: 0`;
  - `workflowsDir` empty → `workflows` false with text matching `/Set the workflows folder/`, the other checks still answered;
  - `pipeline.json` version 2 → `workflows` false, `/knows version 1/`;
  - ComfyUI not listening → `comfy` false within 6 s, `nodes` and `models` `null`, `status` resolves;
  - a node type missing from `/object_info` → `nodes` false and its text names the type;
  - a checkpoint name not among a loader's options → `models` false naming the file;
  - `/asset3d/status` 404 → `models` ok is `null` for the UltraShape part and the text says `UltraShape: not checked`; with `{ code: false }` and `ultrashape: true` → false; same with `ultrashape: false` → not false;
  - no Blender (setting empty, empty PATH, `exists` false) → `blender` false;
  - ComfyUI answering `<html>` with 200 → `comfy` false, no throw;
  - manager: a job step whose program is `C:\\x\\blender.exe` or `/Applications/Blender.app/Contents/MacOS/Blender` is accepted for a plugin declaring `blender`, and `rm` is still refused.
- [ ] **Step 2: Run** `node --test test/comfy-model.test.mjs test/plugins-manager.test.mjs`. Expected: fail (no plugin).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `A model service: ComfyUI and Blender checked one by one`.

### Task 7: Plugin `nfgames.comfy-model`: `generate`

**Files:**
- Modify: `plugins/comfy-model/server.mjs`, `plugins/comfy-model/comfy.mjs`, `test/comfy-model.test.mjs`

**Interfaces:**
- Consumes: Task 6; the draft's files `.nfgames/drafts/<slug>/draft.json`, `concept.png`, `views/<view>.png`; `MODEL_SIDES`, `MODEL_POLES`, `modelViews` imported from `../model-maker/draft.mjs`; the side mapping decided in Task 5 Step 1.
- Produces: service action `generate({ draft, length, faces = 60000, ultrashape = true, pivot = 'centre', wait = false, replace = false })` → `{ model: 'models/<slug>/<slug>.glb', refs: 'models/<slug>/<slug>.refs', report: object (the finish script's FINISH line), seconds }`.
  - Refusals before any job (Errors with these beginnings): `draft:` (no such draft, not ready, sides missing: names them); `length:` (not a number > 0); `ComfyUI is working on N other prompts` unless `wait`; `models/<slug>/<slug>.glb is already there` unless `replace`; `Not ready:` + the texts of the false checks; `models:` when the project's models folder does not contain `models/`.
  - `setInputs(graph, { views: { front: 'nfgames/<slug>/front.png', … }, poles: boolean, ultrashape, faces, prefix }) -> graph` (in `comfy.mjs`, pure): sets by `_meta.title`; pole loaders get the front image when `poles` is false; `prefix` is `nfgames/<slug>` for `out_model` and `nfgames/<slug>_preview_textured` / `_clay`.
  - One job `Generate model: <name>`, steps `Send the views`, `Generate (ComfyUI)`, `Fetch the model`, `Finish (Blender)`, `Save`. Polling every 3 s, logging elapsed time each 30 s; 30 minutes → fails `still running after 30 minutes (prompt <id>)`. Blender: `[blender, '--background', '--factory-startup', '--python', finish, '--', rawPath, outPath, '--length', String(length), '--name', slug, '--pivot', pivot]` with raw and out in `api.storage`; the step fails unless its output has a `FINISH ` line and the out file exists. `Save` writes the GLB then the refs (`concept.png` and each used view) through `api.files`; only those paths are written.

- [ ] **Step 1: Write the failing tests**, with `fakeComfy` and a stand-in `blender` made with `fakeCommand` (it copies its input file to its output path and prints `FINISH {"after":{"triangles":12}}`; with `BLENDER_FAILS` in its `--name` it exits 3), on a project copy holding a ready draft:
  - success → the result's `model` exists with the fake GLB's bytes; `.refs` has `concept.png` and the four sides; ComfyUI got four uploads under `nfgames/<slug>`, and the queued graph's `in_use_top_bottom_views` is false and its `in_left_image` is the side Task 5 decided;
  - with top and bottom approved → six uploads, `in_use_top_bottom_views` true;
  - `queue: 2` → refused `/2 other prompts/`, no upload made; with `wait: true` → runs;
  - an existing model → refused without `replace`; with it, replaced, and a file `models/<slug>/notes.txt` put there beforehand is still there;
  - `outcome: 'reject'` → fails with ComfyUI's node error text; `'error'` → fails with its execution error; `'no-glb'` → `/without a model/`; `'view-404'` → fails; in all four nothing exists under `models/<slug>/`;
  - Blender failing → job failed, nothing under `models/<slug>/`;
  - a draft missing `left` → refused `/draft: .*left/`; `length: 0` → refused.
- [ ] **Step 2: Run** `node --test test/comfy-model.test.mjs`. Expected: new tests fail (`no action generate` or similar).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `The model service generates: views to ComfyUI, the result through Blender into models/`.

### Task 8: Step ③ in the page

**Files:**
- Modify: `plugins/model-maker/web/steps.js`, `plugins/model-maker/web/style.css`, `scripts/browser-check.mjs`

**Interfaces:**
- Consumes: `api.services.call('nfgames.comfy-model/model', 'status' | 'generate', input)`; `/draft/model`; `GET /draft`'s `model` field.
- Produces (selectors the browser check uses): `.mm-needs` (the info box; `.mm-need.ok`, `.mm-need.bad`, `.mm-need.unknown` per check; when all ok one line `Everything this step needs is there.`); a cross shows its `help`, the setup link (`status.setup`, opened in a new tab with `rel="noopener"`), `https://www.blender.org/download/` for Blender, and a `Settings` button (`api.commands.execute('core/settings')` or whichever command opens Settings in this shell); fields `data-key="length"` (required, > 0), `data-key="faces"` (default 60000), `data-key="ultrashape"` (checkbox, on); `Generate model` (`.mm-btn.primary`), off until `status.ready`, a length is given and nothing is running; the two confirmations (queue, replace) through `confirmDialog`, sending `wait` / `replace`; while running the job's current step from `/api/job`; after: triangles, size and megabytes from `report`, and a link `Open in the model viewer` to `/viewer?model=<slug>/<slug>.glb`; a line naming the views used and, when listed, that three-quarter is not.

- [ ] **Step 1: Change the browser check:** after `Approve views`, expect `.mm-needs` with at least one `.mm-need.bad` (the check runs with no workflows folder set) and `Generate model` disabled; the old expectation of the "later update" text is removed.
- [ ] **Step 2: Run** `npm run check:browser`. Expected: fails at `.mm-needs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check:browser` and `npm test`. Expected: both pass.
- [ ] **Step 5: Commit** `New model, step 3: what it needs, and Generate model`.

### Task 9: The real run, and the documents

**Files:**
- Modify (E): `README.md`, `docs/plugins.md`, `skills/nfgames/SKILL.md` (if it lists services), `docs/superpowers/specs/2026-11-23-model-generation-design.md` (status line)

- [ ] **Step 1:** ComfyUI's queue empty (`/queue`). The editor on the test project, restarted from this branch; the plugin's `workflowsDir` set to W. A new draft through concept, views (with top and bottom), one revision from notes, approval, and Generate model with a real length. Expected: the model in `models/<slug>/`, opening in the viewer with its references; the job log without errors. Compare left and right of the model with the views.
- [ ] **Step 2:** Fix what the run shows (prompt wording, mapping, texts), with the tests updated first.
- [ ] **Step 3:** Documents: README (New model's three steps as they now are; the model step's requirements; Windows and macOS notes for Blender), `docs/plugins.md` (the model service as the second example). `npm test` and `npm run check:browser`. Expected: both pass.
- [ ] **Step 4: Commit** `Documents for model generation; the design marked built`.

### Task 10: Publish the workflows repository

- [ ] **Step 1:** In a fresh folder outside W: copy W's tracked files (`git -C W archive HEAD | tar -x`), `git init -b main`, one commit `Asset3D: multi-view image to 3D for ComfyUI (Pixal3D, UltraShape, view projection)`. Verify again: a `git grep` for the user name, the install names and `Users/` paths prints nothing, and `git log` shows one commit with the organisation's author details, not a personal address.
- [ ] **Step 2:** Show Jacek the file list and the README's top; on his yes: `gh repo create idnn-productions/comfy-ui-model-workflows --public --source . --push --description "ComfyUI workflows for 3D assets from reference views: Pixal3D, UltraShape, view projection, a Blender finish pass."`
- [ ] **Step 3:** Point W's `origin` at it (W keeps its local history on a branch `local-history`; `main` is reset to the published commit), and rename the local folder to `comfy-ui-model-workflows` when no session is working in it.
