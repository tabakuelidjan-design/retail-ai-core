import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as m4 from '../src/marketing/m4.js';
import * as m3 from '../src/marketing/m3.js';
import * as m2 from '../src/marketing/m2.js';
import * as understand from '../src/marketing/understand.js';
import { MKT_ERROR as E } from '../src/marketing/understand-constants.js';
import { deriveId } from '../src/marketing/understand-validation.js';
import {
  M1, M2, B1, B2, tenant, chainFor,
} from './marketing-m4-fixtures.js';

// ------------------------------------------------------------------ fixtures
const CH = { HOLDOUT: chainFor('HOLDOUT'), TIME: chainFor('TIME'), NONE: chainFor('NONE') };
const RUN_AT = '2026-10-14T00:00:00Z'; // the Run clock (the window of the MeasurementPlan is 10-10 -> 10-24)
const PENDING_AT = '2026-10-20T00:00:00Z';
const FINAL_AT = '2026-10-25T00:00:00Z';
const ACT = '2026-10-13T09:00:00Z';
const VALID_UNTIL = '2026-12-25T00:00:00Z';

const code = (fn) => { try { fn(); } catch (error) { return error.code; } return assert.fail('expected an error'); };
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const everyObject = (v, visit) => { if (v && typeof v === 'object') { visit(v); Object.values(v).forEach((x) => everyObject(x, visit)); } };
const keysDeep = (v) => { const out = new Set(); everyObject(v, (o) => Object.keys(o).forEach((k) => out.add(k))); return out; };
const clone = (v) => JSON.parse(JSON.stringify(v));
const forge = (object, idField, prefix, patch) => { const { [idField]: _id, ...body } = { ...object, ...patch }; return { [idField]: deriveId(prefix, body), ...body }; };
const read = (name) => readFile(new URL(`../src/marketing/${name}.js`, import.meta.url), 'utf8');
const stripComments = (text) => text.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*')).join('\n');
const M4_FILES = ['m4-constants', 'm4-validation', 'execution-receipt', 'marketing-run', 'run-evidence', 'run-result', 'marketing-learning', 'follow-up-proposal', 'steer-package', 'm4'];

const authOf = (c, over = {}) => ({
  authorization_ref: 'exec-auth://1', decision_ref: 'decision://socle-2', activation_manifest_ref: c.activationManifest.activation_manifest_id, push_ref: c.push.push_id,
  scope: 'EXECUTE', status: 'APPROVED', authorized_at: '2026-10-11T09:00:00Z', expires_at: '2026-10-16T00:00:00Z', ...over,
});
const deliveriesOf = (c) => c.activationManifest.deliveries.map((d) => ({ deliverable_ref: d.deliverable_ref, delivery_execution_ref: `dx://${d.deliverable_ref}` }));
const receiptOf = (c, over = {}) => ({
  execution_ref: 'exec://run-1', execution_authorization_ref: 'exec-auth://1', activation_manifest_ref: c.activationManifest.activation_manifest_id, merchant_id: M1, brand_id: B1,
  push_ref: c.push.push_id, execution_status: 'EXECUTED', activated_at: ACT, delivery_execution_refs: deliveriesOf(c), evidence_refs: ['ev/exec-1'], recorded_at: '2026-10-13T10:00:00Z', ...over,
});
const normAuth = (c, over) => m4.normalizeSocleExecutionAuthorization(authOf(c, over), { activationManifest: c.activationManifest, push: c.push });
const normReceipt = (c, over, authOver) => m4.normalizeMarketingExecutionReceipt(receiptOf(c, over), {
  merchantId: M1, activationManifest: c.activationManifest, push: c.push, authorization: normAuth(c, authOver),
});
const runInputs = (c, { auth = {}, receipt = {}, asOf = RUN_AT } = {}) => ({
  tenant: tenant(), push: c.push, activationManifest: c.activationManifest, authorization: authOf(c, auth), receipt: receiptOf(c, receipt), asOf,
});
const runOf = (c, o) => m4.buildMarketingRun(runInputs(c, o));

const crit = (ref, status = 'MET') => ({ criterion_ref: ref, status, evidence_refs: ['ev/crit'] });
const offOf = (over = {}) => ({ method: 'QR', result_ref: 'res/off-1', source_ref: 'src/qr-1', evidence_refs: ['ev/off'], observed_at: '2026-10-20T00:00:00Z', limitations: ['SELF_SELECTED'], ...over });
const evFields = (over = {}) => ({
  data_state: 'COMPLETE', evidence_class: 'ATTRIBUTED', assessment_status: 'SUPPORTS', primary_metric_ref: 'metric/orders', attributed_result_refs: ['res/attr-1'],
  success_criterion: crit('criterion/ok'), failure_criterion: crit('criterion/ko', 'NOT_MET'), stop_rule_assessments: [], evidence_refs: ['ev/m1'], limitations: [],
  assessed_at: '2026-10-24T12:00:00Z', ...over,
});
const INCR = { evidence_class: 'INCREMENTAL', incremental_result_ref: 'res/incr-1' };
const OBSERVED = { evidence_class: 'OBSERVED', observed_result_refs: ['res/obs-1'], attributed_result_refs: [] };
const OFFLINE = { evidence_class: 'OFFLINE_ATTRIBUTED', attributed_result_refs: [], offline_attribution_observations: [offOf()] };
const STOP_MET = { stop_rule_assessments: [{ rule_ref: 'stop/low-stock', status: 'MET', evidence_refs: ['ev/stop'] }] };
const PENDING_EV = { assessed_at: '2026-10-19T12:00:00Z' };
const evInputs = (c, run, over) => ({ tenant: tenant(), push: c.push, run, ...evFields(over) });
const bundleOf = (c, run, over) => m4.buildRunEvidenceBundle(evInputs(c, run, over));

function scenario(plan = 'HOLDOUT', { exec = 'EXECUTED', ev = {}, asOf = FINAL_AT } = {}) {
  const c = CH[plan];
  const receipt = exec === 'PARTIAL' ? { execution_status: 'PARTIAL', delivery_execution_refs: deliveriesOf(c).slice(0, 1) } : {};
  const run = runOf(c, { receipt });
  const bundle = bundleOf(c, run, ev);
  const opts = { tenant: tenant(), push: c.push, run, bundle };
  const result = m4.buildMarketingRunResult({ ...opts, asOf });
  return { c, run, bundle, opts, result, asOf };
}
const learnOf = (s, over = {}) => m4.buildMarketingLearning({
  ...s.opts, result: s.result, asOf: s.asOf, valid_until: VALID_UNTIL, validity_basis_ref: 'basis://review-cycle', ...over,
});
const fuOf = (s, type, over = {}) => m4.buildMarketingFollowUpProposal({
  ...s.opts, result: s.result, asOf: s.asOf, proposal_type: type, reason_codes: ['OWNER_REVIEW'], evidence_refs: ['ev/fu'], expires_at: '2026-11-25T00:00:00Z', ...over,
});
const packageOf = (s, followUps, over = {}) => m4.buildMarketingSteerPackage({
  ...s.opts, result: s.result, follow_ups: followUps, do_nothing: { reason_codes: ['KEEP_AS_IS'], evidence_refs: ['ev/dn'] }, asOf: s.asOf, expires_at: '2026-11-20T00:00:00Z', ...over,
});

// the scenarios the tests keep coming back to
const CONFIRMED = () => scenario('HOLDOUT', { ev: INCR });
const REFUTED = () => scenario('HOLDOUT', { ev: { ...INCR, assessment_status: 'CHALLENGES' } });
const SUGGESTIVE_UP = () => scenario('TIME');
const SUGGESTIVE_DOWN = () => scenario('TIME', { ev: { assessment_status: 'CHALLENGES' } });
const NOT_MEASURABLE = () => scenario('TIME', { ev: { assessment_status: 'NOT_MEASURABLE' } });
const UNKNOWN = () => scenario('TIME', { ev: { assessment_status: 'UNKNOWN' } });
const PENDING = () => scenario('TIME', { ev: PENDING_EV, asOf: PENDING_AT });

// ------------------------------------------------------------------ execution authorization / receipt (1-20)

