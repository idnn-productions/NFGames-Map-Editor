// What the tests share: the sample project, copied to a temporary folder when a test writes.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLE = join(REPO, 'examples', 'sample');
export const samplePlan = () => JSON.parse(readFileSync(join(SAMPLE, 'maps', 'plaza', 'layout.json'), 'utf8'));
export const samplePlants = () => JSON.parse(readFileSync(join(SAMPLE, 'maps', 'plaza', 'plants.json'), 'utf8'));

/** A copy of the sample project in a temporary folder: { root, done() }. */
export function sampleCopy() {
  const root = mkdtempSync(join(tmpdir(), 'nfgames-map-editor-'));
  cpSync(SAMPLE, root, { recursive: true, filter: (src) => !/[\\/]out([\\/]|$)|\.prev\.json$/.test(src) });
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
