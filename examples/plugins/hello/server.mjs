// The sample plugin's server part: a route, a file it may write, a job, and a check. Plan 1B adds its web part.
export function activate(api) {
  api.routes.get('/greeting', () => ({ text: `${api.settings.get('greeting')} from ${api.project.name}` }));
  api.routes.post('/note', ({ body }) => { api.files.write('.hello/note.txt', String(body.text || '')); return { saved: '.hello/note.txt' }; });
  api.routes.post('/count', () => api.jobs.run('Count to three', [1, 2, 3].map((n) => ({ label: `step ${n}`, run: (log) => log(`${n}\n`) }))).job);
  api.hooks.on('check', ({ name }) => (name ? [] : [{ kind: 'hello', text: 'no map open', sel: [], at: null }]));
}
