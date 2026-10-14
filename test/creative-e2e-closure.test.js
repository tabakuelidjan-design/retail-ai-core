import test from 'node:test';
import assert from 'node:assert/strict';

import { e2eBrief, e2eWorld } from './creative-e2e-world.js';
import { campaignRequest } from './creative-campaign-world.js';
import { LOCKED_COPY, fakeLayerPort, propOnGround } from './creative-layered-runtime-world.js';
import { createDefectRegion, DEFECT_KIND, DEFECT_SOURCE, REPAIR_BLOCK, classifyCandidate, refineCreative } from '../src/creative-refine/index.js';
import {
  E2E_STATE, OPERATION, checkProductCopyConsistency, dispositionOfClaims, executionOf, layeredRunOf, runCreativeCampaign, runCreativeEndToEnd,
} from '../src/creative-e2e/index.js';

// The closure of the defects found by the assembled-system validation (`// CS-N` markers): single image, campaign orchestration, real-asset refine, budget semantics, claim disposition, product/copy consistency, one status model.
// Provider-free: every provider is a scripted fake that counts its calls.

const AT = '2026-10-14T10:00:00.000Z';
const run = (w, over = {}) => runCreativeEndToEnd({
  run_id: 'run-cs-1', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian, ...over,
});
const imageOps = (r) => r.provider_calls.filter((c) => c.kind === OPERATION.IMAGE_GENERATION);
const produced = new Set([E2E_STATE.READY, E2E_STATE.NEEDS_OWNER_REVIEW]);
const single = (over = {}) => campaignRequest({ requested_format: 'SINGLE_IMAGE', requested_asset_count: 1, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: 'Vos souvenirs. Votre création.' }], ...over });
const noAnnotations = () => e2eBrief({ identity_annotations: undefined }); // what a real HABB product file is: no case annotations, derived from the matte

test('A SINGLE_IMAGE request runs through the same end-to-end runtime, as one asset, never as a carousel', async () => {
  // CS-1
  const w = await e2eWorld({ request: single() }); const r = await run(w);
  assert.ok(produced.has(r.state), JSON.stringify(r.block ?? r.failure));
  assert.equal(r.format, 'SINGLE_IMAGE'); assert.equal(r.asset_count, 1); assert.equal(r.resume_state.campaign_store.nodes['ASSET_PLAN:L0:0'].status, 'DONE'); assert.equal(r.resume_state.campaign_store.nodes['ASSET_PLAN:L0:1'], undefined);
  assert.equal(r.fallback_to_generated_product, false); assert.equal(new Set(r.operation_ids).size, r.operation_ids.length); assert.ok(r.operation_ids.every((id) => id.startsWith('run-cs-1:')));
  assert.equal(r.product_identity.delivered_identity.valid, true); assert.equal(r.product_identity.product_pixels_changed_by_compositor, 0);
  assert.equal(r.budget.spent_eur, r.provider_calls.reduce((t, c) => t + c.actual_eur, 0)); assert.equal(imageOps(r).length, w.layers.calls.length);
  // the multi-asset requests are unchanged: a carousel is still a carousel
  const car = await run(await e2eWorld(), { run_id: 'run-cs-2' }); assert.equal(car.format, 'CAROUSEL'); assert.ok(car.asset_count > 1);
});

