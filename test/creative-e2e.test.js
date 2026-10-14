import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as IW from './creative-integration-world.js';
import { e2eBrief, e2eWorld } from './creative-e2e-world.js';
import { fakeLayerPort, propOnGround } from './creative-layered-runtime-world.js';
import { DEFECT_KIND, DEFECT_SOURCE, createDefectRegion } from '../src/creative-refine/index.js';
import { encodePng } from '../src/creative-intelligence/png-encode.js';
import { prepareAsset } from '../src/creative-e2e/asset.js';
import {
  E2E_STATE, OPERATION, STAGE, STAGE_ORDER, describeEndToEnd, runCreativeEndToEnd,
} from '../src/creative-e2e/index.js';
import { segmentProduct } from '../src/creative-integration/index.js';

// The END-TO-END run, provider-free (`// E2-N` markers): request → asset → real-product segmentation → format → Brain → production plan → layered production with the integrated product → refine decision → final
// gates → ONE result contract. Every provider is a scripted fake that counts its calls.

const sha = (b) => createHash('sha256').update(b).digest('hex');
const AT = '2026-10-14T10:00:00.000Z';
const run = (w, over = {}) => runCreativeEndToEnd({
  run_id: 'run-e2e-1', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian, ...over,
});
const pngOf = (rgba) => encodePng({ width: rgba.width, height: rgba.height, pixels: rgba.pixels });
const imageOps = (r) => r.provider_calls.filter((c) => c.kind === OPERATION.IMAGE_GENERATION);
const textOps = (r) => r.provider_calls.filter((c) => [OPERATION.BRAIN_TEXT, OPERATION.ASSET_DIRECTOR_TEXT].includes(c.kind));

let baseline;
const getBaseline = async () => { if (!baseline) { const w = await e2eWorld(); baseline = { w, r: await run(w) }; } return baseline; };

test('A full provider-free run produces one coherent result: one run id, one ledger, one budget, unique operation ids, no duplicate provider work', async () => {
  const { w, r } = await getBaseline();
  // E2-1 the final state is explicit: a produced asset whose only open point is the provider-required critic (a warning), never an ambiguous success
  assert.equal(r.state, E2E_STATE.NEEDS_OWNER_REVIEW, JSON.stringify(r.block));
  assert.deepEqual(r.warnings, ['VISION_CRITIC_SKIPPED_PROVIDER_NOT_CONNECTED']); assert.equal(r.owner_approval, 'PENDING'); assert.equal(r.fallback_to_generated_product, false);
  // E2-2 the contract is complete
  for (const k of ['schema', 'state', 'run_id', 'asset_id', 'campaign_id', 'format', 'final', 'source_provenance', 'product_identity', 'copy_integrity', 'integration', 'refine', 'gates', 'budget', 'provider_calls', 'operation_ids', 'ledger_reference', 'warnings', 'owner_approval', 'stages', 'checkpoints', 'resume_state', 'layers', 'selection']) assert.ok(k in r, k);
  assert.equal(r.run_id, 'run-e2e-1'); assert.ok(r.campaign_id && r.asset_id); assert.equal(r.final.status_of_layered_run, 'READY_FOR_REVIEW'); assert.match(r.final.png_sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.product_identity.identity_status, 'VERIFIED'); assert.equal(r.product_identity.product_pixels_changed_by_compositor, 0); assert.equal(r.copy_integrity.exact, true);
  // E2-3 every stage ran, in the declared order, each with a checkpoint
  assert.deepEqual(r.checkpoints.map((c) => c.stage), STAGE_ORDER.filter((s) => s !== STAGE.REFINE)); // REFINE has a checkpoint only when a repair was accepted assert.ok(r.checkpoints.every((c) => c.valid));
  // E2-4 operation ids: all prefixed by the run id, all unique, counted per kind
  assert.ok(r.operation_ids.every((id) => id.startsWith('run-e2e-1:'))); assert.equal(new Set(r.operation_ids).size, r.operation_ids.length);
  // E2-5 no duplicate provider work: what each fake port was asked is exactly what the run settled
  assert.equal(w.brainPort.calls.length, textOps(r).length); assert.equal(w.layers.calls.length, imageOps(r).length); assert.ok(textOps(r).length >= 5 && imageOps(r).length >= 2);
  assert.ok(r.provider_calls.every((c) => c.state === 'SETTLED'));
  // E2-6 ONE budget: the spent amount is the sum of the settled operations, below the ceiling, nothing left reserved
  const sum = r.provider_calls.reduce((t, c) => t + c.actual_eur, 0);
  assert.ok(Math.abs(r.budget.spent_eur - sum) < 1e-9); assert.equal(r.budget.reserved_eur, 0); assert.ok(r.budget.spent_eur < r.budget.ceiling_eur);
  // E2-7 ONE ledger: it carries the run events AND the stages' own decisions (planner, brain, runtime) in one list
  assert.ok(r.ledger_reference.entries > 30);
});

