// Drives the model viewer in headless Chrome: loads an animated multi-material .glb and an .fbx model, verifies
// animation playback controls, stats readout, material slot tinting & isolation, and zero console/page errors.
//
//   node scripts/viewer-check.mjs
//
// Needs playwright-core (npm i --no-save playwright-core) and three.js installed in vendor/.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProject } from '../src/project.mjs';
import { createEditor } from '../src/server.mjs';
import { vendorState } from '../src/vendor.mjs';
import { makeAnimatedGlb, makeFbx, makeGlb } from '../test/helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (text) => { console.error(`viewer check: FAILED: ${text}`); process.exitCode = 1; };

async function playwright() {
  const where = process.env.PLAYWRIGHT_MODULE;
  try {
    if (where) { const file = existsSync(join(where, 'index.mjs')) ? join(where, 'index.mjs') : existsSync(join(where, 'index.js')) ? join(where, 'index.js') : where; return await import(pathToFileURL(file).href); }
    return await import('playwright-core');
  } catch (e) { throw new Error(`playwright-core not found (${e.message}): npm i --no-save playwright-core, or set PLAYWRIGHT_MODULE`); }
}
const CHROMES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

if (!vendorState(REPO).installed) {
  console.error('viewer check: FAILED: three.js is not installed in vendor/ (open the viewer and click Install, or run installThree)');
  process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), 'nfgames-viewer-check-'));
mkdirSync(join(temp, 'models'), { recursive: true });
mkdirSync(join(temp, 'art', 'town'), { recursive: true });
writeFileSync(join(temp, 'models', 'animated.glb'), makeAnimatedGlb());
writeFileSync(join(temp, 'models', 'static.glb'), makeGlb());
writeFileSync(join(temp, 'models', 'mesh.fbx'), makeFbx());
writeFileSync(join(temp, 'art', 'town', 'town.glb'), makeGlb());
writeFileSync(join(temp, 'art', 'town', 'town.json'), '{}');

const port = 18895 + (process.pid % 200);
const server = createEditor(await loadProject({ root: temp, config: { models: 'models' } }), { port, stateDir: `${temp}-state` });
await new Promise((done, no) => { server.once('error', no); server.listen(port, '127.0.0.1', done); });
const url = `http://127.0.0.1:${port}/`;

