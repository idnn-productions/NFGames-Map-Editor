// Service requests from an agent, as files: <reviews>/<job>/requests/<name>.json { service, action, input }. The
// editor runs each once and answers in <name>.answer.json: { ok: true, result }, { ok: false, error }, or { waiting }
// while the user decides on one that costs (the page shows it; POST /api/services/requests/answer). The agent waits
// for an answer with ok set. Ids are made here: nothing from the page becomes a path.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export function createRequestLoop({ reviewsDir, services, events, interval = 2000 }) {
  const seen = new Set(), waiting = new Map();
  const answerFile = (file) => file.replace(/\.json$/, '.answer.json');
  const write = (file, value) => writeFileSync(answerFile(file), `${JSON.stringify(value, null, 2)}\n`);
  async function run(file, req, confirmed) {
    try {
      const r = await services.call(req.service, req.action, req.input || {}, { confirmed, by: 'agent' });
      if (r.needsConfirm) {
        const id = relative(reviewsDir, file).split(/[\\/]/).join('~');
        waiting.set(id, { file, req, reason: r.reason, estimate: r.estimate, service: r.service, action: r.action });
        write(file, { waiting: `waiting for the user: ${r.reason}` });
        events.emit('services/confirm', { id, reason: r.reason, estimate: r.estimate, service: r.service, action: r.action });
        return;
      }
      write(file, { ok: true, result: r.result });
    } catch (e) { write(file, { ok: false, error: e.message }); }
  }
  function scan() {
    if (!existsSync(reviewsDir)) return;
    for (const job of readdirSync(reviewsDir, { withFileTypes: true })) {
      if (!job.isDirectory() || job.name.startsWith('.') || job.name.endsWith('.tmp')) continue;
      const dir = join(reviewsDir, job.name, 'requests');
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json') || name.endsWith('.answer.json')) continue;
        const file = join(dir, name);
        if (seen.has(file) || existsSync(answerFile(file))) continue;
        seen.add(file);
        let req; try { req = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { write(file, { ok: false, error: `not JSON: ${e.message}` }); continue; }
        if (!req || typeof req.service !== 'string' || typeof req.action !== 'string') { write(file, { ok: false, error: 'a request is { service: "<plugin>/<service>", action, input }' }); continue; }
        run(file, req, false);
      }
    }
  }
  async function answer(id, approve) {
    const w = waiting.get(id);
    if (!w) throw Object.assign(new Error('no such request waiting'), { code: 404 });
    waiting.delete(id);
    if (!approve) { write(w.file, { ok: false, error: 'the user said no' }); return; }
    write(w.file, { waiting: 'running' });
    await run(w.file, w.req, true);
  }
  const timer = setInterval(scan, interval); timer.unref?.();
  return { scan, answer, pending: () => [...waiting].map(([id, w]) => ({ id, reason: w.reason, estimate: w.estimate, service: w.service, action: w.action })), stop: () => clearInterval(timer) };
}
