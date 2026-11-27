// External PBR material discovery, catalogue reading, safe file resolution, and HTTP routes.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMaterialsConfig, readMaterialLibrary, resolveMaterialFile } from '../src/materials.mjs';
import { loadProject } from '../src/project.mjs';
import { createEditor } from '../src/server.mjs';
import { sampleCopy, dataBytes, PNG_1PX } from './helpers.mjs';

const PNG = dataBytes(PNG_1PX);
const KTX2 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('materials discovery and resolution', () => {
  let root, builtDir, srcDir, outside;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'nfgames-mats-'));
    outside = mkdtempSync(join(tmpdir(), 'nfgames-mats-out-'));
    builtDir = join(root, 'web', 'game', 'public', 'look', 'materials');
    srcDir = join(root, 'web', 'game', 'sources', 'materials');
    mkdirSync(join(builtDir, 'whitewash-plaster'), { recursive: true });
    mkdirSync(join(srcDir, 'whitewash-plaster'), { recursive: true });
    mkdirSync(join(srcDir, 'only-source'), { recursive: true });
    mkdirSync(join(root, 'dist', 'materials', 'ignored-set'), { recursive: true });
    mkdirSync(join(root, 'web', 'game', 'src', 'look'), { recursive: true });
    writeFileSync(join(builtDir, 'materials.json'), JSON.stringify({ 'whitewash-plaster': { colour: [0.7, 0.65, 0.55], roughness: 0.85, metal: 0 } }));
    writeFileSync(join(builtDir, 'whitewash-plaster', 'albedo-1k.ktx2'), KTX2);
    writeFileSync(join(builtDir, 'whitewash-plaster', 'normal-1k.ktx2'), KTX2);
    writeFileSync(join(builtDir, 'whitewash-plaster', 'ormh-1k.ktx2'), KTX2);
    writeFileSync(join(builtDir, 'whitewash-plaster', 'albedo.png'), 'not-a-png');
    writeFileSync(join(srcDir, 'whitewash-plaster', 'albedo.png'), PNG);
    writeFileSync(join(srcDir, 'only-source', 'albedo.png'), PNG);
    writeFileSync(join(srcDir, 'only-source', 'orm.png'), PNG);
    writeFileSync(join(root, 'dist', 'materials', 'ignored-set', 'albedo.png'), PNG);
    writeFileSync(join(root, 'web', 'game', 'src', 'look', 'plain.json'), JSON.stringify({ note: 'ignored', 'glow-cyan': { colour: '#55f0e6', glow: 6 }, gold: { colour: '#c9a04a', roughness: 0.35, metal: 1 } }));
    writeFileSync(join(outside, 'albedo.png'), PNG);
    symlinkSync(outside, join(srcDir, 'linked-set'));
    mkdirSync(join(srcDir, 'linked-file'), { recursive: true });
    symlinkSync(join(outside, 'albedo.png'), join(srcDir, 'linked-file', 'albedo.png'));
  });
  after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

  it('auto-discovers built KTX2 folders ahead of source PNG folders, skips dist/, and finds plain.json', () => {
    const cfg = resolveMaterialsConfig(root, undefined, (p) => join(root, p));
    assert.deepEqual(cfg.dirs, [builtDir, srcDir]);
    assert.equal(cfg.plain, join(root, 'web', 'game', 'src', 'look', 'plain.json'));
    const lib = readMaterialLibrary(cfg);
    assert.deepEqual(Object.keys(lib.sets).sort(), ['only-source', 'whitewash-plaster']);
    assert.equal(lib.sets['whitewash-plaster'].albedo, 'albedo-1k.ktx2');
    assert.equal(lib.sets['whitewash-plaster'].orm, 'ormh-1k.ktx2');
    assert.equal(lib.sets['whitewash-plaster'].hasHeight, true);
    assert.deepEqual(lib.sets['whitewash-plaster'].colour, [0.7, 0.65, 0.55]);
    assert.equal(lib.sets['only-source'].albedo, 'albedo.png');
    assert.equal(lib.sets['only-source'].orm, 'orm.png');
    assert.equal(lib.sets['only-source'].hasHeight, undefined);
    assert.equal(lib.plain['glow-cyan'].colour, '#55f0e6');
    assert.equal(lib.plain.gold.metal, 1);
    assert.equal(lib.plain.note, undefined);
  });

  it('resolves valid textures and rejects traversal, symlinks, bad names, and mismatched signatures', () => {
    const cfg = resolveMaterialsConfig(root, undefined, (p) => join(root, p));
    const k = resolveMaterialFile(cfg, 'whitewash-plaster', 'albedo-1k.ktx2');
    assert.equal(k.type, 'image/ktx2');
    assert.equal(k.file, realpathSync(join(builtDir, 'whitewash-plaster', 'albedo-1k.ktx2')));
    const p = resolveMaterialFile(cfg, 'only-source', 'albedo.png');
    assert.equal(p.type, 'image/png');
    assert.equal(p.file, realpathSync(join(srcDir, 'only-source', 'albedo.png')));
    // builtDir has a fake albedo.png, so resolution skips it and falls through to srcDir's real PNG
    assert.equal(resolveMaterialFile(cfg, 'whitewash-plaster', 'albedo.png').file, realpathSync(join(srcDir, 'whitewash-plaster', 'albedo.png')));
    for (const [set, file] of [
      ['../outside', 'albedo.png'], ['linked-set', 'albedo.png'], ['linked-file', 'albedo.png'],
      ['whitewash-plaster', 'materials.json'], ['whitewash-plaster', '../materials.json'],
      ['.hidden', 'albedo.png'], ['only-source', 'missing.png'], ['', 'albedo.png'],
    ]) assert.equal(resolveMaterialFile(cfg, set, file), null, `${set}/${file}`);
  });

  it('honours materials: false and rejects paths outside the project root', async () => {
    const p = await loadProject({ root, config: { materials: false } });
    assert.deepEqual(readMaterialLibrary(p.materials), { sets: {}, plain: {} });
    await assert.rejects(loadProject({ root, config: { materials: '../elsewhere' } }), /"materials" must be a folder inside the project/);
  });
});

describe('materials HTTP routes', () => {
  const port = 19893 + (process.pid % 400), origin = `http://127.0.0.1:${port}`;
  let copy, server;
  before(async () => {
    copy = sampleCopy();
    mkdirSync(join(copy.root, 'materials', 'stone'), { recursive: true });
    writeFileSync(join(copy.root, 'materials', 'stone', 'albedo.png'), PNG);
    writeFileSync(join(copy.root, 'plain.json'), JSON.stringify({ lamp: { colour: '#ffaa44', glow: 5 } }));
    const project = await loadProject({ root: copy.root, config: { models: 'models' } });
    server = createEditor(project, { port, defaultMap: 'plaza' });
    await new Promise((done) => server.listen(port, '127.0.0.1', done));
  });
  after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); copy.done(); });

  it('serves /api/materials and /api/material/file safely', async () => {
    const lib = await (await fetch(`${origin}/api/materials`)).json();
    assert.equal(lib.sets.stone.albedo, 'albedo.png');
    assert.equal(lib.plain.lamp.colour, '#ffaa44');
    const r = await fetch(`${origin}/api/material/file?set=stone&file=albedo.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
    assert.equal((await fetch(`${origin}/api/material/file?set=..&file=plain.json`)).status, 404);
    assert.equal((await fetch(`${origin}/api/material/file?set=stone&file=nope.png`)).status, 404);
  });
});
