# 1A · Plugin host core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host side of the plugin system: manifests, the places plugins come from, trust, loading on demand with full clean-up, the server plugin API (routes, files, jobs, events, hooks, settings, storage), one live event stream, `nfgames plugin add/install/update/remove` for npm and git, and the host as a library.

**Architecture:** `src/plugins/` holds small single-purpose modules (`semver`, `glob`, `manifest`, `sources`, `trust`, `manager`, `install`); `src/events.mjs` is a dependency-free Server-Sent Events hub; `jobs.mjs` gains `runSteps`; `server.mjs` wires the manager per project and adds routes; `bin/nfgames.mjs` is the CLI; `src/host.mjs` exposes `createHost`.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, no dependencies; `git` for git installs.

**Spec:** `docs/superpowers/specs/2026-11-22-workbench-and-plugins-design.md` (plans 1B shell and 1C agents and services follow).

## Global Constraints

- No npm dependencies; no shell (`spawn`/`execFileSync` with argument lists).
- Plugin ids `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`; plugin API version `1.0.0`; `engines.nfgames` must be satisfied.
- Precedence: project > installed package (named by the project) > user > built-in.
- Trust: built-in and project folder plugins are trusted; user plugins by content hash; packages by id@version; kept in `<stateDir>/plugins-trusted.json`.
- Plugin routes at `/api/p/<id>/<path>` (Host check; POST also Origin and JSON); assets at `/p/<id>/<path>` (inside the plugin folder, no dot segments).
- A failing plugin is turned off alone (state `failed`); everything it registered is undone.
- `createHost({ root, port })` now; mounting under a path prefix (`basePath`) is sub-project 4.

## File map

| File | Responsibility |
|---|---|
| `src/plugins/semver.mjs` | versions and `^ ~ >= *` ranges |
| `src/plugins/glob.mjs` | project-relative globs to RegExps |
| `src/plugins/manifest.mjs` | `checkManifest`, `readManifest`, `API_VERSION` |
| `src/plugins/sources.mjs` | `discoverPlugins`, `readProjectPlugins`, `packageDir`, `PROJECT_FILE` |
| `src/plugins/trust.mjs` | `pluginTrust`, `trustPlugin`, `folderHash` |
| `src/plugins/manager.mjs` | `createPluginManager`: states, activate/deactivate, server API, routes, hooks, assets |
| `src/plugins/install.mjs` | `installNpm`, `installGit`, `pin`, `unpin`, `installMissing` |
| `src/events.mjs` | `createEvents`: SSE hub |
| `src/jobs.mjs` | + `runSteps` |
| `src/server.mjs` | manager per project; routes; check/validate hooks in `preview` |
| `src/host.mjs` | `createHost` |
| `bin/nfgames.mjs` | `nfgames plugin …` |
| `examples/plugins/hello/` | the sample plugin (server part; 1B adds its web part) |
| tests | `plugins-basics`, `plugins-sources`, `plugins-manager`, `plugins-install`, `plugins-server` |

---

### Task 1: semver, globs, manifests

**Files:** Create `src/plugins/semver.mjs`, `src/plugins/glob.mjs`, `src/plugins/manifest.mjs`; test `test/plugins-basics.test.mjs`.

**Produces:** `satisfies(version, range)`, `validVersion(v)`; `globToRegExp(glob)`, `matchesAny(path, globs)`; `API_VERSION`, `ID`, `checkManifest(m) → string[]`, `readManifest(dir) → { manifest, errors, compatible }`.

- [ ] **Step 1: Create `test/plugins-basics.test.mjs`:**

```js
// The plugin system's small parts: versions, globs, and what a plugin.json must say.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { satisfies, validVersion } from '../src/plugins/semver.mjs';
import { globToRegExp, matchesAny } from '../src/plugins/glob.mjs';
import { checkManifest, readManifest } from '../src/plugins/manifest.mjs';

const good = { id: 'studio.terrain-tools', name: 'Terrain tools', version: '1.2.0', engines: { nfgames: '^1.0.0' }, server: 'server.mjs',
  touches: { files: ['maps/**', 'art/*.glb'], commands: ['blender'], network: false },
  contributes: { tools: [{ id: 'terrain', title: 'Terrain' }], commands: [{ id: 'smooth', title: 'Smooth' }], settings: { strength: { type: 'number', default: 1 } } },
  activation: ['onTool:terrain', 'onCommand:smooth', 'onRoute'] };

describe('versions', () => {
  it('ranges', () => {
    assert.ok(validVersion('1.0.0')); assert.ok(!validVersion('one'));
    for (const [v, r, ok] of [['1.4.2', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['0.3.1', '^0.3.0', true], ['0.4.0', '^0.3.0', false], ['1.2.9', '~1.2.0', true], ['1.3.0', '~1.2.0', false], ['1.0.0', '1.0.0', true], ['3.1.0', '>=2.0.0', true], ['1.0.0', '*', true], ['0.9.0', '^1.0.0', false]])
      assert.equal(satisfies(v, r), ok, `${v} ${r}`);
  });
});
describe('globs', () => {
  it('match project-relative paths', () => {
    assert.ok(globToRegExp('models/**').test('models/ships/a.glb'));
    assert.ok(globToRegExp('art/*.glb').test('art/a.glb')); assert.ok(!globToRegExp('art/*.glb').test('art/x/a.glb'));
    assert.ok(globToRegExp('**/*.json').test('a/b/c.json')); assert.ok(globToRegExp('**/*.json').test('c.json'));
    assert.ok(matchesAny('.review/x/job.json', ['models/**', '.review/**'])); assert.ok(!matchesAny('maps/a', ['models/**']));
  });
});
describe('plugin.json', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'nfgames-manifest-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));
  it('a good manifest passes', () => assert.deepEqual(checkManifest(good), []));
  it('says what is wrong', () => {
    const bad = (patch) => checkManifest({ ...good, ...patch }).join(' | ');
    assert.match(bad({ id: 'Terrain' }), /id:/); assert.match(bad({ version: 'v1' }), /version/); assert.match(bad({ engines: {} }), /engines\.nfgames/);
    assert.match(bad({ server: '../evil.mjs' }), /server: a path inside/); assert.match(bad({ contributes: { gadgets: [] } }), /not an extension point/);
    assert.match(bad({ contributes: { tools: [{ id: 'a' }, { id: 'a' }] } }), /two are called "a"/);
    assert.match(bad({ activation: ['whenever'] }), /activation/); assert.match(bad({ touches: { files: ['/etc/**'] } }), /touches\.files/);
  });
  it('reads a folder: incompatible API versions and broken files are reported, never thrown', () => {
    const w = (name, text) => { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, 'plugin.json'), text); return join(dir, name); };
    assert.equal(readManifest(w('ok', JSON.stringify(good))).compatible, true);
    const later = readManifest(w('later', JSON.stringify({ ...good, engines: { nfgames: '^2.0.0' } })));
    assert.deepEqual([later.errors, later.compatible], [[], false]);
    assert.match(readManifest(w('broken', '{ nope')).errors[0], /plugin\.json/);
    assert.deepEqual(readManifest(join(dir, 'missing')).errors, ['no plugin.json']);
  });
});
```

- [ ] **Step 2:** `node --test test/plugins-basics.test.mjs` → FAIL (modules missing).

- [ ] **Step 3: Create `src/plugins/semver.mjs`:**

```js
// Just enough semver for plugin compatibility: versions x.y.z; ranges "^x.y.z", "~x.y.z", "x.y.z", ">=x.y.z", "*".
const parse = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim()); return m ? m.slice(1).map(Number) : null; };
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const validVersion = (v) => !!parse(v);

/** Whether `version` is in `range`. */
export function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;
  const r = String(range ?? '').trim();
  if (r === '*' || r === '') return true;
  if (r.startsWith('>=')) { const b = parse(r.slice(2)); return !!b && cmp(v, b) >= 0; }
  const op = r[0] === '^' || r[0] === '~' ? r[0] : '', b = parse(op ? r.slice(1) : r);
  if (!b || cmp(v, b) < 0) return false;
  if (op === '^') return b[0] > 0 ? v[0] === b[0] : b[1] > 0 ? v[0] === 0 && v[1] === b[1] : cmp(v, b) === 0;
  if (op === '~') return v[0] === b[0] && v[1] === b[1];
  return cmp(v, b) === 0;
}
```

- [ ] **Step 4: Create `src/plugins/glob.mjs`:**

```js
// Project-relative globs ("models/**", ".review/**", "art/*.glb", "**/*.json") as RegExps over '/'-separated paths.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { const slash = glob[i + 2] === '/'; re += slash ? '(?:.*/)?' : '.*'; i += slash ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));
```

- [ ] **Step 5: Create `src/plugins/manifest.mjs`:**

