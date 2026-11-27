// The match loop's side of a review job: the editor's own scorer measures every round, and writes the rounds into the job's
// status.json. The session that handles the job never judges its own result: it runs `bin/match.mjs round`, which scores the
// model as it is now, records the round and says whether to go on (match.mjs `decide`).
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWS, decide, drift } from './match.mjs';

const bad = (text, code = 400) => { throw Object.assign(new Error(text), { code }); };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
export const STOP_REASONS = ['target-reached', 'out-of-rounds', 'plateau', 'held-back'];

/** The folder of job `id` (a plain name of the reviews folder, with a job.json), its job and its status. */
export function openJob(project, id) {
  if (typeof id !== 'string' || !ID.test(id) || id.includes('..')) bad('not a job id');
  const dir = join(project.reviewsDir, id);
  if (!existsSync(join(dir, 'job.json'))) bad(`no such job: ${id}`, 404);
  const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
  let status = {};
  try { status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')); } catch { /* none yet */ }
  return { dir, job, status };
}
/** status.json is written to a temporary file and renamed, so the page never reads half of it. */
export function writeStatus(dir, status) {
  const file = join(dir, 'status.json'), tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`); renameSync(tmp, file);
}
const now = () => new Date().toISOString();
const requireLoop = (job) => { if (!job.match || !job.match.baseline) bad('this job has no match loop (it was sent without a target)'); return job.match; };

/** A round as status.json keeps it, from a scorer result. `value` is the mean of the job's chosen score. */
export function roundOf(round, result, loop, extra = {}) {
  const scores = {};
  for (const v of VIEWS) if (result.views[v]) scores[v] = { silhouette: result.views[v].silhouette, colour: result.views[v].colour, combined: result.views[v].combined };
  return {
    ...(result.shape ? { shape: result.shape } : {}),
    round, scores, mean: result.mean[loop.score], means: result.mean, orientation: { up: result.orientation.up, turn: result.orientation.turn },
    flagged: (result.consistency && result.consistency.flagged) || [], changed: [], note: '', at: now(), key: result.key, ...extra,
  };
}

/** Takes the job: working, with round 0 (the model as it was sent) in `rounds`. Also what a restart after a crash does: rounds are kept. */
export function startLoop(project, id) {
  const { dir, job, status } = openJob(project, id), loop = requireLoop(job);
  const rounds = Array.isArray(status.rounds) && status.rounds.length ? status.rounds : [{ ...loop.baseline, round: 0, changed: [], note: 'the model as it was sent', at: job.createdAt }];
  const next = { ...status, state: 'working', summary: status.summary || '', updatedAt: now(), changedFiles: status.changedFiles || [], rounds };
  delete next.stopReason; delete next.stopDetail;
  writeStatus(dir, next);
  return { rounds, loop: { target: loop.target, maxRounds: loop.maxRounds, plateau: loop.plateau, score: loop.score } };
}

/**
 * Scores the model as it is now (the editor's scorer, through `matcher`), records it as the next round and decides
 * whether the loop goes on. Resolves { round, decision, result }.
 */
export async function recordRound(project, id, matcher, { changed = [], note = '', seconds, cost, onProgress } = {}) {
  const { dir, job, status } = openJob(project, id), loop = requireLoop(job);
  if (!Array.isArray(status.rounds) || !status.rounds.length) bad('start the loop first: match.mjs start <job>');
  const last = status.rounds[status.rounds.length - 1];
  if (status.stopReason) bad(`the loop already stopped (${status.stopReason}): ${status.stopDetail || ''}`, 409);
  const { done } = matcher.start(job.model.path, { onProgress });
  const { result, dir: resultDir } = await done;
  const n = status.rounds.length, overlays = {};
  for (const v of VIEWS) {
    const src = join(resultDir, `overlay-${v}.png`);
    if (result.views[v] && existsSync(src)) { overlays[v] = `round-${n}-overlay-${v}.png`; copyFileSync(src, join(dir, overlays[v])); }
  }
  const extra = { changed: changed.filter((f) => typeof f === 'string').slice(0, 200), note: String(note).slice(0, 2000), overlays };
  if (Number.isFinite(seconds)) extra.seconds = seconds;
  if (Number.isFinite(cost)) extra.cost = cost;
  const round = roundOf(n, result, loop, extra);
  const off = drift(status.rounds[0].shape, result.shape, matcher.config.limits);
  if (off.length) round.drift = off;
  if (last && last.key === result.key) round.unchanged = true;       // the model file is the one scored last round: nothing was re-exported
  const rounds = [...status.rounds, round];
  const decision = decide(loop, rounds, result.consistency, round.scores);
  const files = [...new Set([...(status.changedFiles || []), ...round.changed])];
  const next = { ...status, state: 'working', updatedAt: now(), changedFiles: files, rounds };
  if (decision.stop) { next.stopReason = decision.reason; next.stopDetail = decision.detail; }
  writeStatus(dir, next);
  return { round, decision, result };
}

/** Ends the job: `done` (or `failed`) with a summary; the rounds and why the loop stopped are kept. */
export function finishLoop(project, id, { state = 'done', summary = '', changed = [] } = {}) {
  const { dir, job, status } = openJob(project, id);
  if (!['done', 'failed'].includes(state)) bad('state: done or failed');
  const rounds = Array.isArray(status.rounds) ? status.rounds : [];
  const next = { ...status, state, summary: String(summary).slice(0, 4000), updatedAt: now(), changedFiles: [...new Set([...(status.changedFiles || []), ...changed])] };
  if (job.match && state === 'done' && !next.stopReason && rounds.length) {
    const last = rounds[rounds.length - 1];
    const off = last.drift && last.drift.length ? last.drift : null;
    next.stopReason = last.mean >= job.match.target - 1e-9 && !off ? 'target-reached' : 'out-of-rounds';
    next.stopDetail = off ? `stopped by the session at the mean ${last.mean.toFixed(2)}. The model drifted from what was sent: ${off.join('; ')}` : next.stopReason === 'target-reached' ? `the mean ${last.mean.toFixed(2)} reached the target ${job.match.target.toFixed(2)}` : `stopped by the session at the mean ${last.mean.toFixed(2)}, below the target ${job.match.target.toFixed(2)}`;
  }
  writeStatus(dir, next);
  return next;
}

/** A state that is not an end: working, or needs-input with the question (the page shows it). Keeps the rounds. */
export function setStatus(project, id, { state, question = '', summary }) {
  const { dir, status } = openJob(project, id);
  if (!['working', 'needs-input'].includes(state)) bad('state: working or needs-input');
  const next = { ...status, state, updatedAt: now(), summary: summary === undefined ? status.summary || '' : String(summary).slice(0, 4000), changedFiles: status.changedFiles || [] };
  if (state === 'needs-input') next.question = String(question).slice(0, 2000); else delete next.question;
  writeStatus(dir, next);
  return next;
}
