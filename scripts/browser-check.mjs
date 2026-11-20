// Drives the editor's page in a headless Chrome: it loads without console errors, a piece dragged with the mouse
// and saved with Ctrl+S changes layout.json and leaves layout.prev.json, the Report action runs from its button, and
// a request with a foreign Host or Origin is refused.
//
//   node scripts/browser-check.mjs                          a copy of examples/sample in a temporary folder, its own server
//   node scripts/browser-check.mjs --screenshot docs/editor.png      also pictures of the sample map, before any edit
//                                                           (docs/editor.png from above, docs/editor-3d.png in 3D)
//   node scripts/browser-check.mjs --url http://127.0.0.1:8794/ --project examples/sample
//                                                           a server already running (npm start -- --port 8794) on that project
//
// Needs playwright-core, which is not a dependency: `npm i --no-save playwright-core`, or PLAYWRIGHT_MODULE=<path to its
// folder>. Chrome: CHROME=<path>, else the usual install places, else Playwright's own browser.
import { existsSync, readFileSync, cpSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProject } from '../src/project.mjs';
import { createEditor } from '../src/server.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const shot = value('--screenshot'), external = value('--url');
const fail = (text) => { console.error(`browser check: FAILED: ${text}`); process.exitCode = 1; };

async function playwright() {
  const where = process.env.PLAYWRIGHT_MODULE;
  try {
    if (where) { const file = existsSync(join(where, 'index.mjs')) ? join(where, 'index.mjs') : existsSync(join(where, 'index.js')) ? join(where, 'index.js') : where; return await import(pathToFileURL(file).href); }
    return await import('playwright-core');
  } catch (e) { throw new Error(`playwright-core not found (${e.message}): npm i --no-save playwright-core, or set PLAYWRIGHT_MODULE`); }
}
const CHROMES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const statusOf = (port, headers, method = 'GET', path = '/api/state') => new Promise((done, no) => { const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => { res.resume(); done(res.statusCode); }); r.on('error', no); r.end(method === 'POST' ? '{}' : undefined); });

