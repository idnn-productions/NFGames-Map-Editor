// Directed Games account connect + curated meshes share & import plugins.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import { sampleCopy } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function sampleGlb() {
  const doc = {
    asset: { version: '2.0' },
    accessors: [{ componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1.2, 2.4, 0.8] }],
    materials: [{ pbrMetallicRoughness: { roughnessFactor: 0.7 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  let json = JSON.stringify(doc);
  while (Buffer.byteLength(json) % 4 !== 0) json += ' ';
  const jsonBuf = Buffer.from(json, 'utf8');
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + jsonBuf.length, 8);
  head.writeUInt32LE(jsonBuf.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, jsonBuf]);
}

describe('Directed Games plugins (connect + meshes)', () => {
  const port = 20593 + (process.pid % 400);
  const origin = `http://127.0.0.1:${port}`;
  const glb = sampleGlb();
  let top, copy, host;
  const uploaded = [];

  const mockFetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const auth = opts.headers?.Authorization || '';
    const jsonRes = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
    });
    const binRes = (buf, ct) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': ct }),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    });

    if (u.pathname === '/wp-json/directed/v1/editor/me') {
      if (!auth.startsWith('Basic ')) return jsonRes(401, { message: 'Unauthorized' });
      return jsonRes(200, {
        user: { id: 7, login: 'frank', display_name: 'Frank', is_publisher: true },
        mesh_count: uploaded.length,
        limits: { max_mesh_bytes: 50 * 1024 * 1024 },
      });
    }
    if (u.pathname === '/wp-json/directed/v1/meshes' && (opts.method || 'GET') === 'POST') {
      if (!auth.startsWith('Basic ')) return jsonRes(401, { message: 'Unauthorized' });
      const body = JSON.parse(opts.body);
      uploaded.push(body);
      return jsonRes(201, { id: 101, slug: 'oak-barrel', title: body.title, status: 'pending', ref_count: (body.refs || []).length });
    }
    if (u.pathname === '/wp-json/directed/v1/meshes' && (opts.method || 'GET') === 'GET') {
      return jsonRes(200, {
        items: [{ id: 42, slug: 'stone-lantern', title: 'Stone Lantern', category: 'props', category_label: 'Props', license_short: 'CC0', triangles: 1, author: { display_name: 'IDNN' } }],
        total: 1,
        page: 1,
        pages: 1,
      });
    }
    if (u.pathname === '/wp-json/directed/v1/meshes/42') {
      return jsonRes(200, {
        id: 42,
        slug: 'stone-lantern',
        title: 'Stone Lantern',
        refs: [{ name: 'front.png', url: 'https://directedgames.com/wp-json/directed/v1/meshes/42/refs/front.png' }],
      });
    }
    if (u.pathname === '/wp-json/directed/v1/meshes/42/download') {
      if (!auth.startsWith('Basic ')) return jsonRes(401, { message: 'Unauthorized' });
      return binRes(glb, 'model/gltf-binary');
    }
    if (u.pathname === '/wp-json/directed/v1/meshes/42/refs/front.png') {
      return binRes(PNG, 'image/png');
    }
    return jsonRes(404, { message: `Unhandled mock route: ${u.pathname}` });
  };

  const ask = (p, o) => fetch(`${origin}${p}`, o);
  const post = (p, body = {}) => ask(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });

  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-dg-')));
    copy = sampleCopy();
    mkdirSync(join(copy.root, 'models', 'barrel.refs'), { recursive: true });
    writeFileSync(join(copy.root, 'models', 'barrel.glb'), glb);
    writeFileSync(join(copy.root, 'models', 'barrel.refs', 'front.png'), PNG);

    host = await createHost({
      root: copy.root,
      port,
      stateDir: join(top, 'state'),
      home: top,
      securityBin: null,
      fetchImpl: mockFetch,
    });
    await host.listen();
  });

  after(async () => {
    await new Promise((d) => host.server.close(d));
    copy.done();
    rmSync(top, { recursive: true, force: true });
  });

  it('connects via cryptographic state-checked localhost callback and stores token in vault', async () => {
    const beforeStatus = await (await ask('/api/p/nfgames.directed-connect/status')).json();
    assert.equal(beforeStatus.connected, false);

    // Reject forged/unknown state on /directed/callback
    const forged = await ask('/directed/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ site: 'https://directedgames.com', login: 'frank', key: 'aaaa bbbb', state: 'bad-state' }),
    });
    assert.equal(forged.status, 400);

    // Legitimate begin -> callback flow
    const begin = await (await post('/api/p/nfgames.directed-connect/begin', {})).json();
    assert.match(begin.url, /^https:\/\/directedgames\.com\/account\/connect\/\?/);
    assert.ok(begin.state && begin.state.length >= 16);

    const cb = await ask('/directed/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ site: 'https://directedgames.com', login: 'frank', key: 'aaaa bbbb cccc dddd', state: begin.state }),
    });
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /Connected as Frank/);

    // State cannot be replayed
    const replay = await ask('/directed/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ site: 'https://directedgames.com', login: 'frank', key: 'aaaa bbbb cccc dddd', state: begin.state }),
    });
    assert.equal(replay.status, 400);

    // Status reports connected user without exposing secret key
    const st = await (await ask('/api/p/nfgames.directed-connect/status')).json();
    assert.equal(st.connected, true);
    assert.equal(st.user.display_name, 'Frank');
    assert.equal(JSON.stringify(st).includes('aaaa bbbb'), false);
  });

  it('inspects local models, shares GLB + .refs + bounds, and 1-click imports safely into models/', async () => {
    const local = await (await ask('/api/p/nfgames.directed-meshes/local-models')).json();
    assert.equal(local.models.length, 1);
    assert.equal(local.models[0].path, 'barrel.glb');
    assert.equal(local.models[0].triangles, 1);
    assert.deepEqual(local.models[0].bounds_m, [1.2, 2.4, 0.8]);
    assert.equal(local.models[0].refCount, 1);

    // Share local model
    const shared = await (await post('/api/p/nfgames.directed-meshes/share', {
      model: 'barrel.glb',
      title: 'Oak Barrel',
      category: 'props',
      provenance: 'hand_made',
      generator_license: 'clean',
      public_license: 'cc0',
      training_opt_in: true,
    })).json();
    assert.equal(shared.ok, true);
    assert.equal(shared.mesh.id, 101);
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].training_opt_in, true);
    assert.deepEqual(uploaded[0].bounds_m, [1.2, 2.4, 0.8]);
    assert.equal(uploaded[0].refs.length, 1);
    assert.equal(uploaded[0].refs[0].name, 'front.png');

    // Browse remote catalog
    const remote = await (await ask('/api/p/nfgames.directed-meshes/remote')).json();
    assert.equal(remote.total, 1);
    assert.equal(remote.items[0].slug, 'stone-lantern');

    // 1-click import into models/directed/stone-lantern/
    const imp = await (await post('/api/p/nfgames.directed-meshes/import', { id: 42 })).json();
    assert.equal(imp.ok, true);
    assert.equal(imp.path, 'models/directed/stone-lantern/stone-lantern.glb');
    assert.equal(imp.refsWritten, 1);
    assert.ok(existsSync(join(copy.root, 'models', 'directed', 'stone-lantern', 'stone-lantern.glb')));
    assert.ok(existsSync(join(copy.root, 'models', 'directed', 'stone-lantern', 'stone-lantern.refs', 'front.png')));
    assert.deepEqual(readFileSync(join(copy.root, 'models', 'directed', 'stone-lantern', 'stone-lantern.glb')), glb);

    // Disconnect clears vault key
    const disc = await (await post('/api/p/nfgames.directed-connect/disconnect', {})).json();
    assert.equal(disc.connected, false);
    const afterStatus = await (await ask('/api/p/nfgames.directed-connect/status')).json();
    assert.equal(afterStatus.connected, false);
  });
});
