// The one selection every tool shares: { type, items }, the type naming what is selected ("nfgames.map/piece").
export function createSelection() {
  let current = { type: null, items: [] };
  const listeners = new Set();
  return {
    get: () => current,
    set(type, items = []) { current = { type: items.length ? type : null, items: [...items] }; for (const fn of listeners) fn(current); },
    clear() { this.set(null, []); },
    on(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
}
