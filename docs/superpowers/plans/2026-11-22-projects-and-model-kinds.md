# Projects, navigation and model kinds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open any project folder under `~` from the browser (both pages), link the editor and the model viewer, and turn a project's `.glb` files into palette kinds sized from their bounds.

**Architecture:** `glb.mjs` reads a GLB's JSON header and scene bounds; `modelkinds.mjs` names and sizes model kinds with a cache; `project.mjs` merges them under the kit and gains model defaults; `home.mjs` browses home, keeps trust and recent lists; `server.mjs` holds a switchable project with three new routes; `nav.html` is the shared project bar and folder dialog written into both pages.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, no dependencies.

**Spec:** `docs/superpowers/specs/2026-11-22-projects-and-model-kinds-design.md`

## Global Constraints

- No npm dependencies. Loopback only; every POST passes `writeAllowed`.
- Browsing and switching: real paths inside the real home folder only; no folder whose name starts with `.`; folder names and markers only, never contents.
- A project's `map-editor.config.mjs` runs on a switch only when trusted: `~/.nfgames-editor/trusted.json`, real path → SHA-256 of the file.
- Kind names match the schema: `^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)?$`; model kinds are `model:<name>`.
- Model kind class `model`, colour `#5fc9c0`, legend "a model from the models folder".

---

### Task 1: GLB bounds (`src/glb.mjs`)

**Files:** Create `src/glb.mjs`; modify `test/helpers.mjs` (append `glbOf`, `boxScene`); test `test/glb.test.mjs`.

**Interfaces — Produces:** `glbJson(file) → object` (throws `not a GLB file`); `sceneBounds(gltf) → { min:[x,y,z], max:[x,y,z] }` (throws `nothing with a size in its scene`); `localMatrix(node) → number[16]`; helpers `glbOf(json) → Buffer`, `boxScene(items:[{min,max,node?}], extra?) → gltf`.

- [ ] **Step 1: Append to `test/helpers.mjs`:**

```js
/** A GLB whose JSON chunk is `json` (the binary chunk is 4 empty bytes): enough for reading bounds from its header. */
export function glbOf(json) {
  let j = Buffer.from(JSON.stringify(json)); j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const bin = Buffer.alloc(4), head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([head, chunk(0x4e4f534a, j), chunk(0x004e4942, bin)]);
}
/** glTF JSON of boxes: each { min, max, node? } is a mesh whose positions span min..max, on a node of the scene. */
export function boxScene(items, extra = {}) {
  return { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: items.map((_, i) => i) }],
    nodes: items.map((it, i) => ({ mesh: i, ...(it.node || {}) })),
    meshes: items.map((_, i) => ({ primitives: [{ attributes: { POSITION: i } }] })),
    accessors: items.map((it) => ({ componentType: 5126, count: 8, type: 'VEC3', min: it.min, max: it.max })), ...extra };
}
```

- [ ] **Step 2: Create `test/glb.test.mjs`:**

```js
// A model's bounds from its GLB header alone: what the editor sizes a model kind's footprint from.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { glbJson, sceneBounds } from '../src/glb.mjs';
import { boxScene, makeGlb } from './helpers.mjs';

const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const bounds = (items, extra) => sceneBounds(boxScene(items, extra));

describe('a model\'s bounds from its GLB header', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'nfgames-glb-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the JSON chunk of a real GLB, and refuses other files', () => {
    writeFileSync(join(dir, 'tri.glb'), makeGlb()); writeFileSync(join(dir, 'bad.glb'), 'not a glb at all, really');
    assert.equal(glbJson(join(dir, 'tri.glb')).meshes[0].name, 'tri');
    assert.deepEqual(sceneBounds(glbJson(join(dir, 'tri.glb'))), { min: [0, 0, 0], max: [1, 1, 0] });
    assert.throws(() => glbJson(join(dir, 'bad.glb')), /not a GLB/);
  });
  it('moves, scales and turns with the nodes', () => {
    const b = bounds([{ min: [-1, 0, -2], max: [1, 3, 2], node: { translation: [10, 0, 5], scale: [2, 1, 1] } }]);
    assert.ok(near(b.min, [8, 0, 3]) && near(b.max, [12, 3, 7]), JSON.stringify(b));
    const s = Math.SQRT1_2, r = bounds([{ min: [0, 0, 0], max: [4, 1, 1], node: { rotation: [0, s, 0, s] } }]); // 90° about Y: +X → -Z
    assert.ok(near(r.min, [0, 0, -4]) && near(r.max, [1, 1, 0]), JSON.stringify(r));
    const m = bounds([{ min: [0, 0, 0], max: [1, 1, 1], node: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] } }]);
    assert.ok(near(m.min, [5, 6, 7]) && near(m.max, [6, 7, 8]));
  });
  it('follows children, and combines every mesh', () => {
    const gltf = boxScene([{ min: [0, 0, 0], max: [1, 1, 1] }, { min: [0, 0, 0], max: [1, 1, 1], node: { translation: [0, 0, 3] } }]);
    gltf.scenes[0].nodes = [0]; gltf.nodes[0].children = [1]; gltf.nodes[0].translation = [2, 0, 0];
    const b = sceneBounds(gltf);
    assert.ok(near(b.min, [2, 0, 0]) && near(b.max, [3, 1, 4]), JSON.stringify(b));
  });
  it('a scene with nothing sized says so', () => assert.throws(() => sceneBounds({ asset: { version: '2.0' }, nodes: [{}] }), /nothing with a size/));
});
```

- [ ] **Step 3:** `node --test test/glb.test.mjs` → FAIL (module not found).

- [ ] **Step 4: Create `src/glb.mjs`:**

