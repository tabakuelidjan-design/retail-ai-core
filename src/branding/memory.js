import {
  DECISION_EVENT_TYPE,
  GOVERNED_DOCUMENT_STATUS as STATUS,
} from './constants.js';
import { commonDocument } from './contracts.js';
import { buildBrandDecisionEvent } from './decision-event.js';
import {
  claimRef,
  normalizeHardRule,
  normalizeHexColor,
  opaqueRef,
} from './hard-rules.js';
import {
  approval,
  assertObject,
  assertResolvedActor,
  deepFreeze,
  integerVersion,
  isoDate,
  objectList,
  optionalString,
  requiredString,
  tenantMerchantId,
  uniqueIds,
  validationResult,
} from './validation.js';

// Brand Memory V1 = the approved, versioned, machine-readable operational brand.
// Exactly five categories (no budget, strategy, catalog, pricing, production dimensions...):
//   identity_references, design_tokens, hard_rules, semantic_context, external_references.
// It stores REFERENCES, never binaries and never the truth of a claim or a product fact.

const MEMORY_SUBJECT = 'brand_memory';
const NAME = /^[a-z][a-z0-9-]*$/;
const POLICY_REF = /^external-policy:\/\/\S+$/;
const MAX_FAMILY = 100;
const MAX_LIST = 50;
const MAX_EXAMPLES = 10;
const MAX_TEXT = 500;
const MAX_SUMMARY = 1000;

function exactKeys(input, allowed, field) {
  assertObject(input, field);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new TypeError(`${field}.${key} is not part of Brand Memory V1`);
  }
  return input;
}

function refList(value, field, item, { max = MAX_LIST } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  if (value.length > max) throw new RangeError(`${field} must contain at most ${max} items`);
  const out = value.map((entry, index) => item(entry, `${field}[${index}]`));
  if (new Set(out).size !== out.length) throw new TypeError(`${field} contains duplicates`);
  return out;
}

function textList(value, field, max) {
  return refList(value, field, (entry, f) => {
    const text = requiredString(entry, f);
    if (text.length > MAX_TEXT) throw new RangeError(`${f} is too long`);
    return text;
  }, { max });
}

// ---------------------------------------------------------------- 1. identity references
export function normalizeIdentityReferences(input = {}, field = 'identity_references') {
  exactKeys(input, ['primary_logo_ref', 'approved_logo_refs', 'distinctive_asset_refs'], field);
  const primary = input.primary_logo_ref == null
    ? null
    : opaqueRef(input.primary_logo_ref, `${field}.primary_logo_ref`);
  const approved = refList(input.approved_logo_refs, `${field}.approved_logo_refs`, opaqueRef);
  if (primary && approved.includes(primary)) {
    throw new TypeError(`${field}.approved_logo_refs must not repeat the primary logo`);
  }
  return {
    primary_logo_ref: primary,
    approved_logo_refs: approved,
    distinctive_asset_refs: refList(input.distinctive_asset_refs, `${field}.distinctive_asset_refs`, opaqueRef),
  };
}

// ---------------------------------------------------------------- 2. design tokens (colors, typography)
function tokenName(name, field) {
  if (!NAME.test(name)) throw new TypeError(`${field} token name must be lowercase kebab-case: ${name}`);
  return name;
}

export function normalizeDesignTokens(input = {}, field = 'design_tokens') {
  exactKeys(input, ['colors', 'typography'], field);

  const colors = {};
  const seenHex = new Map();
  for (const [name, value] of Object.entries(input.colors ?? {})) {
    tokenName(name, `${field}.colors`);
    const hex = normalizeHexColor(value, `${field}.colors.${name}`);
    if (seenHex.has(hex)) {
      throw new TypeError(`${field}.colors.${name} duplicates the value of ${seenHex.get(hex)}`);
    }
    seenHex.set(hex, name);
    colors[name] = hex;
  }

  const typography = {};
  for (const [role, spec] of Object.entries(input.typography ?? {})) {
    tokenName(role, `${field}.typography`);
    const path = `${field}.typography.${role}`;
    exactKeys(spec, ['family', 'weights'], path);
    const family = requiredString(spec.family, `${path}.family`);
    if (family.length > MAX_FAMILY) throw new RangeError(`${path}.family is too long`);
    if (!Array.isArray(spec.weights) || spec.weights.length === 0) {
      throw new TypeError(`${path}.weights must be a non-empty array`);
    }
    const weights = spec.weights.map((weight, index) => {
      if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
        throw new TypeError(`${path}.weights[${index}] must be an integer between 1 and 1000`);
      }
      return weight;
    });
    if (new Set(weights).size !== weights.length) throw new TypeError(`${path}.weights contains duplicates`);
    typography[role] = { family, weights: weights.sort((a, b) => a - b) };
  }

  return { colors, typography };
}

