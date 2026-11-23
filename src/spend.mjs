// The spend guard: what paid service calls cost this month, per service, against the budget the user set. A call whose
// estimate is at or above the threshold, or that would pass the budget, needs the user's yes in the editor, also when
// an agent asked for it. Kept in ~/.nfgames-editor/spend.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createSpend({ stateDir, threshold = 0.5, now = () => new Date() } = {}) {
  const file = join(stateDir, 'spend.json'), month = () => now().toISOString().slice(0, 7);
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (j) => { mkdirSync(stateDir, { recursive: true }); writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`); };
  const money = (n) => `$${n.toFixed(2)}`;
  const api = {
    spent: (key) => read().months?.[month()]?.[key] || 0,
    budget: (key) => read().budgets?.[key] ?? null,
    threshold: () => read().threshold ?? threshold,
    setBudget(key, amount) {
      if (amount !== null && !(typeof amount === 'number' && Number.isFinite(amount) && amount >= 0)) throw new Error('a budget is dollars a month, or none');
      const j = read(); j.budgets = { ...(j.budgets || {}) };
      if (amount === null) delete j.budgets[key]; else j.budgets[key] = amount;
      write(j);
    },
    /** { ok } or { confirm: why the user must say yes }. */
    check(key, estimate = 0) {
      // an estimate that is missing or not a number is an unknown cost, not a free one
      const known = typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0, est = known ? estimate : 0;
      const b = api.budget(key), spent = api.spent(key);
      if (b !== null && spent >= b) return { confirm: `${key} has used its ${money(b)} budget this month (${money(spent)} so far).` };
      if (b !== null && !known) return { confirm: `The cost of this is not known, and ${key} has a ${money(b)} monthly budget (${money(spent)} used).` };
      if (b !== null && spent + est > b) return { confirm: `This would take ${key} to ${money(spent + est)} of its ${money(b)} monthly budget.` };
      if (est > 0 && est >= api.threshold()) return { confirm: `This costs about ${money(est)}.` };
      return { ok: true };
    },
    record(key, cost) {
      if (!(cost > 0)) return;
      const j = read(), m = month(); j.months = j.months || {}; j.months[m] = j.months[m] || {};
      j.months[m][key] = Math.round(((j.months[m][key] || 0) + cost) * 10000) / 10000;
      write(j);
    },
  };
  return api;
}