test('The budget is a state of its own: the ceiling refuses before the port is called, a provider failure stays a provider failure', async () => {
  // CS-2 low ceilings: BUDGET_EXCEEDED whoever was waiting on the reservation (the Brain wraps its port errors), never TECHNICAL_FAIL
  for (const ceiling of [0.01, 0.05, 0.1]) {
    const w = await e2eWorld({ request: single() }); const r = await run(w, { ceiling_eur: ceiling, run_id: 'run-cs-b' });
    assert.equal(r.state, E2E_STATE.BUDGET_EXCEEDED, String(ceiling)); assert.equal(r.failure.code, 'BUDGET_EXCEEDED');
    assert.ok(r.budget.spent_eur <= ceiling + 1e-9, 'never overspent'); assert.equal(w.layers.calls.length, 0, 'no image was asked'); assert.equal(r.final, null);
    assert.equal(w.brainPort.calls.length, r.provider_calls.filter((c) => c.kind === OPERATION.BRAIN_TEXT).length, 'a refused reservation never reached the port');
  }
  // CS-3 enough money, a port that really fails: a TECHNICAL failure, not a budget one
  const broken = await e2eWorld({ request: single() }); broken.ports = { ...broken.ports, brainComplete: async () => { throw Object.assign(new Error('the model is down'), { code: 'MODEL_DOWN' }); } };
  const rb = await run(broken, { run_id: 'run-cs-p' }); assert.equal(rb.state, E2E_STATE.TECHNICAL_FAIL); assert.notEqual(rb.state, E2E_STATE.BUDGET_EXCEEDED);
  // CS-3b a refine whose regeneration the ceiling refuses is BUDGET_EXCEEDED, not a refused repair; the original image is kept
  const withProps = () => fakeLayerPort({ prop: ({ candidate_index: i }) => propOnGround({ colour: i > 1 ? '#3a6ea5' : '#7a4b2a' }) });
  const wb0 = await e2eWorld({ request: single(), layerPort: withProps() }); const base0 = await run(wb0, { run_id: 'run-cs-rb0' });
  const prop0 = base0.layers.props[0]; const dfx = createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, source: DEFECT_SOURCE.OWNER_REGION, layer_id: prop0.layer_id, reason: 'the owner does not like this prop' });
  const wb1 = await e2eWorld({ request: single(), layerPort: withProps() }); const rbud = await run(wb1, { run_id: 'run-cs-rb1', ceiling_eur: base0.budget.spent_eur + 0.001, options: { planner_ceiling_eur: 2, refine: { enabled: true, defects: [dfx] } } });
  assert.equal(rbud.state, E2E_STATE.BUDGET_EXCEEDED, JSON.stringify(rbud.block ?? rbud.failure)); assert.equal(rbud.failure.code, 'BUDGET_EXCEEDED'); assert.equal(wb1.layers.calls.length, wb0.layers.calls.length, 'no image was regenerated'); assert.ok(rbud.budget.spent_eur <= base0.budget.spent_eur + 0.001);
  // a ceiling of nothing is refused at the door
  const none = await run(await e2eWorld({ request: single() }), { ceiling_eur: 0, run_id: 'run-cs-z' }); assert.equal(none.state, E2E_STATE.BUDGET_EXCEEDED); assert.equal(none.provider_calls.length, 0);
});

