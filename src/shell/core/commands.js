// Commands: everything runnable, by id ("<plugin>/<command>"). A command can be declared (from a manifest) before its
// plugin has loaded; running it calls its `load` first, which registers the handler.
import { createRegistry } from './registry.js';

export function createCommands() {
  const reg = createRegistry(), handlers = new Map();
  return {
    declare: (id, info = {}) => reg.add(id, { id, title: info.title || id, keys: info.keys || null, plugin: info.plugin || null, category: info.category || '', load: info.load || null }),
    handle(id, fn) {
      if (handlers.has(id)) throw new Error(`${id} already has a handler`);
      handlers.set(id, fn);
      return { dispose: () => { if (handlers.get(id) === fn) handlers.delete(id); } };
    },
    async execute(id, ...args) {
      const c = reg.get(id);
      if (!c) throw new Error(`no command ${id}`);
      if (!handlers.has(id) && c.load) await c.load();
      const fn = handlers.get(id);
      if (!fn) throw new Error(`${c.title}: nothing handles it`);
      return fn(...args);
    },
    list: () => reg.values(), get: (id) => reg.get(id), onChange: (fn) => reg.onChange(fn),
  };
}

/** The palette's matching: every typed character in order, case-insensitive; runs and word starts rank higher. */
export function rank(items, query, text = (i) => i.title) {
  const q = query.trim().toLowerCase();
  if (!q) return items.map((item) => ({ item, score: 0 }));
  const out = [];
  for (const item of items) {
    const t = String(text(item)).toLowerCase();
    let score = 0, at = -1, ok = true;
    for (const ch of q) {
      const i = t.indexOf(ch, at + 1);
      if (i < 0) { ok = false; break; }
      score += (i === at + 1 && at >= 0 ? 3 : 0) + (i === 0 || /[\s:./-]/.test(t[i - 1]) ? 2 : 0) - i * 0.01;
      at = i;
    }
    if (ok) out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
