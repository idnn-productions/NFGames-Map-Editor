// How Thoon Run's map editor setup maps onto the NFGames Map Editor's config: an example to read, and the starting
// point for the real thing. Placed at the root of the Thoon Run workspace as map-editor.config.mjs (or passed with
// --config), it gives the editor everything Thoon Run's own tools/maps/editor.mjs did:
//
//   npx nfgames-map-editor khairos --project <the workspace> [--config <this file>] [--port 8794] [--dry-run]
//
// It reads, never copies, the game's own modules under web/thoon-run/tools/ (maps/ and look/), so the rules stay
// where they live: the kit's footprints and the hero pieces' sizes (maps/lib.mjs `sources`, which reads the Godot
// project's kit.json and heroes.md; KHAIROS_SOURCE points elsewhere), the kit rules (maps/kit-rules.mjs), the compile
// to the game's scene and walk grid (maps/compile.mjs), the fit check on that walk grid (maps/check.mjs), and the
// look pipeline (look/config.mjs, maps/look-view.mjs: the scaling, bake and planting staleness, rule-made plants).
// Every path below is relative to the project root the editor is given.
//
// Not carried into the editor's core (they are Thoon Run's, so they live here): the look pipeline's Layout, Plants,
// Layout + Plants and Bake buttons, its "stale" panels, the green pots (`planters: "hand"`), the dressing set by rule
// and the last bake's walk grid as layers, the compile's streets, trees, pipes and planters as layers, and writing
// .cache/maps/<name>/ after each save.
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function thoonRun({ root }) {
  const GAME = join(root, 'web', 'thoon-run');
  const game = (file) => import(pathToFileURL(join(GAME, 'tools', file)).href);
  const lib = await game('maps/lib.mjs');
  const rules = await game('maps/kit-rules.mjs');
  const { compile, PLANTER_ID } = await game('maps/compile.mjs');
  const { checkFit, checkPlants } = await game('maps/check.mjs');
  const look = await game('maps/look-view.mjs');
  const { SCALE, WALL, OUT } = await game('look/config.mjs');
  const LOOK_MAP = look.LOOK_MAP; // khairos: the one map the look pipeline draws
  // a step that runs one of the game's scripts with Node, from web/thoon-run (its scripts expect that folder)
  const node = (script, ...args) => ({ node: [`tools/${script}`, ...args], cwd: 'web/thoon-run' });
  // the job hooks keep the records the stale panels compare against (as Thoon Run's editor did)
  const jobHooks = {
    beforeJob() { look.recordBaked(); }, // before Layout rewrites the file the last bake read
    beforeStep(step) { const f = lib.plantsFile(LOOK_MAP); return step.key === 'planting' && existsSync(f) ? readFileSync(f, 'utf8') : undefined; }, // plants.json as this planting reads it
    afterStep(step, ctx, read) { if (read !== undefined) look.recordPlanted(read); },
    afterJob(job, ctx) { if (job.kind === 'bake' && job.state === 'done' && !ctx.dryRun) look.recordBaked(true); },
  };
  const pipeline = (label, steps, extra = {}) => ({ label, maps: [LOOK_MAP], doneText: 'Reload look.html to see it.', steps, ...jobHooks, ...extra });

  // the plan's frame and the game's (the look route draws Khairos SCALE.plan times larger about the ring's centre)
  const centreOf = (plan) => (plan.ring ? plan.ring.centre : [0, 0]);
  const fromGame = (plan, [x, z]) => { const c = centreOf(plan), P = SCALE.plan; return [c[0] + (x - c[0]) / P, c[1] + (z - c[1]) / P]; };
  const r2d = (r) => (r * 180) / Math.PI;

  /** Every kind a plan can place, as Thoon Run's editor listed them (tools/maps/editor.mjs `kinds`). */
  function kinds(name) {
    const src = lib.sources(name), out = {};
    for (const [n, k] of Object.entries(src.kit)) {
      if (/^(door_|window_)/.test(n)) continue; // set into houses by rule (tools/look/layout.mjs), not placed
      const kind = `kit:${n}`;
      out[kind] = { size: k.size, boxes: (k.colliders || []).filter((c) => c[5] < 0.5).map(([x, y, w, d]) => [x, -y, w, d]), cls: look.classOf(kind), hidden: rules.RING_KINDS.includes(kind), door: rules.DOOR_AT[kind] || null };
    }
    for (const [n, size] of Object.entries(src.heroSizes)) {
      const kind = `hero:${n}`;
      out[kind] = { size, boxes: (rules.HERO_BOXES[n] || [[0, 0, size[0], size[1]]]).map((b) => b.slice(0, 4)), cls: look.classOf(kind), door: rules.DOOR_AT[kind] || null };
    }
    return out;
  }

  /** The compile's ground plan and what it adds, as layers (the old page's drawStreets and drawMade). */
  function streetShapes(s) {
    const out = [];
    for (const q of s.gravel || []) out.push({ type: 'rect', at: q.at, rot: r2d(q.rot), w: q.w + 2 * q.r, d: q.d + 2 * q.r, fill: '#b3a08a55' });
    for (const q of s.yards || []) out.push({ type: 'rect', at: q.at, rot: r2d(q.rot), w: q.w + 2 * q.r, d: q.d + 2 * q.r, fill: '#b98f6855' });
    for (const q of s.plazas || []) out.push({ type: 'circle', at: q.at, r: q.r, fill: '#d9c7ad88', stroke: '#d9c7ad' });
    for (const l of s.lanes || []) out.push({ type: 'line', pts: l.pts, width: l.w, stroke: '#9d8f85aa', round: true });
    for (const l of s.paths || []) out.push({ type: 'line', pts: l.pts, width: l.w, stroke: '#a8845faa', round: true });
    return out;
  }
  function madeShapes(scene, plan) {
    const out = [];
    for (const t of scene.streets.trees || []) out.push({ type: 'circle', at: t.at, r: 1.3 * t.scale * 0.5, minPx: 3, fill: '#6f9a5a88', stroke: '#3d5c2e' });
    for (const q of scene.streets.pipes || []) out.push({ type: 'line', pts: q.pts.map(([x, , z]) => [x, z]), width: q.r * 2, minPx: 1.5, stroke: '#6f8da0' });
    for (const p of scene.pieces) if (PLANTER_ID.test(p.id) && !plan.pieces.some((q) => q.id === p.id)) out.push({ type: 'circle', at: [p.at[0], p.at[2]], r: 0.45 * p.scale, minPx: 2.5, fill: '#9fc98a', stroke: '#3d5c2e' });
    return out;
  }
  /** What Layout last wrote (public/look/khairos/khairos.json): the dressing set by rule (the old page's drawRuleMade). */
  function ruleShapes(g, plan, info) {
    const out = [], mine = new Set([...plan.pieces, ...(plan.marks || [])].map((p) => p.id)), P = SCALE.plan;
    const RULE_SIZE = { 'look:cargo_stack': [2.4, 2.4], 'look:workshop_gear': [3, 2.2], 'look:wall_buttress': [1.1, 1.3] };
    for (const s of g.statics.filter((q) => !q.opening || /_door\d+$/.test(q.id))) {
      if (mine.has(s.id) || PLANTER_ID.test(s.id) || /_dress$|^hangar_lights$|^cafe_dress$|^wreck_dressing$/.test(s.id) || s.kind === 'look:wall_bay' || s.kind === 'look:gate') continue;
      const at = fromGame(plan, [s.at[0], s.at[2]]), sc = Array.isArray(s.scale) ? s.scale : [s.scale, s.scale, s.scale];
      if (/_door\d+$/.test(s.id)) { out.push({ type: 'dot', at, px: 5, fill: '#7a4a2a' }); continue; }
      const size = RULE_SIZE[s.kind] || (info[s.kind] ? [info[s.kind].size[0] * sc[0], info[s.kind].size[1] * sc[2]] : null);
      if (!size) continue;
      if (s.kind === 'kit:dome_4') out.push({ type: 'circle', at, r: size[0] / 2 / P, fill: '#b9a3ff33', stroke: '#b9a3ff', lw: 1.2, dash: true });
      else out.push({ type: 'rect', at, rot: r2d(s.rot), w: size[0] / P, d: size[1] / P, fill: '#b9a3ff33', stroke: '#b9a3ff', lw: 1.2, dash: true });
    }
    for (const p of g.plants || []) out.push({ type: 'circle', at: fromGame(plan, [p.at[0], p.at[2]]), r: 0.9 / P, minPx: 2.5, fill: '#e0569b99', stroke: '#8a1f55' });
    for (const l of g.lines || []) out.push({ type: 'line', pts: [fromGame(plan, [l.from[0], l.from[2]]), fromGame(plan, [l.to[0], l.to[2]])], px: 1, stroke: l.kind === 'bunting' ? '#ffb347aa' : '#3b3b3b88' });
    return out;
  }
  /** Hand-placed plants the last Plants left out (tools/maps/editor.mjs `unplanted`): ground truth, where the check only predicts. */
  function unplanted(plants, plan) {
    if (!plants || !Array.isArray(plants.points) || !existsSync(look.PLACEMENTS) || !existsSync(look.PLANTED) || !plan.ring) return [];
    let placed, read;
    try { placed = JSON.parse(readFileSync(look.PLACEMENTS, 'utf8')).kinds || {}; read = JSON.parse(readFileSync(look.PLANTED, 'utf8')).points || []; } catch { return []; }
    const C = plan.ring.centre, P = SCALE.plan, out = [];
    plants.points.forEach((pt, i) => {
      const built = lib.PLANT_KINDS[pt.kind];
      if (!built || !read.some((q) => JSON.stringify(q) === JSON.stringify(pt))) return;
      const x = C[0] + (pt.at[0] - C[0]) * P, z = C[1] + (pt.at[1] - C[1]) * P, list = placed[built[0]] || [];
      for (let k = 0; k < list.length; k += 5) if (Math.hypot(list[k] - x, list[k + 2] - z) < 0.01) return;
      out.push({ kind: 'plant', text: `plant ${i} (${pt.kind}) at ${pt.at.join(', ')}: the last Plants left it out (the planting refused the place)`, sel: [`plant:${i}`], at: pt.at });
    });
    return out;
  }
  const writeCompiled = (name, built) => {
    const dir = join(GAME, '.cache', 'maps', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scene.json'), built.text);
    writeFileSync(join(dir, 'walk.bin'), Buffer.from(built.walk.buffer));
    writeFileSync(join(dir, 'town.json'), JSON.stringify({ ...built.town, places: built.places }, null, 1));
  };

  return {
    title: 'Thoon Run map editor',
    maps: 'data/maps',
    defaultMap: LOOK_MAP,
    port: 8793,
    schema: 'data/schemas/map.schema.json', // its $refs to common.schema.json are read from beside it
    kinds: ({ name }) => kinds(name),
    reservedIds: lib.RESERVED,
    // a map with `planters: "hand"` places its own green pots, kit:pot_big with ids planter0, planter1 ...
    presets: [{ id: 'green-pot', label: 'green pot', group: 'Green pots (a plant grows in each)', kind: 'kit:pot_big', scale: 1.15, idPrefix: 'planter', colour: '#3fae49', note: 'A green pot: a plant grows in it. After moving or adding one: Save, then Layout + Plants, then reload look.html.', when: { field: 'planters', equals: 'hand' } }],
    validate({ plan }) {
      return [...plan.pieces, ...(plan.marks || [])].filter((p) => plan.planters === 'hand' && PLANTER_ID.test(p.id) && p.kind !== 'kit:pot_big').map((p) => `pieces: "${p.id}": a planterN id is for a big pot with a plant in it (kind kit:pot_big)`);
    },
    classes: {
      static: { tag: 'bake', colour: '#e9dccb', legend: 'baked into the town (needs Bake)', note: 'Baked into the town: after moving it, Bake (about ten minutes).' },
      prop: { tag: 'prop', colour: '#7fd4c1', legend: 'a prop: an instance (Layout)', note: 'An instanced prop: Layout is enough, then reload look.html.' },
      mark: { tag: 'mark', colour: '#e58af0', legend: 'a mark: drawn by code (Layout)', note: 'Drawn by the game\'s code (no model): Layout is enough, then reload look.html.' },
    },
    palette: {
      groups: [
        { title: 'Buildings', match: (k) => k.startsWith('kit:') && /house|arch_bay|dome_4|stair|parapet/.test(k) },
        { title: 'Landmarks', match: (k) => k.startsWith('hero:') && !/palm|lantern|rover|holo/.test(k) },
        { title: 'Rooftops and machines', match: /solar|antenna|roof_tank|pipe/ },
        { title: 'Street things', match: /awning|crate|barrel|pot|palm|lantern|rover|cafe/ },
        { title: 'Drawn by code', match: (k, info) => info.cls === 'mark' },
      ],
    },
    // the look route's scaling, for Khairos only: footprints are drawn at the game's size, divided by the plan's scale
    display: ({ name }) => (name === LOOK_MAP ? { planScale: SCALE.plan, kindScale: SCALE.kinds, defaultKindScale: SCALE.default, attach: SCALE.attach, wallThickness: WALL.thick, gameLabel: 'in the game' } : {}),
    plants: {
      schema: 'data/schemas/map-plants.schema.json',
      kinds: lib.PLANT_KINDS, labels: lib.PLANT_LABELS, pointKindOf: lib.POINT_KIND_OF, excludeRadius: 0.6,
      draw: { pot_a: { r: 0.3, fill: '#3fae49', ring: '#c0703f' }, pot_b: { r: 0.3, fill: '#2f8f5a', ring: '#a85a35' }, agave: { r: 0.5, fill: '#76b493', star: 7 }, muhly: { r: 0.35, fill: '#a4c7b0' }, blue_grass: { r: 0.2, fill: '#86aec0' }, dry_tuft: { r: 0.2, fill: '#cdb57c' }, rooibos: { r: 0.35, fill: '#98a24e' }, stones: { r: 0.15, fill: '#a39d94' }, boulders: { r: 0.35, fill: '#8d867c' }, rocks: { r: 0.25, fill: '#968f86' }, bark: { r: 0.2, fill: '#6b4a2e' }, urn_plant: { r: 0.4, fill: '#4f9e3a' } },
      debris: ['stones', 'rocks', 'bark'], // drawn, not picked (too many, too small)
      follows: ['grow.planters'], // drawn, not picked: the plant in a green pot goes where the pot goes
      // what tools/look/planting.mjs made by rule, from its per-placement record
      ruleMade({ name, plan }) {
        const file = name === LOOK_MAP ? look.ruleMadeFile() : null;
        if (!file) return { present: false, why: 'Plants has not run, or wrote no per-plant record' };
        return { present: true, file: file.replace(root, '.').replace(/\\/g, '/'), at: statSync(file).mtimeMs, items: look.rulePlants(JSON.parse(readFileSync(file, 'utf8')), plan.ring?.centre || [0, 0], SCALE.plan) };
      },
    },

    // the compile to the game's scene (and its walk grid), its layers, and Thoon Run's own fit check on that grid
    compileLayers: [
      { id: 'streets', label: 'streets and yards (made by the compile)', legend: [['#d9c7ad', 'plazas, lanes, paths, yards']] },
      { id: 'made', label: 'planters, trees, pipes (made by the compile)', legend: [['#9fc98a', 'planters and trees the compile adds (read-only)']] },
    ],
    compile({ plan, name }) {
      const src = lib.sources(name), built = compile(plan, src), seated = {};
      for (const p of built.scene.pieces) seated[p.id] = p.at[1];
      return { ...built, src, seated, log: built.log, overlays: { streets: { shapes: streetShapes(built.scene.streets) }, made: { shapes: madeShapes(built.scene, plan) } } };
    },
    builtInCheck: false,
    check({ plan, plants, built, name }) {
      if (!built) return [];
      const problems = checkFit(plan, built, built.src), isLook = name === LOOK_MAP;
      if (plants) {
        const predicted = checkPlants(plants, plan, built, { kinds: lib.PLANT_KINDS, people: built.src.people, walk: isLook ? look.bakeWalk() : null, P: isLook ? SCALE.plan : 1 });
        const known = isLook ? unplanted(plants, plan) : [];
        for (const k of known) { const why = predicted.find((p) => p.sel[0] === k.sel[0]); if (why) k.text += ` (${why.text.split(': ').slice(1).join(': ').replace(/: the planting will refuse it$/, '')})`; }
        problems.push(...known, ...predicted.filter((p) => !known.some((k) => k.sel[0] === p.sel[0])));
      }
      // tools/look/layout.mjs hangs its cameras and dressing on these pieces by name, and stops without them
      if (isLook) for (const id of ['tower', 'arcade', 'hangar']) if (!plan.pieces.some((p) => p.id === id)) problems.unshift({ kind: 'pipeline', text: `no piece is called "${id}": the look pipeline (tools/look/layout.mjs) places its cameras and dressing by that name and will stop without it`, sel: [], at: null });
      return problems;
    },
    // is what the look pipeline last laid out, baked and planted still the plan on screen?
    status({ plan, plants, built, name }) {
      if (name !== LOOK_MAP || !built) return [];
      const s = look.staleness(built.scene, plan);
      return [
        { title: 'Props, marks and arrival in the game', ...s.laid, action: 'Layout' },
        { title: 'The baked town', ...s.baked, action: 'Bake' },
        { title: 'Plants in the game', ...(plants ? look.plantStaleness(plants) : { state: 'unknown', basis: 'this map has no plants.json' }), action: 'Plants' },
      ];
    },
    beforeSave({ name, plants }) { if (plants && name === LOOK_MAP) look.recordPlanted(); }, // the record of what the last Plants read, before the file it read is replaced
    afterSave({ name, plan }) { writeCompiled(name, compile(plan, lib.sources(name))); }, // the compiled scene on disk follows the saved plan

    // the look pipeline's own layers: the dressing Layout set by rule, and the walk grid of the last bake (lazy: large)
    overlays: {
      rule: {
        label: 'dressing set by rule (from the last Layout)', legend: [['#b9a3ff', 'set by rule in the look pipeline: domes, awnings, the hangar\'s dressing (read-only, dashed)'], ['#e0569b', 'bougainvillea, by rule (read-only)']],
        load({ name, plan }) {
          if (name !== LOOK_MAP || !existsSync(look.GENERATED)) return { present: false, note: name === LOOK_MAP ? 'Layout has not run: no rule-made dressing to show' : '' };
          return { present: true, note: `rule-made dressing as of the last Layout, ${new Date(statSync(look.GENERATED).mtimeMs).toLocaleString()}`, shapes: ruleShapes(JSON.parse(readFileSync(look.GENERATED, 'utf8')), plan, kinds(name)) };
        },
      },
      walk: {
        label: 'where nobody can stand: the walk grid (from the last bake)', lazy: true, on: false, legend: [['#1e3296aa', 'nowhere to stand in the walk grid of the last bake (raised ground paler)']],
        load({ name, plan }) {
          const meta = join(OUT, 'bake.json'), bin = join(OUT, 'walk.bin');
          if (name !== LOOK_MAP || !existsSync(meta) || !existsSync(bin)) return { present: false, note: 'There is no walk grid yet: it comes from a bake.' };
          const grid = JSON.parse(readFileSync(meta, 'utf8')).grid, bytes = readFileSync(bin);
          if (!grid || bytes.length !== grid.cols * grid.rows * 2) return { present: false, note: 'The walk grid does not match its bake.json.' };
          return { present: true, shapes: [{ type: 'grid', min: fromGame(plan, grid.min), cell: grid.cell / SCALE.plan, cols: grid.cols, rows: grid.rows, none: grid.none, scale: grid.scale, offset: grid.offset, solidAbove: 0.3, data: bytes.toString('base64') }] };
        },
      },
    },

    // the look pipeline's steps, one job at a time, for Khairos only; `--dry-run` stubs the heavy ones
    actions: {
      layout: pipeline('Layout', [{ label: 'compile the map (tools/maps/compile.mjs)', ...node('maps/compile.mjs', '{map}') }, { label: 'lay it out (tools/look/layout.mjs)', ...node('look/layout.mjs') }, { label: 'signs and the hologram\'s place (tools/look/signs-assets.mjs)', ...node('look/signs-assets.mjs') }]),
      plants: pipeline('Plants', [{ key: 'planting', label: 'plant it (tools/look/planting.mjs)', ...node('look/planting.mjs'), heavy: true }]),
      layoutPlants: pipeline('Layout + Plants', [{ label: 'compile the map', ...node('maps/compile.mjs', '{map}') }, { label: 'lay it out', ...node('look/layout.mjs') }, { label: 'signs', ...node('look/signs-assets.mjs') }, { key: 'planting', label: 'plant it', ...node('look/planting.mjs'), heavy: true }]),
      bake: pipeline('Bake (about 10 min)', [{ label: 'compile the map', ...node('maps/compile.mjs', '{map}') }, { label: 'lay it out', ...node('look/layout.mjs') }, { label: 'signs', ...node('look/signs-assets.mjs') }, { label: 'bake the town (tools/look/bake.mjs, about ten minutes)', ...node('look/bake.mjs'), heavy: true }, { key: 'planting', label: 'plant it', ...node('look/planting.mjs'), heavy: true }], { confirm: 'Bake the town? It takes about ten minutes and uses the GPU.' }),
    },

    help: [
      ['bake: buildings, walls, awnings, roof things, the ring (radius, gate)', 'Bake: they are in the town\'s mesh and its light. Layout alone moves only what hangs on them.'],
      ['prop: green pots (planter0, planter1 ...: a plant grows in each)', 'Layout + Plants, then reload look.html. (Bumping into a moved one follows at the next Bake.)'],
      ['prop: tables, crates, barrels, pots, palms, the rover', 'Layout, then reload look.html. (They stay unshadowed by the bake where they moved.)'],
      ['mark: the hologram\'s projector', 'Layout, then reload.'],
      ['where you arrive; a door\'s sign', 'Layout, then reload.'],
      ['plants placed by hand (plants.json points), a rule-made plant moved or removed (exclude)', 'Plants (seconds), then reload look.html. Not a Bake.'],
      ['walkers\' rounds, anything plants should keep off', 'Plants (needs the last bake\'s walk grid).'],
      ['people, things to use, doors\' words', 'Saved in the plan; the look route does not draw them yet.'],
    ],
    hints: {
      afterSave: { plan: 'Now Layout (or Bake), to see it in the game.', plants: 'Now Plants, to see it in the game.', both: 'Now Layout + Plants (or Bake for buildings), to see it in the game.' },
      ring: 'The ring wall is baked: after changing it, Bake.',
      person: 'Who they are and what they say is not in the map (data/npcs, data/dialogue).',
      plant: 'Save, then Plants (seconds), then reload look.html; not a Bake.',
      round: 'Plants keep off the rounds: after changing one, press Plants.',
    },
  };
}
