// Switching project over HTTP: inside home only, from this page only; a config runs once trusted; a config that
// throws keeps the open project; a project with no maps opens; the viewer and the palette follow.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { createEditor } from '../src/server.mjs';
import { SAMPLE, glbOf, boxScene } from './helpers.mjs';

describe('switching project over HTTP', () => {
  const port = 19893 + (process.pid % 500), origin = `http://127.0.0.1:${port}`;
  let top, home, server;
  const ask = (p) => fetch(`${origin}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body, headers = { 'Content-Type': 'application/json', Origin: origin }) => fetch(`${origin}${p}`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-switch-'))); home = join(top, 'home');
    cpSync(SAMPLE, join(home, 'sample'), { recursive: true, filter: (s) => !/[\\/]out([\\/]|$)|\.prev\.json$/.test(s) });
    mkdirSync(join(home, 'khairos', 'ships'), { recursive: true });
    writeFileSync(join(home, 'khairos', 'ships', 'cruiser.glb'), glbOf(boxScene([{ min: [-5, 0, -30], max: [5, 8, 30] }])));
    mkdirSync(join(home, 'broken')); writeFileSync(join(home, 'broken', 'map-editor.config.mjs'), 'throw new Error("this config is broken");\n');
    mkdirSync(join(top, 'outside'));
    server = createEditor(await loadProject({ root: join(home, 'sample') }), { port, defaultMap: 'plaza', home, stateDir: join(home, '.nfgames-editor') });
    await new Promise((d) => server.listen(port, '127.0.0.1', d));
  });
  after(async () => { await new Promise((d) => server.close(d)); rmSync(top, { recursive: true, force: true }); });

  it('says which project is open, and browses home', async () => {
    const p = await ask('/api/projects'); assert.equal(p.body.current.name, 'sample'); assert.equal(p.body.current.maps, 1);
    assert.deepEqual((await ask(`/api/browse?path=${encodeURIComponent(home)}`)).body.entries.map((e) => e.name), ['broken', 'khairos', 'sample']);
    assert.equal((await ask(`/api/browse?path=${encodeURIComponent(join(top, 'outside'))}`)).status, 400);
  });
  it('switches only from this page, and only inside home', async () => {
    assert.equal((await post('/api/project', { root: join(home, 'khairos') }, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/project', { root: join(top, 'outside') })).status, 400);
  });
  it('opens a folder with no config and no maps: the viewer and the palette see its models', async () => {
    const r = await post('/api/project', { root: join(home, 'khairos') });
    assert.equal(r.status, 200); assert.deepEqual(r.body.maps, []);
    assert.equal((await ask('/api/projects')).body.current.name, 'khairos');
    assert.deepEqual((await ask('/api/models')).body.models.map((m) => m.path), ['ships/cruiser.glb']);
    assert.deepEqual((await ask('/api/maps')).body.maps, []);
    assert.equal((await ask('/api/state')).status, 400);
  });
  it('asks before running a config, and keeps the project when a config throws', async () => {
    const first = await post('/api/project', { root: join(home, 'broken') });
    assert.equal(first.status, 200); assert.equal(first.body.needsTrust, true);
    assert.equal((await ask('/api/projects')).body.current.name, 'khairos');
    const r = await post('/api/project', { root: join(home, 'broken'), trust: true });
    assert.equal(r.status, 400); assert.match(r.body.error, /this config is broken/);
    assert.equal((await ask('/api/projects')).body.current.name, 'khairos');
  });
  it('a trusted config opens next time without asking, and is first among the recent', async () => {
    assert.equal((await post('/api/project', { root: join(home, 'sample') })).body.needsTrust, true);
    const r = await post('/api/project', { root: join(home, 'sample'), trust: true });
    assert.equal(r.status, 200); assert.deepEqual(r.body.maps, ['plaza']);
    await post('/api/project', { root: join(home, 'khairos') });
    assert.equal((await post('/api/project', { root: join(home, 'sample') })).body.ok, true);
    assert.equal((await ask('/api/state')).body.name, 'plaza');
    assert.deepEqual((await ask('/api/projects')).body.recent.slice(0, 2), [join(home, 'sample'), join(home, 'khairos')]);
  });
});
