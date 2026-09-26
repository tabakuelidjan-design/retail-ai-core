// Verification of a provider's explanation BEFORE anything is shown. Structure first, text second:
//
//   1. the explanation must match EXPLANATION_SCHEMA;
//   2. every claim lists factRefs that exist in the fact store, and every quantity it states (money, count, percent, days, date) points at ONE fact and
//      equals that fact's value at the precision written (no arithmetic: derived figures such as deltas exist as facts of their own);
//   3. every numeral / date written in a claim's text (and in the answer) must be covered by a verified quantity - a number slipped into prose is rejected;
//   4. one failed claim rejects the whole explanation: nothing of it is shown, the deterministic facts are shown instead. Rejection reasons carry codes and
//      positions, never the rejected value.
//   Hypotheses are judged one by one: no proof, unsupported number or a statement of certainty -> that hypothesis is dropped, the rest is kept.
//
// Known limit (documented, tested as such): numbers spelled out in words ("deux commandes") are not detected; the guarantee rests on the structured
// quantities and on numerals in the text.

import { validate } from '../tools/contract.js';
import { EXPLANATION_SCHEMA } from './contract.js';
import { isCurrency } from './facts.js';

const decimalsOf = (n) => { const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
const roundTo = (x, d) => Number(x.toFixed(d));

/** null when the quantity is exactly what its fact says (at the precision stated), else a reason code. */
export function checkQuantity(q, fact) {
  if (!fact) return 'UNKNOWN_FACT_REF';
  const { kind, value } = q;
  if (kind === 'date') return fact.unit === 'date' && typeof value === 'string' && value === fact.value ? null : (fact.unit === 'date' ? 'QUANTITY_NOT_SUPPORTED' : 'QUANTITY_UNIT_MISMATCH');
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'QUANTITY_NOT_SUPPORTED';
  if (kind === 'count' || kind === 'days') {
    if (fact.unit !== (kind === 'count' ? 'count' : 'days')) return 'QUANTITY_UNIT_MISMATCH';
    return Number.isInteger(value) && value === fact.value ? null : 'QUANTITY_NOT_SUPPORTED';
  }
  const d = decimalsOf(value); if (d > 2) return 'QUANTITY_NOT_SUPPORTED';
  if (kind === 'money') { if (!isCurrency(fact.unit)) return 'QUANTITY_UNIT_MISMATCH'; return typeof fact.value === 'number' && roundTo(fact.value, d) === value ? null : 'QUANTITY_NOT_SUPPORTED'; }
  if (kind === 'percent') { if (fact.unit !== 'ratio') return 'QUANTITY_UNIT_MISMATCH'; return typeof fact.value === 'number' && roundTo(fact.value * 100, d) === value ? null : 'QUANTITY_NOT_SUPPORTED'; }
  return 'QUANTITY_NOT_SUPPORTED';
}

// ---- text scanning: which numerals / dates does a text mention? ----
const MONTHS = { janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, august: 8, october: 10 };
const MONTH_WORDS = Object.keys(MONTHS).join('|');

/** Extract date mentions (ISO, dd/mm[/yyyy], "1er septembre [2026]") and return them with the text they leave behind. */
export function scanDates(text) {
  const dates = []; let rest = String(text);
  rest = rest.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => { dates.push({ y: Number(y), m: Number(m), d: Number(d) }); return ' '; });
  rest = rest.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g, (_, d, m, y) => { dates.push({ y: y ? Number(y) : null, m: Number(m), d: Number(d) }); return ' '; });
  rest = rest.replace(new RegExp(`\\b(\\d{1,2})(?:er|e|st|nd|rd|th)?\\s+(${MONTH_WORDS})(?:\\s+(\\d{4}))?`, 'gi'), (_, d, mon, y) => { dates.push({ y: y ? Number(y) : null, m: MONTHS[mon.toLowerCase()], d: Number(d) }); return ' '; });
  rest = rest.replace(new RegExp(`\\b(${MONTH_WORDS})\\s+(\\d{4})\\b`, 'gi'), (_, mon, y) => { dates.push({ y: Number(y), m: MONTHS[mon.toLowerCase()], d: null }); return ' '; });
  return { dates, rest };
}

/** Numerals in a text: each with the values it may denote ("1 234,5" and "1.234" are ambiguous, both readings are tried). */
export function scanNumbers(text) {
  const out = [];
  const re = /\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g;
  for (const m of String(text).matchAll(re)) {
    const raw = m[0]; const cands = new Set();
    const compact = raw.replace(/[   ]/g, '');
    if (/^\d+$/.test(compact)) cands.add(Number(compact));
    if (/[.,]/.test(compact)) {
      cands.add(Number(compact.replace(/\./g, '').replace(',', '.')));   // 1.234,56 -> 1234.56
      if (!/,/.test(compact)) cands.add(Number(compact));                // 1.234 -> 1.234
      cands.add(Number(compact.replace(/,/g, '')));                      // 1,234 -> 1234
    }
    out.push({ raw, candidates: [...cands].filter(Number.isFinite), decimals: (compact.match(/[.,](\d+)$/)?.[1] ?? '').length });
  }
  return out;
}

