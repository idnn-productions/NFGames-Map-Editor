# Writing a plugin

A plugin adds to the editor: tools, document editors, panels, commands, workflows, services, server routes and
checks. The editor's own tools are plugins too (from sub-project 2), under the same rules as yours.

This guide covers the **server part** (routes, files, jobs, hooks), the **page part** (tools, panels, commands and
documents in the workbench), installing and trust.

A complete small example is in [`examples/plugins/hello`](../examples/plugins/hello).

## A plugin is a folder

```
my-plugin/
  plugin.json        what it is, what it touches, what it adds, when it loads
  server.mjs         optional: activate(api) in the editor's server (Node)
  web/index.js       optional: activate(api) in the page (plan 1B)
  …                  anything else it serves from /p/<id>/…
```

## plugin.json

```jsonc
{
  "id": "studio.terrain-tools",            // lower case, reverse-domain style; namespaces everything the plugin adds
  "name": "Terrain tools",
  "version": "1.2.0",                       // x.y.z
  "engines": { "nfgames": "^1.0.0" },       // the plugin API it needs (this editor: 1.1.0); otherwise it stays off
  "server": "server.mjs",                   // optional, a path inside the folder
  "web": "web/index.js",                    // optional
  "touches": {                              // shown when the user is asked to trust it
    "files": ["maps/**", "art/terrain/**"], //   project-relative globs it may read and write through api.files
    "commands": ["blender"],                //   programs its jobs may run
    "network": false
  },
  "contributes": {                          // what it adds (the workbench reads these without running the plugin)
    "tools": [{ "id": "terrain", "title": "Terrain", "icon": "⛰" }],
    "commands": [{ "id": "smooth", "title": "Smooth terrain", "keys": "Mod+Shift+S" }],
    "settings": { "strength": { "type": "number", "default": 1, "title": "Smoothing strength" } }
  },
  "activation": ["onTool:terrain", "onCommand:smooth", "onRoute"]
}
```

Extension points: `tools`, `editors`, `panels`, `inspectors`, `commands`, `statusItems`, `workflows`, `services`, and
`settings`. Activation events: `onStartup`, `onProject` (each time a project opens), `onRoute` (a request to its
routes), and `onTool:<id>`, `onEditor:<id>`, `onCommand:<id>`, `onPanel:<id>`, `onInspector:<id>`,
`onService:<id>`. **A plugin's code runs only when one of its events happens.**

## The server part

```js
// server.mjs
export function activate(api) {
  api.routes.get('/greeting', ({ query }) => ({ text: `${api.settings.get('greeting')}, ${query.name || 'world'}` }));
  api.routes.post('/note', ({ body }) => { api.files.write('.hello/note.txt', body.text); return { saved: true }; });
  api.hooks.on('check', ({ plan, name }) => [{ kind: 'hello', text: `checked ${name}`, sel: [], at: null }]);
}
export function deactivate() {}   // optional
```

| `api.` | What it is |
|---|---|
| `id`, `dir`, `version` | the plugin's id, its folder, its version |
| `project` | `{ root, name, options }` of the open project |
| `files.read(rel)`, `.write(rel, data)`, `.exists(rel)`, `.list(rel)`, `.remove(rel)` | project files, **only** those matching `touches.files` and really in the project (a link that leads out of it is refused). `remove` takes a file, or a folder with what is in it; nothing there is not an error (since 1.1.0) |
| `jobs.run(label, steps)` | one job (the editor runs one at a time); a step is `{ label, run: async (log) => … }` or `{ label, command: [program, …args] }` with the program in `touches.commands`. Returns `{ job, done }` |
| `routes.get(path, fn)`, `.post(path, fn)` | served at `/api/p/<id><path>`; `fn({ query, body })` returns JSON. To refuse, throw an error whose `code` is 400 to 499: the page gets that status and `{ error }` (and `needsConfirm: true` when the error has it). Any other throw counts as the plugin failing and turns it off |
| `routes.file(rel)` | for a route to return: the project file itself, sent as an image (`.png`, `.jpg`, `.webp`), JSON or text, anything else as bytes to save; a missing file is a 404 (since 1.1.0) |
| `events.emit(name, data)` | to the page's live stream, as `<id>/<name>` |
| `hooks.on(name, fn)` | `check` (warnings for Problems: `[{ kind, text, sel, at }]`), `validate` (errors that stop a save) |
| `settings.get(key)`, `.set(key, value)` | its settings, with the manifest's defaults |
| `storage` | a private folder for its own files |
| `log(…)`, `onDispose(fn)` | write to the editor's log; run something when the plugin unloads |

