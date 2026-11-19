// The built-in fit check: does a map's plan sit right? It needs only the plan and each kind's footprint (the
// project's kinds, see project.mjs), so it works for any project. Every finding is a warning: none stops a save.
//
//   overlap    two pieces on the ground standing in each other (separating axes on their footprint boxes)
//   outside    a piece on the ground beyond the ring (or the bounds)
//   float      a lifted piece (y > 0.5) with nothing under it, or at a height that is not the top of what it stands on
//   overhang   a lifted piece hanging over the edge of what it stands on
//   person, thing, round, door, spawn
//              a person, a thing to use (nowhere to stand within its radius), a walker's round, the step before a door,
//              where the player arrives: inside a piece, or beyond the town's edge
//   plant      (checkPlants) a hand-placed plant of an unknown kind, outside the town, in a piece, in a doorway, on a round
//
// A project can add its own checks, or replace these with them (config `check`, `builtInCheck: false`).
// Frame: metres, +X east, +Z south; a piece's `rot` is degrees about up, 0 facing +Z; its front (+Z) turns to (sin, cos).
const rad = (d) => (d * Math.PI) / 180;
const LIFTED = 0.5;

/** The helpers both checks use: a piece's scale, a point of its own frame in the map's, its footprint boxes, "open ground". */
export function geometry(plan, kinds) {
  const pieces = [...(plan.pieces || []), ...(plan.marks || [])];
  const kindScale = plan.kindScale || {};
  const scaleOf = (p) => p.scale || kindScale[p.kind] || 1;
  const place = (p, lx, lz) => { const t = rad(p.rot || 0), c = Math.cos(t), s = Math.sin(t); return [p.at[0] + lx * c + lz * s, p.at[1] - lx * s + lz * c]; };
  const lifted = (p) => (p.y || 0) > LIFTED;
  /** A piece's footprint boxes in its own frame [x, z, w, d], scaled and stretched. */
  const boxes = (p) => { const k = kinds[p.kind], s = scaleOf(p), st = p.stretch || 1; return k ? k.boxes.map(([x, z, w, d]) => [x * s * st, z * s, w * s * st, d * s]) : []; };
  /** Is a point of the map inside one of piece p's boxes (grown by `grow` metres)? */
  const inside = (p, [x, z], grow = 0) => {
    const t = rad(p.rot || 0), c = Math.cos(t), s = Math.sin(t), dx = x - p.at[0], dz = z - p.at[1];
    const u = dx * c - dz * s, v = dx * s + dz * c;
    return boxes(p).some(([bx, bz, bw, bd]) => Math.abs(u - bx) <= bw / 2 + grow && Math.abs(v - bz) <= bd / 2 + grow);
  };
  const solid = pieces.filter((p) => !lifted(p) && kinds[p.kind] && kinds[p.kind].solid !== false);
  const C = plan.ring?.centre, R = plan.ring?.radius, B = plan.bounds;
  /** How far a point is beyond the town's edge (negative inside). */
  const past = ([x, z]) => (plan.ring ? Math.hypot(x - C[0], z - C[1]) - R : B ? Math.max(B.min[0] - x, x - B.max[0], B.min[1] - z, z - B.max[1]) : -Infinity);
  /** Somewhere a person can stand: in the town, in no solid piece. */
  const open = (at) => past(at) < 0 && !solid.some((p) => inside(p, at));
  /** The map point of a door: its piece's door spot (the kind's `door`), or its own `at`. */
  const byId = Object.fromEntries(pieces.map((p) => [p.id, p]));
  const doorAt = (d) => { const p = byId[d.piece], spot = p && kinds[p.kind]?.door; return spot ? place(p, spot[0] * scaleOf(p), spot[1] * scaleOf(p)) : d.at || null; };
  return { pieces, scaleOf, place, lifted, boxes, inside, solid, past, open, byId, doorAt };
}

