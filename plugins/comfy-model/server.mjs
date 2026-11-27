// 3D model generation: a draft's approved views go to ComfyUI on this computer (the asset3d workflow from the user's
// checkout of comfy-ui-model-workflows), the result is finished in Blender (scale, pivot, compressed textures) and
// saved as models/<slug>/<slug>.glb with <slug>.refs/ beside it, which is what the model viewer shows.
//   status   { ultrashape = true, cleanup = false }  ->  { ready, checks: [{ id, ok, text, help }], queue, setup }
//   checkViews { draft }            ->  { checked, pairs, consistency, warnings, notes, seconds }
//   generate { draft, length, faces = 60000, ultrashape = true, cleanup = false, quads = 12000, pivot = 'centre', wait = false, replace = false }
//                                   ->  { model, refs, report, seconds }
// cleanup: the generated mesh is remeshed into about `quads` quads with new UVs and re-baked maps (Blender runs
// AutoRemesher) before it is finished; report.cleanup then holds what that step said.
// When the workflows folder has an inspect script, the saved model is measured after it is saved: report.mesh holds
// { pieces, floating, openEdges, nonManifoldEdges, flippedFaces, zeroAreaFaces, symmetryP95 } (null when it could not be
// measured, with report.inspectError saying why). A failed inspection never takes the model away.
// checkViews looks at the approved views alone, in Blender on the CPU (seconds, no GPU): opposite views must show one
// shape. It warns; generate never waits on it. The scorer's raw answer is kept per draft with a hash of each view file,
// and the verdict is made again on every call, so changing `viewsOutline` needs no new run.
// The rules that keep a GPU run from starting by accident are here, for every caller: nothing is queued behind other
// ComfyUI work without `wait`, and no model is replaced without `replace`.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCORER, REFS_LIMITS, refsVerdict } from '../../src/match.mjs';
import { modelViews } from '../model-maker/draft.mjs';
import { readPipeline, findBlender, findAutoRemesher, comfy, checksOf, setInputs, outcomeOf, SOURCE_FACES } from './comfy.mjs';

