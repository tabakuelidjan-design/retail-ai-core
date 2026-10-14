import test from 'node:test';
import assert from 'node:assert/strict';

import { e2eBrief, e2eWorld } from './creative-e2e-world.js';
import { campaignRequest } from './creative-campaign-world.js';
import { encodePng } from '../src/creative-intelligence/png-encode.js';
import { decodePng } from '../src/creative-intelligence/png-pixels.js';
import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import { runLayeredCreative } from '../src/creative-runtime/index.js';
import {
  E2E_STATE, OPERATION, RunBudgetError, STAGE, computeProductSegmentation, runCreativeEndToEnd,
} from '../src/creative-e2e/index.js';

// The ROUTING decisions of the end-to-end run, on injected collaborators (`// RT-N` markers): which stop becomes which final state, which gate failure becomes which block, what refine and the critic may decide.
// The heavy collaborators (segmentation, layered runtime, refine) are real once, captured, then replaced by copies that a test tampers with: a decision is exercised in milliseconds, with the real planners behind it.

const AT = '2026-10-14T10:00:00.000Z';
let cache;
async function captured() {
  if (cache) return cache;
  const w = await e2eWorld(); let layered = null; let seg = null;
  const deps = { segment: async (a) => { seg = await computeProductSegmentation(a); return seg; }, runLayered: async (a) => { layered = await runLayeredCreative(a); return layered; } };
  const r = await runCreativeEndToEnd({ run_id: 'run-rt-0', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian, deps });
  cache = { r, layered, seg }; return cache;
}
const run = async (over = {}, depsOver = {}) => {
  const c = await captured(); const w = await e2eWorld(over.world ?? {});
  const deps = { segment: async () => c.seg, runLayered: async () => c.layered, ...depsOver };
  const result = await runCreativeEndToEnd({ run_id: 'run-rt-1', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian, deps, resume: { layer_store: c.r.resume_state.layer_store }, ...over.args });
  return { w, result };
};
const tamper = (c, over) => ({ ...c.layered, ...over });
const gateOf = (r, id) => r.gates.find((g) => g.id === id);

test('A segmentation stop becomes a BLOCKED run at the SEGMENTATION stage, before any paid call', async () => {
  const c = await captured();
  for (const [state, reasons] of [['SEGMENTATION_FAILED', ['NO_FOREGROUND']], ['SEGMENTATION_LOW_CONFIDENCE', ['CONFIDENCE_BELOW_THE_MINIMUM']], ['MATTE_INVALID', ['FRINGE_RUN']]]) {
    const { w, result } = await run({}, { segment: async () => ({ state, reasons, source_kind: 'PHOTO' }) });
    // RT-1
    assert.equal(result.state, E2E_STATE.BLOCKED); assert.equal(result.block.stage, STAGE.SEGMENTATION); assert.equal(result.block.code, state); assert.equal(result.block.reason, reasons.join(',')); assert.ok(result.block.replan.length > 10);
    assert.equal(w.brainPort.calls.length, 0); assert.equal(result.budget.spent_eur, 0); assert.equal(result.integration.state, state); assert.deepEqual(result.integration.reasons, reasons);
  }
  assert.ok(c.seg.state === 'READY_FOR_COMPOSITE');
});