```js
// A GLB's JSON header, and the bounds of what its scene draws, read without loading the model: the editor sizes a
// model kind's footprint from this. glTF requires every POSITION accessor to carry min and max, so no vertex is read.
import { closeSync, openSync, readSync } from 'node:fs';

/** The JSON chunk of a .glb file, reading only the start of the file. Throws when it is not a GLB. */
export function glbJson(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) < 20 || head.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file');
    const length = head.readUInt32LE(12), type = head.readUInt32LE(16);
    if (type !== 0x4e4f534a || length > 64 * 1024 * 1024) throw new Error('not a GLB file: no JSON chunk where a GLB has one');
    const json = Buffer.alloc(length);
    if (readSync(fd, json, 0, length, 20) < length) throw new Error('not a GLB file: it ends inside its JSON chunk');
    return JSON.parse(json.toString('utf8'));
  } finally { closeSync(fd); }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Column-major 4x4 product a·b. */
function mul(a, b) { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; }

/** A node's local matrix (column-major): its `matrix`, or translation · rotation (quaternion x, y, z, w) · scale. */
export function localMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation || [0, 0, 0], [x, y, z, w] = node.rotation || [0, 0, 0, 1], [sx, sy, sz] = node.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** The bounds of everything the default scene draws, in the model's frame (glTF: metres, Y up): { min, max }. */
export function sceneBounds(gltf) {
  const nodes = gltf.nodes || [], meshes = gltf.meshes || [], acc = gltf.accessors || [];
  const scene = (gltf.scenes || [])[gltf.scene ?? 0];
  const roots = scene && Array.isArray(scene.nodes) ? scene.nodes : nodes.map((_, i) => i).filter((i) => !nodes.some((n) => (n.children || []).includes(i)));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], seen = new Set();
  const visit = (i, parent) => {
    const node = nodes[i];
    if (!node || seen.has(i)) return;
    seen.add(i);
    const m = mul(parent, localMatrix(node));
    for (const prim of (node.mesh !== undefined && meshes[node.mesh] && meshes[node.mesh].primitives) || []) {
      const a = acc[prim.attributes && prim.attributes.POSITION];
      if (!a || !Array.isArray(a.min) || !Array.isArray(a.max)) continue;
      for (let c = 0; c < 8; c++) {
        const p = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]];
        for (let k = 0; k < 3; k++) { const v = m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
      }
    }
    for (const ch of node.children || []) visit(ch, m);
  };
  for (const r of roots) visit(r, IDENTITY);
  if (!Number.isFinite(min[0])) throw new Error('nothing with a size in its scene');
  return { min, max };
}
```

- [ ] **Step 5:** `node --test test/glb.test.mjs` → 4 pass. **Commit:** "Model kinds: a GLB's bounds from its header".

---

### Task 2: Model kinds (`src/modelkinds.mjs`) and the project's defaults

**Files:** Create `src/modelkinds.mjs`; modify `src/models.mjs` (skip `node_modules`), `src/project.mjs` (model class, default `models`, merge, `modelProblems`, config cache-bust, `normaliseKind` keeps `label`/`model`), `src/server.mjs` (`preview` adds model problems); tests `test/modelkinds.test.mjs`, update `test/viewer-config.test.mjs`.

**Interfaces — Consumes:** `listModels`; `glbJson`, `sceneBounds`. **Produces:** `kindPart(text)`, `kindNames(paths) → { kind: path }`, `createModelKinds(dir) → () => { kinds, problems:[{file,error}] }`; `project.modelProblems()`; model kinds `{ cls:'model', group, label, model, size, boxes }`.

- [ ] **Step 1: Create `test/modelkinds.test.mjs`:**

```js
// A project's .glb files as kinds of piece: named for the schema, sized from their bounds, under the kit's entries.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { kindNames, kindPart, createModelKinds } from '../src/modelkinds.mjs';
import { loadProject } from '../src/project.mjs';
import { glbOf, boxScene } from './helpers.mjs';

describe('model kinds', () => {
  let root;
  const glb = (rel, min, max) => { const f = join(root, 'models', rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, glbOf(boxScene([{ min, max }]))); };
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'nfgames-mk-'));
    mkdirSync(join(root, 'maps'));
    glb('ships/Light Cruiser.glb', [-5, -1, -20], [5, 7, 40]);
    glb('props/crate.glb', [0, 0, 0], [1, 1, 1]);
    glb('ruins/crate.glb', [0, 0, 0], [2, 2, 2]);
    glb('2x/tower.glb', [-1, 0, -1], [1, 9, 1]);
    writeFileSync(join(root, 'models', 'broken.glb'), 'nope');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('names: lower case, a letter first, folders added only when names collide', () => {
    assert.equal(kindPart('Light Cruiser.glb'), 'light_cruiser'); assert.equal(kindPart('2x'), 'm2x'); assert.equal(kindPart('---'), 'model');
    assert.deepEqual(kindNames(['ships/Light Cruiser.glb', 'props/crate.glb', 'ruins/crate.glb']), { 'model:light_cruiser': 'ships/Light Cruiser.glb', 'model:props_crate': 'props/crate.glb', 'model:ruins_crate': 'ruins/crate.glb' });
    for (const k of Object.keys(kindNames(['a b.glb', 'a_b.glb', 'x/y/z.glb']))) assert.match(k, /^model:[a-z][a-z0-9_]*$/);
  });
  it('sizes each model from its bounds, with the box where the model is', () => {
    const { kinds, problems } = createModelKinds(join(root, 'models'))();
    const c = kinds['model:light_cruiser'];
    assert.deepEqual(c.size, [10, 60, 8]); assert.deepEqual(c.boxes, [[0, 10, 10, 60]]);
    assert.equal(c.cls, 'model'); assert.equal(c.group, 'Models · ships'); assert.equal(c.label, 'Light Cruiser'); assert.equal(c.model, 'ships/Light Cruiser.glb');
    assert.deepEqual(kinds['model:tower'].size, [2, 2, 9]);
    assert.equal(kinds['model:broken'].size, undefined);
    assert.deepEqual(problems.map((p) => p.file), ['broken.glb']);
  });
  it('parses a file again when it changes (the folder listing is kept for 2 s)', () => {
    const mk = createModelKinds(join(root, 'models'));
    assert.deepEqual(mk().kinds['model:props_crate'].size, [1, 1, 1]);
    glb('props/crate.glb', [0, 0, 0], [3, 3, 3]);
    const later = new Date(Date.now() + 5000); utimesSync(join(root, 'models', 'props', 'crate.glb'), later, later);
    assert.deepEqual(mk().kinds['model:props_crate'].size, [1, 1, 1]);
    assert.deepEqual(createModelKinds(join(root, 'models'))().kinds['model:props_crate'].size, [3, 3, 3]);
  });
  it('in a project: among the kinds, under the kit, and they can be turned off', async () => {
    writeFileSync(join(root, 'kit.json'), JSON.stringify({ 'model:tower': { size: [3, 3, 9], solid: false } }));
    const p = await loadProject({ root, config: {} });
    const kinds = await p.kinds('x', null);
    assert.deepEqual(kinds['model:tower'].size, [3, 3, 9]); assert.deepEqual(kinds['model:tower'].boxes, [[0, 0, 3, 3]]);
    assert.equal(kinds['model:tower'].solid, false); assert.equal(kinds['model:tower'].cls, 'model');
    assert.equal(kinds['model:light_cruiser'].unknown, undefined);
    assert.equal(kinds['model:broken'].unknown, true); assert.equal(kinds['model:broken'].model, 'broken.glb');
    assert.deepEqual(p.modelProblems().map((x) => x.file), ['broken.glb']);
    const off = await loadProject({ root, config: { modelKinds: false } });
    assert.equal(Object.keys(await off.kinds('x', null)).some((k) => k.startsWith('model:')), false);
  });
});
```