test('The integration is the general segmentation, not the annotated outline; the gates are named, ordered and not skipped', async () => {
  const { r } = await getBaseline();
  // E2-8 the product was cut by the integration segmentation (photograph path on this plain-ground photo), before any billable call
  assert.equal(r.integration.source_kind, 'PHOTO'); assert.equal(r.integration.state, 'READY_FOR_COMPOSITE'); assert.equal(r.integration.evidence.matte_checks, 14);
  const ids = r.operation_ids; assert.equal(ids.findIndex((id) => id.includes(':LOCAL:')), 0); assert.ok(ids.findIndex((id) => id.includes(':BRAIN_TEXT:')) > ids.findIndex((id) => id.includes(':LOCAL:')));
  // E2-9 the gates: every mandatory gate ran and passed; the case-specific gate and the provider-required critic are labelled
  const byId = Object.fromEntries(r.gates.map((g) => [g.id, g]));
  for (const id of ['PLACEMENT', 'PRODUCT_DELIVERED_IDENTITY', 'PRODUCT_PIXELS_IN_THE_COMPOSITOR', 'COPY_INTEGRITY', 'LAYOUT_TEXT_PREFLIGHT', 'INTEGRATION_ARTIFACTS', 'BRAND_GUARDIAN']) { assert.equal(byId[id].mandatory, true, id); assert.equal(byId[id].outcome, 'PASS', id); assert.equal(byId[id].status, 'EXECUTABLE_NOW', id); }
  assert.equal(byId.VISION_CRITIC.status, 'PROVIDER_REQUIRED'); assert.equal(byId.VISION_CRITIC.outcome, 'SKIPPED_PROVIDER_NOT_CONNECTED');
  // E2-10 the grade is not applied in the layered flow (its identity gate demands the exact colours): said, not hidden
  assert.equal(r.integration.grade, 'NOT_APPLIED_IN_THE_LAYERED_FLOW');
  // E2-11 refine was not needed (no named defect), and says so
  assert.equal(r.refine.decision, 'NOT_NEEDED');
});

test('Deterministic: the same run twice gives the same asset and the same operation ids', async () => {
  const { r } = await getBaseline(); const w2 = await e2eWorld(); const r2 = await run(w2);
  // E2-12
  assert.equal(r2.final.png_sha256, r.final.png_sha256); assert.deepEqual(r2.operation_ids, r.operation_ids); assert.deepEqual(r2.gates.map((g) => g.outcome), r.gates.map((g) => g.outcome));
});

