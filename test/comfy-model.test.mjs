// The model service: what it needs checked one by one, and a draft's views through a stand-in ComfyUI and a stand-in
// Blender into models/<slug>/. No ComfyUI, Blender or GPU is used.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import { programOf } from '../src/plugins/manager.mjs';
import { readPipeline, findBlender, findAutoRemesher, SOURCE_FACES, missingModels, missingNodes, setInputs, outcomeOf, checksOf, comfy } from '../plugins/comfy-model/comfy.mjs';
import { newDraft, startRound, settleRound, pickConcept, approveConcept, setViews, pickView, approveViews } from '../plugins/model-maker/draft.mjs';
import { REPO, sampleCopy, fakeCommand, dataBytes, PNG_1PX } from './helpers.mjs';
import { fakeComfy, fakeWorkflow, FAKE_GLB } from './fake-comfy.mjs';

// a stand-in for Blender: copies the model it is given to where it should write, and reports like the finish script
const BLENDER = `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), rest = a.slice(a.indexOf('--') + 1), name = rest[rest.indexOf('--name') + 1];
if (/score\.py$/.test(a[a.indexOf('--python') + 1] || '')) {   // the editor's own scorer, on the references alone: the left and right outlines agree 0.6 for a draft called "crooked"
  const cfg = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
  if (!a.includes('-b') || !a.includes('--factory-startup') || !cfg.refsOnly || cfg.planUp !== 'up' || Object.values(cfg.refs).some((f) => !fs.existsSync(f))) { console.error('wrong scorer arguments'); process.exit(6); }
  if (process.env.NF_SCORER_LOG) fs.appendFileSync(process.env.NF_SCORER_LOG, Object.keys(cfg.refs).join(',') + '\\n');
  const crooked = /crooked/.test(cfg.refs.front), views = {}, pairs = {};
  for (const v of Object.keys(cfg.refs)) views[v] = { background: 'clean', refSize: [100, 100], refExtent: [100, 100], planUp: null };
  if (cfg.refs.left && cfg.refs.right) pairs['left-right'] = { outline: crooked ? 0.6 : 0.98, colour: 0.5 };
  if (cfg.refs.front && cfg.refs.back) pairs['front-back'] = { outline: 0.98, colour: 0.5 };
  fs.writeFileSync(cfg.result, JSON.stringify({ ok: true, refsOnly: true, views, pairs, warnings: [], seconds: 2 }));
  process.exit(0);
}
if (!a.includes('--background') || !a.includes('--python')) { console.error('not headless'); process.exit(4); }
if (/fails/.test(name)) { console.error('Error: Python: Traceback'); process.exit(3); }
if (/blender_retopo\.py$/.test(a[a.indexOf('--python') + 1])) {
  if (/crumples/.test(name)) { console.error('AutoRemesher failed (exit 1)'); process.exit(1); }
  if (!fs.existsSync(rest[rest.indexOf('--autoremesher') + 1]) || rest[rest.indexOf('--image-format') + 1] !== 'AUTO') { console.error('no remesher'); process.exit(5); }
  fs.copyFileSync(rest[0], rest[1]);
  console.log('RETOPO ' + JSON.stringify({ name, before: { faces: 200000 }, after: { faces: Number(rest[rest.indexOf('--quads') + 1]) + 4, quads: Number(rest[rest.indexOf('--quads') + 1]) }, baked: ['base colour', 'normal'] }));
  process.exit(0);
}
if (!/silent/.test(name)) fs.copyFileSync(rest[0], rest[1]);
console.log('FINISH ' + JSON.stringify({ name, length: Number(rest[rest.indexOf('--length') + 1]), pivot: rest[rest.indexOf('--pivot') + 1], after: { triangles: 12 } }));`;

/** A workflows folder as the repository lays it out. */
function workflowsDir(top, name = 'workflows', pipeline = {}) {
  const dir = join(top, name); mkdirSync(join(dir, 'workflows', 'api'), { recursive: true }); mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'workflows', 'api', 'mv.json'), JSON.stringify(fakeWorkflow())); writeFileSync(join(dir, 'tools', 'blender_finish.py'), '# finish\n'); writeFileSync(join(dir, 'tools', 'blender_retopo.py'), '# clean-up\n');
  writeFileSync(join(dir, 'pipeline.json'), JSON.stringify({ pipeline: 'asset3d', version: 1, multiview: 'workflows/api/mv.json', finish: 'tools/blender_finish.py', cleanup: 'tools/blender_retopo.py', setup: 'https://example.org/setup', ...pipeline }));
  return dir;
}