In `test/viewer-config.test.mjs`, replace `assert.equal((await loadProject({ root: SAMPLE, config: {} })).modelsDir, null);` with:

```js
    assert.equal((await loadProject({ root: SAMPLE, config: {} })).modelsDir, SAMPLE); // no models/ folder: the project's own
    assert.equal((await loadProject({ root: SAMPLE, config: { models: false } })).modelsDir, null);
```

- [ ] **Step 2:** `node --test test/modelkinds.test.mjs test/viewer-config.test.mjs` → FAIL.

- [ ] **Step 3: Create `src/modelkinds.mjs`:**

```js
// Models as kinds of piece: every .glb in the project's models folder is a palette entry, sized from the model's own
// bounds (glb.mjs), so a game's assets can be placed with no kit.json entry. Each file is parsed once per version.
import { join } from 'node:path';
import { listModels } from './models.mjs';
import { glbJson, sceneBounds } from './glb.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
/** A kind's name part from a file or folder name: lower case, [a-z0-9_], starting with a letter. */
export const kindPart = (text) => { const s = String(text).toLowerCase().replace(/\.glb$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); return !s ? 'model' : /^[a-z]/.test(s) ? s : `m${s}`; };

/** Kinds for model paths: { 'model:<name>': path }. Where names collide, parent folders are added until they do not. */
export function kindNames(paths) {
  const name = (p, depth) => { const a = p.split('/'); return a.slice(Math.max(0, a.length - 1 - depth)).map(kindPart).join('_'); };
  const depth = new Map(paths.map((p) => [p, 0]));
  for (let round = 0; round < 20; round++) {
    const by = new Map();
    for (const p of paths) { const n = name(p, depth.get(p)); by.set(n, [...(by.get(n) || []), p]); }
    let clash = false;
    for (const list of by.values()) if (list.length > 1) { clash = true; for (const p of list) depth.set(p, depth.get(p) + 1); }
    if (!clash) return Object.fromEntries([...by].map(([n, [p]]) => [`model:${n}`, p]));
  }
  return Object.fromEntries(paths.map((p, i) => [`model:${name(p, 99)}_${i}`, p]));
}

const labelOf = (p) => p.split('/').pop().replace(/\.glb$/i, '').replace(/[_-]+/g, ' ');
const groupOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? 'Models' : `Models · ${p.slice(0, i)}`; };

/** The model kinds of a folder, cached: a function returning { kinds: { kind: raw kind }, problems: [{ file, error }] }. */
export function createModelKinds(modelsDir) {
  const parsed = new Map();
  let listing = null, listedAt = 0;
  return function modelKinds() {
    if (!modelsDir) return { kinds: {}, problems: [] };
    if (!listing || Date.now() - listedAt > 2000) { listing = listModels(modelsDir); listedAt = Date.now(); }
    const byPath = new Map(listing.map((m) => [m.path, m])), kinds = {}, problems = [];
    for (const [kind, path] of Object.entries(kindNames(listing.map((m) => m.path)))) {
      const m = byPath.get(path), stamp = `${m.size}:${m.mtime}`;
      let hit = parsed.get(path);
      if (!hit || hit.stamp !== stamp) {
        try { hit = { stamp, bounds: sceneBounds(glbJson(join(modelsDir, path))) }; } catch (e) { hit = { stamp, error: e.message }; }
        parsed.set(path, hit);
      }
      const base = { cls: 'model', group: groupOf(path), label: labelOf(path), model: path };
      if (hit.error) { kinds[kind] = base; problems.push({ file: path, error: hit.error }); continue; }
      const { min, max } = hit.bounds, w = r2(max[0] - min[0]) || 0.01, d = r2(max[2] - min[2]) || 0.01, h = r2(max[1] - min[1]) || 0.01;
      kinds[kind] = { ...base, size: [w, d, h], boxes: [[r2((min[0] + max[0]) / 2), r2((min[2] + max[2]) / 2), w, d]] };
    }
    return { kinds, problems };
  };
}
```

