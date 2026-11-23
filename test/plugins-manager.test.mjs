// The plugin manager: on-demand activation, the server API, everything undone on unload, failures isolated.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginManager } from '../src/plugins/manager.mjs';
import { createJobs } from '../src/jobs.mjs';
import { createEvents } from '../src/events.mjs';
import { writePlugin } from './helpers.mjs';

const SERVER = `
export function activate(api) {
  globalThis.__calls = (globalThis.__calls || 0) + 1;
  api.routes.get('/hello', ({ query }) => ({ hello: query.name || 'world', setting: api.settings.get('greeting') }));
  api.routes.post('/save', ({ body }) => { api.files.write('models/notes.txt', body.text); return { ok: true }; });
  api.routes.get('/escape', () => api.files.read('maps/secret.json'));
  api.routes.get('/crash', () => { throw new Error('kaboom'); });
  api.hooks.on('check', ({ name }) => [{ kind: 'hello', text: 'checked ' + name }]);
  api.onDispose(() => { globalThis.__disposed = (globalThis.__disposed || 0) + 1; });
}`;

describe('the plugin manager', () => {
  let top, root, dirs, state, mgr, events;
  const log = [];
  before(() => {
    top = mkdtempSync(join(tmpdir(), 'nfgames-mgr-')); root = join(top, 'game'); state = join(top, 'state');
    dirs = { builtinDir: join(top, 'builtin'), userDir: join(top, 'user'), packagesDir: join(top, 'packages') };
    mkdirSync(join(root, 'maps'), { recursive: true }); writeFileSync(join(root, 'maps', 'secret.json'), '{}');
    writePlugin(join(dirs.builtinDir, 'hello'), { id: 'nfgames.hello', server: 'server.mjs', touches: { files: ['models/**'] }, activation: ['onRoute', 'onCommand:greet'],
      contributes: { commands: [{ id: 'greet', title: 'Greet' }], settings: { greeting: { type: 'string', default: 'hi' } } } }, { 'server.mjs': SERVER, 'web/app.js': 'export {}', '.secret': 'x' });
    writePlugin(join(dirs.builtinDir, 'broken'), { id: 'nfgames.broken', server: 'server.mjs', activation: ['onStartup'] }, { 'server.mjs': 'export function activate() { throw new Error("cannot start"); }' });
    writePlugin(join(dirs.userDir, 'stranger'), { id: 'someone.stranger', server: 'server.mjs', activation: ['onStartup'] }, { 'server.mjs': 'export function activate() { globalThis.__stranger = true; }' });
    writePlugin(join(dirs.builtinDir, 'future'), { id: 'nfgames.future', engines: { nfgames: '^9.0.0' } });
    events = createEvents();
    mgr = createPluginManager({ ...dirs, stateDir: state, project: { root, options: {} }, jobs: createJobs({ root, actions: {}, ctx: {} }), events, log: (...a) => log.push(a.join(' ')) });
  });
  after(async () => { await mgr.close(); events.close(); rmSync(top, { recursive: true, force: true }); });

  const state_ = (id) => mgr.list().find((p) => p.id === id).state;

  it('lists plugins with their state; nothing runs until an activation event', () => {
    assert.equal(state_('nfgames.hello'), 'ready'); assert.equal(state_('nfgames.future'), 'incompatible'); assert.equal(state_('someone.stranger'), 'needs-trust');
    assert.equal(globalThis.__calls, undefined);
  });
  it('onStartup activates what is trusted; a plugin that throws is turned off alone; an untrusted one waits', async () => {
    await mgr.fire('onStartup');
    assert.equal(state_('nfgames.broken'), 'failed'); assert.match(mgr.list().find((p) => p.id === 'nfgames.broken').failure, /cannot start/);
    assert.equal(globalThis.__stranger, undefined);
    mgr.trust('someone.stranger'); await mgr.fire('onStartup'); assert.equal(globalThis.__stranger, true);
  });
  it('a route activates its plugin and answers; settings have their defaults', async () => {
    const r = await mgr.route('nfgames.hello', 'GET', 'hello', { url: '/api/p/nfgames.hello/hello?name=Khairos' }, null, null);
    assert.deepEqual(r, { status: 200, body: { hello: 'Khairos', setting: 'hi' } });
    assert.equal(globalThis.__calls, 1); assert.equal(state_('nfgames.hello'), 'active');
    assert.equal((await mgr.route('nfgames.hello', 'GET', 'nope', { url: '/x' }, null, null)).status, 404);
  });
  it('files: only what touches.files declares', async () => {
    assert.equal((await mgr.route('nfgames.hello', 'POST', 'save', { url: '/x' }, null, async () => ({ text: 'ok' }))).status, 200);
    assert.equal(readFileSync(join(root, 'models', 'notes.txt'), 'utf8'), 'ok');
    const r = await mgr.route('nfgames.hello', 'GET', 'escape', { url: '/x' }, null, null);
    assert.equal(r.status, 500); assert.match(r.body.error, /did not declare maps\/secret\.json/);
  });
  it('hooks run across active plugins', async () => {
    await mgr.reload('nfgames.hello');
    assert.deepEqual((await mgr.runHook('check', { name: 'plaza' })).flat(), [{ kind: 'hello', text: 'checked plaza' }]);
  });
  it('a crashing route turns its plugin off and undoes what it registered', async () => {
    const before = globalThis.__disposed || 0;
    const r = await mgr.route('nfgames.hello', 'GET', 'crash', { url: '/x' }, null, null);
    assert.equal(r.status, 500); assert.equal(state_('nfgames.hello'), 'failed'); assert.equal(globalThis.__disposed, before + 1);
    assert.deepEqual(await mgr.runHook('check', { name: 'plaza' }), []);
    await mgr.reload('nfgames.hello'); assert.equal(state_('nfgames.hello'), 'active');
  });
  it('turning a plugin off unloads it, and it stays off', async () => {
    await mgr.setEnabled('nfgames.hello', false); assert.equal(state_('nfgames.hello'), 'off');
    assert.equal((await mgr.route('nfgames.hello', 'GET', 'hello', { url: '/x' }, null, null)).status, 404);
    await mgr.setEnabled('nfgames.hello', true); assert.equal(state_('nfgames.hello'), 'ready');
  });
  it('assets: files of its own folder only, no hidden files, no way out', () => {
    assert.equal(mgr.asset('nfgames.hello', 'web/app.js'), join(dirs.builtinDir, 'hello', 'web', 'app.js'));
    for (const bad of ['../broken/server.mjs', '.secret', 'web/missing.js', '']) assert.equal(mgr.asset('nfgames.hello', bad), null, bad);
    assert.equal(mgr.asset('nfgames.future', 'plugin.json'), null);
  });
  it('a private storage folder per plugin', async () => {
    await mgr.activate('nfgames.hello');
    assert.ok(existsSync(join(state, 'storage', 'nfgames.hello')));
  });
});