const { chromium } = await playwright();
const executablePath = CHROMES.find((p) => p && existsSync(p));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });

  await page.goto(new URL('viewer?alone&model=models/animated.glb', url).href);
  await page.waitForFunction(() => window.__viewer && window.__viewer.ready && window.__viewer.modelPath === 'models/animated.glb', null, { timeout: 20000 });
  await page.waitForTimeout(200);

  // 1. Animation controls on animated .glb
  const animVisible = await page.evaluate(() => !document.querySelector('#animBar').hidden);
  const clips = await page.evaluate(() => window.__viewer.clips);
  console.log(`animated.glb: ${clips.length} clips (${clips.map((c) => c.name).join(', ')})`);
  if (!animVisible || clips.length !== 2 || clips[0].name !== 'Hover' || clips[1].name !== 'Pulse') fail(`expected 2 clips in visible animBar, got visible=${animVisible} clips=${JSON.stringify(clips)}`);
  const t0 = await page.evaluate(() => window.__viewer.anim.time);
  await page.waitForTimeout(150);
  const t1 = await page.evaluate(() => window.__viewer.anim.time);
  if (!(t1 > t0)) fail(`animation should advance while playing (${t0} -> ${t1})`);
  await page.click('#animPlay');
  if ((await page.evaluate(() => window.__viewer.anim.playing)) !== false) fail('clicking pause should pause playback');
  await page.evaluate(() => { const s = document.querySelector('#animScrub'); s.value = '0.5'; s.dispatchEvent(new Event('input')); });
  const scrubbed = await page.evaluate(() => window.__viewer.anim.time);
  if (Math.abs(scrubbed - 0.5) > 0.05) fail(`scrubbing to 0.5s should set time near 0.5, got ${scrubbed}`);
  await page.selectOption('#animClip', '1');
  if ((await page.evaluate(() => window.__viewer.anim.clip)) !== 1) fail('switching clip should select clip 1');
  await page.selectOption('#animSpeed', '2');
  if ((await page.evaluate(() => window.__viewer.anim.speed)) !== 2) fail('changing speed should set speed to 2');

  // 2. Stats readout
  await page.click('#statsBtn');
  const stats = await page.evaluate(() => ({ visible: !document.querySelector('#statsPanel').hidden, text: document.querySelector('#statsTable').textContent, data: window.__viewer.stats }));
  console.log(`stats: ${stats.data.format}, ${stats.data.tris} tris, ${stats.data.materials} mats, dims=${stats.data.dims.map((x) => x.toFixed(2)).join('x')}`);
  if (!stats.visible || stats.data.tris !== 2 || stats.data.verts !== 6 || stats.data.materials !== 2 || stats.data.clips !== 2) fail(`unexpected stats: ${JSON.stringify(stats.data)}`);
  if (!/2 × 1 × 1 m/.test(stats.text)) fail(`stats table should show dimensions 2 × 1 × 1 m, got: ${stats.text}`);

  // 3. Material inspector: tinting, isolation, and reset
  await page.click('#matsBtn');
  const mats0 = await page.evaluate(() => ({ visible: !document.querySelector('#matsPanel').hidden, rows: document.querySelectorAll('#matsList .mat-row').length, mats: window.__viewer.materials }));
  if (!mats0.visible || mats0.rows !== 2 || mats0.mats[0].name !== 'HullSteel' || mats0.mats[1].name !== 'TrimBrass') fail(`expected 2 material rows (HullSteel, TrimBrass), got ${JSON.stringify(mats0)}`);
  await page.evaluate(() => { const c = document.querySelector('#matsList .mat-row input[type=color]'); c.value = '#ff0044'; c.dispatchEvent(new Event('input')); });
  const tinted = await page.evaluate(() => window.__viewer.materials[0].tint);
  if (tinted !== '#ff0044') fail(`expected slot 0 tint #ff0044, got ${tinted}`);
  await page.click('#matsList .mat-row .mat-name');
  const soloed = await page.evaluate(() => window.__viewer.materials.map((m) => m.solo));
  if (soloed[0] !== true || soloed[1] !== false) fail(`expected slot 0 soloed, got ${JSON.stringify(soloed)}`);
  await page.click('#matsReset');
  const afterReset = await page.evaluate(() => window.__viewer.materials);
  if (afterReset.some((m) => m.tint || m.solo)) fail(`Reset should clear tint and solo: ${JSON.stringify(afterReset)}`);

  // 4. Static .glb hides animBar
  await page.evaluate(() => window.__viewer.open('models/static.glb'));
  await page.waitForFunction(() => window.__viewer.modelPath === 'models/static.glb', null, { timeout: 10000 });
  if (!(await page.evaluate(() => document.querySelector('#animBar').hidden))) fail('animBar should hide for a static model');

  // 5. .fbx model loads via FBXLoader, shows stats & materials, and reports unsupported match
  await page.evaluate(() => window.__viewer.open('models/mesh.fbx'));
  await page.waitForFunction(() => window.__viewer.modelPath === 'models/mesh.fbx', null, { timeout: 10000 });
  await page.waitForTimeout(150);
  const fbx = await page.evaluate(() => ({ stats: window.__viewer.stats, mats: window.__viewer.materials, matchNote: document.querySelector('#matchNote').textContent }));
  console.log(`mesh.fbx: ${fbx.stats.format}, ${fbx.stats.tris} tris, mats=${fbx.mats.map((m) => m.name).join(', ')}`);
  if (fbx.stats.format !== 'FBX' || fbx.stats.tris !== 1 || !fbx.mats.some((m) => m.name === 'FbxClay')) fail(`FBX failed to load cleanly: ${JSON.stringify(fbx)}`);
  if (!/\.glb/.test(fbx.matchNote)) fail(`FBX match note should say .glb only, got: ${fbx.matchNote}`);

  if (errors.length) fail(`console errors:\n  ${errors.join('\n  ')}`); else console.log('console: no errors or warnings');
  await context.close();
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(temp, { recursive: true, force: true });
  rmSync(`${temp}-state`, { recursive: true, force: true });
}
console.log(process.exitCode ? 'viewer check: FAILED' : 'viewer check: passed');
