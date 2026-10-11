import { ACT_ERROR, PROVIDER_ERROR, RETRYABLE_PROVIDER_ERRORS } from '../../activation/constants.js';
import { FinanceError } from '../../finance/document.js';
import { CONNECTOR_ERROR_CODES } from '../../tenant/connectors.js';
import { TENANT_ERROR_CODES } from '../../tenant/index.js';
import { AlibabaProviderError } from '../../marketing-creative/alibaba/http.js';
import { classifyProviderFailure } from '../provider.js';
import { RECOVERY_ACTION as A } from '../recovery.js';
import { CORE_CATEGORY as C, makeCoreError, redact } from '../taxonomy.js';

// THE DOMAIN SEAMS. Each module keeps its own error classes and codes; this file maps them onto Core categories without changing the module. It is the single place where a module's vocabulary meets Core's, so
// a Core rule (a safety failure is never normalized, an unknown outcome is never retried blindly) cannot be forgotten by a module. A module that is only AUDITED has no adapter; these are the ones with real entry
// points exercised by the chaos benchmark.

// ---------------------------------------------------------------------------------------------------------------- FINANCE
// Finance is not creative: a financial fact is never "repaired", never normalized, never replanned around. A contradiction or a broken invariant goes to the person (ASK_USER) or stops (GRACEFUL_BLOCK).

const FINANCE_STATE = new Set(['CONCURRENT_MODIFICATION', 'STOCK_MOVEMENT_STATE_CHANGED']); // somebody else changed the state under us: stop at the last checkpoint, a person re-reads
const FINANCE_CAPABILITY = new Set(['BANK_NOT_CONFIGURED']);
const FINANCE_SEGREGATION = /REQUIRES_A_MERCHANT_ACTOR$/; // who may approve, send or validate: a control, never bypassed
const FINANCE_INPUT = /(?:_INVALID|_NOT_FOUND|_EMPTY|_TOO_LARGE|_NOT_ALLOWED)$|^INPUT_INVALID$|^SOURCE_INVALID$|^USE_SEND_QUOTE$/;

export function financeCategoryOf(code) {
  if (FINANCE_STATE.has(code)) return C.STATE_INTEGRITY_ERROR;
  if (FINANCE_CAPABILITY.has(code)) return C.TOOL_CAPABILITY_LIMIT;
  if (FINANCE_SEGREGATION.test(code)) return C.SAFETY_OR_FIDELITY_BLOCK;
  if (code === 'REASON_REQUIRED') return C.MISSING_INFORMATION;
  if (FINANCE_INPUT.test(code)) return C.INPUT_INVALID;
  return C.DOMAIN_RULE_VIOLATION; // duplicates, locked documents, invalid transitions, payment exceeding the balance...
}

/** Finance policy: nothing is normalized, replanned, switched or retried; the person decides. */
export const FINANCE_POLICY = Object.freeze({
  allow: { DOMAIN_RULE_VIOLATION: [A.ASK_USER, A.GRACEFUL_BLOCK] },
  forbid: Object.fromEntries(Object.values(C).map((category) => [category, [A.NORMALIZE, A.REPLAN, A.SWITCH_CAPABILITY, A.REASK_PROVIDER, ...(category === C.PROVIDER_FAILURE ? [] : [A.RETRY_SAFE_OPERATION])]])),
  extend: { RECOVERABLE_EXECUTION_ERROR: [A.ASK_USER] },
  prefer: { RECOVERABLE_EXECUTION_ERROR: [A.ASK_USER] },
});

