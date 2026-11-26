// Where Blender is. It is an optional external program, like ComfyUI: the editor itself needs nothing installed to run.
// Used by the reference-match scorer (src/match.mjs). The model service plugin keeps its own copy of findBlender: a plugin is
// self-contained (it is copied elsewhere when installed), so it cannot import from here.
import { existsSync, readdirSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const BLENDER_DOWNLOAD = 'https://www.blender.org/download/';

/** Where Blender is: the setting when it names a file; else on the PATH; else where it is usually installed. Or null. */
export function findBlender(setting, { env = process.env, platform = process.platform, exists = existsSync, list = (d) => readdirSync(d) } = {}) {
  if (typeof setting === 'string' && setting.trim()) return exists(setting.trim()) ? setting.trim() : null;
  const path = platform === 'win32' ? win32 : posix, names = platform === 'win32' ? ['blender.exe'] : ['blender', 'Blender'];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')) for (const n of names) if (dir && exists(path.join(dir, n))) return path.join(dir, n);
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      const home = win32.join(base, 'Blender Foundation'); let versions = [];
      try { versions = list(home).filter((n) => /^Blender/i.test(n)); } catch { /* not installed there */ }
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));   // the newest first
      for (const v of versions) if (exists(win32.join(home, v, 'blender.exe'))) return win32.join(home, v, 'blender.exe');
    }
  } else if (platform === 'darwin' && exists('/Applications/Blender.app/Contents/MacOS/Blender')) return '/Applications/Blender.app/Contents/MacOS/Blender';
  return null;
}

