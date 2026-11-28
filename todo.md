# To do

Follow-ups for the model viewer and review inbox (design: `docs/superpowers/specs/2026-11-22-model-review-design.md`;
reference images: `docs/superpowers/specs/2026-11-23-model-references-design.md`).

## Workflows (placeholders in the viewer today)

- [x] **Blender workflow** (`enabled: true`; its words are in `src/reviews.mjs` and the skill). Still open: Draco, WebP or
      KTX2 on export, and a way for a project to name its .blend or build script (it is searched for today).
- [x] **Angelo workflow**, through Angelo's MCP server, with the Angelo 0.1.0 problems in the skill.
- [x] **Build from measurements workflow** (`measured`; the words are in `src/reviews.mjs` and the skill): a hard-surface model is
      rebuilt from `<name>.parts.json`, measured with `match.mjs outline`. Open: the proof by hand on the ship (a loop job with this
      workflow, target 0.85, three rounds) needs another computer; put what it reached, and what the outlines could not give it, here.
- [x] **Reference match** and the **match loop** (`src/match.mjs`, `src/match/score.py`, `bin/match.mjs`). Open:
      - the loop's first round is still a session's work: nothing starts a Claude Code session for a job;
      - the limits of `match.limits` are one number for the whole model: the `measured` workflow has no size or triangle limit, but a model
        that is meant to grow in any other workflow still has to turn the limit off in `match.limits`;
      - a lighting match for the colour score (reference art is shaded, the render is flat);
      - the model is scored on one material pass: models with several UV sets, vertex colours or alpha blending are only
        as good as Workbench's texture display;
      - show a round's overlays (`round-N-overlay-<view>.png`) in the job list, and a before/after of a round;
      - a `.glb` with an unclean reference background cannot be scored well: let the user paint a mask or pick the background colour;
      - the scorer renders at 768 px with Workbench: a finer final pass for thin parts (rigging, antennas).
- [ ] **ComfyUI workflow.** Regenerate textures or reference images through a ComfyUI graph: how the
      server is reached (local URL), which graphs exist, how a pin's UV area maps to a texture region to
      repaint, and where results land. Then set `enabled: true`.
- [ ] A way for a project to point a workflow at its own instructions file (e.g. the light cruiser's
      `light-cruiser/build/README.md`), with an example in `examples/sample`.

## Delivery to Claude Code

- [ ] Re-check **Channels** when they leave research preview: a channel bridge would push jobs into a
      session with no watch to start or re-arm.
- [ ] Optional: a plugin monitor that starts the inbox watch automatically when the skill's plugin is on
      (check the plugin monitor schema first).

## New model

- [x] **Generate the model** from a draft's `concept.png` and `views/` (step ③ of New model, through `plugins/comfy-model/`):
      saves `models/<slug>/<slug>.glb` and copies `concept.png` + `views/*.png` into `<slug>.refs/`.
- [ ] Measure the views check on real drafts: run **Check the views against each other** on every draft with approved
      views and on one deliberately wrong set, write the outline numbers into the README, and say what sound pairs scored
      against the 0.90 default.
- [ ] A side panel and an Inspector for the New model tab (they say "nothing to show here" today): the drafts list
      on the left, the picked image large on the right.

## Viewer

- [x] Every `.glb` in the project is listed, not only the `models` folder; levels (a `.glb` with its `.json`) first.
- [x] A project's own materials on its models, clay and vertex-mask shading, colliders shown or hidden.
- [ ] A level opened as the game shows it: its sky (`.hdr`), its spawn point and its walk grid.
- [ ] Levels that are not a `.glb` (Thoon Run's cave in `public/assets/level2/` is in the game's own format).
- [ ] The viewer's repeat sizes for Perseus's material sets are a table in the page (`MAT_TILE`); they belong in the
      project's `materials.json` as `tile`, which the viewer already reads first.
- [ ] A scripted browser check of the viewer's list (Levels, the filter, an old link); it was tried by hand on Thoon Run.
- [x] A model's reference images beside it in the viewer (`<name>.refs/`), and named in its review jobs.
- [ ] References: add or remove them from the viewer (they are copied in by hand today), and link a model back to the
      draft it came from.
- [ ] References: thumbnails made small on the server (each thumbnail is the whole image today).
- [ ] References: turn the model to a view's angle when its reference is opened (front, left, top ...).
- [ ] `.gltf` files with separate `.bin` and images.
- [ ] Before and after: show `pin-N-after.jpg` next to the pin's own screenshot in the job list.
- [ ] Compare two models side by side (e.g. a TRELLIS test against the hard-surface rebuild).
- [ ] Show models in the map's 3D view instead of boxes.
- [ ] New map from the editor (a project with no maps, like Khairos, can only be browsed and reviewed).
- [ ] `scripts/viewer-check.mjs`: a scripted browser check of the viewer (needs `playwright-core`, like `browser-check.mjs`).

## Asset pipeline (Khairos light cruiser)

- [ ] **Pixal3D on a paid GPU.** The free ZeroGPU quota is used up and no inference provider offers Pixal3D.
      Duplicate `TencentARC/Pixal3D` as a private Space under `capnCoconut` on an Nvidia L40S (48 GB, $1.80/hr,
      billed per minute), sleep after 10 min idle; run `pixal2.py` (scratch script: preprocess → generate_3d with
      `download_files=False` → extract_glb_api) against it; save `light-cruiser/3d-tests/pixal3d.glb`; render it
      beside TRELLIS.2; pause or delete the Space. About $0.50–$1.00 per test (mostly the first build). Needs a
      payment method on the Hugging Face account. The cheaper L4 (24 GB, $0.80/hr) may run out of memory.
