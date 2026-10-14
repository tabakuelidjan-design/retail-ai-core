// EXTERNAL EVIDENCE CONTRACT. The seam through which a provider (shipment-history service, factory-audit company, company registry, certificate registry...) can later feed the supplier truth card
// WITHOUT any redesign: it enters the case as one event, with who said it, when, from where, and how far Nordla trusts that provider. No provider exists today, so nothing is fetched here.
// A provider's statement is never VERIFIED just because it was delivered: only a provider that Nordla has explicitly REGISTERED (below, empty today) may keep a declared VERIFIED status.
// Anything else is shown as an ESTIMATE from an unregistered source. Dates and a source reference are mandatory, so a card can always say where a line came from and how old it is.
export const EVIDENCE_KIND = Object.freeze({ COMPANY_RECORD: 'COMPANY_RECORD', SHIPMENT_HISTORY: 'SHIPMENT_HISTORY', FACTORY_AUDIT: 'FACTORY_AUDIT', CERTIFICATE_REGISTRY: 'CERTIFICATE_REGISTRY', LAB_REPORT_CHECK: 'LAB_REPORT_CHECK', SANCTIONS_CHECK: 'SANCTIONS_CHECK', OTHER: 'OTHER' });
export const EVIDENCE_STATUS = Object.freeze(['VERIFIED', 'SUPPLIER_CLAIM', 'ESTIMATED', 'UNKNOWN', 'CONFLICT']);
/** Providers Nordla has reviewed and chose to trust for a given kind: { providerId: [kinds] }. EMPTY today: no external evidence can be called VERIFIED yet. */
export const REGISTERED_PROVIDERS = Object.freeze({});
export const MAX_EXTERNAL = 200;

export class ExternalEvidenceError extends Error { constructor(msg) { super(msg); this.code = 'EXTERNAL_EVIDENCE_INVALID'; } }

/** Validates one piece of external evidence and returns the record kept in the case. Throws a clear error instead of storing something unusable. */
export function normalizeExternalEvidence(e, at) {
  if (!e || typeof e !== 'object') throw new ExternalEvidenceError('external evidence must be an object');
  const provider = String(e.provider ?? '').trim(); if (!provider) throw new ExternalEvidenceError('the provider is required');
  if (!EVIDENCE_KIND[e.kind]) throw new ExternalEvidenceError(`unknown kind: ${e.kind}`);
  const declared = String(e.status ?? 'UNKNOWN'); if (!EVIDENCE_STATUS.includes(declared)) throw new ExternalEvidenceError(`unknown status: ${declared}`);
  const sourceRef = String(e.sourceRef ?? '').trim(); if (!sourceRef) throw new ExternalEvidenceError('a source reference is required (where this comes from)');
  const retrievedAt = String(e.retrievedAt ?? ''); if (!retrievedAt || Number.isNaN(Date.parse(retrievedAt))) throw new ExternalEvidenceError('retrievedAt must be a date');
  const claim = String(e.claim ?? '').trim(); if (!claim) throw new ExternalEvidenceError('the claim (what the provider says) is required');
  const registered = (REGISTERED_PROVIDERS[provider] ?? []).includes(e.kind);
  const status = declared === 'VERIFIED' && !registered ? 'ESTIMATED' : declared;
  return { id: e.id ?? null, provider, kind: e.kind, subject: e.subject === 'product' || e.subject === 'document' ? e.subject : 'supplier', claim, data: e.data ?? null, declaredStatus: declared, status, registered, downgraded: status !== declared, sourceRef, retrievedAt, validUntil: e.validUntil ?? null, recordedAt: at,
    note: status !== declared ? `declared ${declared} by ${provider}, which is not a registered provider: shown as ${status}` : null };
}
export function applyExternalEvidence(s, ev, at) {
  s.externalEvidence ??= []; const rec = normalizeExternalEvidence(ev.evidence, at); rec.id = rec.id ?? `ext-${s.externalEvidence.length + 1}`;
  if (s.externalEvidence.some((x) => x.id === rec.id)) return; // idempotent: the same record is never stored twice
  if (s.externalEvidence.length >= MAX_EXTERNAL) throw new ExternalEvidenceError('too many external evidence records for one case');
  s.externalEvidence.push(rec);
}

/** SAMPLE LIFECYCLE (a sample is evidence about quality, so it is part of the case): REQUESTED -> RECEIVED -> EVALUATED (PASS / CONCERNS / FAIL). Append-only. */
export const SAMPLE_STATUS = Object.freeze(['REQUESTED', 'RECEIVED', 'EVALUATED']);
export const SAMPLE_VERDICT = Object.freeze(['PASS', 'CONCERNS', 'FAIL']);
export function applySampleRecord(s, ev, at) {
  s.samples ??= []; const status = String(ev.status ?? ''); if (!SAMPLE_STATUS.includes(status)) throw new Error(`sample status must be one of ${SAMPLE_STATUS.join(', ')}`);
  const verdict = ev.verdict ?? null; if (status === 'EVALUATED' && !SAMPLE_VERDICT.includes(verdict)) throw new Error(`an evaluated sample needs a verdict: ${SAMPLE_VERDICT.join(', ')}`); if (status !== 'EVALUATED' && verdict !== null) throw new Error('only an evaluated sample has a verdict');
  s.samples.push({ id: `smp-${s.samples.length + 1}`, status, verdict, note: ev.note ? String(ev.note).slice(0, 500) : null, offerId: ev.offerId ?? s.offers?.at(-1)?.id ?? null, at });
}
export const sampleState = (s) => { const l = (s.samples ?? []).at(-1) ?? null; return l ? { status: l.status, verdict: l.verdict, at: l.at, id: l.id } : { status: 'NONE', verdict: null, at: null, id: null }; };
