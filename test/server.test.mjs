// The editor's server: the security model (loopback, Host, Origin and JSON for writes, plain map names, its one page
// and API), Save (schema check, atomic write, .prev.json backup, a file changed on disk is not overwritten) and the
// Apply actions (fixed commands only).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { createEditor, hostAllowed, writeAllowed } from '../src/server.mjs';
import { formatPlan } from '../src/plan.mjs';
import { sampleCopy } from './helpers.mjs';

describe('the rules', () => {
  it('answers only to its own loopback address', () => {
    assert.ok(hostAllowed('127.0.0.1:8793', 8793));
    assert.ok(hostAllowed('localhost:8793', 8793));
    for (const host of ['evil.example:8793', '192.168.1.20:8793', '127.0.0.1:8792', '127.0.0.1', '0.0.0.0:8793', undefined, '127.0.0.1:8793.evil.example', '[::1]:8793']) assert.ok(!hostAllowed(host, 8793), String(host));
  });
  it('takes a write only from its own page, as JSON', () => {
    const ok = { host: '127.0.0.1:8793', origin: 'http://127.0.0.1:8793', 'content-type': 'application/json' };
    assert.ok(writeAllowed(ok, 8793));
    assert.ok(writeAllowed({ ...ok, 'content-type': 'application/json; charset=utf-8' }, 8793));
    assert.ok(!writeAllowed({ ...ok, origin: 'http://evil.example' }, 8793));
    assert.ok(!writeAllowed({ ...ok, origin: 'http://localhost:8793' }, 8793)); // the Origin must be the Host it was sent to
    assert.ok(!writeAllowed({ ...ok, origin: undefined }, 8793));
    assert.ok(!writeAllowed({ ...ok, 'content-type': 'text/plain' }, 8793));
    assert.ok(!writeAllowed({ ...ok, host: 'evil.example:8793', origin: 'http://evil.example:8793' }, 8793));
  });
});

