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
    const offKinds = await off.kinds('x', null);
    assert.equal(offKinds['model:light_cruiser'], undefined); // none from the folder
    assert.equal(offKinds['model:tower'].cls, 'piece');            // the kit's own entry stays, as a plain kit kind
  });
});
