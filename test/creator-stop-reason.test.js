// CREATOR'S NONE (and the other ways a run ends without a result) FROM ARCHIVED RUNS: the reason is Creator's own, it reaches the screen and the memory once, and the three ends stay distinguishable. NO model call: archived traces and answers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveStopReason, NONE_CODE } from '../src/creative-autonomy/stop-reason.js';
import { createNoneMemory, readNoneMemory, recordNone, factsFingerprint, briefFingerprint, factsOfRegisteredProduct } from '../src/creative-autonomy/none-memory.js';
import { loadAdProducts } from '../src/creative-autonomy/ad-products.js';
import { createCreatorApp } from '../src/creative-autonomy/creator/app.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'creative-autonomy', 'stop-reason-archive');
const trace = (run) => JSON.parse(readFileSync(join(FIX, `${run}.trace.json`), 'utf8'));
const CABLE = 'gid://shopify/Product/15522712846684'; const CABLE_V = 'gid://shopify/ProductVariant/57252207886684';
const BRIEF = { objective: 'Donner envie d’acheter ce produit chez HABB.', audience: 'Clients de HABB', occasion: 'Campagne quotidienne', offer: 'Aucune remise', permissions: [] };

test('SR-1 the archived NONE of the cable (cr-08a0933b0836): the stop reason is Creator\'s OWN reason and the NONE code, not "every proposal was withheld"', () => {
  const r = trace('cr-08a0933b0836'); assert.equal(r.status, 'STOPPED_ERROR'); assert.equal(r.proposals?.length ?? 0, 0);
  const s = deriveStopReason({ r, shown: [] }); assert.equal(s.code, NONE_CODE); assert.equal(s.kind, 'NONE'); assert.match(s.message, /^Aucun détail visible dans la scène ne montre un besoin concret que ce câble résout/); assert.ok(s.message.length > 200 && s.message.length <= 400);
  const answer = JSON.parse(readFileSync(join(FIX, 'cr-08a0933b0836.answer.txt'), 'utf8')); assert.equal(answer.verdict, 'NONE'); assert.ok(answer.none_reason.startsWith(s.message.slice(0, 120)), 'the reason shown is the archived answer\'s own words');
  assert.equal(deriveStopReason({ r, shown: [{ image: 'x' }] }), null, 'a run that has a result has no stop reason');
});

test('SR-2 a stage error stays a stage error with ITS code (a refused direction, a render with no variant), never mistaken for a NONE', () => {
  for (const [run, code] of [['cr-ddf27b48bdd4', 'REPAIR_ARRAY_LENGTH_CHANGED'], ['cr-f69714718fa1', 'SCENE_NO_VARIANT_PASSED']]) {
    const s = deriveStopReason({ r: trace(run), shown: [] }); assert.equal(s.kind, 'STAGE_ERROR', run); assert.equal(s.code, code, run); assert.notEqual(s.code, NONE_CODE);
  }
});

test('SR-3 Creator DID propose and EVERY proposal was withheld by the checks: its own identifiable result (NO_RESULT_PASSED_CHECKS, how many and why), different from a NONE and from a stage error', () => {
  const proposals = JSON.parse(readFileSync(join(FIX, 'cr-f7d2922f5d04.propositions.json'), 'utf8')); assert.equal(proposals[0].technical_quality.state, 'PASS');
  const failed = proposals.map((p) => ({ ...p, technical_quality: { ...p.technical_quality, state: 'FAIL', defects: ['GHOST_EDGE_AROUND_PRODUCT'] } }));
  const s = deriveStopReason({ r: { trace: [{ step: 'COMPOSE+CHECK', outcome: 'CLEAN' }], proposals: failed }, shown: [] });
  assert.equal(s.code, 'NO_RESULT_PASSED_CHECKS'); assert.equal(s.kind, 'WITHHELD'); assert.match(s.message, /1 proposition\(s\) émise\(s\) par Creator, toutes écartées par les contrôles techniques : FAIL \(GHOST_EDGE_AROUND_PRODUCT\)/);
  assert.equal(deriveStopReason({ r: { trace: [], proposals: [] }, shown: [] }), null, 'nothing known: no invented reason');
});

