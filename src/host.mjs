// The editor as a library: open a project and get its server, with its plugins started. An engine's dev server can use
// this to run the editor in its own process (mounting it under a path prefix is sub-project 4).
import { loadProject } from './project.mjs';
import { createEditor, HOST } from './server.mjs';

export async function createHost({ root = process.cwd(), port, config, ...options } = {}) {
  const project = await loadProject({ root, config });
  const at = port ?? project.port;
  const server = createEditor(project, { port: at, ...options });
  await server.ready;
  return {
    server,
    get project() { return server.project; },
    get plugins() { return server.plugins; },
    listen: (p = at) => new Promise((ok, no) => { server.once('error', no); server.listen(p, HOST, () => ok(server)); }),
  };
}