test('Execution authorization: a valid EXECUTE authorization is accepted, and its scope, status, refs and window are enforced', () => {
  const c = CH.HOLDOUT;
  const auth = normAuth(c); // 1
  assert.deepEqual([auth.scope, auth.status, auth.activation_manifest_ref, auth.push_ref], ['EXECUTE', 'APPROVED', c.activationManifest.activation_manifest_id, c.push.push_id]);
  assert.equal(code(() => normAuth(c, { scope: 'CREATE' })), 'MKT_M4_AUTH_INVALID_SCOPE'); // 2
  assert.equal(code(() => normAuth(c, { status: 'PENDING' })), 'MKT_M4_AUTH_INVALID_STATUS'); // 3
  assert.equal(code(() => normAuth(c, { activation_manifest_ref: 'mam_other' })), 'MKT_M4_AUTH_MANIFEST_MISMATCH'); // 4
  assert.equal(code(() => normAuth(c, { push_ref: 'mpp_other' })), 'MKT_M4_AUTH_PUSH_MISMATCH'); // 5
  assert.equal(code(() => normAuth(c, { authorized_at: '2026-10-17T00:00:00Z' })), 'MKT_M4_AUTH_INVALID_WINDOW'); // 6
  assert.equal(code(() => normAuth(c, { expires_at: 'next week' })), 'MKT_M4_AUTH_INVALID_WINDOW');
  assert.equal(code(() => m4.normalizeSocleExecutionAuthorization({ ...authOf(c), approved_by: 'me' }, { activationManifest: c.activationManifest, push: c.push })), 'MKT_UNKNOWN_KEY');
  assert.ok(isDeepFrozen(auth));
});

test('Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps', () => {
  const c = CH.HOLDOUT;
  const executed = normReceipt(c); // 8
  assert.deepEqual([executed.execution_status, executed.merchant_id, executed.brand_id], ['EXECUTED', M1, B1]);
  const partial = normReceipt(c, { execution_status: 'PARTIAL', delivery_execution_refs: deliveriesOf(c).slice(0, 1) }); // 9, 16
  assert.equal(partial.execution_status, 'PARTIAL');
  assert.equal(code(() => normReceipt(c, { merchant_id: M2 })), 'MKT_M4_RECEIPT_MERCHANT_MISMATCH'); // 10
  assert.equal(code(() => normReceipt(c, { brand_id: B2 })), 'MKT_M4_RECEIPT_BRAND_MISMATCH'); // 11
  assert.equal(code(() => normReceipt(c, { push_ref: 'mpp_other' })), 'MKT_M4_RECEIPT_PUSH_MISMATCH'); // 12
  assert.equal(code(() => normReceipt(c, { activation_manifest_ref: 'mam_other' })), 'MKT_M4_RECEIPT_MANIFEST_MISMATCH'); // 13
  assert.equal(code(() => normReceipt(c, { execution_authorization_ref: 'exec-auth://other' })), 'MKT_M4_RECEIPT_AUTHORIZATION_MISMATCH');
  assert.equal(code(() => normReceipt(c, { evidence_refs: [] })), 'MKT_M4_RECEIPT_EVIDENCE_REQUIRED'); // 14
  assert.equal(code(() => normReceipt(c, { delivery_execution_refs: deliveriesOf(c).slice(0, 1) })), 'MKT_M4_RECEIPT_DELIVERIES_INCOMPLETE'); // 15
  assert.equal(code(() => normReceipt(c, { delivery_execution_refs: [...deliveriesOf(c), { deliverable_ref: 'del_unknown', delivery_execution_ref: 'dx://x' }] })), 'MKT_M4_RECEIPT_DELIVERY_UNKNOWN');
  assert.equal(code(() => normReceipt(c, { execution_status: 'PARTIAL', delivery_execution_refs: [] })), 'MKT_M4_RECEIPT_DELIVERIES_REQUIRED'); // 17
  assert.equal(code(() => normReceipt(c, { activated_at: '2026-10-11T00:00:00Z' })), 'MKT_M4_RECEIPT_OUTSIDE_WINDOW'); // 18
  assert.equal(code(() => normReceipt(c, { activated_at: '2026-10-17T00:00:00Z' })), 'MKT_M4_RECEIPT_OUTSIDE_WINDOW'); // the window end is exclusive
  assert.equal(code(() => normReceipt(c, { recorded_at: '2026-10-13T08:00:00Z' })), 'MKT_M4_RECEIPT_INVALID_RECORDED_AT'); // 19
  assert.equal(code(() => normReceipt(c, { execution_status: 'FAILED' })), 'MKT_M4_RECEIPT_INVALID_STATUS'); // FAILED / CANCELLED are not in M4 V1
  assert.equal(code(() => normReceipt(c, { execution_status: 'CANCELLED' })), 'MKT_M4_RECEIPT_INVALID_STATUS');
  assert.equal(code(() => normReceipt(c, { activated_at: '2026-10-13T09:00:00Z' }, { expires_at: '2026-10-12T12:00:00Z' })), 'MKT_M4_EXECUTION_AFTER_AUTHORIZATION_EXPIRY'); // 7
  assert.equal(code(() => normReceipt(c, {}, { authorized_at: '2026-10-13T12:00:00Z' })), 'MKT_M4_EXECUTION_BEFORE_AUTHORIZATION');
  assert.ok(isDeepFrozen(executed)); // 20
  assert.ok(isDeepFrozen(partial));
});

// ------------------------------------------------------------------ Marketing Run (21-32)

test('Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside', () => {
  const c = CH.HOLDOUT;
  const run = runOf(c); // 21, 27
  assert.match(run.run_id, /^mrn_[0-9a-f]{32}$/);
  assert.equal(run.execution_status, 'EXECUTED');
  assert.equal(runOf(c).run_id, run.run_id); // 22, 23
  assert.equal(m4.buildMarketingRun(clone(runInputs(c))).run_id, run.run_id);
  assert.notEqual(runOf(c, { asOf: '2026-10-14T01:00:00Z' }).run_id, run.run_id);
  assert.deepEqual([run.merchant_id, run.brand_id, run.finding_ref, run.push_ref, run.activation_manifest_ref, run.execution_ref, run.activated_at], // 24
    [M1, B1, c.push.finding_ref, c.push.push_id, c.activationManifest.activation_manifest_id, 'exec://run-1', '2026-10-13T09:00:00.000Z']);
  assert.equal(code(() => m4.buildMarketingRun({ ...runInputs(c), merchant_id: M2 })), 'MKT_UNKNOWN_KEY');
  assert.deepEqual({ ...run.observation_window }, { ...c.push.measurement_plan.observation_window }); // 25
  assert.deepEqual(Object.keys(run).filter((k) => /window/.test(k)), ['observation_window']); // 26
  const partial = runOf(c, { receipt: { execution_status: 'PARTIAL', delivery_execution_refs: deliveriesOf(c).slice(0, 1) } }); // 28
  assert.ok(partial.review_signals.includes('PARTIAL_EXECUTION'));
  assert.ok(!run.review_signals.includes('PARTIAL_EXECUTION'));
  assert.ok(run.review_signals.includes('MEASUREMENT_WINDOW_NOT_COMPLETE'));
  assert.ok(run.review_signals.includes('OFFLINE_ATTRIBUTION_EXPECTED')); // a STORE_FRONT delivery
  assert.ok(!run.review_signals.includes('INCREMENTALITY_NOT_ELIGIBLE'));
  assert.ok(runOf(CH.TIME).review_signals.includes('INCREMENTALITY_NOT_ELIGIBLE'));
  assert.deepEqual([...run.review_signals], [...run.review_signals].sort());
  assert.equal(run.measurement_plan_ref, c.activationManifest.measurement_plan_ref); // 29
  const wrongPlan = forge(c.activationManifest, 'activation_manifest_id', 'mam', { measurement_plan_ref: 'other#measurement' });
  assert.equal(code(() => m4.buildMarketingRun({ ...runInputs(c), activationManifest: wrongPlan })), 'MKT_M4_SCOPE_MISMATCH');
  assert.deepEqual([...keysDeep(run)].filter((k) => /outcome|result|direction|learning|follow/.test(k)), []); // 30
  assert.deepEqual([...keysDeep(run)].filter((k) => /score|rank|winner/.test(k)), []); // 31
  assert.ok(isDeepFrozen(run)); // 32
  // a stored Run re-validates against its originals; a forged one is refused
  const inputs = runInputs(c);
  assert.equal(m4.normalizeMarketingRun(run, { tenant: inputs.tenant, push: inputs.push, activationManifest: inputs.activationManifest, authorization: inputs.authorization, receipt: inputs.receipt }).run_id, run.run_id);
  assert.equal(code(() => m4.normalizeMarketingRun({ ...run, execution_status: 'PARTIAL' }, { tenant: inputs.tenant, push: inputs.push, activationManifest: inputs.activationManifest, authorization: inputs.authorization, receipt: inputs.receipt })), 'MKT_M4_RUN_DERIVED_MISMATCH');
  assert.equal(code(() => runOf(c, { receipt: { recorded_at: '2026-10-14T01:00:00Z' } })), 'MKT_M4_RUN_RECEIPT_IN_FUTURE');
  assert.equal(code(() => m4.buildMarketingRun({ ...runInputs(c), tenant: tenant(M2) })), 'MKT_M4_SCOPE_MISMATCH');
});

// ------------------------------------------------------------------ offline attribution (33-45)

