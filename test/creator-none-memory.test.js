// THE MEMORY OF CREATOR'S NONE: the same product is not asked again while the facts and the brief are identical; a change of either makes it askable again. OFFLINE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factsFingerprint, briefFingerprint, noneStatus, recordNone, readNoneMemory, createNoneMemory } from '../src/creative-autonomy/none-memory.js';
import { loadAdProducts } from '../src/creative-autonomy/ad-products.js';

const claims = ['Sa connexion Bluetooth 6.0', 'sa molette multifonction']; const variants = [{ id: 'v1', title: 'Bleu', price: '34.90', inventoryQuantity: 6 }];
const brief = { objective: 'Donner envie de ce casque.', audience: 'Clients de HABB', occasion: 'Campagne quotidienne', offer: 'Aucune remise', permissions: [] };

test('NM-1 the fingerprints ignore the stock and the order of the variants, and see a changed claim, price, brief or permission', () => {
  const f = factsFingerprint({ claims, variants });
  assert.equal(factsFingerprint({ claims, variants: [{ ...variants[0], inventoryQuantity: 0 }] }), f, 'the stock moves every day: not a fact');
  assert.notEqual(factsFingerprint({ claims: [...claims, 'Nouvelle phrase'], variants }), f); assert.notEqual(factsFingerprint({ claims, variants: [{ ...variants[0], price: '39.90' }] }), f);
  const b = briefFingerprint(brief); assert.equal(briefFingerprint({ ...brief, objective: `  ${brief.objective}  ` }), b); assert.notEqual(briefFingerprint({ ...brief, offer: 'Une remise de dix pour cent' }), b); assert.notEqual(briefFingerprint({ ...brief, permissions: ['PEOPLE'] }), b);
});

test('NM-2 a remembered NONE applies while facts and brief are identical; it stops applying, naming what changed, as soon as one changes; another variant is not concerned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-')); const file = join(dir, 'none-memory.json'); const facts_sha = factsFingerprint({ claims, variants }); const brief_sha = briefFingerprint(brief);
  assert.equal(recordNone(file, { run_id: 'cr-1', product_id: 'P', variant_id: 'V', recorded_at: '2026-11-15T13:31:48Z', facts_sha, brief_sha, none_reason: 'rien ne montre un besoin' }).status, 'RECORDED');
  assert.equal(recordNone(file, { run_id: 'cr-1', product_id: 'P', variant_id: 'V', recorded_at: 'x', facts_sha, brief_sha }).status, 'ALREADY_RECORDED'); const e = readNoneMemory(file); assert.equal(e.length, 1);
  assert.equal(noneStatus(e, { product_id: 'P', variant_id: 'V', facts_sha, brief_sha }).applies, true);
  assert.deepEqual(noneStatus(e, { product_id: 'P', variant_id: 'V', facts_sha: 'other', brief_sha }).changed, ['faits']); assert.deepEqual(noneStatus(e, { product_id: 'P', variant_id: 'V', facts_sha, brief_sha: 'other' }).changed, ['brief']);
  assert.equal(noneStatus(e, { product_id: 'P', variant_id: 'V', facts_sha: 'o', brief_sha: 'o' }).applies, false); assert.equal(noneStatus(e, { product_id: 'P', variant_id: 'OTHER', facts_sha, brief_sha }).entry, null);
});

test('NM-3 the Creator app records a NONE with the fingerprints of the registered product sheet and of the brief it was given (the casque of the registry)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-')); const file = join(dir, 'none-memory.json'); const adProducts = loadAdProducts(); const id = 'gid://shopify/Product/15500205523292';
  const mem = createNoneMemory({ file, adProducts });
  const c = { id: 'cr-aaaaaaaaaaaa', product: { product_id: id }, variant: { variant_id: 'gid://shopify/ProductVariant/57206453109084', title: 'Bleu' }, objective: brief.objective, campaign: { audience: brief.audience, occasion: brief.occasion, offer: brief.offer, permissions: [] }, error: { code: 'AD_NO_CONVINCING_IDEA', reason: 'AD_NO_CONVINCING_IDEA: Aucune idée convaincante' } };
  assert.equal(mem.record(c).status, 'RECORDED'); const [e] = mem.entries(); assert.equal(e.none_reason, 'Aucune idée convaincante'); assert.equal(e.brief_sha, briefFingerprint(brief)); assert.equal(mem.record({ ...c, product: { product_id: 'gid://shopify/Product/0' } }).status, 'NOT_AN_AD_PRODUCT');
});
