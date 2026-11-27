// External PBR material sets a project keeps outside its .glb files (for engines that bind scanned materials by
// material name, e.g. "<a>|<b>[|amount][|#tint]", plus a plain.json lookup for solid/emissive surfaces).
//
// Either named explicitly in map-editor.config.mjs (`materials: { dirs, plain }`, or a folder path, or `false`), or
// discovered automatically inside the project root (skipping dot-folders, build outputs, node_modules and links).
// Every served texture stays inside a discovered materials folder and has its file signature checked.
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { IMAGE_SIGNATURES } from './models.mjs';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'Library', 'Temp', 'vendor', 'release']);
const MAX_SCAN_DEPTH = 6;
const MAX_TEX_SIZE = 40 * 1024 * 1024;
const SET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

const ALBEDO_FILES = ['albedo-1k.ktx2', 'albedo-2k.ktx2', 'albedo.png', 'albedo.jpg', 'albedo.jpeg', 'albedo.webp'];
const NORMAL_FILES = ['normal-1k.ktx2', 'normal-2k.ktx2', 'normal.png', 'normal.jpg', 'normal.jpeg', 'normal.webp'];
const ORM_FILES = ['ormh-1k.ktx2', 'ormh-2k.ktx2', 'ormh.png', 'orm.png', 'orm.jpg', 'orm.webp'];
const ALLOWED_FILES = new Set([...ALBEDO_FILES, ...NORMAL_FILES, ...ORM_FILES, 'height.png']);

const MIME = { '.ktx2': 'image/ktx2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const KTX2_SIG = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function head(file) {
  const b = Buffer.alloc(12), fd = openSync(file, 'r');
  try { readSync(fd, b, 0, 12, 0); } finally { closeSync(fd); }
  return b;
}
function signatureOk(file, ext) {
  const b = head(file);
  if (ext === '.ktx2') return b.equals(KTX2_SIG);
  if (ext === '.png') return IMAGE_SIGNATURES.png(b);
  if (ext === '.jpg' || ext === '.jpeg') return IMAGE_SIGNATURES.jpg(b);
  if (ext === '.webp') return IMAGE_SIGNATURES.webp(b);
  return false;
}

/** True when `dir` looks like a folder of named PBR material sets (at least one subfolder with an albedo texture). */
function isMaterialsDir(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.isSymbolicLink() || !SET_NAME.test(e.name)) continue;
    const sub = join(dir, e.name);
    if (ALBEDO_FILES.some((f) => existsSync(join(sub, f)))) return true;
  }
  return false;
}
/** True when `file` parses as a plain-materials JSON map (entries holding a hex colour string). */
function readPlainJson(file) {
  if (!file || !existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const colour = typeof v.colour === 'string' ? v.colour : typeof v.color === 'string' ? v.color : null;
      if (!colour || !/^#[0-9a-fA-F]{3,8}$/.test(colour)) continue;
      const entry = { colour };
      if (typeof v.roughness === 'number') entry.roughness = v.roughness;
      if (typeof v.metal === 'number') entry.metal = v.metal;
      if (typeof v.metalness === 'number') entry.metal = v.metalness;
      if (typeof v.glow === 'number') entry.glow = v.glow;
      if (typeof v.sky === 'number') entry.sky = v.sky;
      out[k] = entry;
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** Discovers material folders and plain.json inside `root`, skipping hidden/build folders and links. */
function autoDiscover(root) {
  const dirs = [], plains = [];
  const walk = (at, depth) => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = join(at, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name === 'materials' && isMaterialsDir(full)) dirs.push(full);
        else walk(full, depth + 1);
      } else if (e.isFile() && e.name === 'plain.json') {
        if (readPlainJson(full)) plains.push(full);
      }
    }
  };
  walk(root, 0);
  // prefer built KTX2 folders (with materials.json or -1k.ktx2) ahead of raw source PNG folders
  const rank = (d) => (existsSync(join(d, 'materials.json')) ? 0 : 1);
  dirs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  plains.sort();
  return { dirs, plain: plains[0] || null };
}