test('Refine works on a real-asset-like candidate whose case gate cannot be measured, and says what it refuses', async () => {
  const withProps = () => fakeLayerPort({ prop: ({ candidate_index: i }) => propOnGround({ colour: i > 1 ? '#3a6ea5' : '#7a4b2a' }) });
  const w0 = await e2eWorld({ brief: noAnnotations(), request: single(), layerPort: withProps() }); const base = await run(w0, { run_id: 'run-cs-r0' });
  // CS-4 the layered run is BLOCKED by an unmeasurable case gate although an image exists: said apart, and consistent with the final state
  assert.equal(base.final.layered_run.raw_status, 'BLOCKED'); assert.equal(base.final.layered_run.delivery, 'IDENTITY_NOT_MEASURED_BY_THE_CASE_GATE'); assert.equal(base.final.layered_run.case_gate, 'NOT_MEASURABLE'); assert.ok(produced.has(base.state));
  const prop = base.layers.props[0]; assert.ok(prop);
  const defect = createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, source: DEFECT_SOURCE.OWNER_REGION, layer_id: prop.layer_id, reason: 'the owner does not like this prop' });
  const w1 = await e2eWorld({ brief: noAnnotations(), request: single(), layerPort: withProps() });
  const fix = await run(w1, { run_id: 'run-cs-r1', options: { refine: { enabled: true, defects: [defect] } } });
  assert.equal(fix.refine.status, 'REPAIRED', JSON.stringify(fix.refine)); assert.deepEqual([].concat(fix.refine.scope), ['PROP_REPAIR']); assert.equal(fix.refine.product_identical, true); assert.equal(fix.refine.locked_copy_identical, true);
  assert.notEqual(fix.final.png_sha256, base.final.png_sha256); assert.ok(produced.has(fix.state)); assert.equal(fix.gates.find((g) => g.id === 'PRODUCT_DELIVERED_IDENTITY').outcome, 'PASS');
  assert.equal(w1.layers.calls.length - w0.layers.calls.length, 1, 'one layer regenerated, nothing else'); assert.equal(w1.brainPort.calls.length, w0.brainPort.calls.length, 'the concept was not restarted');
  // CS-5 the candidate classes, apart: no artifact / unmeasurable / invalid
  assert.equal(classifyCandidate(null), 'NO_ARTIFACT'); assert.equal(classifyCandidate({ status: 'BLOCKED', reason: 'X' }), 'NO_ARTIFACT'); assert.equal(classifyCandidate({ status: 'READY_FOR_REVIEW', artifact: { schema: 'x' } }), 'INVALID');
  const cand = (over) => ({ ...base.resume_state && {}, status: 'BLOCKED', fidelity: { gate: 'NOT_MEASURABLE' }, png_bytes: base.final.png_bytes, ...over });
  assert.equal(classifyCandidate(cand({ artifact: undefined })), 'NO_ARTIFACT');
  // without the caller's acceptance an unmeasured candidate is refused with its OWN code (the strict default is unchanged)
  const wStrict = await e2eWorld({ brief: noAnnotations(), request: single(), layerPort: withProps() }); let candidate = null;
  await run(wStrict, { run_id: 'run-cs-r2', deps: { runLayered: async (a) => { const { runLayeredCreative } = await import('../src/creative-runtime/index.js'); candidate = await runLayeredCreative(a); return candidate; } } });
  assert.equal(classifyCandidate(candidate), 'UNMEASURABLE_DELIVERED');
  const refused = await refineCreative({ candidate, defects: [defect], run: { ledger: { record() {}, entries: () => [] }, scene_id: candidate.scene_id, production: { shared_layers: [], production: { budget: { unit_costs: { image_eur_by_size_class: {} } } } }, ports: { layers: wStrict.layers } }, allowUnmeasurableIdentity: false });
  assert.equal(refused.status, 'BLOCKED'); assert.equal(refused.block.code, REPAIR_BLOCK.FIDELITY_NOT_MEASURABLE);
});

