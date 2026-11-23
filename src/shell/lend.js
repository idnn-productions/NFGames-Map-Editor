// A page shown as a workbench tab (the map editor, the model viewer) lends parts of itself to the workbench's regions
// while its tab is shown: its left column to the side panel, what it says about the selection to the Inspector, a list
// to the bottom panel. A part moves into a shadow root in the workbench's page, taking the page's styles with it (and
// keeping them from leaking into the workbench), and moves back home when the region shows something else. The two
// pages share an origin, so a moved element keeps its listeners and the page's code keeps driving it: the page finds
// its moved elements with byId(), as getElementById no longer sees them.
// A classic script (the map editor has no modules): it sets window.nfLend.
//   nfLend({ side: { el, title, css? }, inspector: { el, title, css? }, bottom: { el, title, key, css? } }) → { byId, setTitle }
window.nfLend = function nfLend(parts) {
  const roots = new Map();   // region → the shadow root its part is shown in
  const lent = {};
  for (const [region, { el, title, key, css = '' }] of Object.entries(parts)) {
    if (!el) continue;
    const home = el.parentNode, next = el.nextSibling;
    lent[region] = {
      title, key,
      /** Shows the part in `host`, an element of the workbench's page. */
      mount(host) {
        const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
        const own = host.ownerDocument.createElement('style');
        // the page's rules, with its :root tokens moved onto the shadow host, then what the part needs there
        own.textContent = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n').replace(/:root\b/g, ':host')
          + `\n:host { display: block; height: 100%; } #${el.id} { height: 100%; border: 0; overflow-y: auto; box-sizing: border-box; }\n${css}`;
        root.replaceChildren(own, el); roots.set(region, root);
        document.body.classList.add(`lent-${region}`); dispatchEvent(new Event('resize'));   // the page's main area just grew
      },
      /** Takes the part back into the page. */
      unmount() {
        if (!roots.has(region)) return;
        home.insertBefore(el, next && next.parentNode === home ? next : null);
        roots.delete(region);
        document.body.classList.remove(`lent-${region}`); dispatchEvent(new Event('resize'));
      },
    };
  }
  window.__nfLent = lent;
  return {
    byId(id) { for (const root of roots.values()) { const e = root.getElementById(id); if (e) return e; } return null; },
    /** Renames a lent part (the Inspector's "Map" becomes "Selected"); the workbench shows it without moving anything. */
    setTitle(region, title) {
      if (!lent[region] || lent[region].title === title) return;
      lent[region].title = title;
      try { window.top.document.dispatchEvent(new CustomEvent('nf:title')); } catch { /* not in the workbench */ }
    },
  };
};
// until the pages lend more than their left column
window.nfLendPanel = (aside, opts) => { const l = window.nfLend({ side: { el: aside, ...opts } }); window.__nfPanel = window.__nfLent.side; return l; };