/** The fit check. `kinds` is the project's { kind: { size, boxes, door, solid, across, mayOverlap, deck } }. Returns [{ kind, text, sel, at }]. */
export function checkFit(plan, kinds) {
  const g = geometry(plan, kinds), problems = [];
  const say = (kind, text, sel = [], at = null) => problems.push({ kind, text, sel, at });
  const corners = (p, b) => { const [x, z, w, d] = b; return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => g.place(p, x + (a * w) / 2, z + (c * d) / 2)); };

  // 1. Lifted pieces: on something, the whole footprint over it, at its top.
  for (const p of g.pieces) {
    if (!g.lifted(p)) continue;
    const bs = g.boxes(p);
    if (!bs.length) continue;
    const [x, z, w, d] = bs.reduce((a, b) => (b[2] * b[3] > a[2] * a[3] ? b : a));
    const pts = [];
    for (const u of [-0.45, 0, 0.45]) for (const v of [-0.45, 0, 0.45]) pts.push(g.place(p, x + u * w, z + v * d));
    const under = (pt) => g.solid.filter((q) => g.inside(q, pt));
    const below = under(pts[4]);
    if (!below.length) { say('float', `${p.id} (${p.kind}) is lifted ${p.y} m over nothing`, [`piece:${p.id}`], p.at); continue; }
    const host = below[0], hk = kinds[host.kind], top = (hk.deck ?? hk.size[2]) * g.scaleOf(host);
    if (Number.isFinite(top) && Math.abs(p.y - top) > 0.05) say('float', `${p.id} (${p.kind}) is at y ${p.y}, the top of ${host.id} under it is at ${+top.toFixed(2)} (${p.y > top ? 'floats ' + (p.y - top).toFixed(2) : 'sinks ' + (top - p.y).toFixed(2)} m)`, [`piece:${p.id}`], p.at);
    const off = pts.filter((pt) => !under(pt).length).length;
    if (off) say('overhang', `${p.id} (${p.kind}): ${off} of 9 points of its footprint are off what it stands on (it hangs over the edge)`, [`piece:${p.id}`], p.at);
  }

  // 2. Ground pieces in each other.
  function depth(A, B) {
    let least = Infinity;
    for (const poly of [A, B]) for (let i = 0; i < 4; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % 4];
      const n = [-(bz - az), bx - ax], len = Math.hypot(...n);
      const pr = (q) => q.map(([qx, qz]) => (qx * n[0] + qz * n[1]) / len);
      const a = pr(A), b = pr(B);
      const o = Math.min(Math.max(...a), Math.max(...b)) - Math.max(Math.min(...a), Math.min(...b));
      if (o <= 0) return 0;
      least = Math.min(least, o);
    }
    return least;
  }
  const pairOk = (a, b) => (kinds[a.kind].mayOverlap || []).includes(b.kind) || (kinds[b.kind].mayOverlap || []).includes(a.kind) || (a.at[0] === b.at[0] && a.at[1] === b.at[1]);
  const footprints = new Map(g.solid.map((p) => [p, g.boxes(p).map((b) => corners(p, b))]));
  for (let i = 0; i < g.solid.length; i++) for (let j = i + 1; j < g.solid.length; j++) {
    const a = g.solid[i], b = g.solid[j];
    if (pairOk(a, b)) continue;
    let worst = 0;
    for (const ba of footprints.get(a)) for (const bb of footprints.get(b)) worst = Math.max(worst, depth(ba, bb));
    if (worst > 0.05) say('overlap', `${a.id} (${a.kind}) and ${b.id} (${b.kind}) stand ${worst.toFixed(2)} m in each other`, [`piece:${a.id}`, `piece:${b.id}`], a.at);
  }

  // 3. Beyond the edge: a ground piece with its middle or a corner of its footprint outside the ring (or the bounds).
  if (plan.ring || plan.bounds) for (const p of g.pieces) {
    if (g.lifted(p) || kinds[p.kind]?.across) continue;
    const worst = Math.max(g.past(p.at), ...g.boxes(p).flatMap((b) => corners(p, b)).map(g.past));
    if (worst > 0.05) say('outside', `${p.id} (${p.kind}) stands ${worst.toFixed(2)} m beyond the ${plan.ring ? 'ring' : 'bounds'}`, [`piece:${p.id}`], p.at);
  }

  // 4. People, things, rounds, doors and the arrival: on open ground.
  const fix = (pt) => pt.map((v) => +v.toFixed(2));
  for (const [id, v] of Object.entries(plan.people || {})) { const at = Array.isArray(v) ? v : v.at; if (!g.open(at)) say('person', `${id} stands inside something (or beyond the edge) at ${at}`, [`person:${id}`], at); }
  for (const t of plan.things || []) {
    if (g.open(t.at)) continue;
    let ok = false; // used from within its radius: somewhere to stand there is enough
    for (let a = 0; a < 16 && !ok; a++) for (let r = 0.25; r <= t.radius && !ok; r += 0.25) ok = g.open([t.at[0] + Math.cos((a * Math.PI) / 8) * r, t.at[1] + Math.sin((a * Math.PI) / 8) * r]);
    if (!ok) say('thing', `${t.id}: nowhere to stand within ${t.radius} m of it (${t.at})`, [`thing:${t.id}`], t.at);
  }
  (plan.routes || []).forEach((r, i) => {
    for (let k = 0; k < r.length; k++) {
      const a = r[k], b = r[(k + 1) % r.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25));
      let bad = 0, first = null;
      for (let s = 0; s <= n; s++) {
        const pt = [a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n];
        if (!g.open(pt)) { bad++; first ??= fix(pt); }
      }
      if (bad) say('round', `walker ${i}'s round: leg ${k} (${a} -> ${b}) goes through something for ${(bad * 0.25).toFixed(1)} m, first at ${first}`, [`route:${i}:${k}`], first);
    }
  });
  for (const d of plan.doors || []) {
    const p = g.byId[d.piece], at = g.doorAt(d);
    if (!at) { say('door', `door ${d.id}: ${p ? `${p.kind} has no known door (give the kind a "door" spot)` : `no piece "${d.piece}"`}`, p ? [`door:${d.id}`] : [], p?.at || null); continue; }
    if (!g.open(at)) say('door', `door ${d.id} (on ${d.piece || 'the ground'}): the step before it, at ${fix(at)}, is inside something`, [`door:${d.id}`], at);
  }
  if (plan.spawn && !g.open(plan.spawn.at)) say('spawn', `the player arrives inside something (or beyond the edge) at ${plan.spawn.at}`, ['spawn'], plan.spawn.at);
  return problems;
}

