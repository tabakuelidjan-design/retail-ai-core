import { PROVIDER_SUBCODE } from './provider.js';
import { PROTOCOL_SUBCODE } from './structured-output.js';
import { CORE_CATEGORY as C, createErrorRegistry } from './taxonomy.js';

// The codes Core itself defines, mapped once: protocol subcodes -> PROTOCOL_ERROR, provider subcodes -> PROVIDER_FAILURE (a missing capability -> TOOL_CAPABILITY_LIMIT), state codes -> STATE_INTEGRITY_ERROR,
// recovery-budget and engine codes -> FATAL_SYSTEM_ERROR. They apply to EVERY module (registered under '*'); a module still registers its own codes.

export const CORE_CODE_TABLE = Object.freeze({
  ...Object.fromEntries(Object.keys(PROTOCOL_SUBCODE).map((code) => [code, { category: C.PROTOCOL_ERROR }])),
  ...Object.fromEntries(Object.keys(PROVIDER_SUBCODE).map((code) => [code, { category: C.PROVIDER_FAILURE }])),
  PROVIDER_CAPABILITY_UNAVAILABLE: { category: C.TOOL_CAPABILITY_LIMIT },
  CORE_TENANT_MISMATCH: { category: C.STATE_INTEGRITY_ERROR },
  CORE_RUN_NOT_FOUND_FOR_TENANT: { category: C.STATE_INTEGRITY_ERROR },
  CORE_RUN_IDENTITY_INVALID: { category: C.STATE_INTEGRITY_ERROR },
  CORE_CHECKPOINT_OVERWRITE: { category: C.STATE_INTEGRITY_ERROR },
  CORE_EFFECT_OUTCOME_UNKNOWN: { category: C.STATE_INTEGRITY_ERROR },
  CORE_UNAUTHORIZED_RECOVERY: { category: C.FATAL_SYSTEM_ERROR },
  CORE_RECOVERY_BUDGET_REFUSED: { category: C.FATAL_SYSTEM_ERROR },
  CORE_ENGINE_FAULT: { category: C.FATAL_SYSTEM_ERROR },
  CORE_RECOVERY_LOOP_GUARD: { category: C.FATAL_SYSTEM_ERROR },
  CORE_REPLAN_TARGET_INVALID: { category: C.TOOL_CAPABILITY_LIMIT },
  CORE_UNKNOWN_FACT: { category: C.INPUT_INVALID },
  // the codes of Core's own input layer
  INPUT_REQUIRED_FIELD_MISSING: { category: C.MISSING_INFORMATION },
  INPUT_COLLECTION_MISSING: { category: C.MISSING_INFORMATION },
  INPUT_TOO_LONG: { category: C.INPUT_INVALID },
  INPUT_AMBIGUOUS: { category: C.INPUT_INVALID },
  INPUT_NOT_USABLE: { category: C.INPUT_INVALID },
  USER_STATEMENTS_CONTRADICT: { category: C.USER_CONTRADICTION },
});

/** A registry that already knows the Core codes. */
export const createCoreRegistry = () => createErrorRegistry().register('*', CORE_CODE_TABLE);
