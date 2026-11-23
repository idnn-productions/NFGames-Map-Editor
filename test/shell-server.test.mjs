// The workbench over HTTP: its page and files, today's editor at /map, plugins activated and their settings changed
// from the page only, frames from this origin only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import { sampleCopy, writePlugin } from './helpers.mjs';

describe('the workbench over HTTP', () => {
  const port = 20893 + (process.pid % 500), origin = `http://127.0.0.1:${port}`;
  let top, copy, host;
  const ask = (p, o) => fetch(`${origin}${p}`, o);
  const post = (p, body = {}, headers = { 'Content-Type': 'application/json', Origin: origin }) => ask(p, { method: 'POST', headers, body: JSON.stringify(body) });
  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-shell-'))); copy = sampleCopy();
    writePlugin(join(top, 'builtin', 'hello'), { id: 'nfgames.hello', server: 'server.mjs', activation: ['onTool:hello'],
      contributes: { tools: [{ id: 'hello' }], settings: { greeting: { type: 'string', default: 'hi' }, loud: { type: 'boolean', default: false }, size: { type: 'number', default: 2, enum: [1, 2, 3] } } } },
      { 'server.mjs': 'export function activate(api) { globalThis.__shellHello = (globalThis.__shellHello || 0) + 1; }' });
    host = await createHost({ root: copy.root, port, pluginDirs: { builtinDir: join(top, 'builtin'), userDir: join(top, 'user'), packagesDir: join(top, 'packages') }, stateDir: join(top, 'state'), home: top });
    await host.listen();
  });
  after(async () => { await new Promise((d) => host.server.close(d)); copy.done(); rmSync(top, { recursive: true, force: true }); });

  it('/ is the workbench, /map today\'s editor, both framable by this origin only', async () => {
    const shell = await ask('/'); const html = await shell.text();
    assert.match(html, /workbench\.js/); assert.match(html, /"three":"\/vendor\/three-/); assert.match(html, /id="nfnav"/);
    assert.equal(shell.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(await (await ask('/map')).text(), /Add a piece/);
    { const map = await (await ask('/map')).text(); assert.match(map, /id="palFilter"/); assert.match(map, /<script src="\/shell\/tree\.js">/); }
  });
  it('a browser opening /map or /viewer at the top goes to the workbench with that tab; frames and ?alone get the page', async () => {
    const top = { headers: { 'Sec-Fetch-Dest': 'document' }, redirect: 'manual' };
    for (const view of ['map', 'viewer']) {
      const r = await ask(`/${view}`, top);
      assert.equal(r.status, 302, view); assert.equal(r.headers.get('location'), `/?view=${view}`);
      assert.equal((await ask(`/${view}`, { headers: { 'Sec-Fetch-Dest': 'iframe' }, redirect: 'manual' })).status, 200, view);
      assert.equal((await ask(`/${view}?alone`, top)).status, 200, view);
    }
  });
  it('serves the shell\'s own files, nothing hidden or outside', async () => {
    const r = await ask('/shell/core/keys.js'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
    for (const bad of ['/shell/../server.mjs', '/shell/%2e%2e/server.mjs', '/shell/.hidden', '/shell/nope.js']) assert.equal((await ask(bad)).status, 404, bad);
  });
  it('activates a plugin from the page only', async () => {
    assert.equal((await post('/api/plugins/nfgames.hello/activate', {}, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    const r = await (await post('/api/plugins/nfgames.hello/activate')).json();
    assert.equal(r.plugins.find((p) => p.id === 'nfgames.hello').state, 'active'); assert.equal(globalThis.__shellHello, 1);
  });
  it('settings: read with defaults, written within their schema', async () => {
    assert.deepEqual((await (await ask('/api/plugins/nfgames.hello/settings')).json()).values, { greeting: 'hi', loud: false, size: 2 });
    assert.equal((await (await post('/api/plugins/nfgames.hello/settings', { key: 'loud', value: true })).json()).values.loud, true);
    for (const [key, value, why] of [['loud', 'yes', /boolean/], ['size', 5, /one of/], ['nope', 1, /no such setting/]]) {
      const r = await post('/api/plugins/nfgames.hello/settings', { key, value }); assert.equal(r.status, 400); assert.match((await r.json()).error, why);
    }
  });
});
