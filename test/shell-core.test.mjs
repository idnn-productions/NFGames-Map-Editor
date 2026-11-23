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
import { createProblems } from '../src/shell/core/problems.js';
import { DEFAULTS, clampWidths, readLayout, writeLayout } from '../src/shell/core/layout.js';

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

describe('problems, from plugins and from the shown page', () => {
  it('a source sets its list, clears it, and is dropped; clicking one goes to it', () => {
    const p = createProblems(); let changes = 0, went = null; p.on(() => changes++);
    p.set('map', [{ kind: 'door', text: 'x' }, { kind: 'fit', text: 'y' }], (i) => { went = i; });
    p.set('nfgames.hello', [{ kind: 'hello', text: 'z' }]);
    assert.equal(p.count(), 3);
    assert.deepEqual(p.all().map((x) => [x.source, x.kind, x.text]), [['map', 'door', 'x'], ['map', 'fit', 'y'], ['nfgames.hello', 'hello', 'z']]);
    p.go(p.all()[1]); assert.equal(went, 1);
    p.go(p.all()[2]);   // a source with nowhere to go: nothing happens
    p.set('map', []); assert.equal(p.count(), 1);
    p.drop('nfgames.hello'); assert.equal(p.count(), 0); assert.equal(changes, 4);
  });
  it('a list that is not one is no problems', () => {
    const p = createProblems(); p.set('map', null); assert.equal(p.count(), 0);
  });
});

describe('the workbench\'s layout', () => {
  it('widths are kept as set when they fit', () => {
    assert.deepEqual(clampWidths({ side: 260, inspector: 280 }, 1440), { side: 260, inspector: 280 });
  });
  it('a panel is at least 200 px, and the documents keep 320', () => {
    assert.deepEqual(clampWidths({ side: 100, inspector: 900 }, 1440), { side: 200, inspector: 874 });
    const w = clampWidths({ side: 500, inspector: 500 }, 1024);
    assert.ok(w.side >= 200 && w.inspector >= 200 && 1024 - 46 - w.side - w.inspector >= 320, JSON.stringify(w));
  });
  it('a window too narrow for both panels gives up the Inspector', () => {
    assert.deepEqual(clampWidths({ side: 260, inspector: 280 }, 700), { side: 200, inspector: 0 });
  });
  it('numbers that are not numbers fall back to the defaults', () => {
    assert.deepEqual(clampWidths({ side: 'x', inspector: undefined }, 1440), { side: DEFAULTS.side, inspector: DEFAULTS.inspector });
  });
  it('the bottom panel rests as a strip unless it was opened; what was kept before is read', () => {
    assert.deepEqual(readLayout('not json'), DEFAULTS); assert.deepEqual(readLayout(null), DEFAULTS);
    assert.deepEqual(DEFAULTS.hidden, ['bottom']);
    assert.deepEqual(readLayout('["bottom"]').hidden, ['bottom']);
    assert.deepEqual(readLayout('["side"]').hidden.sort(), ['bottom', 'side']);   // the old list of hidden panels: the bottom was open by default then
    const kept = readLayout(writeLayout({ hidden: ['inspector'], side: 300, inspector: 400 }));
    assert.deepEqual(kept, { hidden: ['inspector'], side: 300, inspector: 400 });
    assert.deepEqual(readLayout('{"hidden":["nonsense","side"],"side":"wide"}'), { hidden: ['side'], side: 260, inspector: 280 });
  });
});
