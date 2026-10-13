// SUPPLIER TRUTH CARD. One live card per supplier: who they are, how solid each thing they told us is, where the risk sits, and how they have behaved. Everything is recomputed from the case
// (and from external evidence records, if a provider ever supplies some); nothing on the card is stored on its own, so it can never disagree with the case.
// Vocabulary: VERIFIED (an official or registered external source) / SUPPLIER_CLAIM (said by the supplier or typed from what they said) / ESTIMATED (calculated or inferred) / UNKNOWN / CONFLICT.
// A supplier document is a supplier claim even when it matches the model; a calculation from claims is an estimate; nothing the supplier says is VERIFIED.
import { effective } from '../identity.js';
import { documentStatusOf } from '../provenance.js';
import { documentModelConflicts } from '../conflicts.js';
import { IDENTITY_RANK } from '../levels.js';
import { behaviourMemory } from './memory.js';
import { sampleState } from './external-evidence.js';
import { offerRevisions } from './revisions.js';

export const HEALTH = Object.freeze(['VERIFIED', 'SUPPLIER_CLAIM', 'ESTIMATED', 'UNKNOWN', 'CONFLICT']);
export const RISK_AREAS = Object.freeze(['compliance', 'commercial', 'documentation', 'quality', 'delivery', 'consistency']);
export const PROVIDER_CONTRACT = Object.freeze({
  name: 'EvidenceProviderContract', version: 1,
  howToFeed: 'dispatch({ type: "EXTERNAL_EVIDENCE", evidence }) on the case',
  evidenceShape: { provider: 'string (required)', kind: 'COMPANY_RECORD | SHIPMENT_HISTORY | FACTORY_AUDIT | CERTIFICATE_REGISTRY | LAB_REPORT_CHECK | SANCTIONS_CHECK | OTHER', subject: 'supplier | product | document', claim: 'string (required): what the provider says', data: 'any small JSON', status: 'VERIFIED | SUPPLIER_CLAIM | ESTIMATED | UNKNOWN | CONFLICT', sourceRef: 'string (required): where it comes from', retrievedAt: 'ISO date (required)', validUntil: 'ISO date (optional)' },
  trust: 'A declared VERIFIED is kept only for a provider registered in REGISTERED_PROVIDERS for that kind (empty today); otherwise it is shown as ESTIMATED with the reason.',
  today: 'no provider is connected: the card shows an empty external section',
});

const lastLedger = (s, key, ctx = 'product') => s.ledger.filter((e) => e.key === key && e.context === ctx).at(-1) ?? null;
const openOn = (s, prefix) => s.conflicts.some((c) => c.state === 'OPEN' && String(c.key).startsWith(prefix));
const fact = (key, label, status, value, why, ref = null) => ({ key, label, status, value: value ?? null, why, ref });

