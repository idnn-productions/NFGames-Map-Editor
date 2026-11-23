# The workbench and plugins (sub-project 1 of 4): design

Date: 2026-11-22. Status: approved by the user on 2026-11-22, section by section (with mockups in the brainstorming
companion: `shell-layout.html`, `architecture.html`, `look-and-workflow.html`).

## Intent

The editor has grown as separate pages (`editor.html`, about 1,250 lines, and `viewer.html`) that share only a
project bar, with three unrelated ways to extend it (config hooks, Apply actions, review workflows). The user wants
**one consistent look, feel and way of working**, and an architecture that **they and others can extend with
plugins**: tools, panels, workflows. It is to be bundled later with the three.js engine being built in `perseus`
(the Thoon Run workspace: Three.js r187, WebGPU).

The work is split into four sub-projects, each with its own spec, plan and build:

1. **The workbench and the plugin core** (this spec).
2. Port the map editor, model viewer and review inbox onto it as first-party plugins.
3. One workflow system that replaces hooks, Apply actions and review workflows (Blender, ComfyUI).
4. Bundling with the Perseus engine.

## Decisions (by the user)

- Sub-project 1 first.
- **Workbench layout** (fixed regions, VS Code / Blender style), not tool tabs or free docking.
- UI in **Web Components, no build, no dependencies**: native ES modules and custom elements.
- Plugins are **trusted code, approved once**: full rights; what they declare is shown when asking; a new version
  asks again.
- Plugins come from **four places**: built in, the project, the user, npm / git.
- Plugins declare themselves in a **manifest** and run behaviour from **`activate(api)`**, loaded on demand.
- Merge `projects-and-model-kinds` into `main` before starting (done).

## Goals

- One frame for every tool: the same regions, components, keys, selection, jobs, problems and messages.
- A plugin can add tools, document editors, panels, inspectors, commands (with keys and menus), status items,
  workflows, server hooks and settings, from a manifest and two optional entry points.
- The built-in tools are plugins under the same rules (from sub-project 2).
- Plugins load on demand, unload and reload without a restart, and a broken one cannot take the workbench down.
- Installing a shared plugin pins its exact bytes for everyone on the project.
- Nothing that works today breaks.

## Non-goals (this sub-project)

- Porting the map editor and model viewer (2), the workflow system (3), Perseus bundling (4).
- Sandboxing plugins. Free docking. A public plugin registry or marketplace.

## The design

