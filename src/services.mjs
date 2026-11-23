// Services: what plugins can do for the user and for agents (generate an image, a voice line…), run in the editor with
// keys from the vault and under the spend guard. Declared in plugin.json ("services"), provided by the plugin's server
// part (api.services.provide). Neither the page nor an agent ever sees a key.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const onPath = (command, env = process.env) => typeof command === 'string' && /^[A-Za-z0-9._-]+$/.test(command) && (env.PATH || '').split(delimiter).some((d) => d && existsSync(join(d, command)));
export const keyName = (plugin, service, name) => `${plugin}.${service}.${name}`;
const fail = (code, text) => { throw Object.assign(new Error(text), { code }); };

export function createServices({ listPlugins, activate, providers, vault, spend, events }) {
  function list() {
    const out = [];
    for (const p of listPlugins()) {
      if (!['ready', 'active'].includes(p.state)) continue;
      for (const s of p.contributes?.services || []) {
        const key = `${p.id}/${s.id}`;
        const needs = (s.needs || []).map((n) => ({ kind: n.kind, name: n.name || null, command: n.command || null, help: n.help || '',
          ok: n.kind === 'cli' ? onPath(n.command) : n.kind === 'key' ? vault.has(keyName(p.id, s.id, n.name)) : false }));
        out.push({ key, plugin: p.id, id: s.id, title: s.title || s.id, summary: s.summary || '', provider: s.provider || p.name, needs, connected: needs.every((n) => n.ok),
          actions: (s.actions || []).map((a) => ({ id: a.id, title: a.title || a.id, cost: a.cost || null })), spent: spend.spent(key), budget: spend.budget(key) });
      }
    }
    return out;
  }
  const find = (key) => list().find((s) => s.key === key) || fail(404, `no such service: ${key}`);
  function connect(key, name, value) {
    const s = find(key);
    if (!s.needs.some((n) => n.kind === 'key' && n.name === name)) fail(400, `${s.title} does not take a key called ${name}`);
    vault.set(keyName(s.plugin, s.id, name), value);
    events.emit('services/changed', { key });
    return find(key);
  }
  function disconnect(key) {
    const s = find(key);
    for (const n of s.needs) if (n.kind === 'key') vault.delete(keyName(s.plugin, s.id, n.name));
    events.emit('services/changed', { key });
    return find(key);
  }
  function setBudget(key, amount) { find(key); spend.setBudget(key, amount); return find(key); }
  /** Runs an action: { ok, result }, or { needsConfirm, reason, estimate } when the spend guard wants the user's yes. */
  async function call(key, action, input = {}, { confirmed = false, by = 'you' } = {}) {
    const s = find(key), a = s.actions.find((x) => x.id === action) || fail(404, `${s.title} has no action ${action}`);
    if (!s.connected) fail(409, `${s.title} is not connected: ${s.needs.filter((n) => !n.ok).map((n) => n.help || n.name || n.command).join('; ')}`);
    const estimate = a.cost?.estimate || 0, verdict = spend.check(key, estimate);
    if (verdict.confirm && !confirmed) return { needsConfirm: true, reason: verdict.confirm, estimate, service: s.title, action: a.title, by };
    await activate(s.plugin);
    const fn = providers.get(`${key}/${action}`) || fail(500, `${s.plugin} does not provide ${action}`);
    events.emit('services/started', { key, action, title: `${s.title}: ${a.title}`, by });
    try {
      const result = await fn(input && typeof input === 'object' ? input : {}, { secret: (name) => vault.get(keyName(s.plugin, s.id, name)) });
      spend.record(key, typeof result?.cost === 'number' ? result.cost : estimate);
      events.emit('services/done', { key, action, title: `${s.title}: ${a.title}`, by, ok: true });
      events.emit('services/changed', { key });
      return { ok: true, result };
    } catch (e) { events.emit('services/done', { key, action, title: `${s.title}: ${a.title}`, by, ok: false, error: e.message, ...(typeof e.folder === 'string' ? { folder: e.folder } : {}) }); throw e; }
  }
  return { list, connect, disconnect, setBudget, call };
}