```js
// A plugin's plugin.json: who it is, which plugin API it needs, what it touches, what it adds, and when its code loads.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { satisfies, validVersion } from './semver.mjs';

export const API_VERSION = '1.0.0';
export const ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;               // reverse-domain style: "nfgames.model-review"
const LOCAL = /^[a-z][a-zA-Z0-9-]*$/;                                       // a contribution's own id
export const POINTS = ['tools', 'editors', 'panels', 'inspectors', 'commands', 'statusItems', 'workflows', 'services'];
const EVENT = /^(onStartup|onProject|onRoute|on(Tool|Editor|Command|Panel|Inspector|Service):[a-zA-Z][a-zA-Z0-9-]*)$/;
const inside = (p) => typeof p === 'string' && p !== '' && !isAbsolute(p) && !normalize(p).startsWith('..');

/** What is wrong with a manifest object (empty when nothing is). */
export function checkManifest(m) {
  const errors = [], say = (t) => errors.push(t);
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['plugin.json is not an object'];
  if (typeof m.id !== 'string' || !ID.test(m.id)) say('id: lower case, reverse-domain style, e.g. "studio.terrain-tools"');
  if (typeof m.name !== 'string' || !m.name.trim()) say('name: a name to show');
  if (!validVersion(m.version)) say('version: x.y.z');
  if (!m.engines || typeof m.engines.nfgames !== 'string') say('engines.nfgames: the plugin API version it needs, e.g. "^1.0.0"');
  for (const k of ['server', 'web']) if (m[k] !== undefined && !inside(m[k])) say(`${k}: a path inside the plugin's folder`);
  const t = m.touches || {};
  if (t.files !== undefined && (!Array.isArray(t.files) || !t.files.every((g) => inside(String(g).replace(/\*/g, 'x'))))) say('touches.files: project-relative globs');
  if (t.commands !== undefined && (!Array.isArray(t.commands) || !t.commands.every((c) => typeof c === 'string'))) say('touches.commands: a list of program names');
  if (t.network !== undefined && typeof t.network !== 'boolean') say('touches.network: true or false');
  for (const [point, list] of Object.entries(m.contributes || {})) {
    if (point === 'settings') { if (!list || typeof list !== 'object' || Array.isArray(list)) say('contributes.settings: { name: { type, default, title } }'); continue; }
    if (!POINTS.includes(point)) { say(`contributes.${point}: not an extension point (${[...POINTS, 'settings'].join(', ')})`); continue; }
    if (!Array.isArray(list)) { say(`contributes.${point}: a list`); continue; }
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || !LOCAL.test(item.id)) { say(`contributes.${point}: every entry needs a plain id`); continue; }
      if (seen.has(item.id)) say(`contributes.${point}: two are called "${item.id}"`);
      seen.add(item.id);
    }
  }
  if (m.activation !== undefined && (!Array.isArray(m.activation) || !m.activation.every((e) => typeof e === 'string' && EVENT.test(e)))) say('activation: events such as "onStartup", "onProject", "onRoute", "onTool:<id>", "onCommand:<id>"');
  return errors;
}

/** Reads <dir>/plugin.json: { manifest, errors, compatible }. Never throws. */
export function readManifest(dir, apiVersion = API_VERSION) {
  const file = join(dir, 'plugin.json');
  if (!existsSync(file)) return { manifest: null, errors: ['no plugin.json'], compatible: false };
  let m;
  try { m = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { manifest: null, errors: [`plugin.json: ${e.message}`], compatible: false }; }
  const errors = checkManifest(m);
  return { manifest: m, errors, compatible: !errors.length && satisfies(apiVersion, m.engines.nfgames) };
}
```

- [ ] **Step 6:** `node --test test/plugins-basics.test.mjs` → pass. **Commit:** "Plugins: versions, globs and plugin.json checks".

---

### Task 2: Sources and trust

**Files:** Create `src/plugins/sources.mjs`, `src/plugins/trust.mjs`; test `test/plugins-sources.test.mjs`.

**Produces:** `PROJECT_FILE = 'nfgames.json'`; `readProjectPlugins(root)`; `packageDir(packagesDir, id, spec)`; `discoverPlugins({ builtinDir, userDir, packagesDir, root }) → entry[]` (`{ id, dir, source, manifest, errors, compatible, spec?, missing? }`); `folderHash(dir)`, `pluginTrust(stateDir, entry) → 'trusted'|'ask'`, `trustPlugin(stateDir, entry)`.

- [ ] **Step 1: Add the fixture helper to `test/helpers.mjs`:**

```js
/** Writes a plugin folder: plugin.json from `manifest` (id, name, version and engines filled in), plus { relPath: text } files. */
export function writePlugin(dir, manifest, files = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: manifest.id, version: '1.0.0', engines: { nfgames: '^1.0.0' }, ...manifest }, null, 2));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
  return dir;
}
```

(`test/helpers.mjs` imports gain `mkdirSync, writeFileSync` from `node:fs`; `dirname` is already imported.)

- [ ] **Step 2: Create `test/plugins-sources.test.mjs`:**

```js
// Where plugins come from, which one wins, and which are trusted.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPlugins, packageDir } from '../src/plugins/sources.mjs';
import { pluginTrust, trustPlugin } from '../src/plugins/trust.mjs';
import { writePlugin } from './helpers.mjs';

describe('plugin sources', () => {
  let top, dirs, root, state;
  before(() => {
    top = mkdtempSync(join(tmpdir(), 'nfgames-sources-'));
    dirs = { builtinDir: join(top, 'builtin'), userDir: join(top, 'user'), packagesDir: join(top, 'packages') }; root = join(top, 'game'); state = join(top, 'state');
    writePlugin(join(dirs.builtinDir, 'viewer'), { id: 'nfgames.viewer' });
    writePlugin(join(dirs.builtinDir, 'shared'), { id: 'acme.shared', version: '1.0.0' });
    writePlugin(join(dirs.userDir, 'shared'), { id: 'acme.shared', version: '1.1.0' });
    writePlugin(join(dirs.userDir, 'mine'), { id: 'jacek.mine' });
    writePlugin(join(root, 'tools', 'bake'), { id: 'thoon.bake' });
    writePlugin(join(root, 'tools', 'liar'), { id: 'thoon.other-name' });
    writePlugin(packageDir(dirs.packagesDir, 'acme.terrain', { npm: '@acme/terrain@2.1.0' }), { id: 'acme.terrain', version: '2.1.0' });
    writeFileSync(join(root, 'nfgames.json'), JSON.stringify({ plugins: {
      'nfgames.viewer': 'builtin', 'thoon.bake': './tools/bake', 'thoon.liar': './tools/liar', 'thoon.escape': '../outside',
      'acme.terrain': { npm: '@acme/terrain@2.1.0', integrity: 'sha512-x' }, 'acme.missing': { git: 'https://example.com/x.git', commit: 'abcdef1234567890' },
    } }));
  });
  after(() => rmSync(top, { recursive: true, force: true }));

  it('finds built-in, user, project and installed plugins; the project\'s and user\'s win', () => {
    const found = Object.fromEntries(discoverPlugins({ ...dirs, root }).map((p) => [p.id, p]));
    assert.equal(found['nfgames.viewer'].source, 'builtin');
    assert.equal(found['acme.shared'].source, 'user'); assert.equal(found['acme.shared'].manifest.version, '1.1.0');
    assert.equal(found['jacek.mine'].source, 'user');
    assert.equal(found['thoon.bake'].source, 'project'); assert.deepEqual(found['thoon.bake'].errors, []);
    assert.match(found['thoon.liar'].errors.join(), /its plugin\.json says "thoon\.other-name"/);
    assert.match(found['thoon.escape'].errors.join(), /inside the project/);
    assert.equal(found['acme.terrain'].source, 'package'); assert.equal(found['acme.terrain'].spec.npm, '@acme/terrain@2.1.0');
    assert.equal(found['acme.missing'].missing, true); assert.match(found['acme.missing'].errors.join(), /not installed yet/);
  });
  it('a project with no nfgames.json, or a broken one', () => {
    const empty = join(top, 'empty'); mkdirSync(empty);
    assert.ok(discoverPlugins({ ...dirs, root: empty }).some((p) => p.id === 'nfgames.viewer'));
    writeFileSync(join(empty, 'nfgames.json'), '{ broken');
    assert.match(discoverPlugins({ ...dirs, root: empty }).find((p) => p.id === '(nfgames.json)').errors[0], /nfgames\.json/);
  });
  it('trust: built-in and project plugins are trusted; a user plugin is asked about again when its files change', () => {
    const found = Object.fromEntries(discoverPlugins({ ...dirs, root }).map((p) => [p.id, p]));
    assert.equal(pluginTrust(state, found['nfgames.viewer']), 'trusted');
    assert.equal(pluginTrust(state, found['thoon.bake']), 'trusted');
    assert.equal(pluginTrust(state, found['jacek.mine']), 'ask');
    trustPlugin(state, found['jacek.mine']); assert.equal(pluginTrust(state, found['jacek.mine']), 'trusted');
    writeFileSync(join(dirs.userDir, 'mine', 'server.mjs'), 'export function activate() {}\n');
    assert.equal(pluginTrust(state, found['jacek.mine']), 'ask');
    assert.equal(pluginTrust(state, found['acme.terrain']), 'ask');
    trustPlugin(state, found['acme.terrain']); assert.equal(pluginTrust(state, found['acme.terrain']), 'trusted');
  });
});
```

- [ ] **Step 3:** `node --test test/plugins-sources.test.mjs` → FAIL.

- [ ] **Step 4: Create `src/plugins/sources.mjs`:**

```js
// Where plugins come from: built in (<editor>/plugins), the user's (~/.nfgames-editor/plugins), and the project's
// nfgames.json, which names its own folders, built-ins, and npm / git packages installed in the shared cache. The same
// id in several places: the project's (or a package it names) wins, then the user's, then the built-in.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readManifest } from './manifest.mjs';