test('Every approved claim ends with a stated disposition; nothing silently disappears, nothing is forced onto the visual', async () => {
  // CS-6 the default: the brief claims are in no text of the plan: NOT_USED, said, with a warning; the price is never invented onto the image
  const w = await e2eWorld({ request: single() }); const r = await run(w, { run_id: 'run-cs-c1' });
  const byRef = Object.fromEntries(r.claims.map((c) => [c.ref, c]));
  assert.equal(byRef['claim://test/price'].disposition, 'NOT_USED'); assert.equal(byRef['claim://test/price'].reason, 'NOT_IN_THE_REQUEST_COPY_AND_NOT_FORCED_ONTO_THE_VISUAL'); assert.ok(r.warnings.includes('CLAIM_NOT_USED:claim://test/price'));
  assert.equal(byRef['copy://test/headline'].kind, 'APPROVED_COPY'); assert.equal(r.gates.find((g) => g.id === 'CLAIM_DISPOSITION').outcome, 'PASS'); assert.equal(r.gates.find((g) => g.id === 'CLAIM_DISPOSITION').mandatory, true);
  // CS-7 declared METADATA_ONLY: carried as data only, no warning; declared NOT_USED: no warning either
  const w2 = await e2eWorld({ request: single() }); const r2 = await run(w2, { run_id: 'run-cs-c2', options: { claim_policy: { 'claim://test/price': 'METADATA_ONLY', 'claim://test/promise': 'NOT_USED' } } });
  assert.equal(r2.claims.find((c) => c.ref === 'claim://test/price').disposition, 'METADATA_ONLY'); assert.ok(!r2.warnings.some((x) => x.startsWith('CLAIM_NOT_USED:claim://test/price')) && !r2.warnings.includes('CLAIM_NOT_USED:claim://test/promise'));
  // CS-8 declared VISUAL_COPY but the wording is not in the plan: stopped BEFORE any image is made
  const w3 = await e2eWorld({ request: single() }); const r3 = await run(w3, { run_id: 'run-cs-c3', options: { claim_policy: { 'claim://test/price': 'VISUAL_COPY' } } });
  assert.equal(r3.state, E2E_STATE.BLOCKED); assert.equal(r3.block.code, 'CLAIM_NOT_PLACED'); assert.equal(w3.layers.calls.length, 0); assert.equal(r3.final, null);
  // CS-9 the price on the visual, in its exact approved form (a PRICE unit of the copy that equals the approved claim)
  const brief = e2eBrief({ claims: [{ ref: 'claim://habb/price', role: 'PRICE', wording: '25,00 €' }] });
  const priced = campaignRequest({ requested_format: 'SINGLE_IMAGE', requested_asset_count: 1, copy: [{ copy_ref: 'copy://h', mode: 'COPY_LOCKED', text: 'Vos souvenirs. Votre création.' }, { copy_ref: 'copy://p', mode: 'COPY_LOCKED', role: 'PRICE', text: '25,00 €' }] });
  const w4 = await e2eWorld({ brief, request: priced }); const r4 = await run(w4, { run_id: 'run-cs-c4', options: { claim_policy: { 'claim://habb/price': 'VISUAL_COPY' } } });
  assert.ok(produced.has(r4.state), JSON.stringify(r4.block)); const price = r4.claims.find((c) => c.ref === 'claim://habb/price'); assert.equal(price.disposition, 'VISUAL_COPY'); assert.equal(price.wording, '25,00 €'); assert.equal(price.exact, true); assert.equal(price.placed_on[0].slot_role, 'PRICE');
  assert.equal(r4.copy_integrity.exact, true);
  // CS-10 the pure rules: an amount written another way is stopped, a caption counts, an unknown policy is refused
  const plan = (slotText, caption = null) => [{ assets: [{ index: 0, slots: [{ role: 'BODY', text: slotText }] }], caption }];
  const altered = dispositionOfClaims({ brief: { claims: [{ ref: 'c', role: 'PRICE', wording: '25,00 €' }] }, contentPlans: plan('Seulement 25 € aujourd’hui') });
  assert.deepEqual(altered.blocks.map((b) => b.code), ['CLAIM_ALTERED']);
  assert.equal(dispositionOfClaims({ brief: { claims: [{ ref: 'c', role: 'PRICE', wording: '25,00 €' }] }, contentPlans: plan('x', [{ text: 'à 25,00 € seulement' }]) }).dispositions[0].disposition, 'CAPTION');
  assert.equal(dispositionOfClaims({ brief: { claims: [{ ref: 'c', role: 'PRICE', wording: '25,00 €' }] }, contentPlans: plan('25,00 €') }).dispositions[0].disposition, 'VISUAL_COPY'); // a no-break space is the same wording
  assert.deepEqual(dispositionOfClaims({ brief: { claims: [{ ref: 'c', role: 'X', wording: 'w' }] }, contentPlans: plan('x'), policy: { c: 'EVERYWHERE' } }).blocks.map((b) => b.code), ['CLAIM_POLICY_INVALID']);
});

