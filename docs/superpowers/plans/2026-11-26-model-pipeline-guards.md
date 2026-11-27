# Model pipeline: guards, earlier checks and a measured build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the holes found when three outside guides were checked against the pipeline: a match loop that can
"win" by changing size or triangle count, views that are only checked against each other after a GPU run, a finished
mesh nobody measures, an overlay that misleads when one part is missing, and no workflow for building a hard-surface
model from measurements.

**Architecture:** Everything is measured by the scorer the editor already has (`src/match/score.py`, run in Blender as
a fixed command). It gains a description of the mesh (`shape`), a mode that looks at references alone (`refsOnly`), a
best-fit placement, and outlines. The pure rules that read those numbers live in `src/match.mjs`. The workflows
repository's `blender_inspect.py` is corrected and named in `pipeline.json`, and the model service runs it after the
finish.

**Tech Stack:** Node ≥ 20 with no dependencies (`node --test`), Blender's Python (bpy, bmesh, numpy) for the scorer,
plain Python scripts in `comfy-ui-model-workflows`.

**Spec:** There is no separate design note. This plan argues from the review of 2026-11-26 (three guides against the
code) and from the notes already in the repository, which executors read with it:
`docs/superpowers/specs/2026-11-23-model-generation-design.md` (constraints, anti-goals),
`skills/model-review/SKILL.md` (the loop's contract) and `comfy-ui-model-workflows/docs/experiments.md` §2
("A pass that looks at the model"). The decisions that a spec would hold are under **Decisions** below.

**Two repositories.** Tasks 1–4 and 6–9 are in `NFGames-Map-Editor` (branch `feature/pipeline-guards`, cut from
`feature/reference-match`, which is 2 commits ahead of `main`). Task 5 is in `../comfy-ui-model-workflows` (branch
`inspect-in-pipeline`, cut from `main`). Each phase works on its own and can be merged alone.

## Global Constraints

- Dependency-free Node ≥ 20, macOS and Windows. No new npm dependency, no process started through a shell.
- `npm test` passes on a machine without ComfyUI, Blender or Codex: tests that need real Blender are in a `describe`
  skipped when `findBlender('')` finds none (as `test/match-scorer.test.mjs` is).
- The scorer is started as a fixed command with one JSON settings file; nothing from a request becomes part of a command.
- Plugins work through their API: project files only under `touches.files`, programs only from `touches.commands`.
- A GPU run never starts without the user pressing a button. (A Blender run on the CPU that takes seconds may.)
- `pipeline.json` stays `"version": 1`: every key added is optional, and a checkout without it still works.
- Job and draft files keep their shape: everything added is optional, and older jobs and drafts still open.
- The session that handles a loop job never judges its own result: every new number comes from `bin/match.mjs`.
- Commit messages follow the repository's style: a plain sentence saying what is now true ("Match: …").

## Decisions

1. **What the guard holds still** (against round 0 of the job): the longest side within 2%; triangles at most 1.25
   times; the origin's place in the bounding box within 0.02 on each axis; floating pieces no more than before.
   Config `match.limits: { size: 0.02, triangles: 1.25, pivot: 0.02, floating: true }`; `null` (or `false`) turns one off.
2. **A round that drifted cannot reach the target.** It is recorded with `drift: [text]`; `decide` goes on (so the
   session repairs it) until the rounds run out. No new stop reason: `out-of-rounds`, with the drift in its detail.
3. **The views check warns, it never refuses.** Outline agreement of a pair below 0.90 is a warning (Jacek, 2026-11-26:
   "better is better"). The user can change it: the plugin setting `viewsOutline` (a number, default 0.9) under
   3D model generation. Task 4 measures real drawings and records the numbers; it does not change the default.
4. **What the mirror check can and cannot see.** The outline of one side is the mirror of the opposite side's, so a
   pair whose outlines disagree shows two different shapes: that is caught. A view that is a mirrored *copy* of its
   opposite has a perfect outline by construction; it is only noted ("looks like a mirrored copy: right for a
   symmetric object") when outline and colour both agree above 0.97, and a person decides.
5. **The built-in plugin `nfgames.comfy-model` imports `SCORER`, `consistency` and `refsVerdict` from
   `../../src/match.mjs`.** It is the first plugin to import from core. The alternative, a plugin API 1.2.0 with
   `api.match`, is more than this needs; say so if the boundary matters more.
6. **Inspecting never loses a model.** The order is Finish, Save, Inspect. When Inspect fails, `generate` still
   answers with the model and `report.inspectError`.
7. **Best-fit placement can only raise a score** (the bounding-box placement is one of the placements tried), so
   targets set before it stay reachable. It runs in the final pass only, not in the orientation search.
8. **Not in this plan:** rigging, weights, clips and FBX export; a character mode for the view prompts; a level-of-detail
   copy; starting a Claude Code session for a job.

## Review Focus

1. A loop job written before this change (its `match.baseline` has no `shape`): the loop runs as before and reports no drift. Test in Task 2.
2. A raw generator mesh in hundreds of pieces: the scorer still answers in its usual time, with `floating: null` above 500 pieces. Test in Task 1.
3. The views check given fewer than two views, or a view whose background is not flat: it says "not checked" for that pair and never warns about a shape. Test in Task 3.
4. A workflows checkout older than `inspect`, or an inspect script that crashes: the model is saved and shown. Test in Task 6.
5. A user who wants the size changed in a loop job: `match.limits.size: null` turns that limit off, and the drift text names the setting. Test in Task 2.

---

## Phase 1 — The loop cannot win by drifting

### Task 1: The scorer describes the mesh (`shape`)

**Files:**
- Modify: `src/match/score.py` (after the model is imported, before `root` is made), `src/match.mjs` (`SCORER_VERSION = 2`)
- Test: `test/match-scorer.test.mjs`, `test/match-fixtures.mjs` (one new fixture)

**Interfaces:**
- Produces: the result's `shape`:
  `{ triangles: int, pieces: int, floating: int | null, longest: number, origin: [fx, fy, fz] }`.
  `longest` is the longest side in metres (equal to `max(result.size)`). `origin` is where the file's origin lies in
  the bounding box, 0 to 1 on each axis, in glTF's order (x, up, depth): `[0.5, 0, 0.5]` is the centre of the base.
  `pieces` are connected pieces counted on a welded copy (vertices within `longest × 1e-6` made one, so UV seams are
  not gaps). `floating` are pieces whose nearest vertex of any other piece is farther than `longest × 0.001`; `null`
  when there are more than 500 pieces.

- [ ] **Step 1: Add the fixture** `manyBoxesGlb(n)` to `test/match-fixtures.mjs`: `n` unit cubes on a line, 3 apart, through `boxesGlb`.

- [ ] **Step 2: Write the failing tests** in `describe('the scorer in Blender')`:

```js
it('describes the mesh: triangles, pieces, floating pieces, and where its origin is', async () => {
  const refs = (d) => writeRefs(d, { boxes: BOX }, ['front', 'left', 'top'], { colour: RED });
  const box = await score(boxesGlb(BOX, linear(RED)), refs);
  assert.deepEqual([box.shape.triangles, box.shape.pieces, box.shape.floating], [12, 1, 0]);
  assert.equal(box.shape.longest, 2);
  box.shape.origin.forEach((f) => assert.ok(Math.abs(f - 0.5) < 0.01));
  const shape = await score(boxesGlb(SHAPE, linear(RED)), refs);          // base on y = 0, three boxes that touch
  assert.ok(Math.abs(shape.shape.origin[1]) < 0.01); assert.equal(shape.shape.floating, 0);
  const apart = await score(boxesGlb([...BOX, { min: [5, 5, 5], max: [6, 6, 6] }], linear(RED)), refs);
  assert.deepEqual([apart.shape.pieces, apart.shape.floating], [2, 2]);  // neither touches the other
});
it('a mesh in hundreds of pieces is still scored, and its floating pieces are not counted', async () => {
  const r = await score(manyBoxesGlb(600), (d) => writeRefs(d, { boxes: BOX }, ['front', 'left', 'top'], { colour: RED }));
  assert.equal(r.shape.pieces, 600); assert.equal(r.shape.floating, null);
});
```

- [ ] **Step 3: Run them:** `node --test test/match-scorer.test.mjs` — both fail on `shape` undefined.

- [ ] **Step 4: Implement `mesh_shape(meshes, lo, hi) -> dict` in `score.py`.** One `bmesh` of all meshes in world space, `bmesh.ops.remove_doubles`, pieces by union-find over edges, the nearest other piece through one `mathutils.kdtree.KDTree` of every vertex (ask for neighbours until one of another piece is found, at most 16). The origin in glTF's order from Blender's bounds: `[(0 - lo.x) / ext.x, (0 - lo.z) / ext.z, hi.y / ext.y]`, an axis with no extent giving 0.5. Add `"shape"` to the result written by `finish`.

- [ ] **Step 5: Run the scorer tests:** all pass, the earlier ones unchanged.

- [ ] **Step 6: Commit:** `Match: the scorer says what the mesh is made of (triangles, pieces, where its origin is)`

### Task 2: Drift, and a round that drifted cannot reach the target

**Files:**
- Modify: `src/match.mjs` (`DEFAULTS`, `normaliseMatch`, new `drift`, `decide`), `src/matchloop.mjs` (`roundOf`, `recordRound`, `finishLoop`), `bin/match.mjs` (the `round` output), `src/reviews.mjs` (`loopText`), `skills/model-review/SKILL.md`, `README.md` (the `match` config), `todo.md`
- Test: `test/match.test.mjs`

**Interfaces:**
- Consumes: `result.shape` (Task 1).
- Produces:
  - `DEFAULTS.limits = { size: 0.02, triangles: 1.25, pivot: 0.02, floating: true }`; `normaliseMatch` checks `match.limits` (each a number above 0, or `null`/`false`; `floating` a boolean or `null`).
  - `export function drift(base, shape, limits) -> string[]`: empty when either shape is missing. Texts, exactly:
    `the longest side is ${now} m, was ${was} m (more than ${pct}% off; match.limits.size)`,
    `${now} triangles, was ${was} (more than ${x} times; match.limits.triangles)`,
    `the origin moved in the bounding box (${axis}: ${was} to ${now}; match.limits.pivot)`,
    `${now} floating pieces, was ${was} (match.limits.floating)`.
  - A round keeps `shape` and, when not empty, `drift: string[]`. `roundOf(round, result, loop, extra)` copies `result.shape`.
  - `decide(loop, rounds, consistent, scores)` reads `last.drift`: with drift it never answers `target-reached` and never `plateau`; out of rounds it answers `out-of-rounds` with `detail` ending `. The model drifted from what was sent: <the texts joined with "; ">`.
  - `match.mjs round` prints `drift` (a list, empty when none) and `shape`.

- [ ] **Step 1: Write the failing tests** (pure, beside "on the target, on the rounds, on a plateau"):

```js
it('drift: size, triangles, the origin and floating pieces are held to round 0, each by its own limit', () => {
  const base = { triangles: 60000, pieces: 1, floating: 0, longest: 40, origin: [0.5, 0.5, 0.5] }, L = DEFAULTS.limits;
  assert.deepEqual(drift(base, { ...base, longest: 40.5, triangles: 70000 }, L), []);
  assert.match(drift(base, { ...base, longest: 42 }, L)[0], /longest side is 42 m, was 40 m.*match\.limits\.size/);
  assert.match(drift(base, { ...base, triangles: 90000 }, L)[0], /90000 triangles, was 60000/);
  assert.match(drift(base, { ...base, origin: [0.5, 0, 0.5] }, L)[0], /origin moved/);
  assert.match(drift(base, { ...base, floating: 2 }, L)[0], /2 floating pieces, was 0/);
  assert.deepEqual(drift(base, { ...base, longest: 80 }, { ...L, size: null }), []);       // turned off
  assert.deepEqual(drift(undefined, base, L), []); assert.deepEqual(drift(base, undefined, L), []);   // a job from before
  assert.deepEqual(drift({ ...base, floating: null }, { ...base, floating: 3 }, L), []);    // not counted then
});
it('a round that drifted cannot reach the target, and is named when the rounds run out', () => {
  const loop = normaliseLoop({ target: 0.9, maxRounds: 2, plateau: 0.01 });
  const r = (round, mean, drift) => ({ round, mean, ...(drift ? { drift } : {}) });
  assert.deepEqual(decide(loop, [r(0, 0.7), r(1, 0.95, ['x'])]), { stop: false });
  assert.deepEqual(decide(loop, [r(0, 0.7), r(1, 0.701, ['x'])]), { stop: false });        // no plateau while it drifts
  const end = decide(loop, [r(0, 0.7), r(1, 0.95, ['x']), r(2, 0.95, ['42 m'])]);
  assert.equal(end.reason, 'out-of-rounds'); assert.match(end.detail, /drifted from what was sent: 42 m/);
});
```

And in the loop tests (fake spawn): a job whose baseline has no `shape` records rounds with no `drift` and reaches its target; a job whose baseline has one and whose next result has `longest` doubled records `drift` and answers `{ stop: false }` above the target; `finishLoop` after that writes `stopReason: 'out-of-rounds'`, not `target-reached`.

- [ ] **Step 2: Run them:** `node --test test/match.test.mjs` — fail on `drift` not exported.
- [ ] **Step 3: Implement** `drift`, the limits in `normaliseMatch`, the change to `decide`, and in `recordRound` `round.drift = drift(status.rounds[0].shape, result.shape, matcher.config.limits)` when not empty. `finishLoop` treats a last round with `drift` as not having reached the target.
- [ ] **Step 4: Words.** `loopText` gains one paragraph and the skill's loop section the same: "The loop holds the model's size, triangle count, origin and floating pieces to what was sent. `round` prints `drift`: while it is not empty the round cannot reach the target, so undo that first." The skill's loop section also gains: "Open the overlays of the two lowest views only; open another when those are fixed." Document `match.limits` where the README documents `match`.
- [ ] **Step 5: Run** `npm test` — all pass.
- [ ] **Step 6: Commit:** `Match loop: size, triangles, origin and floating pieces are held to what was sent`

## Phase 2 — The views are checked against each other before the GPU run

### Task 3: The scorer looks at references alone (`refsOnly`)

**Files:**
- Modify: `src/match/score.py` (the references section moves above the model; a `refsOnly` branch), `src/match.mjs` (new `refsVerdict`, `REFS_LIMITS`)
- Test: `test/match-scorer.test.mjs`, `test/match.test.mjs`

**Interfaces:**
- Produces:
  - Scorer args `{ refs, outDir, result, refsOnly: true, planUp }` (no `model`). Result:
    `{ ok: true, refsOnly: true, views: { view: { background, refSize, refExtent, planUp } }, pairs: { 'left-right' | 'front-back' | 'top-bottom': { outline: number, colour: number } }, warnings: [{ view, kind: 'background', text }], seconds }`.
    A pair is there only when both views are and neither background is `unclean`. `outline` is the IoU of the first
    view's mask and the second's mirrored left to right, both through `normalise_pair`; `colour` is `colour_score` of the same pair.
  - `export const REFS_LIMITS = { outline: 0.9, copy: 0.97 }`.
  - `export function refsVerdict(result, tolerance = DEFAULTS.tolerance, limits = REFS_LIMITS) -> { checked: boolean, pairs, consistency, warnings: string[], notes: string[] }`.
    `consistency` is `consistency(result.views, tolerance)` and its warnings are included. Texts, exactly:
    warning `${a} and ${b}: their outlines agree ${n.toFixed(2)} (below ${limit}): they show two different shapes`;
    note `${b} looks like a mirrored copy of ${a}: right for a symmetric object; redraw one if it has one-sided details`;
    `checked` is false, with one note `fewer than two views with a clean background: not checked`, when there is no pair and consistency was not checked.

- [ ] **Step 1: Write the failing tests.** In the Blender `describe`, a helper `refsOnly(files)` that runs Blender as `createMatcher` does (`[blender, '-b', '--factory-startup', '--python', SCORER, '--', args.json]`) and reads the result:

```js
it('references alone: opposite views of one shape agree, a pair that does not is found', async () => {
  const d = join(dir, 'refs1'); writeRefs(d, { boxes: SHAPE }, ['front', 'back', 'left', 'right', 'top', 'bottom'], { colour: RED });
  const same = await refsOnly(d);
  for (const p of ['left-right', 'front-back', 'top-bottom']) assert.ok(same.pairs[p].outline > 0.95, `${p} ${same.pairs[p].outline}`);
  const e = join(dir, 'refs2'); writeRefs(e, { boxes: SHAPE }, ['front', 'left'], { colour: RED }); writeRefs(join(e, 'x'), { boxes: BOX }, ['right'], { colour: RED });
  copyFileSync(join(e, 'x', 'right.png'), join(e, 'right.png'));
  assert.ok((await refsOnly(e)).pairs['left-right'].outline < 0.9);
});
it('references alone: one view, or an unclean background, is not a pair', async () => { /* front only -> pairs {}; a gradient left -> no left-right, one background warning */ });
```

Pure, in `test/match.test.mjs`: `refsVerdict` on hand-written results gives the warning text for `outline: 0.71` and for `outline: 0.88`, the note for `{ outline: 0.99, colour: 0.99 }`, nothing for `{ outline: 0.93, colour: 0.6 }`, nothing for `outline: 0.88` with `limits.outline` 0.85, and `checked: false` with the "not checked" note for `{ views: { front: {…} }, pairs: {} }`.

- [ ] **Step 2: Run them** — fail (the scorer stops on `cfg["model"]`; `refsVerdict` is not exported).
- [ ] **Step 3: Implement.** In `score.py` load and mask the references first; when `cfg.get("refsOnly")`, compute the pairs and `finish` before any model code runs. `refsVerdict` in `match.mjs`.
- [ ] **Step 4: Run** `node --test test/match-scorer.test.mjs test/match.test.mjs` — pass.
- [ ] **Step 5: Commit:** `Match: the scorer can look at references alone, and says which opposite views disagree`

### Task 4: "Check the views" in step ③, and its numbers on real drawings

**Files:**
- Modify: `plugins/comfy-model/server.mjs` (action `checkViews`; `generate`'s report), `plugins/comfy-model/plugin.json` (the action; the setting `viewsOutline`: `{ "type": "number", "default": 0.9, "title": "Views check: how well opposite views' outlines must agree (0.5 to 0.99)" }`; version `1.1.0`), `plugins/model-maker/web/steps.js` and `style.css` (step ③), `docs/plugins.md`
- Test: `test/comfy-model.test.mjs`, `scripts/browser-check.mjs`

**Interfaces:**
- Consumes: `SCORER`, `refsVerdict` from `../../src/match.mjs` (Decision 5); the draft's `views/<view>.png`.
- Produces: service action `model.checkViews { draft } -> { checked, pairs, consistency, warnings, notes, seconds }`.
  One job "Check the views: <name>" with one command step (Blender, `refsOnly`, `planUp: 'up'`, args and result under
  `api.storage`). The answer is kept in `api.storage/views-<slug>.json` with the SHA-256 of each view file, and
  answered from there while those are unchanged. Only the scorer's raw result is kept: the verdict is made on every
  call with `{ ...REFS_LIMITS, outline: <the setting viewsOutline, held to 0.5–0.99; 0.9 when it is not a number> }`,
  so a changed setting needs no new Blender run. `generate`'s `report.views` is that kept answer, or `null` when the
  views were never checked (it does not run the check itself).
- The page: under the approved views in step ③, a button **Check the views against each other** (off while a job
  runs or Blender is missing), then a line per warning (as a cross) and per note (plain), or "The views agree."

- [ ] **Step 1: Write the failing tests** with the stand-in `blender` (teach it: when its args file has `refsOnly`, write a result whose `pairs['left-right'].outline` is 0.6 when the draft's name has "crooked", else 0.98): `checkViews` answers the warning text for a crooked draft and none otherwise; with `viewsOutline` set to 0.5 the crooked draft (0.6) has no warning and no job is started for it; a second call starts no job; a changed view file starts one; a draft that is not `ready` is refused with `draft: approve the views first`.
- [ ] **Step 2: Run** `node --test test/comfy-model.test.mjs` — fail on the unknown action.
- [ ] **Step 3: Implement** the action and the page; add the button to the browser check's step ③ pass.
- [ ] **Step 4: Run** `npm test` and `npm run check:browser` — pass.
- [ ] **Step 5: Measure on real drawings.** Run the check on every draft with approved views on the PC that has them (the ship among them) and on one deliberately wrong set (a left view swapped for another object's). Write the outline numbers into the README's match section as a small table, with one line on what a sound pair scored. The default stays 0.9; when sound pairs score below it, say so there and name the setting.
- [ ] **Step 6: Commit:** `New model: the approved views are checked against each other before a model is generated`

## Phase 3 — A finished mesh is measured

### Task 5 (in `comfy-ui-model-workflows`): `blender_inspect.py` counts what is there, and the pipeline names it

**Files:**
- Modify: `tools/blender_inspect.py`, `pipeline.json` (`"inspect": "tools/blender_inspect.py"`), `README.md` (the editor section and the tools table), `docs/experiments.md` (§2's last item now says what exists)
- Create: `tools/test_inspect.py`

**Interfaces:**
- Produces: `blender … --python tools/blender_inspect.py -- model.glb out_dir [--size 900] [--no-render]` prints one
  line `INSPECT {json}`. `loose_pieces`, `open_edges` and `non_manifold_edges` are now counted on a welded copy
  (today every UV seam is counted as an open edge and a gap). New keys: `floating_pieces` (as Task 1 defines it,
  `null` above 500 pieces), `flipped_faces` (faces whose normal `bmesh.ops.recalc_face_normals` turns over, per
  piece, the smaller count of turned and unturned), `zero_area_faces` (area below `longest² × 1e-12`).
  `--no-render` skips the eight pictures.

- [ ] **Step 1: Write `tools/test_inspect.py`**, run by Blender itself. It builds in `bpy`, exports to a temporary GLB and asserts on `measure(load(path))`:
  - a UV-unwrapped cube: `loose_pieces == 1`, `open_edges == 0`, `flipped_faces == 0`, `floating_pieces == 0`;
  - the cube with one face flipped: `flipped_faces == 1`;
  - the cube with one face deleted: `open_edges == 4`;
  - two cubes 10 apart: `loose_pieces == 2`, `floating_pieces == 2`.
  It prints `INSPECT_TEST ok` and exits 0, or exits 1 naming the assertion.
- [ ] **Step 2: Run it:** `blender --background --factory-startup --python-exit-code 1 --python tools/test_inspect.py` — fails (the unwrapped cube has open edges today).
- [ ] **Step 3: Implement** in `measure` (weld the `bmesh` before counting), add the keys and `--no-render`.
- [ ] **Step 4: Run it again** — `INSPECT_TEST ok`. Run `python tools/check_workflows.py` — unchanged.
- [ ] **Step 5: Commit:** `Inspect: pieces and open edges are counted on the welded mesh; flipped faces and floating pieces; the pipeline names it`

### Task 6: The model service inspects what it saved

**Files:**
- Modify: `plugins/comfy-model/comfy.mjs` (`readPipeline`), `plugins/comfy-model/server.mjs` (`generate`), `plugins/model-maker/web/steps.js` (the result line)
- Test: `test/comfy-model.test.mjs`

**Interfaces:**
- Consumes: `pipeline.json`'s optional `inspect` (Task 5) and its `INSPECT {json}` line.
- Produces: `readPipeline(dir).inspect` (a path, or `null` from an older checkout). `generate`'s steps are …, Finish,
  Save, then **Inspect (Blender)** when `inspect` is there:
  `[blender, ...headless, pipeline.inspect, '--', out, <a folder in api.storage>, '--no-render']`.
  `report.mesh = { pieces, floating, openEdges, nonManifoldEdges, flippedFaces, zeroAreaFaces, symmetryP95 } | null`;
  `report.inspectError` (text) when the step failed. A job that stopped at "Inspect (Blender)" is not a failed
  generation: `generate` answers as usual (Decision 6). The temporary `out` is removed after the Inspect step, not before.
- The page's result line adds `1 piece, 0 open edges`, and a crossed line for each of: floating pieces above 0,
  flipped faces above 0, non-manifold edges above 0.

- [ ] **Step 1: Write the failing tests** (the stand-in `blender` prints an `INSPECT` line when run with a script named `blender_inspect.py`, and exits 3 when the draft's name has "unseen"): a run with `inspect` in the pipeline answers `report.mesh.pieces === 1`; a pipeline without `inspect` answers `report.mesh === null` and runs no third Blender step; an "unseen" draft still answers `model`, the file is in `models/`, and `report.inspectError` is set.
- [ ] **Step 2: Run** `node --test test/comfy-model.test.mjs` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit:** `Model generation: the saved model is inspected, and what is wrong with its mesh is shown`

## Phase 4 — An overlay that points at the part that is wrong

### Task 7: Best-fit placement in the final pass

**Files:**
- Modify: `src/match/score.py` (`score_view`, the overlay), `src/match.mjs` (`DEFAULTS.fit = true`, `normaliseMatch`, the args file), `README.md`
- Test: `test/match-scorer.test.mjs`, `test/match.test.mjs` (the config)

**Interfaces:**
- Produces: config `match.fit` (boolean, default `true`); args `fit`. Per view the result gains
  `fit: { scale, dx, dy }` (`{ 1, 0, 0 }` when off, or when the bounding-box placement is already the best).
  In the final pass only, after `normalise_pair`: the model's crop is tried at widths ×0.90, 0.95, 1, 1.05, 1.10 and at
  offsets of −8 to 8 in steps of 2 (in pixels of a 256 grid, scaled with `grid`); the placement with the highest IoU
  is kept, ties going to the one nearest `{ 1, 0, 0 }`. The colour score and the overlay use that placement.

- [ ] **Step 1: Write the failing tests:**

```js
it('a model missing one part is placed where the rest agrees, so only that part is red', async () => {
  const refs = (d) => writeRefs(d, { boxes: SHAPE }, ['left', 'top'], { colour: RED });
  const noNose = boxesGlb(SHAPE.slice(0, 2), linear(RED));
  const fitted = await score(noNose, refs), boxed = await score(noNose, refs, { fit: false });
  assert.ok(fitted.mean.silhouette > boxed.mean.silhouette + 0.03, `${fitted.mean.silhouette} vs ${boxed.mean.silhouette}`);
  assert.notDeepEqual(fitted.views.left.fit, { scale: 1, dx: 0, dy: 0 });
  const whole = await score(boxesGlb(SHAPE, linear(RED)), refs), wholeBoxed = await score(boxesGlb(SHAPE, linear(RED)), refs, { fit: false });
  assert.ok(Math.abs(whole.mean.silhouette - wholeBoxed.mean.silhouette) < 0.005);   // nothing to gain when it already fits
  assert.ok(whole.mean.silhouette >= wholeBoxed.mean.silhouette);                     // and never lower
});
```

- [ ] **Step 2: Run** — fails (`fit` unknown to the config).
- [ ] **Step 3: Implement.** Keep `fit()`'s nearest-pixel resampling; build the model's canvas once per scale and shift it with array slicing, so the search is 5 resamples and 405 IoUs per view.
- [ ] **Step 4: Run** `node --test test/match-scorer.test.mjs test/match.test.mjs` — pass, and the scorer's whole run on the six-view box is within 20% of its time before (print `seconds` before and after in the commit message).
- [ ] **Step 5: Commit:** `Match: the model is placed where it agrees best, so a missing part does not shift the whole overlay`

## Phase 5 — Building a hard-surface model from measurements

### Task 8: `match.mjs outline`: the references as outlines in metres

**Files:**
- Modify: `src/match/score.py` (`outlines` in the `refsOnly` branch), `src/match.mjs` (`consistency` gains `proportions`; new `outlinesOf`), `bin/match.mjs` (command `outline`)
- Test: `test/match-scorer.test.mjs`, `test/match.test.mjs`

**Interfaces:**
- Produces:
  - Scorer arg `outlines: n` (with `refsOnly`): each view gains `outlines: [[[x, y], …], …]`, one closed polygon per
    piece of the mask of at least 1% of its area, largest first, at most `n` points each, in fractions of the view's
    bounding box (x from its left edge, y from its **bottom** edge). Traced on the hole-free mask (square tracing),
    simplified with Douglas–Peucker, the tolerance doubled until the polygon has at most `n` points.
  - `consistency(...)` gains `proportions: { x, y, z } | null`: the object's width, height and depth as the views imply them, the largest being 1.
  - `export function outlinesOf(result, verdict, length) -> { length, size: { x, y, z } | null, views: { view: { axes: [horizontal, vertical], size: [w, h] | null, outlines } } }`:
    with `proportions` and a `length`, `size` and each view's points are in metres; without, points stay fractions and `size` is `null`. `axes` names what the picture's horizontal and vertical are ("depth, front toward the left" for a left view, and so on, as `score.py`'s header describes the views).
  - `match.mjs outline --project <dir> <model path> [--length <metres>] [--points 40]` prints that as JSON and writes it to `<model's folder>/<name>.outlines.json`. `--length` left out: the model's longest side when the model is there.

- [ ] **Step 1: Write the failing tests.** Blender: for references of `BOX` every view's first outline has 4 points within 0.02 of the corners of the unit square; for `SHAPE`'s left view the polygon's area (shoelace) is within 3% of the mask's share of its bounding box and it has at most 12 points. Pure: `consistency` on front 2×1, left 3×1, top 2×3 gives `proportions` `{ x: 0.667, y: 0.333, z: 1 }` (to 3 decimals); `outlinesOf` with `length: 30` gives `size` `{ x: 20, y: 10, z: 30 }` and a left-view point `[1, 1]` as `[30, 10]`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit:** `Match: a model's references as outlines in metres, for building from measurements`

### Task 9: The workflow "Build from measurements"

**Files:**
- Modify: `src/reviews.mjs` (`DEFAULT_WORKFLOWS`: `{ id: 'measured', label: 'Build from measurements', description: 'Rebuild a hard-surface model in Blender from parts measured on its references', enabled: true }`), `skills/model-review/SKILL.md` (a section "Workflow: Build from measurements"), `README.md`, `todo.md`
- Test: `test/reviews.test.mjs`

**Interfaces:**
- Consumes: `match.mjs outline` (Task 8), `drift` and `shape.floating` (Tasks 1–2).
- Produces: the workflow's `instructions` and the skill section. They say, in this order:
  1. Run `match.mjs outline`; read `<name>.outlines.json` and open the references.
  2. Before any geometry, write `<name>.parts.json` beside the model:
     `{ "units": "m", "length": n, "parts": [{ "name", "along": [from, to], "up": [from, to], "across": [from, to], "shape": "box" | "cylinder" | "outline:<view>", "colour", "attachesTo" }] }`,
     `along` measured from the back end, `up` from the lowest point, `across` from the middle. Every number comes from the outlines, never from looking.
     With no loop target, set `needs-input` and show the list before building; with one, go on.
  3. Build `<name>.build.py`: one function per part from `parts.json`; a part with `outline:<view>` extrudes that outline; nothing is placed by a number that is not in `parts.json`. Run it with `blender -b --python`, export over the model file.
  4. A part must touch what it `attachesTo`: `match.mjs round` (or `score`) prints `shape.floating`, which must be 0.
  5. A wrong number is fixed in `parts.json`, then the build is run again; the GLB is never edited.
- A loop job with this workflow has no size or triangle limit against round 0 (the model is being replaced): `recordRound` passes `{ ...limits, size: null, triangles: null }` to `drift` when `job.workflow.id === 'measured'`.

- [ ] **Step 1: Write the failing tests:** the default workflows list `measured` as enabled and its instructions name `match.mjs outline` and `parts.json`; a loop job with workflow `measured` whose next result has four times the triangles records no `drift`, and one whose result has `floating: 1` does.
- [ ] **Step 2: Run** `node --test test/reviews.test.mjs test/match.test.mjs` — fail.
- [ ] **Step 3: Implement** the workflow, the skill section and the exception in `recordRound`.
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Prove it once by hand** on the ship: a loop job with this workflow, target 0.85, three rounds. Put what it reached, and what the outlines could not give it, in `todo.md`.
- [ ] **Step 6: Commit:** `Model review: a workflow that rebuilds a hard-surface model from parts measured on its references`