export const PROJECT_FILE = 'nfgames.json';
const RANK = { builtin: 0, user: 1, package: 2, project: 2 };

/** The `plugins` of the project's nfgames.json ({} when there is none). Throws when the file is not JSON. */
export function readProjectPlugins(root) {
  const file = join(root, PROJECT_FILE);
  if (!existsSync(file)) return {};
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return j && j.plugins && typeof j.plugins === 'object' && !Array.isArray(j.plugins) ? j.plugins : {};
}

/** An installed package's folder in the shared cache: <packagesDir>/<id>@<version, or the commit's first 12>. */
export const packageDir = (packagesDir, id, spec) => join(packagesDir, `${id}@${spec.npm ? spec.npm.slice(spec.npm.lastIndexOf('@') + 1) : String(spec.commit).slice(0, 12)}`);

const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(dir, e.name)) : []);
const broken = (id, dir, source, error, extra = {}) => ({ id, dir, source, manifest: null, errors: [error], compatible: false, ...extra });

/** Every plugin the editor sees for a project, one per id: [{ id, dir, source, manifest, errors, compatible, spec?, missing? }]. */
export function discoverPlugins({ builtinDir, userDir, packagesDir, root }) {
  const found = new Map();
  const add = (dir, source, expectId = null, extra = {}) => {
    const r = readManifest(dir), id = expectId || (r.manifest && r.manifest.id) || dir;
    const entry = { id, dir, source, ...r, ...extra };
    if (expectId && r.manifest && r.manifest.id !== expectId) entry.errors = [...entry.errors, `nfgames.json calls it "${expectId}" but its plugin.json says "${r.manifest.id}"`];
    const had = found.get(id);
    if (!had || RANK[source] >= RANK[had.source]) found.set(id, entry);
  };
  for (const d of subdirs(builtinDir)) add(d, 'builtin');
  for (const d of subdirs(userDir)) add(d, 'user');
  let listed = {};
  try { listed = root ? readProjectPlugins(root) : {}; } catch (e) { found.set('(nfgames.json)', broken('(nfgames.json)', root, 'project', `nfgames.json: ${e.message}`)); }
  for (const [id, spec] of Object.entries(listed)) {
    if (spec === 'builtin') { if (found.get(id)?.source !== 'builtin') found.set(id, broken(id, null, 'builtin', 'nfgames.json asks for a built-in plugin this editor does not have', { missing: true })); continue; }
    if (typeof spec === 'string') {
      const dir = resolve(root, spec), r = relative(root, dir);
      if (r.startsWith('..') || isAbsolute(r)) { found.set(id, broken(id, dir, 'project', 'a project plugin folder must be inside the project')); continue; }
      add(dir, 'project', id); continue;
    }
    if (spec && (spec.npm || spec.git)) {
      const dir = packageDir(packagesDir, id, spec);
      if (!existsSync(dir)) { found.set(id, broken(id, dir, 'package', 'not installed yet: run `nfgames plugin install`', { spec, missing: true })); continue; }
      add(dir, 'package', id, { spec }); continue;
    }
    found.set(id, broken(id, null, 'project', 'nfgames.json: a plugin is "builtin", a folder, { npm, integrity } or { git, commit }'));
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 5: Create `src/plugins/trust.mjs`:**

```js
// Plugin trust. Built-in plugins, and a project's own folder plugins (the project is already trusted), are trusted.
// A user's plugin is asked about once, and again when its files change (a hash of its folder); an installed package
// once per id and version (its bytes are pinned by nfgames.json). Kept in <stateDir>/plugins-trusted.json.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** SHA-256 over a folder's files (names and bytes; hidden files and node_modules left out). */
export function folderHash(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { h.update(relative(dir, f)); h.update('\0'); h.update(readFileSync(f)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

const fileOf = (stateDir) => join(stateDir, 'plugins-trusted.json');
const read = (stateDir) => { try { return JSON.parse(readFileSync(fileOf(stateDir), 'utf8')); } catch { return {}; } };
const keyOf = (p) => `${p.id}@${p.manifest.version}`;
const stamp = (p) => (p.source === 'user' ? folderHash(p.dir) : 'package');

/** 'trusted' or 'ask'. */
export function pluginTrust(stateDir, p) {
  if (p.source === 'builtin' || p.source === 'project') return 'trusted';
  return read(stateDir)[keyOf(p)] === stamp(p) ? 'trusted' : 'ask';
}
/** Remembers the user's yes for this plugin as it is now. */
export function trustPlugin(stateDir, p) {
  const all = read(stateDir);
  all[keyOf(p)] = stamp(p);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(fileOf(stateDir), `${JSON.stringify(all, null, 2)}\n`);
}
```

- [ ] **Step 6:** `node --test test/plugins-sources.test.mjs` → pass. **Commit:** "Plugins: where they come from, which wins, trust".

---

### Task 3: The event stream and plugin jobs

**Files:** Create `src/events.mjs`; modify `src/jobs.mjs` (add `runSteps`); tests in `test/plugins-manager.test.mjs` (Task 4 uses both) and a direct test here: `test/events-jobs.test.mjs`.

**Produces:** `createEvents({ keep }) → { emit(name, data), handle(req, res), close(), clients }`; `jobs.runSteps({ kind, label, steps }, { onDone }) → { job, done: Promise<job> }` where a step is `{ label, run(log) }` or `{ label, command: [program, ...args], cwd? }`.

- [ ] **Step 1: Create `test/events-jobs.test.mjs`:**

```js
// The live event stream (Server-Sent Events) and jobs made of plugin steps.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEvents } from '../src/events.mjs';
import { createJobs } from '../src/jobs.mjs';

describe('events', () => {
  it('streams events, and replays the ones after Last-Event-ID', async () => {
    const events = createEvents(), server = createServer((req, res) => events.handle(req, res));
    await new Promise((d) => server.listen(0, '127.0.0.1', d));
    events.emit('jobs/done', { id: 1 });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { 'Last-Event-ID': '0' } });
    const reader = res.body.getReader(); let text = '';
    events.emit('plugins/changed', { id: 'a.b' });
    while (!/plugins\/changed/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /id: 1\nevent: jobs\/done\ndata: \{"id":1\}/); assert.match(text, /event: plugins\/changed/);
    await reader.cancel(); events.close(); await new Promise((d) => server.close(d));
  });
});

describe('plugin jobs', () => {
  it('runs function and command steps in order, and stops at a failing one', async () => {
    const jobs = createJobs({ root: process.cwd(), actions: {}, ctx: {} });
    const ok = jobs.runSteps({ kind: 'a.b', label: 'Two steps', steps: [{ label: 'say', run: (log) => log('hello\n') }, { label: 'node', command: [process.execPath, '-e', 'console.log("from node")'] }] });
    assert.equal(ok.job.state, 'running');
    assert.throws(() => jobs.runSteps({ kind: 'x', label: 'busy', steps: [] }), /busy/);
    const done = await ok.done;
    assert.equal(done.state, 'done'); assert.match(done.log, /hello/); assert.match(done.log, /from node/);
    const bad = await jobs.runSteps({ kind: 'a.b', label: 'Bad', steps: [{ label: 'boom', run: () => { throw new Error('nope'); } }, { label: 'never', run: () => {} }] }).done;
    assert.equal(bad.state, 'failed'); assert.match(bad.log, /stopped at "boom": nope/); assert.doesNotMatch(bad.log, /== never/);
  });
});
```

- [ ] **Step 2:** `node --test test/events-jobs.test.mjs` → FAIL.

- [ ] **Step 3: Create `src/events.mjs`:**

```js
// One live stream from the host to the page (Server-Sent Events): jobs, plugin state, reviews. No dependencies.
// A page that reconnects sends Last-Event-ID and gets the events it missed (the last `keep`).
export function createEvents({ keep = 200 } = {}) {
  const clients = new Set(), recent = [];
  let id = 0;
  const frame = (ev) => `id: ${ev.id}\nevent: ${ev.name}\ndata: ${JSON.stringify(ev.data)}\n\n`;
  function emit(name, data = {}) {
    const ev = { id: ++id, name, data };
    recent.push(ev); if (recent.length > keep) recent.shift();
    const text = frame(ev);
    for (const res of clients) res.write(text);
    return ev;
  }
  function handle(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    const last = Number(req.headers['last-event-id']) || 0;
    for (const ev of recent) if (ev.id > last) res.write(frame(ev));
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }
  function close() { for (const res of clients) res.end(); clients.clear(); }
  return { emit, handle, close, get clients() { return clients.size; } };
}
```

- [ ] **Step 4: Add `runSteps` to `src/jobs.mjs`** (before `return { current, start };`, and return it too):

```js
  /** Runs a plugin's steps as the one job: each step { label, run(log) } or { label, command: [program, ...args], cwd }. */
  function runSteps({ kind, label, steps }, { onDone = () => {} } = {}) {
    if (job && job.state === 'running') throw Object.assign(new Error(`busy: ${job.kind} is running`), { code: 409 });
    const mine = job = { id: ++count, kind, label, map: null, state: 'running', step: 0, steps: steps.map((s) => s.label), startedAt: Date.now(), endedAt: null, log: '', dryRun: false };
    const add = (text) => { mine.log += text; if (mine.log.length > MAX_LOG) mine.log = mine.log.slice(-KEEP_LOG); };
    const end = (state, text) => { mine.state = state; mine.endedAt = Date.now(); add(text); try { onDone(mine); } catch { /* a listener's problem */ } return mine; };
    const command = (s) => new Promise((ok, no) => {
      const [file, ...args] = s.command;
      const child = spawn(file, args, { cwd: s.cwd || project.root, shell: false, windowsHide: true });
      child.stdout.on('data', (d) => add(String(d))); child.stderr.on('data', (d) => add(String(d)));
      child.on('error', no); child.on('close', (code) => (code === 0 ? ok() : no(new Error(`exit ${code}`))));
    });
    const done = (async () => {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]; mine.step = i; add(`\n== ${s.label}\n`);
        try {
          if (typeof s.run === 'function') await s.run((t) => add(String(t)));
          else if (Array.isArray(s.command) && s.command.length && s.command.every((x) => typeof x === 'string')) await command(s);
          else throw new Error('a step is { label, run } or { label, command: [program, ...args] }');
        } catch (e) { return end('failed', `\n== ${label} stopped at "${s.label}": ${e.message}\n`); }
      }
      return end('done', `\n== ${label}: done in ${((Date.now() - mine.startedAt) / 1000).toFixed(1)} s\n`);
    })();
    return { job: mine, done };
  }
  return { current, start, runSteps };
```

(and delete the old `return { current, start };`).

- [ ] **Step 5:** `node --test test/events-jobs.test.mjs` → pass; `npm test` → all pass. **Commit:** "Host: a live event stream; jobs made of plugin steps".

---

### Task 4: The plugin manager

**Files:** Create `src/plugins/manager.mjs`; test `test/plugins-manager.test.mjs`.

**Consumes:** Tasks 1–3. **Produces:** `createPluginManager({ builtinDir, userDir, packagesDir, stateDir, project, jobs, events, log }) → { refresh, list, activate, deactivate, fire, route, runHook, setEnabled, trust, reload, close, asset, plugins }`. States: `invalid`, `incompatible`, `off`, `needs-trust`, `failed`, `ready`, `active`. The server API given to `activate(api)`: `id, dir, version, project, files{read,write,exists,list}, jobs{run}, routes{get,post}, events{emit}, hooks{on}, settings{get,set}, storage, log, onDispose`.

- [ ] **Step 1: Create `test/plugins-manager.test.mjs`:**

```js
// The plugin manager: on-demand activation, the server API, everything undone on unload, failures isolated.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginManager } from '../src/plugins/manager.mjs';
import { createJobs } from '../src/jobs.mjs';
import { createEvents } from '../src/events.mjs';
import { writePlugin } from './helpers.mjs';

const SERVER = `
export function activate(api) {
  globalThis.__calls = (globalThis.__calls || 0) + 1;
  api.routes.get('/hello', ({ query }) => ({ hello: query.name || 'world', setting: api.settings.get('greeting') }));
  api.routes.post('/save', ({ body }) => { api.files.write('models/notes.txt', body.text); return { ok: true }; });
  api.routes.get('/escape', () => api.files.read('maps/secret.json'));
  api.routes.get('/crash', () => { throw new Error('kaboom'); });
  api.hooks.on('check', ({ name }) => [{ kind: 'hello', text: 'checked ' + name }]);
  api.onDispose(() => { globalThis.__disposed = (globalThis.__disposed || 0) + 1; });
}`;

describe('the plugin manager', () => {
  let top, root, dirs, state, mgr, events;
  const log = [];
  before(() => {
    top = mkdtempSync(join(tmpdir(), 'nfgames-mgr-')); root = join(top, 'game'); state = join(top, 'state');
    dirs = { builtinDir: join(top, 'builtin'), userDir: join(top, 'user'), packagesDir: join(top, 'packages') };
    mkdirSync(join(root, 'maps'), { recursive: true }); writeFileSync(join(root, 'maps', 'secret.json'), '{}');
    writePlugin(join(dirs.builtinDir, 'hello'), { id: 'nfgames.hello', server: 'server.mjs', touches: { files: ['models/**'] }, activation: ['onRoute', 'onCommand:greet'],
      contributes: { commands: [{ id: 'greet', title: 'Greet' }], settings: { greeting: { type: 'string', default: 'hi' } } } }, { 'server.mjs': SERVER, 'web/app.js': 'export {}', '.secret': 'x' });
    writePlugin(join(dirs.builtinDir, 'broken'), { id: 'nfgames.broken', server: 'server.mjs', activation: ['onStartup'] }, { 'server.mjs': 'export function activate() { throw new Error("cannot start"); }' });
    writePlugin(join(dirs.userDir, 'stranger'), { id: 'someone.stranger', server: 'server.mjs', activation: ['onStartup'] }, { 'server.mjs': 'export function activate() { globalThis.__stranger = true; }' });
    writePlugin(join(dirs.builtinDir, 'future'), { id: 'nfgames.future', engines: { nfgames: '^9.0.0' } });
    events = createEvents();
    mgr = createPluginManager({ ...dirs, stateDir: state, project: { root, options: {} }, jobs: createJobs({ root, actions: {}, ctx: {} }), events, log: (...a) => log.push(a.join(' ')) });
  });
  after(async () => { await mgr.close(); events.close(); rmSync(top, { recursive: true, force: true }); });

  const state_ = (id) => mgr.list().find((p) => p.id === id).state;

  it('lists plugins with their state; nothing runs until an activation event', () => {
    assert.equal(state_('nfgames.hello'), 'ready'); assert.equal(state_('nfgames.future'), 'incompatible'); assert.equal(state_('someone.stranger'), 'needs-trust');
    assert.equal(globalThis.__calls, undefined);
  });
  it('onStartup activates what is trusted; a plugin that throws is turned off alone; an untrusted one waits', async () => {
    await mgr.fire('onStartup');
    assert.equal(state_('nfgames.broken'), 'failed'); assert.match(mgr.list().find((p) => p.id === 'nfgames.broken').failure, /cannot start/);
    assert.equal(globalThis.__stranger, undefined);
    mgr.trust('someone.stranger'); await mgr.fire('onStartup'); assert.equal(globalThis.__stranger, true);
  });
  it('a route activates its plugin and answers; settings have their defaults', async () => {
    const r = await mgr.route('nfgames.hello', 'GET', 'hello', { url: '/api/p/nfgames.hello/hello?name=Khairos' }, null, null);
    assert.deepEqual(r, { status: 200, body: { hello: 'Khairos', setting: 'hi' } });
    assert.equal(globalThis.__calls, 1); assert.equal(state_('nfgames.hello'), 'active');
    assert.equal((await mgr.route('nfgames.hello', 'GET', 'nope', { url: '/x' }, null, null)).status, 404);
  });
  it('files: only what touches.files declares', async () => {
    assert.equal((await mgr.route('nfgames.hello', 'POST', 'save', { url: '/x' }, null, async () => ({ text: 'ok' }))).status, 200);
    assert.equal(readFileSync(join(root, 'models', 'notes.txt'), 'utf8'), 'ok');
    const r = await mgr.route('nfgames.hello', 'GET', 'escape', { url: '/x' }, null, null);
    assert.equal(r.status, 500); assert.match(r.body.error, /did not declare maps\/secret\.json/);
  });
  it('hooks run across active plugins', async () => {
    await mgr.reload('nfgames.hello');
    assert.deepEqual((await mgr.runHook('check', { name: 'plaza' })).flat(), [{ kind: 'hello', text: 'checked plaza' }]);
  });
  it('a crashing route turns its plugin off and undoes what it registered', async () => {
    const before = globalThis.__disposed || 0;
    const r = await mgr.route('nfgames.hello', 'GET', 'crash', { url: '/x' }, null, null);
    assert.equal(r.status, 500); assert.equal(state_('nfgames.hello'), 'failed'); assert.equal(globalThis.__disposed, before + 1);
    assert.deepEqual(await mgr.runHook('check', { name: 'plaza' }), []);
    await mgr.reload('nfgames.hello'); assert.equal(state_('nfgames.hello'), 'active');
  });
  it('turning a plugin off unloads it, and it stays off', async () => {
    await mgr.setEnabled('nfgames.hello', false); assert.equal(state_('nfgames.hello'), 'off');
    assert.equal((await mgr.route('nfgames.hello', 'GET', 'hello', { url: '/x' }, null, null)).status, 404);
    await mgr.setEnabled('nfgames.hello', true); assert.equal(state_('nfgames.hello'), 'ready');
  });
  it('assets: files of its own folder only, no hidden files, no way out', () => {
    assert.equal(mgr.asset('nfgames.hello', 'web/app.js'), join(dirs.builtinDir, 'hello', 'web', 'app.js'));
    for (const bad of ['../broken/server.mjs', '.secret', 'web/missing.js', '']) assert.equal(mgr.asset('nfgames.hello', bad), null, bad);
    assert.equal(mgr.asset('nfgames.future', 'plugin.json'), null);
  });
  it('a private storage folder per plugin', async () => {
    await mgr.activate('nfgames.hello');
    assert.ok(existsSync(join(state, 'storage', 'nfgames.hello')));
  });
});
```

- [ ] **Step 2:** `node --test test/plugins-manager.test.mjs` → FAIL.

- [ ] **Step 3: Create `src/plugins/manager.mjs`:**

```js
// The plugin manager: the open project's plugins, which are trusted and on, and their server parts, loaded on demand
// (an activation event) and undone completely when unloaded. A plugin that fails is turned off alone; the rest go on.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverPlugins } from './sources.mjs';
import { pluginTrust, trustPlugin } from './trust.mjs';
import { matchesAny } from './glob.mjs';

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); };

export function createPluginManager({ builtinDir, userDir, packagesDir, stateDir, project, jobs, events, log = () => {} }) {
  let plugins = [];
  const live = new Map(), failures = new Map();
  const disabledFile = join(stateDir, 'plugins-disabled.json'), settingsFile = join(stateDir, 'plugin-settings.json');
  const disabled = () => new Set(readJson(disabledFile, []));

  function refresh() { plugins = discoverPlugins({ builtinDir, userDir, packagesDir, root: project.root }); return plugins; }
  const find = (id) => plugins.find((p) => p.id === id);
  function stateOf(p) {
    if (p.errors.length) return 'invalid';
    if (!p.compatible) return 'incompatible';
    if (disabled().has(p.id)) return 'off';
    if (pluginTrust(stateDir, p) === 'ask') return 'needs-trust';
    if (failures.has(p.id)) return 'failed';
    return live.has(p.id) ? 'active' : 'ready';
  }
  const usable = (p) => !!p && ['ready', 'active'].includes(stateOf(p));

  /** What the page shows about every plugin (no code). */
  function list() {
    return plugins.map((p) => ({
      id: p.id, source: p.source, state: stateOf(p), name: p.manifest?.name || p.id, version: p.manifest?.version || null, needs: p.manifest?.engines?.nfgames || null,
      errors: p.errors, failure: failures.get(p.id) || null, touches: p.manifest?.touches || {}, contributes: p.manifest?.contributes || {},
      activation: p.manifest?.activation || [], web: p.manifest?.web || null,
    }));
  }

  function makeApi(p, rec) {
    const own = (fn) => { rec.disposers.push(fn); return { dispose: fn }; };
    const globs = p.manifest.touches?.files || [], programs = p.manifest.touches?.commands || [];
    const inProject = (rel) => {
      const abs = resolve(project.root, String(rel)), r = relative(project.root, abs);
      if (!r || r.startsWith('..') || isAbsolute(r)) throw new Error(`${p.id}: ${rel} is outside the project`);
      const path = r.split(sep).join('/');
      if (!matchesAny(path, globs)) throw new Error(`${p.id} did not declare ${path} in touches.files`);
      return abs;
    };
    const defaults = Object.fromEntries(Object.entries(p.manifest.contributes?.settings || {}).map(([k, v]) => [k, v && v.default]));
    const mine = () => readJson(settingsFile, {})[p.id] || {};
    const storage = join(stateDir, 'storage', p.id);
    mkdirSync(storage, { recursive: true });
    return {
      id: p.id, dir: p.dir, version: p.manifest.version,
      project: { root: project.root, name: basename(project.root), options: project.options || {} },
      files: {
        read: (rel, encoding = 'utf8') => readFileSync(inProject(rel), encoding),
        write: (rel, data) => { const f = inProject(rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); },
        exists: (rel) => existsSync(inProject(rel)),
        list: (rel) => readdirSync(inProject(rel)),
      },
      jobs: {
        run: (label, steps) => {
          for (const s of steps) if (Array.isArray(s.command) && !programs.includes(basename(s.command[0]))) throw new Error(`${p.id} did not declare ${basename(s.command[0])} in touches.commands`);
          const run = jobs.runSteps({ kind: p.id, label, steps }, { onDone: (j) => events.emit('jobs/done', { id: j.id, kind: j.kind, label: j.label, state: j.state }) });
          events.emit('jobs/started', { id: run.job.id, kind: p.id, label });
          return run;
        },
      },
      routes: {
        get: (path, fn) => { rec.routes.set(`GET ${path}`, fn); return own(() => rec.routes.delete(`GET ${path}`)); },
        post: (path, fn) => { rec.routes.set(`POST ${path}`, fn); return own(() => rec.routes.delete(`POST ${path}`)); },
      },
      events: { emit: (name, data) => events.emit(`${p.id}/${name}`, data) },
      hooks: { on: (name, fn) => { rec.hooks.set(name, [...(rec.hooks.get(name) || []), fn]); return own(() => rec.hooks.set(name, (rec.hooks.get(name) || []).filter((f) => f !== fn))); } },
      settings: {
        get: (k) => (k in mine() ? mine()[k] : defaults[k]),
        set: (k, v) => { const all = readJson(settingsFile, {}); all[p.id] = { ...(all[p.id] || {}), [k]: v }; writeJson(settingsFile, all); },
      },
      storage,
      log: (...a) => log(`[${p.id}]`, ...a),
      onDispose: (fn) => own(fn),
    };
  }

  function undo(rec, id) { for (const d of rec.disposers.splice(0).reverse()) { try { d(); } catch (e) { log(`[${id}] clean-up: ${e.message}`); } } }
  function fail(id, message) {
    failures.set(id, message); log(`[${id}] ${message}`);
    const rec = live.get(id);
    if (rec) { live.delete(id); undo(rec, id); }
    events.emit('plugins/failed', { id, message });
  }
  async function activate(id) {
    const p = find(id);
    if (!usable(p)) throw Object.assign(new Error(`${id} cannot be activated (${p ? stateOf(p) : 'unknown'})`), { code: 409 });
    if (live.has(id)) return live.get(id);
    const rec = { disposers: [], routes: new Map(), hooks: new Map(), deactivate: null };
    live.set(id, rec);
    if (p.manifest.server) {
      try {
        const file = join(p.dir, p.manifest.server);
        const mod = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
        rec.api = makeApi(p, rec);
        if (typeof mod.activate === 'function') await mod.activate(rec.api);
        rec.deactivate = typeof mod.deactivate === 'function' ? mod.deactivate : null;
      } catch (e) { fail(id, `activate failed: ${e.message}`); throw e; }
    }
    events.emit('plugins/changed', { id, state: 'active' });
    return rec;
  }
  async function deactivate(id) {
    const rec = live.get(id);
    if (!rec) return;
    live.delete(id);
    try { await rec.deactivate?.(); } catch (e) { log(`[${id}] deactivate: ${e.message}`); }
    undo(rec, id);
    events.emit('plugins/changed', { id, state: find(id) ? stateOf(find(id)) : 'gone' });
  }
  /** Activates every usable plugin that lists one of these activation events. */
  async function fire(...names) {
    for (const p of plugins) if (usable(p) && !live.has(p.id) && (p.manifest.activation || []).some((e) => names.includes(e))) { try { await activate(p.id); } catch { /* recorded as failed */ } }
  }
  /** /api/p/<id>/<rest>: activates the plugin if needed ("onRoute") and calls its handler with { query, body }. */
  async function route(id, method, rest, req, res, body) {
    const p = find(id);
    if (!usable(p)) return { status: 404, body: { error: 'no such plugin, or it is not on' } };
    try { await activate(id); } catch (e) { return { status: 500, body: { error: e.message } }; }
    const fn = live.get(id)?.routes.get(`${method} /${rest}`);
    if (!fn) return { status: 404, body: { error: 'not here' } };
    const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams), payload = method === 'POST' ? await body() : undefined;
    try { return { status: 200, body: (await fn({ query, body: payload })) ?? {} }; }
    catch (e) { if (/did not declare|outside the project/.test(e.message)) return { status: 500, body: { error: e.message } }; fail(id, `route /${rest} failed: ${e.message}`); return { status: 500, body: { error: `${id} failed: ${e.message}` } }; }
  }
  /** Runs a hook in every active plugin: their results, in order. A hook that throws turns its plugin off. */
  async function runHook(name, payload) {
    const out = [];
    for (const [id, rec] of [...live]) for (const fn of rec.hooks.get(name) || []) { try { out.push(await fn(payload)); } catch (e) { fail(id, `hook ${name} failed: ${e.message}`); } }
    return out;
  }
  async function setEnabled(id, on) {
    const d = disabled();
    if (on) d.delete(id); else d.add(id);
    writeJson(disabledFile, [...d]); failures.delete(id);
    if (!on) await deactivate(id);
    events.emit('plugins/changed', { id, state: find(id) ? stateOf(find(id)) : 'gone' });
  }
  function trust(id) { const p = find(id); if (!p || !p.manifest) throw Object.assign(new Error('no such plugin'), { code: 404 }); trustPlugin(stateDir, p); failures.delete(id); events.emit('plugins/changed', { id, state: stateOf(p) }); }
  async function reload(id) { await deactivate(id); failures.delete(id); refresh(); return activate(id); }
  async function close() { for (const id of [...live.keys()]) await deactivate(id); }
  /** The file for /p/<id>/<rest>: inside the plugin's own folder, no hidden parts, only for a usable plugin. */
  function asset(id, rest) {
    const p = find(id);
    if (!usable(p) || !p.dir || !rest) return null;
    const f = resolve(p.dir, rest), r = relative(p.dir, f);
    if (!r || r.startsWith('..') || isAbsolute(r) || r.split(sep).some((s) => s.startsWith('.')) || !existsSync(f) || !statSync(f).isFile()) return null;
    return f;
  }
  refresh();
  return { refresh, list, activate, deactivate, fire, route, runHook, setEnabled, trust, reload, close, asset, get plugins() { return plugins; } };
}
```

Note: a `files` refusal (undeclared path) answers 500 with the reason but does **not** turn the plugin off: it is the plugin asking for something it may not have, not a crash.

- [ ] **Step 4:** `node --test test/plugins-manager.test.mjs` → pass. **Commit:** "Plugins: the manager (on-demand activation, server API, clean unload, isolated failures)".

---

### Task 5: Installing from npm and git

**Files:** Create `src/plugins/install.mjs`; test `test/plugins-install.test.mjs`.

**Consumes:** `tarEntries`, `integrityOf` (vendor.mjs); `readManifest`; `PROJECT_FILE`, `packageDir`. **Produces:** `parseNpmSpec(spec)`, `installNpm(packagesDir, { npm, integrity? }, { fetchImpl })`, `installGit(packagesDir, { git, commit? }, { gitBin })` → `{ id, dir, manifest, spec }`; `pin(root, id, spec)`, `unpin(root, id)`, `installMissing(root, packagesDir, opts) → installed ids`.

- [ ] **Step 1: Create `test/plugins-install.test.mjs`:**

```js
// Installing shared plugins: npm tarballs checked by hash, git at a fixed commit, pinned in nfgames.json. No network.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGit, installMissing, installNpm, parseNpmSpec, pin, unpin } from '../src/plugins/install.mjs';
import { integrityOf } from '../src/vendor.mjs';
import { makeTgz } from './helpers.mjs';

const manifest = (id, version) => JSON.stringify({ id, name: id, version, engines: { nfgames: '^1.0.0' } });
const fakeRegistry = (pkgs) => async (url) => {
  const meta = /registry\.npmjs\.org\/(.+)\/([^/]+)$/.exec(url);
  if (meta) { const p = pkgs[`${decodeURIComponent(meta[1])}@${meta[2]}`]; return { ok: !!p, status: p ? 200 : 404, json: async () => (p ? { version: p.version, dist: { tarball: `https://tarballs/${p.version}.tgz`, integrity: p.integrity } } : {}) }; }
  const p = Object.values(pkgs).find((x) => url === `https://tarballs/${x.version}.tgz`);
  return { ok: true, status: 200, arrayBuffer: async () => p.tgz.buffer.slice(p.tgz.byteOffset, p.tgz.byteOffset + p.tgz.length) };
};

describe('installing plugins', () => {
  let top, packages, root;
  before(() => { top = mkdtempSync(join(tmpdir(), 'nfgames-install-')); packages = join(top, 'packages'); root = join(top, 'game'); mkdirSync(root); });
  after(() => rmSync(top, { recursive: true, force: true }));

  it('reads npm specs', () => {
    assert.deepEqual(parseNpmSpec('@acme/terrain@2.1.0'), { name: '@acme/terrain', version: '2.1.0' });
    assert.deepEqual(parseNpmSpec('terrain'), { name: 'terrain', version: 'latest' });
  });
  it('npm: checks the hash, unpacks, pins; a mismatch or a path out of the folder installs nothing', async () => {
    const tgz = makeTgz({ 'package/plugin.json': manifest('acme.terrain', '2.1.0'), 'package/server.mjs': 'export function activate() {}' });
    const pkgs = { '@acme/terrain@2.1.0': { version: '2.1.0', tgz, integrity: integrityOf(tgz) } };
    const got = await installNpm(packages, { npm: '@acme/terrain@2.1.0' }, { fetchImpl: fakeRegistry(pkgs) });
    assert.equal(got.id, 'acme.terrain'); assert.ok(existsSync(join(packages, 'acme.terrain@2.1.0', 'server.mjs')));
    assert.deepEqual(got.spec, { npm: '@acme/terrain@2.1.0', integrity: integrityOf(tgz) });
    await assert.rejects(installNpm(packages, { npm: '@acme/terrain@2.1.0', integrity: 'sha512-AAAA' }, { fetchImpl: fakeRegistry(pkgs) }), /differs from the one pinned/);
    const lying = { '@acme/terrain@2.1.0': { ...pkgs['@acme/terrain@2.1.0'], integrity: 'sha512-AAAA' } };
    await assert.rejects(installNpm(join(top, 'p2'), { npm: '@acme/terrain@2.1.0' }, { fetchImpl: fakeRegistry(lying) }), /does not match/);
    const evil = makeTgz({ 'package/plugin.json': manifest('acme.evil', '1.0.0'), 'package/../../escaped.txt': 'x' });
    await assert.rejects(installNpm(join(top, 'p3'), { npm: 'evil@1.0.0' }, { fetchImpl: fakeRegistry({ 'evil@1.0.0': { version: '1.0.0', tgz: evil, integrity: integrityOf(evil) } }) }), /outside the package/);
    assert.ok(!existsSync(join(top, 'escaped.txt')));
  });
  it('git: a local repository at a fixed commit, without its .git', () => {
    const repo = join(top, 'repo'); mkdirSync(repo);
    const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
    git('init', '-q'); git('config', 'user.email', 't@e.st'); git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'plugin.json'), manifest('jacek.comfy', '0.1.0')); git('add', '.'); git('commit', '-qm', 'one');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'plugin.json'), manifest('jacek.comfy', '0.2.0')); git('commit', '-qam', 'two');
    const got = installGit(packages, { git: repo, commit: first });
    assert.equal(got.manifest.version, '0.1.0'); assert.equal(got.spec.commit, first);
    assert.ok(!existsSync(join(got.dir, '.git')));
    assert.throws(() => installGit(packages, { git: '--upload-pack=evil' }), /not a repository address/);
  });
  it('pins in nfgames.json, installs what is missing, unpins', async () => {
    const tgz = makeTgz({ 'package/plugin.json': manifest('acme.trees', '1.0.0') });
    const pkgs = { 'trees@1.0.0': { version: '1.0.0', tgz, integrity: integrityOf(tgz) } };
    pin(root, 'acme.trees', { npm: 'trees@1.0.0', integrity: integrityOf(tgz) });
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'nfgames.json'), 'utf8')).plugins['acme.trees'].npm, 'trees@1.0.0');
    assert.deepEqual(await installMissing(root, packages, { fetchImpl: fakeRegistry(pkgs) }), ['acme.trees']);
    assert.deepEqual(await installMissing(root, packages, { fetchImpl: fakeRegistry(pkgs) }), []);
    unpin(root, 'acme.trees'); assert.equal(JSON.parse(readFileSync(join(root, 'nfgames.json'), 'utf8')).plugins['acme.trees'], undefined);
  });
});
```

Note: `makeTar` writes names as given, so the `../../escaped.txt` entry reaches the installer as-is.

- [ ] **Step 2:** `node --test test/plugins-install.test.mjs` → FAIL.

- [ ] **Step 3: Create `src/plugins/install.mjs`:**

```js
// Installing shared plugins into ~/.nfgames-editor/packages/<id>@<version or commit>: an npm package (its tarball,
// checked against the registry's SHA-512, or the one already pinned) or a git repository at a fixed commit. Pinned in
// the project's nfgames.json, so everyone on the project gets the same bytes. git runs directly, never through a shell.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { integrityOf, tarEntries } from '../vendor.mjs';
import { readManifest } from './manifest.mjs';
import { PROJECT_FILE, packageDir, readProjectPlugins } from './sources.mjs';

