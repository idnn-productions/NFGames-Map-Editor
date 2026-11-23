// Today's map editor and model viewer inside the workbench, as they are, until sub-project 2 rebuilds them as plugins.
export function activate(api) {
  const open = (title, uri) => api.documents.open({ title, editor: 'frame', uri });
  const pages = { map: ['Map editor', '/map', 'The map editor as it is today: plans, the palette, the 3D view, Apply actions.'], viewer: ['Model viewer', '/viewer', 'The model viewer as it is today: models, pins, reference images, Send to Claude.'] };
  for (const [tool, [title, uri, text]] of Object.entries(pages)) {
    api.tools.register(tool, (el) => {
      const p = document.createElement('p'); p.className = 'nf-muted'; p.textContent = text;
      const b = document.createElement('nf-button'); b.setAttribute('variant', 'primary'); b.textContent = `Open the ${title.toLowerCase()}`; b.addEventListener('click', () => open(title, uri));
      el.append(p, b); open(title, uri);
    });
    api.commands.register(`open-${tool}`, () => open(title, uri));
  }
  api.editors.register('frame', (el, doc) => {
    el.classList.add('frame');
    const f = document.createElement('iframe'); f.src = doc.uri; f.title = doc.title; el.append(f);
  });
}