describe('over HTTP', () => {
  const port = 18793 + (process.pid % 500);
  let copy, project, server;
  const origin = `http://127.0.0.1:${port}`;
  const ask = (path, options = {}) => fetch(`${origin}${path}`, options);
  const write = (path, body, headers = { 'Content-Type': 'application/json', Origin: origin }) => ask(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  // Node's fetch will not send another Host, so that one goes by hand
  const withHost = (host, path = '/api/state', method = 'GET', headers = {}) => new Promise((done, fail) => { const r = request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, (res) => { res.resume(); done(res.statusCode); }); r.on('error', fail); r.end(method === 'POST' ? '{}' : undefined); });
  const layout = () => join(copy.root, 'maps', 'plaza', 'layout.json');

  before(async () => {
    copy = sampleCopy();
    project = await loadProject({ root: copy.root });
    server = createEditor(project, { port, defaultMap: 'plaza' });
    await new Promise((done) => server.listen(port, '127.0.0.1', done));
  });
  after(async () => { await new Promise((done) => server.close(done)); copy.done(); });

  it('listens on 127.0.0.1 only', () => { assert.equal(server.address().address, '127.0.0.1'); });
  it('refuses a foreign Host, for reads and for writes', async () => {
    assert.equal(await withHost('evil.example'), 403);
    assert.equal(await withHost(`evil.example:${port}`), 403);
    assert.equal(await withHost(`evil.example:${port}`, '/'), 403);
    assert.equal(await withHost(`evil.example:${port}`, '/api/save', 'POST', { 'Content-Type': 'application/json', Origin: `http://evil.example:${port}` }), 403);
    assert.equal(await withHost(`127.0.0.1:${port}`), 200);
    assert.equal(await withHost(`localhost:${port}`), 200);
  });
  it('serves its page and its API, no other file', async () => {
    const r = await ask('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    for (const path of ['/maps/plaza/layout.json', '/kit.json', '/..%2f..%2fpackage.json', '/src/server.mjs', '/editor.html', '/api/../kit.json']) assert.equal((await ask(path)).status, 404, path);
  });
  it('knows a map only by a plain name', async () => {
    for (const name of ['../../kit', '..%2F..%2Fkit', 'plaza/..', '..', 'PLAZA', 'nosuchmap']) assert.equal((await ask(`/api/state?map=${name}`)).status, 400, name);
    assert.equal((await ask('/api/state?map=plaza')).status, 200);
  });
  it('refuses a cross-site write, a write not in JSON, and other methods', async () => {
    assert.equal((await write('/api/save', {}, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    assert.equal((await write('/api/save', {}, { 'Content-Type': 'application/json' })).status, 403); // no Origin
    assert.equal((await write('/api/save', {}, { 'Content-Type': 'text/plain', Origin: origin })).status, 403);
    assert.equal((await write('/api/save', '{', { 'Content-Type': 'application/json', Origin: origin })).status, 400); // not JSON
    assert.equal((await ask('/api/save', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' })).status, 405);
  });
  it('gives the page the plan, the kinds and the checks', async () => {
    const s = await (await ask('/api/state')).json();
    assert.equal(s.name, 'plaza');
    assert.equal(s.file, 'maps/plaza/layout.json');
    assert.ok(s.kinds['kit:tower'] && s.plantKinds.shrub);
    assert.deepEqual(s.errors, []); assert.deepEqual(s.problems, []);
    assert.deepEqual(s.actions.map((a) => a.id), ['report']);
    assert.equal(s.overlays.paving.shapes.length, 4);
    assert.equal(s.status[0].state, 'unknown');
    assert.deepEqual(await (await ask('/api/maps')).json(), { maps: ['plaza'], default: 'plaza' });
  });
  it('previews without writing', async () => {
    const plan = JSON.parse(readFileSync(layout(), 'utf8')), before = readFileSync(layout(), 'utf8');
    plan.pieces.find((p) => p.id === 'h2').at = [-6, 11];
    const r = await (await write('/api/preview', { plan })).json();
    assert.ok(r.problems.some((p) => p.kind === 'overlap'));
    assert.equal(readFileSync(layout(), 'utf8'), before);
  });
  it('does not save a plan that fails its schema', async () => {
    const before = readFileSync(layout(), 'utf8');
    const r = await write('/api/save', { plan: { id: 'plaza' } });
    assert.equal(r.status, 400);
    assert.ok((await r.json()).errors.some((e) => /missing "spawn"/.test(e)));
    assert.equal(readFileSync(layout(), 'utf8'), before);
  });
  it('saves: the file in its own format, the old one kept as layout.prev.json; then refuses a stale page', async () => {
    const s = await (await ask('/api/state')).json(), before = readFileSync(layout(), 'utf8');
    const plan = s.plan; plan.pieces.find((p) => p.id === 'crate').at = [2.5, 2];
    const r = await write('/api/save', { plan, plants: s.plants, stamps: s.stamps }), body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.planChanged, true); assert.equal(body.plantsChanged, false);
    assert.equal(readFileSync(layout(), 'utf8'), formatPlan(plan));
    assert.equal(readFileSync(join(copy.root, 'maps', 'plaza', 'layout.prev.json'), 'utf8'), before);
    assert.ok(!existsSync(join(copy.root, 'maps', 'plaza', 'plants.prev.json'))); // plants.json unchanged: not rewritten
    // the same again: nothing to write
    const again = await (await write('/api/save', { plan, plants: s.plants, stamps: body.stamps })).json();
    assert.equal(again.changed, false);
    // the page read the file before it changed on disk: refused
    writeFileSync(layout(), readFileSync(layout(), 'utf8').replace('"Plaza"', '"Plaza by hand"'));
    const stale = await write('/api/save', { plan, plants: s.plants, stamps: body.stamps });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /changed on disk/);
  });
  it('saves plants.json beside the plan, checked against its schema', async () => {
    const s = await (await ask('/api/state')).json();
    const bad = await write('/api/save', { plan: s.plan, plants: { points: [{ kind: 'Shrub', at: [0, 0] }] }, stamps: s.stamps });
    assert.equal(bad.status, 400);
    s.plants.points.push({ kind: 'shrub', at: [12, 8] });
    const r = await (await write('/api/save', { plan: s.plan, plants: s.plants, stamps: s.stamps })).json();
    assert.equal(r.plantsChanged, true);
    assert.equal(JSON.parse(readFileSync(join(copy.root, 'maps', 'plaza', 'plants.json'), 'utf8')).points.length, 4);
    assert.ok(existsSync(join(copy.root, 'maps', 'plaza', 'plants.prev.json')));
  });
  it('runs only the project\'s own actions, with the map\'s name as one argument', async () => {
    assert.equal((await write('/api/job', { job: 'rm -rf' })).status, 400);
    assert.equal((await write('/api/job', { job: 'constructor' })).status, 400);
    assert.equal((await write('/api/job', { job: ['report'] })).status, 400);
    assert.equal((await write('/api/job?map=..', { job: 'report' })).status, 400);
    const r = await write('/api/job', { job: 'report' });
    assert.equal(r.status, 200);
    let j;
    for (let i = 0; i < 100; i++) { j = await (await ask('/api/job')).json(); if (j.state !== 'running') break; await new Promise((d) => setTimeout(d, 100)); }
    assert.equal(j.state, 'done', j.log);
    assert.match(j.log, /plaza: \d+ pieces/);
    assert.ok(existsSync(join(copy.root, 'out', 'plaza.summary.json')));
    // the status hook now sees the report up to date with the saved plan
    const s = await (await ask('/api/state')).json();
    assert.equal(s.status[0].state, 'fresh');
  });
  it('a project overlay is asked for by its id only', async () => {
    assert.equal((await ask('/api/overlay?id=nothing')).status, 400);
    assert.equal((await ask('/api/overlay?id=__proto__')).status, 400);
    assert.deepEqual(await (await ask('/api/rule-plants')).json(), { present: false });
  });
});

describe('a dry run', () => {
  it('a heavy step prints what it would run and runs nothing', async () => {
    const copy = sampleCopy(), port = 19300 + (process.pid % 500);
    try {
      const project = await loadProject({ root: copy.root, config: { actions: { bake: { steps: [{ label: 'bake', node: ['tools/report.mjs', '{map}'], heavy: true }] } } } });
      const server = createEditor(project, { port, dryRun: true });
      await new Promise((done) => server.listen(port, '127.0.0.1', done));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/job`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ job: 'bake' }) });
        assert.equal(r.status, 200);
        let j;
        for (let i = 0; i < 100; i++) { j = await (await fetch(`http://127.0.0.1:${port}/api/job`)).json(); if (j.state !== 'running') break; await new Promise((d) => setTimeout(d, 100)); }
        assert.equal(j.state, 'done');
        assert.match(j.log, /DRY RUN[\s\S]*would run node \.[\\/]tools[\\/]report\.mjs plaza/);
        assert.ok(!existsSync(join(copy.root, 'out')));
      } finally { await new Promise((done) => server.close(done)); }
    } finally { copy.done(); }
  });
});