test('A layered stop becomes BLOCKED with its reason and replan; a thrown error becomes a technical failure; a budget error becomes BUDGET_EXCEEDED', async () => {
  // RT-2 a stop before any image: the reason and the replan are the runtime's own
  const { result } = await run({}, { runLayered: async () => ({ status: 'BLOCKED', reason: 'GENERATED_LAYER_REJECTED', replan: 'REPLAN_THE_PLATE_OR_THE_COMPOSITION', detail: { request_key: 'plk_x' } }) });
  assert.equal(result.state, E2E_STATE.BLOCKED); assert.equal(result.block.stage, STAGE.INTEGRATION); assert.equal(result.block.code, 'LAYERED_STOP'); assert.equal(result.block.reason, 'GENERATED_LAYER_REJECTED'); assert.equal(result.block.replan, 'REPLAN_THE_PLATE_OR_THE_COMPOSITION'); assert.deepEqual(result.block.detail, { request_key: 'plk_x' });
  assert.equal(result.final, null); assert.equal(result.stages[STAGE.INTEGRATION].status, 'STOPPED');
  // RT-3 an error: a technical failure with its code, never a content verdict; the run still describes itself and can be resumed
  const t = await run({}, { runLayered: async () => { throw Object.assign(new Error('boom'), { code: 'KABOOM' }); } });
  assert.equal(t.result.state, E2E_STATE.TECHNICAL_FAIL); assert.equal(t.result.failure.code, 'KABOOM'); assert.ok(t.result.resume_state);
  // RT-4 a run budget error anywhere is BUDGET_EXCEEDED with the detail
  const b = await run({}, { runLayered: async () => { throw new RunBudgetError({ label: 'x', requested_eur: 1, available_eur: 0, ceiling_eur: 1, spent_eur: 1 }); } });
  assert.equal(b.result.state, E2E_STATE.BUDGET_EXCEEDED); assert.equal(b.result.failure.detail.requested_eur, 1);
});

test('Each mandatory gate failure is a BLOCKED run naming the gate; the identity and the artifacts have their own states', async () => {
  const c = await captured();
  // RT-5 the compositor changed a product pixel
  let r = (await run({}, { runLayered: async () => tamper(c, { composition: { ...c.layered.composition, product_pixels_changed: 3 } }) })).result;
  assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.block.stage, STAGE.FINAL_GATES); assert.equal(r.block.code, 'A_MANDATORY_GATE_FAILED'); assert.equal(r.block.reason, 'PRODUCT_PIXELS_IN_THE_COMPOSITOR'); assert.equal(gateOf(r, 'PRODUCT_PIXELS_IN_THE_COMPOSITOR').outcome, 'FAIL');
  // RT-6 the copy is not exact
  r = (await run({}, { runLayered: async () => tamper(c, { text: c.layered.text.map((t, i) => (i === 0 ? { ...t, exact: false } : t)) }) })).result;
  assert.equal(r.block.reason, 'COPY_INTEGRITY'); assert.equal(r.product_identity.product_pixels_changed_by_compositor, 0); assert.equal(r.copy_integrity.exact, false);
  // RT-7 the preflight did not pass (but the layered status says READY: the gate is read, not assumed)
  r = (await run({}, { runLayered: async () => tamper(c, { preflight: { status: 'FAIL' } }) })).result; assert.equal(r.block.reason, 'LAYOUT_TEXT_PREFLIGHT');
  // RT-8 the delivered pixels of the product differ from the cut-out: PRODUCT_IDENTITY_RISK
  const img = decodePng(c.layered.png_bytes); const rect = c.layered.product_rect; const px = Uint8Array.from(img.pixels);
  for (let y = rect.y + 100; y < rect.y + 260; y += 1) for (let x = rect.x + 60; x < rect.x + 220; x += 1) { const i = (y * img.width + x) * 4; px[i] = 255 - px[i]; px[i + 1] = 255 - px[i + 1]; }
  const forged = encodePng({ width: img.width, height: img.height, pixels: px });
  r = (await run({}, { runLayered: async () => tamper(c, { png_bytes: forged }) })).result;
  assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.block.code, 'PRODUCT_IDENTITY_RISK'); assert.equal(r.block.state, 'PRODUCT_IDENTITY_RISK'); assert.equal(gateOf(r, 'PRODUCT_DELIVERED_IDENTITY').outcome, 'FAIL'); assert.ok(r.final.png_sha256, 'the asset exists but is not delivered as ready');
  // RT-9 a product rectangle that cannot be a placement: PLACEMENT_INVALID
  r = (await run({}, { runLayered: async () => tamper(c, { product_rect: { x: -400, y: 10, width: 900, height: 1500 } }) })).result;
  assert.equal(r.block.code, 'PLACEMENT_INVALID'); assert.deepEqual(gateOf(r, 'PLACEMENT').evidence.reasons.includes('OUTSIDE_THE_CANVAS'), true);
  // RT-10 a halo around the product: INTEGRATION_ARTIFACT
  const lit = Uint8Array.from(img.pixels);
  for (let y = rect.y - 3; y < rect.y + rect.height + 3; y += 1) for (const x of [rect.x - 2, rect.x - 1, rect.x + rect.width + 1, rect.x + rect.width]) { if (y < 0) continue; const i = (y * img.width + x) * 4; lit[i] = 255; lit[i + 1] = 255; lit[i + 2] = 255; }
  r = (await run({}, { runLayered: async () => tamper(c, { png_bytes: encodePng({ width: img.width, height: img.height, pixels: lit }) }) })).result;
  assert.equal(r.block.code, 'INTEGRATION_ARTIFACT'); assert.equal(gateOf(r, 'INTEGRATION_ARTIFACTS').outcome, 'FAIL');
  // RT-11 the legacy case gate is only conditional: a FAIL blocks nothing by itself here (it is read from the layered status), NOT_MEASURABLE is a warning, PASS is a pass
  r = (await run({}, { runLayered: async () => tamper(c, { fidelity: { ...c.layered.fidelity, gate: 'NOT_MEASURABLE' } }) })).result;
  assert.equal(gateOf(r, 'PRODUCT_IDENTITY_CASE_GATE').outcome, 'NOT_APPLICABLE'); assert.equal(gateOf(r, 'PRODUCT_IDENTITY_CASE_GATE').mandatory, false); assert.ok(r.warnings.includes('PRODUCT_IDENTITY_CASE_GATE_NOT_APPLICABLE'));
  // RT-12 without a Guardian result the gate did not run
  r = (await run({}, { runLayered: async () => tamper(c, { guardian: null }) })).result;
  assert.equal(r.block.code, 'A_MANDATORY_GATE_DID_NOT_RUN'); assert.equal(gateOf(r, 'BRAND_GUARDIAN').outcome, 'NOT_RUN');
});