Everything a plugin registers is undone when it unloads, so it can be turned off or reloaded without restarting the
editor. A plugin whose `activate`, route or hook throws is turned off alone (the Plugins list says why); the rest of
the editor carries on. Its own files are served at `/p/<id>/<path>` (no hidden files, nothing outside its folder).

## The page part

The workbench (`http://127.0.0.1:<port>/`) loads a plugin's `web` module the first time one of its activation events
happens (its tool is opened, its command run, its panel shown, a document of its editor opened), or at start when it
contributes status items. Before that, it shows the plugin's tools and commands from `plugin.json` alone. The server
part, if there is one, is activated first.

```js
// web/index.js
export function activate(api) {
  api.tools.register('terrain', (el) => {                     // the side panel of the tool "terrain"
    const b = document.createElement('nf-button'); b.textContent = 'Smooth'; b.addEventListener('click', () => api.commands.execute('smooth'));
    el.append(b);
  });
  api.commands.register('smooth', async () => api.ui.toast((await api.fetch('/smooth', { method: 'POST', body: '{}' })).text));
}
```

| `api.` | What it is |
|---|---|
| `tools.register(id, factory)` | the side panel of a contributed tool: `factory(element)` fills it, and may return a clean-up function |
| `editors.register(id, factory)` | a document editor: `factory(element, doc)` where `doc` is `{ id, title, editor, uri, dirty }` |
| `panels.register(id, factory)` | a bottom (or side) panel |
| `inspectors.register(id, factory)` | an inspector section for a selection type (`for` in `plugin.json`): `factory(element, selection)` |
| `statusItems.register(id, factory)` | an item in the status bar |
| `commands.register(id, fn)`, `.execute(id, …)` | its commands (also in ⌘K and on their keys); other plugins' as `<plugin>/<command>` |
| `documents.open({ title, editor, uri })`, `.close(id)`, `.setDirty(id, dirty)`, `.setTitle(id, title)` | tabs in the centre; the same `editor` and `uri` focus the open one |
| `fetch(path, options)` | its own server routes (`/api/p/<id><path>`), JSON in and out |
| `events.on(name, fn)` | the editor's live events (`jobs/started`, `jobs/done`, `plugins/changed`, `<plugin>/<name>`…); `'*'` for all the page hears |
| `ui.toast(text, tone)`, `ui.dialog({ title, body, actions })`, `ui.confirm(title, text, ok)`, `ui.palette()` | messages and dialogs |
| `selection.get()`, `.set(type, items)`, `.on(fn)` | the one selection every tool shares; `type` like `"studio.terrain/tile"` |
| `problems.set(list)` | its entries in the Problems panel: `[{ kind, text }]` |
| `settings.get()`, `.set(key, value)` | its settings (the Settings screen edits them too) |
| `three()` | the editor's one three.js (`import('three')`) |

Everything registered is undone when the plugin is turned off or reloaded.

**The UI kit.** Use the shared parts so every tool looks and behaves alike: `import { h, toast, dialog, confirmDialog }
from '/shell/ui.js'`, and the elements `<nf-button variant="primary|danger|ghost">`, `<nf-field label>`,
`<nf-number label value step min max>`, `<nf-select label>` (`options = [{ value, label }]`), `<nf-tag tone>`,
`<nf-progress value>`, `<nf-panel title>`, `<nf-list>` (`items`, `render`), `<nf-tree>` (`items`), `<nf-tabs>`, and
`<nf-viewport>` (a three.js view: `await v.setObject(object3d)`, `v.frame()`, a `pick` event). Colours, type and
spacing are CSS variables (`--nf-accent`, `--nf-panel`, `--nf-s2`…) in `/shell/theme.css`.

