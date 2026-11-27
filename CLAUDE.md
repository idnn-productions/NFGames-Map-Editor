# NFGames Map Editor: notes for Claude

A map editor in the browser with a 3D model pipeline beside it: reference images, a generated model, a scorer that
measures the model against its references, and review jobs in which a Claude Code session improves a model. The
README describes every feature; this file says how to work here and what is waiting to be done.

## Working here

- Node 20 or later, no npm dependencies. Do not add one. Nothing is started through a shell.
- `npm test` runs everything (`node --test`). Tests that need Blender are skipped when Blender is not found, so a
  green run without Blender has not tested the scorer. With Blender it takes about two minutes.
- `npm run check:browser` checks the pages (needs `playwright-core`).
- Commit messages are one plain sentence saying what is now true ("Match: the scorer says what the mesh is made of").
- Code is dense, with comments that say what is true. Follow the file you are in.
- Plans and design notes are in `docs/superpowers/`. Open follow-ups are in `todo.md`.
- Blender, ComfyUI and Codex are optional programs. The editor must start and work without them.

## The model pipeline, in one page

| Part | Where |
|---|---|
| New model: concept, views, then the model | `plugins/model-maker/` (page and drafts), `plugins/comfy-model/` (the model service) |
| The scorer, run in Blender as a fixed command | `src/match/score.py`, started by `src/match.mjs` |
| The command line a session uses | `bin/match.mjs` (`score`, `outline`, `start`, `round`, `status`, `finish`) |
| A loop's rounds and when it stops | `src/matchloop.mjs`, `decide` and `drift` in `src/match.mjs` |
| Review jobs and their workflows | `src/reviews.mjs`, `skills/model-review/SKILL.md` |
| The ComfyUI workflow and the Blender scripts | the other repository, `comfy-ui-model-workflows` (its `pipeline.json` names them) |

Rules that hold across it:

- A session never judges its own result. Every score comes from `bin/match.mjs`.
- A GPU run never starts without the user pressing a button.
- Any change to `src/match/score.py` changes the scorer's hash, so cached scores and kept view checks are made
  again once. That is intended.

## Handoff, 2026-11-26: test this on the PC

This work was built and reviewed on the Mac, which has Blender but no ComfyUI and none of the real drafts. It is
merged into `main` and pushed (2026-11-27): pull `main` in both repositories. The plan is
`docs/superpowers/plans/2026-11-26-model-pipeline-guards.md`.

The other repository's matching work is on its `main` too. The editor's
**3D model generation** setting "Workflows folder" must point at that checkout, pulled to `main`, or the mesh
inspection is skipped.

### What the branch added

1. **The loop cannot win by drifting.** Every score has `shape` (triangles, pieces, floating pieces, longest side,
   where the origin is). A round whose shape left round 0 gets `drift` and cannot reach the target. Limits are in the
   config: `match.limits` (`size` 0.02, `triangles` 1.25, `pivot` 0.02, `floating` true; `null` turns one off).
