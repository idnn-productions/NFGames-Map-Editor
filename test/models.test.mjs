// The viewer's models: every .glb under the project's models folder, and nothing a request can reach outside it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listModels, resolveModel } from '../src/models.mjs';
import { makeGlb } from './helpers.mjs';

describe('models', () => {
  let root, dir, outside;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'nfgames-models-'));
    dir = join(root, 'models'); outside = join(root, 'secret');
    mkdirSync(join(dir, 'ships'), { recursive: true }); mkdirSync(join(dir, '.cache'), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(dir, 'ships', 'cruiser.glb'), makeGlb());
    writeFileSync(join(dir, 'crate.GLB'), makeGlb());
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, '.cache', 'hidden.glb'), makeGlb());
    writeFileSync(join(outside, 'leak.glb'), makeGlb());
    symlinkSync(outside, join(dir, 'link'));
    symlinkSync(join(outside, 'leak.glb'), join(dir, 'leak.glb'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('lists .glb files in subfolders, skipping dot-folders, other files and symlinks', () => {
    const list = listModels(dir);
    assert.deepEqual(list.map((m) => m.path), ['crate.GLB', 'ships/cruiser.glb']);
    assert.equal(list[1].size, makeGlb().length); assert.ok(list[1].mtime > 0);
  });
  it('a missing folder lists nothing', () => assert.deepEqual(listModels(join(root, 'nope')), []));
  it('resolves a model inside the folder', () => assert.equal(resolveModel(dir, 'ships/cruiser.glb'), realpathSync(join(dir, 'ships', 'cruiser.glb'))));
  it('refuses paths that leave the folder, or are not .glb files', () => {
    for (const bad of ['../secret/leak.glb', 'link/leak.glb', 'leak.glb', join(outside, 'leak.glb'), 'notes.txt', 'ships', 'ships/missing.glb', '', 'a\0.glb', null, 42, `${'x'.repeat(600)}.glb`])
      assert.equal(resolveModel(dir, bad), null, String(bad));
    assert.equal(resolveModel(null, 'crate.GLB'), null);
  });
});
