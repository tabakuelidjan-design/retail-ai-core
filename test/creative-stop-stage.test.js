import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import {
  buildExecutionChain, classifyRuntimeError, classifyRuntimeStop, createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst,
  createVisualProductionDirector, DECISION, describeStop, DIRECTOR_CONSTANTS, ROOT_CAUSE, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import {
  BRAND, buildBrief, directorAnswer, fakeEnvironmentPort, fonts, GUARDIAN_PASS,
} from './runtime-world.js';

// Where a creative run really stopped (`// SS-N` markers): the layout is solved BEFORE the billable environment call, and a stop is described by its real stage and one classified cause.

const AT = '2026-10-10T12:00:00.000Z';

function setup(answer) {
  const ledger = createDecisionLedger();
  const environment = fakeEnvironmentPort();
  return {
    ledger, environment,
    run: () => runProductPreservingCreative({
      at: AT, brief: buildBrief(), fonts, ledger, guardian: GUARDIAN_PASS,
      agents: {
        analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
        director: createCreativeDirector({ ledger, complete: async () => ({ text: answer }), constants: DIRECTOR_CONSTANTS }),
        copy: createApprovedCopyAgent({ ledger }),
        visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
      },
      ports: { segmenter: createLocalProductSegmenter({ ledger }), environment },
    }),
  };
}
// a direction whose recipe has a slot for every role but whose text column cannot hold the approved supporting claim on one line (a real capability limit of the layout rules)
const UNSOLVABLE = directorAnswer({ spatial_intent: 'PRODUCT_START_TEXT_END', negative_space_intent: 'SURROUNDING', hierarchy: ['PRODUCT', 'HEADLINE', 'SUBHEADLINE', 'PRICE'] });

test('SS-1 an unsolvable layout stops the run BEFORE the billable environment call, with its record, and is classified as a layout capability limit', async () => {
  const s = setup(UNSOLVABLE);
  const result = await s.run();
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'THE_LAYOUT_COULD_NOT_BE_SOLVED');
  assert.equal(result.before_environment_call, true);
  assert.equal(s.environment.calls.length, 0, 'no provider call is made for a layout that cannot be solved');
  assert.deepEqual(result.violations.map((v) => [v.code, v.layers[0], v.reasons[0]]), [['TEXT_DOES_NOT_FIT', 'text-subheadline', 'TOO_MANY_LINES']]);
  // the record keeps what was decided up to the stop: the recipe, the placement (UNSATISFIED) and the typography with its violations; nothing after
  const seen = new Set(result.ledger.map((e) => e.decision));
  for (const d of [DECISION.LAYOUT_RECIPE, DECISION.PRODUCT_PLACEMENT, DECISION.TYPOGRAPHY_PLACEMENT]) assert.ok(seen.has(d), d);
  for (const d of [DECISION.ENVIRONMENT_SUITABILITY, DECISION.TEXT_STYLE, DECISION.PREFLIGHT, DECISION.FIDELITY, DECISION.BRAND_GUARDIAN]) assert.ok(!seen.has(d), d);
  assert.equal(result.ledger.find((e) => e.decision === DECISION.PRODUCT_PLACEMENT).outcome.status, 'UNSATISFIED');
  assert.equal(result.steering.manual_creative_steering, 'NONE');
  // classification and wording
  const stop = describeStop({ result });
  assert.equal(stop.cause, ROOT_CAUSE.LAYOUT_CAPABILITY_LIMIT);
  assert.equal(stop.stage, 'LAYOUT_PLAN');
  assert.equal(stop.reached_gates, false);
  assert.match(stop.status, /^STOPPED_AT_LAYOUT_PLAN: LAYOUT_CAPABILITY_LIMIT/);
  assert.doesNotMatch(stop.status, /did not pass the deterministic gates/);
});