// ---------------------------------------------------------------- 4. semantic brand context
export function normalizeSemanticContext(input = {}, field = 'semantic_context') {
  exactKeys(input, [
    'voice_traits', 'do', 'dont', 'brand_style_summary', 'on_brand_examples', 'off_brand_examples',
  ], field);
  const summary = optionalString(input.brand_style_summary, `${field}.brand_style_summary`);
  if (summary && summary.length > MAX_SUMMARY) throw new RangeError(`${field}.brand_style_summary is too long`);
  return {
    voice_traits: textList(input.voice_traits, `${field}.voice_traits`, MAX_LIST),
    do: textList(input.do, `${field}.do`, MAX_LIST),
    dont: textList(input.dont, `${field}.dont`, MAX_LIST),
    brand_style_summary: summary,
    on_brand_examples: textList(input.on_brand_examples, `${field}.on_brand_examples`, MAX_EXAMPLES),
    off_brand_examples: textList(input.off_brand_examples, `${field}.off_brand_examples`, MAX_EXAMPLES),
  };
}

// ---------------------------------------------------------------- 5. external references
export function normalizeExternalReferences(input = {}, field = 'external_references') {
  exactKeys(input, ['production_asset_refs', 'claim_refs', 'policy_refs'], field);
  return {
    production_asset_refs: refList(input.production_asset_refs, `${field}.production_asset_refs`, opaqueRef),
    claim_refs: refList(input.claim_refs, `${field}.claim_refs`, claimRef),
    policy_refs: refList(input.policy_refs, `${field}.policy_refs`, (value, f) => {
      const text = requiredString(value, f);
      if (!POLICY_REF.test(text)) throw new TypeError(`${f} must be an external-policy:// reference`);
      return text;
    }),
  };
}

// ---------------------------------------------------------------- document
const DOCUMENT_KEYS = [
  'id', 'merchant_id', 'version', 'status', 'created_at', 'supersedes_id', 'core_ref',
  'identity_references', 'design_tokens', 'hard_rules', 'semantic_context', 'external_references',
  'approval',
];
const CONTENT_KEYS = [
  'identity_references', 'design_tokens', 'hard_rules', 'semantic_context', 'external_references',
];

export function normalizeBrandMemory(input) {
  exactKeys(input, DOCUMENT_KEYS, 'memory');
  const base = commonDocument(input, 'memory', Object.values(STATUS));
  assertObject(input.core_ref, 'memory.core_ref');
  const rules = objectList(input.hard_rules, 'memory.hard_rules', normalizeHardRule);
  uniqueIds(rules, 'memory.hard_rules');

  return deepFreeze({
    ...base,
    core_ref: {
      id: requiredString(input.core_ref.id, 'memory.core_ref.id'),
      version: integerVersion(input.core_ref.version, 'memory.core_ref.version'),
    },
    identity_references: normalizeIdentityReferences(input.identity_references ?? {}),
    design_tokens: normalizeDesignTokens(input.design_tokens ?? {}),
    hard_rules: rules.map((rule) => ({ ...rule })),
    semantic_context: normalizeSemanticContext(input.semantic_context ?? {}),
    external_references: normalizeExternalReferences(input.external_references ?? {}),
    approval: approval(input.approval, 'memory.approval'),
  });
}

const hasContent = (memory) => {
  const { identity_references: id, design_tokens: tokens, semantic_context: sem, external_references: ext } = memory;
  return Boolean(
    id.primary_logo_ref
    || id.approved_logo_refs.length
    || id.distinctive_asset_refs.length
    || Object.keys(tokens.colors).length
    || Object.keys(tokens.typography).length
    || memory.hard_rules.length
    || sem.voice_traits.length || sem.do.length || sem.dont.length
    || sem.brand_style_summary
    || sem.on_brand_examples.length || sem.off_brand_examples.length
    || ext.production_asset_refs.length || ext.claim_refs.length || ext.policy_refs.length,
  );
};