describe('the model service\'s parts', () => {
  let top;
  before(() => { top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-comfy-parts-'))); });
  after(() => rmSync(top, { recursive: true, force: true }));

  it('a job\'s program goes by its name, whatever its folder, its case or its .exe', () => {
    assert.equal(programOf('C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender.exe'), 'blender');
    assert.equal(programOf('/Applications/Blender.app/Contents/MacOS/Blender'), 'blender');
    assert.equal(programOf('codex'), 'codex'); assert.equal(programOf('/bin/rm'), 'rm'); assert.equal(programOf('blender.exe.cmd'), 'blender.exe.cmd');
  });
  it('the workflows folder is read from its pipeline.json, and says what is wrong with it', () => {
    const p = readPipeline(workflowsDir(top));
    assert.equal(p.version, 1); assert.equal(Object.keys(p.multiview).length, 13); assert.ok(existsSync(p.finish)); assert.equal(p.setup, 'https://example.org/setup');
    assert.throws(() => readPipeline(''), /Set the workflows folder/); assert.throws(() => readPipeline(undefined), /Set the workflows folder/);
    assert.throws(() => readPipeline(join(top, 'nowhere')), /not there/);
    mkdirSync(join(top, 'empty')); assert.throws(() => readPipeline(join(top, 'empty')), /no pipeline\.json/);
    assert.throws(() => readPipeline(workflowsDir(top, 'v2', { version: 2 })), /version 2; this editor knows version 1/);
    assert.throws(() => readPipeline(workflowsDir(top, 'other', { pipeline: 'video' })), /not the asset3d pipeline/);
    assert.throws(() => readPipeline(workflowsDir(top, 'gone', { finish: 'tools/none.py' })), /missing tools\/none\.py/);
    assert.throws(() => readPipeline(workflowsDir(top, 'out', { finish: '../workflows/tools/blender_finish.py' })), /inside the folder/);
    const bad = workflowsDir(top, 'canvas'); writeFileSync(join(bad, 'workflows', 'api', 'mv.json'), JSON.stringify({ nodes: [], links: [] }));
    assert.throws(() => readPipeline(bad), /API format/);
    assert.equal(readPipeline(workflowsDir(top, 'http', { setup: 'javascript:alert(1)' })).setup, null);
    assert.ok(existsSync(p.cleanup)); assert.equal(readPipeline(workflowsDir(top, 'older', { cleanup: undefined })).cleanup, null);   // a checkout from before the clean-up
    assert.throws(() => readPipeline(workflowsDir(top, 'nocleanup', { cleanup: 'tools/none.py' })), /missing tools\/none\.py/);
  });
  it('Blender: the setting, else the PATH, else where it is usually installed, the newest first', () => {
    const at = (files) => ({ exists: (f) => files.includes(f), list: (d) => files.filter((f) => f.startsWith(`${d}\\`)).map((f) => f.slice(d.length + 1).split('\\')[0]) });
    assert.equal(findBlender('D:\\b\\blender.exe', { platform: 'win32', env: {}, ...at(['D:\\b\\blender.exe']) }), 'D:\\b\\blender.exe');
    assert.equal(findBlender('D:\\b\\blender.exe', { platform: 'win32', env: { PATH: 'C:\\bin' }, ...at(['C:\\bin\\blender.exe']) }), null);   // a setting that is wrong is not papered over
    assert.equal(findBlender('', { platform: 'win32', env: { PATH: 'C:\\a;C:\\bin' }, ...at(['C:\\bin\\blender.exe']) }), 'C:\\bin\\blender.exe');
    const pf = 'C:\\Program Files\\Blender Foundation';
    assert.equal(findBlender('', { platform: 'win32', env: { PATH: '', ProgramFiles: 'C:\\Program Files' }, ...at([`${pf}\\Blender 4.2\\blender.exe`, `${pf}\\Blender 5.3\\blender.exe`, `${pf}\\Blender 10.0\\blender.exe`]) }), `${pf}\\Blender 10.0\\blender.exe`);
    assert.equal(findBlender('', { platform: 'darwin', env: { PATH: '/usr/bin' }, ...at(['/Applications/Blender.app/Contents/MacOS/Blender']) }), '/Applications/Blender.app/Contents/MacOS/Blender');
    assert.equal(findBlender('', { platform: 'linux', env: { PATH: '/usr/bin:/opt/b' }, ...at(['/opt/b/blender']) }), '/opt/b/blender');
    assert.equal(findBlender('', { platform: 'win32', env: {}, exists: () => false, list: () => { throw new Error('no'); } }), null);
  });
  it('missing node types and model files are named; the views\' loaders are not model files', () => {
    const g = fakeWorkflow(), info = { LoadImage: { input: { required: { image: [['a.png'], {}] } } }, UNETLoader: { input: { required: { unet_name: ['COMBO', { options: ['other.safetensors'] }] } } } };
    assert.deepEqual(missingNodes(g, info), ['DecimateMesh', 'PrimitiveBoolean', 'Save3DAdvanced', 'SaveImage']);
    assert.deepEqual(missingModels(g, info), [{ node: 'UNETLoader', input: 'unet_name', value: 'pixal3d.safetensors' }]);
    info.UNETLoader.input.required.unet_name = [['pixal3d.safetensors'], {}]; assert.deepEqual(missingModels(g, info), []);
  });
  it('a draft\'s inputs are set by node title; unused poles still name a file', () => {
    const views = Object.fromEntries(['front', 'left', 'back', 'right', 'top', 'bottom'].map((v) => [v, `nfgames/k/${v}.png`]));
    const by = (g) => Object.fromEntries(Object.values(g).map((n) => [n._meta.title, n.inputs]));
    const six = by(setInputs(fakeWorkflow(), { views, poles: true, ultrashape: false, faces: 60000, prefix: 'nfgames/k' }));
    assert.equal(six.in_left_image.image, 'nfgames/k/left.png'); assert.equal(six.in_bottom_image.image, 'nfgames/k/bottom.png'); assert.equal(six.in_use_top_bottom_views.value, true);
    assert.equal(six.in_use_ultrashape.value, false); assert.equal(six.in_target_faces.target_face_count, 60000);
    assert.equal(six.out_model.filename_prefix, 'nfgames/k'); assert.equal(six.out_preview_clay.filename_prefix, 'nfgames/k_preview_clay'); assert.deepEqual(six.out_model.mesh, ['9', 0]);
    const four = by(setInputs(fakeWorkflow(), { views, poles: false, ultrashape: true, faces: 1, prefix: 'p' }));
    assert.equal(four.in_top_image.image, 'nfgames/k/front.png'); assert.equal(four.in_use_top_bottom_views.value, false);
    const short = fakeWorkflow(); delete short['9'];
    assert.throws(() => setInputs(short, { views, poles: true, ultrashape: true, faces: 1, prefix: 'p' }), /no "in_target_faces"/);
  });
  it('a finished prompt: its model, its error, or nothing', () => {
    assert.deepEqual(outcomeOf({ status: { status_str: 'success' }, outputs: { 5: { '3d': [{ filename: 'a.glb', subfolder: 's', type: 'output' }] } } }), { ok: true, error: null, glb: { filename: 'a.glb', subfolder: 's', type: 'output' } });
    assert.equal(outcomeOf({ status: { status_str: 'success' }, outputs: { 5: { '3d': [{ filename: 'a.glb', subfolder: 's', type: 'temp' }], text: 'x' } } }).glb, null);
    assert.match(outcomeOf({ status: { status_str: 'error', messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory' }]] } }).error, /KSampler: CUDA out of memory/);
    assert.match(outcomeOf({ status: { status_str: 'error', messages: [['execution_interrupted', {}]] } }).error, /stopped in ComfyUI/);
  });
  it('the checks: UltraShape counts only when it is asked for; an old node pack is "not checked"', () => {
    const base = { pipeline: readPipeline(workflowsDir(top, 'c')), url: 'http://x', info: Object.fromEntries(['LoadImage', 'PrimitiveBoolean', 'DecimateMesh', 'Save3DAdvanced', 'SaveImage'].map((n) => [n, { input: {} }]).concat([['UNETLoader', { input: { required: { unet_name: [['pixal3d.safetensors'], {}] } } }]])), blender: '/b' };
    const models = (more) => checksOf({ ...base, ...more }).checks.find((c) => c.id === 'models');
    assert.equal(models({ a3d: { ultrashape: { code: true, packages: [], checkpoints: ['u.pt'] } } }).ok, true);
    const none = models({ a3d: { ultrashape: { code: false, packages: ['omegaconf'], checkpoints: [] } } });
    assert.equal(none.ok, false); assert.match(none.text, /UltraShape's code; Python packages: omegaconf; UltraShape's checkpoint/);
    assert.equal(models({ a3d: { ultrashape: { code: false, packages: [], checkpoints: [] } }, ultrashape: false }).ok, true);
    const old = models({ a3d: null }); assert.equal(old.ok, null); assert.match(old.text, /UltraShape: not checked/);
    assert.deepEqual(checksOf({ ...base, a3d: null }).checks.map((c) => c.id), ['workflows', 'comfy', 'nodes', 'models', 'blender']);
    const tidy = (more) => checksOf({ ...base, a3d: null, cleanup: true, ...more }).checks.find((c) => c.id === 'cleanup');
    assert.equal(tidy({ remesher: '/r/autoremesher' }).ok, true);
    assert.equal(tidy({}).ok, false); assert.match(tidy({}).text, /AutoRemesher was not found/); assert.match(tidy({ remesherSetting: '/x/ar' }).text, /is not at \/x\/ar/);
    const older = tidy({ remesher: '/r/autoremesher', pipeline: { ...base.pipeline, cleanup: null } }); assert.equal(older.ok, false); assert.match(older.text, /no clean-up script/);
  });
  it('AutoRemesher: the setting, else the PATH; a setting that names nothing is not replaced by a guess', () => {
    const at = (files) => ({ exists: (f) => files.includes(f) });
    assert.equal(findAutoRemesher('D:\\ar\\autoremesher.exe', { ...at(['D:\\ar\\autoremesher.exe']), platform: 'win32', env: {} }), 'D:\\ar\\autoremesher.exe');
    assert.equal(findAutoRemesher('D:\\gone.exe', { ...at(['C:\\bin\\autoremesher.exe']), platform: 'win32', env: { Path: 'C:\\bin' } }), null);
    assert.equal(findAutoRemesher('', { ...at(['C:\\bin\\autoremesher.exe']), platform: 'win32', env: { Path: 'C:\\x;C:\\bin' } }), 'C:\\bin\\autoremesher.exe');
    assert.equal(findAutoRemesher('', { ...at(['/opt/ar/AutoRemesher']), platform: 'darwin', env: { PATH: '/usr/bin:/opt/ar' } }), '/opt/ar/AutoRemesher');
    assert.equal(findAutoRemesher('', { ...at([]), platform: 'linux', env: { PATH: '/usr/bin' } }), null);
  });
  it('an address that is not one is refused before anything is asked', () => {
    for (const bad of ['', 'localhost:8188', 'file:///etc', 'http://a/b', null]) assert.throws(() => comfy(bad), /address should look like/, String(bad));
    assert.equal(comfy('http://127.0.0.1:8188/').base, 'http://127.0.0.1:8188');
  });
});

describe('the model service', () => {
  const port = 23393 + (process.pid % 500), origin = `http://127.0.0.1:${port}`, KEY = 'nfgames.comfy-model/model';
  let top, copy, host, restorePath, fake, flows, bin, remesher;
  const call = (action, input = {}) => fetch(`${origin}/api/services/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ key: KEY, action, input, confirmed: true }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const status = async (input) => { const r = await call('status', input); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.result; };
  const settings = (values) => writeFileSync(join(top, 'state', 'plugin-settings.json'), JSON.stringify({ 'nfgames.comfy-model': values }));
  const check = (s, id) => s.checks.find((c) => c.id === id);
  const inProject = (...rest) => join(copy.root, ...rest);
  /** A ready draft on disk, as New model leaves one: draft.json, concept.png and the approved views. */
  function ready(slug, list = ['front', 'back', 'left', 'right']) {
    const img = (n) => `.nfgames/images/${slug}-${n}/image-1.png`;
    let d = newDraft({ slug, name: slug, description: 'a thing' });
    ({ draft: d } = startRound(d, 'concept', { prompt: 'p', count: 1, folder: 'c', at: 1 }));
    d = setViews(approveConcept(pickConcept(settleRound(d, 'concept', 'r1', { images: [img('c')] }), img('c'))), { list });
    for (const v of d.views.list) { ({ draft: d } = startRound(d, v, { prompt: 'p', count: 1, folder: v, at: 2 })); d = pickView(settleRound(d, v, 'r1', { images: [img(v)] }), v, img(v)); }
    d = approveViews(d);
    const dir = inProject('.nfgames', 'drafts', slug); mkdirSync(join(dir, 'views'), { recursive: true });
    writeFileSync(join(dir, 'draft.json'), JSON.stringify(d)); writeFileSync(join(dir, 'concept.png'), dataBytes(PNG_1PX));
    for (const v of d.views.list) writeFileSync(join(dir, 'views', `${v}.png`), Buffer.concat([dataBytes(PNG_1PX), Buffer.from(v)]));
    return d;
  }
  const titles = (graph) => Object.fromEntries(Object.values(graph).map((n) => [n._meta.title, n.inputs]));

  before(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'nfgames-comfy-'))); copy = sampleCopy(); bin = join(top, 'bin');
    const builtinDir = join(top, 'builtin');
    for (const p of ['comfy-model', 'model-maker']) cpSync(join(REPO, 'plugins', p), join(builtinDir, p), { recursive: true });
    symlinkSync(join(REPO, 'src'), join(top, 'src'), 'junction');   // where the copied plugin's `../../src/match.mjs` leads, as in the repository
    restorePath = fakeCommand(bin, 'blender', BLENDER);
    flows = workflowsDir(top); mkdirSync(join(top, 'state'), { recursive: true });
    remesher = join(top, 'autoremesher-stand-in'); writeFileSync(remesher, '');   // only where it is matters: Blender is what would run it
    host = await createHost({ root: copy.root, port, pluginDirs: { builtinDir, userDir: join(top, 'user'), packagesDir: join(top, 'packages') }, stateDir: join(top, 'state'), home: top, securityBin: null });
    await host.listen();
  });
  beforeEach(async () => { if (fake) await fake.close(); fake = await fakeComfy(); settings({ comfyUrl: fake.url, workflowsDir: flows }); });
  after(async () => { restorePath(); if (fake) await fake.close(); await new Promise((d) => { host.server.closeAllConnections(); host.server.close(d); }); copy.done(); rmSync(top, { recursive: true, force: true }); });

  it('is listed as a service that needs no key', async () => {
    const s = (await (await fetch(`${origin}/api/services`)).json()).services.find((x) => x.key === KEY);
    assert.ok(s); assert.equal(s.connected, true); assert.deepEqual(s.actions.map((a) => a.id), ['status', 'generate', 'checkViews']);
  });
  it('status: everything there', async () => {
    const s = await status();
    assert.equal(s.ready, true); assert.deepEqual(s.checks.map((c) => [c.id, c.ok]), [['workflows', true], ['comfy', true], ['nodes', true], ['models', true], ['blender', true]]);
    assert.equal(s.queue, 0); assert.equal(s.setup, 'https://example.org/setup');
  });
  it('status: no workflows folder, or one of another version; the rest is still answered', async () => {
    settings({ comfyUrl: fake.url, workflowsDir: '' });
    let s = await status(); assert.equal(s.ready, false); assert.match(check(s, 'workflows').text, /Set the workflows folder/);
    assert.equal(check(s, 'comfy').ok, true); assert.equal(check(s, 'nodes').ok, null); assert.equal(check(s, 'blender').ok, true);
    settings({ comfyUrl: fake.url, workflowsDir: workflowsDir(top, 'v2', { version: 2 }) });
    s = await status(); assert.match(check(s, 'workflows').text, /knows version 1/);
  });
  it('status: ComfyUI not there, or something else answering: said within seconds, never thrown', async () => {
    const dead = fake.url; await fake.close(); fake = null;
    settings({ comfyUrl: dead, workflowsDir: flows });
    const began = Date.now(); let s = await status();
    assert.ok(Date.now() - began < 6000); assert.equal(s.ready, false); assert.match(check(s, 'comfy').text, /does not answer/);
    assert.equal(check(s, 'nodes').ok, null); assert.equal(check(s, 'models').ok, null); assert.equal(s.queue, null);
    fake = await fakeComfy({ outcome: 'html' }); settings({ comfyUrl: fake.url, workflowsDir: flows });
    s = await status(); assert.match(check(s, 'comfy').text, /is not ComfyUI/);
    settings({ comfyUrl: 'not an address', workflowsDir: flows });
    s = await status(); assert.match(check(s, 'comfy').text, /address should look like/);
  });
  it('status: a node type, a model file, UltraShape or Blender missing is named', async () => {
    fake.set({ nodes: ['LoadImage', 'PrimitiveBoolean', 'UNETLoader', 'Save3DAdvanced', 'SaveImage'] });
    let s = await status(); assert.equal(check(s, 'nodes').ok, false); assert.match(check(s, 'nodes').text, /DecimateMesh/); assert.equal(check(s, 'models').ok, null);
    fake.set({ nodes: ['LoadImage', 'PrimitiveBoolean', 'DecimateMesh', 'UNETLoader', 'Save3DAdvanced', 'SaveImage'], models: [] });
    s = await status(); assert.equal(check(s, 'models').ok, false); assert.match(check(s, 'models').text, /pixal3d\.safetensors/);
    fake.set({ models: ['pixal3d.safetensors'], a3d: undefined });
    s = await status(); assert.equal(check(s, 'models').ok, null); assert.match(check(s, 'models').text, /UltraShape: not checked/); assert.equal(s.ready, true);
    fake.set({ a3d: { version: 1, ultrashape: { code: false, packages: [], checkpoints: [] } } });
    assert.equal(check(await status(), 'models').ok, false); assert.equal(check(await status({ ultrashape: false }), 'models').ok, true);
    settings({ comfyUrl: fake.url, workflowsDir: flows, blender: join(top, 'no', 'blender') });
    s = await status({ ultrashape: false }); assert.equal(check(s, 'blender').ok, false); assert.equal(s.ready, false);
  });

  it('generate: four views to ComfyUI, the result through Blender into models/, with its references', async () => {
    ready('kettle');
    const r = await call('generate', { draft: 'kettle', length: 0.4 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const out = r.body.result;
    assert.equal(out.model, 'models/kettle/kettle.glb'); assert.equal(out.refs, 'models/kettle/kettle.refs');
    assert.deepEqual(out.report, { name: 'kettle', length: 0.4, pivot: 'centre', after: { triangles: 12 }, views: null });   // the views were never checked
    assert.deepEqual(readFileSync(inProject('models', 'kettle', 'kettle.glb')), FAKE_GLB);
    assert.deepEqual(readdirSync(inProject('models', 'kettle', 'kettle.refs')).sort(), ['back.png', 'concept.png', 'front.png', 'left.png', 'right.png']);
    assert.deepEqual(fake.calls.uploads.map((u) => `${u.subfolder}/${u.name}`), ['front', 'left', 'back', 'right'].map((v) => `nfgames/kettle/${v}.png`));
    assert.ok(fake.calls.uploads.every((u) => u.type === 'input' && u.overwrite === 'true'));
    const sent = titles(fake.calls.prompts[0]);
    assert.equal(sent.in_left_image.image, 'nfgames/kettle/left.png'); assert.equal(sent.in_right_image.image, 'nfgames/kettle/right.png');
    assert.equal(sent.in_use_top_bottom_views.value, false); assert.equal(sent.in_top_image.image, 'nfgames/kettle/front.png');
    assert.equal(sent.in_use_ultrashape.value, true); assert.equal(sent.in_target_faces.target_face_count, 60000); assert.equal(sent.out_model.filename_prefix, 'nfgames/kettle');
    assert.deepEqual(fake.calls.views, [{ filename: 'kettle_00001_.glb', subfolder: 'nfgames', type: 'output' }]);
    assert.deepEqual(readdirSync(join(top, 'state', 'storage', 'nfgames.comfy-model')), []);   // nothing left behind
  });
  it('clean-up: AutoRemesher is asked for only when the clean-up is; without it nothing is generated', async () => {
    let s = await status({ cleanup: true }); assert.equal(s.ready, false); assert.equal(check(s, 'cleanup').ok, false); assert.match(check(s, 'cleanup').text, /AutoRemesher was not found/);
    assert.equal(check(await status(), 'cleanup'), undefined);
    ready('nobrush');
    const r = await call('generate', { draft: 'nobrush', length: 1, cleanup: true });
    assert.notEqual(r.status, 200); assert.match(r.body.error, /Not ready: AutoRemesher was not found/); assert.equal(fake.calls.prompts.length, 0);
    settings({ comfyUrl: fake.url, workflowsDir: workflowsDir(top, 'older', { cleanup: undefined }), autoremesher: remesher });
    s = await status({ cleanup: true }); assert.match(check(s, 'cleanup').text, /no clean-up script/);
    assert.match((await call('generate', { draft: 'nobrush', length: 1, cleanup: true, quads: 20 })).body.error, /quads: from 500/);
  });
  it('clean-up: the generated mesh is made larger, goes through the clean-up and then the finish, and the report says so', async () => {
    ready('teapot'); settings({ comfyUrl: fake.url, workflowsDir: flows, autoremesher: remesher });
    assert.equal(check(await status({ cleanup: true }), 'cleanup').ok, true);
    const r = await call('generate', { draft: 'teapot', length: 0.3, cleanup: true, quads: 8000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.result.report.cleanup, { quads: 8000, faces: 8004, from: 200000, baked: ['base colour', 'normal'] });
    assert.equal(titles(fake.calls.prompts[0]).in_target_faces.target_face_count, SOURCE_FACES);
    assert.deepEqual(readFileSync(inProject('models', 'teapot', 'teapot.glb')), FAKE_GLB);
    assert.deepEqual(readdirSync(join(top, 'state', 'storage', 'nfgames.comfy-model')), []);
    ready('it-crumples');
    const bad = await call('generate', { draft: 'it-crumples', length: 1, cleanup: true });
    assert.notEqual(bad.status, 200); assert.match(bad.body.error, /Clean up into quads[^:]*: exit 1/); assert.ok(!existsSync(inProject('models', 'it-crumples')));
    assert.deepEqual(readdirSync(join(top, 'state', 'storage', 'nfgames.comfy-model')), []);
  });
  it('generate: top and bottom go too when both are approved; one of them alone does not', async () => {
    ready('crate', ['front', 'back', 'left', 'right', 'top', 'bottom']);
    assert.equal((await call('generate', { draft: 'crate', length: 1, ultrashape: false, faces: 20000, pivot: 'base' })).status, 200);
    assert.equal(fake.calls.uploads.length, 6);
    const sent = titles(fake.calls.prompts[0]);
    assert.equal(sent.in_use_top_bottom_views.value, true); assert.equal(sent.in_bottom_image.image, 'nfgames/crate/bottom.png'); assert.equal(sent.in_use_ultrashape.value, false); assert.equal(sent.in_target_faces.target_face_count, 20000);
    assert.ok(existsSync(inProject('models', 'crate', 'crate.refs', 'bottom.png')));
    ready('lamp', ['front', 'back', 'left', 'right', 'top', 'three-quarter']);
    assert.equal((await call('generate', { draft: 'lamp', length: 1 })).status, 200);
    assert.equal(fake.calls.uploads.length, 10); assert.equal(titles(fake.calls.prompts[1]).in_use_top_bottom_views.value, false);
    assert.ok(existsSync(inProject('models', 'lamp', 'lamp.refs', 'three-quarter.png')));   // kept as a reference, not sent
  });
  it('generate: nothing is queued behind other ComfyUI work unless told to wait', async () => {
    ready('stool'); fake.set({ queue: 2 });
    const no = await call('generate', { draft: 'stool', length: 1 });
    assert.notEqual(no.status, 200); assert.match(no.body.error, /2 other prompts/); assert.equal(fake.calls.uploads.length, 0); assert.ok(!existsSync(inProject('models', 'stool')));
    assert.equal((await call('generate', { draft: 'stool', length: 1, wait: true })).status, 200);
  });
  it('generate: a model that is there is replaced only when told to, and nothing else in its folder is touched', async () => {
    ready('bench');
    assert.equal((await call('generate', { draft: 'bench', length: 2 })).status, 200);
    writeFileSync(inProject('models', 'bench', 'notes.txt'), 'mine'); writeFileSync(inProject('models', 'bench', 'bench.refs', 'old.png'), 'old');
    const no = await call('generate', { draft: 'bench', length: 2 });
    assert.notEqual(no.status, 200); assert.match(no.body.error, /already there/); assert.equal(fake.calls.prompts.length, 1);
    assert.equal((await call('generate', { draft: 'bench', length: 2, replace: true })).status, 200);
    assert.equal(readFileSync(inProject('models', 'bench', 'notes.txt'), 'utf8'), 'mine'); assert.ok(!existsSync(inProject('models', 'bench', 'bench.refs', 'old.png')));
  });
  for (const [outcome, why] of [['reject', /refused the workflow: Prompt outputs failed validation; UNETLoader: Value not in list/], ['error', /KSampler: CUDA out of memory/], ['no-glb', /without a model/], ['view-404', /answered 404/]])
    it(`generate: ComfyUI ${outcome}: it fails saying why, and nothing is written`, async () => {
      ready(`case-${outcome}`); fake.set({ outcome });
      const r = await call('generate', { draft: `case-${outcome}`, length: 1 });
      assert.notEqual(r.status, 200); assert.match(r.body.error, why); assert.ok(!existsSync(inProject('models', `case-${outcome}`)));
    });
  it('generate: Blender failing, or finishing without a model: it fails, and nothing is written', async () => {
    for (const slug of ['it-fails', 'silent-one']) {
      ready(slug);
      const r = await call('generate', { draft: slug, length: 1 });
      assert.notEqual(r.status, 200, slug); assert.match(r.body.error, slug === 'it-fails' ? /Finish \(Blender\): exit 3/ : /without writing the model/); assert.ok(!existsSync(inProject('models', slug)));
    }
  });
  it('generate: a draft that is not ready, lacks a side or names no length is refused before ComfyUI is asked', async () => {
    ready('nosides', ['front', 'back', 'three-quarter']);
    for (const [input, why] of [[{ draft: 'nosides', length: 1 }, /draft: .*missing left, right/], [{ draft: 'nobody', length: 1 }, /no such draft/], [{ draft: '../kettle', length: 1 }, /no such draft/],
      [{ draft: 'kettle', length: 0 }, /length/], [{ draft: 'kettle', length: '3' }, /length/], [{ draft: 'kettle' }, /length/], [{ draft: 'kettle', length: 1, faces: 5 }, /faces/]]) {
      const r = await call('generate', input); assert.notEqual(r.status, 200, JSON.stringify(input)); assert.match(r.body.error, why);
    }
    const d = JSON.parse(readFileSync(inProject('.nfgames', 'drafts', 'kettle', 'draft.json'), 'utf8'));
    writeFileSync(inProject('.nfgames', 'drafts', 'kettle', 'draft.json'), JSON.stringify({ ...d, status: 'views', views: { ...d.views, approved: false } }));
    assert.match((await call('generate', { draft: 'kettle', length: 1, replace: true })).body.error, /approve the views first/);
    assert.equal(fake.calls.prompts.length, 0);
  });
  it('generate: not ready says what is missing', async () => {
    ready('late'); settings({ comfyUrl: fake.url, workflowsDir: '' });
    const r = await call('generate', { draft: 'late', length: 1 });
    assert.notEqual(r.status, 200); assert.match(r.body.error, /Not ready: Set the workflows folder/);
  });
  describe('check the views against each other', () => {
    let log, runs;
    beforeEach(() => { log = join(top, 'scorer-runs.log'); rmSync(log, { force: true }); process.env.NF_SCORER_LOG = log; runs = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0); });
    after(() => { delete process.env.NF_SCORER_LOG; });
    const checkViews = async (draft) => { const r = await call('checkViews', { draft }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.result; };
    it('a draft whose opposite views disagree is warned about; one whose views agree is not', async () => {
      ready('crooked-pot'); ready('straight-pot', ['front', 'back', 'left', 'right', 'top', 'three-quarter']);
      const bad = await checkViews('crooked-pot');
      assert.equal(bad.checked, true); assert.equal(bad.warnings.length, 1); assert.match(bad.warnings[0], /left and right: their outlines agree 0\.60 \(below 0\.9\)/);
      assert.equal(bad.pairs['left-right'].outline, 0.6); assert.equal(bad.seconds, 2); assert.equal(runs(), 1);
      const good = await checkViews('straight-pot');
      assert.equal(good.checked, true); assert.deepEqual(good.warnings, []); assert.deepEqual(good.notes, []); assert.equal(runs(), 2);
      assert.equal(readFileSync(log, 'utf8').split('\n')[1], 'front,back,left,right,top');   // the approved views that have a file; three-quarter is never sent
      assert.deepEqual(readdirSync(join(top, 'state', 'storage', 'nfgames.comfy-model')).filter((f) => !/^views-.*\.json$/.test(f)), []);   // only the kept answers stay
    });
    it('a second call, and a changed viewsOutline, start no job; a changed view file starts one', async () => {
      ready('crooked-jug');
      assert.equal((await checkViews('crooked-jug')).warnings.length, 1); assert.equal(runs(), 1);
      const again = await checkViews('crooked-jug'); assert.equal(again.warnings.length, 1); assert.equal(again.seconds, 0); assert.equal(runs(), 1);
      settings({ comfyUrl: fake.url, workflowsDir: flows, viewsOutline: 0.5 });
      assert.deepEqual((await checkViews('crooked-jug')).warnings, []); assert.equal(runs(), 1);
      settings({ comfyUrl: fake.url, workflowsDir: flows, viewsOutline: 'high' });   // not a number: 0.9
      assert.equal((await checkViews('crooked-jug')).warnings.length, 1); assert.equal(runs(), 1);
      writeFileSync(inProject('.nfgames', 'drafts', 'crooked-jug', 'views', 'left.png'), Buffer.concat([dataBytes(PNG_1PX), Buffer.from('redrawn')]));
      assert.equal((await checkViews('crooked-jug')).checked, true); assert.equal(runs(), 2);
      assert.equal((await checkViews('crooked-jug')).seconds, 0); assert.equal(runs(), 2);
    });
    it('generate reports the kept answer, or null when the views were never checked, and does not run the check', async () => {
      ready('crooked-vase');
      assert.equal((await call('generate', { draft: 'crooked-vase', length: 1 })).body.result.report.views, null); assert.equal(runs(), 0);
      const kept = await checkViews('crooked-vase');
      const r = await call('generate', { draft: 'crooked-vase', length: 1, replace: true });
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.result.report.views, { ...kept, seconds: 0 }); assert.equal(runs(), 1);
    });
    it('a draft that is not ready, or is not there, is refused; so is a missing Blender', async () => {
      ready('crooked-urn');
      const d = JSON.parse(readFileSync(inProject('.nfgames', 'drafts', 'crooked-urn', 'draft.json'), 'utf8'));
      writeFileSync(inProject('.nfgames', 'drafts', 'crooked-urn', 'draft.json'), JSON.stringify({ ...d, status: 'views', views: { ...d.views, approved: false } }));
      assert.match((await call('checkViews', { draft: 'crooked-urn' })).body.error, /draft: approve the views first/);
      assert.match((await call('checkViews', { draft: 'nobody' })).body.error, /draft: no such draft/);
      assert.match((await call('checkViews', { draft: '../x' })).body.error, /draft: no such draft/);
      ready('crooked-bin'); settings({ comfyUrl: fake.url, workflowsDir: flows, blender: join(top, 'no', 'blender') });
      assert.match((await call('checkViews', { draft: 'crooked-bin' })).body.error, /Not ready: Blender is not at /); assert.equal(runs(), 0);
    });
  });
});