test('SR-4 the NONE enters none-memory.json AUTOMATICALLY from the archived NONE, with the reason; a manual entry of the SAME run, or a replay under ANOTHER run id with the same facts and brief, is NOT duplicated; another brief is a new memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-')); const file = join(dir, 'none-memory.json'); const adProducts = loadAdProducts(); const mem = createNoneMemory({ file, adProducts });
  const reason = deriveStopReason({ r: trace('cr-08a0933b0836'), shown: [] }).message;
  const creation = (id, brief = BRIEF) => ({ id, product: { product_id: CABLE }, variant: { variant_id: CABLE_V, title: 'Default Title' }, objective: brief.objective, campaign: { audience: brief.audience, occasion: brief.occasion, offer: brief.offer, permissions: brief.permissions }, error: { code: NONE_CODE, reason } });
  // the entry added by hand earlier (same run id, same fingerprints as the app computes)
  const reg = adProducts.find(CABLE); recordNone(file, { run_id: 'cr-08a0933b0836', product_id: CABLE, variant_id: CABLE_V, recorded_at: '2026-11-15T14:36:00Z', kind: 'NONE', none_reason: reason.slice(0, 300), facts_sha: factsFingerprint(factsOfRegisteredProduct(reg)), brief_sha: briefFingerprint(BRIEF) });
  assert.equal(mem.record(creation('cr-08a0933b0836')).status, 'ALREADY_RECORDED', 'same run');
  assert.equal(mem.record(creation('cr-aaaaaaaaaaaa')).status, 'ALREADY_REMEMBERED', 'a replay: another run id, same facts and brief'); assert.equal(readNoneMemory(file).length, 1); assert.equal(readNoneMemory(file)[0].run_id, 'cr-08a0933b0836', 'the first date and run stay');
  assert.equal(mem.record(creation('cr-bbbbbbbbbbbb', { ...BRIEF, offer: 'Une autre offre' })).status, 'RECORDED', 'another brief is another question'); assert.equal(readNoneMemory(file).length, 2);
  const fresh = mkdtempSync(join(tmpdir(), 'sr-')); const m2 = createNoneMemory({ file: join(fresh, 'none-memory.json'), adProducts }); assert.equal(m2.record(creation('cr-cccccccccccc')).status, 'RECORDED'); assert.equal(m2.entries()[0].none_reason, reason.slice(0, 300));
});

async function serve(handler) { const s = http.createServer(handler); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (path, body) => { const r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, json: j }; };
  return { req, close: () => new Promise((r) => s.close(r)) }; }
const until = async (fn, ms = 4000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

test('SR-5 in the Creator app: a run that ends with Creator\'s NONE shows its REAL reason as the error of the creation, with the NONE code, spends nothing more, and is remembered once; the three ends keep three different codes on screen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-')); const memory = createNoneMemory({ file: join(dir, 'none-memory.json'), adProducts: loadAdProducts() });
  const noneReason = deriveStopReason({ r: trace('cr-08a0933b0836'), shown: [] });
  const outcomes = { NONE: { stop_reason: noneReason }, STAGE: { stop_reason: deriveStopReason({ r: trace('cr-f69714718fa1'), shown: [] }) }, WITHHELD: { stop_reason: { code: 'NO_RESULT_PASSED_CHECKS', message: '1 proposition(s) émise(s)…' } } };
  let which = 'NONE'; let hubCalls = 0;
  const integration = { async call() { hubCalls += 1; live.__spent = 0.0078; return { ok: true, result: { status: 'STOPPED_ERROR', results: [], ...outcomes[which] } }; } };
  const live = { caps: { concept_eur: 0.0932, attempt_eur: 0.2 }, spent: () => live.__spent ?? 0, preflight: async () => ({ ok: true, status: 'CUT_OUT', reasons: [] }), estimate: (phase) => ({ phase, label: 'x', expected_eur: 0.03, max_eur: 0.0932, attempt_cap_eur: 0.2, spent_eur: 0 }), begin() {}, end() {}, route: 'AD_V1', adProducts: loadAdProducts(), noneMemory: memory };
  const catalog = async () => [{ product_id: CABLE, title: 'Câble USB-C vers Lightning 2 m', variants: [{ variant_id: CABLE_V, title: 'Default Title', price: '6,99 €' }] }];
  const s = await serve(createCreatorApp({ integration, catalog, mode: 'LIVE_LOCAL', live, actor: { id: 'a', role: 'OWNER' } }));
  const run = async (w) => { which = w; const c = (await s.req('/api/creator/creations', { product_id: CABLE, variant_id: CABLE_V, objective: BRIEF.objective, audience: BRIEF.audience, occasion: BRIEF.occasion, offer: BRIEF.offer, permissions: [] })).json; await s.req(`/api/creator/creations/${c.creation_id}/authorize`, { phase: 'CONCEPT', ceiling_eur: 0.0932 }); return until(async () => { const v = (await s.req(`/api/creator/creations/${c.creation_id}`)).json; return v.status === 'RUNNING' ? null : v; }); };
  const none = await run('NONE'); assert.equal(none.status, 'NO_RESULT'); assert.equal(none.error.code, NONE_CODE); assert.match(none.error.reason, /^Aucun détail visible dans la scène ne montre un besoin concret que ce câble résout/); assert.equal(none.spend.spent_eur, 0.0078);
  assert.equal(memory.entries().length, 1); assert.equal(memory.entries()[0].none_reason.slice(0, 40), none.error.reason.slice(0, 40));
  await run('NONE'); assert.equal(memory.entries().length, 1, 'asking again with the same facts and brief does not add a second memory');
  const stage = await run('STAGE'); assert.equal(stage.error.code, 'SCENE_NO_VARIANT_PASSED'); const withheld = await run('WITHHELD'); assert.equal(withheld.error.code, 'NO_RESULT_PASSED_CHECKS');
  assert.equal(memory.entries().length, 1, 'only a NONE is remembered as a NONE'); assert.equal(hubCalls, 4); await s.close();
});