const sameValue = (candidate, q) => { const a = Math.abs(q.value); return candidate === a || (typeof candidate === 'number' && roundTo(a, decimalsOfToken(candidate)) === candidate); };
const decimalsOfToken = (n) => decimalsOf(n);

/** Codes for every numeral or date in `text` that no verified quantity covers. */
export function unsupportedInText(text, quantities, facts) {
  const problems = []; const { dates, rest } = scanDates(text);
  const dateQs = quantities.filter((q) => q.kind === 'date').map((q) => q.value.split('-').map(Number));
  for (const d of dates) {
    const ok = dateQs.some(([y, m, dd]) => (d.m === m) && (d.d == null || d.d === dd) && (d.y == null || d.y === y));
    if (!ok) problems.push('UNSUPPORTED_DATE_IN_TEXT');
  }
  const years = new Set(facts.list.filter((f) => f.unit === 'date' && typeof f.value === 'string').map((f) => Number(f.value.slice(0, 4))));
  const numericQs = quantities.filter((q) => typeof q.value === 'number');
  for (const n of scanNumbers(rest)) {
    const covered = n.candidates.some((c) => numericQs.some((q) => sameValue(c, q)) || (Number.isInteger(c) && c >= 1900 && c <= 2100 && years.has(c)));
    if (!covered) problems.push('UNSUPPORTED_NUMBER_IN_TEXT');
  }
  return problems;
}

const CERTAINTY = [/\best d[ûu]e?s?\b/i, /\bsont dus\b/i, /\b[àa] cause de\b/i, /\bc['’]est parce que\b/i, /\bprouve\b/i, /\bd[ée]montre\b/i, /\bcertainement\b/i, /\bsans aucun doute\b/i, /\bil est certain\b/i,
  /\bis caused by\b/i, /\bis due to\b/i, /\bproves?\b/i, /\bdefinitely\b/i, /\bcertainly\b/i, /\bwithout (?:a )?doubt\b/i, /\bkomt door\b/i, /\bte wijten aan\b/i, /\bveroorzaakt door\b/i, /\bbewijst\b/i, /\bzonder twijfel\b/i];
export const statesCertainty = (text) => CERTAINTY.some((re) => re.test(text));

function checkEvidence(item, facts) {
  if (!item.factRefs?.length) return 'NO_FACT_REF';
  for (const ref of item.factRefs) if (!facts.byRef.has(ref)) return 'UNKNOWN_FACT_REF';
  const qs = item.quantities ?? [];
  for (const q of qs) {
    if (!item.factRefs.includes(q.factRef)) return 'QUANTITY_REF_NOT_IN_CLAIM';
    const code = checkQuantity(q, facts.byRef.get(q.factRef)); if (code) return code;
  }
  const t = unsupportedInText(item.text, qs, facts); if (t.length) return t[0];
  return null;
}

/**
 * @returns {{ status: 'VERIFIED'|'REJECTED', answer?, claims?, hypotheses?, reasons: {code, where}[], suppressedHypotheses: {index, code}[] }}
 */
export function verifyExplanation(explanation, facts) {
  const problem = explanation && typeof explanation === 'object' ? validate(EXPLANATION_SCHEMA, explanation, 'explanation') : 'explanation must be an object';
  if (problem) return { status: 'REJECTED', reasons: [{ code: 'INVALID_EXPLANATION_SHAPE', where: 'explanation' }], suppressedHypotheses: [] };
  const reasons = [];
  explanation.claims.forEach((c, i) => {
    if (!c.factRefs.length) { reasons.push({ code: 'CLAIM_WITHOUT_FACT_REF', where: `claims[${i}]` }); return; }
    const code = checkEvidence(c, facts); if (code) reasons.push({ code, where: `claims[${i}]` });
  });
  // The answer may only contain numbers that a verified claim states.
  if (!reasons.length) {
    const all = explanation.claims.flatMap((c) => c.quantities ?? []);
    const t = unsupportedInText(explanation.answer, all, facts); if (t.length) reasons.push({ code: t[0] === 'UNSUPPORTED_DATE_IN_TEXT' ? 'UNSUPPORTED_DATE_IN_ANSWER' : 'UNSUPPORTED_NUMBER_IN_ANSWER', where: 'answer' });
  }
  const suppressed = []; const kept = [];
  (explanation.hypotheses ?? []).forEach((h, index) => {
    const code = checkEvidence(h, facts) ?? (statesCertainty(h.text) ? 'HYPOTHESIS_STATED_AS_CERTAINTY' : null);
    if (code) suppressed.push({ index, code: code === 'NO_FACT_REF' ? 'HYPOTHESIS_WITHOUT_EVIDENCE' : code }); else kept.push(h);
  });
  if (reasons.length) return { status: 'REJECTED', reasons, suppressedHypotheses: suppressed };
  return { status: 'VERIFIED', answer: explanation.answer, claims: explanation.claims, hypotheses: kept, reasons: [], suppressedHypotheses: suppressed };
}
