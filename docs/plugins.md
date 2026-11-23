# Writing a plugin

A plugin adds to the editor: tools, document editors, panels, commands, workflows, services, server routes and
checks. The editor's own tools are plugins too (from sub-project 2), under the same rules as yours.

This guide covers the **host side** (the server part, routes, files, jobs, hooks, installing and trust). The page
side (tools, panels and commands in the workbench) is added with the workbench in plan 1B.

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
  "engines": { "nfgames": "^1.0.0" },       // the plugin API it needs (this editor: 1.0.0); otherwise it stays off
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
| `files.read(rel)`, `.write(rel, data)`, `.exists(rel)`, `.list(rel)` | project files, **only** those matching `touches.files` |
| `jobs.run(label, steps)` | one job (the editor runs one at a time); a step is `{ label, run: async (log) => … }` or `{ label, command: [program, …args] }` with the program in `touches.commands`. Returns `{ job, done }` |
| `routes.get(path, fn)`, `.post(path, fn)` | served at `/api/p/<id><path>`; `fn({ query, body })` returns JSON |
| `events.emit(name, data)` | to the page's live stream, as `<id>/<name>` |
| `hooks.on(name, fn)` | `check` (warnings for Problems: `[{ kind, text, sel, at }]`), `validate` (errors that stop a save) |
| `settings.get(key)`, `.set(key, value)` | its settings, with the manifest's defaults |
| `storage` | a private folder for its own files |
| `log(…)`, `onDispose(fn)` | write to the editor's log; run something when the plugin unloads |

Everything a plugin registers is undone when it unloads, so it can be turned off or reloaded without restarting the
editor. A plugin whose `activate`, route or hook throws is turned off alone (the Plugins list says why); the rest of
the editor carries on. Its own files are served at `/p/<id>/<path>` (no hidden files, nothing outside its folder).

## Where plugins come from

| Source | Where | Trusted |
|---|---|---|
| built in | `NFGames-Map-Editor/plugins/` | yes |
| user | `~/.nfgames-editor/plugins/<folder>/` | asked once, and again when its files change |
| project | a folder named in the project's `nfgames.json` | yes, with the project |
| npm / git | named in `nfgames.json`, installed in `~/.nfgames-editor/packages/` | asked once per version |

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
```

## What trust means

A plugin is **trusted code**: once allowed, it runs with your rights, like a VS Code extension or a Blender add-on.
`touches` is shown when you are asked, and the editor holds a plugin to it **through its API** (`api.files` refuses
undeclared paths, `api.jobs` undeclared programs), which stops mistakes; it cannot stop a plugin that deliberately
reaches around the API. Install plugins you trust.