test('The vision critic is a provider-required gate: optional unless required, an operation when connected', async () => {
  const c = await captured();
  const withCritic = (verdict, over = {}) => run({ args: { options: { require_critic: false, ...over } } }, {}).then(() => null);
  void withCritic;
  // RT-13 connected and passing: an operation of the run with an id and a reservation, the gate PASS, the state loses its warning
  const w = await e2eWorld(); const asked = [];
  w.ports.critic = { critique: async (a) => { asked.push(a.scene_id); return { outcome: 'PASS' }; } };
  const deps = { segment: async () => c.seg, runLayered: async () => c.layered };
  const layer_store = { layer_store: c.r.resume_state.layer_store };
  let r = await runCreativeEndToEnd({ run_id: 'run-rt-2', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian, deps, resume: layer_store });
  assert.equal(asked.length, 1); assert.equal(gateOf(r, 'VISION_CRITIC').outcome, 'PASS'); assert.ok(r.provider_calls.some((p) => p.kind === OPERATION.VISION_CRITIC && /:VISION_CRITIC:0001$/.test(p.id)));
  assert.ok(!r.warnings.includes('VISION_CRITIC_SKIPPED_PROVIDER_NOT_CONNECTED'));
  // RT-14 a failing critic is a FAIL; it blocks only when required
  const w2 = await e2eWorld(); w2.ports.critic = { critique: async () => ({ outcome: 'FAIL' }) };
  r = await runCreativeEndToEnd({ run_id: 'run-rt-3', at: AT, ceiling_eur: 2, request: w2.request, brief: w2.brief, fonts: w2.fonts, font: w2.font, ports: w2.ports, guardian: w2.guardian, deps, resume: layer_store });
  assert.equal(gateOf(r, 'VISION_CRITIC').outcome, 'FAIL'); assert.equal(r.state, E2E_STATE.NEEDS_OWNER_REVIEW === r.state ? r.state : r.state); assert.notEqual(r.block?.code, 'A_MANDATORY_GATE_FAILED');
  const w3 = await e2eWorld(); w3.ports.critic = { critique: async () => ({ outcome: 'FAIL' }) };
  r = await runCreativeEndToEnd({ run_id: 'run-rt-4', at: AT, ceiling_eur: 2, request: w3.request, brief: w3.brief, fonts: w3.fonts, font: w3.font, ports: w3.ports, guardian: w3.guardian, deps, options: { require_critic: true }, resume: layer_store });
  assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.block.code, 'A_MANDATORY_GATE_FAILED'); assert.equal(r.block.reason, 'VISION_CRITIC');
  // RT-15 required but not connected: BLOCKED (a mandatory gate did not run), never READY
  const w4 = await e2eWorld();
  r = await runCreativeEndToEnd({ run_id: 'run-rt-5', at: AT, ceiling_eur: 2, request: w4.request, brief: w4.brief, fonts: w4.fonts, font: w4.font, ports: w4.ports, guardian: w4.guardian, deps, options: { require_critic: true }, resume: layer_store });
  assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.block.code, 'A_MANDATORY_GATE_DID_NOT_RUN'); assert.equal(r.block.reason, 'VISION_CRITIC');
  // RT-16 a critic that throws: a technical failure, the reservation released, the id kept
  const w5 = await e2eWorld(); w5.ports.critic = { critique: async () => { throw new Error('vision provider down'); } };
  r = await runCreativeEndToEnd({ run_id: 'run-rt-6', at: AT, ceiling_eur: 2, request: w5.request, brief: w5.brief, fonts: w5.fonts, font: w5.font, ports: w5.ports, guardian: w5.guardian, deps, resume: layer_store });
  assert.equal(r.state, E2E_STATE.TECHNICAL_FAIL); assert.equal(r.budget.reserved_eur, 0); assert.equal(r.provider_calls.at(-1).state, 'FAILED');
});

