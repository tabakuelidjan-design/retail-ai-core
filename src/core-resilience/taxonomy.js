// NORDLA CORE RESILIENCE: THE ERROR TAXONOMY. Every failure of every module maps to EXACTLY ONE of eleven Core categories; a module keeps its own detailed code as `code` / `domain_code` (nothing useful is replaced, it is MAPPED).
// A CoreError is safe to log and to show: stable machine code, a human-safe explanation, whether it is recoverable, where it came from, a pointer to the evidence and to the state checkpoint, and diagnostics that were
// sanitized (no credential, no private payload, scalars only). Core owns these mechanics; modules own their domain reasoning. This layer is a Socle responsibility (NDR-010): evidence, observability, tenant isolation.

export const CORE_CATEGORY = Object.freeze({
  PROTOCOL_ERROR: 'PROTOCOL_ERROR', // a tool answered, in the wrong shape (malformed JSON, wrapper, unknown key...)
  INPUT_INVALID: 'INPUT_INVALID', // what the user gave cannot be used as given (too long, ambiguous number...)
  MISSING_INFORMATION: 'MISSING_INFORMATION', // something required is absent
  USER_CONTRADICTION: 'USER_CONTRADICTION', // the user said two incompatible things
  RECOVERABLE_EXECUTION_ERROR: 'RECOVERABLE_EXECUTION_ERROR', // an execution step failed in a way that may be re-run or re-planned
  TOOL_CAPABILITY_LIMIT: 'TOOL_CAPABILITY_LIMIT', // the tool cannot do what the plan asked
  PROVIDER_FAILURE: 'PROVIDER_FAILURE', // an external provider failed (timeout, rate limit, refusal, outage)
  DOMAIN_RULE_VIOLATION: 'DOMAIN_RULE_VIOLATION', // a rule of the domain is broken (finance invariant, creative gate...)
  SAFETY_OR_FIDELITY_BLOCK: 'SAFETY_OR_FIDELITY_BLOCK', // safety, fidelity or legal integrity stops the work
  STATE_INTEGRITY_ERROR: 'STATE_INTEGRITY_ERROR', // the state itself cannot be trusted
  FATAL_SYSTEM_ERROR: 'FATAL_SYSTEM_ERROR', // nothing safe can be done
});

export const RECOVERABLE = Object.freeze({ YES: 'YES', NO: 'NO', CONDITIONAL: 'CONDITIONAL' });

/** The default of each category: whether it is recoverable and the sentence a person may be shown. */
export const CATEGORY_DEFAULTS = Object.freeze({
  PROTOCOL_ERROR: { recoverable: RECOVERABLE.YES, human: 'A tool answered in a format Nordla could not use.' },
  INPUT_INVALID: { recoverable: RECOVERABLE.CONDITIONAL, human: 'Part of the information given cannot be used as it is.' },
  MISSING_INFORMATION: { recoverable: RECOVERABLE.CONDITIONAL, human: 'Some required information is missing.' },
  USER_CONTRADICTION: { recoverable: RECOVERABLE.CONDITIONAL, human: 'Two instructions contradict each other.' },
  RECOVERABLE_EXECUTION_ERROR: { recoverable: RECOVERABLE.YES, human: 'A step failed and can be tried again or planned differently.' },
  TOOL_CAPABILITY_LIMIT: { recoverable: RECOVERABLE.CONDITIONAL, human: 'The available tool cannot do what was asked.' },
  PROVIDER_FAILURE: { recoverable: RECOVERABLE.CONDITIONAL, human: 'An external service failed.' },
  DOMAIN_RULE_VIOLATION: { recoverable: RECOVERABLE.CONDITIONAL, human: 'A rule of this domain is not satisfied.' },
  SAFETY_OR_FIDELITY_BLOCK: { recoverable: RECOVERABLE.NO, human: 'The work was stopped to protect safety, fidelity or integrity.' },
  STATE_INTEGRITY_ERROR: { recoverable: RECOVERABLE.CONDITIONAL, human: 'The saved state could not be trusted.' },
  FATAL_SYSTEM_ERROR: { recoverable: RECOVERABLE.NO, human: 'An unexpected system error stopped the work.' },
});

export const CATEGORIES = Object.freeze(Object.values(CORE_CATEGORY));

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,100}$/;

// credentials and private payloads that must never reach a log, a ledger or a message
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{6,}/g, /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s"',;]{4,}/gi,
  /shp(?:at|ca|ss)_[A-Za-z0-9]{8,}/g, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g, /\bAKIA[0-9A-Z]{12,}\b/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[0-9a-f]{32,}\b/gi, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