test('Resume: a finished run resumed with ports that would fail repeats nothing; a run broken in the middle resumes without paying twice', async () => {
  const { r } = await getBaseline();
  // E2-13 resume of a completed run: the ports are unusable, the result is the same, no new provider operation
  const dead = await e2eWorld();
  dead.ports = { brainComplete: async () => { throw new Error('the Brain must not be called'); }, directorComplete: async () => { throw new Error('no'); }, layers: { executes: dead.layers.executes, live: false, generate: async () => { throw new Error('the layer generator must not be called'); } } };
  const resumed = await run(dead, { resume: JSON.parse(JSON.stringify(r.resume_state)) });
  assert.equal(resumed.state, r.state, JSON.stringify(resumed.block ?? resumed.failure)); assert.equal(resumed.final.png_sha256, r.final.png_sha256);
  assert.equal(resumed.provider_calls.length, r.provider_calls.length); assert.equal(resumed.budget.spent_eur, r.budget.spent_eur);
  assert.equal(resumed.stages[STAGE.SEGMENTATION].status, 'REUSED');
  // E2-14 a run broken after the plate was generated: the layer provider fails on the 2nd image
  let n = 0; const flaky = fakeLayerPort(); const original = flaky.generate;
  const broken = await e2eWorld(); broken.ports.layers = { executes: flaky.executes, live: false, generate: async (a) => { n += 1; if (n === 2) throw Object.assign(new Error('provider timeout'), { code: 'PROVIDER_TIMEOUT' }); return original(a); } };
  const first = await run(broken);
  assert.equal(first.state, E2E_STATE.TECHNICAL_FAIL); assert.equal(first.failure.code, 'PROVIDER_TIMEOUT');
  const settledBefore = imageOps(first).filter((o) => o.state === 'SETTLED').length; assert.equal(settledBefore, 1); assert.equal(imageOps(first).at(-1).state, 'FAILED');
  assert.equal(first.budget.reserved_eur, 0); // the failed operation released its reservation
  // the plans and the segmentation of the broken run are intact checkpoints
  for (const s of [STAGE.REQUEST, STAGE.ASSET, STAGE.SEGMENTATION, STAGE.FORMAT_PLAN, STAGE.BRAIN_PLAN, STAGE.PRODUCTION_PLAN]) assert.ok(first.checkpoints.find((c) => c.stage === s && c.valid), s);
  assert.equal(first.checkpoints.find((c) => c.stage === STAGE.INTEGRATION), undefined);
  // resume with a healthy provider: the settled plate is NOT generated again, the brain is not asked again, and the total equals an uninterrupted run
  const healthy = await e2eWorld(); healthy.ports = { ...healthy.ports, brainComplete: async () => { throw new Error('the Brain must not be called again'); }, directorComplete: async () => { throw new Error('no'); } };
  const second = await run(healthy, { resume: JSON.parse(JSON.stringify(first.resume_state)) });
  assert.equal(second.state, r.state, JSON.stringify(second.block ?? second.failure)); assert.equal(second.final.png_sha256, r.final.png_sha256);
  assert.equal(imageOps(second).filter((o) => o.state === 'SETTLED').length, imageOps(r).length); assert.equal(healthy.layers.calls.length, imageOps(r).length - settledBefore);
  assert.equal(new Set(second.operation_ids).size, second.operation_ids.length);
});

test('The budget is one: a ceiling stops the run before the work that would pass it', async () => {
  // E2-15 a ceiling of 0.2 EUR: the planning text calls are paid, the first image reservation is refused, nothing passes the ceiling
  const w = await e2eWorld(); const r = await run(w, { ceiling_eur: 0.2 });
  assert.equal(r.state, E2E_STATE.BUDGET_EXCEEDED, JSON.stringify(r.block ?? r.failure)); assert.ok(r.budget.spent_eur <= 0.2); assert.equal(r.budget.reserved_eur, 0); assert.equal(w.layers.calls.length, 0);
  assert.equal(r.failure.code, 'BUDGET_EXCEEDED'); assert.equal(r.failure.detail.source, 'THE_CAMPAIGN_PLANNER_ESTIMATE_EXCEEDS_THE_RUN_CEILING');
  // E2-16 a ceiling of zero stops before the first paid text call
  const w0 = await e2eWorld(); const r0 = await run(w0, { ceiling_eur: 0 }); assert.equal(r0.state, E2E_STATE.BUDGET_EXCEEDED); assert.equal(w0.brainPort.calls.length, 0); assert.equal(r0.budget.spent_eur, 0);
});

