// A map's files as text: the plan (layout.json) and its planting plan (plants.json), each always written the same
// way (stable key order, one piece a line), so a move shows as one changed line in a diff; the atomic write that
// keeps the old file beside it; and the plant edits the page shares with the server.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** A map's name: its folder, and nothing that could leave the maps folder. */
export const NAME = /^[a-z][a-z0-9_-]{0,39}$/;

// --- layout.json ------------------------------------------------------------------------------------
/** The order layout.json keeps its top-level keys in (keys not listed follow, in the order they came). */
export const TOP = ['$schema', 'id', 'name', 'games', 'note', 'frame', 'ring', 'bounds', 'gate', 'spawn', 'kindScale', 'sizes', 'planters', 'awnings', 'pieces', 'marks', 'people', 'doors', 'routes', 'things'];
/** The order a piece keeps its keys in. */
export const PIECE = ['id', 'kind', 'at', 'rot', 'y', 'scale', 'stretch', 'seat'];
const ordered = (object, order) => {
  const out = {};
  for (const key of order) if (key in object) out[key] = object[key];
  for (const key of Object.keys(object)) if (!(key in out)) out[key] = object[key];
  return out;
};
/** The plan with its keys in the order the file keeps them. */
export function normalise(layout) {
  const out = ordered(layout, TOP);
  for (const key of ['pieces', 'marks']) if (Array.isArray(out[key])) out[key] = out[key].map((p) => (p && typeof p === 'object' ? ordered(p, PIECE) : p));
  return out;
}
const WIDE = 150;
const flat = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(flat).join(', ')}]`;
  const keys = Object.keys(v);
  return keys.length ? `{ ${keys.map((k) => `${JSON.stringify(k)}: ${flat(v[k])}`).join(', ')} }` : '{}';
};
const plainList = (v) => Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');
function pretty(v, pad, depth) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const entries = Array.isArray(v) ? v.map((x) => [null, x]) : Object.entries(v);
  if (!entries.length) return Array.isArray(v) ? '[]' : '{}';
  const line = flat(v);
  // the top level and its lists are always one entry a line; below that, whatever fits on a line stays on it
  const holdsThings = entries.some(([, x]) => x !== null && typeof x === 'object');
  if (depth >= 2 ? line.length + pad.length <= WIDE : depth === 1 && (plainList(v) || (!Array.isArray(v) && !holdsThings)) && line.length <= 100) return line;
  const inner = pad + '  ';
  const body = entries.map(([k, x]) => inner + (k === null ? '' : `${JSON.stringify(k)}: `) + pretty(x, inner, depth + 1));
  return `${Array.isArray(v) ? '[' : '{'}\n${body.join(',\n')}\n${pad}${Array.isArray(v) ? ']' : '}'}`;
}
/** layout.json's text: the same plan always gives the same bytes. */
export const formatPlan = (layout) => pretty(normalise(layout), '', 0) + '\n';

// --- plants.json ------------------------------------------------------------------------------------
const PLANTS_TOP = ['$schema', 'note', 'beds', 'walls', 'points', 'exclude', 'inside', 'outside', 'grow'];
const POINT = ['district', 'kind', 'at', 'rot', 'scale'];
const EXCLUDE = ['at', 'r', 'note'];
/** plants.json with its keys in the order the file keeps them (anything else after, as it came). */
export function normalisePlants(plants) {
  const out = ordered(plants, PLANTS_TOP);
  if (Array.isArray(out.points)) out.points = out.points.map((p) => (p && typeof p === 'object' ? ordered(p, POINT) : p));
  if (Array.isArray(out.exclude)) out.exclude = out.exclude.map((p) => (p && typeof p === 'object' ? ordered(p, EXCLUDE) : p));
  return out;
}
/** plants.json's text: two-space JSON, so an unchanged file comes back byte for byte. */
export const formatPlants = (plants) => JSON.stringify(normalisePlants(plants), null, 2) + '\n';

// --- writing ------------------------------------------------------------------------------------------
/**
 * Writes `text` to a temporary file beside `file`, then renames it over `file`; the old file is first copied beside
 * it as `prev` (layout.prev.json). Nothing is written when the file already holds exactly this text.
 */
export function writeKeeping(file, text, prev) {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return { file, changed: false };
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text);
    if (existsSync(file)) copyFileSync(file, join(dirname(file), prev));
    renameSync(temp, file);
  } catch (e) { rmSync(temp, { force: true }); throw e; }
  return { file, changed: true };
}
/** A file's identity for "has it changed on disk since the page read it": its bytes' hash ('' when there is none). */
export const fileStamp = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) : '');

// --- the plant edits, shared with the page -------------------------------------------------------------
/**
 * The editor's plant edits. The server writes this function's source into editor.html, so it must use nothing
 * outside itself (and the tests run the page's own code). A plant made by a project's rules (`it`: { kind, at, rule,
 * rotDeg?, scale?, source? }) that is moved by hand becomes a point of its own plus an exclusion where it stood;
 * removed, an exclusion only.
 */
export function plantEditing() {
  const tidy = (v) => Math.round(v * 1000) / 1000;
  const norm = (deg) => { let v = ((((deg + 180) % 360) + 360) % 360) - 180; if (v === -180) v = 180; return tidy(v); };
  /** Is `at` inside one of plants.json's exclusions? */
  const covered = (plants, at) => ((plants && plants.exclude) || []).some((e) => Math.hypot(at[0] - e.at[0], at[1] - e.at[1]) < e.r);
  /** A rule-made plant as a point: the name a point takes for its kind, its turn in degrees, its size without the kind's factor. */
  function pointFromRule(it, pointKindOf, kinds) {
    const kind = it.source || pointKindOf[it.kind];
    if (!kind || !kinds[kind]) return null;
    const pt = { kind, at: [tidy(it.at[0]), tidy(it.at[1])] };
    if (Number.isFinite(it.rotDeg)) pt.rot = norm(Math.round(it.rotDeg));
    if (Number.isFinite(it.scale)) { const s = Math.round(it.scale / kinds[kind][1] / 0.05) * 0.05; if (Math.abs(s - 1) > 0.049) pt.scale = tidy(s); }
    return pt;
  }
  /** Removes a rule-made plant: an exclusion of radius `r` where it stands (none if one covers it already). */
  function exclude(plants, it, r) { if (!covered(plants, it.at)) (plants.exclude = plants.exclude || []).push({ at: [tidy(it.at[0]), tidy(it.at[1])], r }); }
  /** Takes a rule-made plant into the plan's points (at `to`, or where it stands): returns the new point's index, or -1. */
  function adopt(plants, it, { pointKindOf, kinds, r, to = null }) {
    const pt = pointFromRule(it, pointKindOf, kinds);
    if (!pt) return -1;
    exclude(plants, it, r);
    if (to) pt.at = [tidy(to[0]), tidy(to[1])];
    (plants.points = plants.points || []).push(pt);
    return plants.points.length - 1;
  }
  return { pointFromRule, exclude, adopt, covered, norm };
}
