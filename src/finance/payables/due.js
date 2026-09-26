// The due date of a SUPPLIER document, with where it comes from. Pure functions: no model, no database, no hidden clock (today is always a parameter).
//
// Origin (the same mechanism as every other field: `extraction.provenance.dueDate.source`, plus the evidence in `extraction.due`):
//   MANUAL               a person typed or corrected it (provenance source 'user')                             - never overwritten
//   PRINTED              the supplier printed a due date on the document (read by the PDF / UBL reader)
//   COMPUTED_FROM_TERMS  no printed date, but an EXPLICIT payment term of the closed grammar + a valid invoice date; the original wording is kept
//   UNKNOWN              none of the above. Never a default number of days, never the merchant's own invoicing terms.
// Priority: MANUAL > PRINTED > COMPUTED_FROM_TERMS > UNKNOWN. When a printed date and a computed one both exist they are both kept; if they differ, the
// printed date stays and the difference is reported (never hidden).

import { addDays, daysBetween } from '../document.js';
import { parsePaymentTerms } from './payment-terms.js';

export const DUE_ORIGINS = ['MANUAL', 'PRINTED', 'COMPUTED_FROM_TERMS', 'UNKNOWN'];
export const COMPUTED_PROVENANCE_SOURCE = 'computed';   // provenance.dueDate.source of a computed date (a person's edit is 'user', a reader's is its own name)
export const DUE_DATE_DIFFERS_WARNING = 'DUE_DATE_DIFFERS_FROM_TERMS';
const COMPUTABLE = ['IMMEDIATE', 'NET_DAYS', 'NET_DAYS_END_OF_MONTH'];

export const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const lastDayOfMonth = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };

/**
 * The due date a parsed term gives, or null when it cannot give one (unknown starting point, invalid invoice date, PREPAID...).
 * @param {string|null} issueDate YYYY-MM-DD
 * @param {{ kind: string, days: number|null, referencePoint: string|null, endOfMonth: boolean }|null} parsed
 */
export function computeDueFromTerms(issueDate, parsed) {
  if (!parsed || !COMPUTABLE.includes(parsed.kind) || parsed.referencePoint !== 'INVOICE_DATE' || !isIsoDate(issueDate) || !Number.isInteger(parsed.days) || parsed.days < 0) return null;
  const plain = addDays(issueDate, parsed.days);
  return { value: parsed.endOfMonth ? lastDayOfMonth(plain) : plain, referenceDate: issueDate, days: parsed.days, endOfMonth: !!parsed.endOfMonth };
}

/**
 * @param {{ issueDate: string|null, printed: string|null, terms: { raw: string, status: string, parsed: object|null }|null, manual?: { value: string|null }|null }} input
 *   manual: present only when a person set (or cleared) the date.
 * @returns {{ effective: { value: string|null, origin: string }, computed: object|null, divergence: { printed: string, computed: string, days: number }|null, suppressed: boolean }}
 */
export function resolveDue({ issueDate, printed, terms, manual = null }) {
  const computed = terms?.status === 'PARSED' ? computeDueFromTerms(issueDate, terms.parsed) : null;
  const printedOk = isIsoDate(printed) ? printed : null;
  const divergence = printedOk && computed && printedOk !== computed.value ? { printed: printedOk, computed: computed.value, days: daysBetween(computed.value, printedOk) } : null;
  if (manual) return { effective: manual.value ? { value: manual.value, origin: 'MANUAL' } : { value: null, origin: 'UNKNOWN' }, computed, divergence, suppressed: !manual.value };
  if (printedOk) return { effective: { value: printedOk, origin: 'PRINTED' }, computed, divergence, suppressed: false };
  if (computed) return { effective: { value: computed.value, origin: 'COMPUTED_FROM_TERMS' }, computed, divergence: null, suppressed: false };
  return { effective: { value: null, origin: 'UNKNOWN' }, computed: null, divergence: null, suppressed: false };
}

/**
 * From what a reader extracted (fields of an extraction) to the due-date block, the column value and the provenance entry.
 * @param {{ issueDate: string|null, fields: object }} p fields: the reader's fields ({ dueDate?, paymentTerms? }, each { value, page?, path?, text? })
 */
