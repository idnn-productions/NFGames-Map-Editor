// The viewer's models: every .glb under the project's models folder, and nothing a request can reach outside it.
// A model's reference images: the image files of <name>.refs/ beside it, in their order, and nothing else.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIEWER_EXTENSIONS, listModels, resolveModel, listRefs, modelRefs, resolveRef, REF_LIMITS } from '../src/models.mjs';
import { makeGlb, makeFbx, dataBytes, PNG_1PX, JPEG_SIG, WEBP_SIG } from './helpers.mjs';

describe('models', () => {
  let root, dir, outside, top;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'nfgames-models-'));
    dir = join(root, 'models'); outside = join(root, 'secret');
    mkdirSync(join(dir, 'ships'), { recursive: true }); mkdirSync(join(dir, '.cache'), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(dir, 'ships', 'cruiser.glb'), makeGlb());
    writeFileSync(join(dir, 'crate.GLB'), makeGlb());
    writeFileSync(join(dir, 'rig.fbx'), makeFbx());
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, '.cache', 'hidden.glb'), makeGlb());
    writeFileSync(join(outside, 'leak.glb'), makeGlb());
    symlinkSync(outside, join(dir, 'link'));
    symlinkSync(join(outside, 'leak.glb'), join(dir, 'leak.glb'));
    // a game's folder: the same model in its source folders, and copies of it where builds and caches put them
    top = join(root, 'game');
    for (const f of ['a/x.glb', 'web/dist/x.glb', 'web/.cache/x.glb', 'web/node_modules/p/x.glb', 'web/build/x.glb', 'web/out/x.glb', 'unity/Library/x.glb', 'unity/Temp/x.glb', 'art/raw/x.glb', 'art/town/t.glb']) {
      mkdirSync(join(top, f, '..'), { recursive: true }); writeFileSync(join(top, f), makeGlb());
    }
    writeFileSync(join(top, 'art/town/T.JSON'), '{}');   // the level's own data, whatever the case of its name
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('lists .glb files in subfolders, skipping dot-folders, other files and symlinks', () => {
    const list = listModels(dir);
    assert.deepEqual(list.map((m) => m.path), ['crate.GLB', 'ships/cruiser.glb']);
    assert.equal(list[1].size, makeGlb().length); assert.ok(list[1].mtime > 0);
  });
  it('skips build and cache copies at any depth, and the folders it is told to', () => {
    const all = { copies: false };   // a whole project is searched without its builds' and caches' copies
    assert.deepEqual(listModels(top, all).map((m) => m.path), ['a/x.glb', 'art/raw/x.glb', 'art/town/t.glb']);
    assert.deepEqual(listModels(top, { ...all, skip: ['art/raw'] }).map((m) => m.path), ['a/x.glb', 'art/town/t.glb']);
    assert.deepEqual(listModels(top, { ...all, skip: ['art'] }).map((m) => m.path), ['a/x.glb']);
    // a models folder is listed as it always was: a folder in it called build or out is the project's own
    assert.deepEqual(listModels(top).map((m) => m.path), ['a/x.glb', 'art/raw/x.glb', 'art/town/t.glb', 'unity/Library/x.glb', 'unity/Temp/x.glb', 'web/build/x.glb', 'web/dist/x.glb', 'web/out/x.glb']);
  });
  it('a model with a .json of its name beside it is a level, and so is one the config names', () => {
    const by = Object.fromEntries(listModels(top, { copies: false, levels: ['a/x.glb'] }).map((m) => [m.path, m.level]));
    assert.deepEqual(by, { 'a/x.glb': true, 'art/raw/x.glb': undefined, 'art/town/t.glb': true });
    assert.equal('level' in listModels(top).find((m) => m.path === 'a/x.glb'), false);
  });
  it('a missing folder lists nothing', () => assert.deepEqual(listModels(join(root, 'nope')), []));
  it('resolves a model inside the folder', () => assert.equal(resolveModel(dir, 'ships/cruiser.glb'), realpathSync(join(dir, 'ships', 'cruiser.glb'))));
  it('lists and resolves .fbx files when given VIEWER_EXTENSIONS, while default stays .glb only', () => {
    assert.deepEqual(listModels(dir, { extensions: VIEWER_EXTENSIONS }).map((m) => m.path), ['crate.GLB', 'rig.fbx', 'ships/cruiser.glb']);
    assert.equal(resolveModel(dir, 'rig.fbx'), null);
    assert.equal(resolveModel(dir, 'rig.fbx', { extensions: VIEWER_EXTENSIONS }), realpathSync(join(dir, 'rig.fbx')));
  });
  it('refuses paths that leave the folder, or are not .glb files', () => {
    for (const bad of ['../secret/leak.glb', 'link/leak.glb', 'leak.glb', join(outside, 'leak.glb'), 'notes.txt', 'ships', 'ships/missing.glb', '', 'a\0.glb', null, 42, `${'x'.repeat(600)}.glb`])
      assert.equal(resolveModel(dir, bad), null, String(bad));
    assert.equal(resolveModel(null, 'crate.GLB'), null);
  });
});