- [ ] **Step 4: Edit `src/models.mjs`:** in `listModels`, skip `node_modules` too: change `if (out.length >= MAX_MODELS || e.name.startsWith('.') || e.isSymbolicLink()) continue;` to `if (out.length >= MAX_MODELS || e.name.startsWith('.') || e.name === 'node_modules' || e.isSymbolicLink()) continue;`.

- [ ] **Step 5: Edit `src/project.mjs`:**
  1. Import: `import { createModelKinds } from './modelkinds.mjs';`
  2. `DEFAULT_CLASSES` gains `model: { tag: 'model', colour: '#5fc9c0', legend: 'a model from the models folder', note: 'Sized from the model\'s bounds. A kit.json entry of the same name overrides it.' },`
  3. `normaliseKind`'s unknown branch keeps the label and model: add `label: k.label, ...(k.model ? { model: k.model } : {}),` to the returned object.
  4. The config import: `const mod = await import(`${pathToFileURL(configFile).href}?v=${statSync(configFile).mtimeMs}`);` (a changed config is read again).
  5. Replace the `modelsDir` line with:
     ```js
       const modelsDir = options.models === false || options.models === null ? null : options.models ? inside(options.models, '"models"') : existsSync(join(root, 'models')) ? join(root, 'models') : root;
       const modelKindsOn = options.modelKinds !== false, modelKinds = createModelKinds(modelKindsOn ? modelsDir : null);
     ```
  6. In `kinds()`, after the kit/`kinds` hook fills `raw` and before the plan's `sizes` loop:
     ```js
         // the models folder's .glb files, under the kit's entries of the same name (a kit size without boxes drops the model's box)
         for (const [kind, k] of Object.entries(modelKinds().kinds)) { const own = raw[kind] || {}; raw[kind] = { ...k, ...own }; if (own.size && !own.boxes) delete raw[kind].boxes; }
     ```
  7. Return also `modelProblems: () => modelKinds().problems,`.

- [ ] **Step 6: Edit `src/server.mjs` `preview()`:** after the built-in check block (before `if (hooks.check)`), add:
  ```js
    for (const m of project.modelProblems ? project.modelProblems() : []) problems.push({ kind: 'model', text: `${m.file}: ${m.error} (drawn as 2 x 2 m)`, sel: [], at: null });
  ```

- [ ] **Step 7:** `npm test` → all pass. **Commit:** "Model kinds: a project's .glb files in the palette, sized from their bounds".

---

### Task 3: Browsing home, trust, recent (`src/home.mjs`)

**Files:** Create `src/home.mjs`; test `test/home.test.mjs`.

**Interfaces — Produces:** `HOME`; `insideHome(home, path) → realPath|null`; `browse(home, path) → { path, name, parent, home, project, models, entries }` (throws code 400); `configTrust(stateDir, root) → 'none'|'trusted'|'ask'`; `trustConfig(stateDir, root)`; `recentProjects(stateDir) → string[]`; `addRecent(stateDir, root)`.

- [ ] **Step 1: Create `test/home.test.mjs`:**

```js
// The folder browser: home only, no hidden folders, no links out; a config runs only once trusted, and asks again
// when it changes; ten recent projects.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browse, insideHome, configTrust, trustConfig, recentProjects, addRecent } from '../src/home.mjs';
import { makeGlb } from './helpers.mjs';

describe('the folder browser', () => {
  let top, home, state;
  before(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-home-'))); home = join(top, 'home'); state = join(home, '.nfgames-editor');
    for (const d of ['game/maps', 'art', '.ssh', 'Docs']) mkdirSync(join(home, d), { recursive: true });
    mkdirSync(join(top, 'outside'));
    writeFileSync(join(home, 'art', 'ship.glb'), makeGlb()); writeFileSync(join(home, 'art', 'notes.txt'), 'x');
    symlinkSync(join(top, 'outside'), join(home, 'escape')); symlinkSync(join(home, 'art'), join(home, 'art-link'));
  });
  after(() => rmSync(top, { recursive: true, force: true }));

  it('lists folders under home with markers, no hidden ones, no links out', () => {
    const b = browse(home, home);
    assert.deepEqual(b.entries.map((e) => e.name), ['art', 'art-link', 'Docs', 'game']);
    assert.equal(b.parent, null); assert.equal(b.name, '~');
    const art = b.entries.find((e) => e.name === 'art'); assert.equal(art.models, 1); assert.equal(art.project, false);
    assert.equal(b.entries.find((e) => e.name === 'game').project, true);
    assert.equal(browse(home, join(home, 'game')).parent, home);
  });
  it('refuses anything outside home', () => {
    for (const p of [top, join(top, 'outside'), join(home, 'escape'), join(home, '..'), '/etc', '', 'relative/path', join(home, 'missing')]) assert.throws(() => browse(home, p), /home folder/, p);
    assert.equal(insideHome(home, join(home, 'art-link')), join(home, 'art'));
  });
  it('asks before running a config, remembers the answer, asks again when the file changes', () => {
    const game = join(home, 'game');
    assert.equal(configTrust(state, game), 'none');
    writeFileSync(join(game, 'map-editor.config.mjs'), 'export default {};\n');
    assert.equal(configTrust(state, game), 'ask');
    trustConfig(state, game); assert.equal(configTrust(state, game), 'trusted');
    writeFileSync(join(game, 'map-editor.config.mjs'), 'export default { title: "changed" };\n');
    assert.equal(configTrust(state, game), 'ask');
  });
  it('keeps ten recent projects, newest first, only those that still exist', () => {
    for (let i = 0; i < 12; i++) { mkdirSync(join(home, `p${i}`)); addRecent(state, join(home, `p${i}`)); }
    addRecent(state, join(home, 'p3'));
    const r = recentProjects(state);
    assert.equal(r.length, 10); assert.equal(r[0], join(home, 'p3')); assert.equal(r[1], join(home, 'p11'));
    rmSync(join(home, 'p11'), { recursive: true });
    assert.ok(!recentProjects(state).includes(join(home, 'p11')));
  });
});
```