test('A copy that contradicts the declared product is stopped before anything is spent, and never rewritten', async () => {
  // CS-11 a phone-case sentence on a power bank
  const bank = e2eBrief({ public_facts: { product: 'Batterie externe Remax 20000 mAh', merchant: 'HABB, Namur' } });
  const w = await e2eWorld({ brief: bank, request: single({ copy: [{ copy_ref: 'copy://h', mode: 'COPY_LOCKED', text: 'Votre photo sur votre coque.' }] }) }); const r = await run(w, { run_id: 'run-cs-k1' });
  assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.block.code, 'PRODUCT_COPY_CONFLICT'); assert.equal(r.block.stage, 'REQUEST'); assert.equal(w.brainPort.calls.length, 0); assert.equal(r.provider_calls.length, 0); assert.equal(r.budget.spent_eur, 0);
  assert.equal(r.gates.find((g) => g.id === 'PRODUCT_COPY_CONSISTENCY').outcome, 'FAIL'); assert.equal(r.gates.find((g) => g.id === 'PRODUCT_COPY_CONSISTENCY').mandatory, true); assert.equal(r.consistency.findings[0].copy_says, 'PHONE_CASE'); assert.equal(r.final, null);
  // CS-12 the other way round: a charging claim on a phone case, from the approved claims of the brief
  const conflict = checkProductCopyConsistency({ brief: e2eBrief({ claims: [{ ref: 'claim://x', role: 'SUBHEADLINE', wording: '20 000 mAh d’autonomie' }] }), request: { copy: [] } });
  assert.equal(conflict.status, 'CONFLICT'); assert.equal(conflict.product_category, 'PHONE_CASE'); assert.ok(conflict.findings.every((f) => f.copy_says === 'POWER_BANK'));
  assert.equal(checkProductCopyConsistency({ brief: e2eBrief(), request: { copy: [{ copy_ref: 'c', text: 'Protège ton téléphone' }] } }).status, 'CONSISTENT'); // a case that protects the phone is consistent
  assert.equal(checkProductCopyConsistency({ brief: bank, request: { copy: [{ copy_ref: 'c', text: 'Protège ton téléphone' }] } }).status, 'CONFLICT');
  // CS-13 the limits, said: a cross-sell mention is not a contradiction, an undeclared product is not judged (and says so), the declared category wins
  assert.equal(checkProductCopyConsistency({ brief: e2eBrief(), request: { copy: [{ copy_ref: 'c', text: 'HABB propose aussi des gourdes et des boîtes cadeaux.' }] } }).status, 'CONSISTENT');
  const undeclared = checkProductCopyConsistency({ brief: e2eBrief({ public_facts: { product: 'Produit tech', merchant: 'HABB' } }), request: { copy: [{ copy_ref: 'c', text: 'Votre coque' }] } }); assert.equal(undeclared.status, 'CATEGORY_NOT_DECLARED');
  const wu = await e2eWorld({ brief: e2eBrief({ public_facts: { product: 'Produit tech', merchant: 'HABB' } }), request: single() }); const ru = await run(wu, { run_id: 'run-cs-k2' });
  assert.ok(produced.has(ru.state)); assert.ok(ru.warnings.includes('PRODUCT_COPY_CONSISTENCY_NOT_APPLICABLE')); assert.notEqual(ru.state, E2E_STATE.READY);
  assert.equal(checkProductCopyConsistency({ brief: e2eBrief({ product_category: 'POWER_BANK' }), request: { copy: [{ copy_ref: 'c', text: 'Votre coque' }] } }).status, 'CONFLICT');
});

