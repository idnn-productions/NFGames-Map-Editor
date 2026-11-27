// The match routes: measuring a model in the background, the pictures it makes, a loop job from the page, the slider's last values.
// A stand-in `blender` (a Node script) is first on the PATH, so the real command line is what runs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { createEditor } from '../src/server.mjs';
import { sampleCopy, makeGlb, dataBytes, fakeCommand, PNG_1PX } from './helpers.mjs';

const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(a[a.length - 1], 'utf8'));
if (a[0] !== '-b' || a[1] !== '--factory-startup' || a[2] !== '--python' || a[4] !== '--') { console.error('unexpected arguments ' + a.join(' ')); process.exit(3); }
const views = {}, png = Buffer.from('${PNG_1PX.split(',')[1]}', 'base64');
console.log('PROGRESS 1/2 scoring');
for (const v of Object.keys(s.refs)) { views[v] = { silhouette: 0.8, colour: 0.7, combined: 0.76, background: 'flat', refExtent: v === 'front' ? [400, 200] : v === 'left' ? [300, 200] : [400, 300], modelExtent: [1, 1], planUp: null, overlay: 'overlay-' + v + '.png', render: 'render-' + v + '.png' }; fs.writeFileSync(path.join(s.outDir, 'overlay-' + v + '.png'), png); }
fs.writeFileSync(s.result, JSON.stringify({ ok: true, blender: 'fake', views, size: [1, 1, 1], mean: { silhouette: 0.8, colour: 0.7, combined: 0.76 }, orientation: { up: '+Y', turn: 0, tried: [] }, warnings: [] }));
`;

describe('matching over HTTP', () => {
  const port = 24393 + (process.pid % 500), origin = `http://127.0.0.1:${port}`;
  let copy, server, editorRoot, undo;
  const ask = (path, options = {}) => fetch(`${origin}${path}`, options);
  const post = (path, body, headers = { 'Content-Type': 'application/json', Origin: origin }) => ask(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const until = async (path, state) => { for (let i = 0; i < 100; i++) { const s = await (await ask(path)).json(); if (s.state === state) return s; await new Promise((ok) => setTimeout(ok, 50)); } throw new Error(`never ${state}`); };

  before(async () => {
    copy = sampleCopy(); const dir = mkdtempSync(join(tmpdir(), 'nfgames-fake-blender-'));
    undo = fakeCommand(dir, 'blender', FAKE);
    mkdirSync(join(copy.root, 'models', 'cruiser.refs'), { recursive: true });
    writeFileSync(join(copy.root, 'models', 'cruiser.glb'), makeGlb()); writeFileSync(join(copy.root, 'models', 'bare.glb'), makeGlb());
    for (const n of ['concept', 'front', 'left', 'top']) writeFileSync(join(copy.root, 'models', 'cruiser.refs', `${n}.png`), dataBytes(PNG_1PX));
    editorRoot = mkdtempSync(join(tmpdir(), 'nfgames-editor-root-'));
    server = createEditor(await loadProject({ root: copy.root, config: { models: 'models' } }), { port, defaultMap: 'plaza', editorRoot });
    await new Promise((done) => server.listen(port, '127.0.0.1', done));
  });
  after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); undo(); copy.done(); rmSync(editorRoot, { recursive: true, force: true }); });

  it('lists what can be measured, and nothing before it is asked for', async () => {
    const s = await (await ask('/api/model/match?path=cruiser.glb')).json();
    assert.equal(s.state, 'idle'); assert.deepEqual(s.views, ['front', 'left', 'top']); assert.equal(s.blender.found, true);
    const bare = await (await ask('/api/model/match?path=bare.glb')).json(); assert.equal(bare.state, 'no-views');
    assert.equal((await ask('/api/model/match?path=nope.glb')).status, 400); assert.equal((await ask('/api/model/match')).status, 400);
  });
  it('is asked from this page only; a model with nothing to match against is refused', async () => {
    assert.equal((await post('/api/model/match', { path: 'cruiser.glb' }, { 'Content-Type': 'text/plain', Origin: origin })).status, 403);
    assert.equal((await post('/api/model/match', { path: 'cruiser.glb' }, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    const none = await post('/api/model/match', { path: 'bare.glb' }); assert.equal(none.status, 400); assert.match((await none.json()).error, /no front, back, left, right, top or bottom reference/);
    for (const bad of ['../outside.glb', '../maps/plaza/layout.json', '/etc/passwd', 'cruiser.glb/../../x.glb', '']) assert.equal((await post('/api/model/match', { path: bad })).status, 400, bad);
  });
  it('measures in the background, and serves the pictures it made, only those', async () => {
    const started = await post('/api/model/match', { path: 'cruiser.glb' }); assert.equal(started.status, 200);
    const done = await until('/api/model/match?path=cruiser.glb', 'done');
    assert.equal(done.result.mean.combined, 0.76); assert.equal(done.result.consistency.checked, true); assert.deepEqual(Object.keys(done.result.views), ['front', 'left', 'top']);
    const img = await ask(`/api/model/match/image?key=${done.key}&name=overlay-front.png`);
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await img.arrayBuffer()), dataBytes(PNG_1PX));
    for (const q of [`key=${done.key}&name=result.json`, `key=${done.key}&name=..%2Fresult.json`, `key=..&name=overlay-front.png`, `key=${done.key}&name=overlay-back.png`, 'name=overlay-front.png', `key=${done.key}`])
      assert.equal((await ask(`/api/model/match/image?${q}`)).status, 404, q);
    const again = await post('/api/model/match', { path: 'cruiser.glb' }); assert.equal((await again.json()).state, 'done', 'a second ask is answered from the cache');
  });
  it('sends a loop job, and the slider\'s value comes back as it was kept', async () => {
    const job = { model: 'cruiser.glb', workflow: 'blender', match: { target: 0.857, maxRounds: 7, plateau: 0.02, score: 'silhouette' } };
    assert.equal((await post('/api/review', { ...job, match: { ...job.match, target: 1.2 } })).status, 400);
    const r = await post('/api/review', job); assert.equal(r.status, 200);
    const { id } = await r.json(), written = JSON.parse(readFileSync(join(copy.root, '.review', id, 'job.json'), 'utf8'));
    assert.equal(written.match.target, 0.86); assert.equal(written.match.baseline.mean, 0.8); assert.equal(written.match.baseline.scores.front.combined, 0.76);
    const listed = (await (await ask('/api/reviews')).json()).reviews.find((j) => j.id === id);
    assert.deepEqual(listed.match, { target: 0.86, maxRounds: 7, plateau: 0.02, score: 'silhouette', views: ['front', 'left', 'top'] }); assert.deepEqual(listed.rounds, []);
    const viewer = await (await ask('/api/viewer')).json();
    assert.deepEqual(viewer.match.last, { target: 0.86, maxRounds: 7, plateau: 0.02, score: 'silhouette' }); assert.equal(viewer.match.limits.target.min, 0.5); assert.equal(viewer.match.limits.target.max, 0.99);
  });
  it('keeps the slider\'s values when they are set, and refuses ones off the slider', async () => {
    assert.equal((await post('/api/match/settings', { target: 0.995 })).status, 400);
    assert.equal((await post('/api/match/settings', { target: 0.7 }, { 'Content-Type': 'text/plain', Origin: origin })).status, 403);
    const ok = await post('/api/match/settings', { target: 0.7, maxRounds: 3, plateau: '', score: 'combined' });
    assert.deepEqual(await ok.json(), { target: 0.7, maxRounds: 3, plateau: null, score: 'combined' });
    assert.deepEqual((await (await ask('/api/viewer')).json()).match.last, { target: 0.7, maxRounds: 3, plateau: null, score: 'combined' });
  });
  it('says plainly when Blender is not there', async () => {
    const p2 = port + 1, o2 = `http://127.0.0.1:${p2}`;
    const s2 = createEditor(await loadProject({ root: copy.root, config: { models: 'models', blender: join(copy.root, 'no-blender-here') } }), { port: p2, defaultMap: 'plaza', editorRoot });
    await new Promise((done) => s2.listen(p2, '127.0.0.1', done));
    try {
      const s = await (await fetch(`${o2}/api/model/match?path=cruiser.glb`)).json(); assert.equal(s.blender.found, false); assert.match(s.blender.text, /Blender was not found at/);
      writeFileSync(join(copy.root, 'models', 'cruiser.refs', 'top.png'), Buffer.concat([dataBytes(PNG_1PX), Buffer.alloc(1)]));   // not cached any more
      const r = await fetch(`${o2}/api/model/match`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o2 }, body: JSON.stringify({ path: 'cruiser.glb' }) });
      assert.equal(r.status, 409); assert.match((await r.json()).error, /Blender was not found at/);
    } finally { s2.closeAllConnections(); await new Promise((done) => s2.close(done)); }
  });
});
