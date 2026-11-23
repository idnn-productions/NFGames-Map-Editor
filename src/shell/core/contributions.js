// What the workbench shows before any plugin code runs, built from the manifests the host lists (/api/plugins).
export const USABLE = ['ready', 'active'];

export function contributionsOf(plugins) {
  const out = { tools: [], panels: [], commands: [], editors: [], inspectors: [], statusItems: [], settings: [] };
  for (const p of plugins) {
    if (!USABLE.includes(p.state)) continue;
    const c = p.contributes || {}, key = (x) => `${p.id}/${x.id}`, base = (x) => ({ key: key(x), plugin: p.id, id: x.id, title: x.title || x.id });
    for (const t of c.tools || []) out.tools.push({ ...base(t), icon: t.icon || '◇', event: `onTool:${t.id}` });
    for (const x of c.panels || []) out.panels.push({ ...base(x), region: ['side', 'inspector', 'bottom'].includes(x.region) ? x.region : 'bottom', event: `onPanel:${x.id}` });
    for (const x of c.commands || []) out.commands.push({ ...base(x), keys: x.keys || null, category: p.name, event: `onCommand:${x.id}` });
    for (const x of c.editors || []) out.editors.push({ ...base(x), files: x.files || [], event: `onEditor:${x.id}` });
    for (const x of c.inspectors || []) out.inspectors.push({ ...base(x), for: x.for || null, event: `onInspector:${x.id}` });
    for (const x of c.statusItems || []) out.statusItems.push({ ...base(x), align: x.align === 'left' ? 'left' : 'right' });
    if (c.settings && Object.keys(c.settings).length) out.settings.push({ plugin: p.id, name: p.name, schema: c.settings });
  }
  return out;
}