test('Nothing is paid for a product that cannot be cut out; every segmentation stop is explicit', async () => {
  const stopAt = async (asset, over = {}) => { const w = await e2eWorld({ brief: e2eBrief({ asset: { ...e2eBrief().asset, bytes: asset, sha256: sha(asset) }, identity_annotations: undefined }) }); const r = await run(w, over); return { w, r }; };
  // E2-17 a cluttered ground: SEGMENTATION_FAILED at the SEGMENTATION stage; no Brain call, no image call, nothing spent
  const clutter = await stopAt(pngOf(IW.clutteredGround().rgba));
  assert.equal(clutter.r.state, E2E_STATE.BLOCKED); assert.equal(clutter.r.block.stage, STAGE.SEGMENTATION); assert.equal(clutter.r.block.code, 'SEGMENTATION_FAILED'); assert.deepEqual(clutter.r.block.reason, 'BACKGROUND_NOT_PLAIN');
  assert.equal(clutter.w.brainPort.calls.length, 0); assert.equal(clutter.w.layers.calls.length, 0); assert.equal(clutter.r.budget.spent_eur, 0); assert.equal(clutter.r.final, null);
  // E2-18 a white product on a near-white ground: a stop at the segmentation or the matte, never a result
  const low = await stopAt(pngOf(IW.lowContrast().rgba)); assert.equal(low.r.state, E2E_STATE.BLOCKED); assert.equal(low.r.block.stage, STAGE.SEGMENTATION); assert.ok(['SEGMENTATION_LOW_CONFIDENCE', 'MATTE_INVALID', 'SEGMENTATION_FAILED'].includes(low.r.block.code)); assert.equal(low.w.brainPort.calls.length, 0);
  // E2-19 several objects and no selection: ambiguous (never a guess); an explicit selection is carried into the run and the product id is preserved
  const multi = await stopAt(pngOf(IW.multiObject().rgba));
  assert.equal(multi.r.block.code, 'SEGMENTATION_FAILED'); assert.equal(multi.r.block.reason, 'AMBIGUOUS_SELECTION'); assert.equal(multi.w.brainPort.calls.length, 0);
  const one = await stopAt(pngOf(IW.multiObject().rgba), { options: { selection: { mode: 'IDS', ids: ['o1'] } } });
  assert.notEqual(one.r.block?.stage, STAGE.SEGMENTATION, JSON.stringify(one.r.block)); assert.deepEqual(one.r.selection, { mode: 'IDS', ids: ['o1'], product_ids: ['o1'] }); assert.ok(one.r.integration.evidence.components >= 3);
  assert.ok(one.r.warnings.includes('IDENTITY_ANNOTATIONS_DERIVED_FROM_THE_MATTE'));
  // E2-20 a segmentation provider returning a fat matte (ground inside the product): MATTE_INVALID, the provider call was an operation of the run, and nothing else was paid
  const prep = prepareAsset(e2eBrief().asset); const good = segmentProduct({ rgba: prep.rgba });
  const fat = Uint8Array.from(good.alpha); const wd = prep.rgba.width;
  for (let y = 1; y < prep.rgba.height - 1; y += 1) for (let x = 1; x < wd - 1; x += 1) if (good.alpha[y * wd + x] >= 128) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) fat[(y + dy) * wd + x + dx] = 255;
  const wp = await e2eWorld(); wp.ports.segmentation = { id: 'fat-provider', segment: async () => ({ ...good, alpha: fat, bounds: { x0: good.bounds.x0 - 1, y0: good.bounds.y0 - 1, x1: good.bounds.x1 + 1, y1: good.bounds.y1 + 1 } }) };
  const rp = await run(wp);
  assert.equal(rp.state, E2E_STATE.BLOCKED); assert.equal(rp.block.code, 'MATTE_INVALID'); assert.equal(rp.provider_calls.length, 1); assert.equal(rp.provider_calls[0].kind, OPERATION.SEGMENTATION_PROVIDER); assert.match(rp.provider_calls[0].id, /:SEGMENTATION_PROVIDER:0001$/); assert.equal(wp.brainPort.calls.length, 0);
});