const REGISTRY = 'https://registry.npmjs.org';

/** "@scope/name@1.2.3" or "name@1.2.3" or "name" (the latest) → { name, version }. */
export function parseNpmSpec(spec) { const at = spec.lastIndexOf('@'); return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: 'latest' }; }

function settle(tmp, packagesDir, spec) {
  const r = readManifest(tmp);
  if (!r.manifest) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`not a plugin: ${r.errors.join('; ')}`); }
  const dir = packageDir(packagesDir, r.manifest.id, spec);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dirname(dir), { recursive: true }); renameSync(tmp, dir);
  return { id: r.manifest.id, dir, manifest: r.manifest, spec };
}

export async function installNpm(packagesDir, { npm, integrity = null }, { fetchImpl = fetch } = {}) {
  const { name, version } = parseNpmSpec(npm);
  const res = await fetchImpl(`${REGISTRY}/${name.replace('/', '%2F')}/${version}`);
  const meta = res.ok ? await res.json() : null;
  if (!meta || !meta.dist) throw new Error(`no such package: ${npm}`);
  if (integrity && meta.dist.integrity && integrity !== meta.dist.integrity) throw new Error(`${name}@${meta.version}: the registry's hash differs from the one pinned`);
  const want = integrity || meta.dist.integrity;
  const got = await fetchImpl(meta.dist.tarball);
  if (!got.ok) throw new Error(`download failed: ${got.status}`);
  const buf = Buffer.from(await got.arrayBuffer());
  if (integrityOf(buf) !== want) throw new Error(`${name}@${meta.version}: the download does not match its SHA-512; nothing installed`);
  const files = [];
  for (const { name: entry, data } of tarEntries(gunzipSync(buf))) {
    const rel = normalize(entry.replace(/^[^/]+\//, ''));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${name}: a file outside the package (${entry}); nothing installed`);
    files.push([rel, Buffer.from(data)]);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'nfgames-plugin-'));
  for (const [rel, data] of files) { const to = join(tmp, rel); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, data); }
  return settle(tmp, packagesDir, { npm: `${name}@${meta.version}`, integrity: want });
}

