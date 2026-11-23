// The folding list's logic, without a page: grouping by folder, counts, joined chains, closed folders, the filter.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/shell/tree.js');
const { nfTree } = globalThis;
const items = (...paths) => paths.map((path) => ({ path }));

describe('the folding list', () => {
  it('groups by folder, counts, and joins a chain of single folders', () => {
    const t = nfTree.build(items('art/town/c.glb', 'web/run/public/models/a.glb', 'web/run/public/models/b.glb'), {});
    assert.deepEqual(t.map((n) => [n.label, n.count]), [['art/town', 1], ['web/run/public/models', 2]]);
    assert.deepEqual(t[1].children.map((n) => n.label), ['a.glb', 'b.glb']);
    assert.equal(t[1].path, 'web/run/public/models');
  });
  it('nests folders that hold items and folders', () => {
    const t = nfTree.build(items('art/a.glb', 'art/town/b.glb'), {});
    assert.equal(t[0].label, 'art'); assert.equal(t[0].count, 2);
    assert.deepEqual(t[0].children.map((n) => n.type), ['folder', 'item']);
  });
  it('closed folders are closed; a filter opens matches and drops the rest', () => {
    const closed = new Set(['art']);
    assert.equal(nfTree.build(items('art/a.glb', 'kit/b.glb'), { closed })[0].open, false);
    assert.equal(nfTree.build(items('art/a.glb', 'kit/b.glb'), { closed })[1].open, true);
    const f = nfTree.build(items('art/a.glb', 'kit/b.glb'), { closed, filter: 'A.GL' });
    assert.deepEqual(f.map((n) => [n.label, n.open, n.count]), [['art', true, 1]]);
  });
  it('the filter also looks in an item\'s search text', () => {
    const f = nfTree.build([{ path: 'Buildings/house', search: 'kit:house_4x4' }, { path: 'Buildings/hall' }], { filter: 'kit:' });
    assert.deepEqual(f[0].children.map((n) => n.label), ['house']);
  });
  it('top-level items come through without a folder', () => {
    assert.deepEqual(nfTree.build(items('a.glb'), {}).map((n) => n.type), ['item']);
  });
  it('folders keep the order their first item came in', () => {
    assert.deepEqual(nfTree.build(items('Zed/a', 'Alpha/b', 'Zed/c'), {}).map((n) => [n.label, n.count]), [['Zed', 2], ['Alpha', 1]]);
  });
  it('5000 items build in under 50 ms', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i % 50}/g${i % 7}/m${i}.glb` }));
    const t0 = performance.now(); nfTree.build(many, { filter: 'm49' }); assert.ok(performance.now() - t0 < 50);
  });
  it('a store without localStorage still remembers for the page\'s life', () => {
    const s = nfTree.store('test'); s.toggle('art', false); assert.ok(s.closed.has('art')); s.toggle('art', true); assert.ok(!s.closed.has('art'));
  });
});
