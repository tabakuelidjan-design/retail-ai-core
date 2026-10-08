// MarketingRun: the governed snapshot of an activation that REALLY happened. It carries no result.
//
// Built only from the original Push, the original ActivationManifest, a SocleExecutionAuthorization, a MarketingExecutionReceipt, the
// tenant and an explicit clock. M4 validates scopes; it does not re-judge the creative, rebuild the Guardian or recompute anything.
// The observation window is the MeasurementPlan's (reused as is, never a second window). Like every M2/M3 object a stored Run is a
// snapshot: it is re-validated against its originals and never read as a live authority.

import {
  EXECUTION_STATUS, M4_ERROR as Z, MARKETING_STEER_VERSION, RUN_SIGNAL,
} from './m4-constants.js';
import { normalizeMarketingExecutionReceipt, normalizeSocleExecutionAuthorization } from './execution-receipt.js';
import {
  assertOwnId, canonical, sortedUnique, verifiedManifest, verifiedPush,
} from './m4-validation.js';
import {
  asOfValue, closedObject, deepFreeze, deriveId, fail, isPlainObject, tenantMerchantId, toMs,
} from './understand-validation.js';

const OPTION_KEYS = ['tenant', 'push', 'activationManifest', 'authorization', 'receipt', 'asOf'];
const RUN_KEYS = [
  'run_id', 'schema_version', 'merchant_id', 'brand_id', 'finding_ref', 'push_ref', 'activation_manifest_ref', 'execution_ref',
  'execution_status', 'activated_at', 'measurement_plan_ref', 'observation_window', 'created_at', 'review_signals',
];

// M4 does not own the offline / online taxonomy of channels (M2 channels are extensible): it never infers an expected offline
// attribution from a channel name. A real offline measurement arrives as an OfflineAttributionObservation (OFFLINE_ATTRIBUTED).
function runSignals({ push, receipt, createdAt }) {
  const signals = [];
  if (receipt.execution_status === EXECUTION_STATUS.PARTIAL) signals.push(RUN_SIGNAL.PARTIAL_EXECUTION);
  if (!push.measurement_plan.incrementality_candidate) signals.push(RUN_SIGNAL.INCREMENTALITY_NOT_ELIGIBLE);
  if (toMs(createdAt) < toMs(push.measurement_plan.observation_window.end)) signals.push(RUN_SIGNAL.MEASUREMENT_WINDOW_NOT_COMPLETE);
  return sortedUnique(signals);
}

/**
 * @param {object} p { tenant, push, activationManifest, authorization, receipt, asOf } - the originals and the explicit clock.
 * The Run's scope, execution status and activation time are DERIVED from them; none can be supplied.
 */
export function buildMarketingRun(options = {}) {
  closedObject(options, OPTION_KEYS, 'run');
  const merchantId = tenantMerchantId(options.tenant);
  const createdAt = asOfValue(options.asOf);
  const push = verifiedPush(options.push, merchantId);
  const manifest = verifiedManifest(options.activationManifest, push, merchantId);
  const authorization = normalizeSocleExecutionAuthorization(options.authorization, { activationManifest: manifest, push });
  const receipt = normalizeMarketingExecutionReceipt(options.receipt, { merchantId, activationManifest: manifest, push, authorization });
  if (toMs(receipt.recorded_at) > toMs(createdAt)) fail(Z.RUN_RECEIPT_IN_FUTURE, 'the receipt was recorded after the Run is created');

  const body = {
    schema_version: MARKETING_STEER_VERSION,
    merchant_id: merchantId,
    brand_id: push.brand_id,
    finding_ref: push.finding_ref,
    push_ref: push.push_id,
    activation_manifest_ref: manifest.activation_manifest_id,
    execution_ref: receipt.execution_ref,
    execution_status: receipt.execution_status,
    activated_at: receipt.activated_at,
    measurement_plan_ref: manifest.measurement_plan_ref,
    observation_window: { ...push.measurement_plan.observation_window }, // reused exactly, never a second window
    created_at: createdAt,
    review_signals: runSignals({ push, receipt, createdAt }),
  };
  return deepFreeze({ run_id: deriveId('mrn', body), ...body });
}

/** Re-validates a STORED Run against the originals it claims to come from, by rebuilding it at its own created_at. */
export function normalizeMarketingRun(input, options = {}) {
  closedObject(input, RUN_KEYS, 'run');
  const rebuilt = buildMarketingRun({ ...options, asOf: input.created_at });
  if (canonical(rebuilt) !== canonical(input)) fail(Z.RUN_DERIVED_MISMATCH, 'the Run does not match what its originals produce');
  return rebuilt;
}

/**
 * A stored Run as used by the later steps (evidence, result, learning...): its own id must match, and its scope must be the
 * tenant's and the original Push's. The authorization and receipt are not needed again (the Run already is their snapshot).
 */
export function verifiedRun(run, push, merchantId) {
  assertOwnId(run, 'run_id', 'mrn', Z.RUN_DERIVED_MISMATCH, 'the Run does not match its own id');
  if (!isPlainObject(run.observation_window)) fail(Z.RUN_DERIVED_MISMATCH, 'the Run has no observation window');
  const sameScope = run.merchant_id === merchantId && run.brand_id === push.brand_id && run.finding_ref === push.finding_ref
    && run.push_ref === push.push_id && run.measurement_plan_ref === `${push.push_id}#measurement`;
  if (!sameScope) fail(Z.SCOPE_MISMATCH, 'the Run is not in the scope of the tenant and the Push');
  if (canonical(run.observation_window) !== canonical(push.measurement_plan.observation_window)) {
    fail(Z.RUN_DERIVED_MISMATCH, 'the Run observation window is not the MeasurementPlan one');
  }
  return run;
}
