import {
  BRAIN_ERROR, enumOf, fail, isPlain, listOf, noNumbers, oneLine, TEXT_MAX,
} from './validation.js';
import { assertNoSubstitute } from './substitutes.js';

// THE CONTRACT LAYER of the Creative Brain. A model's structured answer is described by ONE declarative spec per stage. The same spec (1) validates the answer, (2) is rendered into the instruction the
// model receives, (3) drives the near-miss normalization, and (4) generates the valid and the mutated structures of the property tests. A rule that the validator enforces is therefore a rule that the
// instruction states: there is no second list to forget. Rules that cannot be expressed per field (relations between fields, between an answer and its context) are declared next to the spec as
// `rules` ({ id, statement, check(value, ctx) }) and are printed and enforced from that one declaration too.
//
// Spec nodes: text(), word(), list(), obj(). Nothing here knows a provider, a model, a merchant or a product.

const SPEC = Symbol('spec');
const node = (kind, body) => Object.freeze({ [SPEC]: true, kind, ...body });
export const isSpec = (v) => v !== null && typeof v === 'object' && v[SPEC] === true;

/** One line of plain text. `geometry`: no digit, colour code or unit (a semantic line). `forbid`: refuses the scene lexicon (a narrative element). */
export const text = ({ min = 1, max = TEXT_MAX, geometry = false, forbid = false, doc = null } = {}) => node('text', { min, max, geometry, forbid, doc });
/** A closed vocabulary (an object of NAME: 'NAME'). Matching is exact after trimming; `caseInsensitive` also accepts another casing of the same word (a harmless syntactic variant, journaled). */
export const word = (vocab, { caseInsensitive = true, doc = null } = {}) => node('word', { vocab, caseInsensitive, doc });
export const list = (item, { min = 0, max = 12, doc = null } = {}) => node('list', { item, min, max, doc });
/** An object whose keys are words of a closed vocabulary (each at most once) and whose values follow one spec. */
export const map = (keyVocab, value, { min = 1, max = 12, doc = null } = {}) => node('map', { keyVocab, value, min, max, doc });
/** A closed object: exactly `fields`, except the `optional` keys which may be absent. */
export const obj = (fields, { optional = [], doc = null } = {}) => node('object', { fields, optional, doc });

const GEOMETRY_TEXT = /[0-9]|#[0-9a-f]{3,8}\b|\b(px|pt|em|rem)\b/i;

/** Validates `value` against a spec. Throws a BrainError naming the field; returns the value (normalized as the helpers do: trimmed single-line text). */
export function validateSpec(spec, value, where) {
  switch (spec.kind) {
    case 'text': {
      const out = oneLine(value, where, { min: spec.min, max: spec.max });
      if (spec.geometry && GEOMETRY_TEXT.test(out)) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `${where} holds a digit, a colour code or a unit`, where);
      if (spec.forbid) assertNoSubstitute(out, where);
      return out;
    }
    case 'word': return enumOf(value, spec.vocab, where);
    case 'list': return listOf(value, where, { min: spec.min, max: spec.max }, (v, w) => validateSpec(spec.item, v, w));
    case 'map': {
      if (!isPlain(value)) fail(BRAIN_ERROR.MALFORMED, `${where} must be a plain object`, where);
      const allowed = Object.values(spec.keyVocab);
      const names = Object.keys(value);
      for (const key of names) if (!allowed.includes(key)) fail(BRAIN_ERROR.UNKNOWN_KEY, `${where}.${key} is not part of this contract`, `${where}.${key}`);
      if (names.length < spec.min || names.length > spec.max) fail(BRAIN_ERROR.LIST_INVALID, `${where} must hold ${spec.min}..${spec.max} entries`, where);
      const out = {};
      for (const key of names) out[key] = validateSpec(spec.value, value[key], `${where}.${key}`);
      return out;
    }
    case 'object': {
      if (!isPlain(value)) fail(BRAIN_ERROR.MALFORMED, `${where} must be a plain object`, where);
      const keys = Object.keys(spec.fields);
      for (const key of Object.keys(value)) if (!keys.includes(key)) fail(BRAIN_ERROR.UNKNOWN_KEY, `${where}.${key} is not part of this contract`, `${where}.${key}`);
      for (const key of keys) if (!(key in value) && !spec.optional.includes(key)) fail(BRAIN_ERROR.MISSING_KEY, `${where}.${key} is missing`, `${where}.${key}`);
      const out = {};
      for (const key of keys) if (key in value) out[key] = validateSpec(spec.fields[key], value[key], `${where}.${key}`);
      return out;
    }
    default: throw new TypeError(`unknown spec kind ${spec.kind}`);
  }
}