const coreAssetRefs = (core) => core.distinctive_assets.map((asset) => asset.asset_ref).filter(Boolean);

/**
 * Structural + binding validation. `core` must be the tenant's active APPROVED Core: the Memory
 * is bound to ONE exact Core version and is unusable against any other. A Memory is never
 * required to carry a logo (a legitimate brand may have none).
 */
export function validateBrandMemory(memory, { core = null } = {}) {
  const reasons = [];

  if (memory.status === STATUS.APPROVED && !memory.approval) reasons.push('APPROVAL_RECORD_REQUIRED');
  if (!hasContent(memory)) reasons.push('BRAND_MEMORY_EMPTY');

  if (!core) {
    reasons.push('APPROVED_CORE_REQUIRED');
  } else {
    if (core.status !== STATUS.APPROVED) reasons.push('CORE_NOT_APPROVED');
    if (core.merchant_id !== memory.merchant_id) reasons.push('CORE_MEMORY_MERCHANT_MISMATCH');
    if (memory.core_ref.id !== core.id || memory.core_ref.version !== core.version) {
      reasons.push('BRAND_MEMORY_CORE_MISMATCH');
    }
    // A distinctive asset is referenced from the Core, never invented in Memory.
    const known = new Set(coreAssetRefs(core));
    for (const ref of memory.identity_references.distinctive_asset_refs) {
      if (!known.has(ref)) reasons.push('MEMORY_DISTINCTIVE_ASSET_NOT_IN_CORE');
    }
  }
  return validationResult(reasons);
}

// ---------------------------------------------------------------- governed flow
function assertBindableCore(core, merchantId) {
  if (!core || core.status !== STATUS.APPROVED) throw new Error('MEMORY_REQUIRES_APPROVED_CORE');
  if (core.merchant_id !== merchantId) throw new Error('MEMORY_CORE_TENANT_MISMATCH');
  return core;
}

export function buildBrandMemoryDraft({
  tenant,
  id,
  version = 1,
  createdAt,
  core,
  content = {},
  supersedesId = null,
} = {}) {
  const merchantId = tenantMerchantId(tenant);
  assertBindableCore(core, merchantId);
  exactKeys(content, CONTENT_KEYS, 'content');

  const memory = normalizeBrandMemory({
    id,
    merchant_id: merchantId,
    version,
    status: STATUS.DRAFT,
    created_at: createdAt,
    supersedes_id: supersedesId,
    core_ref: { id: core.id, version: core.version },
    ...content,
    approval: null,
  });
  return Object.freeze({
    memory,
    readiness: validateBrandMemory(memory, { core }),
    auto_approved: false,
  });
}

export function submitBrandMemoryForReview({ memory, core, tenant } = {}) {
  if (!memory) throw new TypeError('memory is required');
  const merchantId = tenantMerchantId(tenant);
  if (memory.merchant_id !== merchantId) throw new Error('MEMORY_TENANT_MISMATCH');
  if (memory.status !== STATUS.DRAFT) throw new Error('MEMORY_MUST_BE_DRAFT_TO_SUBMIT');
  assertBindableCore(core, merchantId);

  const readiness = validateBrandMemory(memory, { core });
  if (!readiness.ok) throw new Error(`MEMORY_NOT_READY_FOR_REVIEW: ${readiness.reasons.join(', ')}`);
  return normalizeBrandMemory({ ...memory, status: STATUS.REVIEW_REQUIRED });
}

/**
 * Human approval of a reviewed Memory. Same trust model as Brand Core:
 * `resolvedActor` comes from the trusted server / Socle context - NEVER from an untrusted client
 * payload. Branding authenticates nobody; it only checks presence, tenant and role.
 * Persists nothing; returns the approved Memory, the superseded previous Memory and a decision
 * event for the future Decision Ledger.
 */