export function registerFinance(registry) {
  return registry.register('finance', {}, {
    classifyUnknown(error, where) {
      if (!(error instanceof FinanceError)) return null;
      return makeCoreError({ ...where, category: financeCategoryOf(error.code), code: error.code, domain_code: `FINANCE_${error.code}`, diagnostics: { has_detail: error.detail != null } });
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------- ACTIVATION (channel execution)
// The activation module already normalizes provider errors (ProviderRejection). An ambiguous submission (the provider may have published) is never retried blindly.

const ACT_PROVIDER = Object.freeze({
  [PROVIDER_ERROR.RATE_LIMITED]: { category: C.PROVIDER_FAILURE }, [PROVIDER_ERROR.PROVIDER_UNAVAILABLE]: { category: C.PROVIDER_FAILURE }, [PROVIDER_ERROR.TIMEOUT]: { category: C.PROVIDER_FAILURE },
  [PROVIDER_ERROR.PROCESSING_TRANSIENT]: { category: C.PROVIDER_FAILURE }, [PROVIDER_ERROR.AUTH_INVALID]: { category: C.PROVIDER_FAILURE }, [PROVIDER_ERROR.SCOPE_MISSING]: { category: C.PROVIDER_FAILURE },
  [PROVIDER_ERROR.MEDIA_INVALID]: { category: C.INPUT_INVALID }, [PROVIDER_ERROR.PRIVACY_MISMATCH]: { category: C.SAFETY_OR_FIDELITY_BLOCK }, [PROVIDER_ERROR.CAPABILITY_UNSUPPORTED]: { category: C.TOOL_CAPABILITY_LIMIT },
  [PROVIDER_ERROR.POLICY_VIOLATION]: { category: C.SAFETY_OR_FIDELITY_BLOCK }, [PROVIDER_ERROR.ACCOUNT_INVALID]: { category: C.PROVIDER_FAILURE }, [PROVIDER_ERROR.PRIVATE_ONLY_RESTRICTION]: { category: C.SAFETY_OR_FIDELITY_BLOCK },
  [PROVIDER_ERROR.DAILY_LIMIT_REACHED]: { category: C.PROVIDER_FAILURE }, [PROVIDER_ERROR.INVALID_PAYLOAD]: { category: C.INPUT_INVALID }, [PROVIDER_ERROR.PERMANENT_REJECTION]: { category: C.PROVIDER_FAILURE },
  [PROVIDER_ERROR.PUBLISH_RESULT_UNKNOWN]: { category: C.STATE_INTEGRITY_ERROR }, // maybe published: never retried blindly
});

export function activationCategoryOf(code) {
  if (ACT_PROVIDER[code]) return ACT_PROVIDER[code].category;
  if (code === ACT_ERROR.SECRET_LEAK) return C.SAFETY_OR_FIDELITY_BLOCK;
  if (/SCOPE_MISMATCH$|MERCHANT_MISMATCH$|IDEMPOTENCY_CONFLICT$|STATE_CONFLICT$|DERIVED_MISMATCH$/.test(code)) return C.STATE_INTEGRITY_ERROR;
  if (code === ACT_ERROR.STORE_FAILED) return C.RECOVERABLE_EXECUTION_ERROR;
  if (/NOT_FOUND$|AMBIGUOUS$|REQUIRED$|MISSING$|UNKNOWN_KEY$|INVALID_FIELD$|INVALID_TIMESTAMP$|FORBIDDEN_FIELD$|UNSUPPORTED$|INVALID_MODE$|INVALID_EXPIRY$|OPTIONS_INVALID$/.test(code)) return C.INPUT_INVALID;
  return C.DOMAIN_RULE_VIOLATION;
}

export function registerActivation(registry) {
  const known = [...Object.values(PROVIDER_ERROR), ...Object.values(ACT_ERROR)];
  return registry.register('activation', Object.fromEntries(known.map((code) => [code, { category: activationCategoryOf(code), domain_code: `ACTIVATION_${code}` }])));
}

/** Whether the activation module itself already declares a provider code retryable (so the Core context agrees with it, not with a guess). */
export const activationRetryable = (code) => RETRYABLE_PROVIDER_ERRORS.includes(code);

// ---------------------------------------------------------------------------------------------------------------- TENANT, CONNECTORS, SYNC GUARD
export function registerTenant(registry) {
  const table = {};
  for (const code of Object.values(TENANT_ERROR_CODES)) table[code] = { category: code === TENANT_ERROR_CODES.TENANT_LOOKUP_FAILED ? C.RECOVERABLE_EXECUTION_ERROR : code === TENANT_ERROR_CODES.TENANT_SOURCE_NOT_AVAILABLE ? C.TOOL_CAPABILITY_LIMIT : C.INPUT_INVALID, domain_code: `TENANT_${code}` };
  for (const code of Object.values(CONNECTOR_ERROR_CODES)) {
    if (table[code]) continue;
    table[code] = { category: code === 'CONNECTOR_STORE_FAILED' ? C.RECOVERABLE_EXECUTION_ERROR : code === 'CONNECTOR_CONFIG_SECRET' || code === 'CONNECTOR_EXTERNAL_TAKEN' ? C.SAFETY_OR_FIDELITY_BLOCK : code === 'CONNECTOR_AMBIGUOUS' ? C.USER_CONTRADICTION : C.INPUT_INVALID, domain_code: `CONNECTOR_${code}` };
  }
  table.TENANT_WRITE_VIOLATION = { category: C.SAFETY_OR_FIDELITY_BLOCK, domain_code: 'SYNC_TENANT_WRITE_VIOLATION' }; // a write outside the tenant: never retried, never normalized
  return registry.register('tenant', table);
}

// ---------------------------------------------------------------------------------------------------------------- SYNC and generic providers
/**
 * A sync/provider failure for a log or a summary: no provider body, no row data, no credential. The audit found raw bodies (`HTTP 500: {...}`) flowing into sync summaries; this is the safe form.
 */
export function safeProviderMessage(error, where = { module: 'sync', stage: 'fetch' }) {
  const status = /\bHTTP (\d{3})\b/.exec(String(error?.message ?? ''))?.[1];
  const core = classifyProviderFailure({ status: status ? Number(status) : error?.status, code: error?.code, name: error?.name, message: error?.message }, where);
  return `${core.code}${core.diagnostics.status_class ? ` (${core.diagnostics.status_class})` : ''}: ${redact(core.human_message, 120)}`;
}

/** The Alibaba adapter error (code, status, transient) on Core: its own `transient` flag is respected. */
export function registerAlibaba(registry) {
  return registry.register('marketing-creative', {}, {
    classifyUnknown(error, where) {
      if (!(error instanceof AlibabaProviderError)) return null;
      const core = classifyProviderFailure({ status: error.status, code: error.code, name: error.name, message: error.code }, where);
      return error.transient === true && !core.diagnostics.transient ? makeCoreError({ ...where, category: core.category, code: core.code, diagnostics: { ...core.diagnostics, transient: true } }) : core;
    },
  });
}

/** One registry with every adapter registered. */
export function registerAll(registry) {
  return registerAlibaba(registerTenant(registerActivation(registerFinance(registry))));
}