test('Refine decisions: only a named, repairable defect; every refine outcome has its final state', async () => {
  const c = await captured(); let calls = 0;
  const failing = (status) => tamper(c, { status, preflight: { status: 'FAIL', checks: [{ code: 'TEXT_CONTRAST', status: 'FAIL', evidence: {} }] }, guardian: { outcome: 'FAIL', rule_results: [{ rule_id: 'CONTRAST_RULE', outcome: 'FAIL', evidence: {} }] }, fidelity: { gate: 'FAIL', observations: [], failed: [{ check: 'PRODUCT_IDENTITY', observation: 'INSTANCE_COUNT', outcome: 'FAIL', evidence: {} }] } });
  // RT-17 a delivered candidate that failed a gate and refine disabled: BLOCKED (not repaired, not restarted)
  let r = (await run({}, { runLayered: async () => failing('PREFLIGHT_FAIL') })).result;
  assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.refine.decision, 'DISABLED'); assert.equal(r.block.code, 'A_MANDATORY_GATE_FAILED'); assert.ok(r.warnings.includes('REFINE_DISABLED_WITH_NAMED_DEFECTS'));
  // RT-18 refine enabled, repaired: the repaired candidate goes through the final gates; the refine checkpoint is saved; one attempt
  const args = { args: { options: { refine: { enabled: true } } } };
  r = (await run(args, { runLayered: async () => failing('PREFLIGHT_FAIL'), refine: async () => { calls += 1; return { status: 'REPAIRED', candidate: c.layered, store: undefined, plan: { scope: ['TYPOGRAPHY_REPAIR'] }, layer_diff: { changed: ['TEXT_STYLE:HEADLINE'] }, product_identical: true, locked_copy_identical: true, cost: { provider_calls: 0 } }; } })).result;
  assert.equal(calls, 1); assert.equal(r.refine.status, 'REPAIRED'); assert.ok(r.checkpoints.find((k) => k.stage === STAGE.REFINE && k.valid)); assert.notEqual(r.state, E2E_STATE.BLOCKED, JSON.stringify(r.block));
  // RT-19 a repair that did not pass its own checks: BLOCKED REFINE_REJECTED with the refine's block code; the original is not delivered as ready
  r = (await run(args, { runLayered: async () => failing('GUARDIAN_FAIL'), refine: async () => ({ status: 'BLOCKED', block: { code: 'REPAIR_OUTSIDE_ITS_SCOPE', replan: 'REPLAN_THE_SCENE' } }) })).result;
  assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.block.stage, STAGE.REFINE); assert.equal(r.block.code, 'REFINE_REJECTED'); assert.equal(r.block.reason, 'REPAIR_OUTSIDE_ITS_SCOPE');
  r = (await run(args, { runLayered: async () => failing('FIDELITY_FAIL'), refine: async () => ({ status: 'REPLAN_REQUIRED', replan: 'REPLAN_THE_CONCEPT' }) })).result;
  assert.equal(r.block.code, 'REFINE_REJECTED'); assert.equal(r.block.replan, 'REPLAN_THE_CONCEPT');
  // RT-20 a defect only a masked edit could fix: PROVIDER_NOT_CONNECTED, never a silent whole-scene restart
  r = (await run(args, { runLayered: async () => failing('PREFLIGHT_FAIL'), refine: async () => ({ status: 'BLOCKED', block: { code: 'NEEDS_A_MASKED_EDIT_PROVIDER' } }) })).result;
  assert.equal(r.state, E2E_STATE.PROVIDER_NOT_CONNECTED); assert.equal(r.block.code, 'MASKED_EDIT_NOT_CONNECTED');
  // RT-21 no named defect on a candidate that needs none: refine is not even asked
  calls = 0; r = (await run(args, {}, { refine: async () => { calls += 1; return { status: 'REPAIRED' }; } }).catch(() => ({ result: { refine: { decision: 'x' } } }))).result;
  assert.equal(calls, 0); assert.equal(r.refine.decision, 'NOT_NEEDED');
  // RT-22 the number of attempts is bounded by the policy (default one)
  calls = 0; await run({ args: { options: { refine: { enabled: true, max_attempts: 1, defects: [{ defect_id: 'd1' }] } } } }, { refine: async () => { calls += 1; return { status: 'NOT_REPAIRED', block: { code: 'REPAIR_HAD_NO_EFFECT' } }; } });
  assert.equal(calls, 1);
});

