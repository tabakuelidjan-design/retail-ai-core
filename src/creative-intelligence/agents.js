// Agent interfaces and the TRUST BOUNDARY. Six agents in C1; no live model call exists in this module.
//
//   model output  ->  adapter  ->  plain-JSON check  ->  normalize  ->  validate  ->  immutable domain object
//
// An agent's output is UNTRUSTED data until it has passed through its normalizer: a function, a class instance, an unknown key, a
// provider prompt / model / seed, an unapproved claim or a verdict that belongs to another module is refused, and the error never
// echoes the offending value. An agent never publishes, schedules, picks a channel, an audience, a budget or a price, and never
// decides Marketing strategy: those keys are refused outright.

import {
  AGENT_ROLE, CI_ERROR as E, CI_VERSION, FORBIDDEN_PROVIDER_KEYS, MAX_CANDIDATE_BUDGET, ORCHESTRATION_STEP, PRIVACY_CLASS,
  PROVIDER_CAPABILITY, TEXT_KIND, VISUAL_PURPOSE,
} from './constants.js';
import { buildAssetReadinessReport } from './asset-readiness.js';
import { assertDistinctDirections, normalizeCreativeDirection } from './creative-direction.js';
import { normalizeQualityReport } from './creative-quality.js';
import { normalizeTextBasis } from './layers.js';
import { normalizeProductUnderstanding } from './product-understanding.js';
import {
  closedObject, deepFreeze, enumValue, fail, idToken, integer, isPlainObject, plainJson, refList, rejectKeysDeep, textDigest, tokenList,
} from './validation.js';

// What an agent may never do, whatever it is called: publish, schedule, route to a channel / audience, spend, price.
const STRATEGY_KEYS = Object.freeze([
  'publish', 'schedule', 'scheduled_at', 'activation', 'channel', 'channels', 'audience', 'budget', 'spend', 'price', 'discount',
  'objective', 'strategy', 'push', 'decision', 'brand_memory', 'margin', 'stock',
]);

const CANONICAL_SEQUENCE = Object.freeze(Object.values(ORCHESTRATION_STEP));

/** The deterministic-first plan: every step, in order, with a bounded candidate budget. The orchestrator may only narrow / reorder within it. */
export function planCreativeRun({ candidate_budget: budget = 3 } = {}) {
  return deepFreeze({
    sequence: [...CANONICAL_SEQUENCE],
    candidate_budget: integer(budget, 'candidate_budget', { min: 1, max: MAX_CANDIDATE_BUDGET, code: E.AGENT_OUTPUT_INVALID }),
    max_retries: 1,
  });
}

