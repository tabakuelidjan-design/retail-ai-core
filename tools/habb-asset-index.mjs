// Builds the LOCAL HABB asset index (read-only on the source folders). Output goes to data/private/habb-assets/ (git-ignored: the repository is public).
// usage: node tools/habb-asset-index.mjs <namespace=folder> [<namespace=folder> ...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { indexFolder } from '../src/asset-library/indexer.js';

const OUT = new URL('../data/private/habb-assets/', import.meta.url);
const specs = process.argv.slice(2).map((a) => a.split(/=(.+)/));
if (specs.length === 0 || specs.some((s) => s.length < 2)) {
  console.error('usage: node tools/habb-asset-index.mjs <namespace=folder> ...');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const all = [];
const report = [];
const hashes = new Set();
for (const [namespace, folder] of specs) {
  const { entries, skipped, duplicates } = indexFolder(folder, { namespace });
  const fresh = entries.filter((e) => !hashes.has(e.content_hash));
  fresh.forEach((e) => hashes.add(e.content_hash));
  all.push(...fresh);
  report.push({ namespace, indexed: fresh.length, cross_folder_duplicates: entries.length - fresh.length, in_folder_duplicates: duplicates.length, skipped: skipped.length });
}
const byOrigin = {};
for (const e of all) byOrigin[e.origin_class] = (byOrigin[e.origin_class] ?? 0) + 1;
writeFileSync(new URL('index.json', OUT), `${JSON.stringify({ generated_by: 'tools/habb-asset-index.mjs', count: all.length, entries: all }, null, 1)}\n`);
console.log(JSON.stringify({ report, total: all.length, by_origin_class: byOrigin }, null, 1));
