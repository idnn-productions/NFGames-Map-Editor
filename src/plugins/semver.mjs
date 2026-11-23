// Just enough semver for plugin compatibility: versions x.y.z; ranges "^x.y.z", "~x.y.z", "x.y.z", ">=x.y.z", "*".
const parse = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim()); return m ? m.slice(1).map(Number) : null; };
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const validVersion = (v) => !!parse(v);

/** Whether `version` is in `range`. */
export function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;
  const r = String(range ?? '').trim();
  if (r === '*' || r === '') return true;
  if (r.startsWith('>=')) { const b = parse(r.slice(2)); return !!b && cmp(v, b) >= 0; }
  const op = r[0] === '^' || r[0] === '~' ? r[0] : '', b = parse(op ? r.slice(1) : r);
  if (!b || cmp(v, b) < 0) return false;
  if (op === '^') return b[0] > 0 ? v[0] === b[0] : b[1] > 0 ? v[0] === 0 && v[1] === b[1] : cmp(v, b) === 0;
  if (op === '~') return v[0] === b[0] && v[1] === b[1];
  return cmp(v, b) === 0;
}
