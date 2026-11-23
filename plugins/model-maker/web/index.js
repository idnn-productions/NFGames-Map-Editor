// New model, the page part: a tab with three steps (concept, views, model). The command opens it, on a draft or new.
import { createScreen } from './steps.js';

export function activate(api) {
  if (!document.getElementById('mm-style')) document.head.append(Object.assign(document.createElement('link'), { id: 'mm-style', rel: 'stylesheet', href: `/p/${api.id}/web/style.css` }));
  // what a draft's tab should do as it opens (the first Generate of a new draft makes the draft, then reopens as its tab)
  const first = new Map();
  const open = ({ slug = null, name = null, then = null } = {}) => {
    if (slug && then) first.set(slug, then);
    return api.documents.open({ title: slug ? `New model: ${name || slug}` : 'New model', editor: 'new-model', uri: slug ? `draft:${slug}` : 'draft:' });
  };
  api.commands.register('new-model', (args) => open(args && typeof args === 'object' ? args : {}));
  api.editors.register('new-model', (el, doc) => {
    const slug = doc.uri && doc.uri.startsWith('draft:') ? doc.uri.slice(6) || null : null;
    const then = slug ? first.get(slug) : null; if (slug) first.delete(slug);
    return createScreen({ el, api, doc, slug, then, reopen: (draft, next) => { api.documents.close(doc.id); open({ slug: draft.slug, name: draft.name, then: next }); } });
  });
}
