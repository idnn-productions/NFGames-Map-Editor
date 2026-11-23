// The model viewer's routes: its page, three.js only once installed (and only when the download matches), models only
// from the models folder, review jobs only from this page.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { createEditor } from '../src/server.mjs';
import { sampleCopy, makeGlb, JPEG_SIG } from './helpers.mjs';

describe('the model viewer over HTTP', () => {
  const port = 19393 + (process.pid % 500), origin = `http://127.0.0.1:${port}`;
  let copy, server, editorRoot, fetched = 0;
  const ask = (path, options = {}) => fetch(`${origin}${path}`, options);
  const post = (path, body, headers = { 'Content-Type': 'application/json', Origin: origin }) => ask(path, { method: 'POST', headers, body: JSON.stringify(body) });

  before(async () => {
    copy = sampleCopy();
    mkdirSync(join(copy.root, 'models'), { recursive: true });
    writeFileSync(join(copy.root, 'models', 'cruiser.glb'), makeGlb());
    editorRoot = mkdtempSync(join(tmpdir(), 'nfgames-editor-root-'));
    const project = await loadProject({ root: copy.root, config: { models: 'models' } });
    const fetchImpl = async () => { fetched++; return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; };
    server = createEditor(project, { port, defaultMap: 'plaza', editorRoot, fetchImpl });
    await new Promise((done) => server.listen(port, '127.0.0.1', done));
  });
  // a review refused for its size leaves its upload's connection open, and close() alone would wait for it for ever
  after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); copy.done(); rmSync(editorRoot, { recursive: true, force: true }); });

  it('serves the viewer page with the import map written in', async () => {
    const r = await ask('/viewer');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /"three":"\/vendor\/three-[\d.]+\/build\/three\.module\.js"/);
  });
  it('the page loads the folding list, which is served as a script', async () => {
    assert.match(await (await ask('/viewer')).text(), /<script src="\/shell\/tree\.js">/);
    const r = await ask('/shell/tree.js');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  });
  it('the page lends its parts by region; the one-column way of lending is gone', async () => {
    assert.match(await (await ask('/viewer')).text(), /nfLend\(\{ side:/);
    assert.doesNotMatch(await (await ask('/shell/lend.js')).text(), /nfLendPanel|__nfPanel/);
  });
  it('says three.js is not installed, and serves none of it', async () => {
    const v = await (await ask('/api/viewer')).json();
    assert.equal(v.three.installed, false); assert.equal(v.models, 'models'); assert.equal(v.workflows[0].id, 'auto');
    assert.equal((await ask(`${v.three.base}build/three.module.js`)).status, 404);
  });
  it('installs only from this page, and nothing when the download does not match', async () => {
    assert.equal((await post('/api/vendor/install', {}, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    assert.equal(fetched, 0);
    const r = await post('/api/vendor/install', {});
    assert.equal(r.status, 502); assert.match((await r.json()).error, /does not match/);
    assert.equal(fetched, 1); assert.deepEqual(readdirSync(editorRoot), []);
  });
  it('lists and streams models, nothing else', async () => {
    assert.deepEqual((await (await ask('/api/models')).json()).models.map((m) => m.path), ['cruiser.glb']);
    const r = await ask('/api/model?path=cruiser.glb');
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(Buffer.from(await r.arrayBuffer()).length, makeGlb().length);
    for (const bad of ['../maps/plaza/layout.json', '..%2Fmaps%2Fplaza%2Flayout.json', 'nope.glb', '']) assert.equal((await ask(`/api/model?path=${bad}`)).status, 404, bad);
  });
  it('takes a review from this page only, and lists it', async () => {
    const job = { model: 'cruiser.glb', workflow: 'auto', note: 'check the nose', pins: [{ note: 'x', position: [0, 0, 0], normal: [0, 1, 0], camera: { position: [1, 1, 1], target: [0, 0, 0], fov: 50 }, screenshot: JPEG_SIG }] };
    assert.equal((await post('/api/review', job, { 'Content-Type': 'text/plain', Origin: origin })).status, 403);
    const r = await post('/api/review', job);
    assert.equal(r.status, 200);
    const { id } = await r.json(), list = (await (await ask('/api/reviews')).json()).reviews;
    assert.equal(list[0].id, id); assert.equal(list[0].state, 'queued');
    assert.equal((await post('/api/review', { ...job, workflow: 'comfyui' })).status, 400);
  });
  it('a review may be bigger than 2 MB, but not than 24 MB; other routes keep 2 MB', async () => {
    const big = (mb) => ({ model: 'cruiser.glb', workflow: 'auto', note: 'x', padding: 'y'.repeat(mb * 1024 * 1024) });
    assert.equal((await post('/api/review', big(3))).status, 200);
    assert.equal((await post('/api/review', big(25))).status, 413);
    assert.equal((await post('/api/save', { padding: 'y'.repeat(3 * 1024 * 1024) })).status, 413);
  });
});
