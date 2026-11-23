// The workbench's logic, without a page: registries, keys, commands and the palette's ranking, the shared selection,
// open documents, and what the manifests contribute.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/shell/core/registry.js';
import { matches, parseKeys, showKeys } from '../src/shell/core/keys.js';
import { createCommands, rank } from '../src/shell/core/commands.js';
import { createSelection } from '../src/shell/core/selection.js';
import { createDocuments } from '../src/shell/core/documents.js';
import { contributionsOf } from '../src/shell/core/contributions.js';
import { lentFor } from '../src/shell/core/lent.js';

const ev = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('registries', () => {
  it('add, dispose, refuse duplicates, tell listeners', () => {
    const r = createRegistry(); let changes = 0; r.onChange(() => changes++);
    const a = r.add('x/a', 1); assert.equal(r.get('x/a'), 1); assert.throws(() => r.add('x/a', 2), /already registered/);
    a.dispose(); assert.equal(r.has('x/a'), false); a.dispose(); assert.equal(changes, 2);
  });
});
describe('keys', () => {
  it('Mod is ⌘ on a Mac and Ctrl elsewhere', () => {
    assert.ok(matches(parseKeys('Mod+K', { mac: true }), ev('k', { metaKey: true })));
    assert.ok(!matches(parseKeys('Mod+K', { mac: true }), ev('k', { ctrlKey: true })));
    assert.ok(matches(parseKeys('Mod+Shift+S'), ev('S', { ctrlKey: true, shiftKey: true })));
    assert.ok(matches(parseKeys('Esc'), ev('Escape'))); assert.ok(matches(parseKeys('Del'), ev('Delete')));
    assert.equal(showKeys(parseKeys('Mod+Shift+S', { mac: true }), { mac: true }), '⇧⌘S'); assert.equal(showKeys(parseKeys('Mod+K')), 'Ctrl+K');
    assert.throws(() => parseKeys('Mod+'), /no key/); assert.throws(() => parseKeys('A+B'), /two keys/);
  });
});
describe('commands', () => {
  it('a command of a plugin not loaded yet loads it first', async () => {
    const c = createCommands(); let loaded = false;
    c.declare('p.x/greet', { title: 'Say hello', load: async () => { loaded = true; c.handle('p.x/greet', (n) => `hello ${n}`); } });
    assert.equal(await c.execute('p.x/greet', 'there'), 'hello there'); assert.ok(loaded);
    await assert.rejects(c.execute('nope'), /no command nope/);
    c.declare('p.x/idle', { title: 'Idle' }); await assert.rejects(c.execute('p.x/idle'), /nothing handles it/);
  });
  it('the palette ranks typed letters in order, word starts and runs first', () => {
    const items = [{ title: 'Open project' }, { title: 'Save map' }, { title: 'Reload plugin' }, { title: 'Toggle bottom panel' }];
    assert.deepEqual(rank(items, 'op').map((r) => r.item.title).slice(0, 1), ['Open project']);
    assert.deepEqual(rank(items, 'sm').map((r) => r.item.title), ['Save map']);
    assert.equal(rank(items, 'zz').length, 0); assert.equal(rank(items, '').length, 4);
  });
});
describe('selection and documents', () => {
  it('one shared selection', () => {
    const s = createSelection(); const seen = []; s.on((x) => seen.push(x.type));
    s.set('nfgames.map/piece', [{ id: 'tower' }]); s.set('x', []); assert.deepEqual(seen, ['nfgames.map/piece', null]);
  });
  it('documents: open (or focus the same uri), close, dirty', () => {
    const d = createDocuments();
    const a = d.open({ title: 'plaza', editor: 'p.x/map', uri: 'plaza' }), b = d.open({ title: 'gate', editor: 'p.x/map', uri: 'gate' });
    assert.equal(d.open({ title: 'plaza', editor: 'p.x/map', uri: 'plaza' }).id, a.id); assert.equal(d.active().id, a.id);
    d.setDirty(b.id, true); assert.equal(d.list().find((x) => x.id === b.id).dirty, true);
    d.close(a.id); assert.equal(d.active().id, b.id); d.close(b.id); assert.equal(d.active(), null);
  });
});
describe('contributions', () => {
  it('only usable plugins, keyed by plugin and id, with their activation events', () => {
    const c = contributionsOf([
      { id: 'a.b', name: 'AB', state: 'ready', contributes: { tools: [{ id: 't', title: 'Tool', icon: 'T' }], commands: [{ id: 'go', title: 'Go', keys: 'Mod+G' }], panels: [{ id: 'p', region: 'weird' }], settings: { n: { type: 'number', default: 1 } } } },
      { id: 'c.d', name: 'CD', state: 'needs-trust', contributes: { tools: [{ id: 'x' }] } }]);
    assert.deepEqual(c.tools.map((t) => [t.key, t.event]), [['a.b/t', 'onTool:t']]);
    assert.equal(c.commands[0].category, 'AB'); assert.equal(c.panels[0].region, 'bottom'); assert.equal(c.settings[0].plugin, 'a.b');
  });
});

describe('what a framed page lends', () => {
  const frame = { side: { title: 'S' }, inspector: { title: 'I' }, bottom: { title: 'B', key: 'reviews' } };
  it('the side panel takes the page\'s part unless a tool is picked; the Inspector and the bottom panel always do', () => {
    assert.equal(lentFor('side', { activeTool: null, frame }), frame.side);
    assert.equal(lentFor('side', { activeTool: 'x/tool', frame }), null);
    assert.equal(lentFor('inspector', { activeTool: 'x/tool', frame }), frame.inspector);
    assert.equal(lentFor('bottom', { activeTool: null, frame }), frame.bottom);
  });
  it('nothing is lent without a frame, or for a region the page keeps', () => {
    assert.equal(lentFor('bottom', { activeTool: null, frame: null }), null);
    assert.equal(lentFor('inspector', { activeTool: null, frame: { side: frame.side } }), null);
  });
});
