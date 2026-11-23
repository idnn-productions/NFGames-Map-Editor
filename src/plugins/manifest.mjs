// A plugin's plugin.json: who it is, which plugin API it needs, what it touches, what it adds, and when its code loads.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { satisfies, validVersion } from './semver.mjs';

export const API_VERSION = '1.0.0';
export const ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;               // reverse-domain style: "nfgames.model-review"
const LOCAL = /^[a-z][a-zA-Z0-9-]*$/;                                       // a contribution's own id
export const POINTS = ['tools', 'editors', 'panels', 'inspectors', 'commands', 'statusItems', 'workflows', 'services'];
const EVENT = /^(onStartup|onProject|onRoute|on(Tool|Editor|Command|Panel|Inspector|Service):[a-zA-Z][a-zA-Z0-9-]*)$/;
const inside = (p) => typeof p === 'string' && p !== '' && !isAbsolute(p) && !normalize(p).startsWith('..');
// an entry point must be a plain file of the plugin's own: not in a hidden folder or node_modules, which the trust hash would not cover
const plainEntry = (p) => inside(p) && !normalize(p).split(/[\\/]/).some((s) => s.startsWith('.') || s === 'node_modules');

/** What is wrong with a manifest object (empty when nothing is). */
export function checkManifest(m) {
  const errors = [], say = (t) => errors.push(t);
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['plugin.json is not an object'];
  if (typeof m.id !== 'string' || !ID.test(m.id)) say('id: lower case, reverse-domain style, e.g. "studio.terrain-tools"');
  if (typeof m.name !== 'string' || !m.name.trim()) say('name: a name to show');
  if (!validVersion(m.version)) say('version: x.y.z');
  if (!m.engines || typeof m.engines.nfgames !== 'string') say('engines.nfgames: the plugin API version it needs, e.g. "^1.0.0"');
  for (const k of ['server', 'web']) if (m[k] !== undefined && !plainEntry(m[k])) say(`${k}: a path inside the plugin's folder, not in a hidden folder or node_modules`);
  const t = m.touches || {};
  if (t.files !== undefined && (!Array.isArray(t.files) || !t.files.every((g) => inside(String(g).replace(/\*/g, 'x'))))) say('touches.files: project-relative globs');
  if (t.commands !== undefined && (!Array.isArray(t.commands) || !t.commands.every((c) => typeof c === 'string'))) say('touches.commands: a list of program names');
  if (t.network !== undefined && typeof t.network !== 'boolean') say('touches.network: true or false');
  for (const [point, list] of Object.entries(m.contributes || {})) {
    if (point === 'settings') { if (!list || typeof list !== 'object' || Array.isArray(list)) say('contributes.settings: { name: { type, default, title } }'); continue; }
    if (!POINTS.includes(point)) { say(`contributes.${point}: not an extension point (${[...POINTS, 'settings'].join(', ')})`); continue; }
    if (!Array.isArray(list)) { say(`contributes.${point}: a list`); continue; }
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || !LOCAL.test(item.id)) { say(`contributes.${point}: every entry needs a plain id`); continue; }
      if (seen.has(item.id)) say(`contributes.${point}: two are called "${item.id}"`);
      seen.add(item.id);
    }
  }
  if (m.activation !== undefined && (!Array.isArray(m.activation) || !m.activation.every((e) => typeof e === 'string' && EVENT.test(e)))) say('activation: events such as "onStartup", "onProject", "onRoute", "onTool:<id>", "onCommand:<id>"');
  return errors;
}

/** Reads <dir>/plugin.json: { manifest, errors, compatible }. Never throws. */
export function readManifest(dir, apiVersion = API_VERSION) {
  const file = join(dir, 'plugin.json');
  if (!existsSync(file)) return { manifest: null, errors: ['no plugin.json'], compatible: false };
  let m;
  try { m = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { manifest: null, errors: [`plugin.json: ${e.message}`], compatible: false }; }
  const errors = checkManifest(m);
  return { manifest: m, errors, compatible: !errors.length && satisfies(apiVersion, m.engines.nfgames) };
}
