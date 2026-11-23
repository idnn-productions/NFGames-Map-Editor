// One switch for every grid: the map's (from above and in 3D) and the model viewer's floor. It is kept in this
// browser, so the workbench and each tab's page (same origin) read the same value, and a change in one reaches the
// others: through the storage event in the other pages, through nf:grid in the page that made it.
// A classic script (the map editor has no modules): it sets window.nfGrid.
(() => {
  const KEY = 'nfgames.grid';
  let on = true;
  try { on = localStorage.getItem(KEY) !== 'off'; } catch { /* storage blocked: grids stay on */ }
  const tell = () => dispatchEvent(new CustomEvent('nf:grid', { detail: on }));
  addEventListener('storage', (e) => { if (e.key === KEY) { on = e.newValue !== 'off'; tell(); } });
  window.nfGrid = {
    get: () => on,
    set(value) {
      if (!!value === on) return;
      on = !!value;
      try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* not kept: this page still follows */ }
      tell();
    },
    toggle() { this.set(!on); },
    /** Calls fn(on) whenever the switch changes, here or in another page. */
    onChange(fn) { const h = (e) => fn(e.detail); addEventListener('nf:grid', h); return () => removeEventListener('nf:grid', h); },
  };
})();