test('One status model: the sub-statuses never contradict the final state', async () => {
  // CS-14 a produced asset is `produced`, `deliverable` only in a delivered final state; the layered run is said as what it means
  const w = await e2eWorld({ request: single() }); const ok = await run(w, { run_id: 'run-cs-s1' });
  assert.deepEqual(ok.execution, { planned: true, specified: true, produced: true, deliverable: true, layered_delivery: 'COMPLETE' });
  const w2 = await e2eWorld({ brief: noAnnotations(), request: single() }); const un = await run(w2, { run_id: 'run-cs-s2' });
  assert.equal(un.execution.layered_delivery, 'IDENTITY_NOT_MEASURED_BY_THE_CASE_GATE'); assert.equal(un.execution.deliverable, true); assert.equal(un.state, E2E_STATE.NEEDS_OWNER_REVIEW);
  const w3 = await e2eWorld({ request: single() }); const ng = await run(w3, { run_id: 'run-cs-s3', guardian: null });
  assert.equal(ng.state, E2E_STATE.BLOCKED); assert.equal(ng.execution.produced, true); assert.equal(ng.execution.deliverable, false);
  const w4 = await e2eWorld({ request: single() }); w4.ports = { ...w4.ports, layers: undefined }; const nl = await run(w4, { run_id: 'run-cs-s4' });
  assert.equal(nl.state, E2E_STATE.PROVIDER_NOT_CONNECTED); assert.deepEqual([nl.execution.produced, nl.execution.deliverable], [false, false]);
  // the invariant over every result of this file's runs: produced iff there is a final image; deliverable implies produced and a delivered state
  for (const r of [ok, un, ng, nl]) { assert.equal(r.execution.produced, Boolean(r.final)); if (r.execution.deliverable) assert.ok(produced.has(r.state)); if (!produced.has(r.state)) assert.equal(r.execution.deliverable, false); }
  // the pure helpers
  assert.deepEqual(layeredRunOf({ status: 'FIDELITY_FAIL', png_bytes: new Uint8Array(1), fidelity: { gate: 'FAIL' } }), { raw_status: 'FIDELITY_FAIL', delivery: 'A_GATE_OF_THE_LAYERED_RUN_FAILED', case_gate: 'FAIL' });
  assert.equal(layeredRunOf(null).delivery, 'NO_IMAGE'); assert.equal(executionOf({ state: 'BLOCKED', png: null, planned: true, specified: false, layered: null }).deliverable, false);
});

test('A campaign is ONE run: one campaign id, one budget, one ledger, one concept, shared layers, and each asset has its own chain', async () => {
  const w = await e2eWorld({ assets: 3, request: campaignRequest({ requested_asset_count: 3, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: LOCKED_COPY }] }) });
  const camp = (over = {}) => runCreativeCampaign({ campaign_run_id: 'camp-cs-1', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian, ...over });
  const c = await camp();
  // CS-15 orchestration: every planned asset produced, by one call, nothing passed around by the caller
  assert.ok(produced.has(c.state), JSON.stringify(c.assets.map((a) => [a.state, a.result?.block ?? a.result?.failure]))); assert.ok(c.asset_count >= 2); assert.equal(c.assets.length, c.asset_count); assert.equal(c.produced_assets, c.asset_count);
  assert.equal(c.fallback_to_generated_product, false); assert.equal(c.owner_approval, 'PENDING');
  const results = c.assets.map((a) => a.result);
  assert.equal(new Set(results.map((r) => r.campaign_id)).size, 1); assert.equal(c.campaign_id, results[0].campaign_id); assert.equal(new Set(results.map((r) => r.asset_id)).size, c.asset_count, 'each asset has its own asset id');
  assert.equal(c.shared.coherent, true); assert.equal(typeof c.shared.concept_id, 'string'); assert.equal(typeof c.shared.art_direction_id, 'string'); assert.equal(typeof c.shared.product_identity_sha256, 'string');
  // the Brain was asked once for the whole campaign (the concept and the art direction are shared), not once per asset
  const brainOps = (r) => r.provider_calls.filter((p) => p.kind === OPERATION.BRAIN_TEXT).length;
  assert.ok(brainOps(results[0]) > 0); for (const r of results.slice(1)) assert.equal(brainOps(r), 0, 'the later assets reuse the shared concept');
  // CS-16 one operation chain per asset, unique across the campaign, all under the run id of that asset
  const all = Object.values(c.operation_ids).flat(); assert.equal(new Set(all).size, all.length); for (const a of c.assets) assert.ok(c.operation_ids[a.run_id].every((id) => id.startsWith(`${a.run_id}:`)));
  // CS-17 one campaign budget: the sum of the assets, never above the ceiling, and equal to the money the operations settled
  assert.equal(c.budget.spent_eur, Math.round(results.reduce((t, r) => t + r.budget.spent_eur, 0) * 1e6) / 1e6); assert.ok(c.budget.spent_eur <= c.budget.ceiling_eur); assert.equal(c.budget.within_ceiling, true);
  assert.equal(c.budget.spent_eur, Math.round(results.flatMap((r) => r.provider_calls).reduce((t, p) => t + p.actual_eur, 0) * 1e6) / 1e6);
  // CS-18 one ledger: the campaign events and every asset's decisions are in the same one
  assert.equal(c.ledger_reference.entries > results[0].ledger_reference.entries, true);
  // CS-19 the generated layers are shared: the plate of the campaign is generated once
  const plateKeys = results.map((r) => r.layers.plate.request_key ?? r.layers.plate.node_id); assert.equal(new Set(plateKeys).size, 1);
  assert.ok(w.layers.calls.length < c.asset_count * 2, 'fewer images than a plate and a prop per asset');
});