test('The pre-cut path runs end to end; the missing capabilities are reported as such, never hidden', async () => {
  // E2-21 a pre-cut asset (native alpha): the matte is the validated alpha, the run completes
  const prep = prepareAsset(e2eBrief().asset); const seg = segmentProduct({ rgba: prep.rgba });
  const pre = { width: prep.rgba.width, height: prep.rgba.height, pixels: Uint8Array.from(prep.rgba.pixels) };
  for (let i = 0; i < pre.width * pre.height; i += 1) { const a = seg.alpha[i]; pre.pixels[i * 4 + 3] = a === 255 ? 253 : a; if (a === 0) { pre.pixels[i * 4] = 0; pre.pixels[i * 4 + 1] = 0; pre.pixels[i * 4 + 2] = 0; } }
  const bytes = pngOf(pre); const w = await e2eWorld({ brief: e2eBrief({ asset: { ...e2eBrief().asset, bytes, sha256: sha(bytes) } }) }); const r = await run(w);
  assert.equal(r.integration.source_kind, 'NATIVE_ALPHA'); assert.ok(r.integration.evidence.native.snapped_to_opaque > 1000); assert.notEqual(r.state, E2E_STATE.BLOCKED, JSON.stringify(r.block)); assert.equal(r.product_identity.delivered_identity.valid, true);
  // E2-22 no layer provider: PROVIDER_NOT_CONNECTED before anything is done; no Brain guardian: BLOCKED with the gate that did not run
  const none = await e2eWorld(); none.ports = { ...none.ports, layers: undefined }; const rn = await run(none); assert.equal(rn.state, E2E_STATE.PROVIDER_NOT_CONNECTED); assert.equal(rn.block.code, 'LAYER_PORT_NOT_CONNECTED'); assert.equal(none.brainPort.calls.length, 0);
  const noGuard = await e2eWorld(); const rg = await run(noGuard, { guardian: null }); assert.equal(rg.state, E2E_STATE.BLOCKED); assert.equal(rg.block.code, 'A_MANDATORY_GATE_DID_NOT_RUN'); assert.equal(rg.block.reason, 'BRAND_GUARDIAN'); assert.equal(rg.gates.find((g) => g.id === 'BRAND_GUARDIAN').outcome, 'NOT_RUN'); assert.ok(rg.final.png_sha256); // the gate did not run: the asset exists but is not READY
  // E2-23 a malformed request never reaches a provider
  const bad = await e2eWorld(); const rb = await run(bad, { request: null }); assert.equal(rb.block.code, 'REQUEST_INVALID'); assert.equal(bad.brainPort.calls.length, 0);
  const rc = await run(await e2eWorld(), { ceiling_eur: Number.NaN }); assert.equal(rc.state, E2E_STATE.TECHNICAL_FAIL); assert.equal(rc.failure.code, 'CEILING_INVALID');
});

test('The contact shadow is opt-in, a separate layer, judged; an impossible light stops the run and the earlier work is kept', async () => {
  // E2-24 enabled: a layer under the product, the renderer's own shadow effect dropped (no double shadow), the artifact gate judges it
  const w = await e2eWorld(); const r = await run(w, { options: { contact_shadow: { kind: 'SOFT' } } });
  assert.notEqual(r.state, E2E_STATE.BLOCKED, JSON.stringify(r.block)); assert.equal(r.integration.shadow.kind, 'SOFT'); assert.ok(r.gates.find((g) => g.id === 'INTEGRATION_ARTIFACTS').outcome === 'PASS');
  const { r: base } = await getBaseline(); assert.notEqual(r.final.png_sha256, base.final.png_sha256);
  // E2-25 an impossible light: SHADOW_INVALID, BLOCKED at the integration stage; the plans, the segmentation and the generated layers stay valid and a corrected run reuses them
  const bad = await e2eWorld(); const rb = await run(bad, { options: { contact_shadow: { kind: 'SOFT', light: { angle_deg: 120, elevation_deg: 0, softness: 0.5 } } } });
  assert.equal(rb.state, E2E_STATE.BLOCKED); assert.equal(rb.block.code, 'SHADOW_INVALID'); assert.equal(rb.block.stage, STAGE.INTEGRATION);
  for (const s of [STAGE.SEGMENTATION, STAGE.FORMAT_PLAN, STAGE.BRAIN_PLAN, STAGE.PRODUCTION_PLAN]) assert.ok(rb.checkpoints.find((c) => c.stage === s && c.valid), s);
  const fixed = await e2eWorld(); const calls = imageOps(rb).length;
  const rf = await run(fixed, { options: { contact_shadow: { kind: 'SOFT' } }, resume: JSON.parse(JSON.stringify(rb.resume_state)) });
  assert.notEqual(rf.state, E2E_STATE.BLOCKED, JSON.stringify(rf.block ?? rf.failure)); assert.equal(fixed.layers.calls.length, imageOps(r).length - calls); assert.equal(fixed.brainPort.calls.length, 0);
});