test('SS-2 the execution chain is derived from evidence: a step with no evidence is NOT RUN, and no gate is claimed to have run', async () => {
  const result = await setup(UNSOLVABLE).run();
  const chain = buildExecutionChain({ result, events: [] });
  assert.equal(chain.length, 13);
  const state = Object.fromEntries(chain.map((c) => [c.step, c.state]));
  assert.equal(state['Environment image call'], 'NOT SENT');
  assert.equal(state['Environment suitability gate'], 'NOT RUN');
  assert.equal(state['Layout plan'], 'FAIL');
  assert.equal(state.DesignDocument, 'FAIL');
  for (const step of ['Render', 'Preflight', 'Fidelity', 'Brand Guardian']) assert.equal(state[step], 'NOT RUN', step);
  // with the provider journal of a run that paid for the environment before stopping
  const events = [
    { event: 'RESERVED', operation_id: 'op-1', model: 'qwen3.8-max' }, { event: 'SUCCEEDED', operation_id: 'op-1', model: 'qwen3.8-max', request_id: 'chatcmpl-x' },
    { event: 'RESERVED', operation_id: 'op-2', model: 'qwen-image-3.0-pro', operation: 'IMAGE_GENERATE_ENVIRONMENT' }, { event: 'SUCCEEDED', operation_id: 'op-2', model: 'qwen-image-3.0-pro', operation: 'IMAGE_GENERATE_ENVIRONMENT', request_id: 'env-req' },
  ];
  const paid = Object.fromEntries(buildExecutionChain({ result, events }).map((c) => [c.step, c]));
  assert.equal(paid['Revision Director call'].state, 'SENT');
  assert.equal(paid['Revision Director provider result'].state, 'SUCCESS');
  assert.equal(paid['Revision Director provider result'].detail, 'chatcmpl-x');
  assert.equal(paid['Environment image call'].state, 'SENT');
  assert.equal(paid['Environment image call'].detail, 'env-req');
  // a failed Director completion is a FAIL, not a success and not a skipped step
  const failedDirector = Object.fromEntries(buildExecutionChain({ result: { ledger: [] }, events: [{ event: 'RESERVED', operation_id: 'op-1', model: 'qwen3.8-max' }, { event: 'FAILED', operation_id: 'op-1', model: 'qwen3.8-max', reason: 'TIMEOUT' }] }).map((c) => [c.step, c]));
  assert.equal(failedDirector['Revision Director call'].state, 'SENT');
  assert.equal(failedDirector['Revision Director provider result'].state, 'FAIL');
  assert.equal(failedDirector['Revision Director provider result'].detail, 'TIMEOUT');
  assert.equal(failedDirector['Environment image call'].state, 'NOT SENT');
});

test('SS-3 the "did not pass the deterministic gates" wording is used only when a candidate existed and a gate really ran and failed', () => {
  const ran = { status: 'GUARDIAN_FAIL', png_sha256: 'a'.repeat(64), preflight: { status: 'PASS' }, fidelity: { gate: 'PASS' }, guardian: { outcome: 'FAIL' } };
  const gated = describeStop({ result: ran });
  assert.equal(gated.cause, ROOT_CAUSE.GUARDIAN_FAIL);
  assert.equal(gated.reached_gates, true);
  assert.match(gated.status, /did not pass the deterministic gates/);
  // the same status without a candidate or without any gate result: the stage is named instead
  for (const result of [
    { status: 'GUARDIAN_FAIL', png_sha256: null, preflight: null, fidelity: null, guardian: null },
    { status: 'BLOCKED', reason: 'THE_LAYOUT_COULD_NOT_BE_SOLVED', png_sha256: null, preflight: null, fidelity: null, guardian: null },
    { status: 'BLOCKED', reason: 'ENVIRONMENT_NOT_EMPTY' },
    { status: 'GUARDIAN_FAIL', png_sha256: null, preflight: { status: 'PASS' }, fidelity: { gate: 'PASS' }, guardian: { outcome: 'FAIL' } }, // a gate result without a candidate is not a gate that ran on one
  ]) {
    const stop = describeStop({ result });
    assert.equal(stop.reached_gates, false);
    assert.doesNotMatch(stop.status, /did not pass the deterministic gates/);
    assert.match(stop.status, /^STOPPED_AT_/);
  }
});

