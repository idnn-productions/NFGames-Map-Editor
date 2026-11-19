// The sample project's Apply action: counts a saved map's pieces by kind into out/<map>.summary.json.
//   node tools/report.mjs <map>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name || '')) { console.error('usage: node tools/report.mjs <map>'); process.exit(2); }
const text = readFileSync(join(root, 'maps', name, 'layout.json'), 'utf8'), plan = JSON.parse(text);
const kinds = {};
for (const p of [...plan.pieces, ...(plan.marks || [])]) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
const summary = { map: name, stamp: createHash('sha256').update(text).digest('hex').slice(0, 16), pieces: plan.pieces.length, kinds };
mkdirSync(join(root, 'out'), { recursive: true });
writeFileSync(join(root, 'out', `${name}.summary.json`), JSON.stringify(summary, null, 2) + '\n');
for (const [kind, n] of Object.entries(kinds)) console.log(`${String(n).padStart(3)}  ${kind}`);
console.log(`${name}: ${plan.pieces.length} pieces -> out/${name}.summary.json`);
