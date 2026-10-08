// SocleExecutionAuthorization and MarketingExecutionReceipt: the INCOMING handoff of an execution that happened elsewhere.
//
// M4 builds no mini-Socle and no execution layer. The authorization is a decision ALREADY taken by the Socle / Policy / a human;
// the receipt is an event ALREADY recorded by an external execution layer. Marketing neither creates nor infers either: this module
// only validates their FORM and their coherence with the original Push and ActivationManifest. It authenticates nobody (trust
// boundary: trusted server-side adapters). A receipt says "an activation was really executed", never that it was a good idea.

import { MKT_ERROR as E } from './understand-constants.js';
import {
  EXECUTION_AUTHORIZATION_SCOPE, EXECUTION_AUTHORIZATION_STATUS, EXECUTION_STATUS, M4_ERROR as Z, MAX_DELIVERY_EXECUTIONS,
} from './m4-constants.js';
import { safeRef, safeRefList } from './m4-validation.js';
import {
  closedObject, deepFreeze, enumValue, fail, isPlainObject, isoTimestamp, toMs, uuidValue,
} from './understand-validation.js';

const AUTH_KEYS = ['authorization_ref', 'decision_ref', 'activation_manifest_ref', 'push_ref', 'scope', 'status', 'authorized_at', 'expires_at'];
const RECEIPT_KEYS = [
  'execution_ref', 'execution_authorization_ref', 'activation_manifest_ref', 'merchant_id', 'brand_id', 'push_ref', 'execution_status',
  'activated_at', 'delivery_execution_refs', 'evidence_refs', 'recorded_at',
];
const DELIVERY_KEYS = ['deliverable_ref', 'delivery_execution_ref'];

/**
 * @param {object} input the authorization, as supplied by a trusted Socle adapter
 * @param {object} p { activationManifest, push } - the ORIGINAL (already verified) manifest and Push it must match
 *
 * scope is exactly EXECUTE, status exactly APPROVED; activation_manifest_ref == manifest.activation_manifest_id;
 * push_ref == manifest.push_ref; authorized_at <= expires_at. Whether it has expired at the execution time is checked against the
 * receipt (see normalizeMarketingExecutionReceipt).
 */
export function normalizeSocleExecutionAuthorization(input, { activationManifest, push } = {}) {
  if (!isPlainObject(activationManifest) || !isPlainObject(push)) {
    fail(E.INVALID_FIELD, 'an execution authorization is validated against its original manifest and Push', { field: 'authorization' });
  }
  closedObject(input, AUTH_KEYS, 'execution_authorization');
  const scope = enumValue(input.scope, { EXECUTE: EXECUTION_AUTHORIZATION_SCOPE }, 'execution_authorization.scope', Z.AUTH_INVALID_SCOPE);
  const status = enumValue(input.status, { APPROVED: EXECUTION_AUTHORIZATION_STATUS }, 'execution_authorization.status', Z.AUTH_INVALID_STATUS);

  const manifestRef = safeRef(input.activation_manifest_ref, 'execution_authorization.activation_manifest_ref');
  if (manifestRef !== activationManifest.activation_manifest_id) fail(Z.AUTH_MANIFEST_MISMATCH, 'the authorization is about another Activation Manifest');
  const pushRef = safeRef(input.push_ref, 'execution_authorization.push_ref');
  if (pushRef !== activationManifest.push_ref || pushRef !== push.push_id) fail(Z.AUTH_PUSH_MISMATCH, 'the authorization is about another Push');

  const authorizedAt = isoTimestamp(input.authorized_at, 'execution_authorization.authorized_at', Z.AUTH_INVALID_WINDOW);
  const expiresAt = isoTimestamp(input.expires_at, 'execution_authorization.expires_at', Z.AUTH_INVALID_WINDOW);
  if (toMs(authorizedAt) > toMs(expiresAt)) fail(Z.AUTH_INVALID_WINDOW, 'execution_authorization.authorized_at cannot be after expires_at');

  return deepFreeze({
    authorization_ref: safeRef(input.authorization_ref, 'execution_authorization.authorization_ref'),
    decision_ref: safeRef(input.decision_ref, 'execution_authorization.decision_ref'),
    activation_manifest_ref: manifestRef,
    push_ref: pushRef,
    scope,
    status,
    authorized_at: authorizedAt,
    expires_at: expiresAt,
  });
}

function deliveryExecutions(value) {
  if (!Array.isArray(value)) fail(Z.RECEIPT_DELIVERIES_REQUIRED, 'a receipt needs delivery_execution_refs');
  if (value.length > MAX_DELIVERY_EXECUTIONS) fail(E.INVALID_FIELD, `at most ${MAX_DELIVERY_EXECUTIONS} delivery executions`, { field: 'delivery_execution_refs' });
  const out = value.map((entry, i) => {
    closedObject(entry, DELIVERY_KEYS, `delivery_execution_refs[${i}]`);
    return {
      deliverable_ref: safeRef(entry.deliverable_ref, `delivery_execution_refs[${i}].deliverable_ref`),
      delivery_execution_ref: safeRef(entry.delivery_execution_ref, `delivery_execution_refs[${i}].delivery_execution_ref`),
    };
  });
  if (new Set(out.map((d) => d.deliverable_ref)).size !== out.length) fail(E.DUPLICATE_ENTRY, 'a deliverable is executed more than once in the receipt', { field: 'delivery_execution_refs' });
  return out;
}