const POLL = 3000, LIMIT = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHECKED = ['front', 'back', 'left', 'right', 'top', 'bottom'];   // the views that are compared; three-quarter is not
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function activate(api) {
  const f = api.files;
  /** Everything the step needs, looked at now. Never throws: what is wrong is in the checks. */
  async function look({ ultrashape = true, cleanup = false } = {}) {
    const url = api.settings.get('comfyUrl'), blenderSetting = String(api.settings.get('blender') || '').trim(), remesherSetting = String(api.settings.get('autoremesher') || '').trim();
    let pipeline = null, pipelineError = null, client = null, info = null, comfyError = null, a3d = null, queue = null;
    try { pipeline = readPipeline(api.settings.get('workflowsDir')); } catch (e) { pipelineError = e.message; }
    // the queue first: it answers at once and shows ComfyUI is there. Its node list is megabytes and takes seconds, and
    // ComfyUI answers one request at a time, so the two are not asked together.
    try { client = comfy(url); queue = await client.queueLength(); info = await client.objectInfo(); if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error(`What answers at ${client.base} is not ComfyUI.`); }
    catch (e) { info = null; queue = null; comfyError = e.message; }
    if (info) { try { a3d = await client.asset3dStatus(); } catch { a3d = null; } }
    const blender = findBlender(blenderSetting), remesher = cleanup ? findAutoRemesher(remesherSetting) : null;
    const { checks, setup } = checksOf({ pipeline, pipelineError, url: client?.base || url, info, comfyError, a3d, blender, blenderSetting, ultrashape, cleanup, remesher, remesherSetting });
    return { pipeline, client, blender, remesher, checks, setup, queue, ready: checks.every((c) => c.ok !== false) };
  }

  /** A draft that is ready, read from its file; throws the texts both actions use. */
  function draftOf(slug) {
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,45}$/.test(slug) || !f.exists(`.nfgames/drafts/${slug}/draft.json`)) throw new Error('draft: no such draft');
    let draft = null; try { draft = JSON.parse(f.read(`.nfgames/drafts/${slug}/draft.json`)); } catch { /* below */ }
    if (!draft || draft.version !== 1 || draft.slug !== slug) throw new Error('draft: its file cannot be read');
    if (draft.status !== 'ready') throw new Error('draft: approve the views first');
    return draft;
  }
  /** { view: bytes } of the approved views that have a file. */
  const checkedViews = (slug, draft) => Object.fromEntries(CHECKED.filter((v) => draft.views.list.includes(v) && f.exists(`.nfgames/drafts/${slug}/views/${v}.png`)).map((v) => [v, f.read(`.nfgames/drafts/${slug}/views/${v}.png`, null)]));
  const keptFile = (slug) => join(api.storage, `views-${slug}.json`);
  const hashesOf = (bytes) => Object.fromEntries(Object.entries(bytes).map(([v, b]) => [v, sha(b)]));
  /** The SHA-256 of the scorer script, or null when it cannot be read: a result is kept only against the scorer that made it. */
  const scorerHash = () => { try { return sha(readFileSync(SCORER)); } catch { return null; } };
  /** The scorer's raw result kept for these views, or null when there is none, a view or the scorer has changed since, or the record is unreadable. */
  function keptResult(slug, hashes) {
    try { const k = JSON.parse(readFileSync(keptFile(slug), 'utf8')), scorer = scorerHash(); return k && k.result && scorer && k.scorer === scorer && JSON.stringify(k.hashes) === JSON.stringify(hashes) ? k.result : null; } catch { return null; }
  }
  /** The verdict on a kept result, with the outline limit from the setting (0.5 to 0.99; 0.9 when it is not a number). */
  function verdict(result) {
    const s = api.settings.get('viewsOutline'), outline = typeof s === 'number' && Number.isFinite(s) ? Math.min(0.99, Math.max(0.5, s)) : REFS_LIMITS.outline;
    return refsVerdict(result, undefined, { ...REFS_LIMITS, outline });
  }

  api.services.provide('model', 'checkViews', async (input = {}) => {
    const slug = input.draft, draft = draftOf(slug), bytes = checkedViews(slug, draft), names = Object.keys(bytes);
    const hashes = hashesOf(bytes), old = keptResult(slug, hashes);
    if (old) return { ...verdict(old), seconds: 0 };
    if (names.length < 2) return { ...refsVerdict({ ok: false }), seconds: 0 };   // nothing to compare: no job
    const setting = String(api.settings.get('blender') || '').trim(), blender = findBlender(setting);
    if (!blender) throw new Error(`Not ready: ${setting ? `Blender is not at ${setting}` : 'Blender was not found'}`);
    const work = join(api.storage, `views-${slug}`), argsFile = join(work, 'args.json'), resultFile = join(work, 'result.json'), refs = {};
    rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
    for (const v of names) { refs[v] = join(work, `${v}.png`); writeFileSync(refs[v], bytes[v]); }
    writeFileSync(argsFile, JSON.stringify({ refs, outDir: work, result: resultFile, refsOnly: true, planUp: 'up' }));
    try {
      const job = await api.jobs.run(`Check the views: ${draft.name}`, [
        { label: 'Compare the views (Blender)', command: [blender, '-b', '--factory-startup', '--python', SCORER, '--', argsFile], cwd: api.storage },
      ]).done;
      let result = null; try { result = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { /* below */ }
      if (!result) {
        const m = /== .* stopped at "([^"]+)": ([^\n]*)/.exec(job.log.slice(-4000));
        throw new Error(m ? `${m[1]}: ${m[2]} (see Jobs for Blender's output)` : 'The views were not checked: see Jobs for what happened');
      }
      if (result.ok === true) { const scorer = scorerHash(); if (scorer) writeFileSync(keptFile(slug), JSON.stringify({ hashes, scorer, result })); }
      return { ...verdict(result), seconds: result.ok === true && Number.isFinite(result.seconds) ? result.seconds : 0 };
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  api.services.provide('model', 'status', async (input = {}) => {
    const { ready, checks, queue, setup } = await look({ ultrashape: input.ultrashape !== false, cleanup: input.cleanup === true });
    return { ready, checks, queue, setup };
  });

  api.services.provide('model', 'generate', async (input = {}) => {
    const slug = input.draft, dir = `.nfgames/drafts/${slug}`, draft = draftOf(slug);
    const { views, missing } = modelViews(draft);
    if (missing.length) throw new Error(`draft: a model needs the front, left, back and right views; missing ${missing.join(', ')}`);
    const length = input.length, faces = Math.round(Number(input.faces ?? 60000)), ultrashape = input.ultrashape !== false, pivot = input.pivot === 'base' ? 'base' : 'centre';
    if (typeof length !== 'number' || !Number.isFinite(length) || !(length > 0) || length > 100000) throw new Error('length: the longest side in metres, more than 0');
    if (!Number.isFinite(faces) || faces < 1000 || faces > 2000000) throw new Error('faces: from 1000 to 2000000 triangles');
    const cleanup = input.cleanup === true, quads = Math.round(Number(input.quads ?? 12000));
    if (cleanup && (!Number.isFinite(quads) || quads < 500 || quads > 500000)) throw new Error('quads: from 500 to 500000');
    const kept = api.project.options?.models;
    if (kept === false || (typeof kept === 'string' && !['', '.', 'models'].includes(kept.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))))
      throw new Error(`models: this project keeps its models in ${kept === false ? 'no folder' : kept}; the model step writes to models/`);
    const model = `models/${slug}/${slug}.glb`, refs = `models/${slug}/${slug}.refs`;
    if (f.exists(model) && input.replace !== true) throw new Error(`${model} is already there: say replace to make it again`);
    for (const v of ['concept', ...views]) if (!f.exists(v === 'concept' ? `${dir}/concept.png` : `${dir}/views/${v}.png`)) throw new Error(`draft: its ${v} image is missing: approve the views again`);

    const seen = await look({ ultrashape, cleanup });
    if (!seen.ready) throw new Error(`Not ready: ${seen.checks.filter((c) => c.ok === false).map((c) => c.text).join('; ')}`);
    if (seen.queue > 0 && input.wait !== true) throw new Error(`ComfyUI is working on ${seen.queue} other prompt${seen.queue > 1 ? 's' : ''}: say wait to queue behind ${seen.queue > 1 ? 'them' : 'it'}`);
    const { client, pipeline, blender, remesher } = seen, poles = views.includes('top') && views.includes('bottom');
    const raw = join(api.storage, `${slug}-raw.glb`), clean = join(api.storage, `${slug}-clean.glb`), out = join(api.storage, `${slug}.glb`), looked = join(api.storage, `${slug}-inspect`), started = Date.now();
    const made = cleanup ? Math.max(faces, SOURCE_FACES) : faces;   // triangles asked of ComfyUI
    const headless = ['--background', '--factory-startup', '--python-exit-code', '1', '--python'];   // a script that fails stops its step
    for (const old of [raw, clean, out, looked]) rmSync(old, { force: true, recursive: true });
    if (pipeline.inspect) mkdirSync(looked, { recursive: true });
    const sent = {}; let id = null, glb = null, report = null, run = null;

    run = api.jobs.run(`Generate model: ${draft.name}`, [
      { label: 'Send the views', run: async (log) => {
        for (const v of views) { sent[v] = await client.upload(`${v}.png`, `nfgames/${slug}`, f.read(`${dir}/views/${v}.png`, null)); log(`${v} -> ${sent[v]}\n`); }
      } },
      { label: 'Generate (ComfyUI)', run: async (log) => {
        id = await client.prompt(setInputs(pipeline.multiview, { views: sent, poles, ultrashape, faces: made, prefix: `nfgames/${slug}` }));
        log(`queued as ${id}: ${views.length} views, ${made} triangles${ultrashape ? ', refined with UltraShape' : ''}\n`);
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
      ...(cleanup ? [{ label: 'Clean up into quads (Blender, AutoRemesher)', command: [blender, ...headless, pipeline.cleanup, '--', raw, clean, '--quads', String(quads), '--autoremesher', remesher, '--image-format', 'AUTO', '--name', slug], cwd: api.storage }] : []),
      { label: 'Finish (Blender)', command: [blender, ...headless, pipeline.finish, '--', cleanup ? clean : raw, out, '--length', String(length), '--name', slug, '--pivot', pivot], cwd: api.storage },
      { label: 'Save', run: async (log) => {
        const lines = run.job.log.split(/\r?\n/).reverse(), line = lines.find((l) => l.startsWith('FINISH ')), tidy = cleanup ? lines.find((l) => l.startsWith('RETOPO ')) : null;
        if (!line || !existsSync(out)) throw new Error('Blender finished without writing the model');
        try { report = JSON.parse(line.slice(7)); } catch { report = {}; }
        report.views = null; try { const now = keptResult(slug, hashesOf(checkedViews(slug, draft))); if (now) report.views = { ...verdict(now), seconds: 0 }; } catch { /* a warning only: never fails the job */ }   // what the views check last said, if the views are as they were then
        if (tidy) { try { const t = JSON.parse(tidy.slice(7)); report.cleanup = { quads: t.after?.quads, faces: t.after?.faces, from: t.before?.faces, baked: t.baked }; } catch { /* the model is there; its numbers are not */ } }
        f.write(model, readFileSync(out));
        f.remove(refs);
        f.write(`${refs}/concept.png`, f.read(`${dir}/concept.png`, null));
        for (const v of draft.views.list) if (f.exists(`${dir}/views/${v}.png`)) f.write(`${refs}/${v}.png`, f.read(`${dir}/views/${v}.png`, null));
        log(`${model}\n`);
      } },
      ...(pipeline.inspect ? [{ label: 'Inspect (Blender)', command: [blender, ...headless, pipeline.inspect, '--', out, looked, '--no-render'], cwd: api.storage }] : []),
    ]);
    const job = await run.done;
    for (const old of [raw, clean, out, looked]) rmSync(old, { force: true, recursive: true });
    const m = job.state !== 'done' ? /== .* stopped at "([^"]+)": ([^\n]*)/.exec(job.log.slice(-4000)) : null;
    if (report && pipeline.inspect) {   // the model is saved by now: what the inspection says is added to the report, and its failure never takes the model away
      report.mesh = null;
      try { const i = JSON.parse(job.log.split(/\r?\n/).reverse().find((l) => l.startsWith('INSPECT ')).slice(8)); report.mesh = { pieces: i.loose_pieces, floating: i.floating_pieces, openEdges: i.open_edges, nonManifoldEdges: i.non_manifold_edges, flippedFaces: i.flipped_faces, zeroAreaFaces: i.zero_area_faces, symmetryP95: i.symmetry_error_p95_pct }; } catch { /* no line, or one that is not JSON */ }
      if (!report.mesh) report.inspectError = m && m[1] === 'Inspect (Blender)' ? m[2] : 'the inspection printed no result';
    } else if (report) report.mesh = null;
    if (job.state !== 'done' && !(report && m && m[1] === 'Inspect (Blender)')) {
      throw new Error(m ? `${m[1]}: ${m[2]}${/^(Finish|Clean up)/.test(m[1]) ? ' (see Jobs for Blender\'s output)' : ''}` : 'The model was not made: see Jobs for what happened');
    }
    return { model, refs, report, seconds: Math.round((Date.now() - started) / 1000) };
  });
}
