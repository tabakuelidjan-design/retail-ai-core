import { CORE_CATEGORY, makeCoreError } from './taxonomy.js';

// NORDLA CORE RESILIENCE: THE STRUCTURED-OUTPUT BOUNDARY. A provider's text is untrusted: before any module sees it, this boundary extracts ONE JSON object, refuses what is ambiguous (two equal keys in one object),
// and classifies what went wrong as a PROTOCOL_ERROR with a stable subcode. It extracts and classifies; it never judges the CONTENT (that is the module's canonical validator) and never chooses between two
// meanings. The Creative Brain was the pilot that taught these rules (fences, prose around the JSON, a lone wrapper, duplicate keys, a broken array); the mechanics live here and Creative Brain consumes them.

/** The protocol subcodes: whether ONE re-ask of the provider may fix them (`reask`) and whether a deterministic meaning-preserving repair exists (`normalize`). */
export const PROTOCOL_SUBCODE = Object.freeze({
  PROVIDER_EMPTY_BODY: { reask: false, normalize: false }, // nothing came back: not a formatting problem
  PROVIDER_NO_JSON_OBJECT: { reask: true, normalize: false },
  PROVIDER_MALFORMED_JSON: { reask: true, normalize: false },
  PROVIDER_DUPLICATE_KEYS: { reask: false, normalize: false }, // two values for one key: the answer does not say which it means
  PROVIDER_WRAPPED_ANSWER: { reask: false, normalize: true },
  PROVIDER_MISSING_KEY: { reask: false, normalize: false },
  PROVIDER_UNKNOWN_KEY: { reask: false, normalize: false },
  PROVIDER_WRONG_ENUM: { reask: false, normalize: false },
  PROVIDER_WRONG_TYPE: { reask: false, normalize: false },
  PROVIDER_INVALID_IMAGE: { reask: false, normalize: false },
  PROVIDER_MALFORMED_CRITIC: { reask: false, normalize: false },
});

/** The JSON object inside a reply: markdown fences and prose around it are removed. null when there is no `{ ... }` at all. */
export function jsonSlice(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  return trimmed.slice(start, end + 1);
}

/** JSON.parse silently keeps the LAST of two equal keys in one object. Returns the first duplicated key and its depth, or null. Valid JSON only. */
export function findDuplicateKey(text) {
  const s = jsonSlice(text);
  if (s === null) return null;
  const stack = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '{') stack.push(new Set());
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (k < s.length && /\s/.test(s[k])) k += 1;
      const top = stack[stack.length - 1];
      if (s[k] === ':' && top) {
        const key = JSON.parse(s.slice(i, j + 1));
        if (top.has(key)) return { key, depth: stack.length };
        top.add(key);
      }
      i = j;
    }
  }
  return null;
}

const ENVELOPE_WORDS = ['answer', 'response', 'result', 'output', 'data'];
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Reads one provider reply. Returns { ok: true, value, repairs } or { ok: false, error: CoreError }.
 *   expectedKeys (optional): the keys of the contract's object. A lone wrapper ({"answer": {...}}) is unwrapped, and journaled, only if its key is not an expected key and either it is an envelope word or the
 *   inside holds only expected keys; nothing else is repaired here (the module's own normalization does the rest).
 */
export function readStructuredReply(text, { module, stage, expectedKeys = null, evidence_ref = null, tenant = null } = {}) {
  const where = { module, stage, evidence_ref, tenant };
  const fail = (code, human) => ({ ok: false, error: makeCoreError({ ...where, category: CORE_CATEGORY.PROTOCOL_ERROR, code, human_message: human }) });
  if (typeof text !== 'string' || text.trim() === '') return fail('PROVIDER_EMPTY_BODY', 'The provider returned an empty answer.');
  const slice = jsonSlice(text);
  if (slice === null) return fail('PROVIDER_NO_JSON_OBJECT', 'The provider answered without a JSON object.');
  let value;
  try { value = JSON.parse(slice); } catch { return fail('PROVIDER_MALFORMED_JSON', 'The provider returned invalid JSON.'); }
  const duplicate = findDuplicateKey(text);
  if (duplicate) return { ok: false, error: makeCoreError({ ...where, category: CORE_CATEGORY.PROTOCOL_ERROR, code: 'PROVIDER_DUPLICATE_KEYS', human_message: 'The provider repeated a key, so its answer does not say which value it means.', diagnostics: { key: duplicate.key, depth: duplicate.depth } }) };
  const repairs = [];
  if (expectedKeys && isPlain(value)) {
    const keys = Object.keys(value);
    const inner = keys.length === 1 ? value[keys[0]] : null;
    if (keys.length === 1 && !expectedKeys.includes(keys[0]) && isPlain(inner) && (ENVELOPE_WORDS.includes(keys[0].trim().toLowerCase()) || Object.keys(inner).every((k) => expectedKeys.includes(k)))) {
      repairs.push({ kind: 'PROVIDER_WRAPPED_ANSWER', from: keys[0], to: 'the inner object' });
      value = inner;
    }
  }
  if (!isPlain(value)) return fail('PROVIDER_WRONG_TYPE', 'The provider answered with something that is not an object.');
  return { ok: true, value, repairs };
}
