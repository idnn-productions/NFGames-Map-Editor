// Keys for services, kept out of projects, the page and agents: in the macOS Keychain (the `security` tool run
// directly, one command on its standard input, the secret as hex, never on a command line), elsewhere in
// ~/.nfgames-editor/secrets.json, readable by its owner only. Plugins never see the vault: a provider gets a function
// that reads its own service's keys.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^[A-Za-z0-9._:-]{1,120}$/, ACCOUNT = 'nfgames';

export function createVault({ stateDir, securityBin = process.platform === 'darwin' ? '/usr/bin/security' : null } = {}) {
  const file = join(stateDir, 'secrets.json'), keychain = !!securityBin && existsSync(securityBin);
  const check = (name) => { if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`not a key name: ${name}`); };
  const security = (line) => execFileSync(securityBin, ['-i'], { input: `${line}\n`, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  const plainly = (e) => String((e.stderr && e.stderr.toString()) || e.message).split('\n').find((l) => /security:|returned/.test(l))?.replace(/^security:\s*/, '') || e.message;
  const readFile = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const writeFile = (all) => { mkdirSync(stateDir, { recursive: true }); writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 }); chmodSync(file, 0o600); };
  return {
    where: keychain ? 'the macOS Keychain' : file,
    set(name, value) {
      check(name);
      if (typeof value !== 'string' || !value) throw new Error('a key is some text');
      if (keychain) { try { security(`add-generic-password -U -a ${ACCOUNT} -s nfgames:${name} -X ${Buffer.from(value, 'utf8').toString('hex')}`); } catch (e) { throw new Error(`Could not save the key in the macOS Keychain: ${plainly(e)}`); } return; }
      const all = readFile(); all[name] = value; writeFile(all);
    },
    get(name) {
      check(name);
      if (!keychain) return readFile()[name] ?? null;
      try { const out = security(`find-generic-password -a ${ACCOUNT} -s nfgames:${name} -w`).replace(/\n$/, ''); return out || null; } catch { return null; }
    },
    has(name) { return this.get(name) !== null; },
    delete(name) {
      check(name);
      if (keychain) { try { security(`delete-generic-password -a ${ACCOUNT} -s nfgames:${name}`); } catch { /* not there */ } return; }
      const all = readFile(); delete all[name]; writeFile(all);
    },
  };
}
