// Conflict detection. A material supplier fact is never overwritten silently: when a confirmed statement differs from what the case already holds, a CONFLICT is raised and a person chooses.
// Contexts separate things that only look contradictory (product MOQ 100 vs custom-logo MOQ 300). Model identifiers are compared EXACTLY: PB-X200, PB X200 and X200 are never silently equal.
import { effectiveQuote } from './offers.js';

const MODEL_BOUND = new Set(['EU_DOC', 'TEST_REPORT', 'CERTIFICATE', 'UN383', 'FCM_DOC', 'BATTERY_DOC']);
const squash = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** @returns {{ result: 'MATCH'|'FORMAT_VARIANT'|'MISMATCH'|'NO_CASE_MODEL'|'NO_DOC_MODEL' }} */
export function compareModels(caseModel, docModel) {
  const a = String(caseModel ?? '').trim(); const b = String(docModel ?? '').trim();
  if (!a) return { result: 'NO_CASE_MODEL' }; if (!b) return { result: 'NO_DOC_MODEL' };
  if (a === b) return { result: 'MATCH' };
  return squash(a) === squash(b) ? { result: 'FORMAT_VARIANT' } : { result: 'MISMATCH' };
}

/** Documents that name another model than the case (computed from the case, not stored). A format variant is reported separately: it needs a human decision, it is not accepted. */
export function documentModelConflicts(state) {
  const caseModel = state.identity?.identifiers?.model ?? null; if (!caseModel) return [];
  const out = [];
  for (const d of state.documents ?? []) {
    const models = d.extraction?.models ?? []; if (!models.length || !MODEL_BOUND.has(d.docType)) continue;
    const rs = models.map((m) => compareModels(caseModel, m).result); if (rs.includes('MATCH')) continue;
    out.push({ docId: d.id, fileName: d.fileName ?? null, docType: d.docType, caseModel, docModels: models, result: rs.includes('FORMAT_VARIANT') ? 'FORMAT_VARIANT' : 'MISMATCH' });
  }
  return out;
}

const numEq = (a, b) => { const x = Number(String(a).replace(',', '.')); const y = Number(String(b).replace(',', '.')); return Number.isFinite(x) && Number.isFinite(y) && x === y; };
const same = (a, b) => (typeof a === 'object' || typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b) || numEq(a, b));

/** What the case holds today for a candidate key (null = nothing, so nothing can conflict). */
export function existingValue(state, key, context = 'product') {
  const q = state.quotes?.at(-1) ?? null; const eq = q ? effectiveQuote(q) : null; const id = state.identity?.identifiers ?? {};
  switch (key) {
    case 'identifier.model': return id.model ?? null; case 'identifier.brand': return id.brand ?? null; case 'identifier.manufacturer': return id.manufacturer ?? null;
    case 'quote.unitPrice': return eq?.unitPrice ?? null; case 'quote.currency': return q?.currency ?? null; case 'quote.incoterm': return q?.incoterm ?? null; case 'quote.port': return q?.port ?? null;
    case 'quote.moq': return context === 'product' ? (q?.moq ?? null) : lastLedger(state, key, context); case 'quote.tiers': return q?.tiers ?? null;
    case 'quote.leadTime': return q?.leadTimeDays ?? null; case 'payment.depositPct': return q?.payment?.depositPct ?? null; case 'payment.balancePct': return q?.payment?.balancePct ?? null;
    default: return lastLedger(state, key, context);
  }
}
const lastLedger = (state, key, context) => (state.ledger ?? []).filter((e) => e.key === key && e.context === context).at(-1)?.value ?? null;

/** @returns {null | { type: 'MODEL_MISMATCH'|'VALUE', key: string, existing: any }} */
export function findCandidateConflict(state, cand, value) {
  if (cand.key.startsWith('docClaim.')) return null; // claims are statements; a changed statement is recorded, the document ledger keeps the latest
  const have = existingValue(state, cand.key, cand.context);
  if (have === null || have === undefined || have === '') return null;
  const incoming = cand.key === 'quote.leadTime' && value && typeof value === 'object' ? value.max : value;
  if (same(have, incoming)) return null;
  return { type: cand.key === 'identifier.model' ? 'MODEL_MISMATCH' : 'VALUE', key: cand.key, existing: have };
}
