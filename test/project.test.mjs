// A project: its config (or the defaults), its maps folder, the schema check and what stops a save.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject, BUILT_IN_SCHEMAS } from '../src/project.mjs';
import { SAMPLE, samplePlan, samplePlants, sampleCopy } from './helpers.mjs';

const sample = () => loadProject({ root: SAMPLE });

describe('a map\'s plan and its schema', () => {
  it('the sample map and its plants pass', async () => {
    const p = await sample();
    assert.deepEqual(await p.planErrors(samplePlan(), 'plaza'), []);
    assert.deepEqual(await p.plantsErrors(samplePlants()), []);
  });
  it('says what is wrong with a plan', async () => {
    const p = await sample();
    const broken = async (change) => { const plan = samplePlan(); change(plan); return (await p.planErrors(plan, 'plaza')).join('\n'); };
    assert.match(await broken((q) => { delete q.spawn; }), /missing "spawn"/);
    assert.match(await broken((q) => { delete q.ring; }), /none of the allowed forms/);
    assert.match(await broken((q) => { delete q.frame; }), /missing "frame"/);
    assert.match(await broken((q) => { q.frame.rot = 'radians'; }), /frame\.rot/);
    assert.match(await broken((q) => { q.pieces[0].kind = 'Tower'; }), /pieces\[0\]\.kind/);
    assert.match(await broken((q) => { q.pieces[0].at = [1, 2, 3]; }), /pieces\[0\]\.at/);
    assert.match(await broken((q) => { delete q.pieces[1].rot; }), /pieces\[1\]: missing "rot"/);
    assert.match(await broken((q) => { q.pieces[1].scale = 0; }), /pieces\[1\]\.scale/);
    assert.match(await broken((q) => { q.pieces[2].id = 'h1'; }), /two are called "h1"/);
    assert.match(await broken((q) => { q.pieces[2].id = 'wall3'; }), /kept for things/);
    assert.match(await broken((q) => { q.doors[0].piece = 'nowhere'; }), /hangs on "nowhere"/);
    assert.match(await broken((q) => { q.things[0].radius = -1; }), /things\[0\]\.radius/);
    assert.match(await broken((q) => { q.id = 'other'; }), /its id is "other"/);
  });
  it('a preset\'s series may use its kept ids, nothing else may', async () => {
    const p = await sample(), plan = samplePlan();
    assert.deepEqual(await p.planErrors(plan, 'plaza'), []); // planter0 and planter1 are kit:pot
    plan.pieces.find((q) => q.id === 'planter0').kind = 'kit:crate';
    assert.match((await p.planErrors(plan, 'plaza')).join('\n'), /"planter0" is a name kept/);
  });
  it('a map with bounds and no ring, and sections of its own, passes', async () => {
    const p = await sample(), plan = samplePlan();
    delete plan.ring; delete plan.gate; plan.bounds = { min: [-30, -30], max: [30, 30] }; plan.weather = { dust: 0.4 };
    assert.deepEqual(await p.planErrors(plan, 'plaza'), []);
  });
  it('says what is wrong with plants.json', async () => {
    const p = await sample(), bad = samplePlants();
    bad.points[0].kind = 'Big Pot'; bad.points[1].at = [1]; bad.exclude = [{ at: [0, 0] }];
    const text = (await p.plantsErrors(bad)).join('\n');
    for (const want of [/points\[0\]\.kind/, /points\[1\]\.at/, /exclude\[0\]: missing "r"/]) assert.match(text, want);
    assert.deepEqual(await p.plantsErrors({ ...samplePlants(), beds: [{ any: 'thing' }] }), []); // open to a project's own sections
  });
});

describe('a map\'s name cannot leave the maps folder', () => {
  it('mapDir and knownMap', async () => {
    const p = await sample();
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', 'Plaza', '.git', 'x'.repeat(60), null, 7, 'a..b/c']) assert.throws(() => p.mapDir(bad), String(bad));
    assert.equal(p.mapDir('plaza'), join(SAMPLE, 'maps', 'plaza'));
    for (const bad of ['../plaza', '..', 'plaza/../../kit', '%2e%2e', 'plaza\\..', '', 'nosuchmap', 'PLAZA']) assert.equal(p.knownMap(bad), null, bad);
    assert.equal(p.knownMap('plaza'), 'plaza');
  });
});

describe('the config', () => {
  it('reads kinds from the kit, the plan\'s own sizes on top, and the palette\'s groups', async () => {
    const p = await sample(), plan = samplePlan();
    plan.sizes = { 'kit:fountain': [3, 3, 1.5], 'kit:crate': [2, 2, 2] };
    const kinds = await p.kinds('plaza', plan);
    assert.deepEqual(kinds['kit:hall'].boxes.length, 3);
    assert.deepEqual(kinds['kit:house'].door, [0, 2.8]);
    assert.deepEqual(kinds['kit:fountain'].boxes, [[0, 0, 3, 3]]);
    assert.deepEqual(kinds['kit:crate'].size, [2, 2, 2]); // the plan's size wins
    assert.equal(kinds['mark:beacon'].unknown, true);
    assert.equal(kinds['kit:fountain'].group, 'Street things'); // by the config's palette.groups
  });
  it('with no config: maps/ or data/maps/, the built-in schemas, kit.json if there is one', async () => {
    const { root, done } = sampleCopy();
    try {
      const bare = join(root, 'bare');
      mkdirSync(join(bare, 'data', 'maps', 'plaza'), { recursive: true });
      writeFileSync(join(bare, 'data', 'maps', 'plaza', 'layout.json'), JSON.stringify(samplePlan()));
      const p = await loadProject({ root: bare });
      assert.equal(p.configFile, null);
      assert.equal(p.mapsDir, join(bare, 'data', 'maps'));
      assert.equal(p.schemaFile, BUILT_IN_SCHEMAS.layout);
      assert.deepEqual(p.listMaps(), ['plaza']);
      assert.deepEqual(await p.kinds('plaza', samplePlan()), {});
      assert.deepEqual(await p.planErrors(samplePlan(), 'plaza'), []);
      assert.deepEqual(p.actions, {});
    } finally { done(); }
  });
  it('takes a config object, and refuses actions that are not fixed lists of strings', async () => {
    const ok = await loadProject({ root: SAMPLE, config: { actions: { build: { steps: [{ node: ['tools/report.mjs', '{map}'] }] } } } });
    assert.deepEqual(ok.actions.build.steps[0].argv, ['tools/report.mjs', '{map}']);
    for (const actions of [{ build: { steps: [{ command: 'rm -rf /' }] } }, { build: { steps: [] } }, { 'a b': { steps: [{ node: ['x.mjs'] }] } }, { build: { steps: [{ node: ['x.mjs', 3] }] } }, { build: { steps: [{ node: ['x.mjs'], command: ['y'] }] } }]) {
      await assert.rejects(loadProject({ root: SAMPLE, config: { actions } }), /map editor config/);
    }
  });
  it('a config file that is missing is an error, not a silent default', async () => {
    await assert.rejects(loadProject({ root: SAMPLE, config: join(SAMPLE, 'nope.config.mjs') }), /no such file/);
  });
});
