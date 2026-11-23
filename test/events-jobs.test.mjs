// The live event stream (Server-Sent Events) and jobs made of plugin steps.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEvents } from '../src/events.mjs';
import { createJobs } from '../src/jobs.mjs';

describe('events', () => {
  it('streams events, and replays the ones after Last-Event-ID', async () => {
    const events = createEvents(), server = createServer((req, res) => events.handle(req, res));
    await new Promise((d) => server.listen(0, '127.0.0.1', d));
    events.emit('jobs/done', { id: 1 });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { 'Last-Event-ID': '0' } });
    const reader = res.body.getReader(); let text = '';
    events.emit('plugins/changed', { id: 'a.b' });
    while (!/plugins\/changed/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /id: 1\nevent: jobs\/done\ndata: \{"id":1\}/); assert.match(text, /event: plugins\/changed/);
    await reader.cancel(); events.close(); await new Promise((d) => server.close(d));
  });
});

describe('plugin jobs', () => {
  it('runs function and command steps in order, and stops at a failing one', async () => {
    const jobs = createJobs({ root: process.cwd(), actions: {}, ctx: {} });
    const ok = jobs.runSteps({ kind: 'a.b', label: 'Two steps', steps: [{ label: 'say', run: (log) => log('hello\n') }, { label: 'node', command: [process.execPath, '-e', 'console.log("from node")'] }] });
    assert.equal(ok.job.state, 'running');
    assert.throws(() => jobs.runSteps({ kind: 'x', label: 'busy', steps: [] }), /busy/);
    const done = await ok.done;
    assert.equal(done.state, 'done'); assert.match(done.log, /hello/); assert.match(done.log, /from node/);
    const bad = await jobs.runSteps({ kind: 'a.b', label: 'Bad', steps: [{ label: 'boom', run: () => { throw new Error('nope'); } }, { label: 'never', run: () => {} }] }).done;
    assert.equal(bad.state, 'failed'); assert.match(bad.log, /stopped at "boom": nope/); assert.doesNotMatch(bad.log, /== never/);
  });
});