### Layout: the workbench

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◆ NFGames  [Khairos ▾]     ⌘K Search commands, files, models…   ● 1 job │  top bar
├──┬─────────────┬──────────────────────────────────────┬──────────────┤
│🗺│ side panel   │  [plaza.map] [cruiser.glb]  ← tabs    │ Inspector    │
│🧊│ (the active  │                                      │ (the shared  │
│📮│  tool's)     │  the document                        │  selection)  │
│🧩│              ├──────────────────────────────────────┤              │
│  │              │ Jobs · Problems · Output  (bottom)    │              │
├──┴─────────────┴──────────────────────────────────────┴──────────────┤
│ status bar                                                            │
└──────────────────────────────────────────────────────────────────────┘
```

Regions: **top bar** (project switcher, ⌘K, job indicator), **activity bar** (one icon per tool), **side panel**
(the active tool's), **documents** in tabs, **inspector**, **bottom panel** (Jobs, Problems, Output and plugin
panels), **status bar**. Regions can be resized and hidden; they are not free-docking.

### Architecture

- **Host** (Node, `127.0.0.1` only): plugin manager (find, check, trust, activate on demand, unload); project
  (open, switch, config); files (confined); jobs (one queue, streamed output); router (core `/api/…`, each
  plugin's `/api/p/<id>/…`); **one event stream** to the page (Server-Sent Events: jobs, file changes, reviews,
  plugin state), in place of polling; settings; trust store; today's security checks.
- **Shell** (browser): the workbench; registries (tools, editors, panels, inspectors, commands, keys, menus, status
  items); ⌘K palette; toasts and dialogs; Problems and Output; Settings and Plugins screens; the UI kit; a
  **three.js service** (one pinned install, shared by every 3D view).
- **A plugin** is a folder: `plugin.json`, optional `server.mjs`, optional `web/index.js`, and its own assets
  (served at `/p/<id>/…`, only from that folder).

### The plugin contract

```jsonc
// plugin.json
{
  "id": "nfgames.model-review",           // reverse-domain style; namespaces routes, commands, settings, storage
  "name": "Model review",
  "version": "1.0.0",
  "engines": { "nfgames": "^1.0.0" },     // the plugin API version it needs
  "server": "server.mjs",                 // optional
  "web": "web/index.js",                  // optional
  "touches": { "files": ["models/**", ".review/**"], "commands": ["blender"], "network": false },
  "contributes": {
    "tools":      [{ "id": "viewer", "title": "Model viewer", "icon": "🧊" }],
    "editors":    [{ "id": "glb", "title": "Model", "files": ["*.glb"] }],
    "panels":     [{ "id": "jobs", "title": "Review jobs", "region": "bottom" }],
    "inspectors": [{ "id": "pin", "title": "Pin", "for": "nfgames.model-review/pin" }],
    "commands":   [{ "id": "send", "title": "Send pins to Claude", "keys": "Mod+Enter", "menu": "tool" }],
    "statusItems":[{ "id": "queue", "align": "right" }],
    "workflows":  [{ "id": "auto", "title": "Auto" }],
    "settings":   { "watchHint": { "type": "boolean", "default": true, "title": "Remind me to start a watch" } }
  },
  "activation": ["onTool:viewer", "onEditor:glb", "onCommand:send"]  // also "onStartup", "onProject"
}
```

Extension points (version 1): **tools**, **editors** (by file pattern), **panels** (side, inspector, bottom),
**inspectors** (by selection type), **commands** with **keys** and **menus**, **status items**, **workflows**
(declared now, built out in sub-project 3), server **hooks** (today's `kinds`, `compile`, `check`, `validate`,
`beforeSave`, `afterSave`), **settings** (typed, with defaults).

`activate(api)`:

- **Server:** `api.project` (root, name, config); `api.files` (read, write, list, watch: only within
  `touches.files`, project-relative); `api.jobs.run(steps)`; `api.routes.get/post(path, handler)` at
  `/api/p/<id>/…` (the host's Host, Origin and JSON checks apply); `api.events.emit(name, data)`;
  `api.hooks.on(name, fn)`; `api.settings`; `api.storage` (a private folder); `api.log`.
- **Web:** `api.tools / editors / panels / inspectors / statusItems.register(id, elementOrFactory)`;
  `api.commands.register(id, fn)` and `.execute(id, …)`; `api.fetch(path)` (its own routes); `api.events.on`;
  `api.ui` (toast, dialog, confirm, palette); `api.selection` (get, set, on change; shared across tools, typed);
  `api.three()` (the shared three.js); `api.settings`.
- Every registration returns a **disposable**; all are undone when the plugin unloads. `deactivate()` is optional.

**Versions.** The plugin API follows semver. A plugin whose `engines.nfgames` does not match is listed as
incompatible (with the version it needs) and stays off. Breaking changes only in a major version.

### Look and workflow

- **Tokens** as CSS variables `--nf-*`: bg `#14171d`, panel `#1c2029`, raised `#252a35`, line `#2c3240`, text
  `#d8dee9`, dim `#8a93a6`, accent `#ffb366`, ok `#6fcf97`, warn `#ffd166`, error `#ff7a7a`, model `#5fc9c0`, link
  `#9fb4d4`; system UI 13 px, mono for numbers and paths; spacing 4/8/12/16; radius 6. A light theme swaps tokens
  only.
- **Components (first set):** `nf-button`, `nf-field`, `nf-number`, `nf-select`, `nf-tree`, `nf-list`, `nf-tabs`,
  `nf-panel`, `nf-dialog`, `nf-toast`, `nf-tag`, `nf-progress`, and `nf-viewport` (a three.js view: orbit, grid,
  picking, framing).
- **Rules every tool follows:** things open as documents in tabs; select, then inspect (one shared selection);
  the same verbs and keys (`⌘S` save, `⌘Z`/`⇧⌘Z` undo/redo per document, `⌘K` commands, `Del` remove, `F` frame,
  `Esc` stop; a dot on a tab means unsaved); long work is a job (progress in the status bar, output in the bottom
  panel); problems in one Problems panel (click to go to it); toasts for results, the status bar for state, errors
  that say what to do next.

### Plugins: where they come from, install, trust, lifecycle

- **Sources**, searched in this order: built in (`NFGames-Map-Editor/plugins/`), user (`~/.nfgames-editor/plugins/`),
  installed packages (`~/.nfgames-editor/packages/<id>@<version>/`), project (`<project>/nfgames.json`):

  ```jsonc
  { "plugins": {
      "nfgames.model-review": "builtin",
      "thoon.bake-town": "./tools/editor-plugins/bake-town",
      "acme.terrain-tools": { "npm": "@acme/nfgames-terrain@2.1.0", "integrity": "sha512-…" },
      "jacek.comfy": { "git": "https://github.com/…/comfy-plugin.git", "commit": "4f2c9e1" }
  } }
  ```

  The same id from several places: the project's wins, then the user's, then the built-in. The Plugins screen
  says where each came from.
- **Install:** `nfgames plugin add <npm spec | git url>` (and **Plugins → Add**). npm: the tarball, its SHA-512
  checked against the registry's and written into `nfgames.json` (the three.js installer's code, generalised).
  git: `git` run directly (no shell) at a fixed commit. Teammates get the same bytes; `plugin update` is explicit
  and shows what changes.
- **Trust:** before a plugin first loads, the prompt shows its `touches` and `contributes`. The answer is kept per
  plugin id and version (by content hash for folder plugins); a new version asks again. Built-in plugins are
  trusted. A project's own folder plugins are trusted with the project (its config is already trusted). Declared
  file access is enforced by `api.files`; plugins still run as trusted code, so this prevents mistakes, not malice
  (the docs say so).
- **Lifecycle:** manifests are read at start and on project switch; code is activated on its activation events;
  unloading disposes everything it registered; **dev mode** reloads a plugin when its files change.
- **Failure:** a manifest that is invalid or needs another editor version is not loaded (listed with the reason);
  a plugin whose `activate` throws, or whose route or web part fails, is disabled alone (a toast, the error in
  Output); the rest keeps working. Routes, commands, settings and storage are namespaced by id, so plugins cannot
  collide.

### Compatibility

- The workbench is the home page `/`. Until sub-project 2 ports them, the map editor (moving to `/map`) and the
  model viewer (`/viewer`) open from the activity bar as **classic tools**.
- `map-editor.config.mjs` keeps working unchanged. `nfgames.json` is new and optional.
- Review jobs, `review-watch` and the `model-review` skill are unchanged.
- Ready for sub-project 4: the host is also a library, `createHost({ root, plugins, basePath })`, which the engine's
  dev server can mount under a path (for example `/editor/`). three.js stays one pinned install, matching r187.

## Testing

- `node --test`, no dependencies, no network: manifest checks and `engines` matching; source precedence; trust
  (asked, remembered, a new version asks again); activation events; disposables undone on unload; route, command,
  setting and storage namespacing; `api.files` refusing undeclared paths; npm install from a local fixture tarball;
  git install from a local fixture repository; the shell's logic modules (registries, palette matching, key
  parsing), kept free of the DOM so Node can test them.
- Browser (Playwright): the workbench loads; the sample plugin's tool, panel and command appear; ⌘K runs the
  command; turning the plugin off removes its parts live; a broken plugin is isolated; the classic tools open.
- The existing 105 tests keep passing.

## Deliverables

Host and shell as above; the `--nf-*` tokens and the first components; Settings and Plugins screens;
`nfgames plugin add/update/remove`; **a plugin authoring guide** (`docs/plugins.md`); **a sample plugin**
(`examples/plugins/hello`: a tool, a panel, a command, a server route); README and security notes.