**The rules every tool follows:** things open as documents in tabs; select, then inspect; the same verbs and keys
(⌘S save, ⌘Z undo, ⌘K commands, Del remove, F frame, Esc stop); long work is a job (`api.jobs.run` on the server);
problems go to the Problems panel; toasts say what happened.

## Services

A **service** is something a plugin can do for the user and for their agent: generate images, a voice line, a 3D
model. It runs in the editor, with keys the editor keeps (the macOS Keychain) and under the user's spend guard, so
neither the page nor an agent handles keys or endpoints. Declare it in `plugin.json` and provide its actions from the
server part:

```jsonc
"contributes": { "services": [{
  "id": "image", "title": "Image generation", "summary": "Makes images from a description",
  "provider": "Codex, with your ChatGPT login",
  "needs": [{ "kind": "cli", "command": "codex", "help": "Install the Codex app or CLI and sign in once" }],
  // or { "kind": "key", "name": "HF_TOKEN", "help": "Your Hugging Face token: huggingface.co/settings/tokens" }
  "actions": [{ "id": "generate", "title": "Generate images", "cost": { "estimate": 0, "note": "uses your ChatGPT plan" } }]
}] },
"activation": ["onService:image"]
```

```js
// server.mjs
export function activate(api) {
  api.services.provide('image', 'generate', async ({ prompt }, { secret }) => {
    // secret('HF_TOKEN') reads this service's own key from the vault; nothing else can be read
    return { images: ['…'], cost: 0.04 };   // `cost` (dollars), when known, is what the spend guard records
  });
}
```

The user connects a service on the **🔌 Services** screen (a key is pasted once; a program is checked on the PATH),
and can set a monthly budget for it. A call estimated at the threshold (default $0.50) or more, or one that would
pass the budget, or any call once the budget is used up, asks the user first. From a page part, call a service with
`await api.services.call('<plugin>/<service>', '<action>', input)`; it asks the user when the spend guard says so.
Agents ask through request files (see `skills/nfgames/SKILL.md`); the first time an agent uses a service in a session,
the user is asked to allow it. The built-in `nfgames.codex-image` plugin is a complete example.

## Where plugins come from

| Source | Where | Trusted |
|---|---|---|
| built in | `NFGames-Map-Editor/plugins/` | yes |
| user | `~/.nfgames-editor/plugins/<folder>/` | asked once, and again when its files change |
| project | a folder named in the project's `nfgames.json` | asked once, and again when its files change |
| npm / git | named in `nfgames.json`, installed in `~/.nfgames-editor/packages/` | asked once for its exact pinned bytes (integrity, or commit) |

```jsonc
// <project>/nfgames.json
{ "plugins": {
    "thoon.bake-town": "./tools/editor-plugins/bake-town",
    "acme.terrain-tools": { "npm": "@acme/nfgames-terrain@2.1.0", "integrity": "sha512-…" },
    "jacek.comfy": { "git": "https://github.com/…/comfy-plugin.git", "commit": "4f2c9e1…" }
} }
```

The same id in several places: the project's wins, then the user's, then the built-in.

```sh
nfgames plugin add @acme/nfgames-terrain@2.1.0      # npm: checked against the registry's SHA-512, pinned
nfgames plugin add https://github.com/you/comfy.git # git: pinned at the current commit (or url#commit)
nfgames plugin install                              # after a fresh checkout: install everything pinned
nfgames plugin update acme.terrain-tools            # newest version or commit; shows old → new
nfgames plugin remove acme.terrain-tools
nfgames plugin list
nfgames plugin trust acme.terrain-tools             # approve one (shows what it touches and adds first)
```

## What trust means

A plugin is **trusted code**: once allowed, it runs with your rights, like a VS Code extension or a Blender add-on.
`touches` is shown when you are asked, and the editor holds a plugin to it **through its API** (`api.files` refuses
undeclared paths, `api.jobs` undeclared programs), which stops mistakes; it cannot stop a plugin that deliberately
reaches around the API. Install plugins you trust.
