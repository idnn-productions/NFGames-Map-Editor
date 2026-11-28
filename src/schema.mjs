// A small JSON Schema checker, no dependencies: the parts of JSON Schema a map's schemas use (type, properties,
// required, additionalProperties, patternProperties, enum, const, minimum/maximum/exclusiveMinimum, pattern, items,
// minItems/maxItems, anyOf/oneOf, $ref to #/$defs and to other schema files beside the first one).
// Ported from the Thoon Run workspace's tools/validate-data.mjs; each problem is a string that starts with its path.
import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';

/** Schemas read from disk, by absolute path. */
const cache = new Map();
function load(file) {
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(file, 'utf8')));
  return cache.get(file);
}
/** Forget every schema read so far (a test that rewrites one, or an editor that wants the file as it is now). */
export const forgetSchemas = () => cache.clear();

function resolveRef(ref, base) {
  const [file, pointer = ''] = ref.split('#');
  const target = file ? (isAbsolute(file) ? file : join(dirname(base), file)) : base;
  const node = pointer.split('/').filter(Boolean).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((n, key) => (n && typeof n === 'object' && Object.hasOwn(n, key) ? n[key] : undefined), load(target));
  if (!node) throw new Error(`unresolved $ref ${ref} (in ${base})`);
  return [node, target];
}
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const typeOk = (v, t) => (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeOf(v) === t);

/** Problems with `value` against schema node `s`, which was read from the schema file `base` (an absolute path). */
export function check(value, s, base, path = '') {
  const out = [], at = path || '(top)';
  if (s.$ref) { const [t, b] = resolveRef(s.$ref, base); return check(value, t, b, path); }
  if (s.anyOf && !s.anyOf.some((sub) => !check(value, sub, base, path).length)) out.push(`${at}: matches none of the allowed forms`);
  if (s.oneOf && s.oneOf.filter((sub) => !check(value, sub, base, path).length).length !== 1) out.push(`${at}: must match exactly one allowed form`);
  if (s.const !== undefined && value !== s.const) out.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} is not one of ${s.enum.join(', ')}`);
  if (s.type) { const types = [].concat(s.type); if (!types.some((t) => typeOk(value, t))) { out.push(`${at}: should be ${types.join(' or ')}, is ${typeOf(value)}`); return out; } }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) out.push(`${at}: ${value} is below ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) out.push(`${at}: ${value} is above ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) out.push(`${at}: ${value} must be above ${s.exclusiveMinimum}`);
  }
  if (typeof value === 'string' && s.pattern && !new RegExp(s.pattern).test(value)) out.push(`${at}: "${value}" does not match ${s.pattern}`);
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) out.push(`${at}: needs at least ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) out.push(`${at}: at most ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => out.push(...check(v, s.items, base, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of s.required || []) if (!(key in value)) out.push(`${at}: missing "${key}"`);
    for (const [key, v] of Object.entries(value)) {
      const p = path ? `${path}.${key}` : key;
      let matched = false;
      if (s.properties && Object.hasOwn(s.properties, key)) { matched = true; out.push(...check(v, s.properties[key], base, p)); }
      if (s.patternProperties) for (const [re, sub] of Object.entries(s.patternProperties)) if (new RegExp(re).test(key)) { matched = true; out.push(...check(v, sub, base, p)); }
      if (matched) continue;
      if (s.additionalProperties === false) out.push(`${at}: "${key}" is not allowed here`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push(...check(v, s.additionalProperties, base, p));
    }
  }
  return out;
}

/**
 * Problems with `value` against the schema file `file` (an absolute path; its $refs to other files are beside it).
 * The schema is read afresh each time, so an edit to it counts from the next check without restarting the editor.
 */
export function checkFile(value, file) {
  cache.clear();
  return check(value, load(file), file);
}
