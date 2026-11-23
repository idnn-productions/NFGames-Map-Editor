// The workbench's problems: one list per source (a plugin's id, or 'map' for the shown map), shown together in the
// bottom panel's Problems tab. A source may say how to go to one of its problems (the map pans to it and selects it).
export function createProblems() {
  const lists = new Map(), listeners = new Set();   // source → { list, goTo }
  const tell = () => { for (const fn of listeners) fn(); };
  return {
    /** Sets a source's problems: [{ kind, text, ... }]. goTo(index) is called when one of them is clicked. */
    set(source, list, goTo = null) {
      const items = Array.isArray(list) ? list : [];
      if (items.length) lists.set(source, { list: items.map((x, index) => ({ ...x, source, index })), goTo }); else lists.delete(source);
      tell();
    },
    drop(source) { if (lists.delete(source)) tell(); },
    all: () => [...lists.values()].flatMap((l) => l.list),
    count: () => [...lists.values()].reduce((n, l) => n + l.list.length, 0),
    /** Goes to a problem from all(), when its source said how. */
    go(problem) { const l = problem && lists.get(problem.source); if (l && typeof l.goTo === 'function') l.goTo(problem.index); },
    canGo: (problem) => typeof lists.get(problem && problem.source)?.goTo === 'function',
    on(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
}
