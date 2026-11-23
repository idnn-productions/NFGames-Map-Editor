// A stand-in for ComfyUI, for tests: the few routes the model service uses, answering as ComfyUI does.
//   fakeComfy({ nodes, models, queue, a3d, outcome }) -> { url, calls, set(more), close() }
// nodes: node types it has; models: file names its loaders offer; queue: prompts it is already holding;
// a3d: what /asset3d/status answers (undefined: no such route); outcome: 'success' | 'reject' | 'error' | 'no-glb' |
// 'view-404' | 'html' (not ComfyUI at all). calls records what it was sent.
import { createServer } from 'node:http';

export const FAKE_GLB = Buffer.from('glTF-fake-model');

export async function fakeComfy(options = {}) {
  const o = { nodes: ['LoadImage', 'PrimitiveBoolean', 'DecimateMesh', 'UNETLoader', 'Save3DAdvanced', 'SaveImage'], models: ['pixal3d.safetensors'], queue: 0, a3d: { version: 1, ultrashape: { code: true, packages: [], checkpoints: ['ultrashape_v1.pt'] } }, outcome: 'success', ...options };
  const calls = { uploads: [], prompts: [], views: [] };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks), url = new URL(req.url, 'http://x'), path = url.pathname;
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (o.outcome === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>a router</html>'); }
    if (path === '/object_info') return json(200, Object.fromEntries(o.nodes.map((n) => [n, { input: { required: n === 'UNETLoader' ? { unet_name: [o.models, {}] } : n === 'LoadImage' ? { image: [['example.png'], {}] } : {} } }])));
    if (path === '/queue') return json(200, { queue_running: Array.from({ length: Math.min(1, o.queue) }, () => [0]), queue_pending: Array.from({ length: Math.max(0, o.queue - 1) }, () => [0]) });
    if (path === '/asset3d/status') { if (o.a3d === undefined) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404: Not Found'); } return json(200, o.a3d); }
    if (path === '/upload/image' && req.method === 'POST') {
      const text = body.toString('latin1'), field = (name) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(text)?.[1];
      const up = { name: /filename="([^"]+)"/.exec(text)?.[1], subfolder: field('subfolder'), type: field('type'), overwrite: field('overwrite') };
      calls.uploads.push(up); return json(200, { name: up.name, subfolder: up.subfolder, type: 'input' });
    }
    if (path === '/prompt' && req.method === 'POST') {
      const graph = JSON.parse(body.toString('utf8')).prompt; calls.prompts.push(graph);
      if (o.outcome === 'reject') return json(400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { 10: { class_type: 'UNETLoader', errors: [{ message: 'Value not in list', details: 'unet_name: \'pixal3d.safetensors\' not in []' }] } } });
      return json(200, { prompt_id: 'p1', number: 1, node_errors: {} });
    }
    if (path === '/history/p1') {
      if (o.outcome === 'error') return json(200, { p1: { status: { status_str: 'error', completed: false, messages: [['execution_start', {}], ['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory' }]] }, outputs: {} } });
      return json(200, { p1: { status: { status_str: 'success', completed: true, messages: [] }, outputs: o.outcome === 'no-glb' ? { 12: { images: [{ filename: 'p.png', subfolder: 'nfgames', type: 'output' }] } } : { 11: { '3d': [{ filename: 'kettle_00001_.glb', subfolder: 'nfgames', type: 'output' }] } } } });
    }
    if (path === '/view') {
      calls.views.push(Object.fromEntries(url.searchParams));
      if (o.outcome === 'view-404') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary' }); return res.end(FAKE_GLB);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404: Not Found');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, set: (more) => Object.assign(o, more), close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) };
}

/** A small workflow in ComfyUI's API format with every title the model service sets, and one model file. */
export const fakeWorkflow = () => Object.fromEntries([
  ...['front', 'left', 'back', 'right', 'top', 'bottom'].map((v) => ['LoadImage', `in_${v}_image`, { image: `${v}.png` }]),
  ['PrimitiveBoolean', 'in_use_top_bottom_views', { value: true }], ['PrimitiveBoolean', 'in_use_ultrashape', { value: true }],
  ['DecimateMesh', 'in_target_faces', { target_face_count: 700000 }], ['UNETLoader', 'Load the model', { unet_name: 'pixal3d.safetensors' }],
  ['Save3DAdvanced', 'out_model', { filename_prefix: '3d/x', mesh: ['9', 0] }], ['SaveImage', 'out_preview_textured', { filename_prefix: 'a' }], ['SaveImage', 'out_preview_clay', { filename_prefix: 'b' }],
].map(([class_type, title, inputs], i) => [String(i + 1), { class_type, inputs, _meta: { title } }]));
