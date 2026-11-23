// A folding list: items with a path ('art/town/apple.glb') drawn under folders that open and close. The model viewer's
// list and the map editor's palette both use it. Folders keep the order their first item came in; inside a folder,
// folders come before items. A chain of folders with nothing else in them is one row ('web/run/public/models').
// A classic script (the map editor has no modules): it sets nfTree. Only render() and store() touch the page.
(() => {
  /** items [{ path, search? }] → nodes: { type: 'folder', path, label, count, open, children } | { type: 'item', item, label }. */
  function build(items, { filter = '', closed = new Set() } = {}) {
    const q = filter.trim().toLowerCase();
    const root = { folders: new Map(), items: [] };
    for (const item of items) {
      if (q && !item.path.toLowerCase().includes(q) && !(item.search && item.search.toLowerCase().includes(q))) continue;
      const parts = item.path.split('/'); let at = root;
      for (let i = 0; i < parts.length - 1; i++) { let next = at.folders.get(parts[i]); if (!next) at.folders.set(parts[i], next = { folders: new Map(), items: [] }); at = next; }
      at.items.push({ type: 'item', item, label: parts[parts.length - 1] });
    }
    const nodes = (dir, prefix) => {
      const out = [];
      for (let [name, f] of dir.folders) {
        let path = prefix + name, label = name;
        while (!f.items.length && f.folders.size === 1) { const [n, only] = [...f.folders][0]; label += `/${n}`; path += `/${n}`; f = only; }
        const children = nodes(f, `${path}/`);
        out.push({ type: 'folder', path, label, count: children.reduce((n, c) => n + (c.type === 'folder' ? c.count : 1), 0), open: q ? true : !closed.has(path), children });
      }
      return out.concat(dir.items);
    };
    return nodes(root, '');
  }

  /** Draws nodes into box. row(item) → Element draws an item; onToggle(path, open) hears a folder opened or closed. */
  function render(box, nodes, { row, onToggle = () => {} }) {
    const doc = box.ownerDocument;
    const draw = (list, depth) => list.map((n) => {
      if (n.type === 'item') return row(n.item, n);
      const wrap = doc.createElement('div'), head = doc.createElement('button'), count = doc.createElement('span');
      wrap.className = 'tree-group'; head.type = 'button'; head.className = 'tree-folder'; head.title = n.path;
      count.className = 'tree-count'; count.textContent = n.count;
      let kids = null;
      const show = (open) => {
        head.setAttribute('aria-expanded', String(open)); head.replaceChildren(`${open ? '▾' : '▸'} ${n.label}`, count);
        if (open && !kids) { kids = doc.createElement('div'); kids.className = 'tree-kids'; kids.append(...draw(n.children, depth + 1)); wrap.append(kids); }   // built when first opened
        if (kids) kids.hidden = !open;
      };
      head.onclick = () => { n.open = !n.open; show(n.open); onToggle(n.path, n.open); };
      wrap.append(head); show(n.open);
      return wrap;
    });
    box.replaceChildren(...draw(nodes, 0));
  }

  /** Which folders are closed, kept in this browser under nfgames.tree.<key>. */
  function store(key) {
    const name = `nfgames.tree.${key}`; let closed = new Set();
    try { closed = new Set(JSON.parse(localStorage.getItem(name) || '[]')); } catch { /* none kept, or storage blocked */ }
    return {
      closed,
      toggle(path, open) {
        if (open) closed.delete(path); else closed.add(path);
        try { localStorage.setItem(name, JSON.stringify([...closed])); } catch { /* not kept: this page still remembers */ }
      },
      /** Opens every folder on the way to path ('a/b/c' opens 'a', 'a/b' and any joined row holding them). */
      reveal(path) { let changed = false; for (const c of [...closed]) if (path === c || path.startsWith(`${c}/`)) { closed.delete(c); changed = true; } if (changed) this.toggle(path, true); return changed; },
    };
  }

  /** The styles a page needs for the list (each page adds them once; a lent column carries them into its shadow root). */
  const css = `.tree-folder { display: flex; width: 100%; gap: 6px; align-items: baseline; background: none; border: 0; color: var(--dim, #8a93a6); font: inherit; font-size: 11px; text-align: left; padding: 6px 4px 3px; margin: 0; cursor: pointer; border-radius: 4px; }
.tree-folder:hover { color: var(--ink, #d8dee9); } .tree-folder:focus-visible { outline: 1px solid var(--accent, #ffb366); }
.tree-count { margin-left: auto; opacity: .7; } .tree-kids { margin-left: 10px; } .tree-kids[hidden] { display: none; }`;

  globalThis.nfTree = { build, render, store, css };
})();
