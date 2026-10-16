import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeCreative, createCampaignBudget, createNotConnectedProvider, createVersionLog, generatePlateStep, buildPlateRequest, loadFonts, productPost, HABB_PALETTE, AI_ERROR,
} from '../src/studio-compose/index.js';
import { encodePng } from '../src/creative-intelligence/png-encode.js';
import { decodePng } from '../src/creative-intelligence/png-pixels.js';

// No network and no provider: the "provider" below is a TEST DOUBLE that draws a flat plate locally. It proves the integration rules, not any image quality.
const FONTS = loadFonts(new URL('../resources/fonts/habb-benchmark', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const flat = (w, h, rgb) => { const px = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) px.set([...rgb, 255], i * 4); return encodePng({ width: w, height: h, pixels: px }); };
const noise = (w, h) => { const px = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { const v = (i * 7919 + (i >> 3) * 104729) & 255; px.set([v, 255 - v, (v * 3) & 255, 255], i * 4); } return encodePng({ width: w, height: h, pixels: px }); };
const tall = (w, h) => { const px = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([(x * 3) & 255, (y * 2) & 255, (x + y) & 255, 255], (y * w + x) * 4); return encodePng({ width: w, height: h, pixels: px }); };
const mark = () => { const w = 480; const h = 120; const px = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(x > 150 && x < 300 && y > 40 && y < 80 ? [255, 255, 255, 255] : [24, 50, 71, 255], (y * w + x) * 4); return encodePng({ width: w, height: h, pixels: px }); };
const images = () => new Map([['p', tall(200, 400)], ['wm', mark()]]);
const spec = () => productPost({ id: 'AI1', productKey: 'p', wordmarkKey: 'wm', copy: { headline: ['Votre photo,', 'votre coque.'], price: ['25 €'], note: ['Prête en environ', '5 minutes, selon le', 'modèle et la', 'disponibilité.'], example: ['Exemple de rendu.'], cta: ['Venez en boutique', 'à Namur.'], address: ['RUE DE BRUXELLES 18', '5000 NAMUR'] } });

function double({ estimate = 0.04, cost = 0.04, plate = () => flat(1080, 1350, [24, 50, 71]), needsRef = false } = {}) {
  const calls = { estimate: 0, generate: 0, requests: [] };
  return { calls, id: 'TEST_DOUBLE', capabilities: { operations: ['BACKGROUND_PLATE'], needs_reference_image: needsRef }, estimate(r) { calls.estimate++; return estimate; }, async generate(r) { calls.generate++; calls.requests.push(r); return { png: plate(), usage: { cost_eur: cost, model: 'double-1' } }; } };
}
const base = (over = {}) => ({ spec: spec(), images: images(), fonts: FONTS, palette: HABB_PALETTE, budget: createCampaignBudget({ ceilingEur: 1 }), log: createVersionLog(), intent: 'A calm, plain, dark blue-grey studio wall with soft daylight', ...over });

test('AI-1 the default provider is NOT CONNECTED: nothing is reserved, nothing is generated, nothing is logged', async () => {
  const b = base({ provider: createNotConnectedProvider() });
  await assert.rejects(() => generatePlateStep(b), (e) => e.code === AI_ERROR.PROVIDER_NOT_CONNECTED);
  assert.equal(b.budget.reserved_eur(), 0);
  assert.equal(b.log.list().length, 0);
});

test('AI-2 a plate goes UNDER the locked layers: product pixels, copy and safe zones stay intact, and the version is PROPOSED', async () => {
  const p = double();
  const b = base({ provider: p });
  const r = await generatePlateStep(b);
  assert.equal(r.creative.record.deliverable, true, JSON.stringify(r.creative.record.checks.filter((c) => c.outcome === 'FAIL')));
  assert.equal(r.creative.record.backgrounds.length, 1);
  assert.equal(r.version.status, 'PROPOSED');
  assert.equal(r.version.decided_by, null);
  assert.equal(r.version.cost_eur, 0.04);
  assert.equal(b.budget.reserved_eur(), 0.04);
  // the product region is byte-identical to the same creative composed WITHOUT any plate
  const plain = composeCreative({ spec: spec(), images: images(), fonts: FONTS, palette: HABB_PALETTE });
  const a = decodePng(r.creative.png); const c = decodePng(plain.png);
  const box = plain.record.products.find((x) => x.layer === 'product').placed;
  for (let y = box.y; y < box.y + box.height; y += 9) for (let x = box.x; x < box.x + box.width; x += 7) {
    const o = (y * a.width + x) * 4;
    assert.deepEqual([...a.pixels.subarray(o, o + 3)], [...c.pixels.subarray(o, o + 3)]);
  }
});

test('AI-3 a request that would pass the ceiling is refused BEFORE any call', async () => {
  const p = double({ estimate: 0.05 });
  const b = base({ provider: p, budget: createCampaignBudget({ ceilingEur: 0.03 }) });
  await assert.rejects(() => generatePlateStep(b), (e) => e.code === AI_ERROR.BUDGET_EXCEEDED);
  assert.equal(p.calls.generate, 0);
  assert.equal(b.budget.reserved_eur(), 0);
});

test('AI-4 locked data never leaves: the request holds an intent, a size and geometry only', async () => {
  const p = double();
  const b = base({ provider: p });
  await generatePlateStep(b);
  const req = JSON.stringify(p.calls.requests[0]);
  for (const locked of ['Votre photo', 'votre coque', '25', 'Namur', 'BRUXELLES']) assert.equal(req.includes(locked), false, locked);
  assert.equal(/base64|sha256|[A-Za-z0-9+/]{200}/.test(req), false);
  const parsed = JSON.parse(req);
  assert.deepEqual(Object.keys(parsed).sort(), ['constraints', 'intent', 'keep_clear', 'operation', 'seed_label', 'size']);
  assert.ok(parsed.keep_clear.every((k) => k.layer && k.box && !('key' in k)));
  assert.ok(parsed.constraints.includes('no product, no phone, no person, no face'));
});

test('AI-5 a provider that needs a reference image is refused unless the owner enabled the upload', async () => {
  const p = double({ needsRef: true });
  await assert.rejects(() => generatePlateStep(base({ provider: p })), (e) => e.code === AI_ERROR.REFERENCE_UPLOAD_NOT_ALLOWED);
  assert.equal(p.calls.estimate, 0);
  assert.equal(p.calls.generate, 0);
});

test('AI-6 an unusable plate is refused: wrong size, no cost reported, not a PNG', async () => {
  await assert.rejects(() => generatePlateStep(base({ provider: double({ plate: () => flat(100, 100, [0, 0, 0]) }) })), (e) => e.code === AI_ERROR.INVALID_PLATE);
  const noCost = double(); noCost.generate = async () => ({ png: flat(1080, 1350, [24, 50, 71]), usage: {} });
  await assert.rejects(() => generatePlateStep(base({ provider: noCost })), (e) => e.code === AI_ERROR.INVALID_PLATE && /cost/.test(e.message));
  const junk = double(); junk.generate = async () => ({ png: new Uint8Array([1, 2, 3]), usage: { cost_eur: 0 } });
  await assert.rejects(() => generatePlateStep(base({ provider: junk })), (e) => e.code === AI_ERROR.INVALID_PLATE);
});

test('AI-7 the quality gates still decide: a busy plate under text, or a plate that kills the contrast, is logged as NOT deliverable', async () => {
  const busy = await generatePlateStep(base({ provider: double({ plate: () => noise(1080, 1350) }) }));
  assert.equal(busy.version.deliverable, false);
  assert.ok(busy.version.failed_gates.includes('TEXT_CONTRAST'));
  const pale = await generatePlateStep(base({ provider: double({ plate: () => flat(1080, 1350, [250, 250, 250]) }) }));
  assert.equal(pale.version.deliverable, false);
  assert.ok(pale.version.failed_gates.includes('TEXT_CONTRAST'));
});

test('AI-8 version log: append-only, parent chain, only a named human decides', async () => {
  const b = base({ provider: double() });
  const v1 = (await generatePlateStep(b)).version;
  const v2 = (await generatePlateStep({ ...b, parent: v1.version })).version;
  assert.equal(v2.parent, 1);
  assert.equal(b.log.list().length, 2);
  assert.throws(() => b.log.decide(1, 'APPROVED', 'claude'), (e) => e.code === AI_ERROR.INVALID_DECISION);
  assert.throws(() => b.log.decide(1, 'APPROVED', 'https://example.test/ok'), (e) => e.code === AI_ERROR.INVALID_DECISION);
  // the log checks the SHAPE of the reference only; WHO may approve is enforced by chantier E (owner role), not here
  const d = b.log.decide(1, 'APPROVED', 'approval://habb/owner-2026-10-17');
  assert.equal(d.status, 'APPROVED');
  assert.equal(b.log.list()[1].status, 'PROPOSED');
  assert.throws(() => { b.log.list()[0].status = 'X'; }, TypeError);
});

test('AI-9 a cost above the estimate is recorded, never hidden; the spend stays inside the ceiling that was reserved', async () => {
  const b = base({ provider: double({ estimate: 0.04, cost: 0.09 }) });
  const r = await generatePlateStep(b);
  assert.equal(r.version.over_estimate, true);
  assert.equal(r.version.cost_eur, 0.09);
  assert.equal(buildPlateRequest({ spec: spec(), intent: 'a plain wall under soft light' }).operation, 'BACKGROUND_PLATE');
  assert.throws(() => buildPlateRequest({ spec: spec(), intent: 'x' }), (e) => e.code === AI_ERROR.INVALID_PLATE);
});