export function installGit(packagesDir, { git, commit = null }, { gitBin = 'git' } = {}) {
  if (typeof git !== 'string' || !git || git.startsWith('-')) throw new Error(`not a repository address: ${git}`);
  const tmp = mkdtempSync(join(tmpdir(), 'nfgames-plugin-'));
  const run = (args, cwd = tmp) => execFileSync(gitBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    run(['clone', '--quiet', '--', git, tmp], tmpdir());
    if (commit) run(['checkout', '--quiet', commit]);
    const sha = run(['rev-parse', 'HEAD']);
    rmSync(join(tmp, '.git'), { recursive: true, force: true });
    return settle(tmp, packagesDir, { git, commit: sha });
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`git: ${(e.stderr && String(e.stderr).trim()) || e.message}`); }
}

const projectFile = (root) => join(root, PROJECT_FILE);
const readProject = (root) => (existsSync(projectFile(root)) ? JSON.parse(readFileSync(projectFile(root), 'utf8')) : {});
const writeProject = (root, j) => writeFileSync(projectFile(root), `${JSON.stringify(j, null, 2)}\n`);
export function pin(root, id, spec) { const j = readProject(root); j.plugins = { ...(j.plugins || {}), [id]: spec }; writeProject(root, j); }
export function unpin(root, id) { const j = readProject(root); if (j.plugins) delete j.plugins[id]; writeProject(root, j); }

