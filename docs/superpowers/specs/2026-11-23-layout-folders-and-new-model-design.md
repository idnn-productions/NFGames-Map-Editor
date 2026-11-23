# More room for the map, folding lists, and a "New model" flow: design

Date: 2026-11-23. Status: draft, waiting for the user's approval.

## Intent

The workbench works for early tests but wastes its space and has no way to start a new model. Looked at on the
perseus project at 1440 x 900:

- the map canvas is about 480 px wide. The rest is the palette, the map page's own right column (Save, Problems,
  Selected), an Inspector that only says "Nothing selected", and an empty Jobs panel;
- problems are listed twice (the map's column and the bottom Problems tab, which the map does not feed);
- the map palette is one flat list with no filter; the viewer's list has a filter but its folders cannot close, and
  perseus shows the same 25 models from two folders;
- a stray `null` prints under the ring fields when nothing is selected;
- models can be reviewed but not made.

The user wants, in this order: folders that open and close in the model viewer's left column; a better map layout;
and a flow to make a new model: **prompt for an image → OK the image → prompt for views → OK the views → generate the
model**. Generating the model itself comes in a later update; the image and view steps work now.

## Goals

1. **Folding lists.** Folders in the viewer's model list open and close. The map palette's groups do the same and gain
   a filter.
2. **Layout A (picked by the user).** Each page's right column moves into the workbench's Inspector; problems live
   only in the bottom panel; the bottom panel starts closed. The map and the model get the freed width.
3. **New model.** A three-step screen that ends with an approved concept image and approved view images saved in the
   project, and a disabled **Generate model** step.

## Non-goals

- Generating the 3D model (later update). Choosing the 3D service.
- Rebuilding the map editor or the viewer as plugins. They stay pages in frames.
- Label decluttering on crowded maps, thumbnails in the model list, real models in the 3D view (`todo.md`).
- Changing the standalone pages (`/map?alone`, `/viewer?alone`): they keep both of their own columns.

## Anti-goals

- A map that is narrower than today at any window width.
- A second copy of Save, Problems or Selected anywhere on screen.
- A generation step that spends money or runs Codex without the user pressing a button for that run.

## Approaches

**Layout** (the user picked A):

- **A. Move each page's right column into the workbench's regions.** Most map, one panel system, fixes the viewer too.
  Costs the most wiring between the pages and the workbench. *Picked.*
- B. Keep the pages as they are; hide the empty Inspector and bottom panel, add a collapse button to each page's own
  column. Cheapest, but two panel systems stay.
- C. Full-window canvas with floating panels. Most map, but panels cover it, it is the largest rewrite and it breaks
  from the viewer's look.

**New model** (my call; the user handed over the how):

- **A bundled plugin with its own screen, calling the image service directly.** The `codex-image` service already
  takes a prompt and reference images. *Chosen.*
- Sending a request to a Claude session, like model review does. Rejected: it needs a session watching, and picking
  between candidate images is a quick back-and-forth that belongs on the page.
- Adding the steps to `viewer.html`. Rejected: that page is to be rebuilt as a plugin; new screens should start as one.

## The design

### 1. Folding lists

One small shared script, `src/shell/tree.js`, a classic script like `grid.js` (the map page has no modules). It draws
rows from `[{ path, label, ... }]` grouped by folder:

- a folder row shows ▸ or ▾, the folder's name and how many items are under it; click or Enter toggles it;
- nested folders nest, each level indented; a folder with one child folder and no items of its own is joined to it
  (`web/thoon-run/public/assets/models` is one row, not five);
- which folders are closed is kept in `localStorage`, per project root and per list;
- with text in the filter, every folder with a match is shown open and the kept state is left alone;
- the folder holding the open model (viewer) or the picked kind (palette) is opened when it is chosen from elsewhere
  (the address, **View model**).

**Viewer:** `drawModelList` uses it. All folders start open, as today.

**Map palette:** a filter box above the palette; the palette's groups are the folders. Model kinds, whose groups are
flat strings today (`Models · a/b/c`, `src/modelkinds.mjs`), nest by folder under one "Models" folder; presets, plants
and kit groups stay one level each. Groups start open. The add buttons, layers and legend below the palette are not
changed.

The same models listed from two folders (perseus has real copies on disk) are left as they are: a folder can be closed.

### 2. Layout

`lend.js` today lends one column (`#left`) to the workbench's side panel. It grows to lend named parts to named
regions, moved the same way (into a shadow root with the page's styles; `byId` finds them):

| Part of the page | Goes to |
|---|---|
| `#left` | side panel (as today) |
| the map's Save, Undo, Redo, snap, map picker, status line | a toolbar over the canvas, beside Top / 3D (inside the page: no lending needed) |
| the map's Apply box, status panels, help table, log | Inspector, under a "Map" heading, shown when nothing is selected |
| the map's Selected block | Inspector |
| the viewer's Pins, Note, Workflow, Send | Inspector |
| the viewer's Jobs (review jobs) | a bottom tab, "Reviews" |
| the map's Problems | the bottom Problems tab |

- **Inspector.** While a framed page's tab is shown, the Inspector shows what the page lent it. The Inspector's title
  follows it ("Map", "Selected", "Review"). On other tabs the Inspector behaves as today. If the user has hidden the
  Inspector, selecting something on the map does not reopen it; the bar's existing toggle does.
- **Problems.** The page gives its problems to the workbench (kind, text, and a way to go to one). The bottom Problems
  tab lists them; clicking one pans and selects on the map, as the map's list does today. The count shows on the tab
  and in the status bar. The map page's own list is not drawn when embedded.
- **Bottom panel.** Starts closed, as a one-line strip with its tabs and counts ("Problems 8 · Jobs · Output"). It
  opens when a tab is clicked and never by itself: while a job runs, the Jobs tab on the strip shows a running mark.
  (Only plugin jobs emit `jobs/started` today; the map's Apply jobs do not, and their log stays where it is, in the
  map's part of the Inspector.) Whether it is open, and each region's width, are kept in `localStorage`.
- **View model.** Today it is a plain link (`src/editor.html`, the Selected block) that navigates the map's own frame.
  Once Selected sits in the Inspector it must instead show the Model viewer tab and open that model there.
- **Side panel and Inspector** each get a drag handle on their inner edge to set their width (min 200 px).
- The `null` under the ring fields is removed: `note()` returns `null` for no text and `append(null)` prints it. Every
  `box.append(…, note(…))` in `editor.html` has the same fault and is fixed with it.

Result at 1440 px: side panel 260, Inspector 280, the map about 850 px wide and the full height when the bottom strip
is closed.

### 3. New model

A bundled plugin, `plugins/model-maker`, with a page part and a server part.

**Where it starts:** a **＋ New model** button at the top of the viewer's side panel, and a "New model" command in ⌘K.
It opens a workbench tab.

**The screen:** three steps across the top, the current step below. A step is reachable once the one before it is
approved.

```
 ① Concept ─── ② Views ─── ③ Model
┌───────────────────────────────────────────────────────────┐
│ Name  [ brass lantern      ]                              │
│ Describe it                                               │
│ [ a small brass street lantern, worn, hexagonal glass… ]  │
│ Style  [ project style text, editable, kept per project ] │
│ References [+ add image]            How many [4]          │
│                                         [ Generate ]      │
├───────────────────────────────────────────────────────────┤
│  [img 1]   [img 2]   [img 3 ✓]   [img 4]                  │
│  earlier rounds ▸                                         │
│                       [ Use this one → Views ]            │
└───────────────────────────────────────────────────────────┘
```

- **① Concept.** Name, description, an optional style text (kept per project in `.nfgames/drafts/style.txt` and
  prefilled next time; plugin settings are per user, so not there), optional reference images and a count (1 to 8,
  default 4). References (up to 8, as the image service allows) are added from the user's disk: a file picker, a drop
  or a paste. The page shrinks each to fit plugin routes' 2 MB body limit (longest side 2048 px, JPEG) and the plugin
  saves it into the draft's `refs/`, from where the image service takes it as a project file.
  **Generate** calls the image service. Candidates appear when the job is done; earlier rounds stay under a fold. The
  user picks one and presses **Use this one**. The prompt can be edited and generated again any number of times.
- **② Views.** The approved concept is shown on the left. A list of views, each with its own editable prompt:
  **front, back, left, right** by default (my call: four separate images is what multi-image 3D services take; a view
  can be removed, and **three-quarter** and **top** can be added). Each view's prompt is drafted from the concept's
  description plus a fixed part: the same object, that side, orthographic, plain neutral background, even light, whole
  object in frame. The approved concept is passed as a reference image for every view. **Generate views** makes all of
  them, one run after another (the editor runs one job at a time); each view can be regenerated alone, with a count,
  and one candidate picked per view. **Approve views** is enabled when every listed view has a pick.
- **Going back.** Views belong to the concept they were made from. Approving a different concept, after a
  confirmation, clears the view picks, empties `views/` and sets the status back to `views`; the old rounds stay
  listed under "earlier rounds". Regenerating or re-picking a view after **Approve views** sets the status back to
  `views` until they are approved again. So `views/` on disk never disagrees with `concept.png`.
- **③ Model.** Shows the concept and the approved views, where they are saved, and a disabled **Generate model**
  button with "Model generation comes in a later update".

**What is kept.** One folder per draft, in the project:

```
.nfgames/drafts/<slug>/
  draft.json            name, description, style, the steps' prompts, every round, what is picked, status
  refs/                 the user's reference images
  concept.png           the approved concept (a copy of the pick)
  views/front.png …     the approved views
```

`draft.json` has a `version` field. `status` is `concept`, `views` or `ready`. The image service keeps writing its
rounds under `.nfgames/images/<time>/`; `draft.json` points at them. `concept.png` and `views/` are the contract the
later model step reads.

**Drafts in the viewer.** The viewer's side panel lists drafts under a folding "Drafts" folder above the models, each
with its step ("brass lantern · views"). Clicking one reopens its tab where it was left. A draft can be deleted from
its tab (with a confirmation; it deletes the draft folder, not the rounds under `.nfgames/images/`).

**Server part.** Routes to list, read, save and delete drafts, to save a reference, to copy a pick into the draft, and
to serve an image under `.nfgames/images/` or `.nfgames/drafts/` to the page. `touches.files`: `.nfgames/drafts/**`,
`.nfgames/images/**`.

**What the plugin API gains** (the editor's own tools live under the same rules as anyone's, so the API grows; the
plugin does not reach around it). A minor version, with `docs/plugins.md` updated:

- a route may answer with a file (bytes and a content type), not only JSON;
- `api.files.remove(rel)`, for a file or a folder, under the same declared globs;
- `api.files` checks real paths, so a symlink inside a declared folder cannot lead out of the project.

**What `codex-image` gains:** an optional `folder` input, a name under `.nfgames/images/` that the caller chooses
(checked: one safe path segment). The result and a failure both name the folder.

**Who runs a generation, and what survives.** The page calls the image service, as the plugin API allows today; there
is no queue on the server. Before each call the page saves the round in `draft.json` as *pending*, with the folder it
chose. If the tab closes or the workbench reloads mid-run, Codex still finishes and the images land in that folder;
when the draft is next opened, a pending round with images in its folder is shown as a finished round, and one with
none after the job has ended as failed. If the editor is busy with another job (a map Apply, another draft), Generate
says what is running and does nothing else.

**When the image service is not connected** (no `codex` on the PATH, or the plugin is off): the Generate buttons are
disabled with one line saying why and a link to the Services screen. Drafts can still be opened and read.

**Failure.** A failed generation leaves the step as it was, shows the error on the step and keeps the prompt. Images
the service saved before failing are shown (the round's folder is known beforehand).

## Left to the builder

- How `lend.js` names parts and regions, and how a page hands problems and "go to" to the workbench (same-origin calls
  like `__nfPanel` today, or events).
- The exact fixed wording of the view prompts.
- Whether the Drafts list is drawn by the viewer page or contributed by the plugin, as long as it sits in the viewer's
  side panel.
- Markup, class names and tests' layout, following the repo's ways (`node:test`, `scripts/browser-check.mjs`).

## Order of work

1. Folding lists (viewer, then palette).
2. Layout (lend parts; toolbar; Inspector; Problems; bottom strip; widths).
3. New model: first the plugin API's and `codex-image`'s additions, then the plugin (drafts, steps ① and ②, step ③
   as a placeholder).

Each lands by itself with its tests and a README update.