// ---- normalizers (one per role)
const NORMALIZERS = {
  [AGENT_ROLE.CREATIVE_ORCHESTRATOR](raw) {
    rejectKeysDeep(raw, STRATEGY_KEYS, E.AGENT_OUTPUT_INVALID, 'orchestrator');
    closedObject(raw, ['sequence', 'candidate_budget', 'max_retries'], 'orchestrator', E.AGENT_OUTPUT_INVALID);
    if (!Array.isArray(raw.sequence) || raw.sequence.length === 0) fail(E.AGENT_OUTPUT_INVALID, 'orchestrator.sequence must list steps', { field: 'sequence' });
    const sequence = raw.sequence.map((s, i) => enumValue(s, ORCHESTRATION_STEP, `orchestrator.sequence[${i}]`, E.AGENT_OUTPUT_INVALID));
    if (new Set(sequence).size !== sequence.length) fail(E.AGENT_OUTPUT_INVALID, 'orchestrator.sequence repeats a step', { field: 'sequence' });
    // the order of the pipeline is not negotiable, and nothing may be rendered without a gate behind it
    const positions = sequence.map((s) => CANONICAL_SEQUENCE.indexOf(s));
    if (positions.some((p, i) => i > 0 && p < positions[i - 1])) fail(E.AGENT_OUTPUT_INVALID, 'orchestrator.sequence breaks the pipeline order', { field: 'sequence' });
    for (const required of [ORCHESTRATION_STEP.RENDER, ORCHESTRATION_STEP.PREFLIGHT]) {
      if (!sequence.includes(required)) fail(E.AGENT_OUTPUT_INVALID, `orchestrator.sequence must include ${required}`, { field: 'sequence' });
    }
    return deepFreeze({
      sequence,
      candidate_budget: integer(raw.candidate_budget, 'orchestrator.candidate_budget', { min: 1, max: MAX_CANDIDATE_BUDGET, code: E.AGENT_OUTPUT_INVALID }),
      max_retries: integer(raw.max_retries ?? 0, 'orchestrator.max_retries', { min: 0, max: 2, code: E.AGENT_OUTPUT_INVALID }),
    });
  },

  [AGENT_ROLE.PRODUCT_ASSET_ANALYST](raw, ctx) {
    closedObject(raw, ['product_understanding', 'asset_observations'], 'analyst', E.AGENT_OUTPUT_INVALID);
    const understanding = normalizeProductUnderstanding(raw.product_understanding);
    if (ctx.merchant_id && (understanding.merchant_id !== ctx.merchant_id || understanding.brand_id !== ctx.brand_id)) fail(E.AGENT_OUTPUT_INVALID, 'the analyst answered for another merchant or brand', { field: 'analyst' });
    const readiness = buildAssetReadinessReport({
      merchant_id: understanding.merchant_id, brand_id: understanding.brand_id, assets: raw.asset_observations, resolutions: ctx.resolutions ?? null, target: ctx.target ?? null, created_at: understanding.created_at,
    });
    return deepFreeze({ product_understanding: understanding, asset_readiness: readiness });
  },

  [AGENT_ROLE.CREATIVE_DIRECTOR](raw, ctx) {
    closedObject(raw, ['directions'], 'director', E.AGENT_OUTPUT_INVALID);
    if (!Array.isArray(raw.directions) || raw.directions.length < 1 || raw.directions.length > MAX_CANDIDATE_BUDGET) fail(E.AGENT_OUTPUT_INVALID, `the director returns 1..${MAX_CANDIDATE_BUDGET} directions`, { field: 'directions' });
    const directions = raw.directions.map((d) => normalizeCreativeDirection(d));
    for (const d of directions) {
      if (ctx.merchant_id && (d.merchant_id !== ctx.merchant_id || d.brand_id !== ctx.brand_id || d.brief_ref !== ctx.brief_ref)) fail(E.AGENT_OUTPUT_INVALID, 'a direction answers another merchant, brand or brief', { field: 'directions' });
      if (ctx.claim_refs && d.claim_refs.some((c) => !ctx.claim_refs.includes(c))) fail(E.CLAIM_REF_NOT_APPROVED, 'a direction uses a claim the Brief did not approve', { field: 'directions' });
    }
    return deepFreeze({ directions: assertDistinctDirections(directions) });
  },

  [AGENT_ROLE.COPY_CLAIMS_AGENT](raw, ctx) {
    closedObject(raw, ['items'], 'copy', E.AGENT_OUTPUT_INVALID);
    if (!Array.isArray(ctx.claim_refs)) fail(E.AGENT_OUTPUT_INVALID, 'the copy agent runs against an explicit list of approved claim references', { field: 'claim_refs' });
    if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > 12) fail(E.AGENT_OUTPUT_INVALID, 'the copy agent returns 1..12 items', { field: 'items' });
    const items = raw.items.map((item, i) => {
      closedObject(item, ['text_role', 'content', 'text_kind', 'claim_ref'], `copy.items[${i}]`, E.AGENT_OUTPUT_INVALID);
      // approved wording = the digest is computed HERE, once the claim reference has been checked against the approved list
      if (item.text_kind === TEXT_KIND.CLAIM_BEARING && !ctx.claim_refs.includes(item.claim_ref)) {
        fail(E.CLAIM_REF_NOT_APPROVED, `copy.items[${i}] uses a claim reference that is not approved`, { field: `copy.items[${i}]` });
      }
      const digest = item.text_kind === TEXT_KIND.CLAIM_BEARING && typeof item.content === 'string' ? textDigest(item.content) : null;
      const basis = normalizeTextBasis({ ...item, approved_digest: digest }, `copy.items[${i}]`);
      return {
        text_role: basis.role, text_kind: basis.kind, content: basis.content, claim_ref: basis.claimRef, approved_digest: basis.digest,
      };
    });
    const roles = items.map((x) => x.text_role);
    if (new Set(roles).size !== roles.length) fail(E.AGENT_OUTPUT_INVALID, 'the copy agent returns one text per role', { field: 'items' });
    return deepFreeze({ items });
  },

  [AGENT_ROLE.VISUAL_PRODUCTION_DIRECTOR](raw) {
    rejectKeysDeep(raw, FORBIDDEN_PROVIDER_KEYS, E.AGENT_OUTPUT_INVALID, 'visual');
    closedObject(raw, ['requests'], 'visual', E.AGENT_OUTPUT_INVALID);
    if (!Array.isArray(raw.requests) || raw.requests.length > 10) fail(E.AGENT_OUTPUT_INVALID, 'the visual director returns at most 10 requests', { field: 'requests' });
    const allowed = [PROVIDER_CAPABILITY.IMAGE_GENERATE, PROVIDER_CAPABILITY.IMAGE_EDIT, PROVIDER_CAPABILITY.IMAGE_BACKGROUND, PROVIDER_CAPABILITY.IMAGE_VECTOR, PROVIDER_CAPABILITY.PRODUCT_SEGMENT, PROVIDER_CAPABILITY.PRODUCT_RELIGHT];
    const requests = raw.requests.map((r, i) => {
      closedObject(r, ['request_id', 'capability', 'purpose', 'input_asset_refs', 'privacy_class', 'text_policy', 'forbidden_transformations'], `visual.requests[${i}]`, E.AGENT_OUTPUT_INVALID);
      // critical text is never generated into pixels: the request must say so, in so many words
      if (r.text_policy !== 'NO_CRITICAL_TEXT') fail(E.AGENT_OUTPUT_INVALID, `visual.requests[${i}].text_policy must be NO_CRITICAL_TEXT`, { field: 'text_policy' });
      return {
        request_id: idToken(r.request_id, `visual.requests[${i}].request_id`),
        capability: enumValue(r.capability, allowed, `visual.requests[${i}].capability`, E.AGENT_OUTPUT_INVALID),
        purpose: enumValue(r.purpose, VISUAL_PURPOSE, `visual.requests[${i}].purpose`, E.AGENT_OUTPUT_INVALID),
        input_asset_refs: refList(r.input_asset_refs, `visual.requests[${i}].input_asset_refs`, { max: 10 }),
        privacy_class: enumValue(r.privacy_class, PRIVACY_CLASS, `visual.requests[${i}].privacy_class`, E.AGENT_OUTPUT_INVALID),
        text_policy: 'NO_CRITICAL_TEXT',
        forbidden_transformations: tokenList(r.forbidden_transformations, `visual.requests[${i}].forbidden_transformations`),
      };
    });
    if (new Set(requests.map((r) => r.request_id)).size !== requests.length) fail(E.AGENT_OUTPUT_INVALID, 'a request_id repeats', { field: 'requests' });
    return deepFreeze({ requests });
  },

  [AGENT_ROLE.CREATIVE_CRITIC](raw, ctx) {
    const report = normalizeQualityReport(raw);
    if (ctx.document_ref && report.document_ref !== ctx.document_ref) fail(E.AGENT_OUTPUT_INVALID, 'the critic reviewed another document', { field: 'document_ref' });
    return report;
  },
};

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,100}$/;
/** The diagnostics of a thrown value that are safe to keep: scalars of a fixed shape, never a message. */
export function safeCause(cause) {
  const out = {};
  if (typeof cause?.name === 'string' && SAFE_TOKEN.test(cause.name)) out.name = cause.name;
  if (typeof cause?.code === 'string' && SAFE_TOKEN.test(cause.code)) out.code = cause.code;
  if (Number.isInteger(cause?.status) && cause.status >= 100 && cause.status <= 599) out.status = cause.status;
  const requestId = cause?.requestId ?? cause?.request_id;
  if (typeof requestId === 'string' && SAFE_TOKEN.test(requestId)) out.request_id = requestId;
  if (typeof cause?.transient === 'boolean') out.transient = cause.transient;
  return out;
}