/**
 * @param {object} input the receipt, as supplied by a trusted execution adapter
 * @param {object} p { tenantMerchantId, activationManifest, push, authorization } - the verified originals; `authorization` is the
 *                   NORMALIZED SocleExecutionAuthorization
 *
 * EXECUTED covers every manifest delivery; PARTIAL covers at least one (a subset). activated_at is inside the manifest activation
 * window [start, end), after authorized_at and before the authorization expiry; recorded_at >= activated_at; evidence is mandatory.
 */
export function normalizeMarketingExecutionReceipt(input, {
  merchantId, activationManifest, push, authorization,
} = {}) {
  closedObject(input, RECEIPT_KEYS, 'execution_receipt');
  const status = enumValue(input.execution_status, EXECUTION_STATUS, 'execution_receipt.execution_status', Z.RECEIPT_INVALID_STATUS);

  if (uuidValue(input.merchant_id, 'execution_receipt.merchant_id') !== merchantId) fail(Z.RECEIPT_MERCHANT_MISMATCH, 'the receipt belongs to another merchant');
  if (uuidValue(input.brand_id, 'execution_receipt.brand_id') !== activationManifest.brand_id) fail(Z.RECEIPT_BRAND_MISMATCH, 'the receipt belongs to another brand');
  if (safeRef(input.push_ref, 'execution_receipt.push_ref') !== push.push_id || input.push_ref !== activationManifest.push_ref) fail(Z.RECEIPT_PUSH_MISMATCH, 'the receipt is about another Push');
  if (safeRef(input.activation_manifest_ref, 'execution_receipt.activation_manifest_ref') !== activationManifest.activation_manifest_id) fail(Z.RECEIPT_MANIFEST_MISMATCH, 'the receipt is about another Activation Manifest');
  if (safeRef(input.execution_authorization_ref, 'execution_receipt.execution_authorization_ref') !== authorization.authorization_ref) fail(Z.RECEIPT_AUTHORIZATION_MISMATCH, 'the receipt names another authorization');

  const activatedAt = isoTimestamp(input.activated_at, 'execution_receipt.activated_at');
  const recordedAt = isoTimestamp(input.recorded_at, 'execution_receipt.recorded_at');
  const window = activationManifest.activation_window;
  if (toMs(activatedAt) < toMs(window.start) || toMs(activatedAt) >= toMs(window.end)) fail(Z.RECEIPT_OUTSIDE_WINDOW, 'the activation happened outside the activation window of the manifest');
  if (toMs(activatedAt) < toMs(authorization.authorized_at)) fail(Z.EXECUTION_BEFORE_AUTHORIZATION, 'the activation happened before the authorization');
  if (toMs(activatedAt) > toMs(authorization.expires_at)) fail(Z.EXECUTION_AFTER_AUTHORIZATION_EXPIRY, 'the activation happened after the authorization expired');
  if (toMs(recordedAt) < toMs(activatedAt)) fail(Z.RECEIPT_INVALID_RECORDED_AT, 'recorded_at cannot be before activated_at');

  const evidence = safeRefList(input.evidence_refs, 'execution_receipt.evidence_refs');
  if (!evidence.length) fail(Z.RECEIPT_EVIDENCE_REQUIRED, 'a receipt without evidence is not a receipt');

  const executions = deliveryExecutions(input.delivery_execution_refs);
  if (!executions.length) fail(Z.RECEIPT_DELIVERIES_REQUIRED, 'a receipt needs at least one delivery execution');
  const known = new Set(activationManifest.deliveries.map((d) => d.deliverable_ref));
  if (executions.some((d) => !known.has(d.deliverable_ref))) fail(Z.RECEIPT_DELIVERY_UNKNOWN, 'the receipt executes a deliverable that is not in the manifest');
  if (status === EXECUTION_STATUS.EXECUTED && known.size !== executions.length) {
    fail(Z.RECEIPT_DELIVERIES_INCOMPLETE, 'an EXECUTED receipt must cover every delivery of the manifest');
  }

  return deepFreeze({
    execution_ref: safeRef(input.execution_ref, 'execution_receipt.execution_ref'),
    execution_authorization_ref: authorization.authorization_ref,
    activation_manifest_ref: activationManifest.activation_manifest_id,
    merchant_id: merchantId,
    brand_id: activationManifest.brand_id,
    push_ref: push.push_id,
    execution_status: status,
    activated_at: activatedAt,
    delivery_execution_refs: executions,
    evidence_refs: evidence,
    recorded_at: recordedAt,
  });
}