2. **Views are checked before the GPU run.** Step 3 of New model has **Check the views against each other**. Opposite
   views must have mirrored outlines. It warns and never blocks. The limit is the plugin setting `viewsOutline`,
   default 0.9 (Jacek's choice: "better is better").
3. **A saved model is inspected.** After Finish and Save, the model service runs `tools/blender_inspect.py` and step 3
   shows pieces, open edges, floating pieces, flipped faces. A failed inspection never loses the model.
4. **Best-fit placement** (`match.fit`, on by default). A model missing one part is placed where the rest agrees, so
   the overlay points at the missing part. A view never scores lower with it on, for a fixed plan direction.
5. **Build from measurements.** `match.mjs outline` writes `<name>.outlines.json` beside a model: each view's outline,
   and the same polygons as `parts` in the frame `parts.json` uses (along from the back end, across from the middle
   and positive toward the model's left, up from the lowest point). The workflow `measured` tells a session to write
   `<name>.parts.json`, then `<name>.build.py`, and never to edit the GLB.

### Do these on the PC, in this order

1. `npm test` in the editor. Expect every test to pass, with the Blender suites running (not skipped). If Blender is
   not on the PATH, the config's `blender` or the plugin's Blender setting names it.
2. In `comfy-ui-model-workflows`:
   `blender --background --factory-startup --python-exit-code 1 --python tools/test_inspect.py`
   Expect `INSPECT_TEST ok`.
3. **One real generation.** Start the editor on a project with a draft whose views are approved. In step 3:
   - press **Check the views against each other** and note what it says;
   - generate the model (only when ComfyUI's queue is empty, one run at a time);
   - confirm the result line shows the mesh numbers, and that the model opens in the viewer.
4. **Measure the views check on real drawings** (the plan's Task 4, step 5). Run the check on every draft with
   approved views, and on one deliberately wrong set (swap one view for another object's). Write the outline numbers
   into the README's match section as a small table, with one line on what sound pairs scored. The default stays 0.9;
   if sound pairs score below it, say so there and name the setting. Then tick the item in `todo.md`.
5. **Prove the measured build on the ship** (the plan's Task 9, step 5). Send a loop job for the light cruiser with
   the workflow **Build from measurements**, target 0.85, three rounds, and handle it by the skill. Put what it
   reached, and what the outlines could not give, in `todo.md`.
6. **One ordinary loop job** with the Blender workflow on a generated model, to see `drift` stay empty when the model
   is only fixed, and to look at an overlay with the fit on.

### Things to watch for while testing

- The 0.9 limit has only met test shapes so far (matching views scored 1.0, a wrong pair 0.38). Real drawings of one
  object will score lower than 1.0. Step 4 above is how we learn by how much.
- With `planUp: "auto"`, `match.mjs outline` takes the direction of top and bottom views from the model's last score.
  With no score yet it assumes the front is toward the top of the picture and says so in `note`. Score the model first.
- The measured workflow has no size or triangle limit, but the origin and floating pieces are still held. The skill
  says where the origin goes.
- The best-fit search is small on purpose (width 0.90 to 1.10, 8 pixels each way). A large missing part is only
  partly re-centred.
- The floating-pieces check takes a few seconds on a mesh of several hundred thousand triangles in many dense pieces.

## Handoff, 2026-11-27: the viewer finds every asset

This is on `main` as well (merged and pushed 2026-11-27). Test it after the steps above.

- The model viewer lists every `.glb` in the project, not only the `models` folder. Build and cache folders are left
  out (`dist`, `build`, `out`, Unity's `Library` and `Temp`, dot-folders). Config: `assets: { skip, levels }`, or
  `assets: false` for the old behaviour.
- **Levels** are listed first: a `.glb` with a `.json` of the same name beside it, or one `assets.levels` names.
- A model's path is now counted from the project's folder. A path counted from the `models` folder still opens: old
  review jobs, old links, and unsent pins kept in the browser (they move to the new path when the model is opened).
- The palette and New model still use the `models` folder only.
- A project's own materials are shown on its models (`src/materials.mjs`; README, "A project's own materials"), with
  Textured, Clay and Vertex mask shading and a Colliders switch.

On the PC, open Thoon Run and Perseus in the viewer and check: the town is under **Levels** and opens; a character
from `art/export/townsfolk` shows its reference images; a Perseus kit piece shows its scanned materials, and one
whose material name has two sets (`a|b`) blends them without a shader error in the browser's console. Perseus has no
level listed until its config names one in `assets.levels`. Thoon Run's cave is not a `.glb` and is not listed.

### Known and left for later

`todo.md` has the list. From this branch: the overlay's placement has no test that reads its pixels; the combined
score's guard has no test that fails without it (the fixtures are one colour); `outlines()` repeats some of
`start()`'s code for running Blender; the plugin `nfgames.comfy-model` imports `src/match.mjs` directly, which works
only for the built-in copy. Rigging, weights, animation clips and FBX export are not started.
