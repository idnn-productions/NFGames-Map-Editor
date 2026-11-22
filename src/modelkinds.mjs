// Models as kinds of piece: every .glb in the project's models folder is a palette entry, sized from the model's own
// bounds (glb.mjs), so a game's assets can be placed with no kit.json entry. Each file is parsed once per version.
import { join } from 'node:path';
import { listModels } from './models.mjs';
import { glbJson, sceneBounds } from './glb.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
/** A kind's name part from a file or folder name: lower case, [a-z0-9_], starting with a letter. */
export const kindPart = (text) => { const s = String(text).toLowerCase().replace(/\.glb$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); return !s ? 'model' : /^[a-z]/.test(s) ? s : `m${s}`; };

/** Kinds for model paths: { 'model:<name>': path }. Where names collide, parent folders are added until they do not. */
export function kindNames(paths) {
  const name = (p, depth) => { const a = p.split('/'); return a.slice(Math.max(0, a.length - 1 - depth)).map(kindPart).join('_'); };
  const depth = new Map(paths.map((p) => [p, 0]));
  for (let round = 0; round < 20; round++) {
    const by = new Map();
    for (const p of paths) { const n = name(p, depth.get(p)); by.set(n, [...(by.get(n) || []), p]); }
    let clash = false;
    for (const list of by.values()) if (list.length > 1) { clash = true; for (const p of list) depth.set(p, depth.get(p) + 1); }
    if (!clash) return Object.fromEntries([...by].map(([n, [p]]) => [`model:${n}`, p]));
  }
  return Object.fromEntries(paths.map((p, i) => [`model:${name(p, 99)}_${i}`, p]));
}

const labelOf = (p) => p.split('/').pop().replace(/\.glb$/i, '').replace(/[_-]+/g, ' ');
const groupOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? 'Models' : `Models · ${p.slice(0, i)}`; };

/** The model kinds of a folder, cached: a function returning { kinds: { kind: raw kind }, problems: [{ file, error }] }. */
export function createModelKinds(modelsDir) {
  const parsed = new Map();
  let listing = null, listedAt = 0;
  return function modelKinds() {
    if (!modelsDir) return { kinds: {}, problems: [] };
    if (!listing || Date.now() - listedAt > 2000) { listing = listModels(modelsDir); listedAt = Date.now(); }
    const byPath = new Map(listing.map((m) => [m.path, m])), kinds = {}, problems = [];
    for (const [kind, path] of Object.entries(kindNames(listing.map((m) => m.path)))) {
      const m = byPath.get(path), stamp = `${m.size}:${m.mtime}`;
      let hit = parsed.get(path);
      if (!hit || hit.stamp !== stamp) {
        try { hit = { stamp, bounds: sceneBounds(glbJson(join(modelsDir, path))) }; } catch (e) { hit = { stamp, error: e.message }; }
        parsed.set(path, hit);
      }
      const base = { cls: 'model', group: groupOf(path), label: labelOf(path), model: path };
      if (hit.error) { kinds[kind] = base; problems.push({ file: path, error: hit.error }); continue; }
      const { min, max } = hit.bounds, w = r2(max[0] - min[0]) || 0.01, d = r2(max[2] - min[2]) || 0.01, h = r2(max[1] - min[1]) || 0.01;
      kinds[kind] = { ...base, size: [w, d, h], boxes: [[r2((min[0] + max[0]) / 2), r2((min[2] + max[2]) / 2), w, d]] };
    }
    return { kinds, problems };
  };
}
