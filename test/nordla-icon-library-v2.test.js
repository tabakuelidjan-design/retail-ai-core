// Nordla icon library V2 (src/shared/assets/nordla/library/catalog.json): ONE catalogue for the V1 official pack (in production,
// unchanged) and the two V2 deliveries. Guards: every referenced file exists and is the byte-identical copy of the inspected source
// (no pixel touched), only files that passed the technical inspection live under the served library folder, files to correct are kept
// as references outside it, the 11 categories are used, and no production screen or the registry uses a V2 icon before validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const LIB = join(ROOT, 'src/shared/assets/nordla/library');
const cat = JSON.parse(readFileSync(join(LIB, 'catalog.json'), 'utf8'));
const sha16 = (p) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex').slice(0, 16);
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const png = (p) => { const b = readFileSync(join(ROOT, p)); return { sig: b.subarray(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }; };

test('catalogue: 11 categories, unique canonical ids, each function has a French label, a category, modules and both statuses', () => {
  assert.deepEqual(Object.keys(cat.categories), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
  const ids = [...cat.functions, ...cat.v1_without_v2_equivalent].map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const f of cat.functions) {
    assert.match(f.id, /^[a-z0-9-]+$/); assert.ok(f.label && cat.categories[String(f.category)], f.id); assert.ok(f.modules.length, `${f.id} has modules`);
    assert.ok(['conforme', 'a-corriger', 'absente'].includes(f.technical_quality), f.id); assert.ok(['en-attente', 'non-applicable'].includes(f.graphic_validation), f.id);
    if (f.file) { assert.equal(f.technical_quality, 'conforme'); assert.equal(f.graphic_validation, 'en-attente', 'a V2 icon is never declared graphically validated by the code'); }
  }
  for (const c of Object.keys(cat.categories)) assert.ok(cat.functions.some((f) => String(f.category) === c), `category ${c} used`);
});

test('files: retained V2 icons are byte-identical copies of inspected sources (256 px RGBA PNG); references to correct exist outside the served folder', () => {
  const served = new Set(walk(LIB).filter((f) => f.endsWith('.png')).map((f) => f.slice(ROOT.length)));
  const referenced = new Set(cat.functions.filter((f) => f.file).map((f) => f.file));
  assert.deepEqual([...served].sort(), [...referenced].sort(), 'the served library folder holds exactly the retained files, nothing else');
  let sources = 0;
  for (const f of cat.functions) for (const s of f.sources) {
    sources += 1;
    if (s.verdict === 'conforme' && s.retained) {
      assert.equal(sha16(s.library_path), s.sha256_16, `${s.library_path} is the untouched source file`);
      const p = png(s.library_path); assert.equal(p.sig, 'PNG'); assert.deepEqual([p.w, p.h, p.colorType], [256, 256, 6], `${s.library_path} 256x256 RGBA`);
    }
    if (s.verdict === 'a-corriger') {
      assert.ok(s.reasons.length, `${s.source}: a reason is recorded`); assert.ok(s.reference_path.startsWith('docs/design/nordla-icon-library-v2/reference/'), s.reference_path);
      assert.equal(sha16(s.reference_path), s.sha256_16, `${s.reference_path} untouched`);
      assert.ok(!served.has(s.reference_path), 'a file to correct is never in the served library');
    }
  }
  assert.equal(sources, 206, 'every received icon file is accounted for (76 lot 1 + 130 lot 2)');
});

test('V1 official pack stays the production set: registry unchanged, every V1 icon listed once, no screen uses a V2 icon yet', () => {
  const reg = readFileSync(join(ROOT, 'src/shared/nordla-icon.js'), 'utf8');
  const v1 = [...cat.functions.flatMap((f) => f.v1_official), ...cat.v1_without_v2_equivalent.flatMap((f) => f.v1_official)];
  assert.equal(v1.length, 46); assert.equal(new Set(v1.map((v) => v.key)).size, 46);
  for (const v of v1) { assert.ok(existsSync(join(ROOT, v.file)), v.file); assert.ok(reg.includes(`${v.key}: '${v.file.split('/').pop()}'`), `${v.key} is the registry entry`); }
  assert.doesNotMatch(reg, /library\//, 'the production registry does not reference V2 files');
  const ui = ['src/finance/ui', 'src/analytics-premium/ui', 'src/growth/ui', 'src/sourcing/ui', 'src/sourcing/nordla-ui', 'src/procurement/ui']
    .flatMap((d) => walk(join(ROOT, d))).filter((f) => /\.(js|html|css)$/.test(f));
  for (const f of ui) assert.doesNotMatch(readFileSync(f, 'utf8'), /nordla-assets\/library\//, `${f.slice(ROOT.length)} does not use a V2 icon before validation`);
});
