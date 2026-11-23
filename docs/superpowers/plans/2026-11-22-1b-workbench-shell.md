# 1B · Workbench shell and UI kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workbench at `/`: top bar, activity bar, side panel, documents in tabs, inspector, bottom panel (Jobs, Problems, Output and plugin panels), status bar, ⌘K palette, toasts and dialogs; the `--nf-*` theme and `<nf-*>` components (with `nf-viewport`); the page half of the plugin API with on-demand loading; Plugins and Settings screens; the map editor and model viewer as **classic** tools; the sample plugin's page part.

**Architecture:** DOM-free logic in `src/shell/core/` (registry, keys, commands and palette ranking, selection, documents, contributions), tested in Node. The page is `src/shell/index.html` + `workbench.js` (layout, wiring, page plugin API and loader) + `ui.js` (components) + `theme.css` / `workbench.css`, served by the host from `/shell/…`. Built-in plugin `plugins/classic` hosts today's pages in iframes.

**Tech Stack:** Web Components (light DOM), native ES modules, no build, no dependencies; three.js through the existing pinned install for `nf-viewport`.

**Spec:** `docs/superpowers/specs/2026-11-22-workbench-and-plugins-design.md` · Builds on plan 1A (merged).

## Global Constraints

- No build step, no dependencies. Components use light DOM so the `--nf-*` tokens and shared classes apply.
- Plugin page parts load only on an activation event (tool, editor, command, panel, inspector), or at start when they contribute status items. Loading first activates the plugin's server part (`POST /api/plugins/<id>/activate`).
- Everything a page part registers is disposable and undone when the plugin is turned off or reloaded.
- Keys: `Mod` is ⌘ on a Mac, Ctrl elsewhere. Built-in keys: `Mod+K` palette, `Escape` closes the palette / dialog.
- The workbench is `/`; the map editor moves to `/map`; the model viewer stays at `/viewer`. Frames are allowed from the same origin only (`X-Frame-Options: SAMEORIGIN`).
- Regions can be hidden (commands); resizing by dragging is left for later (said in the docs).

## File map

| File | Responsibility |
|---|---|
| `src/shell/core/registry.js` | disposable registries with change listeners |
| `src/shell/core/keys.js` | `parseKeys`, `matches`, `showKeys` |
| `src/shell/core/commands.js` | `createCommands` (declare, handle, execute with lazy load), `rank` (palette matching) |
| `src/shell/core/selection.js` | the shared selection |
| `src/shell/core/documents.js` | open documents and the active one |
| `src/shell/core/contributions.js` | the workbench model from `/api/plugins` |
| `src/shell/theme.css`, `workbench.css` | tokens; layout and shared classes |
| `src/shell/ui.js` | `nf-button`, `nf-field`, `nf-number`, `nf-select`, `nf-tag`, `nf-progress`, `nf-panel`, `nf-list`, `nf-tree`, `nf-tabs`, `nf-viewport`; `toast`, `dialog`, `confirmDialog` |
| `src/shell/index.html`, `workbench.js` | the page, the regions, the page plugin API, loader, palette, Plugins and Settings screens, Jobs, Problems, Output |
| `src/plugins/manager.mjs` | + `getSettings`, `setSetting` |
| `src/server.mjs` | `/` shell, `/map`, `/shell/…`, `activate` and `settings` routes, SAMEORIGIN |
| `src/nav.html` | links: Workbench, Map editor (`/map`), Model viewer |
| `plugins/classic/` | built-in: Map editor and Model viewer as classic tools |
| `examples/plugins/hello/` | + page part |
| `scripts/browser-check.mjs` | the editor at `/map` |
| tests | `shell-core.test.mjs`, `shell-server.test.mjs` |

---

### Task 1: The shell's core logic (DOM-free)

**Files:** Create `src/shell/core/registry.js`, `keys.js`, `commands.js`, `selection.js`, `documents.js`, `contributions.js`; test `test/shell-core.test.mjs`.

**Produces:** `createRegistry()` → `{ add(key, value) → {dispose}, get, has, values, entries, onChange(fn) → {dispose} }`; `parseKeys(text, { mac })` → `{ ctrl, meta, alt, shift, key }`, `matches(chord, event)`, `showKeys(chord, { mac })`; `createCommands()` → `{ declare(id, { title, keys, plugin, category, load }) → {dispose}, handle(id, fn) → {dispose}, execute(id, ...args), list, get, onChange }`, `rank(items, query, text?)` → `[{ item, score }]`; `createSelection()` → `{ get, set(type, items), clear, on(fn) }`; `createDocuments()` → `{ open({ title, editor, uri }), close, focus, setDirty, setTitle, list, active, on }`; `USABLE`, `contributionsOf(plugins)` → `{ tools, panels, commands, editors, inspectors, statusItems, settings }`.

- [ ] **Step 1: Create `test/shell-core.test.mjs`:**

```js
// The workbench's logic, without a page: registries, keys, commands and the palette's ranking, the shared selection,
// open documents, and what the manifests contribute.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/shell/core/registry.js';
import { matches, parseKeys, showKeys } from '../src/shell/core/keys.js';
import { createCommands, rank } from '../src/shell/core/commands.js';
import { createSelection } from '../src/shell/core/selection.js';
import { createDocuments } from '../src/shell/core/documents.js';
import { contributionsOf } from '../src/shell/core/contributions.js';

const ev = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('registries', () => {
  it('add, dispose, refuse duplicates, tell listeners', () => {
    const r = createRegistry(); let changes = 0; r.onChange(() => changes++);
    const a = r.add('x/a', 1); assert.equal(r.get('x/a'), 1); assert.throws(() => r.add('x/a', 2), /already registered/);
    a.dispose(); assert.equal(r.has('x/a'), false); a.dispose(); assert.equal(changes, 2);
  });
});
describe('keys', () => {
  it('Mod is ⌘ on a Mac and Ctrl elsewhere', () => {
    assert.ok(matches(parseKeys('Mod+K', { mac: true }), ev('k', { metaKey: true })));
    assert.ok(!matches(parseKeys('Mod+K', { mac: true }), ev('k', { ctrlKey: true })));
    assert.ok(matches(parseKeys('Mod+Shift+S'), ev('S', { ctrlKey: true, shiftKey: true })));
    assert.ok(matches(parseKeys('Esc'), ev('Escape'))); assert.ok(matches(parseKeys('Del'), ev('Delete')));
    assert.equal(showKeys(parseKeys('Mod+Shift+S', { mac: true }), { mac: true }), '⇧⌘S'); assert.equal(showKeys(parseKeys('Mod+K')), 'Ctrl+K');
    assert.throws(() => parseKeys('Mod+'), /no key/); assert.throws(() => parseKeys('A+B'), /two keys/);
  });
});
describe('commands', () => {
  it('a command of a plugin not loaded yet loads it first', async () => {
    const c = createCommands(); let loaded = false;
    c.declare('p.x/greet', { title: 'Say hello', load: async () => { loaded = true; c.handle('p.x/greet', (n) => `hello ${n}`); } });
    assert.equal(await c.execute('p.x/greet', 'there'), 'hello there'); assert.ok(loaded);
    await assert.rejects(c.execute('nope'), /no command nope/);
    c.declare('p.x/idle', { title: 'Idle' }); await assert.rejects(c.execute('p.x/idle'), /nothing handles it/);
  });
  it('the palette ranks typed letters in order, word starts and runs first', () => {
    const items = [{ title: 'Open project' }, { title: 'Save map' }, { title: 'Reload plugin' }, { title: 'Toggle bottom panel' }];
    assert.deepEqual(rank(items, 'op').map((r) => r.item.title).slice(0, 1), ['Open project']);
    assert.deepEqual(rank(items, 'sm').map((r) => r.item.title), ['Save map']);
    assert.equal(rank(items, 'zz').length, 0); assert.equal(rank(items, '').length, 4);
  });
});
describe('selection and documents', () => {
  it('one shared selection', () => {
    const s = createSelection(); const seen = []; s.on((x) => seen.push(x.type));
    s.set('nfgames.map/piece', [{ id: 'tower' }]); s.set('x', []); assert.deepEqual(seen, ['nfgames.map/piece', null]);
  });
  it('documents: open (or focus the same uri), close, dirty', () => {
    const d = createDocuments();
    const a = d.open({ title: 'plaza', editor: 'p.x/map', uri: 'plaza' }), b = d.open({ title: 'gate', editor: 'p.x/map', uri: 'gate' });
    assert.equal(d.open({ title: 'plaza', editor: 'p.x/map', uri: 'plaza' }).id, a.id); assert.equal(d.active().id, a.id);
    d.setDirty(b.id, true); assert.equal(d.list().find((x) => x.id === b.id).dirty, true);
    d.close(a.id); assert.equal(d.active().id, b.id); d.close(b.id); assert.equal(d.active(), null);
  });
});
describe('contributions', () => {
  it('only usable plugins, keyed by plugin and id, with their activation events', () => {
    const c = contributionsOf([
      { id: 'a.b', name: 'AB', state: 'ready', contributes: { tools: [{ id: 't', title: 'Tool', icon: 'T' }], commands: [{ id: 'go', title: 'Go', keys: 'Mod+G' }], panels: [{ id: 'p', region: 'weird' }], settings: { n: { type: 'number', default: 1 } } } },
      { id: 'c.d', name: 'CD', state: 'needs-trust', contributes: { tools: [{ id: 'x' }] } }]);
    assert.deepEqual(c.tools.map((t) => [t.key, t.event]), [['a.b/t', 'onTool:t']]);
    assert.equal(c.commands[0].category, 'AB'); assert.equal(c.panels[0].region, 'bottom'); assert.equal(c.settings[0].plugin, 'a.b');
  });
});
```

- [ ] **Step 2:** `node --test test/shell-core.test.mjs` → FAIL.

- [ ] **Step 3: Create `src/shell/core/registry.js`:**

```js
// A registry of contributions (tools, panels, editors, …): add returns a disposable; listeners hear every change.
export function createRegistry() {
  const items = new Map(), listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); };
  return {
    add(key, value) {
      if (items.has(key)) throw new Error(`${key} is already registered`);
      items.set(key, value); changed();
      return { dispose: () => { if (items.get(key) === value) { items.delete(key); changed(); } } };
    },
    get: (key) => items.get(key), has: (key) => items.has(key), values: () => [...items.values()], entries: () => [...items.entries()],
    onChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
}
```