/** Normalises the `materials` config option into `{ dirs: [absDir, ...], plain: absFile | null }`. */
export function resolveMaterialsConfig(root, option, inside) {
  if (option === false || option === null) return { dirs: [], plain: null };
  if (option === undefined) return autoDiscover(root);
  if (typeof option === 'string') return { dirs: [inside(option, '"materials"')], plain: null };
  if (typeof option !== 'object' || Array.isArray(option)) throw new Error('map editor config: "materials" must be a path, an object ({ dirs, plain }), or false');
  const rawDirs = option.dirs !== undefined ? (Array.isArray(option.dirs) ? option.dirs : [option.dirs]) : option.dir ? [option.dir] : [];
  const dirs = rawDirs.map((d) => { if (typeof d !== 'string') throw new Error('map editor config: "materials.dirs" entries must be paths'); return inside(d, '"materials.dirs"'); });
  const plain = option.plain ? inside(option.plain, '"materials.plain"') : null;
  return { dirs, plain };
}

/**
 * The material catalogue for the viewer: `{ sets: { name: { albedo, normal?, orm?, hasHeight, colour?, roughness?, metal?, tile? } }, plain: { ... } }`.
 * No filesystem paths leave the server. Earlier folders in `cfg.dirs` win on name collisions.
 */
export function readMaterialLibrary(cfg) {
  const sets = {};
  if (!cfg || !Array.isArray(cfg.dirs)) return { sets, plain: {} };
  for (const dir of cfg.dirs) {
    if (!existsSync(dir)) continue;
    let meta = {};
    try {
      const m = JSON.parse(readFileSync(join(dir, 'materials.json'), 'utf8'));
      if (m && typeof m === 'object' && !Array.isArray(m)) meta = m;
    } catch { /* no materials.json: still list sets by folder */ }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || !SET_NAME.test(e.name) || Object.hasOwn(sets, e.name)) continue;
      const sub = join(dir, e.name);
      const pick = (list) => list.find((f) => { try { return lstatSync(join(sub, f)).isFile(); } catch { return false; } }) || null;
      const albedo = pick(ALBEDO_FILES);
      if (!albedo) continue;
      const normal = pick(NORMAL_FILES), orm = pick(ORM_FILES);
      const info = meta[e.name] && typeof meta[e.name] === 'object' ? meta[e.name] : {};
      const entry = { albedo };
      if (normal) entry.normal = normal;
      if (orm) entry.orm = orm;
      if (orm && orm.startsWith('ormh')) entry.hasHeight = true;
      if (Array.isArray(info.colour) && info.colour.length === 3) entry.colour = info.colour;
      if (typeof info.roughness === 'number') entry.roughness = info.roughness;
      if (typeof info.metal === 'number') entry.metal = info.metal;
      if (typeof info.tile === 'number' && info.tile > 0 && Number.isFinite(info.tile)) entry.tile = info.tile;   // metres one repeat covers
      sets[e.name] = entry;
    }
  }
  const plain = (cfg.plain && readPlainJson(cfg.plain)) || {};
  return { sets, plain };
}

/** Resolves one texture of set `set` (e.g. "whitewash-plaster", "albedo-1k.ktx2") to `{ file, type, size }`, or null. */
export function resolveMaterialFile(cfg, set, file) {
  if (!cfg || !Array.isArray(cfg.dirs) || typeof set !== 'string' || typeof file !== 'string') return null;
  if (!SET_NAME.test(set) || !ALLOWED_FILES.has(file)) return null;
  const ext = extname(file).toLowerCase(), type = MIME[ext];
  if (!type) return null;
  for (const dir of cfg.dirs) {
    try {
      const root = realpathSync(dir), sub = join(root, set);
      if (!lstatSync(sub).isDirectory() || realpathSync(sub) !== sub) continue;
      const full = join(sub, file), st = lstatSync(full);
      if (!st.isFile() || st.size > MAX_TEX_SIZE) continue;
      const real = realpathSync(full);
      if (!real.startsWith(root + sep)) continue;
      if (!signatureOk(real, ext)) continue;
      return { file: real, type, size: st.size };
    } catch { /* try next dir */ }
  }
  return null;
}
