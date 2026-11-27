#!/usr/bin/env node
// match <command> --project <dir> ...   The reference-match loop, for the Claude Code session that handles a review job
// (see skills/model-review/SKILL.md). Every round is scored here, by the editor's scorer in Blender: the session never
// judges its own result.
//
//   match.mjs score  --project <dir> <model path in the models folder> [--json]     measure a model now
//   match.mjs start  --project <dir> <job id>                                       take a loop job: working, round 0 recorded
//   match.mjs round  --project <dir> <job id> [--changed <file>]... [--note <text>] [--seconds <n>] [--cost <usd>]
//                                                                                    score the model as it is, record the round, say go on or stop
//   match.mjs status --project <dir> <job id> --state working|needs-input [--question <text>] [--summary <text>]
//   match.mjs finish --project <dir> <job id> --summary <text> [--state done|failed] [--changed <file>]...
import { loadProject } from '../src/project.mjs';
import { createMatcher } from '../src/match.mjs';
import { finishLoop, recordRound, setStatus, startLoop } from '../src/matchloop.mjs';

const args = process.argv.slice(2), command = args.shift();
const flags = {}, rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2), v = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true; (flags[k] ||= []).push(v); } else rest.push(args[i]);
}
const one = (k) => (flags[k] ? flags[k][flags[k].length - 1] : undefined);
const out = (o) => console.log(JSON.stringify(o, null, 2));
const die = (text, code = 1) => { console.error(`match: ${text}`); process.exit(code); };
if (!['score', 'start', 'round', 'status', 'finish'].includes(command)) die('commands: score, start, round, status, finish (see the top of bin/match.mjs)', 2);
let project; try { project = await loadProject({ root: one('project') || process.cwd(), config: one('config') }); } catch (e) { die(e.message); }
const matcher = createMatcher(project), target = rest[0];
if (!target) die(`${command} needs ${command === 'score' ? 'a model path' : 'a job id'}`, 2);
const progress = ({ done, total, text }) => process.stderr.write(`  ${done}/${total} ${text}\n`);
const summary = (r) => ({ views: Object.fromEntries(Object.entries(r.views).map(([v, s]) => [v, { silhouette: s.silhouette, colour: s.colour, combined: s.combined, background: s.background }])), mean: r.mean, orientation: r.orientation, consistency: r.consistency, warnings: r.warnings });
try {
  if (command === 'score') {
    const { done } = matcher.start(target, { onProgress: progress }), { result, dir } = await done;
    out(one('json') ? result : { ...summary(result), files: dir });
  } else if (command === 'start') out(startLoop(project, target));
  else if (command === 'round') {
    const num = (v) => (v === undefined ? undefined : Number(v));
    const { round, decision, result } = await recordRound(project, target, matcher, { changed: flags.changed || [], note: one('note') || '', seconds: num(one('seconds')), cost: num(one('cost')), onProgress: progress });
    out({ round: round.round, mean: round.mean, means: round.means, scores: round.scores, unchanged: !!round.unchanged, flagged: round.flagged, orientation: round.orientation, decision, overlays: round.overlays, drift: round.drift || [], shape: round.shape, consistency: result.consistency.warnings });
  } else if (command === 'status') out(setStatus(project, target, { state: one('state'), question: one('question') || '', summary: one('summary') }));
  else out(finishLoop(project, target, { state: one('state') || 'done', summary: one('summary') || '', changed: flags.changed || [] }));
} catch (e) { die(e.message); }
