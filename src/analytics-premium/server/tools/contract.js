// Nordla Tool Layer - the common result contract shared by every tool (Analytics today, Finance later).
//
// A tool is a THIN wrapper over an existing deterministic engine: it selects and reshapes figures the engine already produced. It never computes a KPI
// itself and never estimates. When it cannot answer it returns a structured error - it never guesses.
//
// Success:  { ok: true,  tool, args, period, values[], items?[], comparison, completeness, source, freshness, privacy }
// Failure:  { ok: false, tool, args, error: { code, message }, ...detail }
//
// Privacy: a result only ever carries AGGREGATED business facts. Identifiers are internal or pseudonymous (product ids, "#A4B7" customer labels).
// `sanitize` is the last line of defence: it drops forbidden fields and redacts anything shaped like an e-mail, IBAN or phone number, so that the
// result can later be handed to an external AI provider without any personal data in it.

export const ERROR_CODES = ['UNKNOWN_TOOL', 'INVALID_ARGUMENT', 'INVALID_PERIOD', 'NO_DATA', 'NOT_FOUND', 'INSUFFICIENT_HISTORY', 'DATA_UNAVAILABLE', 'PERIOD_TOO_LONG', 'PERIOD_IN_FUTURE', 'INTERNAL_ERROR'];

export const fail = (tool, args, code, message, detail = {}) => ({ ok: false, tool, args, error: { code, message }, ...detail });

/** One scalar fact. `unit`: 'EUR' (currency code) | 'count' | 'ratio' (0.12 = 12 %) | 'days' | 'text' | 'date'. */
export const fact = (key, value, unit) => ({ key, value: value ?? null, unit });

const FORBIDDEN_KEYS = new Set(['email', 'mail', 'phone', 'telephone', 'tel', 'address', 'street', 'iban', 'bic', 'customer_key', 'customerkey', 'first_name', 'last_name', 'firstname', 'lastname', 'full_name', 'fullname', 'invoice', 'document', 'raw']);
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/;
const PHONE = /\+\d[\d .-]{7,}\d/g;
// Postal addresses (conservative): a street word + name + house number, or a 4-digit postal code followed by a capitalised town ("5000 Namur").
const STREET = /\b(?:rue|avenue|av\.|boulevard|bd|chauss[ée]e|place|impasse|straat|laan|weg|plein|street|road|lane)\s+[\p{L}'’. -]{2,40}?\s+\d{1,4}\b/giu;
const POSTAL_TOWN = /\b\d{4}\s+\p{Lu}\p{L}{2,}(?:[- ]\p{Lu}\p{L}+)*/gu;
/** Replace every personal-looking span of a string (an e-mail, an IBAN, a phone number) and count them; the rest of the text is kept. */
const redactText = (s) => { let n = 0; const sub = (re) => { s = s.replace(re, () => { n += 1; return '[redacted]'; }); }; sub(EMAIL); sub(IBAN); sub(PHONE); sub(STREET); sub(POSTAL_TOWN); return { text: s, n }; };

/** Deep copy without forbidden keys, with personal-looking strings replaced. Returns { value, redactions }. */
export function sanitize(value) {
  let redactions = 0;
  const walk = (v) => {
    if (typeof v === 'string') { const r = redactText(v); redactions += r.n; return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) { if (FORBIDDEN_KEYS.has(k.toLowerCase())) { redactions += 1; continue; } out[k] = walk(x); }
      return out;
    }
    return v;
  };
  return { value: walk(value), redactions };
}

export const PRIVACY = (redactions) => ({ aggregatesOnly: true, identifiers: 'internal-or-pseudonymous', redactions });

/** How old the data is, from the moment the dataset snapshot was generated. Deterministic given `now`. */
export function freshnessOf(generatedAt, { now, staleAfterMinutes = 180, includesToday = false } = {}) {
  const t = generatedAt ? Date.parse(generatedAt) : NaN;
  const ageMinutes = Number.isFinite(t) ? Math.max(0, Math.round((now.getTime() - t) / 60000)) : null;
  return { dataAsOf: generatedAt ?? null, ageMinutes, stale: ageMinutes == null ? true : ageMinutes > staleAfterMinutes, staleAfterMinutes, includesToday };
}

/** Completeness: COMPLETE when nothing is missing or partial; otherwise PARTIAL with the reasons the answer must mention. */
export function completenessOf(reasons, missing = []) {
  return { status: reasons.length || missing.length ? 'PARTIAL' : 'COMPLETE', reasons, missing };
}

/** Minimal validation against a JSON-Schema subset (object / array / string / integer / number / boolean / enum / required / additionalProperties:false / min-max bounds). Returns an error string or null. */
export function validate(schema, value, at = 'args') {
  if (schema.type === 'object') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return `${at} must be an object`;
    for (const k of schema.required ?? []) if (value[k] === undefined) return `${at}.${k} is required`;
    for (const k of Object.keys(value)) {
      if (!schema.properties?.[k]) { if (schema.additionalProperties === false) return `${at}.${k} is not allowed`; continue; }
      const e = validate(schema.properties[k], value[k], `${at}.${k}`); if (e) return e;
    }
    return null;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${at} must be a string`;
    if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${at} is too long`;
    if (schema.minLength != null && value.length < schema.minLength) return `${at} is too short`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${at} has an invalid format`;
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} must be an array`;
    if (schema.minItems != null && value.length < schema.minItems) return `${at} must have at least ${schema.minItems} item(s)`;
    if (schema.maxItems != null && value.length > schema.maxItems) return `${at} must have at most ${schema.maxItems} item(s)`;
    for (let i = 0; i < value.length; i += 1) { const e = schema.items ? validate(schema.items, value[i], `${at}[${i}]`) : null; if (e) return e; }
    return null;
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${at} must be a boolean`;
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a number`;
    return null;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${at} must be an integer`;
    if (schema.minimum != null && value < schema.minimum) return `${at} must be >= ${schema.minimum}`;
    if (schema.maximum != null && value > schema.maximum) return `${at} must be <= ${schema.maximum}`;
    return null;
  }
  return null;
}
