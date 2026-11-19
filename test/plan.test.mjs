// The plan and plants.json as text (the same plan always gives the same bytes), and the plant edits the page shares.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatPlan, normalise, formatPlants, plantEditing, NAME } from '../src/plan.mjs';
import { page } from '../src/server.mjs';
import { SAMPLE, samplePlants } from './helpers.mjs';

describe('layout.json as text', () => {
  const text = readFileSync(join(SAMPLE, 'maps', 'plaza', 'layout.json'), 'utf8');
  it('comes back byte for byte when nothing changed', () => { assert.equal(formatPlan(JSON.parse(text)), text); });
  it('keeps its key order whatever order the keys arrive in, one piece a line', () => {
    const plan = JSON.parse(text), shuffled = Object.fromEntries(Object.entries(plan).reverse());
    shuffled.pieces = shuffled.pieces.map((p) => Object.fromEntries(Object.entries(p).reverse()));
    assert.equal(formatPlan(shuffled), text);
    assert.deepEqual(Object.keys(normalise(shuffled)).slice(0, 3), ['id', 'name', 'games']);
    assert.ok(text.includes('    { "id": "crate", "kind": "kit:crate", "at": [2, 2], "rot": 15 },\n'));
  });
  it('a move changes one line', () => {
    const plan = JSON.parse(text);
    plan.pieces.find((p) => p.id === 'crate').at = [2.5, 2];
    const before = text.split('\n'), after = formatPlan(plan).split('\n');
    assert.equal(after.length, before.length);
    assert.equal(after.filter((l, i) => l !== before[i]).length, 1);
  });
  it('keeps sections a project adds, after the known ones', () => {
    const plan = JSON.parse(text); plan.weather = { dust: 0.4 };
    const again = formatPlan(JSON.parse(formatPlan(plan)));
    assert.equal(again, formatPlan(plan));
    assert.ok(again.indexOf('"weather"') > again.indexOf('"things"'));
  });
});

describe('plants.json as text', () => {
  it('comes back byte for byte, whatever order its keys arrive in; exclude after points, at before r', () => {
    const text = readFileSync(join(SAMPLE, 'maps', 'plaza', 'plants.json'), 'utf8');
    assert.equal(formatPlants(JSON.parse(text)), text);
    const s = samplePlants(), shuffled = Object.fromEntries(Object.entries(s).reverse());
    shuffled.points = shuffled.points.map((p) => Object.fromEntries(Object.entries(p).reverse()));
    assert.equal(formatPlants(shuffled), text);
    assert.match(formatPlants({ exclude: [{ r: 0.6, at: [1, 1] }], ...samplePlants() }), /"points": \[[\s\S]*\],\n {2}"exclude": \[\n {4}\{\n {6}"at": \[/);
  });
});

describe('a map\'s name', () => {
  it('is a plain folder name', () => {
    for (const ok of ['plaza', 'a', 'town-2', 'old_town']) assert.ok(NAME.test(ok), ok);
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', 'Plaza', '.git', 'x'.repeat(60), '2town', 'a..b/c', '%2e%2e']) assert.ok(!NAME.test(bad), bad);
  });
});

describe('the plant edits the page shares', () => {
  const kinds = { shrub: ['shrub', 1], flowers: ['flowers', 1], cactus: ['cactus', 1], big_cactus: ['cactus', 1.6] };
  const pointKindOf = { shrub: 'shrub', flowers: 'flowers', cactus: 'cactus' };
  it('a rule-made plant dragged away becomes a point there and an exclusion where it stood; removed, an exclusion only', () => {
    const PE = plantEditing(), opts = { pointKindOf, kinds, r: 0.6 }, plants = samplePlants(), before = formatPlants(plants);
    const it = { kind: 'cactus', at: [10.1234, -7.5], rule: 'edges', rotDeg: 450.4, scale: 1.1 };
    assert.equal(PE.adopt(plants, it, { ...opts, to: [13.25, -7.5] }), 3);
    assert.deepEqual(plants.points[3], { kind: 'cactus', at: [13.25, -7.5], rot: 90, scale: 1.1 });
    assert.deepEqual(plants.exclude, [{ at: [10.123, -7.5], r: 0.6 }]);
    assert.ok(PE.covered(plants, it.at));
    PE.exclude(plants, { kind: 'shrub', at: [20, 20] }, 0.6);
    PE.exclude(plants, { kind: 'shrub', at: [20.2, 20] }, 0.6); // already covered: nothing added
    assert.equal(plants.exclude.length, 2);
    const after = formatPlants(plants).split('\n');
    assert.deepEqual(before.split('\n').filter((l) => !after.includes(l)), []); // only added to
    assert.equal(PE.adopt(plants, { kind: 'bark', at: [0, 0] }, opts), -1); // not a kind a point can take
    // a big cactus (built as cactus at 1.6x) keeps its own name through `source`, and its size without the factor
    const i = PE.adopt(plants, { kind: 'cactus', source: 'big_cactus', at: [1, 1], scale: 1.6 }, opts);
    assert.deepEqual(plants.points[i], { kind: 'big_cactus', at: [1, 1] });
  });
  it('is the page\'s own code: the server writes it in', () => {
    const html = page();
    assert.ok(html.includes(plantEditing.toString()));
    assert.ok(!html.includes('/*@plantEditing*/'));
  });
});