describe('reference images', () => {
  const PNG = dataBytes(PNG_1PX), JPG = dataBytes(JPEG_SIG);
  let root, dir, outside, refs;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'nfgames-refs-'));
    dir = join(root, 'models'); outside = join(root, 'secret'); refs = join(dir, 'ships', 'cruiser.refs');
    mkdirSync(refs, { recursive: true }); mkdirSync(join(refs, 'sub.png')); mkdirSync(join(dir, 'many.refs')); mkdirSync(join(dir, 'ghost.refs')); mkdirSync(outside);
    for (const name of ['ships/cruiser.glb', 'ships/linked.glb', 'crate.GLB', 'many.glb']) writeFileSync(join(dir, name), makeGlb());
    // written out of order, in mixed case: the list puts them in theirs
    for (const [name, bytes] of [['zeta.png', PNG], ['back.jpg', JPG], ['Top.PNG', PNG], ['alpha.jpeg', JPG], ['three-quarter.png', PNG], ['left.webp', WEBP_SIG], ['front.png', PNG], ['concept.png', PNG], ['right.png', PNG], ['bottom.jpg', JPG]]) writeFileSync(join(refs, name), bytes);
    // none of these is a reference: not an image by name, hidden, not the image its name says, a link, a folder, too big
    writeFileSync(join(refs, 'notes.txt'), 'x'); writeFileSync(join(refs, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'); writeFileSync(join(refs, '.hidden.png'), PNG);
    writeFileSync(join(refs, 'fake.png'), '<html>'); writeFileSync(join(refs, 'wrong.jpg'), PNG);
    writeFileSync(join(outside, 'leak.png'), PNG); symlinkSync(join(outside, 'leak.png'), join(refs, 'link.png'));
    writeFileSync(join(refs, 'huge.png'), PNG); truncateSync(join(refs, 'huge.png'), REF_LIMITS.size + 1);
    symlinkSync(outside, join(dir, 'ships', 'linked.refs'), 'junction');   // a .refs folder that is a link out of the models folder
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, 'many.refs', `view-${String(i).padStart(2, '0')}.png`), PNG);
    writeFileSync(join(dir, 'ghost.refs', 'front.png'), PNG);             // a .refs folder with no model beside it
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('lists the concept first, then the views in their order, then the rest by name', () => {
    const list = listRefs(dir, 'ships/cruiser.glb');
    assert.deepEqual(list.map((r) => r.name), ['concept.png', 'front.png', 'left.webp', 'back.jpg', 'right.png', 'Top.PNG', 'bottom.jpg', 'three-quarter.png', 'alpha.jpeg', 'zeta.png']);
    assert.deepEqual(Object.keys(list[0]), ['name', 'size', 'mtime']); assert.equal(list[0].size, PNG.length); assert.ok(list[0].mtime > 0);
  });
  it('no .refs folder, no such model, a .refs folder that is a link: nothing', () => {
    for (const model of ['crate.GLB', 'ships/missing.glb', 'ghost.glb', 'ships/linked.glb', '../secret/leak.glb', 'ships/cruiser.refs', '', null]) assert.deepEqual(listRefs(dir, model), [], String(model));
    assert.deepEqual(listRefs(null, 'ships/cruiser.glb'), []);
  });
  it(`lists at most ${REF_LIMITS.count}`, () => assert.equal(listRefs(dir, 'many.glb').length, REF_LIMITS.count));
  it('resolves a reference to its file and type', () => {
    const r = resolveRef(dir, 'ships/cruiser.glb', 'back.jpg');
    assert.equal(r.file, join(realpathSync(refs), 'back.jpg')); assert.equal(r.type, 'image/jpeg'); assert.equal(r.size, JPG.length);
    assert.equal(resolveRef(dir, 'ships/cruiser.glb', 'left.webp').type, 'image/webp'); assert.equal(resolveRef(dir, 'ships/cruiser.glb', 'Top.PNG').type, 'image/png');
    assert.equal(modelRefs(dir, 'ships/cruiser.glb')[0].file, join(realpathSync(refs), 'concept.png'));
  });
  it('refuses names that are not a plain image file of that folder', () => {
    for (const bad of ['../cruiser.glb', '../../crate.GLB', '..\\..\\crate.GLB', 'sub/x.png', 'sub.png', '/etc/passwd', 'C:\\x.png', 'c:front.png', 'front.png\0.jpg', 'a\0.png', '.hidden.png', '..', '.', '',
      'notes.txt', 'icon.svg', 'fake.png', 'wrong.jpg', 'link.png', 'huge.png', 'missing.png', 'top.png', 'front', 'front.png/', `${'x'.repeat(200)}.png`, null, undefined, 42, ['front.png']])
      assert.equal(resolveRef(dir, 'ships/cruiser.glb', bad), null, String(bad));
  });
  it('refuses a reference of a model outside the folder, or of a linked .refs folder', () => {
    for (const model of ['../secret/leak.glb', 'ships/linked.glb', 'ships/missing.glb', 'ships', '', null]) assert.equal(resolveRef(dir, model, 'front.png'), null, String(model));
    assert.equal(resolveRef(dir, 'ships/linked.glb', 'leak.png'), null);
    assert.equal(resolveRef(dir, 'ghost.glb', 'front.png'), null);
  });
});