test('Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic', () => {
  const cases = { QR: 33, PROMO_CODE: 34, SHORT_URL: 35, POS_MARKER: 36, COUPON: 37, SELF_REPORTED: 38 };
  for (const method of Object.keys(cases)) {
    const observation = m4.buildOfflineAttributionObservation(offOf({ method })); // 33-38
    assert.equal(observation.method, method);
    assert.equal(observation.causal_claim, false);
  }
  assert.deepEqual(Object.values(m4.OFFLINE_METHOD), ['QR', 'PROMO_CODE', 'SHORT_URL', 'POS_MARKER', 'COUPON', 'SELF_REPORTED']);
  assert.equal(code(() => m4.buildOfflineAttributionObservation(offOf({ method: 'TELEPATHY' }))), 'MKT_M4_OFFLINE_INVALID_METHOD'); // 39
  assert.equal(code(() => m4.buildOfflineAttributionObservation(offOf({ evidence_refs: [] }))), 'MKT_M4_OFFLINE_EVIDENCE_REQUIRED'); // 40
  assert.equal(m4.buildOfflineAttributionObservation(offOf({ causal_claim: false })).causal_claim, false); // 41
  assert.equal(code(() => m4.buildOfflineAttributionObservation(offOf({ causal_claim: true }))), 'MKT_M4_OFFLINE_CAUSAL_CLAIM');
  assert.equal(code(() => m4.buildOfflineAttributionObservation(offOf({ response_text: 'she said a friend told her about us' }))), 'MKT_M4_PRIVACY_FIELD'); // 42
  assert.equal(code(() => m4.buildOfflineAttributionObservation(offOf({ result_ref: 'she told me at the door' }))), 'MKT_INVALID_FIELD');
  assert.equal(code(() => m4.buildOfflineAttributionObservation(offOf({ email: 'a@b.example' }))), 'MKT_M4_PRIVACY_FIELD'); // 43
  assert.equal(code(() => m4.buildOfflineAttributionObservation(offOf({ customer_name: 'X' }))), 'MKT_M4_PRIVACY_FIELD');
  assert.equal(code(() => m4.buildOfflineAttributionObservation(offOf({ source_ref: 'someone@mail.example' }))), 'MKT_INVALID_FIELD');
  const a = m4.buildOfflineAttributionObservation(offOf()); // 44
  assert.match(a.observation_id, /^moa_[0-9a-f]{32}$/);
  assert.equal(m4.buildOfflineAttributionObservation(offOf()).observation_id, a.observation_id);
  assert.notEqual(m4.buildOfflineAttributionObservation(offOf({ method: 'COUPON' })).observation_id, a.observation_id);
  assert.equal(m4.buildOfflineAttributionObservation({ ...a }).observation_id, a.observation_id); // an observation built earlier re-validates
  assert.equal(code(() => m4.buildOfflineAttributionObservation({ ...a, method: 'COUPON' })), 'MKT_M4_EVIDENCE_DERIVED_MISMATCH');
  assert.ok(isDeepFrozen(a)); // 45
});

// ------------------------------------------------------------------ run evidence (46-62)