test('SS-4 every reason the runtime can stop with has one classified cause, and thrown errors are classified by their real origin', () => {
  const expected = {
    THE_LAYOUT_COULD_NOT_BE_SOLVED: 'LAYOUT_CAPABILITY_LIMIT', NO_LAYOUT_RECIPE_FOR_THE_SPATIAL_INTENT: 'LAYOUT_CAPABILITY_LIMIT', NO_LAYOUT_RECIPE_COVERS_THE_HIERARCHY: 'LAYOUT_CAPABILITY_LIMIT',
    ENVIRONMENT_NOT_EMPTY: 'ENVIRONMENT_NOT_EMPTY', NO_BRAND_COLOUR_PAIR_READS: 'DESIGN_DOCUMENT_FAILURE', THE_ENVIRONMENT_IS_NOT_A_DECODABLE_PNG: 'ENVIRONMENT_PROVIDER_FAILURE',
    THE_ENVIRONMENT_SIZE_DIFFERS_FROM_THE_CANVAS: 'ENVIRONMENT_PROVIDER_FAILURE', SEGMENTATION_LOW_CONFIDENCE: 'VISUAL_PRODUCTION_PLAN_FAILURE',
    THE_STRATEGY_PRODUCED_NO_CUTOUT_OR_NO_ENVIRONMENT: 'VISUAL_PRODUCTION_PLAN_FAILURE', A_REVISION_NEEDS_A_REVISION_DIRECTOR: 'REVISION_DIRECTION_INVALID', BRAND_GUARDIAN_NOT_CONFIGURED: 'GUARDIAN_FAIL',
  };
  for (const [reason, cause] of Object.entries(expected)) assert.equal(classifyRuntimeStop({ status: 'BLOCKED', reason }), cause, reason);
  for (const [status, cause] of [['PREFLIGHT_FAIL', 'PREFLIGHT_FAIL'], ['FIDELITY_FAIL', 'FIDELITY_FAIL'], ['GUARDIAN_FAIL', 'GUARDIAN_FAIL']]) assert.equal(classifyRuntimeStop({ status }), cause);
  assert.equal(classifyRuntimeStop({ status: 'BLOCKED', reason: 'SOMETHING_NEW' }), 'RUNTIME_REPORTING_DEFECT'); // an unknown stop is reported as unclassified, never as a gate failure
  const agent = (role, cause) => Object.assign(new Error('x'), { code: CI.CI_ERROR.AGENT_FAILED, detail: { role, cause } });
  assert.equal(classifyRuntimeError(agent('CREATIVE_DIRECTOR', { code: 'REVISED_DIRECTION_NOT_DIFFERENT' })), 'REVISION_NOT_MEANINGFULLY_DIFFERENT');
  assert.equal(classifyRuntimeError(agent('CREATIVE_DIRECTOR', { name: 'AlibabaProviderError', status: 429, code: 'Throttling' })), 'REVISION_DIRECTOR_PROVIDER_FAILURE');
  assert.equal(classifyRuntimeError(agent('CREATIVE_DIRECTOR', { code: 'REVISION_INPUT_NOT_SEMANTIC' })), 'REVISION_DIRECTION_INVALID');
  assert.equal(classifyRuntimeError(agent('CREATIVE_DIRECTOR', { status: 403, code: 'x' })), 'REVISION_DIRECTOR_PROVIDER_FAILURE'); // an HTTP status alone is a provider answer
  assert.equal(classifyRuntimeError(agent('VISUAL_PRODUCTION_DIRECTOR', { code: 'X' })), 'VISUAL_PRODUCTION_PLAN_FAILURE');
  assert.equal(classifyRuntimeError(Object.assign(new Error('x'), { name: 'AlibabaProviderError', code: 'TIMEOUT', requestId: null })), 'ENVIRONMENT_PROVIDER_FAILURE');
  assert.equal(classifyRuntimeError(new Error('boom')), 'RUNTIME_REPORTING_DEFECT');
  assert.equal(describeStop({ error: agent('CREATIVE_DIRECTOR', { code: 'REVISED_DIRECTION_NOT_DIFFERENT' }) }).stage, 'MEANINGFUL_DIFFERENCE_CHECK');
});

test('SS-5 the revision script reports the real stage: no hard-coded gate message, an offline --explain, no process.exit', async () => {
  const source = (await readFile(new URL('../scripts/run-c3-revision.mjs', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /did not pass the deterministic gates/);
  assert.match(source, /describeStop\(\{ result \}\)/);
  assert.match(source, /describeStop\(\{ error \}\)/);
  assert.match(source, /mode === 'explain'/);
  assert.doesNotMatch(source, /process\.exit\(/);
});
