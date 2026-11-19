// The sample project's map editor config: what `npm start` opens. It shows each kind of option and hook once;
// README.md, "Running it against your own project", describes them all. Paths are relative to this folder.
//
// Hooks get the editor's helpers in their second argument (ctx.formatPlan ...), so a config imports nothing of the editor.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const rad = (d) => (d * Math.PI) / 180;
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export default {
  title: 'sample map editor',
  maps: 'maps', // <maps>/<name>/layout.json (and plants.json)
  defaultMap: 'plaza',
  kit: 'kit.json', // the kinds of piece and their footprints (the default, written out here to show it)
  // schema: 'schemas/map.schema.json',   // left out: the editor's built-in schema

  // How the palette tags and colours each class of kind (a kind's `cls` in kit.json)
  classes: {
    building: { tag: 'building', colour: '#e9dccb', legend: 'a building', note: 'A building. After moving it: Save, then Report.' },
    prop: { tag: 'prop', colour: '#7fd4c1', legend: 'a prop', note: 'A prop: small, and moved freely.' },
  },
  palette: { groups: [{ title: 'Buildings', match: /^kit:(house|tower|hall)/ }, { title: 'Street things', match: /^kit:/ }] },

  // A series of pieces: "planter" adds a kit:pot with the next free planterN id. planterN ids are otherwise kept.
  presets: [{ id: 'planter', label: 'planter (a pot with a plant)', group: 'Planters', kind: 'kit:pot', idPrefix: 'planter', colour: '#3fae49', note: 'A pot the game grows a plant in.' }],
  reservedIds: /^(wall|planter)\d+$/,

  // Plants placed by hand (plants.json `points`): the kinds the game plants, as [what it builds, a size factor]
  plants: {
    kinds: { shrub: ['shrub', 1], flowers: ['flowers', 1], cactus: ['cactus', 1], big_cactus: ['cactus', 1.6] },
    labels: { shrub: 'shrub', flowers: 'flower bed', cactus: 'cactus', big_cactus: 'big cactus' },
    draw: { shrub: { r: 0.5, fill: '#6f9a5a' }, flowers: { r: 0.6, fill: '#e58af0', ring: '#8a5a3a' }, cactus: { r: 0.35, fill: '#76b493', star: 6 } },
    tall: ['cactus'],
  },

  // A compile: here only a paved apron before every door, drawn as a layer (a real project builds its game's scene).
  compileLayers: [{ id: 'paving', label: 'paving before each door (made by the sample compile)', legend: [['#d9c7ad', 'paving the sample compile lays before doors']] }],
  compile({ plan, kinds }) {
    const shapes = [];
    for (const p of [...plan.pieces, ...(plan.marks || [])]) {
      const door = kinds[p.kind]?.door;
      if (!door || (p.y || 0) > 0.5) continue;
      const t = rad(p.rot || 0), k = p.scale || 1, lz = door[1] * k + 0.6;
      const at = [p.at[0] + door[0] * k * Math.cos(t) + lz * Math.sin(t), p.at[1] - door[0] * k * Math.sin(t) + lz * Math.cos(t)];
      shapes.push({ type: 'rect', at, w: 3, d: 3.5, rot: p.rot || 0, fill: '#d9c7ad99', stroke: '#b9a78d', lw: 1 });
    }
    return { overlays: { paving: { label: 'paving', shapes } } };
  },

  // A check of the project's own (the built-in fit check runs too): every map needs a beacon
  check({ plan }) {
    return [...plan.pieces, ...(plan.marks || [])].some((p) => p.kind === 'mark:beacon') ? [] : [{ kind: 'beacon', text: 'the map has no beacon: the game needs one to find the square', sel: [], at: null }];
  },

  // Is the last Report still the plan on screen?
  status({ plan, name }, ctx) {
    const file = join(ctx.root, 'out', `${name}.summary.json`);
    if (!existsSync(file)) return [{ title: 'The report', state: 'unknown', basis: 'Report has not run yet.' }];
    const was = JSON.parse(readFileSync(file, 'utf8'));
    return [was.stamp === hash(ctx.formatPlan(plan)) ? { title: 'The report', state: 'fresh', basis: `against out/${name}.summary.json` } : { title: 'The report', state: 'stale', changes: [{ id: 'layout.json', what: 'differs from what Report read', sel: [] }], action: 'Report' }];
  },

  // Apply actions: fixed commands with fixed arguments; `{map}` is replaced by the (checked) map's name.
  actions: {
    report: { label: 'Report', title: 'count the saved map\'s pieces into out/<map>.summary.json', steps: [{ label: 'report (tools/report.mjs)', node: ['tools/report.mjs', '{map}'] }], doneText: 'See out/ for the summary.' },
  },
  help: [['buildings, props, marks', 'Save, then Report.'], ['plants (plants.json)', 'Save.']],
  hints: { afterSave: { plan: 'Now Report, to see it counted.', plants: '', both: 'Now Report.' }, person: 'Who they are lives in the game, not the map.' },
};