export function approveBrandMemory({
  memory,
  core,
  tenant,
  resolvedActor,
  activeMemory = null,
  approvedAt,
  note = null,
} = {}) {
  if (!memory) throw new TypeError('memory is required');
  const merchantId = tenantMerchantId(tenant);
  if (memory.merchant_id !== merchantId) throw new Error('MEMORY_TENANT_MISMATCH');
  const actor = assertResolvedActor(resolvedActor, tenant);

  if (memory.status !== STATUS.REVIEW_REQUIRED) {
    throw new Error('MEMORY_MUST_BE_REVIEW_REQUIRED_BEFORE_APPROVAL');
  }
  assertBindableCore(core, merchantId);
  const readiness = validateBrandMemory(memory, { core });
  if (!readiness.ok) throw new Error(`MEMORY_NOT_READY_FOR_APPROVAL: ${readiness.reasons.join(', ')}`);

  let supersededMemory = null;
  if (activeMemory) {
    if (activeMemory.merchant_id !== merchantId) throw new Error('MEMORY_ACTIVE_MEMORY_TENANT_MISMATCH');
    if (activeMemory.status !== STATUS.APPROVED) throw new Error('MEMORY_ACTIVE_MEMORY_NOT_APPROVED');
    if (memory.supersedes_id !== activeMemory.id || memory.version !== activeMemory.version + 1) {
      throw new Error('MEMORY_ACTIVE_MEMORY_MUST_BE_SUPERSEDED');
    }
    supersededMemory = normalizeBrandMemory({ ...activeMemory, status: STATUS.SUPERSEDED });
  } else if (memory.supersedes_id) {
    throw new Error('MEMORY_SUPERSEDES_UNKNOWN_ACTIVE_MEMORY');
  }

  const decidedAt = isoDate(approvedAt, 'approvedAt');
  const decisionEvent = buildBrandDecisionEvent({
    type: DECISION_EVENT_TYPE.BRAND_MEMORY_APPROVED,
    merchantId,
    actor,
    subject: { kind: MEMORY_SUBJECT, id: memory.id, version: memory.version },
    decidedAt,
    note: optionalString(note, 'note'),
    supersedes: supersededMemory
      ? { kind: MEMORY_SUBJECT, id: supersededMemory.id, version: supersededMemory.version }
      : null,
  });

  const approvedMemory = normalizeBrandMemory({
    ...memory,
    status: STATUS.APPROVED,
    approval: {
      decision_event_id: decisionEvent.id,
      approved_by: actor.user_id,
      approver_role: actor.role,
      approved_at: decidedAt,
      note: optionalString(note, 'note'),
    },
  });

  return Object.freeze({ approvedMemory, supersededMemory, decisionEvent });
}

// A new version is always prepared as a fresh REVIEW_REQUIRED document; the approved one is never mutated.
// `core` is the tenant's CURRENT active Core (it may be newer than the one the old Memory was bound to).
export function proposeBrandMemoryRevision({
  approvedMemory,
  core,
  tenant,
  id,
  createdAt,
  changes = {},
} = {}) {
  if (!approvedMemory) throw new TypeError('approvedMemory is required');
  if (approvedMemory.status !== STATUS.APPROVED) throw new Error('MEMORY_REVISION_REQUIRES_APPROVED_MEMORY');
  exactKeys(changes, CONTENT_KEYS, 'changes');

  const content = {};
  for (const key of CONTENT_KEYS) content[key] = changes[key] ?? approvedMemory[key];

  const draft = buildBrandMemoryDraft({
    tenant,
    id,
    version: approvedMemory.version + 1,
    createdAt,
    core,
    content: JSON.parse(JSON.stringify(content)),
    supersedesId: approvedMemory.id,
  });
  const memory = submitBrandMemoryForReview({ memory: draft.memory, core, tenant });
  return Object.freeze({ memory, readiness: validateBrandMemory(memory, { core }), auto_approved: false });
}

// Guard for stores/callers: a tenant has at most one APPROVED Memory.
export function selectActiveBrandMemory(memories = [], tenant) {
  const merchantId = tenantMerchantId(tenant);
  const active = memories.filter((memory) => (
    memory.merchant_id === merchantId && memory.status === STATUS.APPROVED
  ));
  if (active.length > 1) throw new Error('MULTIPLE_APPROVED_BRAND_MEMORIES');
  return active[0] ?? null;
}