/** Installs every npm / git plugin nfgames.json pins that is not in the cache yet: the ids installed. */
export async function installMissing(root, packagesDir, opts = {}) {
  const done = [];
  for (const [id, spec] of Object.entries(readProjectPlugins(root))) {
    if (!spec || typeof spec !== 'object' || existsSync(packageDir(packagesDir, id, spec))) continue;
    if (spec.npm) await installNpm(packagesDir, spec, opts); else if (spec.git) installGit(packagesDir, spec, opts); else continue;
    done.push(id);
  }
  return done;
}
```

- [ ] **Step 4:** `node --test test/plugins-install.test.mjs` → pass. **Commit:** "Plugins: install from npm (hash-checked) and git (fixed commit), pinned in nfgames.json".

---

### Task 6: Wiring into the server; the host as a library; the CLI; the sample plugin

**Files:** Modify `src/server.mjs`; create `src/host.mjs`, `bin/nfgames.mjs`, `examples/plugins/hello/plugin.json`, `examples/plugins/hello/server.mjs`; test `test/plugins-server.test.mjs`; modify `package.json` (`bin.nfgames`, `exports['./host']`, `files` += `plugins/`).

**Produces:** `createEditor(…, { pluginDirs })` (defaults: `builtinDir: <editor>/plugins`, `userDir: <stateDir>/plugins`, `packagesDir: <stateDir>/packages`); `server.plugins` (getter), `server.events`, `server.ready` (Promise); routes `GET /api/events`, `GET /api/plugins`, `POST /api/plugins/<id>/(trust|enable|disable|reload)`, `GET|POST /api/p/<id>/<path>`, `GET /p/<id>/<path>`; `check` and `validate` hooks in `preview`; `createHost({ root, port, ...options }) → { server, project, plugins, listen(port?) }`.

- [ ] **Step 1: Create `test/plugins-server.test.mjs`:**

```js
// Plugins over HTTP: listed, their routes and assets served under their id, the same security checks, live events,
// their check hook feeding Problems, and a project switch reloading them.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import { sampleCopy, writePlugin } from './helpers.mjs';