let root, temp = null, server = null, url;
if (external) { root = resolve(value('--project') || join(REPO, 'examples', 'sample')); url = external; }
else {
  temp = mkdtempSync(join(tmpdir(), 'nfgames-map-editor-check-'));
  cpSync(join(REPO, 'examples', 'sample'), temp, { recursive: true, filter: (src) => !/[\\/]out([\\/]|$)|\.prev\.json$/.test(src) });
  root = temp;
  const port = Number(value('--port') || 18890);
  server = createEditor(await loadProject({ root }), { port, defaultMap: 'plaza' });
  await new Promise((done, no) => { server.once('error', no); server.listen(port, '127.0.0.1', done); });
  url = `http://127.0.0.1:${port}/`;
}
const port = Number(new URL(url).port);
const layout = join(root, 'maps', 'plaza', 'layout.json'), prev = join(root, 'maps', 'plaza', 'layout.prev.json');
const { chromium } = await playwright();
const executablePath = CHROMES.find((p) => p && existsSync(p));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.__map && window.__map.ready, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({ pieces: window.__map.plan.pieces.length, errors: window.__map.problems.errors.length, problems: window.__map.problems.problems.length, palette: document.querySelectorAll('#palette button').length, layers: document.querySelectorAll('#layers input').length, actions: document.querySelectorAll('#actions button').length }));
  console.log(`loaded: ${state.pieces} pieces, ${state.palette} palette buttons, ${state.layers} layers, ${state.actions} actions, ${state.errors} schema errors, ${state.problems} warnings`);
  if (state.errors || state.problems) fail('the sample map should load with no errors and no warnings');

  if (shot) {
    await page.evaluate(() => window.__map.select(['piece:tower']));
    await page.waitForTimeout(300);
    mkdirSync(dirname(resolve(shot)), { recursive: true });
    await page.screenshot({ path: resolve(shot) });
    console.log(`screenshot: ${shot}`);
    const shot3d = shot.replace(/\.png$/, '') + '-3d.png'; // the same, in the 3D view
    await page.evaluate(() => window.__map.setMode('3d'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(shot3d) });
    console.log(`screenshot: ${shot3d}`);
    await page.evaluate(() => { window.__map.setMode('top'); window.__map.select([]); });
  }

  // drag the crate two metres east with the mouse, then Ctrl+S
  const before = readFileSync(layout, 'utf8'), from = JSON.parse(before).pieces.find((p) => p.id === 'crate').at;
  const k = await page.evaluate(() => window.__map.view.k);
  const [sx, sy] = await page.evaluate((at) => window.__map.toScreen(at), from);
  await page.mouse.move(sx, sy); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(sx + (2 * k * i) / 8, sy);
  await page.mouse.up();
  const moved = await page.evaluate(() => window.__map.plan.pieces.find((p) => p.id === 'crate').at);
  console.log(`dragged crate from ${from} to ${moved}`);
  if (Math.abs(moved[0] - from[0] - 2) > 0.26 || moved[1] !== from[1]) fail(`the crate should have moved 2 m east, it is at ${moved}`);
  if (!(await page.evaluate(() => window.__map.isDirty()))) fail('the page should say there are unsaved changes');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__map.saves > 0, null, { timeout: 10000 });
  const after = readFileSync(layout, 'utf8');
  const saved = JSON.parse(after).pieces.find((p) => p.id === 'crate').at;
  console.log(`saved: layout.json crate at ${saved}; layout.prev.json ${existsSync(prev) ? 'kept' : 'MISSING'}; status "${await page.textContent('#status')}"`);
  if (after === before || saved[0] !== moved[0]) fail('layout.json did not change as dragged');
  if (!existsSync(prev) || readFileSync(prev, 'utf8') !== before) fail('layout.prev.json should hold the file as it was');

  // the Report action, from its button
  const report = await page.$('#job-report');
  if (report) {
    await report.click();
    await page.waitForFunction(() => window.__map.job && ['done', 'failed'].includes(window.__map.job.state), null, { timeout: 30000 });
    await page.waitForFunction(() => /up to date/.test(document.querySelector('#statusPanels').textContent), null, { timeout: 10000 }).catch(() => {});
    const job = await page.evaluate(() => ({ state: window.__map.job.state, panel: document.querySelector('#statusPanels').textContent }));
    console.log(`Report: ${job.state}; status panel: "${job.panel}"`);
    if (job.state !== 'done' || !/up to date/.test(job.panel)) fail('Report should finish and the status panel say up to date');
  }

  // the 3D view: it draws, its camera's target is the middle of the map, and it survives a resize
  await page.evaluate(() => window.__map.setMode('3d'));
  await page.waitForTimeout(300);
  const centreOf3d = () => page.evaluate(() => { const r = document.querySelector('#map').getBoundingClientRect(), t = window.__map.cam.target; return { mid: [r.left + r.width / 2, r.top + r.height / 2], at: window.__map.toScreen3(t) }; });
  const offCentre = (c) => Math.hypot(c.mid[0] - c.at[0], c.mid[1] - c.at[1]);
  if ((await page.evaluate(() => window.__map.mode)) !== '3d') fail('the page should be in the 3D view');
  else {
    let c = await centreOf3d();
    if (offCentre(c) > 2) fail(`the 3D camera's target should be in the middle of the map, it is ${offCentre(c).toFixed(1)} px off`);
    // a pixel of the WebGL canvas at the top of the tower is not the background
    const px = await page.evaluate(() => {
      const gl = document.querySelector('#gl'), [x, y] = window.__map.toScreen3([6, 12, -10]), r = gl.getBoundingClientRect(), d = gl.width / r.width;
      const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d');
      g.drawImage(gl, (x - r.left) * d, (y - r.top) * d, 1, 1, 0, 0, 1, 1); return Array.from(g.getImageData(0, 0, 1, 1).data);
    });
    const bg = [0x8a, 0x6a, 0x4c];
    console.log(`3D: the tower's top is drawn rgb(${px.slice(0, 3)})`);
    if (Math.hypot(px[0] - bg[0], px[1] - bg[1], px[2] - bg[2]) < 30) fail('the 3D view should draw the tower');
    await page.setViewportSize({ width: 1200, height: 700 }); await page.waitForTimeout(300);
    c = await centreOf3d();
    if (offCentre(c) > 2) fail(`after a resize the 3D camera's target should still be in the middle, it is ${offCentre(c).toFixed(1)} px off`);
    await page.setViewportSize({ width: 1600, height: 900 }); await page.waitForTimeout(300);
  }
  await page.evaluate(() => window.__map.setMode('top'));

  // foreign Host and Origin
  const host = await statusOf(port, { Host: 'evil.example' });
  const origin = await statusOf(port, { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, 'POST', '/api/save');
  console.log(`foreign Host: ${host}; foreign Origin on a write: ${origin}`);
  if (host !== 403 || origin !== 403) fail('a foreign Host and a foreign Origin must get 403');

  if (errors.length) fail(`console errors:\n  ${errors.join('\n  ')}`); else console.log('console: no errors or warnings');
  await context.close();
} finally {
  await browser.close();
  if (server) await new Promise((done) => server.close(done));
  if (temp) rmSync(temp, { recursive: true, force: true });
}
console.log(process.exitCode ? 'browser check: FAILED' : 'browser check: passed');