/** A whole answer: no number anywhere, then the spec, then the declared rules (in order). */
export function validateAnswer({ spec, rules = [] }, value, where, ctx = {}) {
  noNumbers(value, where);
  const out = validateSpec(spec, value, where);
  for (const rule of rules) rule.check(out, ctx, where);
  return out;
}

// ---- the instruction: the spec rendered as words
const describe = (spec) => {
  switch (spec.kind) {
    case 'text': return `ONE line of plain text, ${spec.min === 1 ? 'at most' : `${spec.min} to`} ${spec.max} characters${spec.geometry ? ', with no digit at all, no colour code and no unit' : ''}${spec.forbid ? ', without any word of the refused scene lexicon (see below)' : ''}`;
    case 'word': return `one of: ${Object.values(spec.vocab).join(' | ')}`;
    case 'list': return `a list of ${spec.min} to ${spec.max} ${describe(spec.item).replace(/^a /, '')}`.replace(/(\d+) to (\d+) (one|an?|ONE) /, '$1 to $2 ');
    case 'map': return `an object whose keys are among ${Object.values(spec.keyVocab).join(', ')} (each at most once, ${spec.min} to ${spec.max} entries)`;
    case 'object': return `an object with exactly the keys ${Object.keys(spec.fields).join(', ')}${spec.optional.length ? ` (${spec.optional.join(', ')} optional)` : ''}`;
    default: return '';
  }
};

/** The lines that state a spec to a model: every key, vocabulary, limit and count, including nested ones. */
export function renderSpec(spec, name = 'answer', depth = 0) {
  const lines = [];
  if (spec.kind === 'object') {
    lines.push(`${name}: ${describe(spec)}.`);
    for (const [key, child] of Object.entries(spec.fields)) lines.push(...renderSpec(child, `${name}.${key}`, depth + 1));
    return lines;
  }
  if (spec.kind === 'map') {
    lines.push(`${name}: ${describe(spec)}.`);
    lines.push(...renderSpec(spec.value, `${name}.<key>`, depth + 1));
    return lines;
  }
  if (spec.kind === 'list') {
    lines.push(`${name}: a list of ${spec.min} to ${spec.max} items.`);
    lines.push(...renderSpec(spec.item, `${name}[]`, depth + 1));
    return lines;
  }
  lines.push(`${name}: ${describe(spec)}.${spec.doc ? ` ${spec.doc}` : ''}`);
  return lines;
}

/** What a model sees first: the exact JSON shape of the answer, as a skeleton, and the statement that the dotted names below it are field names and not keys (a model once wrapped its answer in an "answer" key because of them). */
const skeleton = (spec, indent = '') => {
  const next = `${indent}  `;
  switch (spec.kind) {
    case 'text': return '"<one line of text>"';
    case 'word': return `"<one of: ${Object.values(spec.vocab).join(' | ')}>"`;
    case 'list': return `[${skeleton(spec.item, indent)}, ...]`;
    case 'map': return `{ "<one of: ${Object.values(spec.keyVocab).join(' | ')}>": ${skeleton(spec.value, indent)}, ... }`;
    case 'object': return `{\n${Object.entries(spec.fields).map(([key, child]) => `${next}"${key}": ${skeleton(child, next)}`).join(',\n')}\n${indent}}`;
    default: return '""';
  }
};
export function renderShape(spec) {
  return [
    'The answer is exactly this JSON object, and nothing else (no text before or after it). Its keys are at the TOP LEVEL of the object: there is no wrapper key around it (no "answer", no "result", no "response"). Every list is a JSON array in square brackets, every text a JSON string:',
    ...skeleton(spec).split('\n'),
    'The dotted names in the lines below (for example answer.audience) only NAME the fields to describe them: they are not keys, and the word "answer" is never a key.',
  ];
}