- [ ] **Step 4: Create `src/shell/core/keys.js`:**

```js
// Key chords: "Mod+Shift+S" (Mod is ⌘ on a Mac, Ctrl elsewhere), matched against keydown events and shown as text.
const MODS = ['ctrl', 'meta', 'alt', 'shift'];
const NAMES = { esc: 'escape', del: 'delete', return: 'enter', space: ' ', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' };

export function parseKeys(text, { mac = false } = {}) {
  const parts = String(text).split('+').map((p) => p.trim()).filter(Boolean), chord = { ctrl: false, meta: false, alt: false, shift: false, key: '' };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'mod') chord[mac ? 'meta' : 'ctrl'] = true;
    else if (MODS.includes(l)) chord[l] = true;
    else if (chord.key) throw new Error(`two keys in "${text}"`);
    else chord.key = NAMES[l] || l;
  }
  if (!chord.key) throw new Error(`no key in "${text}"`);
  return chord;
}
export const matches = (chord, e) => !!e && e.ctrlKey === chord.ctrl && e.metaKey === chord.meta && e.altKey === chord.alt && e.shiftKey === chord.shift && String(e.key).toLowerCase() === chord.key;
export function showKeys(chord, { mac = false } = {}) {
  const k = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key[0].toUpperCase() + chord.key.slice(1);
  return mac ? `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.meta ? '⌘' : ''}${k}`
    : [chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', chord.meta && 'Meta', k].filter(Boolean).join('+');
}
```

- [ ] **Step 5: Create `src/shell/core/commands.js`:**