/** the supplier's facts and how solid each one is */
function facts(s, a) {
  const q = s.quotes.at(-1) ?? null; const L = a.landed; const out = [];
  const idLevel = (t) => { const e = effective(s.identity, t); return e.known ? (IDENTITY_RANK[e.level] >= IDENTITY_RANK.VERIFIED_OFFICIAL ? 'VERIFIED' : 'SUPPLIER_CLAIM') : e.contradiction ? 'CONFLICT' : 'UNKNOWN'; };
  const model = s.identity.identifiers?.model ?? null; const mst = openOn(s, 'identifier.model') ? 'CONFLICT' : model ? idLevel('model') : 'UNKNOWN';
  out.push(fact('model', 'Model', mst, model, mst === 'CONFLICT' ? 'two different models were stated' : model ? 'stated by the supplier or typed by you' : 'not stated'));
  const mf = s.identity.identifiers?.manufacturer ?? null; out.push(fact('manufacturer', 'Manufacturer', mf ? idLevel('manufacturer') : 'UNKNOWN', mf, mf ? 'stated, not checked against a company record' : 'not stated'));
  const hasPrice = q && (q.unitPrice || (q.tiers ?? []).length);
  out.push(fact('price', 'Price', openOn(s, 'quote.unitPrice') || openOn(s, 'quote.tiers') ? 'CONFLICT' : hasPrice ? 'SUPPLIER_CLAIM' : 'UNKNOWN', hasPrice ? (q.tiers?.length ? `${q.tiers.length} price tiers` : `${q.unitPrice} ${q.currency ?? ''}`.trim()) : null, hasPrice ? 'a supplier quotation' : 'no price on record', lastLedger(s, 'quote.unitPrice') ? { ledgerId: lastLedger(s, 'quote.unitPrice').id } : null));
  out.push(fact('moq', 'MOQ', openOn(s, 'quote.moq') ? 'CONFLICT' : q?.moq ? 'SUPPLIER_CLAIM' : 'UNKNOWN', q?.moq ?? null, q?.moq ? 'a supplier statement' : 'not stated'));
  out.push(fact('incoterm', 'Incoterm', openOn(s, 'quote.incoterm') ? 'CONFLICT' : q?.incoterm ? 'SUPPLIER_CLAIM' : 'UNKNOWN', q?.incoterm ? `${q.incoterm}${q.port ? ` ${q.port}` : ''}` : null, q?.incoterm ? 'a supplier statement' : 'not stated'));
  out.push(fact('leadTime', 'Lead time', openOn(s, 'quote.leadTime') ? 'CONFLICT' : q?.leadTimeDays ? 'SUPPLIER_CLAIM' : 'UNKNOWN', q?.leadTimeDays ?? null, q?.leadTimeDays ? 'a supplier statement' : 'not stated'));
  const mat = lastLedger(s, 'spec.material'); out.push(fact('material', 'Material', openOn(s, 'spec.material') ? 'CONFLICT' : mat ? 'SUPPLIER_CLAIM' : 'UNKNOWN', mat?.value ?? null, mat ? 'a supplier statement' : 'not stated', mat ? { ledgerId: mat.id } : null));
  out.push(fact('payment', 'Payment terms', q?.payment?.depositPct != null ? 'SUPPLIER_CLAIM' : 'UNKNOWN', q?.payment?.depositPct != null ? `${q.payment.depositPct}% deposit` : null, q?.payment?.depositPct != null ? 'a supplier statement' : 'not stated'));
  const typ = lastLedger(s, 'supplier.type'); out.push(fact('supplierType', 'Factory or trading company', typ ? 'SUPPLIER_CLAIM' : 'UNKNOWN', typ?.value ?? null, typ ? 'the supplier says so about itself: not checked' : 'not stated'));
  const claims = [...new Set((s.documentLedger ?? []).map((d) => d.claim))];
  for (const c of claims) { const st = documentStatusOf(s, c); const received = st.received > 0; out.push(fact(`cert:${c}`, `Certificate: ${c}`, st.status === 'MISMATCH' ? 'CONFLICT' : 'SUPPLIER_CLAIM', st.status, st.status === 'MISMATCH' ? 'a document was received but it names another model' : received ? (st.matched ? 'a supplier document matching the model was received: still a supplier document, not proof' : 'a supplier document was received') : `the supplier says ${String(st.claimStatus ?? st.status).toLowerCase().replace('_', ' ')}: no document received`)); }
  out.push(fact('landedCost', 'Landed cost', L && L.status !== 'INFORMATION_INSUFFICIENT' ? 'ESTIMATED' : 'UNKNOWN', L && L.status !== 'INFORMATION_INSUFFICIENT' ? L.totals.landedPerUnitEurMinor : null, L && L.status !== 'INFORMATION_INSUFFICIENT' ? `calculated from claims and entered costs${L.isLowerBound ? ' (LOWER BOUND)' : ''}` : 'cannot be calculated yet'));
  return out;
}

