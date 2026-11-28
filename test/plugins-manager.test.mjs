// The plugin manager: on-demand activation, the server API, everything undone on unload, failures isolated.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    writePlugin(join(dirs.builtinDir, 'filer'), { id: 'nfgames.filer', server: 'server.mjs', touches: { files: ['.x/**'] }, activation: ['onRoute'] }, { 'server.mjs': `
export function activate(api) {
  const f = api.files;
  api.routes.post('/do', ({ body: { op, rel, data } }) => ({ result: op === 'write' ? (f.write(rel, data), true) : op === 'remove' ? (f.remove(rel), true) : op === 'exists' ? f.exists(rel) : op === 'list' ? f.list(rel) : f.read(rel) }));
}` });
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
  const filer = async (op, rel, data) => { const r = await mgr.route('nfgames.filer', 'POST', 'do', { url: '/x' }, null, async () => ({ op, rel, data })); return r.status === 200 ? r.body.result : r.body.error; };
  it('files.remove takes a file or a folder with what is in it, only where touches.files says', async () => {
    assert.equal(await filer('write', '.x/a/b.txt', 'one'), true); assert.equal(await filer('write', '.x/a/c/d.txt', 'two'), true);
    assert.equal(await filer('remove', '.x/a/b.txt'), true); assert.equal(await filer('exists', '.x/a/b.txt'), false); assert.equal(await filer('exists', '.x/a/c/d.txt'), true);
    assert.equal(await filer('remove', '.x/a'), true); assert.equal(await filer('exists', '.x/a'), false);
    assert.equal(await filer('remove', '.x/never-was'), true);   // nothing there: not an error
    assert.match(await filer('remove', 'maps/secret.json'), /did not declare maps\/secret\.json/); assert.ok(existsSync(join(root, 'maps', 'secret.json')));
    assert.match(await filer('remove', '.'), /outside the project/); assert.match(await filer('remove', '../game'), /outside the project/); assert.ok(existsSync(root));
  });
  it('files: a link inside a declared folder cannot lead out of the project', async () => {
    const outside = join(top, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'keep');
    mkdirSync(join(root, '.x'), { recursive: true }); symlinkSync(outside, join(root, '.x', 'link')); symlinkSync(join(outside, 'secret.txt'), join(root, '.x', 'file-link'));
    for (const [op, rel] of [['read', '.x/link/secret.txt'], ['write', '.x/link/new.txt'], ['remove', '.x/link/secret.txt'], ['list', '.x/link'], ['exists', '.x/link/secret.txt'], ['read', '.x/file-link'], ['write', '.x/file-link'], ['write', '.x/link/deep/er/new.txt']])
      assert.match(String(await filer(op, rel, 'changed')), /outside the project/, `${op} ${rel}`);
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'keep'); assert.ok(!existsSync(join(outside, 'new.txt'))); assert.ok(!existsSync(join(outside, 'deep')));
    assert.equal(await filer('remove', '.x/link'), true);   // the link itself is the project's: it goes, what it pointed at stays
    assert.ok(!existsSync(join(root, '.x', 'link'))); assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'keep');
    assert.equal(state_('nfgames.filer'), 'active');   // a refusal is not a crash
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
    const out = join(top, 'asset-outside.txt'); writeFileSync(out, 'nope');
    symlinkSync(out, join(dirs.builtinDir, 'hello', 'web', 'escape.txt'));
    assert.equal(mgr.asset('nfgames.hello', 'web/escape.txt'), null);
  });
  it('a private storage folder per plugin', async () => {
    await mgr.activate('nfgames.hello');
    assert.ok(existsSync(join(state, 'storage', 'nfgames.hello')));
  });
});
