# The model viewer finds every asset in a project, with levels on top

Date: 2026-11-26. Status: waiting for approval. Size: a small change.

## Why

A designer opens a game folder to move quickly between its levels and its assets. Today the viewer lists the `.glb`
files of one folder only (the config's `models`). In Thoon Run that folder is `web/thoon-run/public/assets/models`
(27 files), so the town (`public/assets/town/town.glb`), 26 town pieces in `art/town/models` and 18 characters in
`art/export/townsfolk` never show.

## Goals

- Opening a project shows every `.glb` in it, with no config needed.
- Levels (a town, a cave) are listed first, apart from props and characters.
- Build and cache copies of a model are not listed a second and third time.

## Not in this change

- A level opened with its own sky, spawn point or walk grid. It opens in the viewer like any model.
- Levels that are not a `.glb`. Thoon Run's cave (`public/assets/level2/`) is stored in the game's own binary
  format, so it will not appear until it has a `.glb`.
- The map editor's palette. It keeps reading the `models` folder, or Thoon Run's palette would gain 70 pieces.
- Where New model writes (`models/<name>/`). The rename to Directed. Recent and New project.

## What would make it a failure

- A project that works today shows fewer models, or its open review jobs stop working.
- The search makes opening a large project slow (a Unity `Library/`, a `node_modules/`).

## Approaches

1. **The viewer searches the whole project; `models` stays what the palette and New model use. Chosen.** One new
   idea (what the viewer browses) beside the old one, and nothing to set up. Cost: a model's path in the viewer is
   now from the project root, so older paths need a fallback.
2. `models` becomes a list of folders. Every game has to list its folders, and the palette and New model would have
   to pick one of them. More to configure, and it does not work on a folder opened for the first time.
3. Change only Thoon Run's config to drop `models`. No code, but the palette fills with every model, the copies in
   `dist/` show twice, and the next game has the same problem.

Jacek chose levels on top in the same viewer (over one flat list, and over a separate level view).

## Design

- **What is searched.** The project root, to any depth. Skipped: folders whose name starts with a dot,
  `node_modules`, `dist`, `build`, `out`, links, and Unity's `Library` and `Temp`. At most 5,000 models, as today.
  The list is kept for 2 seconds, as the palette's is.
- **Config, all optional:** `assets: { skip: [folders from the project root], levels: [paths of .glb files] }`, or
  `assets: false` to keep today's behaviour (the viewer lists the `models` folder only).
- **Paths.** A model's path in the viewer, in a review job and in a match is from the project root
  (`web/thoon-run/public/assets/town/town.glb`). A path that is not found there is tried under the `models` folder,
  so links, drafts and jobs written before this still open.
- **A level** is a `.glb` with a `.json` of the same name beside it (`town.glb`, `town.json`), or one the config's
  `assets.levels` names. `/api/models` marks it `level: true`.
- **The list.** A group **Levels** first, each row the level's name with its folder as the tooltip. Then the
  folders, as today. The filter and the open and closed folders work as they do now. With no levels there is no
  Levels group.
- **Reference images, review jobs and the match** follow the model wherever it is: `<name>.refs/` beside the
  `.glb`, as today.
- **Thoon Run's config** keeps `models` for the palette. Nothing in it has to change.

## Left to the builder

- Whether the fallback lives in `resolveModel`'s callers or in one new function they all use.
- The look of the Levels group, within the folding list the viewer already has.

## Tests

- A project with models in three folders, a copy in `dist/` and one in `.cache/`: all three folders are listed, the
  copies are not.
- `town.glb` beside `town.json` is a level; `assets.levels` names another; `assets.skip` hides a folder;
  `assets: false` lists the `models` folder only.
- A path from before (relative to `models`) still resolves for the viewer, a review job and a match.
- The palette's kinds are unchanged by any of this.
- The browser check opens a level from the Levels group.
