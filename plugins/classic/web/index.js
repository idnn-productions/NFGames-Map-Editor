// The map editor and the model viewer as workbench tabs: each page in a frame, until they are rebuilt as plugins. The
// top bar's views open them; each page lends its left column to the side panel while its tab is shown.
export function activate(api) {
  const open = (title, uri) => api.documents.open({ title, editor: 'frame', uri });
  api.commands.register('open-map', () => open('Map editor', '/map'));
  api.commands.register('open-viewer', () => open('Model viewer', '/viewer'));
  api.editors.register('frame', (el, doc) => {
    el.classList.add('frame');
    const f = document.createElement('iframe'); f.src = doc.uri; f.title = doc.title; el.append(f);
    // the page's left column can be lent once it has loaded: the workbench asks for it again
    f.addEventListener('load', () => document.dispatchEvent(new CustomEvent('nf:panel')));
    // the map's unsaved changes show on its tab and on Map editor in the bar
    let dirty = false;
    const watch = setInterval(() => {
      let now = false; try { now = !!f.contentWindow?.__map?.isDirty?.(); } catch { /* not loaded yet */ }
      if (now !== dirty) { dirty = now; api.documents.setDirty(doc.id, now); }
    }, 1000);
    return () => clearInterval(watch);
  });
}
