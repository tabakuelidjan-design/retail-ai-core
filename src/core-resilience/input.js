import { CORE_CATEGORY as C, makeCoreError } from './taxonomy.js';

// NORDLA CORE RESILIENCE: USER INPUT. Unpredictable input is normalized ONLY when its meaning is preserved (Unicode form, invisible characters, runs of blanks); when normalization could change the meaning the answer
// is ASK_USER. Nothing is truncated, translated or guessed, and nothing is ever invented: a price, a legal or financial fact, a product claim, a supplier claim, a compliance claim or a commercial fact that is
// missing is MISSING_INFORMATION unless a safe default was DECLARED for that field. Contradictions are detected, not resolved, unless an explicit user-priority rule resolves them.

const INVISIBLE = /[​-‍⁠﻿­‪-‮⁦-⁩]/g; // zero-width, BOM, soft hyphen, bidirectional controls
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const NULL_LIKE = new Set(['null', 'undefined', 'nan', 'n/a', 'na', 'none', 'nil', '-', '--', '—', '?', 'tbd', 'todo', 'unknown', 'aucun', 'neant', 'néant', 'geen', 'ninguno', 'kein', 'nessuno']);

export const FIELD_STATUS = Object.freeze({ OK: 'OK', NORMALIZED: 'NORMALIZED', MISSING: 'MISSING', TOO_LONG: 'TOO_LONG', INVALID: 'INVALID', AMBIGUOUS: 'AMBIGUOUS' });

/** The scripts present in a text (for reporting and routing only, never to change it). */
export function scriptsOf(text) {
  const found = new Set();
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    if (/\p{Script=Latin}/u.test(ch)) found.add('LATIN');
    else if (/\p{Script=Cyrillic}/u.test(ch)) found.add('CYRILLIC');
    else if (/\p{Script=Greek}/u.test(ch)) found.add('GREEK');
    else if (/\p{Script=Arabic}/u.test(ch)) found.add('ARABIC');
    else if (/\p{Script=Hebrew}/u.test(ch)) found.add('HEBREW');
    else if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch)) found.add('CJK');
    else if (/\p{Script=Devanagari}|\p{Script=Thai}/u.test(ch)) found.add('OTHER_INDIC_OR_THAI');
    else if (cp > 0x1F000) found.add('EMOJI');
  }
  return [...found].sort();
}

/**
 * One text field. `multiline` keeps line breaks (long copy); otherwise blanks and line breaks collapse to one blank. Returns { status, value, repairs }.
 *   MISSING   : absent, empty, only blanks, or a null-like word the field does not accept literally (`nullLike: 'LITERAL'` accepts it).
 *   TOO_LONG  : more than `max` characters: never truncated, the user is asked.
 */
export function readTextField(raw, { max = 2000, multiline = false, nullLike = 'MISSING' } = {}) {
  const repairs = [];
  if (raw === null || raw === undefined) return { status: FIELD_STATUS.MISSING, value: null, repairs };
  if (typeof raw !== 'string') return { status: FIELD_STATUS.INVALID, value: null, repairs, reason: 'NOT_TEXT' };
  let value = raw;
  const step = (name, next) => { if (next !== value) { repairs.push(name); value = next; } };
  step('UNICODE_NFC', value.normalize('NFC'));
  step('INVISIBLE_CHARACTERS_REMOVED', value.replace(INVISIBLE, ''));
  step('CONTROL_CHARACTERS_REMOVED', value.replace(CONTROL, ''));
  step('NON_BREAKING_SPACE', value.replace(/[   　]/g, ' '));
  step('LINE_ENDINGS', value.replace(/\r\n?/g, '\n'));
  step(multiline ? 'BLANK_RUNS' : 'WHITESPACE_COLLAPSED', multiline ? value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : value.replace(/\s+/g, ' '));
  step('TRIMMED', value.trim());
  if (value === '') return { status: FIELD_STATUS.MISSING, value: null, repairs };
  if (nullLike === 'MISSING' && NULL_LIKE.has(value.toLowerCase())) return { status: FIELD_STATUS.MISSING, value: null, repairs, reason: 'NULL_LIKE' };
  if (value.length > max) return { status: FIELD_STATUS.TOO_LONG, value: null, repairs, reason: `MORE_THAN_${max}_CHARACTERS` };
  return { status: repairs.length ? FIELD_STATUS.NORMALIZED : FIELD_STATUS.OK, value, repairs };
}

/**
 * An amount in a currency. Accepted without ambiguity: 25, "25", "25.5", "25,50", "25,50 EUR", "EUR 25", "€25". A group separator ("1.250", "1,250", "1 250,00") is AMBIGUOUS (1250 or 1.25?) and is never guessed.
 */
