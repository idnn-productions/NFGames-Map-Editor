// The watcher a Claude Code session runs with its Monitor tool: each waiting job printed once, new ones as they come.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sampleCopy, REPO } from './helpers.mjs';

describe('review-watch', () => {
  it('prints the jobs waiting, then new ones, each once', async () => {
    const copy = sampleCopy();
    const job = (id, status) => { const d = join(copy.root, '.review', id); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'job.json'), '{}'); if (status) writeFileSync(join(d, 'status.json'), '{"state":"done"}'); };
    job('2026-01-01T000000-a'); job('2026-01-02T000000-b', true);
    const child = spawn(process.execPath, [join(REPO, 'bin', 'review-watch.mjs'), '--project', copy.root]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const until = async (re) => { for (let i = 0; i < 80 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 100)); assert.match(out, re); };
    try {
      await until(/NEW JOB \.review\/2026-01-01T000000-a/);
      job('2026-01-03T000000-c');
      await until(/NEW JOB \.review\/2026-01-03T000000-c/);
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(out.match(/NEW JOB/g).length, 2);
      assert.ok(!out.includes('-b'));
      assert.match(out, /^WATCHING \.review/);
      assert.equal(JSON.parse(readFileSync(join(copy.root, '.review', '.agent.json'), 'utf8')).agent, 'an agent');
    } finally { child.kill(); copy.done(); }
  });
});
