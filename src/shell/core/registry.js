// A registry of contributions (tools, panels, editors, …): add returns a disposable; listeners hear every change.
export function createRegistry() {
  const items = new Map(), listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); };
  return {
    add(key, value) {
      if (items.has(key)) throw new Error(`${key} is already registered`);
      items.set(key, value); changed();
      return { dispose: () => { if (items.get(key) === value) { items.delete(key); changed(); } } };
    },
    get: (key) => items.get(key), has: (key) => items.has(key), values: () => [...items.values()], entries: () => [...items.entries()],
    onChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
}
