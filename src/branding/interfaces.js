import {
  BRAND_CONTEXT_STATUS,
  BRAND_REVIEW_SIGNAL,
  BRAND_RULE_TYPE,
  BRAND_STATUS,
  GOVERNED_DOCUMENT_STATUS,
  SNAPSHOT_STATUS,
} from './constants.js';
import { normalizeBrandIdentity } from './brand.js';
import { validateCoreForApproval } from './contracts.js';
import { validateBrandMemory } from './memory.js';
import { deepFreeze, tenantMerchantId } from './validation.js';

// The context is only as good as the ACTIVE Core: if the Memory was approved against another Core
// version, validateBrandMemory reports BRAND_MEMORY_CORE_MISMATCH and the context is GATED.
// A stale (or outdated) Snapshot is a REVIEW SIGNAL, never an automatic block:
// the approved Core stays usable until a human decides otherwise.
function reviewSignals(core, snapshot) {
  const signals = [];
  if (!snapshot || !core?.snapshot_ref) return signals;
  if (snapshot.status === SNAPSHOT_STATUS.STALE) signals.push(BRAND_REVIEW_SIGNAL.SNAPSHOT_STALE);
  if (
    snapshot.id !== core.snapshot_ref.id
    || snapshot.version !== core.snapshot_ref.version
  ) {
    signals.push(BRAND_REVIEW_SIGNAL.SNAPSHOT_SUPERSEDED_BY_NEWER);
  }
  return signals;
}

export function buildBrandContext({
  tenant,
  brand = null,
  core = null,
  memory = null,
  snapshot = null,
} = {}) {
  const merchantId = tenantMerchantId(tenant);
  const reasons = [];

  // The brand is explicit (merchant_id owns the data, brand_id says which brand it is about).
  // Brand reasons are their own codes: they are never reported as plain tenant errors.
  const identity = brand == null ? null : normalizeBrandIdentity(brand);
  if (!identity) {
    reasons.push('BRAND_IDENTITY_MISSING');
  } else {
    if (identity.merchant_id !== merchantId) reasons.push('BRAND_TENANT_MISMATCH');
    if (identity.status !== BRAND_STATUS.ACTIVE) reasons.push('BRAND_INACTIVE');
  }
  const brandId = identity ? identity.brand_id : null;
  if (identity) {
    if (snapshot && snapshot.brand_id !== brandId) reasons.push('BRAND_SNAPSHOT_BRAND_MISMATCH');
    if (core && core.brand_id !== brandId) reasons.push('BRAND_CORE_BRAND_MISMATCH');
    if (memory && memory.brand_id !== brandId) reasons.push('BRAND_MEMORY_BRAND_MISMATCH');
  }

  if (!core) reasons.push('BRAND_CORE_MISSING');
  if (!memory) reasons.push('BRAND_MEMORY_MISSING');

  if (core) {
    if (core.merchant_id !== merchantId) reasons.push('BRAND_CORE_TENANT_MISMATCH');
    if (core.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
      reasons.push('BRAND_CORE_NOT_APPROVED');
    }
    reasons.push(...validateCoreForApproval(core).reasons);
  }

  if (memory) {
    if (memory.merchant_id !== merchantId) reasons.push('BRAND_MEMORY_TENANT_MISMATCH');
    if (memory.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
      reasons.push('BRAND_MEMORY_NOT_APPROVED');
    }
    reasons.push(...validateBrandMemory(memory, { core }).reasons);
  }

  const unique = [...new Set(reasons)];
  if (unique.length) {
    return Object.freeze({
      status: BRAND_CONTEXT_STATUS.GATED,
      reasons: Object.freeze(unique),
      review_signals: Object.freeze([]),
      brand: null,
      core: null,
      memory: null,
    });
  }

  return Object.freeze({
    status: BRAND_CONTEXT_STATUS.READY,
    reasons: Object.freeze([]),
    review_signals: Object.freeze(reviewSignals(core, snapshot)),
    brand: identity,
    core,
    memory,
  });
}

export function assertBrandContextReady(context) {
  if (context?.status !== BRAND_CONTEXT_STATUS.READY) {
    const reasons = context?.reasons?.join(', ') || 'BRAND_CONTEXT_NOT_READY';
    throw new Error(`brand context is gated: ${reasons}`);
  }
  return context;
}

// Read-only views: everything handed out is deeply frozen, and approval internals
// (approval record, decision event id, timestamps) are never exposed.
const MARKETING_RULE_TYPES = new Set([BRAND_RULE_TYPE.TEXT, BRAND_RULE_TYPE.CLAIM_REF]);
const copy = (value) => JSON.parse(JSON.stringify(value));
// Which brand the view is about (and its locales); not the brand's registry internals.
const brandView = (brand) => ({
  brand_id: brand.brand_id,
  name: brand.name,
  default_locale: brand.default_locale,
  supported_locales: brand.supported_locales,
});

export function marketingBrandInterface(context) {
  assertBrandContextReady(context);
  return deepFreeze(copy({
    brand: brandView(context.brand),
    core_ref: { id: context.core.id, version: context.core.version },
    memory_ref: { id: context.memory.id, version: context.memory.version },
    review_signals: context.review_signals,
    category: context.core.category,
    buying_contexts: context.core.buying_contexts,
    value_proposition: context.core.value_proposition,
    positioning: context.core.positioning,
    core_promise: context.core.core_promise,
    reasons_to_believe: context.core.reasons_to_believe,
    exclusions: context.core.exclusions,
    voice: context.core.voice,
    semantic_context: context.memory.semantic_context,
    hard_rules: context.memory.hard_rules.filter((rule) => MARKETING_RULE_TYPES.has(rule.rule_type)),
    claim_refs: context.memory.external_references.claim_refs,
  }));
}

export function creativeBrandInterface(context) {
  assertBrandContextReady(context);
  return deepFreeze(copy({
    brand: brandView(context.brand),
    core_ref: { id: context.core.id, version: context.core.version },
    memory_ref: { id: context.memory.id, version: context.memory.version },
    review_signals: context.review_signals,
    distinctive_assets: context.core.distinctive_assets,
    identity_references: context.memory.identity_references,
    design_tokens: context.memory.design_tokens,
    hard_rules: context.memory.hard_rules,
    semantic_context: context.memory.semantic_context,
    external_references: context.memory.external_references,
  }));
}