test('The campaign budget is enforced above the assets, and a campaign resumes without paying twice', async () => {
  const mk = () => e2eWorld({ assets: 3, request: campaignRequest({ requested_asset_count: 3, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: LOCKED_COPY }] }) });
  const w = await mk();
  const camp = (world, over = {}) => runCreativeCampaign({ campaign_run_id: 'camp-cs-2', at: AT, ceiling_eur: 2, request: world.request, brief: world.brief, fonts: world.fonts, font: world.font, ports: world.ports, guardian: world.guardian, ...over });
  const full = await camp(w);
  // CS-20 a campaign ceiling just under what the whole campaign costs: the assets that cannot be paid are NOT STARTED, the state says so, the ceiling holds
  const tight = Math.round((full.budget.spent_eur - 0.01) * 100) / 100;
  const wt = await mk(); const small = await camp(wt, { campaign_run_id: 'camp-cs-3', ceiling_eur: tight });
  assert.ok(small.budget.spent_eur <= tight + 1e-9); assert.notEqual(small.state, E2E_STATE.READY); assert.ok(!produced.has(small.state) || small.produced_assets < small.asset_count || small.budget.spent_eur <= tight);
  assert.equal(small.state, E2E_STATE.BUDGET_EXCEEDED); assert.ok(small.produced_assets < small.asset_count); assert.ok(small.assets.some((a) => a.not_run || a.state === E2E_STATE.BUDGET_EXCEEDED));
  for (const a of small.assets.filter((x) => x.not_run)) assert.equal(a.result, null, 'an asset that was not started has no operation');
  // an asset cap below the cost of one asset stops at the asset ceiling, not at the campaign one
  const wc = await mk(); const capped = await camp(wc, { campaign_run_id: 'camp-cs-4', asset_ceiling_eur: 0.05 }); assert.equal(capped.state, E2E_STATE.BUDGET_EXCEEDED); assert.ok(capped.budget.spent_eur <= 0.05 * capped.assets.length + 1e-9);
  // CS-21 resume: a finished campaign resumed with dead ports gives the same images and no new operation; a campaign broken at an image resumes and the total number of images is the uninterrupted one
  const dead = await mk(); dead.ports = { ...dead.ports, layers: { ...fakeLayerPort(), generate: async () => { throw new Error('DEAD'); } }, brainComplete: async () => { throw new Error('DEAD'); }, directorComplete: async () => { throw new Error('DEAD'); } };
  const again = await camp(dead, { resume: JSON.parse(JSON.stringify(full.resume_state)) });
  assert.ok(produced.has(again.state), JSON.stringify(again.assets.map((a) => a.result?.block ?? a.result?.failure))); assert.deepEqual(again.assets.map((a) => a.result.final.png_sha256), full.assets.map((a) => a.result.final.png_sha256));
  assert.deepEqual(Object.values(again.operation_ids).map((x) => x.length), Object.values(full.operation_ids).map((x) => x.length), 'no new operation'); assert.equal(again.budget.spent_eur, full.budget.spent_eur);
  let n = 0; const base = fakeLayerPort(); const flaky = { ...base, generate: async (a) => { n += 1; if (n === 3) throw new Error('an image failed'); return base.generate(a); } };
  const wf = await mk(); wf.ports = { ...wf.ports, layers: flaky }; const broken = await camp(wf, { campaign_run_id: 'camp-cs-5' });
  assert.ok(!produced.has(broken.state) || broken.produced_assets < broken.asset_count);
  const wr = await mk(); const healed = await camp(wr, { campaign_run_id: 'camp-cs-5', resume: JSON.parse(JSON.stringify(broken.resume_state)) });
  assert.ok(produced.has(healed.state), JSON.stringify(healed.assets.map((a) => a.result?.block ?? a.result?.failure))); assert.equal(healed.produced_assets, healed.asset_count);
  assert.equal(wf.layers.calls.length + wr.layers.calls.length >= 1, true); assert.equal(n - 1 + wr.layers.calls.length, w.layers.calls.length, 'no image was paid twice: the images before the failure plus the images after equal the uninterrupted campaign');
  // CS-22 the campaign refuses what is not a campaign run
  assert.equal((await camp(w, { campaign_run_id: 'x' })).failure.code, 'CAMPAIGN_RUN_ID_INVALID'); assert.equal((await camp(w, { ceiling_eur: -1 })).failure.code, 'CEILING_INVALID');
  assert.equal((await camp(w, { campaign_run_id: 'camp-cs-9', resume: JSON.parse(JSON.stringify(full.resume_state)) })).failure.code, 'RESUME_STATE_IS_NOT_THIS_CAMPAIGN');
});

