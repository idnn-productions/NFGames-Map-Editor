// Project-relative globs ("models/**", ".review/**", "art/*.glb", "**/*.json") as RegExps over '/'-separated paths.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { const slash = glob[i + 2] === '/'; re += slash ? '(?:.*/)?' : '.*'; i += slash ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));
