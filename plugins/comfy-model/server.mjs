// 3D model generation: a draft's approved views go to ComfyUI on this computer (the asset3d workflow from the user's
// checkout of comfy-ui-model-workflows), the result is finished in Blender (scale, pivot, compressed textures) and
// saved as models/<slug>/<slug>.glb with <slug>.refs/ beside it, which is what the model viewer shows.
//   status   { ultrashape = true }  ->  { ready, checks: [{ id, ok, text, help }], queue, setup }
//   generate { draft, length, faces = 60000, ultrashape = true, pivot = 'centre', wait = false, replace = false }
//                                   ->  { model, refs, report, seconds }
// The rules that keep a GPU run from starting by accident are here, for every caller: nothing is queued behind other
// ComfyUI work without `wait`, and no model is replaced without `replace`.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelViews } from '../model-maker/draft.mjs';
import { readPipeline, findBlender, comfy, checksOf, setInputs, outcomeOf } from './comfy.mjs';

const POLL = 3000, LIMIT = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function activate(api) {
  const f = api.files;
  /** Everything the step needs, looked at now. Never throws: what is wrong is in the checks. */
  async function look({ ultrashape = true } = {}) {
    const url = api.settings.get('comfyUrl'), blenderSetting = String(api.settings.get('blender') || '').trim();
    let pipeline = null, pipelineError = null, client = null, info = null, comfyError = null, a3d = null, queue = null;
    try { pipeline = readPipeline(api.settings.get('workflowsDir')); } catch (e) { pipelineError = e.message; }
    try { client = comfy(url); [info, queue] = await Promise.all([client.objectInfo(), client.queueLength()]); if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error(`What answers at ${client.base} is not ComfyUI.`); }
    catch (e) { info = null; queue = null; comfyError = e.message; }
    if (info) { try { a3d = await client.asset3dStatus(); } catch { a3d = null; } }
    const blender = findBlender(blenderSetting);
    const { checks, setup } = checksOf({ pipeline, pipelineError, url: client?.base || url, info, comfyError, a3d, blender, blenderSetting, ultrashape });
    return { pipeline, client, blender, checks, setup, queue, ready: checks.every((c) => c.ok !== false) };
  }

  api.services.provide('model', 'status', async (input = {}) => {
    const { ready, checks, queue, setup } = await look({ ultrashape: input.ultrashape !== false });
    return { ready, checks, queue, setup };
  });

  api.services.provide('model', 'generate', async (input = {}) => {
    const slug = input.draft, dir = `.nfgames/drafts/${slug}`;
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,45}$/.test(slug) || !f.exists(`${dir}/draft.json`)) throw new Error('draft: no such draft');
    let draft = null; try { draft = JSON.parse(f.read(`${dir}/draft.json`)); } catch { /* below */ }
    if (!draft || draft.version !== 1 || draft.slug !== slug) throw new Error('draft: its file cannot be read');
    if (draft.status !== 'ready') throw new Error('draft: approve the views first');
    const { views, missing } = modelViews(draft);
    if (missing.length) throw new Error(`draft: a model needs the front, left, back and right views; missing ${missing.join(', ')}`);
    const length = input.length, faces = Math.round(Number(input.faces ?? 60000)), ultrashape = input.ultrashape !== false, pivot = input.pivot === 'base' ? 'base' : 'centre';
    if (typeof length !== 'number' || !Number.isFinite(length) || !(length > 0) || length > 100000) throw new Error('length: the longest side in metres, more than 0');
    if (!Number.isFinite(faces) || faces < 1000 || faces > 2000000) throw new Error('faces: from 1000 to 2000000 triangles');
    const kept = api.project.options?.models;
    if (kept === false || (typeof kept === 'string' && !['', '.', 'models'].includes(kept.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))))
      throw new Error(`models: this project keeps its models in ${kept === false ? 'no folder' : kept}; the model step writes to models/`);
    const model = `models/${slug}/${slug}.glb`, refs = `models/${slug}/${slug}.refs`;
    if (f.exists(model) && input.replace !== true) throw new Error(`${model} is already there: say replace to make it again`);
    for (const v of ['concept', ...views]) if (!f.exists(v === 'concept' ? `${dir}/concept.png` : `${dir}/views/${v}.png`)) throw new Error(`draft: its ${v} image is missing: approve the views again`);

    const seen = await look({ ultrashape });
    if (!seen.ready) throw new Error(`Not ready: ${seen.checks.filter((c) => c.ok === false).map((c) => c.text).join('; ')}`);
    if (seen.queue > 0 && input.wait !== true) throw new Error(`ComfyUI is working on ${seen.queue} other prompt${seen.queue > 1 ? 's' : ''}: say wait to queue behind ${seen.queue > 1 ? 'them' : 'it'}`);
    const { client, pipeline, blender } = seen, poles = views.includes('top') && views.includes('bottom');
    const raw = join(api.storage, `${slug}-raw.glb`), out = join(api.storage, `${slug}.glb`), started = Date.now();
    for (const old of [raw, out]) rmSync(old, { force: true });
    const sent = {}; let id = null, glb = null, report = null, run = null;

    run = api.jobs.run(`Generate model: ${draft.name}`, [
      { label: 'Send the views', run: async (log) => {
        for (const v of views) { sent[v] = await client.upload(`${v}.png`, `nfgames/${slug}`, f.read(`${dir}/views/${v}.png`, null)); log(`${v} -> ${sent[v]}\n`); }
      } },
      { label: 'Generate (ComfyUI)', run: async (log) => {
        id = await client.prompt(setInputs(pipeline.multiview, { views: sent, poles, ultrashape, faces, prefix: `nfgames/${slug}` }));
        log(`queued as ${id}: ${views.length} views, ${faces} triangles${ultrashape ? ', refined with UltraShape' : ''}\n`);
        for (let said = Date.now(); ;) {
          const entry = await client.history(id);
          if (entry?.status?.status_str) { const o = outcomeOf(entry); if (!o.ok) throw new Error(o.error); if (!o.glb) throw new Error('ComfyUI finished without a model in its output'); glb = o.glb; break; }
          if (Date.now() - started > LIMIT) throw new Error(`still running after 30 minutes (prompt ${id}); it goes on in ComfyUI`);
          if (Date.now() - said >= 30000) { said = Date.now(); log(`${Math.round((Date.now() - started) / 1000)} s…\n`); }
          await sleep(POLL);
        }
        log(`generated in ${Math.round((Date.now() - started) / 1000)} s: ${glb.filename}\n`);
      } },
      { label: 'Fetch the model', run: async (log) => { const bytes = await client.view(glb); writeFileSync(raw, bytes); log(`${(bytes.length / 1e6).toFixed(1)} MB\n`); } },
      { label: 'Finish (Blender)', command: [blender, '--background', '--factory-startup', '--python', pipeline.finish, '--', raw, out, '--length', String(length), '--name', slug, '--pivot', pivot], cwd: api.storage },
      { label: 'Save', run: async (log) => {
        const line = run.job.log.split(/\r?\n/).reverse().find((l) => l.startsWith('FINISH '));
        if (!line || !existsSync(out)) throw new Error('Blender finished without writing the model');
        try { report = JSON.parse(line.slice(7)); } catch { report = {}; }
        f.write(model, readFileSync(out));
        f.remove(refs);
        f.write(`${refs}/concept.png`, f.read(`${dir}/concept.png`, null));
        for (const v of draft.views.list) if (f.exists(`${dir}/views/${v}.png`)) f.write(`${refs}/${v}.png`, f.read(`${dir}/views/${v}.png`, null));
        log(`${model}\n`);
      } },
    ]);
    const job = await run.done;
    for (const old of [raw, out]) rmSync(old, { force: true });
    if (job.state !== 'done') {
      const m = /== .* stopped at "([^"]+)": ([^\n]*)/.exec(job.log.slice(-4000));
      throw new Error(m ? `${m[1]}: ${m[2]}${m[1].startsWith('Finish') ? ' (see Jobs for Blender\'s output)' : ''}` : 'The model was not made: see Jobs for what happened');
    }
    return { model, refs, report, seconds: Math.round((Date.now() - started) / 1000) };
  });
}