/** Text made safe to keep: credentials, long hex strings and e-mail addresses are replaced, the length is bounded. */
export function redact(text, max = 240) {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/** Diagnostics: at most 12 scalar entries under safe key names, strings redacted. Anything else (objects, payloads, bodies) is dropped. */
export function safeDiagnostics(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input).slice(0, 12)) {
    if (!SAFE_TOKEN.test(key)) continue;
    if (typeof value === 'string') out[key] = redact(value, 200);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

export class CoreError extends Error {
  constructor(spec) {
    super(spec.human_message);
    this.name = 'CoreError';
    Object.assign(this, spec);
    Object.freeze(this);
  }
}

/**
 * Builds a CoreError. `category` must be one of the eleven; `code` is the module's own stable code (kept); `domain_code` an optional finer subcode.
 */
export function makeCoreError({
  category, code, module, stage, domain_code = null, human_message = null, recoverable = null, evidence_ref = null, checkpoint = null, diagnostics = null, tenant = null, unmapped = false,
}) {
  if (!CATEGORIES.includes(category)) throw new TypeError(`unknown Core category ${category}`);
  if (typeof code !== 'string' || !SAFE_TOKEN.test(code)) throw new TypeError('a CoreError needs a stable machine code');
  if (typeof module !== 'string' || !SAFE_TOKEN.test(module)) throw new TypeError('a CoreError needs its originating module');
  if (typeof stage !== 'string' || !SAFE_TOKEN.test(stage)) throw new TypeError('a CoreError needs its originating stage');
  if (recoverable !== null && !Object.values(RECOVERABLE).includes(recoverable)) throw new TypeError('recoverable must be YES, NO or CONDITIONAL');
  const defaults = CATEGORY_DEFAULTS[category];
  return new CoreError({
    category, code, domain_code: domain_code && SAFE_TOKEN.test(domain_code) ? domain_code : null, module, stage,
    human_message: redact(human_message ?? defaults.human, 240), recoverable: recoverable ?? defaults.recoverable,
    evidence_ref: evidence_ref ? redact(evidence_ref, 200) : null, checkpoint: checkpoint ? redact(checkpoint, 120) : null,
    diagnostics: Object.freeze(safeDiagnostics(diagnostics)), tenant: tenant && SAFE_TOKEN.test(tenant) ? tenant : null, unmapped: unmapped === true,
  });
}

/**
 * A registry of the codes of each module: `register('finance', { FINANCE_UNBALANCED_ALLOCATION: { category: 'DOMAIN_RULE_VIOLATION' } })`. One registry per use (never a process-wide singleton: tenant-safe).
 * `classify(error, where)` returns a CoreError: an existing one is kept; a known code is mapped; anything else is FATAL_SYSTEM_ERROR flagged `unmapped` (counted in the coverage report, never silently recovered).
 */
export function createErrorRegistry() {
  const tables = new Map();
  const registry = {
    register(module, table, { classifyUnknown = null } = {}) {
      if (module !== '*' && !SAFE_TOKEN.test(module)) throw new TypeError('module name');
      for (const [code, entry] of Object.entries(table)) {
        if (!CATEGORIES.includes(entry.category)) throw new TypeError(`${module}.${code}: unknown Core category ${entry.category}`);
        if (tables.get(module)?.table[code]) throw new TypeError(`${module}.${code} is already registered: a code maps to exactly one category`);
      }
      const previous = tables.get(module);
      tables.set(module, { table: { ...(previous?.table ?? {}), ...table }, classifyUnknown: classifyUnknown ?? previous?.classifyUnknown ?? null });
      return registry;
    },
    modules: () => [...tables.keys()].sort(),
    codes: (module) => Object.keys(tables.get(module)?.table ?? {}).sort(),
    lookup: (module, code) => tables.get(module)?.table[code] ?? null,
    classify(error, { module, stage, evidence_ref = null, checkpoint = null, tenant = null } = {}) {
      if (error instanceof CoreError) return error;
      const entry = tables.get(module);
      const shared = tables.get('*');
      const code = typeof error?.code === 'string' && SAFE_TOKEN.test(error.code) ? error.code : null;
      const where = { module, stage, evidence_ref, checkpoint, tenant };
      const hit = code ? (entry?.table[code] ?? shared?.table[code]) : null;
      if (code && hit) {
        const m = hit;
        return makeCoreError({ ...where, category: m.category, code, domain_code: m.domain_code ?? null, recoverable: m.recoverable ?? null, human_message: m.human ?? null, diagnostics: { name: error?.name, field: error?.field, status: error?.status } });
      }
      const custom = entry?.classifyUnknown?.(error, where);
      if (custom) return custom instanceof CoreError ? custom : makeCoreError({ ...where, ...custom });
      return makeCoreError({ ...where, category: CORE_CATEGORY.FATAL_SYSTEM_ERROR, code: code ?? 'UNCLASSIFIED_ERROR', human_message: 'An error that no module has classified stopped the work.', diagnostics: { name: error?.name, message: error?.message }, unmapped: true });
    },
  };
  return registry;
}
