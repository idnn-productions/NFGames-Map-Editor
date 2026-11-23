# Reference images for a model: design

Date: 2026-11-23. Status: built on the branch `model-references`; the convention was decided by the user.

## Intent

A model is made from images: a concept, and views of it (front, left, back ...). When the model is reviewed, those
images are the thing to compare it with, and today they are somewhere else: in a draft, in a generator's input
folder, in another window. Show a model's reference images **next to the model** in the viewer, so the user can look
from one to the other while pinning what is wrong, and give the session that fixes the model **the same images** as
its reference.

## The convention (decided)

A model `<dir>/<name>.glb` under the project's models folder may have a sibling folder `<dir>/<name>.refs/`. The
image files in it (`.png`, `.jpg`, `.jpeg`, `.webp`) are the model's references.

- **No manifest.** The files are the list; nothing to keep in step with them.
- **Order:** `concept` first, then `front`, `left`, `back`, `right`, `top`, `bottom`, `three-quarter`, each when
  present, matched on the file's name without its extension, in any case. Then everything else by name.
- **Label:** the name without its extension.

This mirrors a New model draft (`.nfgames/drafts/<name>/concept.png` and `views/<view>.png`), which is where such
images come from: a draft's files can be copied into a `.refs` folder as they are.

## Goals

- The viewer shows a model's references when it has any, and nothing new when it has none.
- A reference can be seen large **while the model is still in view and still turns**.
- A review job for a model with references names them, so the session works from them.
- The security model is unchanged: nothing of the project is served except through a route built for it.

## Non-goals (this version)

- **No upload from the viewer.** References are put in the folder by hand or by a script. (Pins still take dropped
  and pasted images of their own; those are about one spot, and travel in the job.)
- **No link back to drafts.** A model does not know which draft it came from, and New model does not write a
  `.refs` folder yet: that belongs with its step ③ (`todo.md`).
- No thumbnails made on the server (a thumbnail is the whole image, drawn small), no image editing, no SVG.
- No turning the model to match a view's angle.

## Anti-goals

- A second copy of the references in every job. A job names them; it does not carry them.
- A route that serves "a file near a model". It serves images of one folder, by plain name.

## The design

### Routes

| Route | Answers |
|---|---|
| `GET /api/model/refs?path=<model path>` | `{ refs: [{ name, size, mtime }] }`, in display order. `[]` when the model has no `.refs` folder, or `path` is not a `.glb` of the models folder |
| `GET /api/model/ref?path=<model path>&name=<file name>` | the image's bytes with its `Content-Type` (`image/png`, `image/jpeg`, `image/webp`), or 404 |

Both are GETs under `/api/`, so the Host check applies, and both answer with the headers every response has
(`no-store`, `nosniff`, `X-Frame-Options`, `Referrer-Policy`).

### Their checks (`src/models.mjs`)

1. The model is resolved with `resolveModel`, as for `/api/model`: a relative path to an existing `.glb` whose real
   path is inside the real models folder.
2. The references folder is derived from the model's **real** path (`.glb` → `.refs`), never from the request. It
   must be a real folder, not a link: its real path must be itself.
3. `name` must be a plain file name: a string of at most 120 characters, no `/`, `\`, `:` or NUL, no leading dot,
   ending in one of the four extensions. It must be a name the folder really holds, spelled as it is there.
4. The file must be a regular file, not a link, with its real path inside the folder, and at most **40 MB**.
5. Its first bytes must be the image its name says (PNG, JPEG or WebP signature; the same check job images get). A
   text file named `x.png` is neither listed nor served. SVG is never served: it can carry script.
6. At most **24** references are listed per model.

A file that fails a check is left out of the list, so the list and what can be fetched agree.

### The viewer (`src/viewer.html`)

- Opening a model fetches its references. With none, nothing is added to the page.
- **References (n)**: a strip of thumbnails with labels over the foot of the 3D view. It is in the page's own centre
  column, so it is there both standalone and in the workbench (where the side columns are lent away). Clicking the
  heading folds it.
- Clicking a thumbnail opens that image in a **panel beside the 3D view**. The view narrows and stays live: orbit,
  pins and screenshots work as before. The panel has the label, "2 / 7", previous, next and close; its left edge
  drags to resize, and the width is remembered (`localStorage`, a convenience only).
- Clicking the large image shows it whole over the page (the lightbox the pins' images use).
- Keys: **←** **→** previous and next; **Esc** closes what is on top: the lightbox, then pin mode, then the panel.
- A panel left open stays open when another model is opened, on the same view when that model has one, so several
  attempts at one model can be compared against the same reference in turn.

Considered and set aside: a lightbox alone (it hides the model), and a place in the right column (in the workbench
that column is the Inspector, far from the model and narrow).

### Review jobs (`src/reviews.mjs`)

- `job.json` gains `references`: the paths of the model's references **from the project root**, forward slashes, in
  display order (`[]` when there are none). The server works them out; the page sends nothing new.
- The job's `workflow.instructions` (the text the session follows) ends with a paragraph naming them and saying they
  are what the model was made from and the ground truth for what it should look like.
- The bytes are not copied into the job folder. The references live in the project, where the session works anyway.

### The skill (`skills/model-review/SKILL.md`)

Handling a job now includes: open every image in `references` and treat them as the ground truth; never change them.

## Tests

- `test/models.test.mjs`: the order (mixed case, written out of order); no folder, no model, a `.refs` folder that
  is a link; the cap of 24; names refused (`..`, slashes, backslashes, NUL, a drive, a leading dot, other
  extensions, SVG, a wrong-case name, a link, a folder, a file over 40 MB, bytes that are not the image named).
- `test/viewer-server.test.mjs`: both routes over HTTP: the list and its empty cases, the content types and
  headers, refused names and models, and that the image is not served by its path.
- `test/reviews.test.mjs`: `references` in `job.json` (empty, then in order, from the project root), the paragraph
  in the instructions, and that no reference is copied into the job.

## Left for later (`todo.md`)

- New model's step ③ writing `<name>.refs/` beside the `.glb` it makes.
- Adding and removing references from the viewer; linking a model to its draft.
- Small thumbnails from the server; turning the model to a view's angle.
