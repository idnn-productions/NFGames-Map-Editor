// Directed Community Meshes plugin: share local models (.glb + .refs/ + glb.mjs metrics + consent)
// to directedgames.com and 1-click import curated meshes directly into models/directed/<slug>/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listModels, resolveModel, modelRefs, IMAGE_SIGNATURES } from '../../src/models.mjs';
import { glbJson, sceneBounds } from '../../src/glb.mjs';

const refuse = (code, text) => { throw Object.assign(new Error(text), { code }); };

function inspectGlbMetrics(file) {
  const gltf = glbJson(file);
  const acc = gltf.accessors || [];
  let triangles = 0;
  for (const mesh of gltf.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const mode = prim.mode === undefined ? 4 : prim.mode;
      const idx = prim.indices !== undefined ? acc[prim.indices] : null;
      const pos = prim.attributes?.POSITION !== undefined ? acc[prim.attributes.POSITION] : null;
      const count = idx ? idx.count : pos ? pos.count : 0;
      if (mode === 4 && count >= 3) triangles += Math.floor(count / 3);
      else if ((mode === 5 || mode === 6) && count >= 3) triangles += count - 2;
    }
  }
  let bounds_m = null;
  try {
    const b = sceneBounds(gltf);
    bounds_m = [
      Number((b.max[0] - b.min[0]).toFixed(3)),
      Number((b.max[1] - b.min[1]).toFixed(3)),
      Number((b.max[2] - b.min[2]).toFixed(3)),
    ];
  } catch { /* no bounds */ }
  const has_pbr = (gltf.materials || []).some((m) => !!m.pbrMetallicRoughness);
  return { triangles, bounds_m, has_pbr };
}

function isGlbBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 12 && buf.readUInt32LE(0) === 0x46546c67 && buf.readUInt32LE(4) === 2;
}

function safeSlug(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!s) refuse(400, 'invalid mesh slug');
  return s;
}

function isSafeImage(name, buf) {
  if (!/^[a-zA-Z0-9._-]+\.(png|jpe?g|webp)$/i.test(name) || name.includes('..')) return false;
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (/\.png$/i.test(name)) return IMAGE_SIGNATURES.png(buf);
  if (/\.jpe?g$/i.test(name)) return IMAGE_SIGNATURES.jpg(buf);
  if (/\.webp$/i.test(name)) return IMAGE_SIGNATURES.webp(buf);
  return false;
}

export function activate(api) {
  const modelsRoot = () => join(api.project.root, 'models');

  api.routes.get('/local-models', () => {
    const dir = modelsRoot();
    const list = listModels(dir);
    return {
      models: list.map((m) => {
        const file = resolveModel(dir, m.path);
        const refs = modelRefs(dir, m.path);
        let metrics = { triangles: 0, bounds_m: null, has_pbr: false };
        if (file) {
          try { metrics = inspectGlbMetrics(file); } catch { /* non-standard glb */ }
        }
        return {
          path: m.path,
          rel: `models/${m.path}`,
          size: m.size,
          refCount: refs.length,
          refs: refs.map((r) => r.name),
          ...metrics,
        };
      }),
    };
  });

  api.routes.get('/remote', async ({ query }) => {
    const res = await api.services.call('nfgames.directed-connect/account', 'listMeshes', {
      q: query.q || '',
      category: query.category || '',
      license: query.license || '',
      quads: query.quads === '1',
      sort: query.sort || 'newest',
      page: query.page ? Number(query.page) : 1,
      mine: query.mine === '1',
    });
    return res;
  });

  api.routes.post('/share', async ({ body = {} }) => {
    const relPath = String(body.model || '').replace(/^models\//, '');
    const dir = modelsRoot();
    const file = resolveModel(dir, relPath);
    if (!file) refuse(404, 'Model not found under models/.');

    const glbBuf = api.files.read(`models/${relPath}`, null);
    if (!isGlbBuffer(glbBuf)) refuse(400, 'Selected file is not a valid glTF 2.0 binary (.glb).');

    const metrics = inspectGlbMetrics(file);
    const refEntries = modelRefs(dir, relPath);
    const refs = refEntries.map((r) => ({
      name: r.name,
      data_base64: readFileSync(r.file).toString('base64'),
    }));

    const thumb_base64 = typeof body.thumb_base64 === 'string' && body.thumb_base64
      ? body.thumb_base64
      : (refs[0] ? refs[0].data_base64 : undefined);

    const payload = {
      title: String(body.title || '').trim(),
      description: String(body.description || '').trim(),
      category: String(body.category || 'props'),
      tags: Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
      provenance: String(body.provenance || 'human_refined'),
      tools_used: Array.isArray(body.tools_used) ? body.tools_used : String(body.tools_used || 'NFGames-Map-Editor').split(',').map((s) => s.trim()).filter(Boolean),
      generator_license: String(body.generator_license || 'clean'),
      public_license: String(body.public_license || 'cc0'),
      training_opt_in: body.training_opt_in === true,
      triangles: metrics.triangles,
      quads: Number(body.quads) || 0,
      bounds_m: metrics.bounds_m,
      has_pbr: metrics.has_pbr,
      match_score: body.match_score !== undefined && body.match_score !== '' && body.match_score !== null ? Number(body.match_score) : null,
      glb_base64: glbBuf.toString('base64'),
      ...(thumb_base64 ? { thumb_base64 } : {}),
      refs,
    };

    const { mesh } = await api.services.call('nfgames.directed-connect/account', 'uploadMesh', payload);
    api.events.emit('shared', { id: mesh.id, slug: mesh.slug, title: mesh.title });
    return { ok: true, mesh };
  });

  api.routes.post('/import', async ({ body = {} }) => {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) refuse(400, 'mesh id required');
    const includeRefs = body.includeRefs !== false;

    const { mesh, glb_base64 } = await api.services.call('nfgames.directed-connect/account', 'downloadMesh', { id });
    const glbBuf = Buffer.from(String(glb_base64 || ''), 'base64');
    if (!isGlbBuffer(glbBuf)) refuse(502, 'Downloaded file failed GLB 2.0 header check.');

    const slug = safeSlug(mesh.slug || mesh.title || `mesh-${id}`);
    const relGlb = `models/directed/${slug}/${slug}.glb`;
    api.files.write(relGlb, glbBuf);

    let refsWritten = 0;
    if (includeRefs && Array.isArray(mesh.refs) && mesh.refs.length) {
      for (const ref of mesh.refs) {
        try {
          const got = await api.services.call('nfgames.directed-connect/account', 'downloadRef', { id, name: ref.name });
          const imgBuf = Buffer.from(String(got.data_base64 || ''), 'base64');
          if (isSafeImage(ref.name, imgBuf)) {
            api.files.write(`models/directed/${slug}/${slug}.refs/${ref.name}`, imgBuf);
            refsWritten++;
          }
        } catch {
          // Non-fatal: the GLB itself is already imported
        }
      }
    }

    api.events.emit('imported', { id: mesh.id, slug, path: relGlb, refsWritten });
    return { ok: true, path: relGlb, modelParam: `directed/${slug}/${slug}.glb`, refsWritten, mesh };
  });
}