const segDist = (p, a, b) => { const abx = b[0] - a[0], abz = b[1] - a[1], t = Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / Math.max(1e-6, abx * abx + abz * abz))); return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - abz * t); };

/**
 * Hand-placed plants (plants.json `points`): of a kind the project knows (`plantKinds`, when it lists any), in the town,
 * not in a piece, not in a doorway, off the walkers' rounds (`clearance` metres; `tall` kinds `tallClearance`).
 */
export function checkPlants(plants, plan, kinds, { plantKinds = {}, clearance = 0.6, tall = [], tallClearance = 1.0 } = {}) {
  const problems = [], points = (plants && plants.points) || [];
  if (!points.length) return problems;
  const g = geometry(plan, kinds), known = Object.keys(plantKinds).length > 0;
  const doors = [];
  for (const p of g.pieces) { const spot = !g.lifted(p) && kinds[p.kind]?.door; if (spot) { const t = rad(p.rot || 0); doors.push({ id: p.id, at: g.place(p, spot[0] * g.scaleOf(p), spot[1] * g.scaleOf(p)), out: [Math.sin(t), Math.cos(t)], k: g.scaleOf(p) }); } }
  const rounds = (plan.routes || []).flatMap((r) => r.map((a, i) => [a, r[(i + 1) % r.length]]));
  points.forEach((pt, i) => {
    const at = pt.at, sel = [`plant:${i}`];
    const say = (text) => problems.push({ kind: 'plant', text: `plant ${i} (${pt.kind}) at ${at.map((v) => +v.toFixed(2)).join(', ')}: ${text}`, sel, at });
    if (known && !plantKinds[pt.kind]) { say('not a kind this project plants: nothing will grow there'); return; }
    if (g.past(at) >= 0) { say('outside the town'); return; }
    const inPiece = g.solid.find((p) => g.inside(p, at));
    if (inPiece) { say(`inside ${inPiece.id}'s footprint`); return; }
    for (const d of doors) {
      const dx = at[0] - d.at[0], dz = at[1] - d.at[1], along = dx * d.out[0] + dz * d.out[1], across = Math.abs(-dx * d.out[1] + dz * d.out[0]);
      if (along > -1.6 * d.k && along < 0.9 && across < 0.9) { say(`in ${d.id}'s doorway: it stands in the way in and out`); return; }
    }
    const built = plantKinds[pt.kind] ? plantKinds[pt.kind][0] : pt.kind;
    const clear = tall.includes(built) || tall.includes(pt.kind) ? tallClearance : clearance;
    if (rounds.some(([a, b]) => segDist(at, a, b) < clear)) say('on a walkers\' round: they walk through it');
  });
  return problems;
}
