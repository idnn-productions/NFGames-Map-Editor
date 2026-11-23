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
import { chmodSync, existsSync, readFileSync, readdirSync, cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProject } from '../src/project.mjs';
import { createEditor } from '../src/server.mjs';
import { fakeCommand } from '../test/helpers.mjs';

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
  // its own state folder: the check must not read, or depend on, the settings of whoever runs it
  server = createEditor(await loadProject({ root }), { port, defaultMap: 'plaza', stateDir: `${temp}-state` });
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
  await page.goto(new URL('map?alone', url).href);
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

    // moving in 3D: the Y arrow lifts, the X arrow moves along x only, nothing goes below the ground
    const crate = () => page.evaluate(() => { const p = window.__map.plan.pieces.find((q) => q.id === 'crate'); return { at: [...p.at], y: p.y, hasY: 'y' in p }; });
    const dragFrom = async (from, dx, dy, steps = 8) => { await page.mouse.move(from[0], from[1]); await page.mouse.down(); for (let i = 1; i <= steps; i++) await page.mouse.move(from[0] + (dx * i) / steps, from[1] + (dy * i) / steps); await page.mouse.up(); };
    await page.evaluate(() => window.__map.select(['piece:crate'])); await page.waitForTimeout(100);
    let g = await page.evaluate(() => window.__map.gizmo());
    const c0 = await crate();
    if (!g || !g.y) fail('a selected piece should have a Y arrow in 3D');
    else {
      await dragFrom(g.y, 0, -60);
      const c1 = await crate();
      console.log(`3D: the Y arrow lifted the crate to y ${c1.y}`);
      if (!(c1.y > 0) || Math.abs(c1.y / 0.25 - Math.round(c1.y / 0.25)) > 1e-9 || c1.at.join() !== c0.at.join()) fail(`the Y arrow should lift the crate on the snap grid and not move it sideways: ${JSON.stringify(c1)}`);
      await page.keyboard.press('Control+z');
      if ((await crate()).hasY) fail('undo should put the crate back on the ground (no y)');
      g = await page.evaluate(() => window.__map.gizmo());
      const ux = [g.x[0] - g.at[0], g.x[1] - g.at[1]], n = Math.hypot(...ux);
      await dragFrom(g.x, (ux[0] / n) * 50, (ux[1] / n) * 50);
      const c2 = await crate();
      console.log(`3D: the X arrow moved the crate to ${c2.at}`);
      if (!(c2.at[0] > c0.at[0]) || c2.at[1] !== c0.at[1] || c2.hasY) fail(`the X arrow should move the crate east only: ${JSON.stringify(c2)}`);
      g = await page.evaluate(() => window.__map.gizmo());
      await dragFrom(g.y, 0, 400);
      const c3 = await crate();
      if (c3.hasY) fail(`the Y arrow dragged down should stop on the ground (no y), the crate has y ${c3.y}`);
      await page.keyboard.press('Control+z');
      // Page Down lowers the tank one snap step at a time
      await page.evaluate(() => window.__map.select(['piece:tank']));
      await page.keyboard.press('PageDown'); await page.keyboard.press('PageDown');
      const ty = await page.evaluate(() => window.__map.plan.pieces.find((q) => q.id === 'tank').y);
      if (ty !== 3) fail(`Page Down twice should take the tank from 3.5 to 3, it is at ${ty}`);
      await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
      // switching views in the middle of a drag leaves the plan as it was, with nothing to undo
      await page.evaluate(() => window.__map.select(['piece:crate'])); await page.waitForTimeout(100);
      g = await page.evaluate(() => window.__map.gizmo());
      const planBefore = await page.evaluate(() => JSON.stringify(window.__map.plan)), undosBefore = await page.evaluate(() => window.__map.undos);
      await page.mouse.move(g.y[0], g.y[1]); await page.mouse.down();
      for (let i = 1; i <= 5; i++) await page.mouse.move(g.y[0], g.y[1] - i * 10);
      await page.evaluate(() => window.__map.setMode('top'));
      await page.mouse.up();
      if ((await page.evaluate(() => JSON.stringify(window.__map.plan))) !== planBefore || (await page.evaluate(() => window.__map.undos)) !== undosBefore) fail('a drag cut short by switching views should leave the plan and the undo stack as they were');
      await page.evaluate(() => window.__map.setMode('3d'));
      // what has no height gets no Y arrow, and nothing becomes NaN
      await page.evaluate(() => window.__map.select(['spawn'])); await page.waitForTimeout(100);
      g = await page.evaluate(() => window.__map.gizmo());
      if (!g || g.y !== null || !g.x) fail(`where the player arrives should have X and Z arrows and no Y arrow: ${JSON.stringify(g)}`);
      await page.evaluate(() => window.__map.select(['piece:beacon'])); await page.waitForTimeout(100);
      if (!(await page.evaluate(() => window.__map.gizmo()))) fail('the beacon mark should have handles');
      if (/NaN|null/.test(await page.evaluate(() => JSON.stringify(window.__map.plan.pieces)))) fail('a NaN or null got into the plan');
      await page.evaluate(() => window.__map.select([]));

      // placing in 3D: a crate clicked onto h2's roof lands on it (and the fit check agrees); on open ground it has no y
      const count = () => page.evaluate(() => window.__map.plan.pieces.length);
      const n0 = await count();
      await page.click('#palette button[data-kind="kit:crate"]');
      const roof = await page.evaluate(() => window.__map.toScreen3([4, 3.5, 12]));
      await page.mouse.click(roof[0], roof[1]);
      const onRoof = await page.evaluate(() => window.__map.plan.pieces.at(-1));
      console.log(`3D: placed ${onRoof.id} at ${onRoof.at}, y ${onRoof.y}`);
      if ((await count()) !== n0 + 1 || onRoof.y !== 3.5 || Math.hypot(onRoof.at[0] - 4, onRoof.at[1] - 12) > 0.25) fail(`a crate clicked onto h2's roof should stand on it at y 3.5: ${JSON.stringify(onRoof)}`);
      const previews = await page.evaluate(() => window.__map.previews);
      await page.waitForFunction((n) => window.__map.previews > n, previews, { timeout: 10000 });
      const floats = await page.evaluate((id) => window.__map.problems.problems.filter((p) => p.kind === 'float' && p.sel.includes(`piece:${id}`)), onRoof.id);
      if (floats.length) fail(`the fit check should accept the crate on the roof: ${floats[0].text}`);
      const ground = await page.evaluate(() => window.__map.toScreen3([15, 0, -3]));
      await page.mouse.click(ground[0], ground[1]);
      const onGround = await page.evaluate(() => window.__map.plan.pieces.at(-1));
      if ((await count()) !== n0 + 2 || 'y' in onGround) fail(`a crate clicked on open ground should have no y: ${JSON.stringify(onGround)}`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
      if ((await count()) !== n0) fail('undo should take both placed crates away');

      // a selection lowered to the ground keeps its heights apart: the lowest stops at 0, the rest stop with it
      const heights = () => page.evaluate(() => { const y = (id) => window.__map.plan.pieces.find((q) => q.id === id).y || 0; return [y('crate'), y('tank')]; });
      await page.evaluate(() => { window.__map.plan.pieces.find((q) => q.id === 'crate').y = 1; window.__map.select(['piece:crate', 'piece:tank']); });
      await page.keyboard.press('Shift+PageDown'); await page.keyboard.press('Shift+PageDown');
      let hs = await heights();
      if (hs[0] !== 0 || hs[1] !== 2.5) fail(`Shift Page Down twice should leave crate 0 and tank 2.5 (2.5 apart), they are at ${hs}`);
      await page.keyboard.press('Control+z');
      await page.evaluate(() => window.__map.select(['piece:crate', 'piece:tank'])); await page.waitForTimeout(100);
      g = await page.evaluate(() => window.__map.gizmo());
      await dragFrom(g.y, 0, 400);
      hs = await heights();
      if (hs[0] !== 0 || hs[1] !== 2.5) fail(`the Y arrow dragged down should leave crate 0 and tank 2.5, they are at ${hs}`);
      await page.keyboard.press('Control+z');
      await page.evaluate(() => { const p = window.__map.plan.pieces.find((q) => q.id === 'crate'); delete p.y; window.__map.select([]); });

      // a key pressed in the middle of a drag edits nothing and leaves one undo step
      await page.evaluate(() => window.__map.select(['piece:crate'])); await page.waitForTimeout(100);
      g = await page.evaluate(() => window.__map.gizmo());
      let undos0 = await page.evaluate(() => window.__map.undos);
      const planAt0 = await page.evaluate(() => JSON.stringify(window.__map.plan));
      await page.mouse.move(g.y[0], g.y[1]); await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(g.y[0], g.y[1] - i * 10);
      await page.keyboard.press('r'); await page.keyboard.press('PageUp'); await page.keyboard.press('Delete');
      await page.mouse.move(g.y[0], g.y[1] - 70); await page.mouse.up();
      if ((await page.evaluate(() => window.__map.undos)) !== undos0 + 1) fail('a drag with keys pressed during it should leave exactly one undo step');
      if (!(await page.evaluate(() => window.__map.plan.pieces.some((q) => q.id === 'crate')))) fail('Delete during a drag should not remove what is dragged');
      await page.keyboard.press('Control+z');
      if ((await page.evaluate(() => JSON.stringify(window.__map.plan))) !== planAt0) fail('one undo after a drag should give the plan as it was before it');

      // orbiting keeps the selection; a click on empty ground clears it
      const yaw0 = await page.evaluate(() => window.__map.cam.yaw), empty = await page.evaluate(() => window.__map.toScreen3([15, 0, -3]));
      await dragFrom(empty, 90, 0);
      if ((await page.evaluate(() => window.__map.cam.yaw)) === yaw0) fail('a drag on empty ground should orbit');
      if ((await page.evaluate(() => window.__map.sel.join())) !== 'piece:crate') fail('orbiting should keep the selection');
      const empty2 = await page.evaluate(() => window.__map.toScreen3([15, 0, -3]));
      await page.mouse.click(empty2[0], empty2[1]);
      if ((await page.evaluate(() => window.__map.sel.length)) !== 0) fail('a click on empty ground should clear the selection');

      // with the camera low, a point near the horizon is far off the map: nothing is placed, slid or zoomed out there
      await page.evaluate(() => { const c = window.__map.cam; c.pitch = 8; c.dist = 40; c.target = [0, 0, 0]; window.__map.select([]); });
      const farPx = await page.evaluate(() => { const c = window.__map.cam, y = (c.yaw * Math.PI) / 180; return window.__map.toScreen3([Math.sin(y) * 3000, 0, -Math.cos(y) * 3000]); });
      const inMap = (p) => Math.hypot(p[0], p[1]) < 60;
      const n1 = await count();
      await page.click('#palette button[data-kind="kit:crate"]');
      await page.mouse.click(farPx[0], farPx[1]);
      await page.keyboard.press('Escape');
      if ((await count()) !== n1) { fail(`a click near the horizon should place nothing: ${JSON.stringify(await page.evaluate(() => window.__map.plan.pieces.at(-1)))}`); await page.keyboard.press('Control+z'); }
      await page.mouse.move(farPx[0], farPx[1]); await page.mouse.wheel(0, -100); await page.waitForTimeout(100);
      const tgt = await page.evaluate(() => window.__map.cam.target);
      if (!inMap([tgt[0], tgt[2]])) fail(`zooming at the horizon should not fling the camera off the map: target ${tgt}`);
      await page.evaluate(() => { const c = window.__map.cam; c.target = [0, 0, 0]; c.dist = 40; window.__map.select([]); }); // nothing selected: no handles over the box, so the press grabs the box
      const c2px = await page.evaluate(() => window.__map.toScreen3([3.25, 0.5, 2.5]));
      await dragFrom(c2px, farPx[0] - c2px[0], farPx[1] - c2px[1], 12);
      const slid = await page.evaluate(() => ({ far: window.__map.plan.pieces.filter((q) => Math.hypot(q.at[0], q.at[1]) >= 60).map((q) => `${q.id} at ${q.at}`) })); // whichever box was under the mouse
      if (slid.far.length) fail(`sliding a piece toward the horizon should not fling it off the map: ${slid.far.join(', ')}`);
      await page.keyboard.press('Control+z');

      // markers behind the camera are not drawn (they used to land in the canvas's top left corner)
      await page.evaluate(() => { const c = window.__map.cam, y = (c.yaw * Math.PI) / 180, s = window.__map.plan.spawn.at; c.pitch = 5; c.dist = 3; c.target = [s[0] + Math.sin(y) * 10, 0, s[1] - Math.cos(y) * 10]; window.__map.select([]); });
      const corner = await page.evaluate(() => { const m = document.querySelector('#map'), d = m.width / m.getBoundingClientRect().width; return Array.from(m.getContext('2d').getImageData(0, 0, Math.round(14 * d), Math.round(14 * d)).data).filter((v, i) => i % 4 === 3 && v > 0).length; });
      if (corner) fail(`nothing should be drawn in the top left corner when the markers are behind the camera (${corner} pixels are)`);
      await page.evaluate(() => window.__map.setMode('3d')); await page.keyboard.press('f');

      // a lost WebGL context: back to the top view, the 3D button disabled and saying why
      const seen = errors.length;
      await page.evaluate(() => document.querySelector('#gl').getContext('webgl').getExtension('WEBGL_lose_context').loseContext());
      await page.waitForTimeout(300);
      const lost = await page.evaluate(() => ({ mode: window.__map.mode, disabled: document.querySelector('#view3d').disabled, title: document.querySelector('#view3d').title, status: document.querySelector('#status').textContent }));
      console.log(`3D: after a lost context: ${JSON.stringify(lost)}`);
      if (lost.mode !== 'top' || !lost.disabled || !/lost/.test(lost.title)) fail('a lost WebGL context should put the page in the top view and disable the 3D button, saying the view was lost');
      errors.splice(seen, errors.length - seen, ...errors.slice(seen).filter((m) => !/CONTEXT_LOST_WEBGL/.test(m))); // the browser's own note about the context we lost on purpose
    }
  }
  await page.evaluate(() => window.__map.setMode('top'));

  // foreign Host and Origin
  const host = await statusOf(port, { Host: 'evil.example' });
  const origin = await statusOf(port, { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, 'POST', '/api/save');
  console.log(`foreign Host: ${host}; foreign Origin on a write: ${origin}`);
  if (host !== 403 || origin !== 403) fail('a foreign Host and a foreign Origin must get 403');

  // through the workbench: Save sits in a bar over the map, Selected in the Inspector, and a problem is listed once,
  // in the bottom panel, where a click selects it on the map
  {
    const wb = await context.newPage();
    wb.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`workbench: ${m.text()}`); });
    wb.on('pageerror', (e) => errors.push(`workbench: ${e}`));
    await wb.goto(new URL('?view=map', url).href);
    await wb.waitForFunction(() => { try { return document.querySelector('iframe').contentWindow.__map.ready; } catch { return false; } }, null, { timeout: 15000 });
    const inFrame = (fn, arg) => wb.evaluate(([f, a]) => new Function('w', 'a', `return (${f})(w, a)`)(document.querySelector('iframe').contentWindow, a), [fn.toString(), arg]);
    const lentIn = (region, sel) => wb.evaluate(([r, q]) => { const host = document.querySelector(`#${r} .lent`); return !!(host && host.shadowRoot && host.shadowRoot.querySelector(q)); }, [region, sel]);
    if (!(await inFrame((w) => !!w.document.querySelector('#toolbar #save') && !!w.document.querySelector('#toolbar #viewBar')))) fail('in the workbench, Save and Top/3D should be in the bar over the map');
    if (!(await lentIn('inspectorBody', '#sel')) || !(await lentIn('sideBody', '#palette'))) fail('in the workbench, Selected should be in the Inspector and the palette in the side panel');
    if ((await wb.locator('#inspectorTitle').textContent()) !== 'Map') fail('with nothing selected the Inspector should be titled Map');
    const text = await wb.evaluate(() => document.querySelector('#inspectorBody .lent').shadowRoot.querySelector('#sel').textContent);
    if (/null/.test(text)) fail(`the Inspector should not print "null": ${text}`);
    const mapW = await inFrame((w) => w.document.querySelector('#map').getBoundingClientRect().width), winW = await wb.evaluate(() => innerWidth);
    console.log(`workbench: the map is ${Math.round(mapW)} px of ${winW}`);
    if (mapW < winW * 0.5) fail(`in the workbench the map should have at least half the window (${Math.round(mapW)} of ${winW} px)`);
    // a piece moved far outside the map is a problem
    await inFrame((w) => w.__map.select(['piece:crate']));
    if ((await wb.locator('#inspectorTitle').textContent()) !== 'Selected') fail('with a piece selected the Inspector should be titled Selected');
    const before = await inFrame((w) => w.__map.previews);
    await wb.evaluate(() => { const i = document.querySelector('#inspectorBody .lent').shadowRoot.querySelector('#sel input[type=number]'); i.value = '500'; i.dispatchEvent(new Event('change')); });
    await wb.waitForFunction((n) => document.querySelector('iframe').contentWindow.__map.previews > n, before, { timeout: 10000 });
    const want = await inFrame((w) => w.__map.problems.errors.length + w.__map.problems.problems.length);
    await wb.locator('#bottomTabs .nf-tab', { hasText: 'Problems' }).click();
    const rows = await wb.locator('#bottomBody .nf-problems li').count();
    console.log(`workbench: ${want} problems on the map, ${rows} in the Problems tab`);
    if (!want || rows !== want) fail('the Problems tab should list the map\'s problems');
    if (await inFrame((w) => w.document.querySelector('#problems').children.length)) fail('in the workbench the map should not list its problems a second time');
    // keys pressed while the Inspector has the focus still reach the map: undo takes the move back, and the page's own save runs
    const moved = await inFrame((w) => w.__map.plan.pieces.find((q) => q.id === 'crate').at[0]);
    await wb.evaluate(() => document.querySelector('#inspectorBody .lent').shadowRoot.querySelector('#sel button').focus());
    await wb.keyboard.press('Control+z');
    const undone = await inFrame((w) => w.__map.plan.pieces.find((q) => q.id === 'crate').at[0]);
    if (moved !== 500 || undone === 500) fail(`Ctrl+Z with the focus in the Inspector should undo on the map (x was ${moved}, is ${undone})`);
    await wb.keyboard.press('Control+y');
    if ((await inFrame((w) => w.__map.plan.pieces.find((q) => q.id === 'crate').at[0])) !== 500) fail('Ctrl+Y with the focus in the Inspector should redo on the map');
    await wb.evaluate(() => { const i = document.querySelector('#inspectorBody .lent').shadowRoot.querySelector('#sel input[type=number]'); i.focus(); });
    await wb.keyboard.press('Delete');   // typing in a field is typing: the piece stays
    if (!(await inFrame((w) => w.__map.plan.pieces.some((q) => q.id === 'crate')))) fail('Delete typed in an Inspector field should not remove the piece');
    await inFrame((w) => w.__map.select([]));
    await wb.locator('#bottomBody .nf-problems li').first().click();
    if ((await inFrame((w) => w.__map.sel.join())) !== 'piece:crate') fail('a click on a problem should select it on the map');
    await wb.close({ runBeforeUnload: false });
  }

  // New model, with a stand-in for the codex CLI (our own server only): describe it, generate, pick a concept, make
  // and pick the views, approve; the draft's folder then holds concept.png and the four views, and reopens on step 3
  if (server) {
    const bin = mkdtempSync(join(tmpdir(), 'nfgames-check-bin-'));
    const restorePath = fakeCommand(bin, 'codex', `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
const prompt = a.find((x, i) => i > 0 && /^Use your image generation tool/.test(x));
const m = /into \\.\\/(\\S+)\\/ named/.exec(prompt), n = Number(/make (\\d+) image/.exec(prompt)[1]);
const dir = path.join(a[a.indexOf('-C') + 1], m[1]); fs.mkdirSync(dir, { recursive: true });
for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(dir, 'image-' + i + '.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
`);
    const wb = await context.newPage();
    wb.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`new model: ${m.text()}`); });
    wb.on('pageerror', (e) => errors.push(`new model: ${e}`));
    try {
      await wb.goto(new URL('?view=viewer', url).href);
      const side = (q) => wb.locator('#sideBody .lent').locator(q);
      await wb.waitForFunction(() => { const b = document.querySelector('#sideBody .lent')?.shadowRoot?.querySelector('#newModel'); return b && !b.hidden; }, null, { timeout: 15000 });
      await side('#newModel').click();
      await wb.locator('.mm [data-key="name"]').fill('Check lantern');
      await wb.locator('.mm [data-key="description"]').fill('a small brass street lantern');
      await wb.locator('.mm [data-key="count"]').fill('2');
      await wb.locator('.mm-btn.primary', { hasText: 'Generate' }).click();
      await wb.waitForSelector('.mm-grid .mm-pic', { timeout: 20000 });
      if ((await wb.locator('.mm-grid .mm-pic').count()) !== 2) fail('New model: two concept candidates were asked for');
      // an image opens large, steps to its neighbour, closes with Esc; picking is its own control
      await wb.locator('.mm-grid .mm-pic .mm-open').first().click();
      await wb.waitForSelector('.mm-large');
      const shown = await wb.locator('.mm-large-img').getAttribute('src');
      await wb.locator('.mm-large-next').click();
      if ((await wb.locator('.mm-large-img').getAttribute('src')) === shown) fail('New model: → in the large view shows the next image');
      await wb.keyboard.press('Escape');
      if (await wb.locator('.mm-large').count()) fail('New model: Esc closes the large view');
      if (await wb.locator('.mm-pic.on').count()) fail('New model: looking at an image does not pick it');
      // notes on an image send it back: a new round, revised from it
      await wb.locator('.mm-grid .mm-pic .mm-open').first().click();
      if (!(await wb.locator('.mm-notes-send').isDisabled())) fail('New model: nothing to send back before a note is written');
      await wb.locator('.mm-notes-add').click();
      await wb.locator('.mm-large-img').click({ position: { x: 20, y: 20 } });
      await wb.locator('.mm-notes-pin textarea').fill('no antenna');
      if ((await wb.locator('.mm-large-stage .mm-pin').count()) !== 1) fail('New model: a click on the image in notes mode drops a pin');
      await wb.locator('.mm-notes-send').click();
      await wb.waitForFunction(() => !document.querySelector('.mm-large') && document.querySelector('.mm-from') && !document.querySelector('.mm-wait'), null, { timeout: 20000 });
      if (!/no antenna/.test(await wb.locator('.mm-from').first().textContent())) fail('New model: a revised round shows the notes it was made from');
      await wb.locator('.mm-grid .mm-pic .mm-open').first().click();
      await wb.locator('.mm-large-pick').click();
      await wb.waitForSelector('.mm-pic.on');
      if (await wb.locator('.mm-large').count()) fail('New model: picking in the large view closes it');
      await wb.locator('.mm-btn', { hasText: 'Use this one' }).click();
      await wb.waitForSelector('.mm-views');
      await wb.locator('.mm-btn.primary', { hasText: 'Generate views' }).click();
      await wb.waitForFunction(() => document.querySelectorAll('.mm-view .mm-grid').length === 4 && !document.querySelector('.mm-wait'), null, { timeout: 40000 });
      if (!(await wb.locator('.mm-btn', { hasText: 'Approve views' }).isDisabled())) fail('New model: the views cannot be approved before each has a pick');
      for (let i = 0; i < 4; i++) { await wb.locator('.mm-view').nth(i).locator('.mm-pick').first().click(); await wb.waitForFunction((n) => document.querySelectorAll('.mm-view .mm-pic.on').length === n, i + 1); }
      await wb.locator('.mm-btn', { hasText: 'Approve views' }).click();
      // step 3 says what it needs: here no workflows folder is set, so it names that and Generate model stays off
      await wb.waitForSelector('.mm-needs .mm-need.bad', { timeout: 20000 });
      if (!/workflows folder/i.test(await wb.locator('.mm-needs').textContent())) fail('New model: step 3 names the workflows folder as missing');
      await wb.locator('.mm [data-key="length"]').fill('0.4');
      if (!(await wb.locator('.mm-go').isDisabled())) fail('New model: Generate model is off until everything it needs is there');
      const kept = join(root, '.nfgames', 'drafts', 'check-lantern');
      const views = existsSync(join(kept, 'views')) ? readdirSync(join(kept, 'views')).sort().join() : '';
      console.log(`new model: concept.png ${existsSync(join(kept, 'concept.png')) ? 'kept' : 'MISSING'}; views: ${views}`);
      if (!existsSync(join(kept, 'concept.png')) || views !== 'back.png,front.png,left.png,right.png') fail('New model: an approved draft keeps concept.png and its four views');
      await wb.reload();
      await wb.locator('#nfnav .view[data-view="viewer"]').click();
      await wb.waitForFunction(() => document.querySelector('#sideBody .lent')?.shadowRoot?.querySelector('#drafts button.model'), null, { timeout: 15000 });
      await side('#drafts button.model').first().click();
      await wb.waitForSelector('.mm-step.on');
      if (!/Model/.test(await wb.locator('.mm-step.on').textContent())) fail('New model: an approved draft reopens on its Model step');
    } catch (e) { fail(`New model: ${e.message}`); }
    await wb.close(); restorePath(); rmSync(bin, { recursive: true, force: true });
  }

  if (errors.length) fail(`console errors:\n  ${errors.join('\n  ')}`); else console.log('console: no errors or warnings');
  await context.close();
} finally {
  await browser.close();
  if (server) await new Promise((done) => server.close(done));
  if (temp) { rmSync(temp, { recursive: true, force: true }); rmSync(`${temp}-state`, { recursive: true, force: true }); }
}
console.log(process.exitCode ? 'browser check: FAILED' : 'browser check: passed');
