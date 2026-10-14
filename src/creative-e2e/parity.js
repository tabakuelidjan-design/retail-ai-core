import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeLayeredRuntime } from '../creative-runtime/layered-runtime.js';
import {
  E2E_STATE, INVALIDATES, OPERATION, STAGE, STAGE_ORDER,
} from './constants.js';
import { describeEndToEnd, runCreativeEndToEnd } from './e2e.js';
import { RunBudgetError, createRunContext } from './run-context.js';

// THE PARITY AUDIT OF THE END-TO-END RUN: a mechanical probe, like the others. It checks that the final states and the stages are the declared ones, that the run context refuses what it must (an anonymous paid operation,
// a reservation beyond the ceiling, a reused id, a resume of another run), that the entry point stops explicitly on a request without money, without a layer provider and without a request, that the entry point is WIRED to
// the integration segmentation, the layered runtime and the refine (by the references of its own sources), that the layered runtime is still opt-in, and that nothing in this module can reach a network or a provider by itself.

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_STATES = ['READY', 'NEEDS_OWNER_REVIEW', 'BLOCKED', 'TECHNICAL_FAIL', 'PROVIDER_NOT_CONNECTED', 'BUDGET_EXCEEDED'];
const REQUIRED_STAGES = ['REQUEST', 'ASSET', 'SEGMENTATION', 'FORMAT_PLAN', 'BRAIN_PLAN', 'PRODUCTION_PLAN', 'INTEGRATION', 'REFINE', 'FINAL_GATES'];
const FORBIDDEN = [/\bfetch\s*\(/, /node:https?['"]/, /node:net['"]/, /node:child_process['"]/, /node:dgram['"]/, /process\.env/, /\bWebSocket\b/, /\bXMLHttpRequest\b/];
const read = (f) => readFileSync(path.join(DIR, f), 'utf8');

/** @returns {{ ready: boolean, failures: string[], checks: string[], stages: string[], rows: string[] }} (synchronous: the readiness gate is) */
export function auditEndToEndParity() {
  const failures = []; const checks = [];
  const expect = (name, ok) => { checks.push(name); if (!ok) failures.push(name); };

  expect('FINAL_STATES_ARE_EXACTLY_THE_SIX', JSON.stringify(Object.keys(E2E_STATE).sort()) === JSON.stringify([...REQUIRED_STATES].sort()) && Object.keys(E2E_STATE).every((k) => E2E_STATE[k] === k));
  expect('STAGES_ARE_THE_NINE_IN_ORDER', JSON.stringify(STAGE_ORDER) === JSON.stringify(REQUIRED_STAGES) && Object.keys(STAGE).length === 9);
  expect('INVALIDATION_ONLY_GOES_FORWARD', Object.entries(INVALIDATES).every(([s, later]) => later.every((l) => STAGE_ORDER.indexOf(l) > STAGE_ORDER.indexOf(s))) && INVALIDATES[STAGE.REFINE].join() === `${STAGE.FINAL_GATES}` && !INVALIDATES[STAGE.INTEGRATION].includes(STAGE.SEGMENTATION));

  // the run context
  const ctx = createRunContext({ run_id: 'probe-run-1', ceiling_eur: 0.1, ledger: null, at: 'probe' });
  let anonymous = false; try { ctx.operations.begin({ kind: OPERATION.IMAGE_GENERATION }); } catch { anonymous = true; }
  expect('NO_ANONYMOUS_PAID_OPERATION', anonymous);
  const a = ctx.operations.begin({ kind: OPERATION.BRAIN_TEXT, key: 'k1', estimate_eur: 0.03, executor: 'PROVIDER' }); a.complete();
  const b = ctx.operations.begin({ kind: OPERATION.BRAIN_TEXT, key: 'k2', estimate_eur: 0.03, executor: 'PROVIDER' }); b.fail('x');
  const c = ctx.operations.begin({ kind: OPERATION.BRAIN_TEXT, key: 'k3', estimate_eur: 0.03, executor: 'PROVIDER' });
  expect('OPERATION_IDS_ARE_UNIQUE_AND_NEVER_REUSED', new Set([a.id, b.id, c.id]).size === 3 && c.id.endsWith(':BRAIN_TEXT:0003'));
  expect('A_FAILED_OPERATION_RELEASES_ITS_RESERVATION', Math.abs(ctx.budget.snapshot().reserved_eur - 0.03) < 1e-9 && Math.abs(ctx.budget.snapshot().spent_eur - 0.03) < 1e-9);
  let refused = false; try { ctx.operations.begin({ kind: OPERATION.IMAGE_GENERATION, key: 'big', estimate_eur: 0.5, executor: 'PROVIDER' }); } catch (e) { refused = e instanceof RunBudgetError; }
  expect('A_RESERVATION_BEYOND_THE_CEILING_IS_REFUSED_BEFORE_THE_WORK', refused && ctx.operations.list().length === 3);
  expect('A_SETTLED_REQUEST_IS_REUSED_NOT_PAID_TWICE', ctx.operations.begin({ kind: OPERATION.BRAIN_TEXT, key: 'k1', estimate_eur: 0.03, executor: 'PROVIDER' }).reused === true);
  let foreign = false; try { createRunContext({ run_id: 'another-run', ceiling_eur: 1, ledger: null, at: 'x', resume: ctx.exportState() }); } catch { foreign = true; }
  expect('A_RESUME_OF_ANOTHER_RUN_IS_REFUSED', foreign);

  // the wiring, by the references of the sources
  const d = describeEndToEnd();
  expect('THE_ENTRY_POINT_DESCRIBES_ITSELF_AS_WIRED_OPT_IN_AND_NOT_A_REPLACEMENT', d.wired === true && d.opt_in === true && d.replaces_legacy === false && d.entry === 'runCreativeEndToEnd');
  const e2e = read('e2e.js'); const seg = read('segmentation-stage.js'); const integ = read('integration-stage.js');
  expect('IT_IS_WIRED_TO_THE_INTEGRATION_SEGMENTATION', /from '\.\.\/creative-integration\/index\.js'/.test(seg) && /segmentNativeAlpha/.test(seg) && /segmentProduct/.test(seg) && /checkMatte/.test(seg) && /computeProductSegmentation/.test(e2e));
  expect('IT_IS_WIRED_TO_THE_INTEGRATION_CHECKS', /detectArtifacts/.test(integ) && /buildContactShadow/.test(integ) && /validatePlacement/.test(integ) && /checkDelivered/.test(e2e) && /checkProductPlacement/.test(e2e));
  expect('IT_IS_WIRED_TO_THE_LAYERED_RUNTIME_AND_THE_REFINE', /runLayeredCreative/.test(e2e) && /refineCreative/.test(e2e) && /createCampaignPlanner/.test(e2e) && /createProductionPlanner/.test(e2e));
  expect('THE_LAYERED_RUNTIME_REMAINS_OPT_IN_WITHOUT_A_SINGLE_IMAGE_FALLBACK', describeLayeredRuntime().opt_in === true && describeLayeredRuntime().single_image_fallback === false);
  expect('THERE_IS_NO_FALLBACK_TO_A_GENERATED_PRODUCT_IN_THE_RESULT_CONTRACT', /fallback_to_generated_product: false/.test(e2e));

  // nothing here reaches a network or a provider by itself
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.js') && x !== 'parity.js')) { const text = read(f); for (const re of FORBIDDEN) expect(`NO_${re.source}_IN_${f}`, !re.test(text)); }
  return { ready: failures.length === 0, failures, checks, stages: [...new Set(checks.map((x) => x.split('_')[0]))], rows: checks };
}

/** The probes of the ENTRY POINT itself (they run it, so they are asynchronous; the readiness gate calls the synchronous audit above and the test suite calls this one). */
export async function probeEntryPoint() {
  const failures = []; const checks = [];
  const expect = (name, ok) => { checks.push(name); if (!ok) failures.push(name); };
  const stub = { request: { request_ref: 'probe' }, brief: { asset: { bytes: new Uint8Array(4) }, ids: {}, format: {} }, ports: { brainComplete: async () => ({ text: '{}' }) } };
  const noMoney = await runCreativeEndToEnd({ run_id: 'probe-run-2', at: 'probe', ceiling_eur: 0, ...stub });
  expect('A_RUN_WITHOUT_BUDGET_IS_BUDGET_EXCEEDED', noMoney.state === E2E_STATE.BUDGET_EXCEEDED && noMoney.provider_calls.length === 0);
  const noLayer = await runCreativeEndToEnd({ run_id: 'probe-run-3', at: 'probe', ceiling_eur: 1, ...stub });
  expect('A_RUN_WITHOUT_A_LAYER_PROVIDER_IS_PROVIDER_NOT_CONNECTED', noLayer.state === E2E_STATE.PROVIDER_NOT_CONNECTED && noLayer.provider_calls.length === 0 && noLayer.fallback_to_generated_product === false);
  const noRequest = await runCreativeEndToEnd({ run_id: 'probe-run-4', at: 'probe', ceiling_eur: 1, request: null, brief: stub.brief, ports: stub.ports });
  expect('A_RUN_WITHOUT_A_REQUEST_IS_BLOCKED_BEFORE_ANY_WORK', noRequest.state === E2E_STATE.BLOCKED && noRequest.block.code === 'REQUEST_INVALID');
  const badId = await runCreativeEndToEnd({ run_id: 'x', at: 'probe', ceiling_eur: 1, ...stub });
  expect('AN_INVALID_RUN_ID_IS_A_TECHNICAL_FAILURE_NOT_AN_EXCEPTION', badId.state === E2E_STATE.TECHNICAL_FAIL && badId.failure.code === 'RUN_ID_INVALID');

  return { ready: failures.length === 0, failures, checks };
}