export function normalizeAgentOutput(role, raw, context = {}) {
  const normalizer = NORMALIZERS[role];
  if (!normalizer) fail(E.AGENT_UNKNOWN_ROLE, 'unknown agent role');
  const data = plainJson(raw, 'agent_output');
  if (!isPlainObject(data)) fail(E.AGENT_OUTPUT_INVALID, 'an agent returns an object', { field: 'agent_output' });
  // a refusal keeps its own stable code (a claim refusal stays a claim refusal); nothing is "repaired" or defaulted
  return normalizer(data, context);
}

/**
 * Wraps an injected handler (a live model adapter later, a fake in tests) into an agent. The handler receives a deep-frozen copy
 * of the input; whatever it returns - or throws - crosses the trust boundary before anything else sees it.
 */
export function defineCreativeAgent(role, handler) {
  if (!NORMALIZERS[role]) fail(E.AGENT_UNKNOWN_ROLE, 'unknown agent role');
  if (typeof handler !== 'function') fail(E.AGENT_OUTPUT_INVALID, 'an agent needs a handler function');
  return Object.freeze({
    role,
    async invoke(input, context = {}) {
      let raw;
      try {
        raw = await handler(deepFreeze(plainJson(input ?? {}, 'input')), deepFreeze(plainJson(context, 'context')));
      } catch (cause) {
        // the message is never echoed (it may carry model output or a header), but the SAFE diagnostics of the failure are kept: without them a provider refusal is
        // indistinguishable from a bug (name, a code token, an HTTP status, a request id, transient)
        fail(E.AGENT_FAILED, 'the agent handler failed', { role, cause: safeCause(cause) });
      }
      return normalizeAgentOutput(role, raw, context);
    },
  });
}

/** A fake agent for tests / demos: it answers a fixed (cloned) payload. */
export const createFakeAgent = (role, payload) => defineCreativeAgent(role, () => structuredClone(payload));

export const AGENT_INTERFACE_VERSION = `${CI_VERSION}.agents`;
