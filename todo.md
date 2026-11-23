# To do

Follow-ups for the model viewer and review inbox (design: `docs/superpowers/specs/2026-11-22-model-review-design.md`;
reference images: `docs/superpowers/specs/2026-11-23-model-references-design.md`).

## Workflows (placeholders in the viewer today)

- [ ] **Blender workflow.** Instructions for fixing a model through Blender scripts: find or create the
      build script, re-bake textures, re-export the GLB (Draco, WebP or KTX2). Decide where projects keep
      their Blender scripts and how a job names the .blend or script to use. Then set `enabled: true`.
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

- [ ] **Generate the model** from a draft's `concept.png` and `views/` (step ③ of New model, a disabled button today).
      Choose the image-to-3D service (a `services` plugin like `codex-image`), where the `.glb` lands in the models
      folder, and how a draft is marked done. It should also copy the draft's `concept.png` and `views/*.png` into
      `<name>.refs/` beside the new `.glb`, so the viewer shows them as the model's references.
- [ ] A side panel and an Inspector for the New model tab (they say "nothing to show here" today): the drafts list
      on the left, the picked image large on the right.

## Viewer

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