/** The complete contract of an answer for an instruction: its shape, then every field, vocabulary, limit and count. */
export const renderContract = (spec, name = 'answer') => [...renderShape(spec), ...renderSpec(spec, name)];

/** The rules that a spec cannot express, as the lines of the instruction. */
export const renderRules = (rules) => rules.map((r) => `RULE ${r.id}: ${r.statement}`);

// ---- near-miss normalization: ONE shared layer for provider structured output.
// It repairs only SYNTACTIC near misses, never a creative meaning: (1) a key misspelled within two edits when exactly one key is unknown and exactly one is missing (so no choice is made);
// (2) line breaks, tabs and runs of blanks inside a one-line text; (3) another casing of a word of a closed vocabulary. It never chooses between contradictory values, never fills a missing value,
// never turns one word of a vocabulary into a different one, never drops a relation. Every repair is returned as journal evidence: { path, kind, from, to }.
export const REPAIR_KIND = Object.freeze({ ENVELOPE: 'ENVELOPE', KEY_NEAR_MISS: 'KEY_NEAR_MISS', WHITESPACE: 'WHITESPACE', WORD_CASE: 'WORD_CASE', OPTIONAL_EMPTY: 'OPTIONAL_EMPTY' });
const MAX_KEY_EDITS = 2;

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = keep; }
  }
  return row[b.length];
}

// A wrapper around the whole answer ({"answer": {...}}): the SAME answer one level down. It is unwrapped only when the object has exactly ONE key that is not a field of the contract, the inside is a plain
// object, and either the key is a generic envelope word or the inside already IS the contract's object (only its keys, every required one present): nothing is chosen, nothing is invented.
const ENVELOPE_KEYS = Object.freeze(['answer', 'response', 'result', 'output', 'data']);