- [ ] **Step 2:** `node --test test/home.test.mjs` → FAIL.

- [ ] **Step 3: Create `src/home.mjs`:**

```js
// The folder browser, and the projects the editor may switch to: folders under the user's home folder (hidden ones
// left out), as names and a few markers only, never contents. A project's config is code the editor runs, so the
// first time a folder's config would run, and whenever the file changes, the user is asked; the answer is kept
// with the file's hash in ~/.nfgames-editor/trusted.json. Recent projects: ~/.nfgames-editor/recent.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { CONFIG_NAME } from './project.mjs';

export const HOME = homedir();
const MAX_ENTRIES = 2000;
const outside = () => Object.assign(new Error('only folders in your home folder can be opened'), { code: 400 });

/** The real path of `path` when it is the home folder or inside it, else null. */
export function insideHome(home, path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return null;
  try { const h = realpathSync(home), p = realpathSync(path); return p === h || p.startsWith(h + sep) ? p : null; } catch { return null; }
}
const isProject = (dir) => existsSync(join(dir, CONFIG_NAME)) || existsSync(join(dir, 'maps')) || existsSync(join(dir, 'data', 'maps'));
const glbCount = (dir) => { try { return readdirSync(dir).filter((n) => /\.glb$/i.test(n)).length; } catch { return 0; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** One folder for the browser: its sub-folders (no hidden ones, no links out of home) with markers, and its parent. */
export function browse(home, path = home) {
  const dir = insideHome(home, path);
  if (!dir || !isDir(dir)) throw outside();
  const h = realpathSync(home), entries = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (entries.length >= MAX_ENTRIES || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (!(e.isDirectory() || (e.isSymbolicLink() && insideHome(home, full) && isDir(full)))) continue;
    entries.push({ name: e.name, path: full, project: isProject(full), models: glbCount(full) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { path: dir, name: dir === h ? '~' : basename(dir), parent: dir === h ? null : dirname(dir), home: h, project: isProject(dir), models: glbCount(dir), entries };
}

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 'none' (no config), 'trusted' (this exact file was trusted before) or 'ask'. */
export function configTrust(stateDir, root) {
  const file = join(root, CONFIG_NAME);
  if (!existsSync(file)) return 'none';
  return readJson(join(stateDir, 'trusted.json'), {})[realpathSync(file)] === sha(file) ? 'trusted' : 'ask';
}
/** Remembers that the user trusts this project's config, as it is now. */
export function trustConfig(stateDir, root) {
  const file = join(root, CONFIG_NAME);
  if (!existsSync(file)) return;
  const all = readJson(join(stateDir, 'trusted.json'), {});
  all[realpathSync(file)] = sha(file);
  writeJson(join(stateDir, 'trusted.json'), all);
}
export const recentProjects = (stateDir) => readJson(join(stateDir, 'recent.json'), []).filter((p) => typeof p === 'string' && existsSync(p));
export function addRecent(stateDir, root) { writeJson(join(stateDir, 'recent.json'), [root, ...recentProjects(stateDir).filter((p) => p !== root)].slice(0, 10)); }
```

- [ ] **Step 4:** `node --test test/home.test.mjs` → 4 pass. **Commit:** "Open project: browse home, trust configs, recent projects".

---

### Task 4: Switching project on the server; `bin` without maps

**Files:** Modify `src/server.mjs`, `bin/nfgames-map-editor.mjs`; test `test/switch.test.mjs`.

**Interfaces — Consumes:** Task 3. **Produces:** `createEditor(project, { …, home = HOME, stateDir = join(HOME, '.nfgames-editor') })`; `server.switchProject(root, { trust })`; routes `GET /api/projects`, `GET /api/browse`, `POST /api/project`.

- [ ] **Step 1: Create `test/switch.test.mjs`:**