const lvl = (level, why) => ({ level, why });
function risks(s, a, mem) {
  const d = a.decision; const hard = d.hardBlockers.map((b) => b.code); const miss = d.gaps?.missingDocs ?? []; const q = s.quotes.at(-1) ?? null; const sample = sampleState(s); const revs = offerRevisions(s);
  const R = {};
  R.compliance = hard.length ? lvl('HIGH', [`blocked by ${hard.join(', ')}`]) : d.verdict === 'INSUFFICIENT_INFORMATION' ? lvl('UNKNOWN', ['the assessment cannot conclude yet (missing information)']) : d.verdict === 'CONDITIONAL_GO' ? lvl('MEDIUM', [`${d.conditions.length} condition(s) open`]) : lvl('LOW', ['no blocker and no open condition (decision support, not a legal conclusion)']);
  const price = q && (q.unitPrice || q.tiers?.length); const over = a.maxPurchasePrice?.maxUnitPriceMinor != null && q?.unitPrice && q.currency === (a.maxPurchasePrice.currency ?? q.currency) && Math.round(Number(q.unitPrice) * 100) > a.maxPurchasePrice.maxUnitPriceMinor;
  const cw = [];
  if (over) cw.push('the quoted price is above the maximum purchase price');
  if (a.landed?.isLowerBound) cw.push('the landed cost is only a lower bound');
  if (mem.changedPrice || mem.changedMoq) cw.push('the supplier has moved price or MOQ between offers');
  R.commercial = !price ? lvl('UNKNOWN', ['no usable price on record']) : over ? lvl('HIGH', cw) : cw.length ? lvl('MEDIUM', cw) : a.landed?.status === 'INFORMATION_INSUFFICIENT' ? lvl('UNKNOWN', ['price known but the landed cost cannot be calculated']) : lvl('LOW', ['price within the limit and stable']);
  const docBad = d.contradictions?.length || hard.includes('DOCUMENT_CONTRADICTS_CASE') || documentModelConflicts(s).length;
  R.documentation = docBad ? lvl('HIGH', ['a document contradicts the case']) : miss.length ? lvl(s.documents.length ? 'MEDIUM' : 'HIGH', [`${miss.length} required document(s) missing: ${miss.slice(0, 3).map((m) => m.label ?? m.docType ?? m).join(', ')}`]) : d.verdict === 'INSUFFICIENT_INFORMATION' ? lvl('UNKNOWN', ['what is required cannot be determined yet']) : lvl('LOW', ['nothing required is missing for the rules that apply today']);
  R.quality = sample.status === 'EVALUATED' ? (sample.verdict === 'PASS' ? lvl('LOW', ['the sample was evaluated: PASS']) : sample.verdict === 'FAIL' ? lvl('HIGH', ['the sample was evaluated: FAIL']) : lvl('MEDIUM', ['the sample was evaluated with concerns'])) : sample.status === 'NONE' ? lvl('UNKNOWN', ['no sample requested or evaluated']) : lvl('MEDIUM', [`sample ${sample.status.toLowerCase()} but not evaluated yet`]);
  const lead = q?.leadTimeDays != null ? Number(q.leadTimeDays) : null; const need = Number(s.context?.deliveryNeededByDays); const slip = mem.changedLeadTime;
  R.delivery = slip ? lvl('MEDIUM', [`the lead time moved: ${slip.values.join(' -> ')} days`]) : lead === null ? lvl('UNKNOWN', ['no lead time stated']) : Number.isFinite(need) && need > 0 ? (lead <= need ? lvl('LOW', [`${lead} days against ${need} needed`]) : lvl('HIGH', [`${lead} days against ${need} needed`])) : lvl('UNKNOWN', [`${lead} days stated, but nothing says when you need the goods`]);
  const open = mem.contradictory.open.length + mem.contradictory.documents.length;
  R.consistency = open ? lvl('HIGH', [`${open} contradictory statement(s) not resolved`]) : mem.notes.length ? lvl('MEDIUM', mem.notes.filter((n) => !/important question/.test(n)).slice(0, 3).concat(mem.unansweredCritical.length ? [`${mem.unansweredCritical.length} important question(s) still unanswered`] : [])) : revs.length || s.ledger.length ? lvl('LOW', ['no contradiction on record (this is not proof that none exists)']) : lvl('UNKNOWN', ['nothing stated yet']);
  return R;
}

/**
 * @param {object} state the case  @param {object} a its assessment
 * @returns the card (a view): identity, evidence health, risk, behaviour memory and external evidence
 */
export function supplierTruthCard(state, a) {
  const f = facts(state, a); const counts = Object.fromEntries(HEALTH.map((h) => [h, f.filter((x) => x.status === h).length]));
  const ext = (state.externalEvidence ?? []).map((e) => ({ id: e.id, provider: e.provider, kind: e.kind, subject: e.subject, claim: e.claim, status: e.status, declaredStatus: e.declaredStatus, registered: e.registered, note: e.note, sourceRef: e.sourceRef, retrievedAt: e.retrievedAt, validUntil: e.validUntil, expired: e.validUntil ? Date.parse(e.validUntil) < Date.parse(a.asOf) : false }));
  for (const e of ext) if (e.status in counts) counts[e.status] += 1;
  const mem = behaviourMemory(state, a); const typ = f.find((x) => x.key === 'supplierType'); const sp = state.supplier ?? {};
  const risk = risks(state, a, mem);
  return { type: 'SupplierTruthCard', caseId: state.id, asOf: a.asOf,
    identity: { supplier: { name: sp.name ?? null, status: sp.name ? 'SUPPLIER_CLAIM' : 'UNKNOWN' }, contact: { value: sp.contact ?? null, status: sp.contact ? 'SUPPLIER_CLAIM' : 'UNKNOWN' }, location: { booth: sp.booth ?? null, market: sp.market ?? null, address: sp.address ?? null, city: sp.city ?? null, status: sp.address || sp.city || sp.market ? 'SUPPLIER_CLAIM' : 'UNKNOWN' }, link: sp.link ?? null,
      kind: { value: typ.value ?? 'UNKNOWN', status: typ.status, note: 'what the supplier says it is; a registry or an audit would be needed to check it' }, manufacturer: f.find((x) => x.key === 'manufacturer'), model: f.find((x) => x.key === 'model') },
    evidenceHealth: { counts, facts: f, note: 'Nothing the supplier says is VERIFIED. A calculation from claims is an ESTIMATE.' }, risk, riskSummary: RISK_AREAS.map((k) => ({ area: k, level: risk[k].level })), memory: mem,
    external: { providers: [...new Set(ext.map((e) => e.provider))], items: ext, contract: PROVIDER_CONTRACT.name, contractVersion: PROVIDER_CONTRACT.version, note: ext.length ? null : 'no external evidence on record: nothing here was checked against a registry, an audit or a shipment history' } };
}