export function normalizeNearMisses(spec, value, repairs = [], path = 'answer') {
  if (spec.kind === 'object' && isPlain(value) && !/[.[]/.test(path)) {
    const keys = Object.keys(value);
    const inner = keys.length === 1 ? value[keys[0]] : null;
    const fitsTheContract = isPlain(inner) && Object.keys(inner).every((k) => k in spec.fields) && Object.keys(spec.fields).every((k) => spec.optional.includes(k) || k in inner);
    if (keys.length === 1 && !(keys[0] in spec.fields) && isPlain(inner) && (ENVELOPE_KEYS.includes(keys[0].trim().toLowerCase()) || fitsTheContract)) {
      repairs.push({ path, kind: REPAIR_KIND.ENVELOPE, from: `{"${keys[0]}": {...}}`, to: 'the inner object' });
      return normalizeNearMisses(spec, value[keys[0]], repairs, path);
    }
  }
  switch (spec.kind) {
    case 'text': {
      if (typeof value !== 'string' || !/[\r\n\t\u2028\u2029]/.test(value)) return value;
      const out = value.replace(/[\r\n\t\u2028\u2029]+/g, ' ');
      repairs.push({ path, kind: REPAIR_KIND.WHITESPACE, from: 'line break or tab', to: 'one blank' });
      return out;
    }
    case 'word': {
      if (!spec.caseInsensitive || typeof value !== 'string') return value;
      const trimmed = value.trim();
      const allowed = Object.values(spec.vocab);
      if (allowed.includes(value)) return value;
      const matches = allowed.filter((a) => a.toLowerCase() === trimmed.toLowerCase());
      if (matches.length !== 1) return value;
      repairs.push({ path, kind: REPAIR_KIND.WORD_CASE, from: value, to: matches[0] });
      return matches[0];
    }
    case 'list': return Array.isArray(value) ? value.map((v, i) => normalizeNearMisses(spec.item, v, repairs, `${path}[${i}]`)) : value;
    case 'map': {
      if (!isPlain(value)) return value;
      const allowed = Object.values(spec.keyVocab);
      const out = {};
      for (const [key, v] of Object.entries(value)) {
        const matches = allowed.includes(key) ? [key] : allowed.filter((a) => a.toLowerCase() === key.trim().toLowerCase());
        const target = matches.length === 1 ? matches[0] : key;
        if (target !== key && !(target in value)) repairs.push({ path: `${path}.${key}`, kind: REPAIR_KIND.WORD_CASE, from: key, to: target });
        out[target !== key && !(target in value) ? target : key] = normalizeNearMisses(spec.value, v, repairs, `${path}.${target}`);
      }
      return out;
    }
    case 'object': {
      if (!isPlain(value)) return value;
      const keys = Object.keys(spec.fields);
      const out = { ...value };
      // an OPTIONAL key given as null or as an empty text is the same as an absent key
      for (const key of spec.optional) if (key in out && (out[key] === null || out[key] === '')) { repairs.push({ path: `${path}.${key}`, kind: REPAIR_KIND.OPTIONAL_EMPTY, from: out[key] === null ? 'null' : 'empty text', to: 'absent' }); delete out[key]; }
      const unknown = Object.keys(out).filter((k) => !keys.includes(k));
      const missing = keys.filter((k) => !spec.optional.includes(k) && !(k in out));
      if (unknown.length === 1 && missing.length === 1 && editDistance(unknown[0], missing[0]) <= MAX_KEY_EDITS) {
        out[missing[0]] = out[unknown[0]]; delete out[unknown[0]];
        repairs.push({ path, kind: REPAIR_KIND.KEY_NEAR_MISS, from: unknown[0], to: missing[0] });
      }
      for (const key of keys) if (key in out) out[key] = normalizeNearMisses(spec.fields[key], out[key], repairs, `${path}.${key}`);
      return out;
    }
    default: return value;
  }
}

// ---- generation and mutation, for the property tests: valid structures from a spec, and the same structure broken one rule at a time
const POOL = ['amber', 'quiet', 'harbour', 'morning', 'weathered', 'linen', 'copper', 'orchard', 'ripple', 'lantern', 'meadow', 'velvet', 'granite', 'drift', 'ember', 'willow', 'compass', 'tide', 'ledger', 'mosaic'];

/** A deterministic pseudo-random source (no clock, no Math.random). */
export function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

export function generateValid(spec, random, { textOf = null, path = 'answer' } = {}) {
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  switch (spec.kind) {
    case 'text': {
      if (textOf) { const t = textOf(spec, path); if (t) return t; }
      const target = spec.min + Math.floor(random() * Math.max(1, Math.min(spec.max, spec.min + 60) - spec.min + 1));
      let out = '';
      while (out.length < target) out += `${out ? ' ' : ''}${pick(POOL)}`;
      return out.length > spec.max ? out.slice(0, spec.max).trim() || pick(POOL) : out.padEnd(spec.min, 'a');
    }
    case 'word': return pick(Object.values(spec.vocab));
    case 'list': { const n = spec.min + Math.floor(random() * (Math.min(spec.max, spec.min + 2) - spec.min + 1)); return Array.from({ length: n }, (_, i) => generateValid(spec.item, random, { textOf, path: `${path}[${i}]` })); }
    case 'map': { const keys = Object.values(spec.keyVocab).slice(0, spec.min + Math.floor(random() * (Math.min(spec.max, Object.values(spec.keyVocab).length) - spec.min + 1))); return Object.fromEntries(keys.map((k) => [k, generateValid(spec.value, random, { textOf, path: `${path}.${k}` })])); }
    case 'object': {
      const out = {};
      for (const [key, child] of Object.entries(spec.fields)) if (!spec.optional.includes(key) || random() < 0.5) out[key] = generateValid(child, random, { textOf, path: `${path}.${key}` });
      return out;
    }
    default: throw new TypeError('unknown spec');
  }
}

/** Every single-rule mutation of a valid structure: { label, value, code, field }. `code` and `field` are what the validator must answer with. */
export function mutations(spec, valid, where = 'answer') {
  const out = [];
  const setAt = (path, value) => { const copy = structuredClone(valid); if (!path.length) return value; let cur = copy; for (const k of path.slice(0, -1)) cur = cur[k]; cur[path.at(-1)] = value; return copy; };
  const edit = (path, fn) => { const copy = structuredClone(valid); fn(path.reduce((c, k) => c[k], copy)); return copy; };
  const push = (label, value, code, field) => out.push({ label, value, code, field });
  const walk = (s, v, path, field) => {
    if (s.kind === 'text') {
      if (s.min > 1) push(`${field} below its minimum`, setAt(path, 'a'.repeat(s.min - 1)), BRAIN_ERROR.TEXT_INVALID, field);
      push(`${field} above its maximum`, setAt(path, 'a'.repeat(s.max + 1)), BRAIN_ERROR.TEXT_INVALID, field);
      push(`${field} blank`, setAt(path, '   '), BRAIN_ERROR.TEXT_INVALID, field);
      push(`${field} not text`, setAt(path, ['x']), BRAIN_ERROR.TEXT_INVALID, field);
      push(`${field} a number`, setAt(path, 7), BRAIN_ERROR.NUMERIC_VALUE, field);
      if (s.geometry) for (const bad of ['lit at 5 pm', 'in #ff8800 tones', 'about 4 px wide']) push(`${field} geometry (${bad})`, setAt(path, `quiet ${bad}`), BRAIN_ERROR.FORBIDDEN_CONTENT, field);
      if (s.forbid) push(`${field} forbidden word`, setAt(path, 'a quiet phone in the corner'), BRAIN_ERROR.FORBIDDEN_CONTENT, field);
    } else if (s.kind === 'word') {
      push(`${field} unknown word`, setAt(path, 'NOT_A_WORD_OF_THE_VOCABULARY'), BRAIN_ERROR.ENUM_INVALID, field);
      push(`${field} a number`, setAt(path, 3), BRAIN_ERROR.NUMERIC_VALUE, field);
    } else if (s.kind === 'list') {
      if (s.min > 0) push(`${field} too few`, setAt(path, v.slice(0, s.min - 1)), BRAIN_ERROR.LIST_INVALID, field);
      push(`${field} too many`, setAt(path, Array.from({ length: s.max + 1 }, (_, i) => v[i % Math.max(1, v.length)] ?? 'amber quiet harbour')), BRAIN_ERROR.LIST_INVALID, field);
      push(`${field} not a list`, setAt(path, 'amber'), BRAIN_ERROR.LIST_INVALID, field);
      if (v.length) walk(s.item, v[0], [...path, 0], `${field}[0]`);
    } else if (s.kind === 'map') {
      push(`${field} unknown key`, edit(path, (t) => { t.zzzzzzzzzz = 'amber'; }), BRAIN_ERROR.UNKNOWN_KEY, `${field}.zzzzzzzzzz`);
      push(`${field} not an object`, setAt(path, 'amber'), BRAIN_ERROR.MALFORMED, field);
      const first = Object.keys(v)[0];
      if (first) walk(s.value, v[first], [...path, first], `${field}.${first}`);
    } else if (s.kind === 'object') {
      push(`${field} unknown key`, edit(path, (t) => { t.zzzzzzzzzz = 'amber'; }), BRAIN_ERROR.UNKNOWN_KEY, `${field}.zzzzzzzzzz`);
      for (const key of Object.keys(s.fields).filter((k) => !s.optional.includes(k))) push(`${field}.${key} missing`, edit(path, (t) => { delete t[key]; }), BRAIN_ERROR.MISSING_KEY, `${field}.${key}`);
      for (const [key, child] of Object.entries(s.fields)) if (key in v) walk(child, v[key], [...path, key], `${field}.${key}`);
    }
  };
  walk(spec, valid, [], where);
  return out;
}