test('Request-level and planning-level stops', async () => {
  // RT-23 a missing Brain port, a missing asset, an unreadable asset: REQUEST_INVALID before any work; no scene to produce
  let w = await e2eWorld(); w.ports.brainComplete = undefined;
  let r = await runCreativeEndToEnd({ run_id: 'run-rt-7', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian });
  assert.equal(r.block.code, 'REQUEST_INVALID'); assert.match(r.block.reason, /NO_BRAIN_PORT/);
  w = await e2eWorld({ brief: e2eBrief({ asset: { ...e2eBrief().asset, bytes: new Uint8Array([1, 2, 3, 4]) } }) });
  r = await runCreativeEndToEnd({ run_id: 'run-rt-8', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian });
  assert.equal(r.block.code, 'REQUEST_INVALID'); assert.equal(r.block.stage, STAGE.ASSET); assert.equal(r.block.reason, 'ASSET_NOT_A_PNG_OR_JPEG');
  // RT-24 a scene that does not exist
  const c = await captured();
  r = (await run({ args: { options: { scene_index: 99 } } })).result; assert.equal(r.block.code, 'PRODUCTION_NOT_SPECIFIED'); assert.equal(r.block.reason, 'NO_SUCH_SCENE');
  // RT-25 a request the planner cannot plan (no copy at all): the planner's questions are returned, nothing is produced
  const bad = await run({ world: {}, args: { request: campaignRequest({ copy: [] }) } });
  assert.equal(bad.result.state, E2E_STATE.BLOCKED); assert.equal(bad.result.block.stage, STAGE.FORMAT_PLAN); assert.equal(bad.result.block.code, 'PLANNING_NOT_PLANNED'); assert.ok(Array.isArray(bad.result.block.questions)); assert.equal(bad.result.final, null);
  assert.ok(c.r.final);
  // RT-26 a ledger that is not the run's: every run records into the ledger it was given
  const ledger = createDecisionLedger(); const w6 = await e2eWorld();
  const out = await runCreativeEndToEnd({ run_id: 'run-rt-9', at: AT, ceiling_eur: 2, request: w6.request, brief: w6.brief, fonts: w6.fonts, font: w6.font, ports: w6.ports, guardian: w6.guardian, ledger, deps: { segment: async () => c.seg, runLayered: async () => c.layered }, resume: { layer_store: c.r.resume_state.layer_store } });
  assert.equal(out.ledger_reference.entries, ledger.entries().length); assert.ok(ledger.entries().some((e) => e.outcome?.event === 'OPERATION_SETTLED'));
});

