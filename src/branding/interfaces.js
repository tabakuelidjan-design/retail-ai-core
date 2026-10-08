import {
  BRAND_CONTEXT_STATUS,
  GOVERNED_DOCUMENT_STATUS,
} from './constants.js';
import {
  validateCoreForApproval,
  validateMemoryForApproval,
} from './contracts.js';

export function buildBrandContext({ core = null, memory = null } = {}) {
  const reasons = [];

  if (!core) reasons.push('BRAND_CORE_MISSING');
  if (!memory) reasons.push('BRAND_MEMORY_MISSING');

  if (core) {
    if (core.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
      reasons.push('BRAND_CORE_NOT_APPROVED');
    }
    reasons.push(...validateCoreForApproval(core).reasons);
  }

  if (memory) {
    if (memory.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
      reasons.push('BRAND_MEMORY_NOT_APPROVED');
    }
    reasons.push(...validateMemoryForApproval(memory, { core }).reasons);
  }

  const unique = [...new Set(reasons)];
  if (unique.length) {
    return Object.freeze({
      status: BRAND_CONTEXT_STATUS.GATED,
      reasons: Object.freeze(unique),
      core: null,
      memory: null,
    });
  }

  return Object.freeze({
    status: BRAND_CONTEXT_STATUS.READY,
    reasons: Object.freeze([]),
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

export function marketingBrandInterface(context) {
  assertBrandContextReady(context);
  return Object.freeze({
    core_ref: Object.freeze({ id: context.core.id, version: context.core.version }),
    memory_ref: Object.freeze({ id: context.memory.id, version: context.memory.version }),
    category: context.core.category,
    buying_contexts: context.core.buying_contexts,
    value_proposition: context.core.value_proposition,
    positioning: context.core.positioning,
    core_promise: context.core.core_promise,
    reasons_to_believe: context.core.reasons_to_believe,
    exclusions: context.core.exclusions,
    voice: context.core.voice,
    hard_rules: context.memory.hard_rules,
    semantic_context: context.memory.semantic_context,
  });
}

export function creativeBrandInterface(context) {
  assertBrandContextReady(context);
  return Object.freeze({
    core_ref: Object.freeze({ id: context.core.id, version: context.core.version }),
    memory_ref: Object.freeze({ id: context.memory.id, version: context.memory.version }),
    distinctive_assets: context.core.distinctive_assets,
    design_tokens: context.memory.design_tokens,
    hard_rules: context.memory.hard_rules,
    asset_refs: context.memory.asset_refs,
    production_asset_refs: context.memory.production_asset_refs,
    semantic_context: context.memory.semantic_context,
  });
}
