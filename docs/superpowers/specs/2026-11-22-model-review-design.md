# Model review: view a game's models, pin what is wrong, send it to Claude Code: design

Date: 2026-11-22. Status: approved by the user on 2026-11-22, section by section.

## Intent

Game models (GLB) come out of pipelines such as Blender scripts, image-to-3D tools and texture
generators, and they need many rounds of "this part is off". Today the user describes problems in words
in a terminal. Add a **model viewer** to the editor where the user opens any model of the game, drops
**pins** on the exact spots that need fixing, writes a note on each (with reference images), picks a
**workflow**, and presses **Send**. The job reaches the Claude Code session open in the user's terminal,
which fixes it and reports back in the viewer.

Decided by the user:

- Models come from a folder named in the project config (`models`).
- Problems are marked with **3D pins and notes**. Pins also take **reference images** (drop or paste).
- **Send** writes a job to a **file inbox** that a Claude Code session watches with the **Monitor tool**.
  Channels (push into a session) were considered and set aside: research preview, need a restart with a
  development flag, and an MCP SDK dependency.
- **three.js is not shipped with the editor.** The viewer offers **"Install three.js"**, which downloads
  a pinned version on demand.
- The user chooses a **workflow** per job. **Auto** works now; **Blender** and **ComfyUI** are
  placeholders, listed in `todo.md`.

## Goals

- List every `.glb` under the project's `models` folder and show any of them with its real materials
  and textures (including Draco, meshopt and KTX2 compressed files).
- Pins on the model's surface that record where they are in the model's own frame, what they hit (mesh,
  material, UV), the view, a screenshot, a note and reference images.
- One click from "this is wrong" to a job on disk that a Claude Code session picks up.
- See each job's progress (queued, working, needs input, done, failed) and reload the model after a fix.
- Keep the editor's rules: no npm dependencies, loopback only, nothing from the project served except
  what a route is built for, no shell.

## Non-goals (this version)

- The Blender and ComfyUI workflows themselves (placeholders only; see `todo.md`).
- Editing models in the viewer (moving parts, painting). The viewer only looks and annotates.
- `.gltf` files with separate `.bin` and image files (only self-contained `.glb`).
- Showing models in the map's 3D view (that view still draws kinds as boxes).
- Pushing jobs into a session without a watch (Channels): a later option, noted in `todo.md`.

## Anti-goals

- Shipping or vendoring three.js in the repository.
- Loading code from a CDN at run time into a page that can write files.
- Any path in a request that is used as a path on disk without being resolved and confined.

## Approaches

**Rendering.** (a) three.js, installed on demand: real PBR, every compression format, well tested.
(b) Our own WebGL GLB loader, like the map's 3D view: weeks of work and still no Draco, KTX2 or proper
PBR. (c) three.js from a CDN: easy, but remote code in a page with write access. **Chosen: (a).**

**Delivery to Claude Code.** (a) File inbox plus Monitor watch: works with the already-open session,
no dependencies, jobs survive when nobody is watching; the watch must be started once and re-armed when
it expires (at most 30 minutes). (b) Channels: real push, but research preview, restart with
`--dangerously-load-development-channels`, MCP SDK dependency, and a bridge process. (c) The cross-session
socket: wire format undocumented. **Chosen: (a).**

**Where the viewer lives.** A separate page (`viewer.html`), not more of `editor.html` (already about
1,200 lines). It shares the server, its security checks and its look.

## The design

### Config

Two new options in `map-editor.config.mjs`, plus one for workflows:

| Option | Default | What it does |
|---|---|---|
| `models` | none (the viewer says how to set it) | the folder whose `.glb` files the viewer lists, subfolders included |
| `reviews` | `.review` | the folder (in the project root) jobs are written to |
| `reviewWorkflows` | Auto, Blender (placeholder), ComfyUI (placeholder) | `[{ id, label, description, enabled, instructions, instructionsFile }]`, or a default's id (`'auto'`): the Workflow list. `instructions` is text; `instructionsFile` is a file inside the project whose text is added to it. Both are copied into the job. Entries with `enabled: false` show as "(not set up yet)" and cannot be chosen. A project's list replaces the defaults; it may include the defaults by id |