test('Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented', () => {
  const c = CH.HOLDOUT;
  const run = runOf(c);
  const observed = bundleOf(c, run, OBSERVED); // 46
  assert.deepEqual([observed.evidence_class, [...observed.observed_result_refs]], ['OBSERVED', ['res/obs-1']]);
  const attributed = bundleOf(c, run); // 47
  assert.deepEqual([attributed.evidence_class, [...attributed.attributed_result_refs]], ['ATTRIBUTED', ['res/attr-1']]);
  const offline = bundleOf(c, run, OFFLINE); // 48
  assert.equal(offline.offline_attribution_observations[0].causal_claim, false);
  const incremental = bundleOf(c, run, INCR); // 49
  assert.equal(incremental.incremental_result_ref, 'res/incr-1');
  assert.equal(code(() => bundleOf(c, run, { primary_metric_ref: 'metric/other' })), 'MKT_M4_EVIDENCE_METRIC_MISMATCH'); // 50
  assert.equal(code(() => bundleOf(c, run, { success_criterion: crit('criterion/other') })), 'MKT_M4_EVIDENCE_CRITERION_MISMATCH'); // 51
  assert.equal(code(() => bundleOf(c, run, { failure_criterion: crit('criterion/other') })), 'MKT_M4_EVIDENCE_CRITERION_MISMATCH'); // 52
  assert.equal(bundleOf(c, run, STOP_MET).stop_rule_assessments[0].rule_ref, 'stop/low-stock'); // 53
  assert.equal(code(() => bundleOf(c, run, { stop_rule_assessments: [{ rule_ref: 'stop/unknown', status: 'MET', evidence_refs: [] }] })), 'MKT_M4_EVIDENCE_STOP_RULE_UNKNOWN');
  assert.equal(code(() => bundleOf(c, run, { stop_rule_assessments: [...STOP_MET.stop_rule_assessments, ...STOP_MET.stop_rule_assessments] })), 'MKT_DUPLICATE_ENTRY');
  assert.equal(attributed.run_ref, run.run_id); // 54
  assert.equal(code(() => m4.buildRunEvidenceBundle({ ...evInputs(c, run), run_ref: 'mrn_other' })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => m4.buildRunEvidenceBundle({ ...evInputs(c, runOf(CH.TIME)) })), 'MKT_M4_SCOPE_MISMATCH'); // a Run of another Push
  assert.equal(attributed.merchant_id, M1); // 55
  assert.equal(code(() => m4.buildRunEvidenceBundle({ ...evInputs(c, run), tenant: tenant(M2) })), 'MKT_M4_SCOPE_MISMATCH');
  assert.equal(attributed.brand_id, B1); // 56
  assert.equal(code(() => m4.buildRunEvidenceBundle({ ...evInputs(c, run), brand_id: B2 })), 'MKT_UNKNOWN_KEY');
  for (const state of ['COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'PENDING']) assert.equal(bundleOf(c, run, { data_state: state }).data_state, state); // 57
  assert.deepEqual(Object.values(m4.DATA_STATE), ['COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'PENDING']);
  assert.equal(code(() => bundleOf(c, run, { data_state: 'DONE' })), 'MKT_M4_EVIDENCE_INVALID_STATE');
  for (const status of ['SUPPORTS', 'CHALLENGES', 'INCONCLUSIVE', 'NOT_MEASURABLE', 'UNKNOWN']) assert.equal(bundleOf(c, run, { assessment_status: status }).assessment_status, status); // 58
  assert.equal(code(() => bundleOf(c, run, { assessment_status: 'GOOD' })), 'MKT_M4_EVIDENCE_INVALID_STATUS');
  assert.deepEqual(Object.values(m4.EVIDENCE_CLASS), ['OBSERVED', 'ATTRIBUTED', 'OFFLINE_ATTRIBUTED', 'INCREMENTAL']); // 59: there is no generic CAUSAL class
  assert.equal(code(() => bundleOf(c, run, { evidence_class: 'CAUSAL' })), 'MKT_M4_EVIDENCE_INVALID_CLASS');
  assert.deepEqual([...attributed.evidence_refs], ['ev/m1']); // 60
  assert.deepEqual([...attributed.success_criterion.evidence_refs], ['ev/crit']);
  assert.equal(code(() => bundleOf(c, run, { evidence_refs: [42] })), 'MKT_INVALID_FIELD'); // 61: refs only, no number
  assert.equal(code(() => bundleOf(c, run, { lift_percent: 12 })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => bundleOf(c, run, { confidence_score: 0.9 })), 'MKT_M4_FORBIDDEN_FIELD');
  assert.equal(code(() => bundleOf(c, run, { evidence_class: 'OBSERVED', observed_result_refs: [] })), 'MKT_M4_EVIDENCE_LAYER_MISSING');
  assert.equal(code(() => bundleOf(c, run, { assessed_at: '2026-10-12T00:00:00Z' })), 'MKT_M4_EVIDENCE_BEFORE_ACTIVATION');
  assert.ok(isDeepFrozen(attributed)); // 62
  const inputs = { tenant: tenant(), push: c.push, run };
  assert.equal(m4.normalizeRunEvidenceBundle(attributed, inputs).assessment_ref, attributed.assessment_ref);
  assert.equal(code(() => m4.normalizeRunEvidenceBundle({ ...attributed, run_ref: 'mrn_other' }, inputs)), 'MKT_M4_EVIDENCE_DERIVED_MISMATCH');
  assert.equal(code(() => m4.normalizeRunEvidenceBundle({ ...attributed, assessment_status: 'CHALLENGES' }, inputs)), 'MKT_M4_EVIDENCE_DERIVED_MISMATCH');
});

// ------------------------------------------------------------------ incrementality (63-73)

test('Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged', () => {
  const holdout = CH.HOLDOUT;
  const hRun = runOf(holdout);
  assert.equal(bundleOf(holdout, hRun, INCR).evidence_class, 'INCREMENTAL'); // 63
  assert.equal(code(() => bundleOf(CH.NONE, runOf(CH.NONE), INCR)), 'MKT_M4_INCREMENTAL_RESULT_NOT_ALLOWED'); // 64
  assert.equal(code(() => bundleOf(CH.TIME, runOf(CH.TIME), INCR)), 'MKT_M4_INCREMENTAL_RESULT_NOT_ALLOWED'); // 65
  assert.equal(code(() => bundleOf(CH.TIME, runOf(CH.TIME), { evidence_class: 'INCREMENTAL' })), 'MKT_M4_INCREMENTAL_RESULT_NOT_ALLOWED');
  assert.equal(code(() => bundleOf(CH.NONE, runOf(CH.NONE), { incremental_result_ref: 'res/x' })), 'MKT_M4_INCREMENTAL_RESULT_NOT_ALLOWED');
  // 66: a HOLDOUT that is not ELIGIBLE cannot even exist in a MeasurementPlan (M2), so it can never reach M4
  assert.throws(() => m2.buildMeasurementPlan({ ...CH.HOLDOUT.push.measurement_plan, eligibility_status: 'NOT_ELIGIBLE', incrementality_candidate: undefined }), /HOLDOUT/);
  assert.equal(code(() => bundleOf(holdout, hRun, { evidence_class: 'INCREMENTAL', incremental_result_ref: undefined })), 'MKT_M4_INCREMENTAL_RESULT_REQUIRED'); // 67
  assert.equal(code(() => bundleOf(holdout, hRun, { incremental_result_ref: 'res/incr-1' })), 'MKT_M4_INCREMENTAL_RESULT_NOT_ALLOWED'); // 68: ATTRIBUTED + ref
  assert.equal(CONFIRMED().result.incrementality_status, 'MEASURABLE'); // 69
  assert.equal(scenario('NONE').result.incrementality_status, 'UNTESTABLE'); // 70
  assert.equal(scenario('TIME').result.incrementality_status, 'UNTESTABLE'); // 71
  assert.ok(scenario('TIME').result.review_signals.includes('INCREMENTALITY_UNTESTABLE'));
  const failures = [
    scenario('HOLDOUT', { ev: { ...INCR, data_state: 'PARTIAL' } }), // 72: design / data failure
    scenario('HOLDOUT', { ev: { ...INCR, assessment_status: 'NOT_MEASURABLE' } }),
    scenario('HOLDOUT', { ev: { data_state: 'COMPLETE' } }), // an eligible HOLDOUT that only delivered an attribution
    scenario('HOLDOUT', { ev: { ...INCR, data_state: 'UNAVAILABLE', evidence_refs: [] } }),
  ];
  for (const s of failures) assert.equal(s.result.incrementality_status, 'NOT_MEASURABLE');
  const pending = [scenario('HOLDOUT', { ev: { ...INCR, data_state: 'PENDING' } }), scenario('HOLDOUT', { ev: { assessment_status: 'UNKNOWN' } })]; // 73
  for (const s of pending) assert.equal(s.result.incrementality_status, 'UNKNOWN');
  assert.notEqual(failures[0].result.incrementality_status, pending[0].result.incrementality_status); // never merged
  assert.deepEqual(Object.values(m4.INCREMENTALITY_STATUS), ['MEASURABLE', 'UNTESTABLE', 'NOT_MEASURABLE', 'UNKNOWN']);
});

// ------------------------------------------------------------------ finalization (74-80)

test('Finalization: PENDING until the window ends, FINAL after it or on an early MET stop rule, with its reason', () => {
  const before = scenario('TIME', { ev: PENDING_EV, asOf: PENDING_AT }).result; // 74
  assert.deepEqual([before.result_state, before.finalization_reason], ['PENDING', null]); // 80
  const after = scenario('TIME').result; // 75
  assert.equal(after.result_state, 'FINAL');
  assert.equal(after.finalization_reason, 'OBSERVATION_WINDOW_COMPLETE'); // 78
  const atEnd = scenario('TIME', { asOf: '2026-10-24T12:00:00Z' }).result; // the window end itself is FINAL (asOf >= end)
  assert.equal(atEnd.result_state, 'FINAL');
  const early = scenario('TIME', { ev: { ...STOP_MET, ...PENDING_EV }, asOf: PENDING_AT }).result; // 76
  assert.equal(early.result_state, 'FINAL');
  assert.equal(early.finalization_reason, 'STOP_RULE_MET'); // 79
  assert.ok(early.review_signals.includes('STOP_RULE_MET'));
  const notMet = scenario('TIME', { ev: { ...PENDING_EV, stop_rule_assessments: [{ rule_ref: 'stop/low-stock', status: 'NOT_MET', evidence_refs: [] }, { rule_ref: 'stop/complaints', status: 'UNKNOWN', evidence_refs: [] }] }, asOf: PENDING_AT }).result; // 77
  assert.equal(notMet.result_state, 'PENDING');
  assert.deepEqual(Object.values(m4.RESULT_STATE), ['PENDING', 'FINAL']);
  assert.equal(code(() => scenario('TIME', { ev: { assessed_at: '2026-10-24T12:00:00Z' }, asOf: PENDING_AT })), 'MKT_M4_EVIDENCE_IN_FUTURE'); // evidence from the future is refused
});

// ------------------------------------------------------------------ outcome (81-97)

test('Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped', () => {
  const confirmed = CONFIRMED().result; // 81
  assert.deepEqual([confirmed.outcome, confirmed.direction, confirmed.evidence_class], ['CONFIRMED', 'SUPPORTS', 'INCREMENTAL']);
  const refuted = REFUTED().result; // 82
  assert.deepEqual([refuted.outcome, refuted.direction], ['REFUTED', 'CHALLENGES']);
  const up = SUGGESTIVE_UP().result; // 83
  assert.deepEqual([up.outcome, up.direction], ['SUGGESTIVE', 'SUPPORTS']);
  const down = SUGGESTIVE_DOWN().result; // 84
  assert.deepEqual([down.outcome, down.direction], ['SUGGESTIVE', 'CHALLENGES']);
  const offline = scenario('HOLDOUT', { ev: OFFLINE }).result; // 85
  assert.deepEqual([offline.outcome, offline.evidence_class], ['SUGGESTIVE', 'OFFLINE_ATTRIBUTED']);
  assert.ok(offline.review_signals.includes('OFFLINE_ATTRIBUTION_ONLY'));
  const observed = scenario('HOLDOUT', { ev: OBSERVED }).result; // 86
  assert.deepEqual([observed.outcome, observed.evidence_class], ['SUGGESTIVE', 'OBSERVED']);
  assert.ok(observed.review_signals.includes('OBSERVED_ONLY'));
  for (const plan of ['NONE', 'TIME']) { // 87-90: no control design can ever confirm or refute
    for (const status of ['SUPPORTS', 'CHALLENGES']) {
      assert.equal(scenario(plan, { ev: { assessment_status: status } }).result.outcome, 'SUGGESTIVE', `${plan} ${status}`);
    }
  }
  assert.ok(scenario('NONE').result.limitations.includes('NO_CONTROL_DESIGN'));
  assert.ok(scenario('TIME').result.limitations.includes('TIME_BASED_CONTROL_ONLY'));
  const notMeasurable = NOT_MEASURABLE().result; // 91
  assert.deepEqual([notMeasurable.outcome, notMeasurable.direction], ['NOT_MEASURABLE', 'INCONCLUSIVE']);
  assert.ok(notMeasurable.review_signals.includes('MEASUREMENT_NOT_MEASURABLE'));
  for (const ev of [{ data_state: 'PARTIAL' }, { data_state: 'UNAVAILABLE', evidence_refs: [] }, { assessment_status: 'INCONCLUSIVE' }]) {
    assert.equal(scenario('TIME', { ev }).result.outcome, 'NOT_MEASURABLE');
  }
  const unknown = UNKNOWN().result; // 92
  assert.deepEqual([unknown.outcome, unknown.direction], ['UNKNOWN', 'INCONCLUSIVE']);
  assert.notEqual(unknown.outcome, notMeasurable.outcome); // UNKNOWN is never merged with NOT_MEASURABLE
  assert.equal(scenario('TIME', { ev: { data_state: 'PENDING', evidence_refs: [] } }).result.outcome, 'UNKNOWN');
  const pending = PENDING().result; // 93
  assert.deepEqual([pending.result_state, pending.outcome], ['PENDING', 'UNKNOWN']);
  assert.ok(scenario('TIME', { ev: { data_state: 'PENDING', evidence_refs: [] } }).result.review_signals.includes('DATA_PENDING'));
  const partialUp = scenario('HOLDOUT', { exec: 'PARTIAL', ev: INCR }).result; // 94
  assert.deepEqual([partialUp.outcome, partialUp.direction], ['SUGGESTIVE', 'SUPPORTS']);
  assert.ok(partialUp.review_signals.includes('PARTIAL_EXECUTION'));
  const partialDown = scenario('HOLDOUT', { exec: 'PARTIAL', ev: { ...INCR, assessment_status: 'CHALLENGES' } }).result; // 95
  assert.deepEqual([partialDown.outcome, partialDown.direction], ['SUGGESTIVE', 'CHALLENGES']);
  assert.deepEqual(Object.values(m4.OUTCOME), ['CONFIRMED', 'SUGGESTIVE', 'REFUTED', 'NOT_MEASURABLE', 'UNKNOWN']);
  assert.deepEqual(Object.values(m4.DIRECTION), ['SUPPORTS', 'CHALLENGES', 'INCONCLUSIVE']);
  const again = CONFIRMED().result; // 96
  assert.equal(again.result_id, confirmed.result_id);
  assert.match(confirmed.result_id, /^mrr_[0-9a-f]{32}$/);
  assert.notEqual(refuted.result_id, confirmed.result_id);
  assert.ok(isDeepFrozen(confirmed)); // 97
  // the result evaluates the hypothesis when the Push has one, else the expected Push outcome; no score anywhere
  assert.equal(confirmed.hypothesis_ref, null);
  assert.deepEqual([...keysDeep(confirmed)].filter((k) => /score|rank|winner/.test(k)), []);
});

// ------------------------------------------------------------------ stored vs live (98-104)

test('Stored versus live: a stored outcome and direction are never an authority; forged results are refused; evidence cannot silently improve', () => {
  const s = PENDING(); // 98: stored UNKNOWN / PENDING
  assert.equal(s.result.outcome, 'UNKNOWN');
  const later = scenario('TIME'); // the same Run, FINAL
  const liveFromPending = m4.evaluateMarketingRunResult(s.result, { ...later.opts, bundle: later.bundle, asOf: FINAL_AT });
  assert.equal(liveFromPending.outcome, 'SUGGESTIVE'); // the stored UNKNOWN is ignored
  assert.equal(liveFromPending.result_state, 'FINAL');
  const stored = SUGGESTIVE_UP(); // 99: stored SUPPORTS, newer evidence says CHALLENGES
  const newer = bundleOf(stored.c, stored.run, { assessment_status: 'CHALLENGES', assessed_at: '2026-10-26T00:00:00Z' });
  const live = m4.evaluateMarketingRunResult(stored.result, { ...stored.opts, bundle: newer, asOf: '2026-10-27T00:00:00Z' });
  assert.deepEqual([live.outcome, live.direction], ['SUGGESTIVE', 'CHALLENGES']);
  assert.equal(code(() => m4.evaluateMarketingRunResult(stored.result, { tenant: stored.opts.tenant, push: stored.opts.push, run: stored.run, asOf: FINAL_AT })), E.INVALID_FIELD); // 100: no bundle, no live answer
  assert.equal(code(() => m4.evaluateMarketingRunResult(stored.result, { ...stored.opts })), E.INVALID_TIMESTAMP); // 101: the clock is explicit
  assert.equal(code(() => m4.evaluateMarketingRunResult(stored.result, { ...stored.opts, asOf: 'today' })), E.INVALID_TIMESTAMP);
  assert.equal(code(() => m4.evaluateMarketingRunResult({ ...stored.result, outcome: 'CONFIRMED' }, { ...stored.opts, asOf: FINAL_AT })), 'MKT_M4_RESULT_DERIVED_MISMATCH'); // 102
  assert.equal(code(() => m4.evaluateMarketingRunResult(forge(stored.result, 'result_id', 'mrr', { run_ref: 'mrn_other' }), { ...stored.opts, asOf: FINAL_AT })), 'MKT_M4_RESULT_SCOPE_MISMATCH');
  assert.equal(code(() => m4.evaluateMarketingRunResult(forge(stored.result, 'result_id', 'mrr', { merchant_id: M2 }), { ...stored.opts, asOf: FINAL_AT })), 'MKT_M4_RESULT_SCOPE_MISMATCH');
  assert.equal(m4.normalizeMarketingRunResult(stored.result, stored.opts).result_id, stored.result.result_id);
  assert.equal(code(() => m4.normalizeMarketingRunResult({ ...stored.result, direction: 'CHALLENGES' }, stored.opts)), 'MKT_M4_RESULT_DERIVED_MISMATCH');
  const c = CONFIRMED(); // 103: new evidence can degrade
  const degraded = bundleOf(c.c, c.run, { ...INCR, assessment_status: 'NOT_MEASURABLE', assessed_at: '2026-10-26T00:00:00Z' });
  assert.equal(m4.evaluateMarketingRunResult(c.result, { ...c.opts, bundle: degraded, asOf: '2026-10-27T00:00:00Z' }).outcome, 'NOT_MEASURABLE');
  // 104: a FINAL, inconclusive result cannot become conclusive with an OLDER bundle (evidence loss / replay), only with a newer one
  const weak = scenario('HOLDOUT', { ev: { ...INCR, data_state: 'PARTIAL' } });
  assert.equal(weak.result.outcome, 'NOT_MEASURABLE');
  const strongOld = bundleOf(weak.c, weak.run, { ...INCR, assessed_at: '2026-10-23T00:00:00Z' });
  assert.equal(code(() => m4.evaluateMarketingRunResult(weak.result, { ...weak.opts, bundle: strongOld, asOf: '2026-10-27T00:00:00Z' })), 'MKT_M4_RESULT_EVIDENCE_REGRESSION');
  const strongNew = bundleOf(weak.c, weak.run, { ...INCR, assessed_at: '2026-10-26T00:00:00Z' });
  assert.equal(m4.evaluateMarketingRunResult(weak.result, { ...weak.opts, bundle: strongNew, asOf: '2026-10-27T00:00:00Z' }).outcome, 'CONFIRMED');
  assert.equal(m4.evaluateMarketingRunResult(c.result, { ...c.opts, asOf: '2026-12-01T00:00:00Z' }).outcome, 'CONFIRMED'); // unchanged evidence, unchanged answer
});

// ------------------------------------------------------------------ learning (105-120)

test('Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit', () => {
  const confirmed = learnOf(CONFIRMED()); // 105
  assert.deepEqual([confirmed.conclusion, confirmed.evidence_class, confirmed.direction], ['CONFIRMED', 'INCREMENTAL', 'SUPPORTS']);
  const suggestive = learnOf(SUGGESTIVE_UP()); // 106
  assert.deepEqual([suggestive.conclusion, suggestive.evidence_class], ['SUGGESTIVE', 'ATTRIBUTED']);
  assert.ok(suggestive.limitations.includes('ATTRIBUTION_IS_NOT_CAUSALITY')); // never promoted to a fact
  const refuted = learnOf(REFUTED()); // 107
  assert.deepEqual([refuted.conclusion, refuted.direction], ['REFUTED', 'CHALLENGES']);
  const notMeasurable = learnOf(NOT_MEASURABLE()); // 108
  assert.deepEqual([notMeasurable.conclusion, notMeasurable.direction], ['NOT_MEASURABLE', 'INCONCLUSIVE']);
  assert.ok(notMeasurable.limitations.includes('INCREMENTALITY_NOT_ESTABLISHED')); // a lesson about the limits of the test
  assert.equal(code(() => learnOf(UNKNOWN())), 'MKT_M4_LEARNING_OUTCOME_NOT_ALLOWED'); // 109
  assert.equal(code(() => learnOf(PENDING())), 'MKT_M4_LEARNING_RESULT_NOT_FINAL'); // 110
  assert.deepEqual(Object.values(m4.LEARNING_CONCLUSION), ['CONFIRMED', 'SUGGESTIVE', 'REFUTED', 'NOT_MEASURABLE']);
  // 111 / 112: an attributed or offline result, however good, teaches SUGGESTIVE - never CONFIRMED / REFUTED
  assert.equal(learnOf(scenario('HOLDOUT')).conclusion, 'SUGGESTIVE');
  assert.equal(learnOf(scenario('HOLDOUT', { ev: { assessment_status: 'CHALLENGES' } })).conclusion, 'SUGGESTIVE');
  assert.equal(learnOf(scenario('HOLDOUT', { ev: OFFLINE })).conclusion, 'SUGGESTIVE');
  assert.equal(learnOf(scenario('HOLDOUT', { exec: 'PARTIAL', ev: INCR })).conclusion, 'SUGGESTIVE'); // 113
  assert.equal(learnOf(scenario('HOLDOUT', { exec: 'PARTIAL', ev: { ...INCR, assessment_status: 'CHALLENGES' } })).conclusion, 'SUGGESTIVE');
  assert.equal(code(() => learnOf(CONFIRMED(), { valid_until: '2026-10-25T00:00:00Z' })), 'MKT_M4_LEARNING_INVALID_VALIDITY'); // 114
  assert.equal(code(() => learnOf(CONFIRMED(), { valid_until: '2026-10-24T00:00:00Z' })), 'MKT_M4_LEARNING_INVALID_VALIDITY');
  assert.equal(confirmed.valid_until, '2026-12-25T00:00:00.000Z');
  assert.equal(confirmed.validity_basis_ref, 'basis://review-cycle'); // 115
  assert.equal(code(() => learnOf(CONFIRMED(), { validity_basis_ref: undefined })), E.INVALID_FIELD);
  assert.equal(m4.evaluateLearningReuse(confirmed, { asOf: '2026-11-01T00:00:00Z' }).reuse_status, 'REUSABLE'); // 116
  assert.equal(m4.evaluateLearningReuse(confirmed, { asOf: '2026-12-24T23:59:59Z' }).reuse_status, 'REUSABLE');
  const stale = m4.evaluateLearningReuse(confirmed, { asOf: '2026-12-25T00:00:00Z' }); // 117
  assert.equal(stale.reuse_status, 'STALE');
  assert.deepEqual([...stale.review_signals], ['LEARNING_STALE']);
  assert.equal(confirmed.reuse_status, 'REUSABLE'); // the stored value is a snapshot, the live answer is separate
  assert.equal(learnOf(CONFIRMED()).learning_id, confirmed.learning_id); // 118
  assert.match(confirmed.learning_id, /^mlg_[0-9a-f]{32}$/);
  assert.notEqual(learnOf(CONFIRMED(), { valid_until: '2027-01-01T00:00:00Z' }).learning_id, confirmed.learning_id);
  // a stored result that no longer says what the live evaluation says cannot teach
  const s = SUGGESTIVE_UP();
  const stored = forge(s.result, 'result_id', 'mrr', { outcome: 'CONFIRMED' });
  assert.equal(code(() => learnOf({ ...s, result: stored })), 'MKT_M4_LEARNING_RESULT_NOT_LIVE');
  assert.equal(m4.normalizeMarketingLearning(confirmed, { ...CONFIRMED().opts, result: CONFIRMED().result }).learning_id, confirmed.learning_id);
  assert.equal(code(() => m4.normalizeMarketingLearning({ ...confirmed, conclusion: 'REFUTED' }, { ...CONFIRMED().opts, result: CONFIRMED().result })), 'MKT_M4_LEARNING_DERIVED_MISMATCH');
  assert.equal(code(() => m4.evaluateLearningReuse({ ...confirmed, valid_until: '2099-01-01T00:00:00Z' }, { asOf: FINAL_AT })), 'MKT_M4_LEARNING_DERIVED_MISMATCH');
  // 119: M1 objects are never mutated, and a Learning exposes no way to change them
  const findingBefore = JSON.stringify(CH.HOLDOUT.finding);
  learnOf(CONFIRMED());
  assert.equal(JSON.stringify(CH.HOLDOUT.finding), findingBefore);
  assert.ok(isDeepFrozen(CH.HOLDOUT.finding));
  assert.deepEqual([...keysDeep(confirmed)].filter((k) => /hypothes.*status|finding_status|signal_update|mutate/.test(k)), []);
  assert.ok(isDeepFrozen(confirmed)); // 120
});

// ------------------------------------------------------------------ follow-up (121-141)

test('Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result', () => {
  assert.equal(fuOf(CONFIRMED(), 'PROPOSE_CONTINUE').proposal_type, 'PROPOSE_CONTINUE'); // 121
  assert.equal(fuOf(SUGGESTIVE_UP(), 'PROPOSE_CONTINUE').readiness, 'READY_FOR_SOCLE'); // 122
  assert.equal(code(() => fuOf(SUGGESTIVE_DOWN(), 'PROPOSE_CONTINUE')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE'); // 123
  assert.equal(code(() => fuOf(REFUTED(), 'PROPOSE_CONTINUE')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE');
  assert.equal(fuOf(REFUTED(), 'PROPOSE_STOP').proposal_type, 'PROPOSE_STOP'); // 124
  assert.equal(fuOf(SUGGESTIVE_DOWN(), 'PROPOSE_STOP').proposal_type, 'PROPOSE_STOP'); // 125
  assert.equal(code(() => fuOf(SUGGESTIVE_UP(), 'PROPOSE_STOP')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE');
  const stopped = scenario('TIME', { ev: { ...STOP_MET, ...PENDING_EV }, asOf: PENDING_AT }); // 126: a MET stop rule admits STOP, whatever the outcome
  assert.equal(stopped.result.outcome, 'SUGGESTIVE'); // SUPPORTS on attribution only
  assert.equal(fuOf(stopped, 'PROPOSE_STOP').proposal_type, 'PROPOSE_STOP');
  assert.equal(fuOf(CONFIRMED(), 'PROPOSE_SCALE').proposal_type, 'PROPOSE_SCALE'); // 127
  assert.equal(code(() => fuOf(SUGGESTIVE_UP(), 'PROPOSE_SCALE')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE'); // 128: attribution alone never scales
  assert.equal(code(() => fuOf(scenario('HOLDOUT', { ev: OFFLINE }), 'PROPOSE_SCALE')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE');
  assert.equal(code(() => fuOf(scenario('HOLDOUT', { exec: 'PARTIAL', ev: INCR }), 'PROPOSE_SCALE')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE'); // 129
  assert.equal(code(() => fuOf(NOT_MEASURABLE(), 'PROPOSE_SCALE')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE'); // 130
  assert.equal(code(() => fuOf(scenario('HOLDOUT', { ev: { ...INCR, ...STOP_MET } }), 'PROPOSE_SCALE')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE'); // a MET stop rule blocks SCALE
  assert.equal(fuOf(SUGGESTIVE_UP(), 'PROPOSE_ADJUST', { change_refs: ['change://copy-1'] }).proposal_type, 'PROPOSE_ADJUST'); // 131
  assert.equal(fuOf(REFUTED(), 'PROPOSE_ADJUST', { change_refs: ['change://copy-1'] }).proposal_type, 'PROPOSE_ADJUST'); // 132
  assert.equal(fuOf(NOT_MEASURABLE(), 'PROPOSE_ADJUST', { change_refs: ['change://design-1'] }).proposal_type, 'PROPOSE_ADJUST'); // 133
  assert.equal(code(() => fuOf(SUGGESTIVE_UP(), 'PROPOSE_ADJUST')), 'MKT_M4_FOLLOW_UP_CHANGES_REQUIRED'); // 134
  assert.equal(code(() => fuOf(CONFIRMED(), 'PROPOSE_ADJUST', { change_refs: ['change://x'] })), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE');
  assert.equal(fuOf(SUGGESTIVE_UP(), 'PROPOSE_TEST_AGAIN').proposal_type, 'PROPOSE_TEST_AGAIN'); // 135
  assert.equal(fuOf(NOT_MEASURABLE(), 'PROPOSE_TEST_AGAIN').proposal_type, 'PROPOSE_TEST_AGAIN'); // 136
  assert.equal(code(() => fuOf(UNKNOWN(), 'PROPOSE_TEST_AGAIN')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE'); // 137: waiting for data is not a reason to re-test
  assert.equal(code(() => fuOf(PENDING(), 'PROPOSE_TEST_AGAIN')), 'MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE');
  const nothing = fuOf(UNKNOWN(), 'DO_NOTHING', { reason_codes: ['WAIT'] }); // 138
  assert.deepEqual([...nothing.reason_codes], ['RESULT_UNKNOWN', 'WAIT', 'WAITING_FOR_DATA']);
  assert.equal(fuOf(CONFIRMED(), 'DO_NOTHING').proposal_type, 'DO_NOTHING');
  assert.equal(code(() => fuOf(CONFIRMED(), 'DO_NOTHING', { evidence_refs: [] })), 'MKT_M4_FOLLOW_UP_EVIDENCE_REQUIRED'); // 139
  assert.equal(code(() => fuOf(CONFIRMED(), 'DO_NOTHING', { reason_codes: [] })), 'MKT_M4_FOLLOW_UP_REASON_REQUIRED');
  assert.equal(code(() => fuOf(CONFIRMED(), 'PROPOSE_TELEPORT')), 'MKT_M4_FOLLOW_UP_INVALID_TYPE');
  assert.deepEqual(Object.values(m4.FOLLOW_UP_TYPE), ['PROPOSE_CONTINUE', 'PROPOSE_STOP', 'PROPOSE_ADJUST', 'PROPOSE_SCALE', 'PROPOSE_TEST_AGAIN', 'DO_NOTHING']);
});

test('Follow-up: deterministic, frozen, no winner or auto-action, and its readiness is recomputed live', () => {
  const s = CONFIRMED();
  const a = fuOf(s, 'PROPOSE_CONTINUE'); // 140
  assert.match(a.follow_up_id, /^mfu_[0-9a-f]{32}$/);
  assert.equal(fuOf(CONFIRMED(), 'PROPOSE_CONTINUE').follow_up_id, a.follow_up_id);
  assert.notEqual(fuOf(s, 'PROPOSE_SCALE').follow_up_id, a.follow_up_id);
  assert.ok(isDeepFrozen(a)); // 141
  for (const key of ['winner', 'ranking', 'score', 'selected_follow_up', 'budget_change', 'auto_scale']) {
    assert.equal(code(() => fuOf(s, 'PROPOSE_CONTINUE', { [key]: 1 })), 'MKT_M4_FORBIDDEN_FIELD', key);
  }
  assert.equal(code(() => fuOf(s, 'PROPOSE_CONTINUE', { merchant_id: M2 })), 'MKT_UNKNOWN_KEY');
  const ctx = { ...s.opts, result: s.result };
  assert.equal(m4.evaluateFollowUpReadiness(a, { ...ctx, asOf: s.asOf }).status, 'READY_FOR_SOCLE');
  assert.equal(m4.evaluateFollowUpReadiness(a, { ...ctx, asOf: '2026-11-25T00:00:00Z' }).status, 'STALE');
  const noEvidence = fuOf(NOT_MEASURABLE(), 'PROPOSE_TEST_AGAIN', { evidence_refs: [] });
  assert.equal(noEvidence.readiness, 'NEEDS_EVIDENCE');
  const degraded = bundleOf(s.c, s.run, { ...INCR, assessment_status: 'NOT_MEASURABLE', assessed_at: '2026-10-26T00:00:00Z' });
  const live = m4.evaluateFollowUpReadiness(a, { ...ctx, bundle: degraded, asOf: '2026-10-27T00:00:00Z' });
  assert.equal(live.status, 'NOT_ELIGIBLE'); // the stored READY_FOR_SOCLE is a snapshot
  assert.equal(a.readiness, 'READY_FOR_SOCLE');
  assert.equal(m4.normalizeMarketingFollowUpProposal(a, ctx).follow_up_id, a.follow_up_id);
  assert.equal(code(() => m4.normalizeMarketingFollowUpProposal({ ...a, proposal_type: 'PROPOSE_SCALE' }, ctx)), 'MKT_M4_FOLLOW_UP_DERIVED_MISMATCH');
  assert.equal(code(() => fuOf(s, 'PROPOSE_CONTINUE', { expires_at: s.asOf })), 'MKT_M4_FOLLOW_UP_INVALID_EXPIRY');
  assert.equal(code(() => m4.evaluateFollowUpReadiness(forge(a, 'follow_up_id', 'mfu', { merchant_id: M2 }), { ...ctx, asOf: s.asOf })), 'MKT_M4_PACKAGE_SCOPE_MISMATCH');
});

// ------------------------------------------------------------------ steer package (142-158)

test('Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking', () => {
  const s = CONFIRMED();
  const cont = fuOf(s, 'PROPOSE_CONTINUE');
  const pkg = packageOf(s, [cont, fuOf(s, 'PROPOSE_SCALE')]); // 142
  assert.match(pkg.steer_package_id, /^msp_[0-9a-f]{32}$/);
  assert.deepEqual([pkg.merchant_id, pkg.brand_id, pkg.run_ref, pkg.result_ref], [M1, B1, s.run.run_id, s.result.result_id]);
  assert.equal(packageOf(CONFIRMED(), [cont, fuOf(CONFIRMED(), 'PROPOSE_SCALE')]).steer_package_id, pkg.steer_package_id); // 143
  assert.deepEqual({ ...pkg.do_nothing }, { reason_codes: ['KEEP_AS_IS'], evidence_refs: ['ev/dn'] }); // 144
  assert.equal(code(() => packageOf(s, [cont], { do_nothing: undefined })), 'MKT_M4_PACKAGE_DO_NOTHING_REQUIRED');
  assert.equal(code(() => packageOf(s, [cont], { do_nothing: { reason_codes: [], evidence_refs: ['ev/dn'] } })), 'MKT_M4_PACKAGE_DO_NOTHING_REQUIRED');
  assert.equal(code(() => packageOf(s, [cont], { do_nothing: { reason_codes: ['X'], evidence_refs: [] } })), 'MKT_M4_PACKAGE_DO_NOTHING_EVIDENCE_REQUIRED');
  assert.equal(code(() => packageOf(s, [cont, cont])), 'MKT_M4_PACKAGE_DUPLICATE_FOLLOW_UP'); // 145
  const otherRun = scenario('HOLDOUT', { ev: INCR }); // 146: another Run of the same Push (another execution) is another scope
  const sameRunOther = runOf(CH.HOLDOUT, { receipt: { execution_ref: 'exec://run-2' } });
  assert.notEqual(sameRunOther.run_id, s.run.run_id);
  assert.equal(otherRun.run.run_id, s.run.run_id);
  assert.equal(code(() => packageOf(s, [forge(cont, 'follow_up_id', 'mfu', { run_ref: sameRunOther.run_id })])), 'MKT_M4_PACKAGE_SCOPE_MISMATCH');
  assert.equal(code(() => packageOf(s, [forge(cont, 'follow_up_id', 'mfu', { result_ref: 'mrr_other' })])), 'MKT_M4_PACKAGE_SCOPE_MISMATCH'); // 147
  assert.equal(code(() => packageOf(s, [forge(cont, 'follow_up_id', 'mfu', { merchant_id: M2 })])), 'MKT_M4_PACKAGE_SCOPE_MISMATCH'); // 148
  assert.equal(code(() => packageOf(s, [forge(cont, 'follow_up_id', 'mfu', { brand_id: B2 })])), 'MKT_M4_PACKAGE_SCOPE_MISMATCH'); // 149
  assert.equal(code(() => packageOf(s, [{ ...cont, readiness: 'NOT_ELIGIBLE' }])), 'MKT_M4_FOLLOW_UP_DERIVED_MISMATCH'); // a tampered follow-up no longer matches its id
  assert.equal(pkg.package_status, 'READY_FOR_SOCLE'); // 150
  assert.deepEqual(pkg.proposal_readiness.map((r) => r.status), ['READY_FOR_SOCLE', 'READY_FOR_SOCLE']);
  const needs = NOT_MEASURABLE(); // 151: admissible but no evidence
  const needsPkg = packageOf(needs, [fuOf(needs, 'PROPOSE_TEST_AGAIN', { evidence_refs: [] })]);
  assert.equal(needsPkg.package_status, 'NEEDS_EVIDENCE');
  const none = packageOf(s, []); // 152: no follow-up at all
  assert.equal(none.package_status, 'NO_ELIGIBLE_FOLLOW_UP');
  assert.deepEqual([...none.do_nothing.reason_codes], ['KEEP_AS_IS']); // still carries DO_NOTHING, and it is not a decision
  assert.equal(m4.evaluateSteerPackageStatus(pkg, { ...s.opts, result: s.result, asOf: '2026-11-19T00:00:00Z' }).status, 'READY_FOR_SOCLE'); // 153
  assert.equal(m4.evaluateSteerPackageStatus(pkg, { ...s.opts, result: s.result, asOf: '2026-11-20T00:00:00Z' }).status, 'STALE');
  const degraded = bundleOf(s.c, s.run, { ...INCR, assessment_status: 'NOT_MEASURABLE', assessed_at: '2026-10-26T00:00:00Z' });
  const liveDegraded = m4.evaluateSteerPackageStatus(pkg, { ...s.opts, result: s.result, bundle: degraded, asOf: '2026-10-27T00:00:00Z' });
  assert.equal(liveDegraded.status, 'STALE'); // the stored result no longer says what the live evaluation says
  assert.ok(liveDegraded.reason_codes.includes('RESULT_NO_LONGER_LIVE'));
  assert.equal(pkg.package_status, 'READY_FOR_SOCLE'); // the stored status is a snapshot
  const many = Array.from({ length: 11 }, (_, i) => fuOf(s, 'DO_NOTHING', { reason_codes: [`R${i}`] })); // 154
  assert.equal(packageOf(s, many.slice(0, 10)).proposals.length, 10);
  assert.equal(code(() => packageOf(s, many)), 'MKT_M4_PACKAGE_TOO_MANY_FOLLOW_UPS');
  assert.deepEqual([...keysDeep(pkg)].filter((k) => /winner|selected|recommended|best_|ranking|rank$|score/.test(k)), []); // 155, 156, 157
  for (const key of ['winner', 'ranking', 'score', 'selected_follow_up', 'recommended_follow_up', 'best_follow_up']) {
    assert.equal(code(() => packageOf(s, [cont], { [key]: 'x' })), 'MKT_M4_FORBIDDEN_FIELD', key);
  }
  assert.deepEqual(Object.values(m4.STEER_PACKAGE_STATUS), ['READY_FOR_SOCLE', 'NEEDS_EVIDENCE', 'NO_ELIGIBLE_FOLLOW_UP', 'STALE']);
  assert.equal(code(() => packageOf(s, [cont], { expires_at: '2026-11-26T00:00:00Z' })), 'MKT_M4_PACKAGE_INVALID_EXPIRY'); // cannot outlive a follow-up
  assert.equal(m4.normalizeMarketingSteerPackage(pkg, { ...s.opts, result: s.result }).steer_package_id, pkg.steer_package_id);
  assert.equal(code(() => m4.normalizeMarketingSteerPackage({ ...pkg, package_status: 'STALE' }, { ...s.opts, result: s.result })), 'MKT_M4_PACKAGE_DERIVED_MISMATCH');
  assert.ok(pkg.review_signals.length >= 0 && [...pkg.review_signals].every((x, i, a) => i === 0 || a[i - 1] < x)); // sorted, unique
  assert.ok(pkg.unresolved_requirement_refs.includes('claim://approved-1')); // carried from the Push, never resolved here
  assert.ok(isDeepFrozen(pkg)); // 158
});

// ------------------------------------------------------------------ attribution / causality (159-167)

test('Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED', () => {
  for (const [ev, cls] of [[OBSERVED, 'OBSERVED'], [{}, 'ATTRIBUTED'], [OFFLINE, 'OFFLINE_ATTRIBUTED']]) { // 159, 160, 161
    for (const status of ['SUPPORTS', 'CHALLENGES']) {
      const { result } = scenario('HOLDOUT', { ev: { ...ev, assessment_status: status } });
      assert.equal(result.evidence_class, cls);
      assert.notEqual(result.incrementality_status, 'MEASURABLE');
      assert.equal(result.outcome, 'SUGGESTIVE', `${cls} ${status}`);
      assert.ok(result.limitations.includes('INCREMENTALITY_NOT_ESTABLISHED'));
    }
  }
  const attributed = scenario('HOLDOUT').result; // 162
  assert.ok(attributed.limitations.includes('ATTRIBUTION_IS_NOT_CAUSALITY'));
  const offline = scenario('HOLDOUT', { ev: OFFLINE }); // 163
  assert.ok(offline.result.limitations.includes('OFFLINE_ATTRIBUTION_IS_NOT_CAUSALITY'));
  assert.ok(offline.bundle.offline_attribution_observations.every((o) => o.causal_claim === false));
  const outcomes = ['NONE', 'TIME', 'HOLDOUT'].map((plan) => scenario(plan, { ev: plan === 'HOLDOUT' ? INCR : {} }).result.outcome); // 164
  assert.deepEqual(outcomes, ['SUGGESTIVE', 'SUGGESTIVE', 'CONFIRMED']); // only the eligible HOLDOUT reaches CONFIRMED
  const everything = JSON.stringify([CONFIRMED(), REFUTED(), SUGGESTIVE_UP(), offline, learnOf(CONFIRMED())]); // 165
  assert.doesNotMatch(everything, /"causal_claim":true/);
  assert.doesNotMatch(everything, /"evidence_class":"CAUSAL"/);
  assert.equal(scenario('TIME', { ev: { assessment_status: 'NOT_MEASURABLE' } }).result.outcome, 'NOT_MEASURABLE'); // 166
  assert.equal(scenario('TIME', { ev: { assessment_status: 'UNKNOWN' } }).result.outcome, 'UNKNOWN'); // 167
  assert.notEqual(m4.OUTCOME.NOT_MEASURABLE, m4.OUTCOME.UNKNOWN);
  assert.equal(code(() => learnOf(UNKNOWN())), 'MKT_M4_LEARNING_OUTCOME_NOT_ALLOWED'); // UNKNOWN never teaches, NOT_MEASURABLE does
  assert.equal(learnOf(NOT_MEASURABLE()).conclusion, 'NOT_MEASURABLE');
});

// ------------------------------------------------------------------ domain boundaries (168-185)

test('Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it', async () => {
  const fns = Object.entries(m4).filter(([, v]) => typeof v === 'function').map(([k]) => k);
  assert.deepEqual(fns.filter((n) => /^(execute|publish|schedule|send|scale|stop|approve|override|force|connect|sync|import|export|persist|save|store|rank|select|choose)/i.test(n)), []); // 168-172
  assert.doesNotMatch(fns.join(' '), /Execute|Publish|Schedule|Connector|Budget|Price|Inventory|Campaign/);
  const sources = {};
  for (const name of M4_FILES) sources[name] = stripComments(await read(name));
  const withoutVocabulary = { ...sources, 'm4-constants': sources['m4-constants'].replace(/export const FORBIDDEN_STEER_KEYS[\s\S]*?\]\);/, '').replace(/export const FORBIDDEN_PII_KEYS[\s\S]*?\]\);/, '') };
  const scan = (pattern) => Object.entries(withoutVocabulary).filter(([, text]) => pattern.test(text)).map(([name]) => name);
  assert.deepEqual(scan(/Date\.now|new Date\(\)|Math\.random/), []); // 168-172: no clock, no randomness
  assert.deepEqual(scan(/\bfetch\(|\baxios\b|\bhttps?\.request|XMLHttpRequest|WebSocket|node:net|node:http/), []); // 178
  assert.deepEqual(scan(/supabase|\bpg\b|knex|prisma|sqlite|mongo/i), []); // 179
  assert.deepEqual(scan(/writeFile|readFile|node:fs|appendFile|createWriteStream|unlink/), []); // 180
  assert.deepEqual(scan(/OpenAI|Anthropic|Gemini|Qwen|Alibaba|\bllm\b|\bvlm\b|completion/i), []); // 177
  assert.deepEqual(scan(/\bpublish\b|\bsend\b|\bschedule\b|\bcron\b|setTimeout|setInterval/), []); // 169, 170
  assert.deepEqual(scan(/budget_change|selected_follow_up|\bwinner\b|ranking_score|confidence_score|causal_claim:\s*true/), []); // 171, 172
  assert.deepEqual(scan(/price|inventory_level|stock_level|setPrice|updateStock/i), []); // 173, 174
  assert.deepEqual(scan(/customer_profile|segmentMembers|\bemail\b|\bphone\b/i), []); // 175
  assert.deepEqual(scan(/finance|margin|revenue|profit|from '\.\.\/finance/i), []); // 176
  assert.deepEqual(scan(/statistical|power_analysis|sample_size|p_value|confidence_interval|ttest|bayes/i), []); // 181
  assert.deepEqual(scan(/ab_test|abTest|variant_allocation|randomi[sz]e|\ballocator\b/i), []); // 182
  assert.deepEqual(scan(/geo_?lift|geolift/i), []); // 183
  assert.deepEqual(scan(/\bMMM\b|marketing_mix|mediaMix/i), []); // 184
  assert.deepEqual(scan(/multi_?touch|touchpoint|shapley|markov/i), []); // 185
  assert.ok(Object.keys(m4).every((k) => k !== 'default'));
  // the vocabulary of forbidden keys exists only as refusals
  assert.ok(m4.FORBIDDEN_STEER_KEYS.includes('winner') && m4.FORBIDDEN_STEER_KEYS.includes('selected_follow_up'));
});

// ------------------------------------------------------------------ non-regression (186-194)

test('Non-regression: M1, M1.5, M2, M3, Measurement, Branding and Creative Fidelity are untouched and do not depend on M4', async () => {
  assert.deepEqual(Object.keys(understand).filter((k) => /Run|Learning|FollowUp|Steer/.test(k)), []); // 186
  assert.deepEqual(Object.keys(m2).filter((k) => /Run|Learning|FollowUp|Steer/.test(k)), []); // 188
  assert.deepEqual(Object.keys(m3).filter((k) => /Run|Learning|FollowUp|Steer/.test(k)), []); // 189
  assert.equal(typeof m3.buildActivationManifest, 'function');
  assert.equal(typeof m2.evaluatePushReadiness, 'function');
  for (const name of ['build', 'provenance', 'traffic', 'paid', 'search', 'search-visibility', 'index', 'understand', 'm2', 'm3', 'lost-demand', 'calendar-signals', 'manual-observation', 'phase3-contract']) { // 187, 190
    const text = await read(name);
    assert.doesNotMatch(text, /from '\.\/(m4|marketing-run|run-evidence|run-result|marketing-learning|follow-up-proposal|steer-package|execution-receipt)/, name);
  }
  assert.doesNotMatch(await read('index'), /m4|steer/); // the CLI is untouched
  // 191-194: the Branding, Creative Fidelity, Marketing focused and full suites are executed by the Marketing V1 workflow
});

// ------------------------------------------------------------------ coverage matrix (doc <-> tests)

test('Coverage matrix: the doc maps all 194 mandate cases, and every test it names exists', async () => {
  const doc = await readFile(new URL('../docs/architecture/marketing-m4-steer-contract.md', import.meta.url), 'utf8');
  const self = await readFile(new URL(import.meta.url), 'utf8');
  const matrix = doc.slice(doc.indexOf('<!-- coverage-matrix:start -->'), doc.indexOf('<!-- coverage-matrix:end -->'));
  const rows = [...matrix.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ n: Number(m[1]), name: m[3] }));
  assert.ok(rows.length >= 194);
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: rows.length }, (_, i) => i + 1)); // contiguous: the mandate numbering 1-194 is never reshuffled
  for (const { n, name } of rows) {
    const known = name.startsWith('(CI)') || self.includes(`test('${name}'`);
    assert.ok(known, `mandate case ${n} names a test that does not exist: ${name}`);
  }
});
