// Apply actions: a project's own steps (compile, bake, export ...), run one job at a time, their output kept for
// the page. Every command and argument comes from the config; a request names only the action (looked up with
// Object.hasOwn) and a map (checked before it gets here), and the map's name is passed as one whole argument where
// a step says `{map}`. Processes are spawned with shell: false, so nothing reaches a shell.
import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

// --dry-run: a heavy step prints what it would run, slowly enough to watch, and touches nothing.
const DRY = 'const what = process.argv[1]; let n = 0; console.log("dry run: would run " + what); const t = setInterval(() => { console.log("dry run: step " + (++n) + " of 5 (nothing is being run)"); if (n === 5) { clearInterval(t); console.log("dry run: done"); } }, 400);';
const MAX_LOG = 1_500_000, KEEP_LOG = 1_000_000;

/** The program and arguments a step runs for map `name`. */
export function commandOf(step, name) {
  const args = step.argv.map((a) => (a === '{map}' ? name : a));
  if (step.node) {
    const [script, ...rest] = args;
    return { file: process.execPath, args: [script.startsWith('-') || isAbsolute(script) ? script : resolve(step.cwd, script), ...rest] };
  }
  const [file, ...rest] = args;
  return { file, args: rest };
}

export function createJobs(project, { dryRun = false } = {}) {
  let job = null, count = 0;
  const current = () => job;
  /** Starts action `id` on map `name` (both checked by the caller). Throws when busy or unknown. */
  function start(id, name, { onDone = () => {} } = {}) {
    if (job && job.state === 'running') throw Object.assign(new Error(`busy: ${job.kind} is running`), { code: 409 });
    if (!Object.hasOwn(project.actions, id)) throw Object.assign(new Error('no such action'), { code: 400 });
    const action = project.actions[id];
    if (action.maps && !action.maps.includes(name)) throw Object.assign(new Error(`${action.label} is only for ${action.maps.join(', ')}`), { code: 400 });
    const ctx = { ...project.ctx, dryRun, map: name };
    const mine = job = { id: ++count, kind: id, label: action.label, map: name, state: 'running', step: 0, steps: action.steps.map((s) => s.label), startedAt: Date.now(), endedAt: null, log: '', dryRun };
    const add = (text) => { mine.log += text; if (mine.log.length > MAX_LOG) mine.log = mine.log.slice(-KEEP_LOG); };
    const finish = (state, text) => { if (mine.state !== 'running') return; mine.state = state; mine.endedAt = Date.now(); add(text); try { action.hooks.afterJob?.(mine, ctx); } catch (e) { add(`\n== afterJob: ${e.message}\n`); } onDone(mine); };
    try { action.hooks.beforeJob?.(mine, ctx); } catch (e) { add(`== beforeJob: ${e.message}\n`); }
    const next = (i) => {
      if (i === action.steps.length) return finish('done', `\n== ${action.label}: done in ${((Date.now() - mine.startedAt) / 1000).toFixed(1)} s\n`);
      mine.step = i;
      const step = action.steps[i], stub = dryRun && step.heavy, { file, args } = commandOf(step, name);
      add(`\n== ${step.label}${stub ? '  [DRY RUN]' : ''}\n`);
      let memo;
      try { memo = stub ? undefined : action.hooks.beforeStep?.(step, ctx); } catch (e) { add(`== beforeStep: ${e.message}\n`); }
      const shown = [file === process.execPath ? 'node' : file, ...args].map((a) => a.replace(project.root, '.')).join(' ');
      const child = spawn(stub ? process.execPath : file, stub ? ['-e', DRY, shown] : args, { cwd: step.cwd, shell: false, windowsHide: true });
      child.stdout.on('data', (d) => add(String(d)));
      child.stderr.on('data', (d) => add(String(d)));
      child.on('error', (e) => finish('failed', `\n== could not start: ${e.message}\n`));
      child.on('close', (code) => {
        if (mine.state !== 'running') return;
        if (code !== 0) return finish('failed', `\n== ${action.label} stopped: that step failed (exit ${code})\n`);
        try { if (!stub) action.hooks.afterStep?.(step, ctx, memo); } catch (e) { add(`== afterStep: ${e.message}\n`); }
        next(i + 1);
      });
    };
    next(0);
    return mine;
  }
  return { current, start };
}
