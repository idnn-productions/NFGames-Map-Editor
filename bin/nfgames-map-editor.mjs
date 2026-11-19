#!/usr/bin/env node
// nfgames-map-editor [map] [--project <dir>] [--config <file>] [--port <n>] [--dry-run]
//
//   --project <dir>   the project whose maps to edit (default: the current folder); its map-editor.config.mjs is read
//   --config <file>   a config file somewhere else (default: <project>/map-editor.config.mjs, when there is one)
//   --port <n>        the port on 127.0.0.1 (default: the config's `port`, else MAP_EDIT_PORT, else 8793)
//   --dry-run         Apply actions' heavy steps only print what they would run
//   map               the map the page opens first (default: the config's `defaultMap`, else the first map)
import { loadProject } from '../src/project.mjs';
import { createEditor, HOST } from '../src/server.mjs';

const USAGE = 'usage: nfgames-map-editor [map] [--project <dir>] [--config <file>] [--port <n>] [--dry-run]';
const args = process.argv.slice(2), value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const takesValue = new Set(['--project', '--config', '--port']);
const loose = args.filter((a, i) => !a.startsWith('--') && !takesValue.has(args[i - 1]));
const unknown = args.filter((a) => a.startsWith('--') && !takesValue.has(a) && a !== '--dry-run');
if (unknown.length || loose.length > 1) { console.error(`map editor: ${unknown.length ? `unknown option ${unknown[0]}` : 'one map name at most'}\n${USAGE}`); process.exit(2); }

let project;
try { project = await loadProject({ root: value('--project') || process.cwd(), config: value('--config') }); } catch (e) { console.error(`map editor: ${e.message}`); process.exit(1); }
const port = Number(value('--port') || process.env.MAP_EDIT_PORT || project.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error(`map editor: not a port: ${value('--port') || process.env.MAP_EDIT_PORT}`); process.exit(2); }
const dryRun = args.includes('--dry-run');
const maps = project.listMaps(), wanted = loose[0] || project.defaultMap || maps[0];
if (!wanted || !project.knownMap(wanted)) {
  console.error(`map editor: ${wanted ? `no map called ${JSON.stringify(wanted)}` : 'no maps yet'} in ${project.mapsDir} (maps: ${maps.join(', ') || 'none'}). A map is <maps>/<name>/layout.json.`);
  process.exit(1);
}
const server = createEditor(project, { port, defaultMap: wanted, dryRun });
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `map editor: port ${port} is in use (another editor?). Start this one with --port ${port + 1}.` : `map editor: ${e.message}`);
  process.exit(1);
});
server.listen(port, HOST, () => {
  console.log(`map editor (${wanted}${dryRun ? ', dry run' : ''}): http://127.0.0.1:${port}/   saves to ${project.rel(project.planFile(wanted))}${project.configFile ? `   config: ${project.rel(project.configFile) || project.configFile}` : '   (no config file: defaults)'}`);
});