test('Refine runs only for a named, repairable defect, within policy and capability', async () => {
  const withProps = () => fakeLayerPort({ prop: ({ candidate_index: i }) => propOnGround({ colour: i > 1 ? '#3a6ea5' : '#7a4b2a' }) });
  const w0 = await e2eWorld({ layerPort: withProps() }); const base = await run(w0); const prop = base.layers.props[0];
  assert.ok(prop, 'the scene has a prop');
  // E2-26 a named prop defect, refine enabled: a PROP_REPAIR of that layer only, the product and the copy identical
  const w = await e2eWorld({ layerPort: withProps() });
  const defect = createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, source: DEFECT_SOURCE.OWNER_REGION, layer_id: prop.layer_id, reason: 'the owner does not like this prop' });
  const r = await run(w, { options: { refine: { enabled: true, defects: [defect] } } });
  assert.equal(r.refine.decision, 'ATTEMPTED'); assert.equal(r.refine.status, 'REPAIRED', JSON.stringify(r.refine)); assert.deepEqual([].concat(r.refine.scope), ['PROP_REPAIR']); assert.equal(r.refine.product_identical, true); assert.equal(r.refine.locked_copy_identical, true);
  assert.notEqual(r.final.png_sha256, base.final.png_sha256); assert.ok(r.refine.provider_calls >= 1 && r.refine.provider_calls <= 2); assert.notEqual(r.state, E2E_STATE.BLOCKED, JSON.stringify(r.block));
  assert.equal(new Set(r.operation_ids).size, r.operation_ids.length); assert.ok(r.budget.spent_eur < 2);
  // E2-27 refine disabled with a named defect: not run, and the warning says so; a defect only a masked edit could fix: PROVIDER_NOT_CONNECTED, never a silent restart
  const w2 = await e2eWorld({ layerPort: withProps() }); const off = await run(w2, { options: { refine: { enabled: false, defects: [defect] } } });
  assert.equal(off.refine.decision, 'DISABLED'); assert.ok(off.warnings.includes('REFINE_DISABLED_WITH_NAMED_DEFECTS')); assert.equal(w2.layers.calls.length, imageOps(base).length);
  const w3 = await e2eWorld({ layerPort: withProps() });
  const local = createDefectRegion({ kind: DEFECT_KIND.LOCAL_PIXEL_DEFECT, source: DEFECT_SOURCE.OWNER_REGION, layer_id: prop.layer_id, reason: 'a scratch' });
  const masked = await run(w3, { options: { refine: { enabled: true, defects: [local] } } });
  assert.equal(masked.state, E2E_STATE.PROVIDER_NOT_CONNECTED); assert.equal(masked.block.code, 'MASKED_EDIT_NOT_CONNECTED'); assert.equal(w3.layers.calls.length, imageOps(base).length); // nothing was regenerated
  // E2-28 a defect on the product pixels is refused, never executed
  const w4 = await e2eWorld({ layerPort: withProps() });
  const onProduct = createDefectRegion({ kind: DEFECT_KIND.PRODUCT_PIXELS, source: DEFECT_SOURCE.OWNER_REGION, node_id: 'PRODUCT', reason: 'repaint the case' });
  const refused = await run(w4, { options: { refine: { enabled: true, defects: [onProduct] } } });
  assert.equal(refused.state, E2E_STATE.BLOCKED); assert.equal(refused.block.stage, STAGE.REFINE); assert.equal(w4.layers.calls.length, imageOps(base).length);
});

test('The entry point is opt-in and describes itself; the legacy runtimes are not replaced', async () => {
  // E2-29
  const d = describeEndToEnd(); assert.equal(d.entry, 'runCreativeEndToEnd'); assert.equal(d.wired, true); assert.equal(d.opt_in, true); assert.equal(d.replaces_legacy, false); assert.deepEqual(d.stages, STAGE_ORDER);
});