export function readAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? { status: FIELD_STATUS.OK, value: raw } : { status: FIELD_STATUS.INVALID, value: null, reason: 'NOT_A_NON_NEGATIVE_NUMBER' };
  if (typeof raw !== 'string') return { status: FIELD_STATUS.MISSING, value: null };
  const text = readTextField(raw, { max: 40 });
  if (text.status === FIELD_STATUS.MISSING) return { status: FIELD_STATUS.MISSING, value: null };
  if (text.status === FIELD_STATUS.TOO_LONG) return { status: FIELD_STATUS.INVALID, value: null, reason: 'TOO_LONG' };
  const bare = text.value.replace(/\b(?:EUR|USD|GBP|CHF)\b/gi, '').replace(/[€$£]/g, '').trim();
  if (/^\d+(?:[.,]\d{1,2})?$/.test(bare)) return { status: FIELD_STATUS.NORMALIZED, value: Number(bare.replace(',', '.')) };
  if (/^\d{1,3}(?:[., ]\d{3})+(?:[.,]\d{1,2})?$/.test(bare) || /^\d+[.,]\d{3}$/.test(bare)) return { status: FIELD_STATUS.AMBIGUOUS, value: null, reason: 'GROUP_SEPARATOR_OR_DECIMAL' };
  return { status: FIELD_STATUS.INVALID, value: null, reason: 'NOT_AN_AMOUNT' };
}

/**
 * A whole input against a field schema: { field: { kind: 'text'|'amount'|'enum', required, max, multiline, enum, safeDefault, factClass } }.
 * Returns { values, repairs, issues }, where each issue is a CoreError: MISSING_INFORMATION, INPUT_INVALID (too long, not an amount, ambiguous amount, not in the enum). A missing field with a DECLARED `safeDefault` takes
 * it (journaled); a missing field of a `factClass` (price, legal, financial, claim, supplier, compliance) NEVER takes a default that was not declared.
 */
export function readInput(schema, input, { module, stage, tenant = null } = {}) {
  const values = {}; const repairs = []; const issues = [];
  const where = { module, stage, tenant };
  for (const [field, rule] of Object.entries(schema)) {
    const raw = input?.[field];
    let result;
    if (rule.kind === 'amount') result = readAmount(raw);
    else if (rule.kind === 'enum') {
      const t = readTextField(raw, { max: 80 });
      const hit = t.value === null ? null : rule.enum.find((e) => e.toLowerCase() === t.value.toLowerCase());
      result = t.status === FIELD_STATUS.MISSING ? t : hit ? { status: t.value === hit ? FIELD_STATUS.OK : FIELD_STATUS.NORMALIZED, value: hit, repairs: t.value === hit ? [] : ['ENUM_CASE'] } : { status: FIELD_STATUS.INVALID, value: null, reason: 'NOT_AN_ALLOWED_VALUE' };
    } else result = readTextField(raw, { max: rule.max ?? 2000, multiline: rule.multiline === true, nullLike: rule.nullLike ?? 'MISSING' });
    if (result.status === FIELD_STATUS.OK || result.status === FIELD_STATUS.NORMALIZED) {
      values[field] = result.value;
      for (const r of result.repairs ?? (result.status === FIELD_STATUS.NORMALIZED && rule.kind === 'amount' ? ['AMOUNT_NORMALIZED'] : [])) repairs.push({ field, repair: r });
    } else if (result.status === FIELD_STATUS.MISSING) {
      if (rule.safeDefault !== undefined) { values[field] = rule.safeDefault; repairs.push({ field, repair: 'DECLARED_SAFE_DEFAULT' }); }
      else if (rule.required) issues.push(makeCoreError({ ...where, category: C.MISSING_INFORMATION, code: 'INPUT_REQUIRED_FIELD_MISSING', domain_code: rule.factClass ? `${String(rule.factClass).toUpperCase()}_FACT_MISSING` : null, human_message: `The field ${field} is required.`, diagnostics: { field, null_like: result.reason === 'NULL_LIKE' } }));
    } else {
      issues.push(makeCoreError({ ...where, category: C.INPUT_INVALID, code: result.status === FIELD_STATUS.TOO_LONG ? 'INPUT_TOO_LONG' : result.status === FIELD_STATUS.AMBIGUOUS ? 'INPUT_AMBIGUOUS' : 'INPUT_NOT_USABLE', human_message: `The field ${field} cannot be used as given.`, diagnostics: { field, reason: result.reason } }));
    }
  }
  return { values, repairs, issues };
}

const norm = (v) => (typeof v === 'string' ? v.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase() : JSON.stringify(v));

/**
 * Statements of one revision of the request: [{ key, value, explicit_change?: boolean, at? }]. Two statements about the same key with different values contradict each other. A rule `priority: { key: 'LATEST_WINS' }`
 * resolves it ONLY for statements flagged `explicit_change` (the user reversing themselves on purpose); otherwise it is a USER_CONTRADICTION. Returns { resolved, contradictions: [CoreError] }.
 */
export function reconcileStatements(statements, { priority = {}, module, stage, tenant = null } = {}) {
  const byKey = new Map();
  for (const s of statements) { if (!byKey.has(s.key)) byKey.set(s.key, []); byKey.get(s.key).push(s); }
  const resolved = {}; const contradictions = [];
  for (const [key, list] of byKey) {
    const distinct = new Set(list.map((s) => norm(s.value)));
    if (distinct.size === 1) { resolved[key] = list[0].value; continue; }
    const latest = list[list.length - 1];
    if (priority[key] === 'LATEST_WINS' && latest.explicit_change === true) { resolved[key] = latest.value; continue; }
    contradictions.push(makeCoreError({ module, stage, tenant, category: C.USER_CONTRADICTION, code: 'USER_STATEMENTS_CONTRADICT', domain_code: null, human_message: `Two different values were given for ${key}.`, diagnostics: { key, values: distinct.size } }));
  }
  return { resolved, contradictions };
}