```js
// Commands: everything runnable, by id ("<plugin>/<command>"). A command can be declared (from a manifest) before its
// plugin has loaded; running it calls its `load` first, which registers the handler.
import { createRegistry } from './registry.js';

export function createCommands() {
  const reg = createRegistry(), handlers = new Map();
  return {
    declare: (id, info = {}) => reg.add(id, { id, title: info.title || id, keys: info.keys || null, plugin: info.plugin || null, category: info.category || '', load: info.load || null }),
    handle(id, fn) {
      if (handlers.has(id)) throw new Error(`${id} already has a handler`);
      handlers.set(id, fn);
      return { dispose: () => { if (handlers.get(id) === fn) handlers.delete(id); } };
    },
    async execute(id, ...args) {
      const c = reg.get(id);
      if (!c) throw new Error(`no command ${id}`);
      if (!handlers.has(id) && c.load) await c.load();
      const fn = handlers.get(id);
      if (!fn) throw new Error(`${c.title}: nothing handles it`);
      return fn(...args);
    },
    list: () => reg.values(), get: (id) => reg.get(id), onChange: (fn) => reg.onChange(fn),
  };
}

/** The palette's matching: every typed character in order, case-insensitive; runs and word starts rank higher. */
export function rank(items, query, text = (i) => i.title) {
  const q = query.trim().toLowerCase();
  if (!q) return items.map((item) => ({ item, score: 0 }));
  const out = [];
  for (const item of items) {
    const t = String(text(item)).toLowerCase();
    let score = 0, at = -1, ok = true;
    for (const ch of q) {
      const i = t.indexOf(ch, at + 1);
      if (i < 0) { ok = false; break; }
      score += (i === at + 1 && at >= 0 ? 3 : 0) + (i === 0 || /[\s:./-]/.test(t[i - 1]) ? 2 : 0) - i * 0.01;
      at = i;
    }
    if (ok) out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 6: Create `src/shell/core/selection.js`:**

```js
// The one selection every tool shares: { type, items }, the type naming what is selected ("nfgames.map/piece").
export function createSelection() {
  let current = { type: null, items: [] };
  const listeners = new Set();
  return {
    get: () => current,
    set(type, items = []) { current = { type: items.length ? type : null, items: [...items] }; for (const fn of listeners) fn(current); },
    clear() { this.set(null, []); },
    on(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
}
```

- [ ] **Step 7: Create `src/shell/core/documents.js`:**

```js
// The open documents (the centre's tabs): { id, title, editor, uri, dirty }, one of them active.
export function createDocuments() {
  let docs = [], active = null, n = 0;
  const listeners = new Set(), changed = () => { for (const fn of listeners) fn({ docs, active }); };
  return {
    open({ title, editor, uri = null }) {
      const same = uri !== null && docs.find((d) => d.editor === editor && d.uri === uri);
      if (same) { active = same.id; changed(); return same; }
      const d = { id: `doc${++n}`, title, editor, uri, dirty: false };
      docs = [...docs, d]; active = d.id; changed();
      return d;
    },
    close(id) {
      const i = docs.findIndex((d) => d.id === id);
      if (i < 0) return;
      docs = docs.filter((d) => d.id !== id);
      if (active === id) active = docs[Math.min(i, docs.length - 1)]?.id ?? null;
      changed();
    },
    focus(id) { if (docs.some((d) => d.id === id)) { active = id; changed(); } },
    setDirty(id, dirty) { docs = docs.map((d) => (d.id === id ? { ...d, dirty: !!dirty } : d)); changed(); },
    setTitle(id, title) { docs = docs.map((d) => (d.id === id ? { ...d, title } : d)); changed(); },
    list: () => docs, active: () => docs.find((d) => d.id === active) || null,
    on(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
}
```

- [ ] **Step 8: Create `src/shell/core/contributions.js`:**

```js
// What the workbench shows before any plugin code runs, built from the manifests the host lists (/api/plugins).
export const USABLE = ['ready', 'active'];

export function contributionsOf(plugins) {
  const out = { tools: [], panels: [], commands: [], editors: [], inspectors: [], statusItems: [], settings: [] };
  for (const p of plugins) {
    if (!USABLE.includes(p.state)) continue;
    const c = p.contributes || {}, key = (x) => `${p.id}/${x.id}`, base = (x) => ({ key: key(x), plugin: p.id, id: x.id, title: x.title || x.id });
    for (const t of c.tools || []) out.tools.push({ ...base(t), icon: t.icon || '◇', event: `onTool:${t.id}` });
    for (const x of c.panels || []) out.panels.push({ ...base(x), region: ['side', 'inspector', 'bottom'].includes(x.region) ? x.region : 'bottom', event: `onPanel:${x.id}` });
    for (const x of c.commands || []) out.commands.push({ ...base(x), keys: x.keys || null, category: p.name, event: `onCommand:${x.id}` });
    for (const x of c.editors || []) out.editors.push({ ...base(x), files: x.files || [], event: `onEditor:${x.id}` });
    for (const x of c.inspectors || []) out.inspectors.push({ ...base(x), for: x.for || null, event: `onInspector:${x.id}` });
    for (const x of c.statusItems || []) out.statusItems.push({ ...base(x), align: x.align === 'left' ? 'left' : 'right' });
    if (c.settings && Object.keys(c.settings).length) out.settings.push({ plugin: p.id, name: p.name, schema: c.settings });
  }
  return out;
}
```

- [ ] **Step 9:** `node --test test/shell-core.test.mjs` → pass. **Commit:** "Workbench: its logic (registries, keys, commands, palette ranking, selection, documents, contributions)".

---

### Task 2: Serving the shell; plugin activation and settings over HTTP

**Files:** Modify `src/server.mjs`, `src/plugins/manager.mjs`, `src/nav.html`, `scripts/browser-check.mjs`; create a placeholder `src/shell/index.html`; test `test/shell-server.test.mjs`.

**Produces:** `GET /` → the shell (`src/shell/index.html` with the import map and the nav bar written in); `GET /map` → today's editor page; `GET /shell/<file>` (files of `src/shell/`, no hidden parts); `POST /api/plugins/<id>/activate`; `GET /api/plugins/<id>/settings` → `{ schema, values }`; `POST /api/plugins/<id>/settings` `{ key, value }` (checked against the schema); manager `getSettings(id)`, `setSetting(id, key, value)`; `X-Frame-Options: SAMEORIGIN`.

- [ ] **Step 1: Create `test/shell-server.test.mjs`:**

```js
// The workbench over HTTP: its page and files, today's editor at /map, plugins activated and their settings changed
// from the page only, frames from this origin only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import { sampleCopy, writePlugin } from './helpers.mjs';

describe('the workbench over HTTP', () => {
  const port = 20893 + (process.pid % 500), origin = `http://127.0.0.1:${port}`;
  let top, copy, host;
  const ask = (p, o) => fetch(`${origin}${p}`, o);
  const post = (p, body = {}, headers = { 'Content-Type': 'application/json', Origin: origin }) => ask(p, { method: 'POST', headers, body: JSON.stringify(body) });
  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-shell-'))); copy = sampleCopy();
    writePlugin(join(top, 'builtin', 'hello'), { id: 'nfgames.hello', server: 'server.mjs', activation: ['onTool:hello'],
      contributes: { tools: [{ id: 'hello' }], settings: { greeting: { type: 'string', default: 'hi' }, loud: { type: 'boolean', default: false }, size: { type: 'number', default: 2, enum: [1, 2, 3] } } } },
      { 'server.mjs': 'export function activate(api) { globalThis.__shellHello = (globalThis.__shellHello || 0) + 1; }' });
    host = await createHost({ root: copy.root, port, pluginDirs: { builtinDir: join(top, 'builtin'), userDir: join(top, 'user'), packagesDir: join(top, 'packages') }, stateDir: join(top, 'state'), home: top });
    await host.listen();
  });
  after(async () => { await new Promise((d) => host.server.close(d)); copy.done(); rmSync(top, { recursive: true, force: true }); });

  it('/ is the workbench, /map today\'s editor, both framable by this origin only', async () => {
    const shell = await ask('/'); const html = await shell.text();
    assert.match(html, /workbench\.js/); assert.match(html, /"three":"\/vendor\/three-/); assert.match(html, /id="nfnav"/);
    assert.equal(shell.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(await (await ask('/map')).text(), /Add a piece/);
  });
  it('serves the shell\'s own files, nothing hidden or outside', async () => {
    const r = await ask('/shell/core/keys.js'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
    for (const bad of ['/shell/../server.mjs', '/shell/%2e%2e/server.mjs', '/shell/.hidden', '/shell/nope.js']) assert.equal((await ask(bad)).status, 404, bad);
  });
  it('activates a plugin from the page only', async () => {
    assert.equal((await post('/api/plugins/nfgames.hello/activate', {}, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    const r = await (await post('/api/plugins/nfgames.hello/activate')).json();
    assert.equal(r.plugins.find((p) => p.id === 'nfgames.hello').state, 'active'); assert.equal(globalThis.__shellHello, 1);
  });
  it('settings: read with defaults, written within their schema', async () => {
    assert.deepEqual((await (await ask('/api/plugins/nfgames.hello/settings')).json()).values, { greeting: 'hi', loud: false, size: 2 });
    assert.equal((await (await post('/api/plugins/nfgames.hello/settings', { key: 'loud', value: true })).json()).values.loud, true);
    for (const [key, value, why] of [['loud', 'yes', /boolean/], ['size', 5, /one of/], ['nope', 1, /no such setting/]]) {
      const r = await post('/api/plugins/nfgames.hello/settings', { key, value }); assert.equal(r.status, 400); assert.match((await r.json()).error, why);
    }
  });
});
```

- [ ] **Step 2:** `node --test test/shell-server.test.mjs` → FAIL.

- [ ] **Step 3: Manager settings.** In `src/plugins/manager.mjs`, before `refresh();` at the end:

```js
  /** A plugin's settings: { schema, values } (the manifest's defaults where nothing was set). */
  function getSettings(id) {
    const p = find(id);
    if (!p || !p.manifest) throw Object.assign(new Error('no such plugin'), { code: 404 });
    const schema = p.manifest.contributes?.settings || {}, saved = readJson(settingsFile, {})[id] || {};
    return { schema, values: Object.fromEntries(Object.entries(schema).map(([k, s]) => [k, k in saved ? saved[k] : s?.default])) };
  }
  /** Sets one setting, checked against its schema (type, and enum when there is one). */
  function setSetting(id, key, value) {
    const { schema } = getSettings(id), s = schema[key], bad = (t) => { throw Object.assign(new Error(t), { code: 400 }); };
    if (!s) bad(`no such setting: ${key}`);
    const type = s.type || typeof s.default;
    if (['number', 'boolean', 'string'].includes(type) && typeof value !== type) bad(`${key} is a ${type}`);
    if (Array.isArray(s.enum) && !s.enum.includes(value)) bad(`${key} is one of ${s.enum.join(', ')}`);
    const all = readJson(settingsFile, {}); all[id] = { ...(all[id] || {}), [key]: value }; writeJson(settingsFile, all);
    events.emit('settings/changed', { id, key });
    return getSettings(id);
  }
```

and add `getSettings, setSetting` to the returned object.

- [ ] **Step 4: Server.** In `src/server.mjs`:
  1. `const navHtml = () => readFileSync(join(EDITOR_ROOT, 'src', 'nav.html'), 'utf8');` and `const importMap = () => JSON.stringify({ imports: { three: `${vendorBase()}build/three.module.js`, 'three/addons/': `${vendorBase()}examples/jsm/` } });` at module level; `page()` and `viewerPage()` use them; add
     `export const shellPage = () => readFileSync(join(EDITOR_ROOT, 'src', 'shell', 'index.html'), 'utf8').replace('/*@importmap*/', importMap).replace('<!--@nav-->', navHtml);`
  2. In both `writeHead` calls, `'X-Frame-Options': 'DENY'` → `'X-Frame-Options': 'SAMEORIGIN'`.
  3. Replace the `/` route with:
     ```js
           if (req.method === 'GET' && (path === '/' || path === '/index.html')) return send(200, shellPage(), 'text/html; charset=utf-8');
           if (req.method === 'GET' && path === '/map') return send(200, page(), 'text/html; charset=utf-8');
           { const m = req.method === 'GET' && /^\/shell\/(.+)$/.exec(path);
             if (m) { const f = shellFile(m[1]); return f ? send(200, readFileSync(f), TYPES[extname(f)] || 'application/octet-stream') : send(404, { error: 'not here' }); } }
     ```
     with, at module level:
     ```js
     const SHELL = join(EDITOR_ROOT, 'src', 'shell');
     /** A file of src/shell for /shell/<rest>: inside that folder, no hidden parts. */
     function shellFile(rest) {
       let rel; try { rel = decodeURIComponent(rest); } catch { return null; }
       const f = resolve(SHELL, rel), r = relative(SHELL, f);
       if (!r || r.startsWith('..') || isAbsolute(r) || r.split(sep).some((s) => s.startsWith('.')) || rel.includes('\0') || !existsSync(f) || !statSync(f).isFile()) return null;
       return f;
     }
     ```
     (imports gain `existsSync` from `node:fs` and `isAbsolute, relative, resolve, sep` from `node:path`).
  4. The plugin verbs regex becomes `(trust|enable|disable|reload|activate)` and the handler gains `else if (verb === 'activate') await plugins.activate(id);` (before the enable/disable branch).
  5. Settings routes, after the verbs block:
     ```js
           { const m = /^\/api\/plugins\/([a-z0-9.-]+)\/settings$/.exec(path);
             if (m) { try { if (req.method === 'GET') return send(200, plugins.getSettings(m[1])); const { key, value } = await body(); return send(200, plugins.setSetting(m[1], key, value)); } catch (e) { return send(e.code || 500, { error: e.message }); } } }
     ```
- [ ] **Step 5: `src/nav.html`:** links become `<a href="/" data-page="workbench">Workbench</a><a href="/map" data-page="editor">Map editor</a><a href="/viewer" data-page="viewer">Model viewer</a>`; `here` is `location.pathname.startsWith('/viewer') ? 'viewer' : location.pathname.startsWith('/map') ? 'editor' : 'workbench'`; after opening a project, `location.href = here === 'viewer' ? '/viewer' : here === 'editor' ? '/map' : '/'`.
- [ ] **Step 6: `scripts/browser-check.mjs`:** where it opens the editor (`page.goto(url)` and `--url` defaults), use `new URL('map', url)`.
- [ ] **Step 7:** Create `src/shell/index.html` as a placeholder that already carries the two markers (Task 4 replaces it):

```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>NFGames</title><script type="importmap">/*@importmap*/</script></head>
<body><!--@nav--><script type="module" src="/shell/workbench.js"></script></body></html>
```

- [ ] **Step 8:** `node --test test/shell-server.test.mjs` → pass; `npm test` → all pass. **Commit:** "Workbench: served at /, the editor at /map; plugin activation and settings over HTTP; same-origin frames".

---

### Task 3: Theme and components

**Files:** Create `src/shell/theme.css`, `src/shell/ui.js`.

**Produces:** tokens `--nf-bg --nf-panel --nf-raised --nf-line --nf-text --nf-dim --nf-accent --nf-ok --nf-warn --nf-error --nf-model --nf-link --nf-font --nf-mono --nf-radius --nf-s1..s4`; shared classes `.nf-btn` (`.primary`, `.danger`, `.ghost`), `.nf-input`, `.nf-empty`, `.nf-log`, `.nf-muted`; elements `nf-button` (attrs `variant`, `disabled`), `nf-field` (`label`), `nf-number` (`label`, `value`, `step`, `min`, `max`; `change` with `detail.value`), `nf-select` (`options` property `[{ value, label }]`, `value`; `change`), `nf-tag` (`tone`: accent|ok|warn|error|model), `nf-progress` (`value` 0..1 or none for busy), `nf-panel` (`title`), `nf-list` (`items` property, `render(item) → node`, `select` event with `detail.item`), `nf-tree` (`items` property `[{ label, children?, data? }]`, `select`), `nf-tabs` (children with `title`; switches), `nf-viewport` (`setObject(obj)`, `frame()`, `ready` promise, `pick` event); functions `h(tag, props, ...kids)`, `toast(text, tone)`, `dialog({ title, body, actions })` → Promise, `confirmDialog(title, text, okLabel)` → Promise<boolean>.

- [ ] **Step 1: Create `src/shell/theme.css`:**

```css
/* The NFGames look: tokens every tool and plugin uses. A light theme would swap only these. */
:root {
  color-scheme: dark;
  --nf-bg: #14171d; --nf-panel: #1c2029; --nf-raised: #252a35; --nf-line: #2c3240;
  --nf-text: #d8dee9; --nf-dim: #8a93a6; --nf-accent: #ffb366; --nf-on-accent: #1a1206;
  --nf-ok: #6fcf97; --nf-warn: #ffd166; --nf-error: #ff7a7a; --nf-model: #5fc9c0; --nf-link: #9fb4d4;
  --nf-font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --nf-mono: 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  --nf-radius: 6px; --nf-s1: 4px; --nf-s2: 8px; --nf-s3: 12px; --nf-s4: 16px;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--nf-bg); color: var(--nf-text); font: var(--nf-font); }
a { color: var(--nf-link); }
.nf-btn { font: inherit; color: var(--nf-text); background: var(--nf-raised); border: 1px solid var(--nf-line); border-radius: var(--nf-radius); padding: 4px 10px; cursor: pointer; }
.nf-btn:hover { border-color: #3a4252; } .nf-btn:disabled { opacity: .45; cursor: default; }
.nf-btn.primary { background: var(--nf-accent); color: var(--nf-on-accent); border-color: var(--nf-accent); font-weight: 600; }
.nf-btn.danger { color: var(--nf-error); border-color: #5a2e2e; } .nf-btn.ghost { background: transparent; border-color: transparent; }
.nf-input, nf-number input, nf-select select { font: inherit; color: var(--nf-text); background: var(--nf-raised); border: 1px solid var(--nf-line); border-radius: var(--nf-radius); padding: 3px 6px; width: 100%; }
nf-button { display: inline-block; margin: 0 var(--nf-s1) var(--nf-s1) 0; }
nf-field, nf-number, nf-select { display: grid; grid-template-columns: 90px 1fr; gap: var(--nf-s2); align-items: center; margin: var(--nf-s1) 0; }
nf-field > .nf-label, nf-number > .nf-label, nf-select > .nf-label { color: var(--nf-dim); }
nf-tag { display: inline-block; font-size: 11px; padding: 0 7px; border-radius: 9px; background: #2a303c; color: var(--nf-link); }
nf-tag[tone=accent] { background: #33291c; color: var(--nf-accent); } nf-tag[tone=ok] { background: #1d3326; color: var(--nf-ok); }
nf-tag[tone=warn] { background: #3a321c; color: var(--nf-warn); } nf-tag[tone=error] { background: #3a2a2a; color: var(--nf-error); } nf-tag[tone=model] { background: #1c3330; color: var(--nf-model); }
nf-progress { display: block; height: 4px; border-radius: 2px; background: var(--nf-line); overflow: hidden; }
nf-progress > i { display: block; height: 100%; background: var(--nf-accent); }
nf-progress:not([value]) > i { width: 30%; animation: nf-busy 1.2s infinite ease-in-out; }
@keyframes nf-busy { from { margin-left: -30%; } to { margin-left: 100%; } }
nf-panel { display: block; border: 1px solid var(--nf-line); border-radius: var(--nf-radius); margin: var(--nf-s2) 0; }
nf-panel > .nf-panel-title { padding: 6px var(--nf-s2); border-bottom: 1px solid var(--nf-line); font-weight: 600; }
nf-panel > .nf-panel-body { padding: var(--nf-s2); }
nf-list, nf-tree { display: block; } .nf-row { padding: 3px 6px; border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nf-row:hover { background: var(--nf-raised); } .nf-row.on { background: #33291c; color: var(--nf-accent); }
nf-tree .nf-tree-kids { padding-left: 14px; }
nf-tabs { display: block; } nf-tabs > .nf-tabbar { display: flex; gap: 2px; border-bottom: 1px solid var(--nf-line); }
.nf-tab { padding: 4px 10px; cursor: pointer; color: var(--nf-dim); border-bottom: 2px solid transparent; } .nf-tab.on { color: var(--nf-text); border-bottom-color: var(--nf-accent); }
nf-viewport { display: block; position: relative; min-height: 240px; background: var(--nf-raised); }
nf-viewport canvas { display: block; width: 100%; height: 100%; position: absolute; inset: 0; }
.nf-empty { color: var(--nf-dim); padding: var(--nf-s3); text-align: center; }
.nf-muted { color: var(--nf-dim); } .nf-log { font: var(--nf-mono); white-space: pre-wrap; margin: 0; }
.nf-toasts { position: fixed; right: 16px; bottom: 36px; display: flex; flex-direction: column; gap: 6px; z-index: 50; }
.nf-toast { background: var(--nf-raised); border-left: 3px solid var(--nf-ok); border-radius: var(--nf-radius); padding: 8px 12px; box-shadow: 0 4px 16px #0006; max-width: 420px; }
.nf-toast.error { border-left-color: var(--nf-error); } .nf-toast.warn { border-left-color: var(--nf-warn); }
.nf-dialog { border: 1px solid var(--nf-line); border-radius: 10px; background: var(--nf-panel); color: var(--nf-text); padding: 0; width: min(560px, 92vw); }
.nf-dialog::backdrop { background: #0008; } .nf-dialog > header { padding: 10px 14px; border-bottom: 1px solid var(--nf-line); font-weight: 600; }
.nf-dialog > .nf-dialog-body { padding: 12px 14px; max-height: 60vh; overflow: auto; } .nf-dialog > footer { padding: 10px 14px; border-top: 1px solid var(--nf-line); display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 2: Create `src/shell/ui.js`:**

```js
// The NFGames UI kit: small custom elements (light DOM, styled by theme.css) and a few functions every tool and plugin
// uses, so everything looks and behaves alike. Import from "/shell/ui.js".
export const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k); return e; };
const label = (el) => h('span', { className: 'nf-label', textContent: el.getAttribute('label') || '' });

class NfButton extends HTMLElement {
  connectedCallback() {
    if (this.btn) return;
    this.btn = h('button', { type: 'button', className: `nf-btn ${this.getAttribute('variant') || ''}`, disabled: this.hasAttribute('disabled') }, ...this.childNodes);
    this.append(this.btn);
  }
  static get observedAttributes() { return ['disabled']; }
  attributeChangedCallback() { if (this.btn) this.btn.disabled = this.hasAttribute('disabled'); }
}
class NfField extends HTMLElement { connectedCallback() { if (this.done) return; this.done = true; const kids = [...this.childNodes]; this.append(label(this), h('span', {}, ...kids)); } }
class NfNumber extends HTMLElement {
  connectedCallback() {
    if (this.input) return;
    this.input = h('input', { type: 'number', step: this.getAttribute('step') || 'any', value: this.getAttribute('value') ?? '' });
    for (const a of ['min', 'max']) if (this.hasAttribute(a)) this.input[a] = this.getAttribute(a);
    this.input.addEventListener('change', () => this.dispatchEvent(new CustomEvent('change', { detail: { value: this.value } })));
    this.append(label(this), this.input);
  }
  get value() { return this.input ? Number(this.input.value) : Number(this.getAttribute('value')); }
  set value(v) { if (this.input) this.input.value = v; else this.setAttribute('value', v); }
}
class NfSelect extends HTMLElement {
  connectedCallback() {
    if (this.sel) return;
    this.sel = h('select'); this.sel.addEventListener('change', () => this.dispatchEvent(new CustomEvent('change', { detail: { value: this.value } })));
    this.append(label(this), this.sel); this.#fill();
  }
  set options(list) { this._options = list; this.#fill(); } get options() { return this._options || []; }
  get value() { return this.sel ? this.sel.value : this._value; } set value(v) { this._value = v; if (this.sel) this.sel.value = v; }
  #fill() { if (!this.sel) return; this.sel.replaceChildren(...this.options.map((o) => h('option', { value: o.value, textContent: o.label ?? o.value }))); if (this._value !== undefined) this.sel.value = this._value; }
}
class NfTag extends HTMLElement {}
class NfProgress extends HTMLElement {
  connectedCallback() { if (!this.bar) { this.bar = h('i'); this.append(this.bar); } this.#show(); }
  static get observedAttributes() { return ['value']; }
  attributeChangedCallback() { this.#show(); }
  #show() { if (this.bar) this.bar.style.width = this.hasAttribute('value') ? `${Math.max(0, Math.min(1, Number(this.getAttribute('value')))) * 100}%` : ''; }
}
class NfPanel extends HTMLElement {
  connectedCallback() { if (this.body) return; const kids = [...this.childNodes]; this.body = h('div', { className: 'nf-panel-body' }, ...kids); this.append(h('div', { className: 'nf-panel-title', textContent: this.getAttribute('title') || '' }), this.body); }
}
class NfList extends HTMLElement {
  set items(list) { this._items = list; this.#draw(); } get items() { return this._items || []; }
  set render(fn) { this._render = fn; this.#draw(); }
  connectedCallback() { this.#draw(); }
  #draw() {
    const render = this._render || ((i) => String(i.label ?? i));
    this.replaceChildren(...this.items.map((item) => { const row = h('div', { className: 'nf-row' }, render(item)); row.onclick = () => { for (const r of this.children) r.classList.toggle('on', r === row); this.dispatchEvent(new CustomEvent('select', { detail: { item } })); }; return row; }));
  }
}
class NfTree extends HTMLElement {
  set items(list) { this._items = list; this.#draw(); } get items() { return this._items || []; }
  connectedCallback() { this.#draw(); }
  #draw() {
    const node = (item) => {
      const kids = item.children && item.children.length ? h('div', { className: 'nf-tree-kids' }, ...item.children.map(node)) : null;
      const row = h('div', { className: 'nf-row', textContent: `${kids ? '▾ ' : ''}${item.label}` });
      row.onclick = () => { if (kids) { kids.hidden = !kids.hidden; row.textContent = `${kids.hidden ? '▸' : '▾'} ${item.label}`; } this.dispatchEvent(new CustomEvent('select', { detail: { item } })); };
      return h('div', {}, row, kids);
    };
    this.replaceChildren(...this.items.map(node));
  }
}
class NfTabs extends HTMLElement {
  connectedCallback() {
    if (this.bar) return;
    const panes = [...this.children]; this.bar = h('div', { className: 'nf-tabbar' }); this.prepend(this.bar);
    const show = (i) => { panes.forEach((p, j) => { p.hidden = i !== j; }); [...this.bar.children].forEach((t, j) => t.classList.toggle('on', i === j)); };
    panes.forEach((p, i) => this.bar.append(h('span', { className: 'nf-tab', textContent: p.getAttribute('title') || `Tab ${i + 1}`, onclick: () => show(i) })));
    show(0);
  }
}

/** A three.js view: orbit, grid, framing and picking, on the editor's one pinned three.js (installed on demand). */
class NfViewport extends HTMLElement {
  connectedCallback() { if (!this.ready) this.ready = this.#start(); else this.three?.renderer.setAnimationLoop(this.loop); }
  disconnectedCallback() { this.three?.renderer.setAnimationLoop(null); }
  async #start() {
    const info = await fetch('/api/viewer').then((r) => r.json());
    if (!info.three.installed) {
      const btn = h('button', { className: 'nf-btn primary', textContent: `Install three.js ${info.three.version}` });
      btn.onclick = async () => { btn.disabled = true; btn.textContent = 'Installing…'; const r = await fetch('/api/vendor/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (r.ok) location.reload(); else { btn.disabled = false; btn.textContent = `Not installed: ${(await r.json()).error}`; } };
      this.replaceChildren(h('div', { className: 'nf-empty' }, h('p', { textContent: '3D views need three.js, which is installed on demand.' }), btn));
      return null;
    }
    const T = await import('three');
    const [{ OrbitControls }, { RoomEnvironment }] = await Promise.all([import('three/addons/controls/OrbitControls.js'), import('three/addons/environments/RoomEnvironment.js')]);
    const canvas = h('canvas'); this.replaceChildren(canvas);
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.toneMapping = T.ACESFilmicToneMapping;
    const scene = new T.Scene(); scene.background = new T.Color(getComputedStyle(this).getPropertyValue('--nf-raised').trim() || '#252a35');
    scene.environment = new T.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    const camera = new T.PerspectiveCamera(45, 1, 0.01, 1e5); camera.position.set(4, 3, 6);
    const controls = new OrbitControls(camera, canvas); controls.enableDamping = true;
    const grid = new T.GridHelper(20, 20, 0x3a4252, 0x2c3240); scene.add(grid);
    const resize = () => { const w = this.clientWidth || 300, ht = this.clientHeight || 240; renderer.setSize(w, ht, false); camera.aspect = w / ht; camera.updateProjectionMatrix(); };
    new ResizeObserver(resize).observe(this); resize();
    this.loop = () => { controls.update(); renderer.render(scene, camera); }; renderer.setAnimationLoop(this.loop);
    const ray = new T.Raycaster(), ndc = new T.Vector2(); let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !this.object) return;
      const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera);
      this.dispatchEvent(new CustomEvent('pick', { detail: ray.intersectObject(this.object, true)[0] || null }));
    });
    this.three = { T, renderer, scene, camera, controls, grid };
    return this.three;
  }
  async setObject(obj) { const t = await this.ready; if (!t) return; if (this.object) t.scene.remove(this.object); this.object = obj; if (obj) { t.scene.add(obj); this.frame(); } }
  frame() {
    const t = this.three; if (!t || !this.object) return;
    const box = new t.T.Box3().setFromObject(this.object), size = box.getSize(new t.T.Vector3()), c = box.getCenter(new t.T.Vector3()), r = Math.max(size.x, size.y, size.z) || 1;
    t.controls.target.copy(c); t.camera.position.copy(c).add(new t.T.Vector3(1, 0.6, 1).normalize().multiplyScalar(r * 1.6));
    t.camera.near = r / 1000; t.camera.far = r * 1000; t.camera.updateProjectionMatrix(); t.grid.scale.setScalar(Math.max(1, r / 10)); t.grid.position.y = box.min.y;
  }
}

for (const [name, cls] of Object.entries({ 'nf-button': NfButton, 'nf-field': NfField, 'nf-number': NfNumber, 'nf-select': NfSelect, 'nf-tag': NfTag, 'nf-progress': NfProgress, 'nf-panel': NfPanel, 'nf-list': NfList, 'nf-tree': NfTree, 'nf-tabs': NfTabs, 'nf-viewport': NfViewport }))
  if (!customElements.get(name)) customElements.define(name, cls);

let toasts = null;
/** A short message in the corner: tone '' (done), 'warn' or 'error'. */
export function toast(text, tone = '') {
  if (!toasts) { toasts = h('div', { className: 'nf-toasts' }); document.body.append(toasts); }
  const t = h('div', { className: `nf-toast ${tone}`, textContent: text }); toasts.append(t);
  setTimeout(() => t.remove(), tone === 'error' ? 9000 : 4000);
}
/** A modal dialog: resolves with the clicked action's value (or null when closed). */
export function dialog({ title, body, actions = [{ label: 'Close', value: null }] }) {
  return new Promise((done) => {
    const d = h('dialog', { className: 'nf-dialog' }, h('header', { textContent: title }), h('div', { className: 'nf-dialog-body' }, body),
      h('footer', {}, ...actions.map((a) => h('button', { className: `nf-btn ${a.variant || ''}`, textContent: a.label, onclick: () => { d.close(); done(a.value); } }))));
    d.addEventListener('close', () => { d.remove(); done(null); });
    document.body.append(d); d.showModal();
  });
}
export const confirmDialog = (title, text, ok = 'OK') => dialog({ title, body: typeof text === 'string' ? h('p', { textContent: text }) : text, actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, variant: 'primary' }] }).then((v) => v === true);
```

- [ ] **Step 3:** Syntax check: `node --check` cannot read a `.js` module that uses the DOM at import time only when run; check with `node -e "import('./src/shell/ui.js').catch(e => { if (!/document|HTMLElement|customElements/.test(e.message)) throw e; console.log('ok: browser module') })"`. Full check in Task 6. **Commit:** "Workbench: the theme and the UI kit".

---

### Task 4: The workbench page

**Files:** Create `src/shell/index.html` (replace the placeholder), `src/shell/workbench.css`, `src/shell/workbench.js`.

**Consumes:** Tasks 1–3; `/api/plugins`, `/api/plugins/<id>/(activate|trust|enable|disable|reload|settings)`, `/api/events`, `/api/job`, `/p/<id>/<web>`.

**Produces:** the page, and the **page plugin API** given to a plugin's `web` module `activate(api)`: `id`; `tools.register(id, factory)`, `editors.register(id, factory)`, `panels.register(id, factory)`, `inspectors.register(id, factory)`, `statusItems.register(id, factory)` (factory `(element, context) → optional cleanup`; context: a document for editors, the selection for inspectors); `commands.register(id, fn)`, `commands.execute(id, …)`; `documents.open({ title, editor, uri })`, `.close`, `.setDirty`, `.setTitle`; `fetch(path, options)` (its own routes, JSON); `events.on(name | '*', fn)`; `ui` (`toast`, `dialog`, `confirm`, `palette`); `selection` (`get`, `set`, `on`); `problems.set(list)`; `settings.get()` / `settings.set(key, value)`; `three()`. Everything returns `{ dispose }` and is undone when the plugin unloads.

- [ ] **Step 1: Create `src/shell/index.html`:**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NFGames</title>
<link rel="stylesheet" href="/shell/theme.css">
<link rel="stylesheet" href="/shell/workbench.css">
<script type="importmap">/*@importmap*/</script>
</head>
<body>
<div id="wb">
  <header id="top"><b class="brand">◆ NFGames</b><!--@nav--><button id="paletteOpen" class="search" title="Search commands (⌘K)">Search commands…</button><span id="jobInd" class="nf-muted"></span></header>
  <nav id="activity"><div id="activityTools"></div><div id="activityCore"></div></nav>
  <aside id="side"><div class="region-title" id="sideTitle"></div><div id="sideBody" class="region-body"></div></aside>
  <main id="docs"><div id="tabs"></div><div id="docBody"></div></main>
  <aside id="inspector"><div class="region-title">Inspector</div><div id="inspectorBody" class="region-body"></div></aside>
  <section id="bottom"><div id="bottomTabs"></div><div id="bottomBody" class="region-body"></div></section>
  <footer id="status"><span id="statusLeft"></span><span id="statusRight"></span></footer>
</div>
<script type="module" src="/shell/workbench.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `src/shell/workbench.css`:**

```css
/* The workbench's regions. Hiding a region (commands "Toggle …") collapses its grid track. */
#wb { display: grid; height: 100vh; grid-template-columns: 46px var(--side-w, 260px) 1fr var(--inspector-w, 280px); grid-template-rows: 40px 1fr var(--bottom-h, 190px) 24px; }
#wb.no-side { --side-w: 0px; } #wb.no-inspector { --inspector-w: 0px; } #wb.no-bottom { --bottom-h: 0px; }
#wb.no-side #side, #wb.no-inspector #inspector, #wb.no-bottom #bottom { display: none; }
#top { grid-column: 1 / 5; display: flex; align-items: center; gap: var(--nf-s3); padding: 0 var(--nf-s3); background: var(--nf-panel); border-bottom: 1px solid var(--nf-line); }
#top .brand { color: var(--nf-accent); white-space: nowrap; } #top #nfnav { flex: none; }
#top .search { flex: 1; max-width: 520px; margin: 0 auto; text-align: left; font: inherit; color: var(--nf-dim); background: var(--nf-raised); border: 1px solid var(--nf-line); border-radius: var(--nf-radius); padding: 4px 10px; cursor: pointer; }
#activity { grid-row: 2 / 4; display: flex; flex-direction: column; justify-content: space-between; background: var(--nf-panel); border-right: 1px solid var(--nf-line); padding: 4px 0; }
.act { display: block; width: 100%; font-size: 18px; padding: 8px 0; background: none; border: 0; color: var(--nf-dim); cursor: pointer; border-left: 2px solid transparent; }
.act:hover { color: var(--nf-text); } .act.on { color: var(--nf-accent); border-left-color: var(--nf-accent); }
#side, #inspector { grid-row: 2 / 4; background: var(--nf-panel); overflow: hidden; display: flex; flex-direction: column; }
#side { border-right: 1px solid var(--nf-line); } #inspector { border-left: 1px solid var(--nf-line); }
.region-title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--nf-dim); padding: 8px var(--nf-s3) 4px; }
.region-body { flex: 1; overflow: auto; padding: 0 var(--nf-s3) var(--nf-s3); }
#docs { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--nf-bg); }
#tabs { display: flex; gap: 1px; background: var(--nf-panel); border-bottom: 1px solid var(--nf-line); min-height: 30px; overflow-x: auto; }
.doc-tab { display: flex; align-items: center; gap: 6px; padding: 5px 10px; color: var(--nf-dim); cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; }
.doc-tab.on { color: var(--nf-text); background: var(--nf-bg); border-bottom-color: var(--nf-accent); }
.doc-tab .x { opacity: .5; } .doc-tab .x:hover { opacity: 1; } .doc-tab.dirty .x::before { content: '●'; }
.doc-tab.dirty .x { font-size: 0; } .doc-tab.dirty .x::before { font-size: 11px; }
#docBody { flex: 1; position: relative; min-height: 0; }
.doc-pane { position: absolute; inset: 0; overflow: auto; } .doc-pane.frame { overflow: hidden; } .doc-pane iframe { border: 0; width: 100%; height: 100%; display: block; }
#bottom { grid-column: 3; display: flex; flex-direction: column; background: var(--nf-panel); border-top: 1px solid var(--nf-line); min-height: 0; }
#bottomTabs { display: flex; gap: 2px; padding: 0 var(--nf-s2); border-bottom: 1px solid var(--nf-line); }
#bottomBody { padding-top: var(--nf-s2); }
#status { grid-column: 1 / 5; display: flex; justify-content: space-between; align-items: center; padding: 0 var(--nf-s3); font-size: 12px; color: var(--nf-dim); background: var(--nf-panel); border-top: 1px solid var(--nf-line); }
#status span { display: flex; gap: var(--nf-s3); }
.palette { position: fixed; inset: 0; background: #0006; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; z-index: 40; }
.palette > div { width: min(620px, 92vw); background: var(--nf-panel); border: 1px solid var(--nf-line); border-radius: 10px; box-shadow: 0 12px 40px #0008; overflow: hidden; }
.palette input { width: 100%; font: inherit; font-size: 15px; padding: 12px 14px; background: var(--nf-raised); color: var(--nf-text); border: 0; outline: 0; }
.palette ul { list-style: none; margin: 0; padding: 4px; max-height: 50vh; overflow: auto; }
.palette li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
.palette li.on { background: #33291c; color: var(--nf-accent); } .palette li .cat { color: var(--nf-dim); font-size: 12px; }
.plugin-row { border: 1px solid var(--nf-line); border-radius: var(--nf-radius); padding: 10px; margin: 8px 0; }
.plugin-row header { display: flex; gap: 8px; align-items: center; } .plugin-row header b { flex: 1; }
.plugin-row .why { color: var(--nf-error); font-size: 12px; margin-top: 4px; }
.doc-page { max-width: 820px; padding: var(--nf-s4); }
```

- [ ] **Step 3: Create `src/shell/workbench.js`:**

```js
// The workbench: the regions, the page half of the plugin API, plugins' page parts loaded on demand, the ⌘K palette,
// the Plugins and Settings screens, and the Jobs, Problems and Output panels. Plugin parts only reach the page through
// the api object they are given; everything they register is undone when they are turned off or reloaded.
import { createRegistry } from './core/registry.js';
import { matches, parseKeys, showKeys } from './core/keys.js';
import { createCommands, rank } from './core/commands.js';
import { createSelection } from './core/selection.js';
import { createDocuments } from './core/documents.js';
import { contributionsOf } from './core/contributions.js';
import { h, toast, dialog, confirmDialog } from './ui.js';

const $ = (id) => document.getElementById(id);
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const json = async (url, options) => { const r = await fetch(url, options), j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`); return j; };
const post = (url, body = {}) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---- state
let plugins = [], model = contributionsOf([]), activeTool = null, bottomTab = 'core/jobs';
const commands = createCommands(), selection = createSelection(), documents = createDocuments();
const tools = createRegistry(), editors = createRegistry(), panels = createRegistry(), inspectors = createRegistry(), statusItems = createRegistry();
const problems = new Map(), output = [], listeners = new Map(), loaded = new Map(), declared = [];
const mounted = new Map();   // document id → { el, cleanup }

// ---- events from the host
// EventSource only delivers named events it subscribed to: each name is subscribed the first time someone asks for it;
// '*' hears every event the page is subscribed to (the workbench's own, and any a plugin asked for).
const stream = new EventSource('/api/events'), subscribed = new Set();
function subscribe(name) { if (name === '*' || subscribed.has(name)) return; subscribed.add(name); stream.addEventListener(name, (e) => dispatch(name, JSON.parse(e.data || '{}'))); }
function onEvent(name, fn) { subscribe(name); if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return { dispose: () => listeners.get(name)?.delete(fn) }; }
function dispatch(name, data) { for (const fn of listeners.get(name) || []) try { fn(data); } catch (e) { log(`listener for ${name}: ${e.message}`); } for (const fn of listeners.get('*') || []) try { fn(name, data); } catch { /* a listener's problem */ } }
for (const name of ['plugins/changed', 'plugins/failed', 'jobs/started', 'jobs/done', 'settings/changed', 'project/changed']) subscribe(name);
function log(text) { output.push(`${new Date().toLocaleTimeString()}  ${text}`); if (output.length > 500) output.shift(); if (bottomTab === 'core/output') renderBottom(); }

// ---- the page plugin API, one per plugin
function makeApi(p, rec) {
  const own = (d) => { rec.disposers.push(() => d.dispose()); return d; };
  const full = (id) => (id.includes('/') ? id : `${p.id}/${id}`);
  const reg = (registry) => ({ register: (id, factory) => own(registry.add(`${p.id}/${id}`, factory)) });
  return {
    id: p.id,
    tools: reg(tools), editors: reg(editors), panels: reg(panels), inspectors: reg(inspectors), statusItems: reg(statusItems),
    commands: { register: (id, fn) => own(commands.handle(full(id), fn)), execute: (id, ...a) => commands.execute(full(id), ...a) },
    documents: { open: (o) => documents.open({ ...o, editor: full(o.editor) }), close: documents.close, setDirty: documents.setDirty, setTitle: documents.setTitle },
    fetch: (path, options = {}) => json(`/api/p/${p.id}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }),
    events: { on: (name, fn) => own(onEvent(name, fn)) },
    ui: { toast, dialog, confirm: confirmDialog, palette: openPalette },
    selection: { get: selection.get, set: (type, items) => selection.set(type, items), on: (fn) => own(selection.on(fn)) },
    problems: { set: (list) => { problems.set(p.id, (list || []).map((x) => ({ ...x, plugin: p.id }))); own({ dispose: () => problems.delete(p.id) }); renderStatus(); if (bottomTab === 'core/problems') renderBottom(); } },
    settings: { get: () => json(`/api/plugins/${p.id}/settings`).then((s) => s.values), set: (key, value) => post(`/api/plugins/${p.id}/settings`, { key, value }) },
    three: () => import('three'),
  };
}

// ---- loading plugins' page parts (and server parts) on demand
async function ensure(id) {
  if (loaded.has(id)) return loaded.get(id);
  const run = (async () => {
    const p = plugins.find((x) => x.id === id);
    if (!p) throw new Error(`no plugin ${id}`);
    await post(`/api/plugins/${id}/activate`);
    const rec = { disposers: [], mod: null };
    if (p.web) { rec.mod = await import(`/p/${id}/${p.web}?v=${Date.now()}`); if (typeof rec.mod.activate === 'function') await rec.mod.activate(makeApi(p, rec)); }
    return rec;
  })();
  loaded.set(id, run);
  try { return await run; } catch (e) { loaded.delete(id); log(`${id}: ${e.message}`); toast(`${id} could not start: ${e.message}`, 'error'); throw e; }
}
async function unload(id) {
  const run = loaded.get(id); if (!run) return; loaded.delete(id);
  const rec = await run.catch(() => null); if (!rec) return;
  try { await rec.mod?.deactivate?.(); } catch (e) { log(`${id} deactivate: ${e.message}`); }
  for (const d of rec.disposers.splice(0).reverse()) try { d(); } catch (e) { log(`${id} clean-up: ${e.message}`); }
}

// ---- the manifests: tools, commands, panels the workbench shows before any plugin code runs
async function refreshPlugins() {
  plugins = (await json('/api/plugins')).plugins;
  for (const id of [...loaded.keys()]) if (!['ready', 'active'].includes(plugins.find((p) => p.id === id)?.state)) await unload(id);
  model = contributionsOf(plugins);
  for (const d of declared.splice(0)) d.dispose();
  for (const c of model.commands) declared.push(commands.declare(c.key, { title: c.title, keys: c.keys, plugin: c.plugin, category: c.category, load: () => ensure(c.plugin) }));
  for (const s of model.statusItems) ensure(s.plugin).catch(() => {});
  render();
}

// ---- core commands
const core = (id, title, fn, keys = null) => { commands.declare(id, { title, keys, category: 'Workbench' }); commands.handle(id, fn); };
core('core/palette', 'Search commands', () => openPalette(), 'Mod+K');
core('core/toggle-side', 'Toggle the side panel', () => $('wb').classList.toggle('no-side'));
core('core/toggle-inspector', 'Toggle the inspector', () => $('wb').classList.toggle('no-inspector'));
core('core/toggle-bottom', 'Toggle the bottom panel', () => $('wb').classList.toggle('no-bottom'));
core('core/plugins', 'Plugins: manage', () => documents.open({ title: 'Plugins', editor: 'core/plugins', uri: 'plugins' }));
core('core/settings', 'Settings', () => documents.open({ title: 'Settings', editor: 'core/settings', uri: 'settings' }));
core('core/close-document', 'Close the document', () => { const d = documents.active(); if (d) documents.close(d.id); }, 'Alt+W');
core('core/open-project', 'Open project…', () => document.getElementById('nfOpen')?.click());

// ---- rendering
function render() { renderActivity(); renderSide(); renderDocs(); renderInspector(); renderBottom(); renderStatus(); }

function renderActivity() {
  const btn = (t) => h('button', { className: `act${activeTool === t.key ? ' on' : ''}`, textContent: t.icon, title: t.title, onclick: () => setTool(activeTool === t.key ? null : t.key) });
  $('activityTools').replaceChildren(...model.tools.map(btn));
  $('activityCore').replaceChildren(btn({ key: 'core/plugins', icon: '🧩', title: 'Plugins' }), btn({ key: 'core/settings', icon: '⚙', title: 'Settings' }));
}
async function setTool(key) {
  activeTool = key; renderActivity();
  if (key === 'core/plugins' || key === 'core/settings') { activeTool = null; renderActivity(); return commands.execute(key); }
  const t = model.tools.find((x) => x.key === key);
  if (t) { $('wb').classList.remove('no-side'); renderSide(); try { await ensure(t.plugin); } catch { return; } }
  renderSide();
}
let sideCleanup = null;
function renderSide() {
  if (typeof sideCleanup === 'function') sideCleanup(); sideCleanup = null;
  const t = model.tools.find((x) => x.key === activeTool), body = $('sideBody');
  $('sideTitle').textContent = t ? t.title : 'Tools';
  if (!t) { body.replaceChildren(h('p', { className: 'nf-muted', textContent: model.tools.length ? 'Pick a tool on the left.' : 'No tools yet: add plugins (🧩).' })); return; }
  const factory = tools.get(t.key);
  if (!factory) { body.replaceChildren(h('p', { className: 'nf-muted', textContent: loaded.has(t.plugin) ? `${t.title} has no side panel.` : 'Loading…' })); return; }
  body.replaceChildren(); try { sideCleanup = factory(body, {}); } catch (e) { body.replaceChildren(h('p', { className: 'nf-muted', textContent: `${t.title} failed: ${e.message}` })); }
}
tools.onChange(renderSide);

function renderDocs() {
  const docs = documents.list(), active = documents.active();
  $('tabs').replaceChildren(...docs.map((d) => h('div', { className: `doc-tab${active && d.id === active.id ? ' on' : ''}${d.dirty ? ' dirty' : ''}`, title: d.uri || d.title, onclick: () => documents.focus(d.id) },
    h('span', { textContent: d.title }), h('span', { className: 'x', textContent: '✕', onclick: (e) => { e.stopPropagation(); documents.close(d.id); } }))));
  for (const [id, m] of mounted) if (!docs.some((d) => d.id === id)) { if (typeof m.cleanup === 'function') m.cleanup(); m.el.remove(); mounted.delete(id); }
  for (const d of docs) if (!mounted.has(d.id)) mountDoc(d);
  for (const [id, m] of mounted) m.el.hidden = !active || id !== active.id;
  if (!docs.length && !$('docBody').querySelector('.nf-empty')) $('docBody').append(h('div', { className: 'nf-empty', textContent: 'Open something from a tool, or press ⌘K.' }));
  if (docs.length) $('docBody').querySelector(':scope > .nf-empty')?.remove();
}
async function mountDoc(d) {
  const el = h('div', { className: 'doc-pane' }); $('docBody').append(el); const m = { el, cleanup: null }; mounted.set(d.id, m);
  if (d.editor === 'core/plugins') { m.cleanup = renderPluginsScreen(el); return; }
  if (d.editor === 'core/settings') { m.cleanup = renderSettingsScreen(el); return; }
  const owner = d.editor.split('/')[0];
  if (!editors.has(d.editor)) { el.append(h('p', { className: 'nf-empty', textContent: 'Loading…' })); try { await ensure(owner); } catch { return; } }
  const factory = editors.get(d.editor);
  el.replaceChildren();
  if (!factory) { el.append(h('p', { className: 'nf-empty', textContent: `No editor ${d.editor}.` })); return; }
  try { m.cleanup = factory(el, d); } catch (e) { el.append(h('p', { className: 'nf-empty', textContent: `${d.editor} failed: ${e.message}` })); }
}
documents.on(() => { renderDocs(); renderStatus(); });

let inspectorCleanups = [];
function renderInspector() {
  for (const c of inspectorCleanups.splice(0)) if (typeof c === 'function') c();
  const sel = selection.get(), body = $('inspectorBody');
  if (!sel.type) { body.replaceChildren(h('p', { className: 'nf-muted', textContent: 'Nothing selected.' })); return; }
  const wanted = model.inspectors.filter((i) => i.for === sel.type);
  body.replaceChildren(h('p', { className: 'nf-muted', textContent: `${sel.items.length} selected (${sel.type})` }));
  for (const i of wanted) {
    const box = h('nf-panel', { title: i.title }); body.append(box);
    const show = () => { const f = inspectors.get(i.key); if (f) { const inner = box.querySelector('.nf-panel-body') || box; inner.replaceChildren(); inspectorCleanups.push(f(inner, sel)); } };
    if (inspectors.has(i.key)) show(); else ensure(i.plugin).then(show).catch(() => {});
  }
}
selection.on(() => { renderInspector(); renderStatus(); });

function renderBottom() {
  const tabs = [{ key: 'core/jobs', title: 'Jobs' }, { key: 'core/problems', title: `Problems${countProblems() ? ` (${countProblems()})` : ''}` }, { key: 'core/output', title: 'Output' }, ...model.panels.filter((p) => p.region === 'bottom')];
  $('bottomTabs').replaceChildren(...tabs.map((t) => h('span', { className: `nf-tab${bottomTab === t.key ? ' on' : ''}`, textContent: t.title, onclick: () => { bottomTab = t.key; renderBottom(); } })));
  const body = $('bottomBody');
  if (bottomTab === 'core/jobs') return renderJobs(body);
  if (bottomTab === 'core/problems') { const all = [...problems.values()].flat(); body.replaceChildren(all.length ? h('ul', { className: 'nf-log' }, ...all.map((p) => h('li', { textContent: `${p.kind || 'problem'}  ${p.text}  (${p.plugin})` }))) : h('p', { className: 'nf-muted', textContent: 'No problems.' })); return; }
  if (bottomTab === 'core/output') { body.replaceChildren(h('pre', { className: 'nf-log', textContent: output.join('\n') || 'Nothing yet.' })); return; }
  const panel = model.panels.find((p) => p.key === bottomTab);
  if (!panel) { bottomTab = 'core/jobs'; return renderBottom(); }
  const mount = () => { const f = panels.get(panel.key); body.replaceChildren(); if (f) f(body, {}); else body.append(h('p', { className: 'nf-muted', textContent: 'Nothing to show.' })); };
  if (panels.has(panel.key)) mount(); else { body.replaceChildren(h('p', { className: 'nf-muted', textContent: 'Loading…' })); ensure(panel.plugin).then(mount).catch(() => {}); }
}
const countProblems = () => [...problems.values()].reduce((n, l) => n + l.length, 0);
async function renderJobs(body) {
  const j = await json('/api/job').catch(() => null);
  if (bottomTab !== 'core/jobs') return;
  if (!j || j.state === 'idle') { body.replaceChildren(h('p', { className: 'nf-muted', textContent: 'No job has run yet.' })); return; }
  body.replaceChildren(h('p', {}, h('nf-tag', { textContent: j.state, tone: j.state === 'done' ? 'ok' : j.state === 'failed' ? 'error' : 'accent' }), ` ${j.label || j.kind}`), ...(j.state === 'running' ? [h('nf-progress')] : []), h('pre', { className: 'nf-log', textContent: j.log }));
  for (const t of body.querySelectorAll('nf-tag')) t.setAttribute('tone', t.tone);
}

function renderStatus() {
  const sel = selection.get(), doc = documents.active();
  $('statusLeft').replaceChildren(h('span', { textContent: doc ? `${doc.title}${doc.dirty ? ' · unsaved' : ''}` : 'No document' }), ...(sel.items.length ? [h('span', { textContent: `${sel.items.length} selected` })] : []), ...(countProblems() ? [h('span', { textContent: `⚠ ${countProblems()}` })] : []));
  const right = $('statusRight'); right.replaceChildren();
  for (const s of model.statusItems) { const f = statusItems.get(s.key); if (!f) continue; const el = h('span'); right.append(el); try { f(el, {}); } catch (e) { el.textContent = `${s.plugin}: ${e.message}`; } }
  right.append(h('span', { textContent: mac ? '⌘K commands' : 'Ctrl+K commands' }));
}
statusItems.onChange(renderStatus);
panels.onChange(() => { if (model.panels.some((p) => p.key === bottomTab)) renderBottom(); });

// ---- Plugins and Settings screens
function renderPluginsScreen(el) {
  const draw = () => {
    const page = h('div', { className: 'doc-page' }, h('h2', { textContent: 'Plugins' }), h('p', { className: 'nf-muted', textContent: 'Built-in plugins are trusted. Every other plugin runs only once you trust it, and asks again when it changes.' }));
    for (const p of plugins) {
      const tone = { active: 'ok', ready: 'ok', 'needs-trust': 'warn', off: '', failed: 'error', invalid: 'error', incompatible: 'warn' }[p.state] || '';
      const act = async (verb) => { try { await post(`/api/plugins/${p.id}/${verb}`); if (verb !== 'trust') await unload(p.id); await refreshPlugins(); draw(); } catch (e) { toast(e.message, 'error'); } };
      const buttons = [];
      if (p.state === 'needs-trust') buttons.push(h('button', { className: 'nf-btn primary', textContent: 'Trust…', onclick: async () => {
        const body = h('div', {}, h('p', { textContent: `${p.name} ${p.version} (${p.source}) runs with your rights once trusted.` }), h('p', { textContent: `Touches: ${JSON.stringify(p.touches)}` }), h('p', { textContent: `Adds: ${Object.entries(p.contributes || {}).map(([k, v]) => `${k} (${Array.isArray(v) ? v.length : Object.keys(v).length})`).join(', ') || 'nothing'}` }));
        if (await confirmDialog(`Trust ${p.name}?`, body, 'Trust it')) act('trust');
      } }));
      if (['ready', 'active', 'failed', 'needs-trust'].includes(p.state)) buttons.push(h('button', { className: 'nf-btn', textContent: 'Turn off', onclick: () => act('disable') }));
      if (p.state === 'off') buttons.push(h('button', { className: 'nf-btn', textContent: 'Turn on', onclick: () => act('enable') }));
      if (['active', 'failed'].includes(p.state)) buttons.push(h('button', { className: 'nf-btn', textContent: 'Reload', onclick: () => act('reload') }));
      page.append(h('div', { className: 'plugin-row' }, h('header', {}, h('b', { textContent: `${p.name} ` }, h('span', { className: 'nf-muted', textContent: `${p.id} ${p.version || ''} · ${p.source}` })), h('nf-tag', { textContent: p.state, tone }), ...buttons),
        ...(p.errors.length ? [h('div', { className: 'why', textContent: p.errors.join('; ') })] : []), ...(p.failure ? [h('div', { className: 'why', textContent: p.failure })] : []),
        ...(p.state === 'incompatible' ? [h('div', { className: 'why', textContent: `needs editor plugin API ${p.needs}` })] : [])));
    }
    for (const t of page.querySelectorAll('nf-tag')) if (t.tone) t.setAttribute('tone', t.tone);
    el.replaceChildren(page);
  };
  draw(); const sub = onEvent('plugins/changed', () => refreshPlugins().then(draw)); return () => sub.dispose();
}
function renderSettingsScreen(el) {
  const page = h('div', { className: 'doc-page' }, h('h2', { textContent: 'Settings' }));
  if (!model.settings.length) page.append(h('p', { className: 'nf-muted', textContent: 'No plugin has settings.' }));
  for (const s of model.settings) {
    const box = h('nf-panel', { title: s.name }); page.append(box);
    json(`/api/plugins/${s.plugin}/settings`).then(({ schema, values }) => {
      const inner = box.querySelector('.nf-panel-body') || box;
      for (const [key, def] of Object.entries(schema)) {
        const save = (value) => post(`/api/plugins/${s.plugin}/settings`, { key, value }).then(() => toast(`Saved ${def.title || key}`)).catch((e) => toast(e.message, 'error'));
        const type = def.type || typeof def.default, title = def.title || key;
        let field;
        if (Array.isArray(def.enum)) { field = h('nf-select'); field.setAttribute('label', title); field.options = def.enum.map((v) => ({ value: String(v) })); field.value = String(values[key]); field.addEventListener('change', () => save(type === 'number' ? Number(field.value) : field.value)); }
        else if (type === 'boolean') { const box2 = h('input', { type: 'checkbox', checked: !!values[key], onchange: () => save(box2.checked) }); field = h('nf-field', {}, box2); field.setAttribute('label', title); }
        else if (type === 'number') { field = h('nf-number'); field.setAttribute('label', title); field.setAttribute('value', values[key]); field.addEventListener('change', () => save(field.value)); }
        else { const input = h('input', { className: 'nf-input', value: values[key] ?? '', onchange: () => save(input.value) }); field = h('nf-field', {}, input); field.setAttribute('label', title); }
        inner.append(field);
      }
    }).catch((e) => box.append(h('p', { className: 'nf-muted', textContent: e.message })));
  }
  el.replaceChildren(page); return null;
}

// ---- the palette
function openPalette(initial = '') {
  if (document.querySelector('.palette')) return;
  const input = h('input', { placeholder: 'Type a command…', value: initial }), list = h('ul'), wrap = h('div', { className: 'palette' }, h('div', {}, input, list));
  const items = () => [...commands.list(), ...model.tools.map((t) => ({ id: `tool:${t.key}`, title: `Open tool: ${t.title}`, category: 'Tools', tool: t.key }))];
  let shown = [], at = 0;
  const run = async (item) => { close(); try { if (item.tool) await setTool(item.tool); else await commands.execute(item.id); } catch (e) { toast(e.message, 'error'); } };
  const draw = () => { shown = rank(items(), input.value).slice(0, 40).map((r) => r.item); at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((c, i) => h('li', { className: i === at ? 'on' : '', onclick: () => run(c) }, h('span', { textContent: c.title }), h('span', { className: 'cat', textContent: [c.category, c.keys && showKeys(parseKeys(c.keys, { mac }), { mac })].filter(Boolean).join('  ') })))); };
  const close = () => wrap.remove();
  input.addEventListener('input', () => { at = 0; draw(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { at = Math.min(at + 1, shown.length - 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { at = Math.max(at - 1, 0); draw(); e.preventDefault(); } else if (e.key === 'Enter' && shown[at]) run(shown[at]); else if (e.key === 'Escape') close(); });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap); draw(); input.focus();
}
$('paletteOpen').textContent = `Search commands…   ${mac ? '⌘K' : 'Ctrl+K'}`;
$('paletteOpen').onclick = () => openPalette();

// ---- keys
addEventListener('keydown', (e) => {
  if (document.querySelector('.palette, dialog[open]')) return;
  const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
  for (const c of commands.list()) {
    if (!c.keys) continue;
    let chord; try { chord = parseKeys(c.keys, { mac }); } catch { continue; }
    if (matches(chord, e) && (!typing || chord.ctrl || chord.meta)) { e.preventDefault(); commands.execute(c.id).catch((err) => toast(err.message, 'error')); return; }
  }
});

// ---- live updates
onEvent('plugins/changed', () => refreshPlugins());
onEvent('plugins/failed', ({ id, message }) => { log(`${id}: ${message}`); toast(`${id} was turned off: ${message}`, 'error'); unload(id); refreshPlugins(); });
onEvent('jobs/started', ({ label }) => { $('jobInd').textContent = `● ${label}`; if (bottomTab === 'core/jobs') renderBottom(); });
onEvent('jobs/done', ({ label, state }) => { $('jobInd').textContent = ''; toast(`${label}: ${state}`, state === 'done' ? '' : 'error'); if (bottomTab === 'core/jobs') renderBottom(); });
onEvent('project/changed', () => location.reload());

// ---- start
await refreshPlugins();
window.__workbench = { commands, selection, documents, get plugins() { return plugins; }, ensure, unload, openPalette, problems };
```

- [ ] **Step 4: Check it loads** (Task 6 does the full browser check): start an editor on the sample project and open `/`; the page shows the regions, the 🧩 and ⚙ buttons, and no console errors. **Commit:** "Workbench: the page (regions, page plugin API, on-demand loading, palette, Plugins and Settings, Jobs, Problems, Output)".

---

### Task 5: Classic tools and the sample plugin's page part

**Files:** Create `plugins/classic/plugin.json`, `plugins/classic/web/index.js` (and remove `plugins/.gitkeep`); modify `examples/plugins/hello/plugin.json`, create `examples/plugins/hello/web/index.js`.

- [ ] **Step 1: Create `plugins/classic/plugin.json`:**

```json
{
  "id": "nfgames.classic",
  "name": "Classic tools",
  "version": "1.0.0",
  "engines": { "nfgames": "^1.0.0" },
  "web": "web/index.js",
  "contributes": {
    "tools": [
      { "id": "map", "title": "Map editor (classic)", "icon": "🗺" },
      { "id": "viewer", "title": "Model viewer (classic)", "icon": "🧊" }
    ],
    "editors": [{ "id": "frame", "title": "Classic page" }],
    "commands": [
      { "id": "open-map", "title": "Open the map editor (classic)" },
      { "id": "open-viewer", "title": "Open the model viewer (classic)" }
    ]
  },
  "activation": ["onTool:map", "onTool:viewer", "onEditor:frame", "onCommand:open-map", "onCommand:open-viewer"]
}
```

- [ ] **Step 2: Create `plugins/classic/web/index.js`:**

```js
// Today's map editor and model viewer inside the workbench, as they are, until sub-project 2 rebuilds them as plugins.
export function activate(api) {
  const open = (title, uri) => api.documents.open({ title, editor: 'frame', uri });
  const pages = { map: ['Map editor', '/map', 'The map editor as it is today: plans, the palette, the 3D view, Apply actions.'], viewer: ['Model viewer', '/viewer', 'The model viewer as it is today: models, pins, reference images, Send to Claude.'] };
  for (const [tool, [title, uri, text]] of Object.entries(pages)) {
    api.tools.register(tool, (el) => {
      const p = document.createElement('p'); p.className = 'nf-muted'; p.textContent = text;
      const b = document.createElement('nf-button'); b.setAttribute('variant', 'primary'); b.textContent = `Open the ${title.toLowerCase()}`; b.addEventListener('click', () => open(title, uri));
      el.append(p, b); open(title, uri);
    });
    api.commands.register(`open-${tool}`, () => open(title, uri));
  }
  api.editors.register('frame', (el, doc) => {
    el.classList.add('frame');
    const f = document.createElement('iframe'); f.src = doc.uri; f.title = doc.title; el.append(f);
  });
}
```

- [ ] **Step 3: The sample plugin's page part.** `examples/plugins/hello/plugin.json` gains `"web": "web/index.js"`, and in `contributes`: `"tools": [{ "id": "hello", "title": "Hello", "icon": "👋" }]`, `"panels": [{ "id": "log", "title": "Hello log", "region": "bottom" }]`, `"statusItems": [{ "id": "greeting", "align": "right" }]`; `activation` gains `"onTool:hello"`, `"onPanel:log"`. Create `examples/plugins/hello/web/index.js`:

```js
// The sample plugin's page part: a tool with a side panel, a bottom panel, a command and a status item.
export function activate(api) {
  api.tools.register('hello', (el) => {
    const out = document.createElement('p'); out.textContent = 'Asking the server…';
    const say = document.createElement('nf-button'); say.textContent = 'Say hello'; say.addEventListener('click', () => api.commands.execute('greet'));
    const count = document.createElement('nf-button'); count.textContent = 'Count to three (a job)';
    count.addEventListener('click', () => api.fetch('/count', { method: 'POST', body: '{}' }).then(() => api.ui.toast('Counting: see Jobs below')).catch((e) => api.ui.toast(e.message, 'error')));
    el.append(out, say, count);
    api.fetch('/greeting').then((g) => { out.textContent = g.text; });
  });
  api.panels.register('log', (el) => {
    const pre = document.createElement('pre'); pre.className = 'nf-log'; pre.textContent = 'Events from the editor appear here.\n'; el.append(pre);
    const sub = api.events.on('*', (name, data) => { pre.textContent += `${name} ${JSON.stringify(data)}\n`; });
    return () => sub.dispose();
  });
  api.commands.register('greet', async () => api.ui.toast((await api.fetch('/greeting')).text));
  api.statusItems.register('greeting', (el) => { el.textContent = '👋 hello'; el.title = 'from the sample plugin'; });
}
```

- [ ] **Step 4:** `npm test` → all pass (the manifests are valid: `node bin/nfgames.mjs plugin list --project examples/sample` shows `nfgames.classic … ok`). **Commit:** "Workbench: the classic tools; the sample plugin's page part".

---

### Task 6: Browser check, docs

- [ ] **Step 1: Browser check** (Playwright MCP) on an editor started on a scratch copy of the sample project, with the hello plugin listed in its `nfgames.json` and trusted (`nfgames plugin trust example.hello`):
  1. `/` loads with no console errors; 🗺 🧊 👋 🧩 ⚙ in the activity bar.
  2. 🗺 opens the classic map editor in a tab (it works inside the frame); 🧊 the viewer.
  3. 👋 shows the greeting from the server; **Say hello** toasts; **Count to three** runs a job that appears in Jobs and toasts when done.
  4. The **Hello log** bottom panel shows live events.
  5. ⌘K lists "Say hello", "Plugins: manage", tools; running "Say hello" from it toasts.
  6. Plugins screen: turn the hello plugin off → its tool, panel, status item and commands disappear without a reload; on again → back.
  7. Settings: change "What to say"; the next greeting uses it.
  8. A deliberately broken plugin (user folder, `activate` throws) is listed as failed with the reason; the rest keeps working.
- [ ] **Step 2: `docs/plugins.md`:** a "The page part" section: the page API table (from Task 4's Produces), the UI kit (`import { h, toast, dialog, confirmDialog } from '/shell/ui.js'` and the `<nf-*>` elements), the workbench regions and rules (from the spec), and the sample's page part.
- [ ] **Step 3: README:** the workbench at `/`, the map editor at `/map`, Workbench in the nav bar; Tests lists `shell-core` and `shell-server`; regions hide but do not resize by dragging yet.
- [ ] **Step 4:** `npm test` → all pass. **Commit:** "Docs: the workbench and the page part of a plugin".

## Self-review

- Spec coverage (1B part): the workbench regions (4), registries and the page API (1, 4), activation events and on-demand loading with disposables (4), ⌘K palette (1, 4), keys (1, 4), toasts and dialogs (3), Problems and Output (4), Settings and Plugins screens (2, 4), the tokens and the component set including `nf-viewport` (3), the shared three.js (3), classic tools (5), the sample plugin (5), docs (6). Not here: services and agent status (plan 1C); resizing regions by dragging (later, said in docs).
- Names match across tasks: `contributionsOf` keys `<plugin>/<id>`; commands `<plugin>/<id>`; `documents.open({ title, editor, uri })` with `editor` `<plugin>/<id>`; server verbs `activate|trust|enable|disable|reload`; `getSettings`/`setSetting`.
