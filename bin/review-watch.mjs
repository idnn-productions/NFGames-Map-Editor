#!/usr/bin/env node
// review-watch [--project <dir>] [--config <file>]
//
// Prints "NEW JOB <reviews>/<id>" once for every review job waiting for a Claude Code session (a job folder with a
// job.json and no status.json): first those already there, then each new one as the model viewer writes it. A Claude
// Code session runs this with its Monitor tool, so each line wakes it (see skills/model-review/SKILL.md).
import { mkdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { newJobs } from '../src/reviews.mjs';

const args = process.argv.slice(2), value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
let project;
try { project = await loadProject({ root: value('--project') || process.cwd(), config: value('--config') }); } catch (e) { console.error(`review watch: ${e.message}`); process.exit(1); }
const dir = project.reviewsDir, seen = new Set();
mkdirSync(dir, { recursive: true });
const scan = () => { for (const id of newJobs(dir, seen)) console.log(`NEW JOB ${project.rel(join(dir, id))}`); };
console.log(`WATCHING ${project.rel(dir)}`);
scan();
try { watch(dir, () => scan()); } catch { /* the poll below is enough */ }
setInterval(scan, 2000);
