import { createHash } from 'node:crypto';

// Shared validators of the Creative Brain contracts. Pure: no clock, no randomness, no I/O. A canonical Creative Brain object is a CLOSED object (exact keys), made of single-line text, closed
// vocabularies and lists, with NO number anywhere (no coordinate, no size, no score, no count): geometry belongs to the deterministic solver and a judgment is a word with evidence, never a score.
// Messages name the field, never the submitted value.

export const BRAIN_ERROR = Object.freeze({
  MALFORMED: 'BRAIN_MALFORMED',
  UNKNOWN_KEY: 'BRAIN_UNKNOWN_KEY',
  MISSING_KEY: 'BRAIN_MISSING_KEY',
  TEXT_INVALID: 'BRAIN_TEXT_INVALID',
  ENUM_INVALID: 'BRAIN_ENUM_INVALID',
  LIST_INVALID: 'BRAIN_LIST_INVALID',
  NUMERIC_VALUE: 'BRAIN_NUMERIC_VALUE',
  FORBIDDEN_CONTENT: 'BRAIN_FORBIDDEN_CONTENT',
  NOT_DISTINCT: 'BRAIN_NOT_DISTINCT',
  RULE_VIOLATION: 'BRAIN_RULE_VIOLATION',
  PORT_FAILED: 'BRAIN_PORT_FAILED',
});

export class BrainError extends Error {
  constructor(code, message, field = null, detail = null) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
    this.field = field;
    this.detail = detail;
  }
}
export const fail = (code, message, field = null, detail = null) => { throw new BrainError(code, message, field, detail); };

export const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Exactly these keys: none missing, none extra. */
export function closed(value, keys, where) {
  if (!isPlain(value)) fail(BRAIN_ERROR.MALFORMED, `${where} must be a plain object`, where);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(BRAIN_ERROR.UNKNOWN_KEY, `${where}.${key} is not part of this contract`, `${where}.${key}`);
  for (const key of keys) if (!(key in value)) fail(BRAIN_ERROR.MISSING_KEY, `${where}.${key} is missing`, `${where}.${key}`);
  return value;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;
export const TEXT_MAX = 300;

/** One line of plain text, min..max characters, no control character (so no line break), not blank. */
export function oneLine(value, where, { min = 1, max = TEXT_MAX } = {}) {
  if (typeof value !== 'string') fail(BRAIN_ERROR.TEXT_INVALID, `${where} must be text`, where);
  const text = value.normalize('NFC').trim().replace(/ {2,}/g, ' ');
  if (text.length < min || text.length > max || CONTROL.test(text)) fail(BRAIN_ERROR.TEXT_INVALID, `${where} must be one line of ${min}..${max} characters`, where, { length: text.length, limit: max });
  return text;
}

export function enumOf(value, vocabulary, where) {
  const allowed = Object.values(vocabulary);
  if (typeof value !== 'string' || !allowed.includes(value)) fail(BRAIN_ERROR.ENUM_INVALID, `${where} is not one of the allowed words`, where);
  return value;
}

export function listOf(value, where, { min = 0, max = 12 } = {}, item = (v) => v) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(BRAIN_ERROR.LIST_INVALID, `${where} must be a list of ${min}..${max} items`, where);
  return value.map((v, i) => item(v, `${where}[${i}]`));
}

/** Refuses any number, boolean-as-score or bigint anywhere in a raw value: a Creative Brain object holds words, never figures. */
export function noNumbers(value, where) {
  if (typeof value === 'number' || typeof value === 'bigint') fail(BRAIN_ERROR.NUMERIC_VALUE, `${where} is a number: the Creative Brain holds words, never figures`, where);
  if (Array.isArray(value)) value.forEach((v, i) => noNumbers(v, `${where}[${i}]`));
  else if (isPlain(value)) for (const [k, v] of Object.entries(value)) noNumbers(v, `${where}.${k}`);
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}

export const deriveId = (prefix, body) => `${prefix}_${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}`;

const tokens = (s) => String(s).toLowerCase().split(/[^a-z0-9à-ÿ]+/i).filter((t) => t.length > 2);
/** Jaccard similarity of the word sets of two texts (1 = same words, 0 = nothing shared). */
export function wordOverlap(a, b) {
  const x = new Set(tokens(a)); const y = new Set(tokens(b));
  if (!x.size && !y.size) return 1;
  const inter = [...x].filter((t) => y.has(t)).length;
  return inter / (x.size + y.size - inter);
}
export { tokens as wordsOf };

/** A canonical id-bearing object: the id is derived from the content, so it cannot drift from it. */
