// Plugins over HTTP: listed, their routes and assets served under their id, the same security checks, live events,
// their check hook feeding Problems, and a project switch reloading them.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import { sampleCopy, writePlugin } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
describe('plugins over HTTP', () => {
  const port = 20393 + (process.pid % 500), origin = `http://127.0.0.1:${port}`;
  let top, copy, host;
  const ask = (p, o) => fetch(`${origin}${p}`, o);
  const post = (p, body = {}, headers = { 'Content-Type': 'application/json', Origin: origin }) => ask(p, { method: 'POST', headers, body: JSON.stringify(body) });
  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-psrv-'))); copy = sampleCopy();
    const builtinDir = join(top, 'builtin');
    writePlugin(join(builtinDir, 'hello'), { id: 'nfgames.hello', server: 'server.mjs', web: 'web/index.js', activation: ['onRoute'] }, {
      'server.mjs': `export function activate(api) { api.routes.get('/hi', () => ({ hi: api.project.name })); api.routes.post('/echo', ({ body }) => body); api.hooks.on('check', ({ name }) => [{ kind: 'hello', text: 'hello checked ' + name, sel: [], at: null }]); }`,
      'web/index.js': 'export function activate() {}', 'web/.hidden': 'x' });
    writePlugin(join(builtinDir, 'pics'), { id: 'nfgames.pics', server: 'server.mjs', touches: { files: ['.x/**'] }, activation: ['onRoute'] }, { 'server.mjs': `
export function activate(api) {
  api.routes.get('/pic', ({ query }) => api.routes.file(query.path));
  api.routes.get('/ask-first', () => { throw Object.assign(new Error('this clears the views'), { code: 409, needsConfirm: true }); });
  api.routes.get('/bad', () => { throw Object.assign(new Error('name: give it a name'), { code: 400 }); });
  api.routes.get('/boom', () => { throw Object.assign(new Error('odd'), { code: 'EODD' }); });
}` });
    mkdirSync(join(copy.root, '.x', 'sub'), { recursive: true }); writeFileSync(join(copy.root, '.x', 'p.png'), PNG); writeFileSync(join(copy.root, '.x', 'page.html'), '<script>alert(1)</script>');
    host = await createHost({ root: copy.root, port, pluginDirs: { builtinDir, userDir: join(top, 'user'), packagesDir: join(top, 'packages') }, stateDir: join(top, 'state'), home: top });
    await host.listen();
  });
  after(async () => { await new Promise((d) => host.server.close(d)); copy.done(); rmSync(top, { recursive: true, force: true }); });

  it('lists plugins', async () => {
    const j = await (await ask('/api/plugins')).json();
    assert.equal(j.api, '1.1.0'); assert.equal(j.plugins.find((p) => p.id === 'nfgames.hello').state, 'ready');
  });
  it('serves a plugin\'s routes under its id, with the usual checks', async () => {
    assert.deepEqual(await (await ask('/api/p/nfgames.hello/hi')).json(), { hi: copy.root.split('/').pop() });
    assert.deepEqual(await (await post('/api/p/nfgames.hello/echo', { a: 1 })).json(), { a: 1 });
    assert.equal((await post('/api/p/nfgames.hello/echo', {}, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    assert.equal((await ask('/api/p/nobody.here/hi')).status, 404);
  });
  it('serves a plugin\'s own files, nothing hidden, nothing outside', async () => {
    const r = await ask('/p/nfgames.hello/web/index.js');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
    for (const bad of ['/p/nfgames.hello/web/.hidden', '/p/nfgames.hello/..%2F..%2Fstate', '/p/nfgames.hello/server.mjs%00']) assert.equal((await ask(bad)).status, 404, bad);
  });
  it('a route can answer with a project file: its bytes, its type, never sniffed', async () => {
    const r = await ask('/api/p/nfgames.pics/pic?path=.x/p.png');
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
    assert.equal((await ask('/api/p/nfgames.pics/pic?path=.x/page.html')).headers.get('content-type'), 'application/octet-stream');   // not a page the browser would run
    assert.equal((await ask('/api/p/nfgames.pics/pic?path=.x/none.png')).status, 404);
    assert.equal((await ask('/api/p/nfgames.pics/pic?path=.x/sub')).status, 404);   // a folder is not a file
    const out = await ask('/api/p/nfgames.pics/pic?path=maps/plaza/layout.json');
    assert.equal(out.status, 500); assert.match((await out.json()).error, /did not declare/);
  });
  it('a route\'s refusal keeps its 4xx code and what it asks; any other throw is the plugin failing', async () => {
    const ask1 = await ask('/api/p/nfgames.pics/ask-first');
    assert.equal(ask1.status, 409); assert.deepEqual(await ask1.json(), { error: 'this clears the views', needsConfirm: true });
    const bad = await ask('/api/p/nfgames.pics/bad');
    assert.equal(bad.status, 400); assert.deepEqual(await bad.json(), { error: 'name: give it a name' });
    assert.equal((await ask('/api/p/nfgames.pics/pic?path=.x/p.png')).status, 200);   // still on
    assert.equal((await ask('/api/p/nfgames.pics/boom')).status, 500);
    assert.equal((await (await ask('/api/plugins')).json()).plugins.find((p) => p.id === 'nfgames.pics').state, 'failed');
  });
  it('a plugin\'s check hook reaches Problems', async () => {
    const s = await (await ask('/api/state')).json();
    assert.ok(s.problems.some((p) => p.kind === 'hello' && /hello checked plaza/.test(p.text)), JSON.stringify(s.problems));
  });
  it('streams plugin events', async () => {
    const res = await ask('/api/events'), reader = res.body.getReader(); let text = '';
    await post('/api/plugins/nfgames.hello/reload');
    while (!/plugins\/changed/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(text, /"id":"nfgames.hello"/);
  });
  it('turning a plugin off and on, from this page only', async () => {
    assert.equal((await post('/api/plugins/nfgames.hello/disable', {}, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    const off = await (await post('/api/plugins/nfgames.hello/disable')).json();
    assert.equal(off.plugins.find((p) => p.id === 'nfgames.hello').state, 'off');
    assert.equal((await ask('/api/p/nfgames.hello/hi')).status, 404);
    await post('/api/plugins/nfgames.hello/enable');
    assert.equal((await ask('/api/p/nfgames.hello/hi')).status, 200);
  });
});
