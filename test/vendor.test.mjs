// three.js on demand: only the pinned version, only when its bytes match the pinned hash, only the allow-listed files.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarEntries, extractAllowed, integrityOf, installThree, vendorState, vendorFile, THREE } from '../src/vendor.mjs';
import { makeTar, makeTgz } from './helpers.mjs';

const FAKE = { version: '9.9.9', tarball: 'https://registry.example/three-9.9.9.tgz', size: 1, files: ['build/three.module.js', 'examples/jsm/libs/draco/gltf/draco_decoder.wasm'] };
const pkg = () => makeTgz({ 'package/build/three.module.js': 'export const REVISION = "999";', 'package/examples/jsm/libs/draco/gltf/draco_decoder.wasm': Buffer.from([0, 97, 115, 109]), 'package/src/Three.js': 'not wanted' });
const respond = (buf, ok = true) => async () => ({ ok, status: ok ? 200 : 404, statusText: ok ? 'OK' : 'Not Found', arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });

describe('the tar reader', () => {
  it('reads regular files with their names and bytes', () => {
    const got = [...tarEntries(makeTar({ 'package/a.txt': 'hello', 'package/dir/b.bin': Buffer.alloc(700, 7) }))];
    assert.deepEqual(got.map((e) => e.name), ['package/a.txt', 'package/dir/b.bin']);
    assert.equal(got[0].data.toString(), 'hello'); assert.equal(got[1].data.length, 700);
  });
  it('keeps only the allow-listed files, and says which are missing', () => {
    assert.deepEqual([...extractAllowed(pkg(), FAKE.files).keys()].sort(), [...FAKE.files].sort());
    assert.throws(() => extractAllowed(pkg(), [...FAKE.files, 'build/three.core.js']), /lacks build\/three\.core\.js/);
  });
});

describe('installing three.js', () => {
  let editorRoot;
  before(() => { editorRoot = mkdtempSync(join(tmpdir(), 'nfgames-vendor-')); });
  after(() => rmSync(editorRoot, { recursive: true, force: true }));

  it('the pinned version lists what the viewer imports', () => {
    for (const f of ['build/three.module.js', 'build/three.core.js', 'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/loaders/FBXLoader.js', 'examples/jsm/curves/NURBSCurve.js', 'examples/jsm/curves/NURBSUtils.js', 'examples/jsm/libs/fflate.module.js', 'examples/jsm/loaders/DRACOLoader.js', 'examples/jsm/controls/OrbitControls.js']) assert.ok(THREE.files.includes(f), f);
    assert.match(THREE.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
  });
  it('a download that does not match the pinned hash installs nothing', async () => {
    const t = { ...FAKE, integrity: 'sha512-AAAA' };
    await assert.rejects(installThree(editorRoot, { fetchImpl: respond(pkg()), t }), /does not match/);
    assert.equal(vendorState(editorRoot, t).installed, false);
    assert.deepEqual(readdirSync(editorRoot), []);
  });
  it('a failed download installs nothing', async () => {
    const t = { ...FAKE, integrity: integrityOf(pkg()) };
    await assert.rejects(installThree(editorRoot, { fetchImpl: respond(Buffer.alloc(0), false), t }), /download failed: 404/);
    assert.equal(vendorState(editorRoot, t).installed, false);
  });
  it('installs the allow-listed files and serves only those', async () => {
    const tgz = pkg(), t = { ...FAKE, integrity: integrityOf(tgz) };
    assert.equal((await installThree(editorRoot, { fetchImpl: respond(tgz), t })).installed, true);
    const dir = join(editorRoot, 'vendor', 'three-9.9.9');
    assert.equal(readFileSync(join(dir, 'build', 'three.module.js'), 'utf8'), 'export const REVISION = "999";');
    assert.ok(!existsSync(join(dir, 'src', 'Three.js')));
    assert.ok(!existsSync(`${dir}.tmp`));
    assert.deepEqual(vendorFile(editorRoot, '/vendor/three-9.9.9/build/three.module.js', t), { file: join(dir, 'build', 'three.module.js'), type: 'text/javascript; charset=utf-8' });
    assert.equal(vendorFile(editorRoot, '/vendor/three-9.9.9/examples/jsm/libs/draco/gltf/draco_decoder.wasm', t).type, 'application/wasm');
    for (const bad of ['/vendor/three-9.9.9/src/Three.js', '/vendor/three-9.9.9/../../package.json', '/vendor/three-9.9.8/build/three.module.js', '/vendor/three-9.9.9/.complete', '/elsewhere'])
      assert.equal(vendorFile(editorRoot, bad, t), null, bad);
    // an older install missing a newly added allow-listed file reports installed: false until refreshed
    assert.equal(vendorState(editorRoot, { ...t, files: [...t.files, 'examples/jsm/loaders/FBXLoader.js'] }).installed, false);
  });
  it('one install at a time', async () => {
    const tgz = pkg(), t = { ...FAKE, version: '9.9.10', integrity: integrityOf(tgz) };
    const a = installThree(editorRoot, { fetchImpl: respond(tgz), t }), b = installThree(editorRoot, { fetchImpl: respond(tgz), t });
    assert.equal(a, b); await a;
  });
});