export function buildDue({ issueDate, fields }) {
  const printedField = fields?.dueDate ?? null; const termsField = fields?.paymentTerms ?? null;
  const termsRaw = typeof termsField?.value === 'string' ? termsField.value : null;
  const terms = termsRaw ? { raw: termsRaw.slice(0, 200), ...parsePaymentTerms(termsRaw, { labelled: termsField.path !== 'TERMS_PHRASE' }), page: termsField.page ?? null, rule: termsField.path ?? null } : null;
  const r = resolveDue({ issueDate, printed: typeof printedField?.value === 'string' ? printedField.value : null, terms });
  const hasEvidence = !!(printedField || terms);
  const due = hasEvidence ? {
    version: 1, issueDate: isIsoDate(issueDate) ? issueDate : null,
    printed: printedField && typeof printedField.value === 'string' ? { value: printedField.value, page: printedField.page ?? null, rule: printedField.path ?? null } : null,
    terms, computed: r.computed, effective: r.effective, divergence: r.divergence, suppressed: false,
  } : null;
  const provenance = r.effective.origin === 'COMPUTED_FROM_TERMS' ? computedProvenance(r.effective.value, terms) : null;
  return { due, dueDate: r.effective.value, origin: r.effective.origin, provenance, warnings: r.divergence ? [DUE_DATE_DIFFERS_WARNING] : [] };
}

/** provenance.dueDate of a computed date: it keeps the ORIGINAL wording that triggered the rule. */
export const computedProvenance = (value, terms) => ({ source: COMPUTED_PROVENANCE_SOURCE, path: 'COMPUTED_FROM_TERMS', page: terms?.page ?? null, zone: null, text: String(terms?.raw ?? '').slice(0, 160), value, confidence: 0.85 });

/**
 * The origin of the due date of a stored record. Read-only: old records (no `extraction.due`) are never rewritten.
 * @returns {{ origin: string, legacy: boolean }} legacy = a date with no recorded reading (typed before provenance existed): reported as MANUAL, never as read from a document
 */
export function dueOriginOf(row) {
  if (!row?.dueDate) return { origin: 'UNKNOWN', legacy: false };
  const pv = row.extraction?.provenance?.dueDate;
  if (!pv) return { origin: 'MANUAL', legacy: true };
  if (pv.source === 'user') return { origin: 'MANUAL', legacy: false };
  if (pv.source === COMPUTED_PROVENANCE_SOURCE) return { origin: 'COMPUTED_FROM_TERMS', legacy: false };
  return { origin: 'PRINTED', legacy: false };
}

/**
 * A record's due date for the treasury projection: a printed or manual date, or a computed one ONLY IF the explicit wording that produced it is kept.
 * An unknown date, or a computed date whose wording is missing, is not a due date.
 */
export function dueForProjection(row) {
  const { origin } = dueOriginOf(row);
  if (!row?.dueDate || origin === 'UNKNOWN') return { dueDate: null, origin: 'UNKNOWN' };
  if (origin === 'COMPUTED_FROM_TERMS') {
    const wording = row.extraction?.due?.terms?.raw ?? row.extraction?.provenance?.dueDate?.text;
    if (!wording || !String(wording).trim()) return { dueDate: null, origin: 'UNKNOWN' };
  }
  return { dueDate: row.dueDate, origin };
}

/**
 * After a person changed the invoice date: refresh the evidence, and the value itself only when it was computed (a printed or manual date is never moved).
 * @returns {{ due: object|null, dueDate: string|null|undefined, provenance: object|null|undefined }} undefined = leave as is
 */
export function refreshDueAfterIssueDateChange(row, newIssueDate) {
  const ex = row.extraction?.due; if (!ex?.terms) return { due: ex ?? null, dueDate: undefined, provenance: undefined };
  const { origin } = dueOriginOf(row);
  const r = resolveDue({ issueDate: newIssueDate, printed: ex.printed?.value ?? null, terms: ex.terms });
  const due = { ...ex, issueDate: isIsoDate(newIssueDate) ? newIssueDate : null, computed: r.computed, divergence: r.divergence };
  if (origin !== 'COMPUTED_FROM_TERMS') return { due, dueDate: undefined, provenance: undefined };
  due.effective = r.effective;
  return { due, dueDate: r.effective.value, provenance: r.effective.origin === 'COMPUTED_FROM_TERMS' ? computedProvenance(r.effective.value, ex.terms) : null };
}

/** Jours restants = échéance - aujourd'hui (negative = overdue). Same convention as receivables.js (daysOverdue = today - due). */
export const daysRemaining = (dueDate, today) => (isIsoDate(dueDate) && isIsoDate(today) ? daysBetween(today, dueDate) : null);
