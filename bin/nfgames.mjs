#!/usr/bin/env node
// nfgames plugin list | add <npm spec | git url[#commit]> | install | update <id> | remove <id>   [--project <dir>]
//
//   list      every plugin the project sees, where it comes from, and its state
//   add       install a shared plugin and pin its exact version (npm: SHA-512; git: commit) in the project's nfgames.json
//   install   install every pinned plugin that is not in ~/.nfgames-editor/packages yet (after a fresh checkout)
//   update    the newest version of a pinned npm plugin, or the newest commit of a git one; shows old → new
//   remove    unpin it (the cached copy stays for other projects)
import { join, resolve } from 'node:path';
import { HOME } from '../src/home.mjs';
import { EDITOR_ROOT } from '../src/project.mjs';
import { discoverPlugins, readProjectPlugins } from '../src/plugins/sources.mjs';
import { installGit, installMissing, installNpm, pin, unpin } from '../src/plugins/install.mjs';

const USAGE = 'usage: nfgames plugin list | add <npm spec | git url[#commit]> | install | update <id> | remove <id>  [--project <dir>]';
const args = process.argv.slice(2), at = args.indexOf('--project'), root = resolve(at >= 0 ? args[at + 1] : process.cwd());
const [group, verb, arg] = args.filter((a, i) => i !== at && i !== at + 1);
const state = join(HOME, '.nfgames-editor'), packagesDir = join(state, 'packages');
const isGit = (s) => /^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(s) || s.endsWith('.git');

try {
  if (group !== 'plugin' || !verb) { console.log(USAGE); process.exit(group ? 2 : 0); }
  if (verb === 'list') {
    for (const p of discoverPlugins({ builtinDir: join(EDITOR_ROOT, 'plugins'), userDir: join(state, 'plugins'), packagesDir, root }))
      console.log(`${p.id.padEnd(32)} ${(p.manifest?.version || '-').padEnd(9)} ${p.source.padEnd(8)} ${p.errors.length ? p.errors.join('; ') : p.compatible ? 'ok' : `needs editor ${p.manifest?.engines?.nfgames}`}`);
  } else if (verb === 'add' && arg) {
    const got = isGit(arg) ? installGit(packagesDir, { git: arg.split('#')[0], commit: arg.split('#')[1] || null }) : await installNpm(packagesDir, { npm: arg });
    pin(root, got.id, got.spec);
    console.log(`added ${got.id} ${got.manifest.version} (${got.spec.npm || `${got.spec.git} @ ${got.spec.commit.slice(0, 12)}`}), pinned in nfgames.json`);
  } else if (verb === 'install') {
    const done = await installMissing(root, packagesDir);
    console.log(done.length ? `installed ${done.join(', ')}` : 'everything pinned is installed');
  } else if (verb === 'update' && arg) {
    const old = readProjectPlugins(root)[arg];
    if (!old || typeof old !== 'object') throw new Error(`${arg} is not an npm or git plugin of this project`);
    const got = old.npm ? await installNpm(packagesDir, { npm: old.npm.slice(0, old.npm.lastIndexOf('@')) }) : installGit(packagesDir, { git: old.git });
    pin(root, arg, got.spec);
    console.log(`${arg}: ${old.npm || old.commit.slice(0, 12)} → ${got.spec.npm || got.spec.commit.slice(0, 12)}`);
  } else if (verb === 'remove' && arg) { unpin(root, arg); console.log(`removed ${arg} from nfgames.json`); }
  else { console.error(USAGE); process.exit(2); }
} catch (e) { console.error(`nfgames: ${e.message}`); process.exit(1); }
