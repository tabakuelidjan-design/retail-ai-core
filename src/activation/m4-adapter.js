// M4 handoff: ChannelPublicationReceipt[] -> the EXISTING M4 MarketingExecutionReceipt (M4 is not modified).
//
//   every manifest delivery published       -> EXECUTED
//   at least one but not all                -> PARTIAL
//   none                                    -> NO receipt (no fake PARTIAL)
//
// `delivery_execution_refs[].delivery_execution_ref` is the id of the INTERNAL publication receipt (not just a provider id); the provider
// ids travel as evidence refs, for future measurement. The produced receipt is validated by M4's own normalizer, so it is compatible by
// construction. A receipt says "an activation was really executed", not that it was good: no causal claim, no success score.

import { normalizeSocleExecutionAuthorization, normalizeMarketingExecutionReceipt } from '../marketing/execution-receipt.js';
import { verifiedManifest, verifiedPush } from '../marketing/m4-validation.js';
import { tenantMerchantId } from '../marketing/understand-validation.js';
import { ACT_ERROR as E } from './constants.js';
import {
  asOfIso, closedObject, deriveId, fail, isPlainObject, ref, sortedUnique, toMs,
} from './validation.js';

const OPTION_KEYS = ['tenant', 'push', 'activationManifest', 'authorization', 'publications', 'executionRef', 'recordedAt'];

function verifiedPublication(receipt, { merchantId, manifest }) {
  if (!isPlainObject(receipt)) fail(E.M4_RECEIPT_SCOPE_MISMATCH, 'a publication receipt must be an object');
  const { receipt_id: id, ...body } = receipt;
  if (typeof id !== 'string' || deriveId('acr', body) !== id) fail(E.M4_RECEIPT_SCOPE_MISMATCH, 'a publication receipt does not match its own id');
  if (receipt.merchant_id !== merchantId || receipt.brand_id !== manifest.brand_id || receipt.activation_manifest_ref !== manifest.activation_manifest_id) {
    fail(E.M4_RECEIPT_SCOPE_MISMATCH, 'a publication receipt is not in the scope of the tenant, brand and manifest');
  }
  if (!manifest.deliveries.some((d) => d.deliverable_ref === receipt.manifest_delivery_ref)) fail(E.M4_RECEIPT_SCOPE_MISMATCH, 'a publication receipt is about a delivery that is not in the manifest');
  return receipt;
}

/**
 * @param {object} p { tenant, push, activationManifest, authorization (M4 SocleExecutionAuthorization), publications[], executionRef?, recordedAt }
 * @returns the normalized M4 MarketingExecutionReceipt
 */
export function buildMarketingExecutionReceiptFromPublications(options = {}) {
  closedObject(options, OPTION_KEYS, 'm4 handoff');
  const merchantId = tenantMerchantId(options.tenant);
  const push = verifiedPush(options.push, merchantId);
  const manifest = verifiedManifest(options.activationManifest, push, merchantId);
  const authorization = normalizeSocleExecutionAuthorization(options.authorization, { activationManifest: manifest, push });
  const publications = (options.publications ?? []).map((r) => verifiedPublication(r, { merchantId, manifest }));
  if (publications.length === 0) fail(E.M4_NOTHING_PUBLISHED, 'nothing was published: there is no execution receipt (and never a fake PARTIAL)');
  const deliveryRefs = publications.map((r) => r.manifest_delivery_ref);
  if (new Set(deliveryRefs).size !== deliveryRefs.length) fail(E.ORDER_DUPLICATE_DELIVERY, 'a delivery is published twice in the receipts');

  const activatedAt = new Date(Math.min(...publications.map((r) => toMs(r.published_at)))).toISOString();
  const executionRef = options.executionRef ?? `exec://${deriveId('ace', { m: manifest.activation_manifest_id, d: [...deliveryRefs].sort() })}`;
  const raw = {
    execution_ref: ref(executionRef, 'executionRef'),
    execution_authorization_ref: authorization.authorization_ref,
    activation_manifest_ref: manifest.activation_manifest_id,
    merchant_id: merchantId,
    brand_id: manifest.brand_id,
    push_ref: push.push_id,
    execution_status: publications.length === manifest.deliveries.length ? 'EXECUTED' : 'PARTIAL',
    activated_at: activatedAt,
    delivery_execution_refs: publications.map((r) => ({ deliverable_ref: r.manifest_delivery_ref, delivery_execution_ref: r.receipt_id })),
    evidence_refs: sortedUnique(publications.flatMap((r) => r.evidence_refs)),
    recorded_at: asOfIso(options.recordedAt, 'recordedAt'),
  };
  return normalizeMarketingExecutionReceipt(raw, { merchantId, activationManifest: manifest, push, authorization });
}
