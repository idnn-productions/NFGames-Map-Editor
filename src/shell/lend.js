// A page shown as a workbench tab (the map editor, the model viewer) lends its left column to the workbench's side
// panel while its tab is shown. The column moves into a shadow root in the workbench's page, taking the page's styles
// with it (and keeping them from leaking into the workbench), and moves back home when another tab or tool takes the side
// panel. The two pages share an origin, so a moved element keeps its listeners and the page's code keeps driving it:
// the page finds its moved elements with byId(), as getElementById no longer sees them.
// A classic script (the map editor has no modules): it sets window.nfLendPanel.
window.nfLendPanel = function nfLendPanel(aside, { title, css = '' }) {
  const home = aside.parentNode, next = aside.nextSibling;
  let root = null;
  const panel = {
    title,
    /** Shows the column in `host`, an element of the workbench's page. */
    mount(host) {
      root = host.shadowRoot || host.attachShadow({ mode: 'open' });
      const own = host.ownerDocument.createElement('style');
      // the page's rules, with its :root tokens moved onto the shadow host, then what the column needs there
      own.textContent = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n').replace(/:root\b/g, ':host')
        + `\n:host { display: block; height: 100%; } #${aside.id} { height: 100%; border: 0; overflow-y: auto; box-sizing: border-box; }\n${css}`;
      root.replaceChildren(own, aside);
      document.body.classList.add('lent'); dispatchEvent(new Event('resize'));   // the page's main area just grew
    },
    /** Takes the column back into the page. */
    unmount() {
      if (!root) return;
      home.insertBefore(aside, next && next.parentNode === home ? next : null);
      root = null;
      document.body.classList.remove('lent'); dispatchEvent(new Event('resize'));
    },
    byId: (id) => (root ? root.getElementById(id) : null),
  };
  window.__nfPanel = panel;
  return panel;
};