```js
// Switching project over HTTP: inside home only, from this page only; a config runs once trusted; a config that
// throws keeps the open project; a project with no maps opens; the viewer and the palette follow.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { createEditor } from '../src/server.mjs';
import { SAMPLE, glbOf, boxScene } from './helpers.mjs';

describe('switching project over HTTP', () => {
  const port = 19893 + (process.pid % 500), origin = `http://127.0.0.1:${port}`;
  let top, home, server;
  const ask = (p) => fetch(`${origin}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body, headers = { 'Content-Type': 'application/json', Origin: origin }) => fetch(`${origin}${p}`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-switch-'))); home = join(top, 'home');
    cpSync(SAMPLE, join(home, 'sample'), { recursive: true, filter: (s) => !/[\\/]out([\\/]|$)|\.prev\.json$/.test(s) });
    mkdirSync(join(home, 'khairos', 'ships'), { recursive: true });
    writeFileSync(join(home, 'khairos', 'ships', 'cruiser.glb'), glbOf(boxScene([{ min: [-5, 0, -30], max: [5, 8, 30] }])));
    mkdirSync(join(home, 'broken')); writeFileSync(join(home, 'broken', 'map-editor.config.mjs'), 'throw new Error("this config is broken");\n');
    mkdirSync(join(top, 'outside'));
    server = createEditor(await loadProject({ root: join(home, 'sample') }), { port, defaultMap: 'plaza', home, stateDir: join(home, '.nfgames-editor') });
    await new Promise((d) => server.listen(port, '127.0.0.1', d));
  });
  after(async () => { await new Promise((d) => server.close(d)); rmSync(top, { recursive: true, force: true }); });

  it('says which project is open, and browses home', async () => {
    const p = await ask('/api/projects'); assert.equal(p.body.current.name, 'sample'); assert.equal(p.body.current.maps, 1);
    assert.deepEqual((await ask(`/api/browse?path=${encodeURIComponent(home)}`)).body.entries.map((e) => e.name), ['broken', 'khairos', 'sample']);
    assert.equal((await ask(`/api/browse?path=${encodeURIComponent(join(top, 'outside'))}`)).status, 400);
  });
  it('switches only from this page, and only inside home', async () => {
    assert.equal((await post('/api/project', { root: join(home, 'khairos') }, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/project', { root: join(top, 'outside') })).status, 400);
  });
  it('opens a folder with no config and no maps: the viewer and the palette see its models', async () => {
    const r = await post('/api/project', { root: join(home, 'khairos') });
    assert.equal(r.status, 200); assert.deepEqual(r.body.maps, []);
    assert.equal((await ask('/api/projects')).body.current.name, 'khairos');
    assert.deepEqual((await ask('/api/models')).body.models.map((m) => m.path), ['ships/cruiser.glb']);
    assert.deepEqual((await ask('/api/maps')).body.maps, []);
    assert.equal((await ask('/api/state')).status, 400);
  });
  it('asks before running a config, and keeps the project when a config throws', async () => {
    const first = await post('/api/project', { root: join(home, 'broken') });
    assert.equal(first.status, 200); assert.equal(first.body.needsTrust, true);
    assert.equal((await ask('/api/projects')).body.current.name, 'khairos');
    const r = await post('/api/project', { root: join(home, 'broken'), trust: true });
    assert.equal(r.status, 400); assert.match(r.body.error, /this config is broken/);
    assert.equal((await ask('/api/projects')).body.current.name, 'khairos');
  });
  it('a trusted config opens next time without asking, and is first among the recent', async () => {
    assert.equal((await post('/api/project', { root: join(home, 'sample') })).body.needsTrust, true);
    const r = await post('/api/project', { root: join(home, 'sample'), trust: true });
    assert.equal(r.status, 200); assert.deepEqual(r.body.maps, ['plaza']);
    await post('/api/project', { root: join(home, 'khairos') });
    assert.equal((await post('/api/project', { root: join(home, 'sample') })).body.ok, true);
    assert.equal((await ask('/api/state')).body.name, 'plaza');
    assert.deepEqual((await ask('/api/projects')).body.recent.slice(0, 2), [join(home, 'sample'), join(home, 'khairos')]);
  });
});
```

- [ ] **Step 2:** `node --test test/switch.test.mjs` → FAIL.

- [ ] **Step 3: Edit `src/server.mjs`:**
  1. Imports: `import { basename, join } from 'node:path';` (replacing the `join`-only import); `import { CONFIG_NAME, EDITOR_ROOT, loadProject } from './project.mjs';`; `import { HOME, addRecent, browse, configTrust, insideHome, recentProjects, trustConfig } from './home.mjs';`.
  2. Signature: `export function createEditor(initial, { port = initial.port, defaultMap = null, dryRun = false, editorRoot = EDITOR_ROOT, fetchImpl = fetch, home = HOME, stateDir = join(HOME, '.nfgames-editor') } = {}) {`
  3. Its first lines become:
     ```js
       let project = initial, jobs = createJobs(project, { dryRun }), startMap = defaultMap;
       project.ctx.dryRun = dryRun;
       const fallback = () => startMap || project.defaultMap || project.listMaps()[0] || null;
       /** Opens another project folder (inside home). A config not yet trusted is not run: { needsTrust, config }. */
       async function switchProject(root, { trust = false } = {}) {
         const dir = insideHome(home, root);
         if (!dir) throw Object.assign(new Error('only folders in your home folder can be opened'), { code: 400 });
         const running = jobs.current();
         if (running && running.state === 'running') throw Object.assign(new Error(`wait for ${running.kind} to finish`), { code: 409 });
         const t = configTrust(stateDir, dir);
         if (t === 'ask' && !trust) return { needsTrust: true, config: join(dir, CONFIG_NAME) };
         if (t === 'ask') trustConfig(stateDir, dir);
         let next;
         try { next = await loadProject({ root: dir }); } catch (e) { throw Object.assign(new Error(e.message), { code: 400 }); }
         project = next; jobs = createJobs(project, { dryRun }); project.ctx.dryRun = dryRun; startMap = null;
         addRecent(stateDir, dir);
         return { ok: true, root: dir, maps: project.listMaps() };
       }
     ```
  4. In the "model viewer: none of this is about a map" block, add:
     ```js
           if (req.method === 'GET' && path === '/api/projects') return send(200, { current: { root: project.root, name: basename(project.root), title: project.options.title || null, maps: project.listMaps().length }, recent: recentProjects(stateDir), home: insideHome(home, home) });
           if (req.method === 'GET' && path === '/api/browse') { try { return send(200, browse(home, url.searchParams.get('path') || home)); } catch (e) { return send(e.code === 400 ? 400 : 500, { error: e.message }); } }
           if (req.method === 'POST' && path === '/api/project') { const b = await body(); try { return send(200, await switchProject(b && b.root, { trust: !!b && b.trust === true })); } catch (e) { return send(e.code || 500, { error: e.message }); } }
     ```
  5. Replace `server.jobs = jobs;` with `Object.defineProperty(server, 'jobs', { get: () => jobs }); server.switchProject = switchProject; Object.defineProperty(server, 'project', { get: () => project });`
  6. `page()` and `viewerPage()` also write in the shared bar: `.replace('<!--@nav-->', () => readFileSync(join(EDITOR_ROOT, 'src', 'nav.html'), 'utf8'))` (Task 5 creates `nav.html`; until then create it empty).

- [ ] **Step 4: Edit `bin/nfgames-map-editor.mjs`:**
  1. Imports: `import { join } from 'node:path';` and `import { HOME, addRecent, trustConfig } from '../src/home.mjs';`.
  2. Replace the "maps / wanted" block with: a named map must exist; with no maps, start anyway:
     ```js
     const maps = project.listMaps(), wanted = loose[0] || project.defaultMap || maps[0] || null;
     if (wanted && !project.knownMap(wanted)) {
       console.error(`map editor: no map called ${JSON.stringify(wanted)} in ${project.mapsDir} (maps: ${maps.join(', ') || 'none'}). A map is <maps>/<name>/layout.json.`);
       process.exit(1);
     }
     // the project it starts on is trusted (its config already ran) and goes to the recent list
     try { const state = join(HOME, '.nfgames-editor'); trustConfig(state, project.root); addRecent(state, project.root); } catch { /* not essential */ }
     ```
  3. The start line prints `${wanted || 'no maps yet'}` in place of `${wanted}`, and `saves to …` only when `wanted`.

- [ ] **Step 5:** create an empty `src/nav.html`; `npm test` → all pass. **Commit:** "Open project: switch the editor's project at run time; start with no maps".

---

### Task 5: The project bar, folder dialog and page changes

**Files:** Create `src/nav.html`; modify `src/editor.html`, `src/viewer.html`.

- [ ] **Step 1: Write `src/nav.html`:**

```html
<style>
#nfnav { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; }
#nfnav a { color: inherit; opacity: .7; text-decoration: none; padding: 2px 7px; border-radius: 5px; }
#nfnav a:hover { opacity: 1; } #nfnav a.here { opacity: 1; background: rgba(255, 179, 102, .16); color: #ffb366; }
#nfnav .proj { opacity: .7; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; }
#nfnav button { font: inherit; cursor: pointer; padding: 2px 8px; border-radius: 5px; border: 1px solid #ffffff2a; background: #ffffff10; color: inherit; }
#nfDialog { width: min(640px, 92vw); padding: 0; border: 1px solid #2c3240; border-radius: 10px; background: #1c2029; color: #d8dee9; font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
#nfDialog::backdrop { background: rgba(0, 0, 0, .55); }
#nfDialog header { padding: 10px 14px; border-bottom: 1px solid #2c3240; display: flex; gap: 8px; align-items: center; } #nfDialog header b { flex: 1; }
#nfDialog .body { padding: 10px 14px; overflow: auto; max-height: 56vh; }
#nfDialog .crumbs { margin-bottom: 8px; word-break: break-all; } #nfDialog .crumbs a { color: #9fb4d4; cursor: pointer; }
#nfDialog ul { list-style: none; margin: 0 0 10px; padding: 0; }
#nfDialog li { display: flex; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 5px; cursor: pointer; }
#nfDialog li:hover { background: #252a35; } #nfDialog li .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#nfDialog .tag { font-size: 11px; padding: 0 6px; border-radius: 8px; background: #33291c; color: #ffb366; } #nfDialog .tag.m { background: #1c3330; color: #5fc9c0; }
#nfDialog footer { padding: 10px 14px; border-top: 1px solid #2c3240; display: flex; gap: 8px; align-items: center; } #nfDialog footer .msg { flex: 1; font-size: 12px; }
#nfDialog .bad { color: #ff7a7a; } #nfDialog .dim { color: #8a93a6; }
#nfDialog button { font: inherit; cursor: pointer; padding: 4px 10px; border-radius: 6px; border: 1px solid #2c3240; background: #252a35; color: inherit; }
#nfDialog button.primary { background: #ffb366; color: #1a1206; border-color: #ffb366; font-weight: 600; }
#nfDialog h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8a93a6; margin: 4px 0 6px; }
</style>
<nav id="nfnav"><a href="/" data-page="editor">Map editor</a><a href="/viewer" data-page="viewer">Model viewer</a><span class="proj" id="nfProj"></span><button id="nfOpen" title="Open another project folder">📁 Open project…</button></nav>
<dialog id="nfDialog">
  <header><b>Open a project folder</b><button id="nfClose" title="Close">✕</button></header>
  <div class="body"><div id="nfRecent"></div><h3>Browse</h3><div class="crumbs" id="nfCrumbs"></div><ul id="nfList"></ul></div>
  <footer><span class="msg dim" id="nfMsg"></span><button id="nfUp">Up</button><button class="primary" id="nfGo">Open this folder</button></footer>
</dialog>
<script type="module">
// The bar both pages share: links between the map editor and the model viewer, the open project, and "Open
// project…", a browser of the folders under your home folder. Opening one switches the project for both pages.
const q = (id) => document.getElementById(id);
const node = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const here = location.pathname.startsWith('/viewer') ? 'viewer' : 'editor';
for (const a of document.querySelectorAll('#nfnav a')) a.classList.toggle('here', a.dataset.page === here);
let at = null, trustFor = null;
const msg = (text, cls = 'dim') => { q('nfMsg').className = `msg ${cls}`; q('nfMsg').textContent = text; };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const info = await (await fetch('/api/projects')).json();
q('nfProj').textContent = `· ${info.current.title || info.current.name}`; q('nfProj').title = info.current.root;

async function show(path) {
  const r = await fetch(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`), b = await r.json();
  if (!r.ok) { msg(b.error, 'bad'); if (path) await show(null); return; }
  at = b; trustFor = null; q('nfGo').textContent = 'Open this folder';
  const rel = b.path.slice(b.home.length).split('/').filter(Boolean);
  q('nfCrumbs').replaceChildren(node('a', { textContent: '~', onclick: () => show(b.home) }), ...rel.flatMap((part, i) => [' / ', node('a', { textContent: part, onclick: () => show(`${b.home}/${rel.slice(0, i + 1).join('/')}`) })]));
  q('nfList').replaceChildren(...(b.entries.length ? b.entries.map((e) => node('li', { title: e.path, onclick: () => show(e.path) }, '📁', node('span', { className: 'n', textContent: e.name }),
    ...(e.project ? [node('span', { className: 'tag', textContent: 'project' })] : []), ...(e.models ? [node('span', { className: 'tag m', textContent: plural(e.models, 'model') })] : []))) : [node('li', { className: 'dim', textContent: 'no folders here' })]));
  q('nfUp').disabled = !b.parent;
  msg(b.project ? 'This folder is a project.' : b.models ? `${plural(b.models, 'model')} here.` : 'Any folder opens: one without a config uses the defaults.');
}
async function open(root, trust = false) {
  if (window.__map && window.__map.isDirty && window.__map.isDirty() && !confirm('This map has unsaved changes. Switch project and lose them?')) return;
  msg('opening…');
  const r = await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, trust }) }), b = await r.json().catch(() => ({}));
  if (!r.ok) { msg(b.error || `${r.status}`, 'bad'); return; }
  if (b.needsTrust) { trustFor = root; msg(`${b.config.replace(info.home, '~')} is code the editor will run. Open only projects you trust.`, 'bad'); q('nfGo').textContent = 'Run its config and open'; return; }
  window.__nfSwitching = true;
  location.href = here === 'viewer' ? '/viewer' : '/';
}
q('nfOpen').onclick = async () => {
  q('nfRecent').replaceChildren(...(info.recent.length ? [node('h3', { textContent: 'Recent' }), node('ul', {}, ...info.recent.map((p) => node('li', { title: p, onclick: () => open(p) }, '★', node('span', { className: 'n', textContent: p.replace(info.home, '~') }))))] : []));
  q('nfDialog').showModal();
  await show(info.current.root.startsWith(info.home) ? info.current.root : null);
};
q('nfClose').onclick = () => q('nfDialog').close();
q('nfUp').onclick = () => at && at.parent && show(at.parent);
q('nfGo').onclick = () => (trustFor ? open(trustFor, true) : at && open(at.path));
</script>
```

- [ ] **Step 2: Edit `src/editor.html`:**
  1. First line inside `<aside id="left">`: `<!--@nav-->` then the existing `<h1>Add a piece</h1>`; add CSS `#nfnav { margin: -4px 0 10px; }`.
  2. `beforeunload`: `if (plan && isDirty() && !window.__nfSwitching)`.
  3. `renderProblems`: focus only when there is a place: `if (p.at) focusOn(p.at, 9);`.
  4. Selected piece row: after `h('span', { class: 'dim', textContent: p.kind })` add `...(k.model ? [h('a', { href: `/viewer?model=${encodeURIComponent(k.model)}`, textContent: 'View model', style: 'margin-left:auto' })] : [])`.
  5. `load()` starts by checking for maps:
     ```js
       const listed = await fetch('/api/maps').then((r) => r.json()).catch(() => ({ maps: [] }));
       if (!listed.maps.length) { $('title').textContent = 'No maps yet'; status('This project has no maps yet (a map is <maps>/<name>/layout.json). Its models are in the Model viewer.'); $('palette').replaceChildren(h('p', { class: 'small dim', textContent: 'No map is open.' })); window.__map.ready = true; return; }
     ```