`models` and `reviews` are checked at start-up like other paths: they must be inside the project root.

### Installing three.js

- The editor's source pins one three.js version and the SHA-512 of its npm tarball
  (`registry.npmjs.org/three/-/three-<version>.tgz`).
- `GET /api/vendor` says whether that version is installed. When it is not, the viewer shows
  **Install three.js** with the version and download size.
- `POST /api/vendor/install` (Origin and JSON checks as for Save; one install at a time):
  1. downloads the tarball (Node's `fetch`) to a temporary file,
  2. checks its SHA-512 against the pinned value; on a mismatch nothing is installed,
  3. reads it with `node:zlib` (gunzip) and a small tar reader written for this, and keeps only an
     allow-list of files: the core module(s), `GLTFLoader`, `OrbitControls`, `DRACOLoader` and the Draco
     decoder, `meshopt_decoder`, `KTX2Loader` and the Basis transcoder, plus what those import,
  4. writes them to `vendor/three-<version>.tmp/`, then renames it to `vendor/three-<version>/`.
     A failed install removes the temporary folder. `vendor/` is git-ignored.
- `GET /vendor/three-<version>/<file>` serves only files in that folder, only for the pinned version,
  with the right content types (`.js`, `.wasm`). Anything else is a 404.
- The page loads three.js through an import map pointing at those URLs.
- Updating three.js means changing the pinned version and hash in the source and installing again.

### Models

- `GET /api/models` lists `.glb` files under `models` (recursively, symlinks not followed): relative
  path, size, modified time.
- `GET /api/model?path=<relative path>` streams one file. The path is resolved against `models`, its real
  path must be inside the real `models` folder, and it must end in `.glb`; otherwise 400 or 404.

### The viewer page (`viewer.html`)

- **Left:** the model list, grouped by subfolder, with a filter box.
- **Centre:** the 3D view: orbit, pan, zoom; reset view; lighting presets (studio, dark space);
  wireframe toggle. A model over 200 MB asks before loading. A load error is shown and the list stays usable.
- **Right:** the pins of the current model, the job's overall note, the **Workflow** list, **Send to
  Claude**, and recent jobs with their state.

### Pins

- **Pin mode** (button, or `P`): a click on the model drops a numbered pin at the surface point and opens
  its note. Pins can be edited, dragged to another point, and deleted. Clicking a pin in the list flies the
  camera back to the view it was placed from.
- A pin records: `n`, `note`; `position` and `normal` in the model's own frame (glTF, metres, Y up);
  `mesh` and `material` names; `uv` (the texture coordinate at that point); `camera` (position, target,
  field of view); a JPEG screenshot (about 1280 px wide) with the pin highlighted.
- **Reference images:** drop onto a pin's note or paste (Cmd/Ctrl V). PNG, JPEG or WebP, at most 4 per
  pin. The page scales each to at most 2048 px on its long side before sending (PNG kept when it has
  transparency, else JPEG). Thumbnails on the pin, removable, click to enlarge.
- **Drafts** (pins, notes, images) are kept per model in **IndexedDB**, so a reload loses nothing.

### Send and the job

- **Send to Claude** posts the job to `POST /api/review` (Origin and JSON checks; this route's body limit
  is 24 MB, every other route keeps 2 MB). The draft is cleared only after the server confirms; sent pins
  stay visible, greyed, until the job finishes.
- The server writes the job into `<reviews>/<id>.tmp/` and renames it to `<reviews>/<id>/` when complete,
  so a watcher never sees half a job. `id` is `<UTC time>-<model file name, slugged>`, made by the server.
  Every file name in the folder is made by the server; nothing from the page becomes a path. Images are
  checked by their bytes (PNG, JPEG or WebP signatures) and size.

```
<reviews>/2026-11-22T0412-light-cruiser-bow/
  job.json         model path, its SHA-256 and modified time, note, workflow (id, label, instructions), pins[]
  overview.jpg
  pin-1.jpg
  pin-1-ref-1.png
  status.json      written by Claude
```

- `status.json`: `{ state: "working" | "needs-input" | "done" | "failed", summary, question?,
  updatedAt, changedFiles[] }`. No `status.json` means queued.
- `GET /api/reviews` lists jobs (newest first) with their state and summary; the page polls it every few
  seconds. A malformed `status.json` shows as "unknown". A job that is done and whose model file changed
  since the job was written offers **Reload model**.
- If no job has been picked up for a while (no `status.json` written within two minutes of the oldest
  queued job), the page says: no Claude session seems to be watching; say "watch the review inbox" in
  the terminal. The job stays queued.

### Workflows

- The Workflow list comes from `reviewWorkflows`. **Auto** (default): Claude decides how to fix (a build
  script in the project, Blender, or editing the file). **Blender** and **ComfyUI**: placeholders, shown
  disabled as "(not set up yet)".
- The chosen workflow's `id`, `label` and `instructions` (text) are copied into `job.json`, so the skill
  needs no change when a project adds a workflow.

### The watcher (`bin/review-watch.mjs <project>`)

- Prints `NEW JOB <reviews>/<id>` once for each job folder without a `status.json`: first those already
  waiting, then new ones as they appear (`fs.watch`, with a 2 s poll as fallback). No dependencies.
- It is what the Claude Code session runs with the Monitor tool.

### The Claude Code side (`skills/model-review/SKILL.md`)

The README says how to install it into a game project's `.claude/skills/`. It tells the session to:

1. On "watch the review inbox", start `review-watch.mjs` with the Monitor tool, and start it again when
   the watch ends.
2. For each job, one at a time: write `status.json` `working`; read `job.json`, the screenshots and the
   references; follow the job's workflow instructions; find how the model is made, and fix the source
   and rebuild when there is a build (rather than editing the exported GLB); render the area around each
   pin after the fix as `pin-N-after.jpg`; write `done` with a short summary and the changed files, or
   `failed` with the reason.
3. When it needs the user's decision, write `needs-input` with the question, and ask in the terminal too.

The session's permissions apply as always; a job cannot grant more. Job notes are the user's own words
from their own editor, read as instructions for fixing that model only.

### Security

The existing rules hold (loopback, Host check, Origin and JSON on every POST, `no-store`, `nosniff`, no
shell). New: the vendor folder is served only for the pinned version, from an allow-list of files that
the install wrote; model reads are confined to the real `models` folder and to `.glb`; job writes go
only to server-named folders and files under `reviews`; the install runs only code whose hash matches.

## How it is built

- `src/vendor.mjs`: pinned version and hash, download, hash check, tar reader, allow-listed extract,
  install state; serving vendor files.
- `src/models.mjs`: listing and confined path resolution.
- `src/reviews.mjs`: job writing (temporary folder then rename), image checks, listing with status,
  workflow lookup and the built-in defaults.
- `src/server.mjs`: the new routes and the per-route body limit.
- `src/project.mjs`: the new config options and their checks.
- `src/viewer.html`: the page.
- `bin/review-watch.mjs`, `skills/model-review/SKILL.md`.
- `.gitignore`: `vendor/`.

### Tests

`node --test`, no dependencies, no network:

- `models.mjs`: `..`, absolute paths, symlinks out of the folder, non-`.glb` files.
- `vendor.mjs`: the tar reader and allow-list on a small fixture tarball; a hash mismatch installs nothing;
  a failed install leaves no folder.
- `reviews.mjs`: job layout, temporary-then-rename, oversized and mislabelled images refused, workflow
  lookup, malformed `status.json`.
- Server: Host and Origin checks and body limits on the new routes; the install route with the download
  stubbed.
- Watcher: existing and new jobs each printed exactly once.
- Browser check (`scripts/browser-check.mjs`): the viewer with a stub three.js; place a pin, attach an
  image, send; the job folder appears on disk.

### Docs

README: the viewer, the config options, installing three.js, the review inbox, the watcher and the skill,
and the security notes. `docs/viewer.png` screenshot.

## Left to the builder

- The exact three.js version to pin (the newest stable at build time) and its tarball hash.
- The tar reader's scope: regular files only, USTAR and the PAX long-name form npm uses.
- Pin drawing (sprites or HTML labels) and the screenshot highlight.
