# To do

Follow-ups for the model viewer and review inbox (design: `docs/superpowers/specs/2026-11-22-model-review-design.md`).

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

## Viewer

- [ ] `.gltf` files with separate `.bin` and images.
- [ ] Before and after: show `pin-N-after.jpg` next to the pin's own screenshot in the job list.
- [ ] Compare two models side by side (e.g. a TRELLIS test against the hard-surface rebuild).
- [ ] Show models in the map's 3D view instead of boxes.
- [ ] `scripts/viewer-check.mjs`: a scripted browser check of the viewer (needs `playwright-core`, like `browser-check.mjs`).
