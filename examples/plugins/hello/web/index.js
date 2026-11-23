// The sample plugin's page part: a tool with a side panel, a bottom panel, a command and a status item.
export function activate(api) {
  api.tools.register('hello', (el) => {
    const out = document.createElement('p'); out.textContent = 'Asking the server…';
    const say = document.createElement('nf-button'); say.textContent = 'Say hello'; say.addEventListener('click', () => api.commands.execute('greet'));
    const count = document.createElement('nf-button'); count.textContent = 'Count to three (a job)';
    count.addEventListener('click', () => api.fetch('/count', { method: 'POST', body: '{}' }).then(() => api.ui.toast('Counting: see Jobs below')).catch((e) => api.ui.toast(e.message, 'error')));
    el.append(out, say, count);
    api.fetch('/greeting').then((g) => { out.textContent = g.text; });
  });
  api.panels.register('log', (el) => {
    const pre = document.createElement('pre'); pre.className = 'nf-log'; pre.textContent = 'Events from the editor appear here.\n'; el.append(pre);
    const sub = api.events.on('*', (name, data) => { pre.textContent += `${name} ${JSON.stringify(data)}\n`; });
    return () => sub.dispose();
  });
  api.commands.register('greet', async () => api.ui.toast((await api.fetch('/greeting')).text));
  api.statusItems.register('greeting', (el) => { el.textContent = '👋 hello'; el.title = 'from the sample plugin'; });
}
