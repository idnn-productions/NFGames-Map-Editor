// Service requests from an agent, as files: <reviews>/<job>/requests/<name>.json
//   { token, service: "<plugin>/<service>", action, input }
// answered in <name>.answer.json: { ok: true, result }, { ok: false, error }, or { waiting } while the user decides.
//
// Request files are untrusted input (a cloned repository could carry some), so a request is only run when:
//   - it carries this editor session's token (written at start to <reviews>/.session.json, owner-only; a repository
//     cannot know it), and an agent is connected (the watcher's heartbeat);
//   - it was written after the editor started;
//   - it and its answer are plain files (no symlinks) inside the reviews folder.
// The first time an agent uses a service in a session the user is asked to allow it; the spend guard applies as well.
// Answers are written to a temporary file and renamed into place. Ids are made here: nothing from the page is a path.
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Writes `text` to `to` without following links: a new file under a random name (exclusive: it fails if anything is
 *  there), then renamed over `to`, which replaces the name, never what a link there pointed to. */
export function writeSafely(to, text, mode = 0o644) {
  const tmp = `${to}.${randomBytes(8).toString('hex')}.tmp`;
  try { writeFileSync(tmp, text, { flag: 'wx', mode }); renameSync(tmp, to); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}
const plainFile = (f) => { try { const s = lstatSync(f); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };

export function createRequestLoop({ reviewsDir, services, events, agentConnected = () => true, interval = 2000, now = () => Date.now() }) {
  const startedAt = now(), seen = new Set(), waiting = new Map(), allowed = new Set();
  const token = randomBytes(24).toString('hex');
  try { mkdirSync(reviewsDir, { recursive: true }); writeSafely(join(reviewsDir, '.session.json'), `${JSON.stringify({ token, startedAt })}\n`, 0o600); } catch { /* no reviews folder: no requests */ }

  const answerFile = (file) => file.replace(/\.json$/, '.answer.json');
  function write(file, value) {
    const to = answerFile(file);
    if (existsSync(to) && !plainFile(to)) return;                       // never write through a link
    writeSafely(to, `${JSON.stringify(value, null, 2)}\n`);
  }
  const idOf = (file) => relative(reviewsDir, file).split(sep).join('~');
  function ask(file, req, reason, kind) {
    const id = idOf(file), s = req.service;
    waiting.set(id, { file, req, kind, reason });
    write(file, { waiting: `waiting for the user: ${reason}` });
    events.emit('services/confirm', { id, reason, service: s, action: req.action, kind });
  }
  async function run(file, req, confirmed) {
    try {
      if (!allowed.has(req.service)) return ask(file, req, `Your agent wants to use ${req.service} (${req.action}). Allow it for this session?`, 'allow');
      const r = await services.call(req.service, req.action, req.input || {}, { confirmed, by: 'agent' });
      if (r.needsConfirm) return ask(file, req, r.reason, 'spend');
      write(file, { ok: true, result: r.result });
    } catch (e) { write(file, { ok: false, error: e.message }); }
  }
  function scan() {
    if (!existsSync(reviewsDir) || !agentConnected()) return;
    let root; try { root = realpathSync(reviewsDir); } catch { return; }
    for (const job of readdirSync(reviewsDir, { withFileTypes: true })) {
      if (!job.isDirectory() || job.name.startsWith('.') || job.name.endsWith('.tmp')) continue;
      const dir = join(reviewsDir, job.name, 'requests');
      let real; try { real = realpathSync(dir); } catch { continue; }
      if (!real.startsWith(root + sep)) continue;                        // a requests folder that links out is ignored
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json') || name.endsWith('.answer.json')) continue;
        const file = join(dir, name);
        if (seen.has(file) || existsSync(answerFile(file))) continue;
        seen.add(file);
        if (!plainFile(file) || lstatSync(file).mtimeMs < startedAt) continue;   // links, and files from before this session
        let req; try { req = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { write(file, { ok: false, error: `not JSON: ${e.message}` }); continue; }
        if (!req || req.token !== token) { write(file, { ok: false, error: 'no valid session token: read it from <reviews>/.session.json' }); continue; }
        if (typeof req.service !== 'string' || typeof req.action !== 'string') { write(file, { ok: false, error: 'a request is { token, service: "<plugin>/<service>", action, input }' }); continue; }
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
    if (w.kind === 'allow') { allowed.add(w.req.service); return run(w.file, w.req, false); }
    return run(w.file, w.req, true);
  }
  const timer = setInterval(scan, interval); timer.unref?.();
  return { scan, answer, token, pending: () => [...waiting].map(([id, w]) => ({ id, reason: w.reason, service: w.req.service, action: w.req.action, kind: w.kind })), stop: () => clearInterval(timer) };
}