- [ ] **Step 3: Edit `src/viewer.html`:**
  1. Header: `<header><h1>Model review</h1><!--@nav--><span class="grow"></span></header>` (the `#project` span and the "map editor" link go; remove the `$('project')…` line in the script).
  2. `openModel` (after `modelPath = m.path;`): `history.replaceState(null, '', `/viewer?model=${encodeURIComponent(m.path)}`);`
  3. Start: after `await listModels();`: `const want = new URLSearchParams(location.search).get('model'), first = want && models.find((x) => x.path === want); if (first && T) await openModel(first);`

- [ ] **Step 4: Browser check** (Playwright MCP) on the running editor: the bar on both pages, links between them; Open project → browse to `~/Desktop/Khairos` → it asks to trust its config → open → the viewer lists its models; the editor shows "No maps yet" or (after the Khairos config's borrowed maps) the palette's **Models** groups; place a model kind; **View model** opens it in the viewer; no console errors. `npm test` → all pass.

- [ ] **Step 5: Commit:** "Open project: the project bar and folder dialog on both pages; viewer follows ?model=".

---

### Task 6: Docs and Khairos

- [ ] **Step 1: README.** Add to the intro a sentence on opening any project from the browser. Add a section **"Opening a project"** before "The config file": the bar, the dialog (home only, hidden folders left out, markers, recent), trust (asked once per config version, `~/.nfgames-editor/trusted.json`), projects with no maps, the defaults for a folder with no config. In "Kinds and kit.json", a paragraph **"Models as kinds"**: names, sizes from bounds, groups, the `model` class, kit wins, `modelKinds: false`, unreadable files as problems. Options table: `models` default updated, `modelKinds` added. Security model: the browser and switching. Tests: the new files.
- [ ] **Step 2: Khairos config.** Remove the borrowed `maps`/`kit` lines from `~/Desktop/Khairos/map-editor.config.mjs` (a project with no maps opens now). Restart the Khairos editor.
- [ ] **Step 3: todo.md.** Add "- [ ] New map from the editor (a project with no maps can only be browsed)."
- [ ] **Step 4:** `npm test` → all pass. **Commit:** "Docs: opening a project, models as kinds".

## Self-review

- Spec coverage: current project + routes (Task 4), browse/trust/recent (3), config defaults and cache-bust (2), model kinds incl. problems and class (1, 2), pages incl. no-maps, View model, ?model= (5), security (3, 4), tests (each), docs (6).
- Not covered by an automated test: "switch refused while a job runs" (a real Apply job finishes too fast to race reliably); the 409 path is a two-line guard, checked by reading.
- Types: `createModelKinds(dir)()` returns `{ kinds, problems }` (Tasks 2, 4); `browse`/`insideHome`/`configTrust` signatures match between Tasks 3 and 4.