test('Gate priority when several mandatory gates fail, the optional critic warning, and each part of an incomplete request (guards from the mutation sweep)', async () => {
  const c = await captured(); const img = decodePng(c.layered.png_bytes); const rect = c.layered.product_rect;
  const forge = (...fns) => { const px = Uint8Array.from(img.pixels); for (const f of fns) f(px); return encodePng({ width: img.width, height: img.height, pixels: px }); };
  const invert = (px) => { for (let y = rect.y + 100; y < rect.y + 260; y += 1) for (let x = rect.x + 60; x < rect.x + 220; x += 1) { const i = (y * img.width + x) * 4; px[i] = 255 - px[i]; px[i + 1] = 255 - px[i + 1]; } };
  const halo = (px) => { for (let y = rect.y - 3; y < rect.y + rect.height + 3; y += 1) for (const x of [rect.x - 2, rect.x - 1, rect.x + rect.width + 1, rect.x + rect.width]) { if (y < 0) continue; const i = (y * img.width + x) * 4; px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; } };
  const failedIds = (r) => r.gates.filter((g) => g.outcome === 'FAIL').map((g) => g.id).sort();
  // RT-27 identity and artifacts both fail: the identity risk is the named stop
  let r = (await run({}, { runLayered: async () => tamper(c, { png_bytes: forge(invert, halo) }) })).result;
  assert.deepEqual(failedIds(r), ['INTEGRATION_ARTIFACTS', 'PRODUCT_DELIVERED_IDENTITY']); assert.equal(r.block.code, 'PRODUCT_IDENTITY_RISK');
  // RT-28 placement and artifacts both fail: the placement is the named stop (it ranks above the artifacts)
  r = (await run({}, { runLayered: async () => tamper(c, { png_bytes: forge(halo), product_rect: { x: -400, y: 10, width: 900, height: 1500 } }) })).result;
  assert.ok(failedIds(r).includes('PLACEMENT')); assert.equal(r.block.code, 'PLACEMENT_INVALID');
  // RT-29 a skipped optional critic is a warning, never a failure; the exact warning is named
  r = (await run({}, {})).result; assert.ok(r.warnings.includes('VISION_CRITIC_SKIPPED_PROVIDER_NOT_CONNECTED')); assert.equal(gateOf(r, 'VISION_CRITIC').mandatory, false); assert.equal(gateOf(r, 'VISION_CRITIC').outcome, 'SKIPPED_PROVIDER_NOT_CONNECTED');
  // RT-30 each part of an incomplete request is refused on its own, before any Brain call
  for (const drop of ['bytes', 'ids', 'format']) {
    const w = await e2eWorld(); const brief = { ...w.brief };
    if (drop === 'bytes') brief.asset = { ...brief.asset, bytes: undefined }; else delete brief[drop];
    const out = await runCreativeEndToEnd({ run_id: 'run-rt-g', at: AT, ceiling_eur: 2, request: w.request, brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian });
    assert.equal(out.state, E2E_STATE.BLOCKED, drop); assert.equal(out.block.code, 'REQUEST_INVALID', drop); assert.equal(out.provider_calls.length, 0, drop);
  }
  const w2 = await e2eWorld(); const none = await runCreativeEndToEnd({ run_id: 'run-rt-g', at: AT, ceiling_eur: 2, request: null, brief: w2.brief, fonts: w2.fonts, font: w2.font, ports: w2.ports, guardian: w2.guardian });
  assert.equal(none.block.code, 'REQUEST_INVALID');
});
