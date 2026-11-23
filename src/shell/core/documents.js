// The open documents (the centre's tabs): { id, title, editor, uri, dirty }, one of them active.
export function createDocuments() {
  let docs = [], active = null, n = 0;
  const listeners = new Set(), changed = () => { for (const fn of listeners) fn({ docs, active }); };
  return {
    open({ title, editor, uri = null }) {
      const same = uri !== null && docs.find((d) => d.editor === editor && d.uri === uri);
      if (same) { active = same.id; changed(); return same; }
      const d = { id: `doc${++n}`, title, editor, uri, dirty: false };
      docs = [...docs, d]; active = d.id; changed();
      return d;
    },
    close(id) {
      const i = docs.findIndex((d) => d.id === id);
      if (i < 0) return;
      docs = docs.filter((d) => d.id !== id);
      if (active === id) active = docs[Math.min(i, docs.length - 1)]?.id ?? null;
      changed();
    },
    focus(id) { if (docs.some((d) => d.id === id)) { active = id; changed(); } },
    setDirty(id, dirty) { docs = docs.map((d) => (d.id === id ? { ...d, dirty: !!dirty } : d)); changed(); },
    setTitle(id, title) { docs = docs.map((d) => (d.id === id ? { ...d, title } : d)); changed(); },
    list: () => docs, active: () => docs.find((d) => d.id === active) || null,
    on(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
}
