# New model: look closer, send back with notes, and generate the model

Date: 2026-11-23. Status: built (plan: `docs/superpowers/plans/2026-11-23-model-generation.md`).

## Why

New model makes a concept image and one image per view, and stops there: step ③ is a disabled button. Three things
are in the way of using it for real assets:

1. A generated image can only be picked. One that is nearly right (a wrong window, a missing fin) means retyping the
   whole prompt and hoping. The user wants to point at what is wrong and send that image back.
2. Candidates are small tiles. Three fronts of the same object cannot be told apart at that size.
3. The model itself is made elsewhere, by hand: a ComfyUI workflow and a Blender pass we built and proved on this PC
   (Pixal3D multi-view, UltraShape refinement, colour projected from the views). Step ③ should run it.

## Goals

- Any image in New model opens large. Rounds can be stepped through at full size.
- An image can be marked with numbered pins and notes and sent back: a new round of the same step, made from it.
- A bottom view, so the model step gets top and bottom for colour.
- Step ③ generates the model from the approved views and saves it where the model viewer shows it, with its
  references beside it.
- Step ③ says plainly what it needs (ComfyUI running, our workflow's nodes installed, the workflows folder, Blender)
  and which of those are missing, with where to get them.
- The ComfyUI workflow is published as its own open repository.

## Non-goals

- An automatic "agent fixes the model before the user sees it" pass. Next piece of work, not this one.
- Running ComfyUI or Blender on another machine than the editor's. (Nothing here prevents a remote ComfyUI later.)
- Installing ComfyUI, the models or Blender for the user. The editor says what is missing and links to the guide.
- Single-image model generation, TRELLIS.2 as a choice in the editor, cancelling a running generation.
- Drawing tools beyond pins (freehand, boxes, erasing parts of the image).

## Anti-goals

- The editor needing ComfyUI, Blender or Python to start or to do anything it does today.
- A new npm dependency, or any process started through a shell.
- A GPU run that starts without the user pressing a button (the machine this runs on is used remotely and must not
  be driven into the ground), or one queued silently behind someone else's ComfyUI work.
- The workflow or the Blender script copied into the editor, where they would drift from their repository.

## Constraints

- Dependency-free Node ≥ 20, macOS and Windows. Tests run on both without ComfyUI, Blender or Codex installed.
- Plugins work through their API: project files only under `touches.files`, programs only from `touches.commands`.
- The editor runs one job at a time.
- Draft files stay version 1: everything added is optional and older drafts open unchanged.

## Approaches to the model step

1. **The plugin talks to ComfyUI over HTTP and runs Blender itself. Chosen.** No Python needed (on Windows `python`
   on the PATH is often a Store stub); each requirement can be checked on its own, so the info box is exact; a remote
   ComfyUI later is a settings change. Cost: the plugin repeats the queue-and-wait logic of `tools/make_asset.py`, and
   the workflows repository ships the workflow in ComfyUI's API format too.
2. The plugin runs `make_asset.py`. Thinnest, one copy of the logic; depends on a working Python, and a missing piece
   shows up only as the script's error text.
3. Workflow and Blender script bundled in the editor. Nothing to point at; drifts. Ruled out.

Jacek chose 1.

## Design

### A. Large view (plugin `nfgames.model-maker`, page only)

- Clicking any image (a candidate, a reference, the approved concept, an earlier round, step ③'s summary) opens it
  large over the tab: the image fitted to the space, its step and round named, ← → (keys and buttons) through the
  images of the same round, Esc or a click outside closes.
- Picking is no longer the click on a tile. A candidate tile has a **Pick** control in its corner (shown picked when
  it is the pick), and the large view has a **Pick this one** button. Images that cannot be picked (made from an
  earlier concept, references) have neither.

### B. Notes on an image, and sending it back

- The large view of a pickable candidate has **Add notes**. In that mode a click on the image drops a numbered pin
  (up to 12); each pin has a short note (up to 300 characters) in a list beside the image, and can be removed. There
  is one overall note (up to 1000 characters) and a **How many** (1 to 8, default 2).
- **Regenerate from this** starts a new round of the same step. It needs at least one pin with a note, or the overall
  note. The round is run through the image service like any other and lands as the step's newest round.
- What is sent: the round's own prompt, then the instruction to revise; references are the image itself, a marked
  copy (the image with the numbered pins drawn on it, made in the page on a canvas), and for a view the approved
  concept. Each pin's note is also written with where it is in words ("1, upper left: …"), from its position, so the
  correction does not depend on the model reading the marks. The prompt says the marks are not part of the picture
  and must not appear in the result, and that everything not mentioned stays as it is.
- Kept in the draft: the new round also has `from` (the image it revises), `pins: [{ x, y, note }]` (0 to 1 from the
  image's top left) and `note`. The marked copy is saved under `.nfgames/drafts/<slug>/marks/`. A round with `from`
  shows "revised from" with a small copy of that image, and its notes.
- Rules (in `draft.mjs`, pure): the image must be one of that step's; for a view, of a round made from the approved
  concept; the concept step's revision uses the image alone (not the user's uploaded references).
- New route `POST /draft/revise { slug, step, image, pins, note, count, marked }` (`marked`: the PNG as a data URL,
  size-limited like references), answering like `/draft/round`. Settling is unchanged.

### C. Views

- `bottom` joins the views that can be made ("straight up from below"). Order: front, back, left, right,
  three-quarter, top, bottom.
- The drafted view prompts are tightened for the model step: same proportions as the concept, the whole object,
  nothing cropped; top and bottom are drawn nose up, as the workflow expects, and with the same length-to-width
  proportion as the side and front views show.
- The model step uses front, left, back and right (all four required), and top and bottom when both are approved.
  three-quarter is never sent; the page says so.

### D. The workflows repository

- The local repository `comfy-model-workflows` is published as `idnn-productions/comfy-ui-model-workflows`, public,
  MIT, "Copyright (c) 2026 IDNN Productions" (as `comfy-ui-video-workflows`). It holds only our own code and
  workflows; the README says which model licences apply to what the user downloads (UltraShape's excludes the EU, the
  UK and South Korea).
- Added there: `LICENSE`; `pipeline.json` at the root, `{ "pipeline": "asset3d", "version": 1, "multiview":
  "workflows/api/asset3d-pixal3d-multiview-ultrashape.json", "finish": "tools/blender_finish.py" }`; the multi-view
  workflow in ComfyUI's API format, each node keeping its title in `_meta.title` (the `in_…` and `out_…` names the
  README already documents); a README section on use from the editor. `tools/check_workflows.py` checks the API file
  has every documented title.

### E. Plugin `nfgames.comfy-model` (new, built in)

- A service `model`, provider "ComfyUI on your computer", cost 0 ("runs on your GPU"), with two actions.
- Settings: `comfyUrl` (default `http://127.0.0.1:8188`), `workflowsDir` (the user's checkout of the workflows
  repository; empty by default), `blender` (path to the program; empty means look on the PATH, then in the usual
  places: `%ProgramFiles%\Blender Foundation\Blender *\blender.exe` newest first,
  `/Applications/Blender.app/Contents/MacOS/Blender`).
- `status` → `{ ready, checks: [{ id, ok, text, help }], queue }`, checks in order: **workflows** (the folder has a
  `pipeline.json` of a version this plugin knows and the files it names), **comfy** (the URL answers), **nodes**
  (every node type the workflow uses is in ComfyUI's `/object_info`; names the missing ones), **blender** (found).
  `queue` is how many prompts ComfyUI is already running or holding. A fifth check, **models**: the model files the
  workflow names are in the option lists of their loader nodes in `/object_info`, and UltraShape (its code, its Python
  packages, its checkpoint) is there, which the workflows repository's node pack reports at a new small route,
  `GET /asset3d/status`. UltraShape missing is a cross only while "Refine with UltraShape" is on; a ComfyUI whose
  node pack is too old to have the route shows that part as "not checked".
- `generate { draft, length, faces = 60000, ultrashape = true, pivot = 'centre', wait = false, replace = false }` →
  `{ model, refs, report }`. The service itself refuses when ComfyUI's queue is not empty unless `wait` is true, and
  when the model file exists unless `replace` is true: the rule holds for every caller, an agent included (an agent's
  first use of a service in a session is already put to the user). One
  job, shown in Jobs, in steps: check (as `status`; stops with what is missing); upload the draft's approved views to
  ComfyUI's input folder under `nfgames/<slug>/`; set the workflow's inputs by title and queue it; wait, polling its
  history (30 minute limit, ComfyUI's own error text on failure); download the GLB; run Blender headless with the
  repository's finish script (scale to `length` metres, pivot, compressed textures); write
  `models/<slug>/<slug>.glb` and `models/<slug>/<slug>.refs/` (concept and every approved view).
- It reads `.nfgames/drafts/<slug>/` and writes only under `models/<slug>/`. A project whose models folder is set
  somewhere that does not contain `models/` is refused with that reason.
- The service declares no `needs`: the Services screen lists it, and readiness is what `status` says. (Services'
  `needs` know programs on the PATH and keys, neither of which fits a URL or a folder.)
- Core change, small: a job's program is checked against `touches.commands` by its name without `.exe` and without
  regard to case, so `C:\…lender.exe` and macOS's `…/MacOS/Blender` both pass as `blender`.

### F. Step ③ in New model

- An info box, **What this step needs**, from `status`: a tick or a cross for each check, with for a cross what to
  do: a link to the workflows repository's setup guide, to Blender's download, and a button to the plugin's settings.
  It is always shown; when everything is there it is one line.
- The approved concept and views, with which of them the model is made from.
- **Longest side (metres)**, required; **Triangles** (default 60000); **Refine with UltraShape** (on).
- **Generate model**: off until `status.ready`. When ComfyUI's queue is not empty it asks first ("ComfyUI is working
  on N other prompts: this one waits its turn") and sends `wait`. When `models/<slug>/<slug>.glb` exists it asks
  before replacing it and sends `replace`.
- While it runs: the job's step, as Jobs shows it. After: the result's numbers (triangles, size, megabytes), and
  **Open in the model viewer** (`/viewer?model=<slug>/<slug>.glb`). The draft keeps `model: { path, length, at }`
  (route `POST /draft/model`, which checks the file is there).
- A draft reopened while a generation is still running shows it as running (from `/api/job`), like rounds do.

## Tests

- `draft.mjs`: bottom; revision rules and the prompt text (positions in words, marks named as not part of the
  picture). Server routes: `/draft/revise`, `/draft/model`, with the stand-in `codex`.
- `nfgames.comfy-model`: against a stand-in ComfyUI (a small HTTP server in the test: `/object_info`, `/queue`,
  `/upload/image`, `/prompt`, `/history`, `/view`) and a stand-in `blender` (the test helper `fakeCommand`), on
  both systems: every `status` outcome, a run that succeeds, one ComfyUI rejects, one that fails mid-run.
- The page: the browser check opens an image large, steps, drops a pin, and sees step ③'s info box.
- Once, by hand, on this PC with the real ComfyUI and Blender: a draft through to a model in the viewer.

## Calls made in writing this (Claude's, not Jacek's)

- The queue and replace rules live in the service, not only in the page (above).
- Which side is "left": the editor's "from its left side" must be what the workflow's `in_left_image` expects. This
  is settled first, before any prompt work, from the ship already made (its left reference against the model seen
  from that side), and the mapping or the prompt wording is corrected to match.
- Real generations (to prove prompt wording, and the end-to-end run) are run by the builder on this PC, one at a
  time, only when ComfyUI's queue is empty.
- The repository is published as one fresh first commit, not with its local history: the history and `SETUP.md`
  carry this machine's paths and notes, which are cleaned out of the files first. The local history stays local.

## Left to the builder

- The look of the large view and the pins, within the shell's UI kit and theme.
- The exact wording of the revision prompt and the view prompts, proven on real generations.
- How the plugin finds the newest Blender in the usual places.

## Order of work

A, B, C (the page and the draft rules), then D (the repository gains its API workflow and `pipeline.json`), E, F,
the real run, and last the repository is published.