describe('plugins over HTTP', () => {
  const port = 20393 + (process.pid % 500), origin = `http://127.0.0.1:${port}`;
  let top, copy, host;
  const ask = (p, o) => fetch(`${origin}${p}`, o);
  const post = (p, body = {}, headers = { 'Content-Type': 'application/json', Origin: origin }) => ask(p, { method: 'POST', headers, body: JSON.stringify(body) });
  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-psrv-'))); copy = sampleCopy();
    const builtinDir = join(top, 'builtin');
    writePlugin(join(builtinDir, 'hello'), { id: 'nfgames.hello', server: 'server.mjs', web: 'web/index.js', activation: ['onRoute'] }, {
      'server.mjs': `export function activate(api) { api.routes.get('/hi', () => ({ hi: api.project.name })); api.routes.post('/echo', ({ body }) => body); api.hooks.on('check', ({ name }) => [{ kind: 'hello', text: 'hello checked ' + name, sel: [], at: null }]); }`,
      'web/index.js': 'export function activate() {}', 'web/.hidden': 'x' });
    host = await createHost({ root: copy.root, port, pluginDirs: { builtinDir, userDir: join(top, 'user'), packagesDir: join(top, 'packages') }, stateDir: join(top, 'state'), home: top });
    await host.listen();
  });
  after(async () => { await new Promise((d) => host.server.close(d)); copy.done(); rmSync(top, { recursive: true, force: true }); });

  it('lists plugins', async () => {
    const j = await (await ask('/api/plugins')).json();
    assert.equal(j.api, '1.0.0'); assert.equal(j.plugins.find((p) => p.id === 'nfgames.hello').state, 'ready');
  });
  it('serves a plugin\'s routes under its id, with the usual checks', async () => {
    assert.deepEqual(await (await ask('/api/p/nfgames.hello/hi')).json(), { hi: copy.root.split('/').pop() });
    assert.deepEqual(await (await post('/api/p/nfgames.hello/echo', { a: 1 })).json(), { a: 1 });
    assert.equal((await post('/api/p/nfgames.hello/echo', {}, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    assert.equal((await ask('/api/p/nobody.here/hi')).status, 404);
  });
  it('serves a plugin\'s own files, nothing hidden, nothing outside', async () => {
    const r = await ask('/p/nfgames.hello/web/index.js');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
    for (const bad of ['/p/nfgames.hello/web/.hidden', '/p/nfgames.hello/..%2F..%2Fstate', '/p/nfgames.hello/server.mjs%00']) assert.equal((await ask(bad)).status, 404, bad);
  });
  it('a plugin\'s check hook reaches Problems', async () => {
    const s = await (await ask('/api/state')).json();
    assert.ok(s.problems.some((p) => p.kind === 'hello' && /hello checked plaza/.test(p.text)), JSON.stringify(s.problems));
  });
  it('streams plugin events', async () => {
    const res = await ask('/api/events'), reader = res.body.getReader(); let text = '';
    await post('/api/plugins/nfgames.hello/reload');
    while (!/plugins\/changed/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(text, /"id":"nfgames.hello"/);
  });
  it('turning a plugin off and on, from this page only', async () => {
    assert.equal((await post('/api/plugins/nfgames.hello/disable', {}, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    const off = await (await post('/api/plugins/nfgames.hello/disable')).json();
    assert.equal(off.plugins.find((p) => p.id === 'nfgames.hello').state, 'off');
    assert.equal((await ask('/api/p/nfgames.hello/hi')).status, 404);
    await post('/api/plugins/nfgames.hello/enable');
    assert.equal((await ask('/api/p/nfgames.hello/hi')).status, 200);
  });
});
```

- [ ] **Step 2:** `node --test test/plugins-server.test.mjs` → FAIL.

- [ ] **Step 3: Edit `src/server.mjs`:**
  1. Imports: `import { createEvents } from './events.mjs';`, `import { createPluginManager } from './plugins/manager.mjs';`, `import { API_VERSION } from './plugins/manifest.mjs';`, and `extname` from `node:path`.
  2. `preview(project, name, plan, plants, plugins = null)`: after `problems.push(...checkFit…)` and the plants check, add
     `if (plugins) for (const list of await plugins.runHook('check', { plan, plants: plants ?? null, built, name, kinds })) if (Array.isArray(list)) problems.push(...list);`
     and before `if (errors.length) return …` (right after the planErrors line) add
     `if (plugins) for (const list of await plugins.runHook('validate', { plan, name })) if (Array.isArray(list)) errors.push(...list.map(String));`
     Every call of `preview(project, name, …)` in the file passes `plugins` as the last argument.
  3. `createEditor` options gain `pluginDirs = {}`. After the `jobs` line:
     ```js
       const events = createEvents();
       const dirs = { builtinDir: join(EDITOR_ROOT, 'plugins'), userDir: join(stateDir, 'plugins'), packagesDir: join(stateDir, 'packages'), ...pluginDirs };
       const makePlugins = () => createPluginManager({ ...dirs, stateDir, project, jobs, events, log: (...a) => console.error('plugins:', ...a) });
       let plugins = makePlugins();
       const ready = plugins.fire('onStartup', 'onProject');
     ```
     In `switchProject`, before `project = next;` add `await plugins.close();`, and after `startMap = null;` add `plugins = makePlugins(); await plugins.fire('onStartup', 'onProject'); events.emit('project/changed', { root: dir });`.
  4. Static plugin files, after the `/vendor/` line:
     ```js
           { const m = req.method === 'GET' && /^\/p\/([a-z0-9.-]+)\/(.+)$/.exec(path);
             if (m) { let rest; try { rest = decodeURIComponent(m[2]); } catch { rest = ''; } const f = rest.includes('\0') ? null : plugins.asset(m[1], rest); return f ? send(200, readFileSync(f), TYPES[extname(f)] || 'application/octet-stream') : send(404, { error: 'not here' }); } }
     ```
     with, at module level: `const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };`
  5. In the "none of this is about a map" block:
     ```js
           if (req.method === 'GET' && path === '/api/events') return events.handle(req, res);
           if (req.method === 'GET' && path === '/api/plugins') return send(200, { api: API_VERSION, plugins: plugins.list() });
           { const m = req.method === 'POST' && /^\/api\/plugins\/([a-z0-9.-]+)\/(trust|enable|disable|reload)$/.exec(path);
             if (m) { try { const [, id, verb] = m; if (verb === 'trust') plugins.trust(id); else if (verb === 'reload') await plugins.reload(id); else await plugins.setEnabled(id, verb === 'enable'); return send(200, { plugins: plugins.list() }); } catch (e) { return send(e.code || 500, { error: e.message, plugins: plugins.list() }); } } }
           { const m = /^\/api\/p\/([a-z0-9.-]+)\/(.*)$/.exec(path);
             if (m) { const r = await plugins.route(m[1], req.method, m[2], req, res, () => body()); return send(r.status, r.body); } }
     ```
  6. At the end: `Object.defineProperty(server, 'plugins', { get: () => plugins }); server.events = events; server.ready = ready;` and close the event stream with the server: `const close = server.close.bind(server); server.close = (cb) => { events.close(); plugins.close().finally(() => close(cb)); return server; };`.

- [ ] **Step 4: Create `src/host.mjs`:**

```js
// The editor as a library: open a project and get its server, with its plugins started. An engine's dev server can use
// this to run the editor in its own process (mounting it under a path prefix is sub-project 4).
import { loadProject } from './project.mjs';
import { createEditor, HOST } from './server.mjs';

export async function createHost({ root = process.cwd(), port, config, ...options } = {}) {
  const project = await loadProject({ root, config });
  const at = port ?? project.port;
  const server = createEditor(project, { port: at, ...options });
  await server.ready;
  return {
    server,
    get project() { return server.project; },
    get plugins() { return server.plugins; },
    listen: (p = at) => new Promise((ok, no) => { server.once('error', no); server.listen(p, HOST, () => ok(server)); }),
  };
}
```

- [ ] **Step 5: Create `bin/nfgames.mjs`:**

```js
#!/usr/bin/env node
// nfgames plugin list | add <npm spec | git url[#commit]> | install | update <id> | remove <id>   [--project <dir>]
//
//   list      every plugin the project sees, where it comes from, and its state
//   add       install a shared plugin and pin its exact version (npm: SHA-512; git: commit) in the project's nfgames.json
//   install   install every pinned plugin that is not in ~/.nfgames-editor/packages yet (after a fresh checkout)
//   update    the newest version of a pinned npm plugin, or the newest commit of a git one; shows old → new
//   remove    unpin it (the cached copy stays for other projects)
import { join, resolve } from 'node:path';
import { HOME } from '../src/home.mjs';
import { EDITOR_ROOT } from '../src/project.mjs';
import { discoverPlugins, readProjectPlugins } from '../src/plugins/sources.mjs';
import { installGit, installMissing, installNpm, pin, unpin } from '../src/plugins/install.mjs';

const USAGE = 'usage: nfgames plugin list | add <npm spec | git url[#commit]> | install | update <id> | remove <id>  [--project <dir>]';
const args = process.argv.slice(2), at = args.indexOf('--project'), root = resolve(at >= 0 ? args[at + 1] : process.cwd());
const [group, verb, arg] = args.filter((a, i) => i !== at && i !== at + 1);
const state = join(HOME, '.nfgames-editor'), packagesDir = join(state, 'packages');
const isGit = (s) => /^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(s) || s.endsWith('.git');

try {
  if (group !== 'plugin' || !verb) { console.log(USAGE); process.exit(group ? 2 : 0); }
  if (verb === 'list') {
    for (const p of discoverPlugins({ builtinDir: join(EDITOR_ROOT, 'plugins'), userDir: join(state, 'plugins'), packagesDir, root }))
      console.log(`${p.id.padEnd(32)} ${(p.manifest?.version || '-').padEnd(9)} ${p.source.padEnd(8)} ${p.errors.length ? p.errors.join('; ') : p.compatible ? 'ok' : `needs editor ${p.manifest?.engines?.nfgames}`}`);
  } else if (verb === 'add' && arg) {
    const got = isGit(arg) ? installGit(packagesDir, { git: arg.split('#')[0], commit: arg.split('#')[1] || null }) : await installNpm(packagesDir, { npm: arg });
    pin(root, got.id, got.spec);
    console.log(`added ${got.id} ${got.manifest.version} (${got.spec.npm || `${got.spec.git} @ ${got.spec.commit.slice(0, 12)}`}), pinned in nfgames.json`);
  } else if (verb === 'install') {
    const done = await installMissing(root, packagesDir);
    console.log(done.length ? `installed ${done.join(', ')}` : 'everything pinned is installed');
  } else if (verb === 'update' && arg) {
    const old = readProjectPlugins(root)[arg];
    if (!old || typeof old !== 'object') throw new Error(`${arg} is not an npm or git plugin of this project`);
    const got = old.npm ? await installNpm(packagesDir, { npm: old.npm.slice(0, old.npm.lastIndexOf('@')) }) : installGit(packagesDir, { git: old.git });
    pin(root, arg, got.spec);
    console.log(`${arg}: ${old.npm || old.commit.slice(0, 12)} → ${got.spec.npm || got.spec.commit.slice(0, 12)}`);
  } else if (verb === 'remove' && arg) { unpin(root, arg); console.log(`removed ${arg} from nfgames.json`); }
  else { console.error(USAGE); process.exit(2); }
} catch (e) { console.error(`nfgames: ${e.message}`); process.exit(1); }
```

- [ ] **Step 6: Create the sample plugin** `examples/plugins/hello/plugin.json`:

```json
{
  "id": "example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "engines": { "nfgames": "^1.0.0" },
  "server": "server.mjs",
  "touches": { "files": [".hello/**"], "commands": [], "network": false },
  "contributes": {
    "commands": [{ "id": "greet", "title": "Say hello" }],
    "settings": { "greeting": { "type": "string", "default": "Hello", "title": "What to say" } }
  },
  "activation": ["onRoute", "onCommand:greet"]
}
```

and `examples/plugins/hello/server.mjs`:

```js
// The sample plugin's server part: a route, a file it may write, a job, and a check. Plan 1B adds its web part.
export function activate(api) {
  api.routes.get('/greeting', () => ({ text: `${api.settings.get('greeting')} from ${api.project.name}` }));
  api.routes.post('/note', ({ body }) => { api.files.write('.hello/note.txt', String(body.text || '')); return { saved: '.hello/note.txt' }; });
  api.routes.post('/count', () => api.jobs.run('Count to three', [1, 2, 3].map((n) => ({ label: `step ${n}`, run: (log) => log(`${n}\n`) }))).job);
  api.hooks.on('check', ({ name }) => (name ? [] : [{ kind: 'hello', text: 'no map open', sel: [], at: null }]));
}
```

- [ ] **Step 7: `package.json`:** `"bin": { "nfgames-map-editor": "bin/nfgames-map-editor.mjs", "nfgames": "bin/nfgames.mjs" }`, `exports["./host"] = "./src/host.mjs"`, `files` gains `"plugins/"`. Create an empty `plugins/.gitkeep` (built-in plugins arrive in sub-project 2).

- [ ] **Step 8:** `node --test test/plugins-server.test.mjs` → pass; `npm test` → all pass; `node bin/nfgames.mjs plugin list --project examples/sample` prints without error. **Commit:** "Plugins: wired into the server (routes, assets, events, hooks), createHost, the nfgames CLI, a sample plugin".

---

### Task 7: Docs

- [ ] **Step 1: `docs/plugins.md`** (the authoring guide, host half; 1B adds the web half): what a plugin is; `plugin.json` field by field (the spec's example); extension points; activation events; the server API (`api.*`, with the sample plugin's code); routes and assets URLs; trust and where plugins come from (`nfgames.json` examples); `nfgames plugin …`; failure isolation; the limits of `touches` (enforced through `api.files` and `api.jobs`, but a plugin is trusted code).
- [ ] **Step 2: README:** a short "Plugins" section linking to `docs/plugins.md`; `nfgames plugin` in the command line section; the security model gains a "Plugins" bullet (trusted code, asked once per version, `touches` enforced through the API only, routes and files namespaced by id, a failing plugin is turned off alone); Tests lists the new files.
- [ ] **Step 3:** `npm test` → all pass. **Commit:** "Docs: writing a plugin (host side)".

## Self-review

- Spec coverage for 1A: manifest and versions (1), sources and precedence, `nfgames.json` (2), trust (2), event stream (3), jobs for plugins (3), on-demand activation, disposables, failure isolation, the server API, routes, hooks (`check`, `validate`), settings, storage, assets (4, 6), npm and git install and pins (5, 6), `createHost` (6), sample plugin (6), docs (7). The `services` extension point is accepted by `checkManifest` (it is in `POINTS`); its behaviour is plan 1C. Web parts, the workbench and the UI kit are plan 1B.
- Deferred and said so: `basePath` (sub-project 4); `kinds`, `compile`, `beforeSave`, `afterSave` hooks (sub-project 2, when the map editor becomes a plugin).
- Names used across tasks match: `runSteps({ kind, label, steps }, { onDone })`, `createPluginManager({...}).route(id, method, rest, req, res, body)`, `asset(id, rest)`, `server.plugins`, `server.ready`, `createHost({ root, port, pluginDirs, stateDir, home })`.