test('A campaign whose plan cannot be produced stops once, with the cause, and starts nothing else', async () => {
  // CS-23 no layer provider: the same cause for every asset, reported once, nothing paid
  const w = await e2eWorld({ assets: 3, request: campaignRequest({ requested_asset_count: 3, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: LOCKED_COPY }] }) }); w.ports = { ...w.ports, layers: undefined };
  const c = await runCreativeCampaign({ campaign_run_id: 'camp-cs-6', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian });
  assert.equal(c.state, E2E_STATE.PROVIDER_NOT_CONNECTED); assert.equal(c.produced_assets, 0); assert.equal(c.budget.spent_eur, 0); assert.equal(w.brainPort.calls.length, 0);
  // a product/copy conflict is a stop of the plan, with the asset count unknown: ONE blocked result, no other asset is started
  const bank = e2eBrief({ public_facts: { product: 'Batterie externe 20000 mAh', merchant: 'HABB' } }); const wb = await e2eWorld({ brief: bank, request: campaignRequest({ requested_asset_count: 3, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: `Votre photo sur votre coque. ${LOCKED_COPY}` }] }) });
  const cb = await runCreativeCampaign({ campaign_run_id: 'camp-cs-7', at: AT, ceiling_eur: 2, request: wb.request, brief: wb.brief, fonts: wb.fonts, font: wb.font, ports: wb.ports, guardian: wb.guardian });
  assert.equal(cb.state, E2E_STATE.BLOCKED); assert.equal(cb.assets.length, 1); assert.equal(cb.assets[0].result.block.code, 'PRODUCT_COPY_CONFLICT'); assert.equal(wb.brainPort.calls.length, 0);
});
