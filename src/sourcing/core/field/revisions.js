// OFFER REVISIONS and WHAT CHANGED. Nothing is stored here: the history already exists (the quote list and the evidence ledger are append-only), so a revision is a VIEW over them.
// A revision is "the offer as the supplier last stated it" at one point: one per imported offer that produced at least one reviewed fact, one per quote typed in the form.
// WHAT CHANGED compares two consecutive revisions deterministically: terms, landed cost, recommendation. The older revision is never touched; it is simply still there.
import { assess } from '../case.js';
import { cellsOf, roleOf, ROLE, RECOMMENDATION } from '../comparison.js';
import { resolveUnitPrice, normalizeTiers } from '../offers.js';
import { fmt } from '../money.js';

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const QUOTE_KEYS = new Set(['quote.unitPrice', 'quote.tiers', 'quote.moq', 'quote.incoterm', 'quote.port', 'quote.currency', 'quote.leadTime', 'payment.depositPct', 'payment.balancePct', 'payment.balanceDue']);

export const TERMS = Object.freeze([
  { key: 'priceAtQty', label: 'Unit price', fr: 'Prix unitaire', cat: 'PRICE', better: 'lower' },
  { key: 'tiers', label: 'Price tiers', fr: 'Prix par palier', cat: 'TIERS', better: null },
  { key: 'moq', label: 'Minimum order', fr: 'Minimum de commande', cat: 'MOQ', better: 'lower' },
  { key: 'leadDays', label: 'Lead time', fr: 'Délai', cat: 'LEAD_TIME', better: 'lower' },
  { key: 'productionDays', label: 'Production time', fr: 'Délai de production', cat: 'PRODUCTION', better: 'lower' },
  { key: 'incoterm', label: 'Incoterm', fr: 'Incoterm', cat: 'INCOTERM', better: null },
  { key: 'port', label: 'Port', fr: 'Port', cat: 'INCOTERM', better: null },
  { key: 'currency', label: 'Currency', fr: 'Devise', cat: 'PRICE', better: null },
  { key: 'depositPct', label: 'Deposit %', fr: 'Acompte %', cat: 'PAYMENT', better: 'lower' },
  { key: 'balancePct', label: 'Balance %', fr: 'Solde %', cat: 'PAYMENT', better: null },
  { key: 'paymentMethods', label: 'Payment methods', fr: 'Modes de paiement', cat: 'PAYMENT', better: null },
  { key: 'packaging', label: 'Packaging', fr: 'Emballage', cat: 'PACKAGING', better: null },
  { key: 'accessories', label: 'Included items', fr: 'Éléments inclus', cat: 'PACKAGING', better: null },
  { key: 'samplePrice', label: 'Sample price', fr: "Prix de l'échantillon", cat: 'SAMPLE', better: 'lower' },
  { key: 'sampleRefund', label: 'Sample refund', fr: 'Remboursement échantillon', cat: 'SAMPLE', better: null },
  { key: 'customization', label: 'Customisation', fr: 'Personnalisation', cat: 'CUSTOMIZATION', better: null },
  { key: 'material', label: 'Material', fr: 'Matière', cat: 'MATERIAL', better: null },
  { key: 'warranty', label: 'Warranty', fr: 'Garantie', cat: 'OTHER', better: null },
]);
const LEDGER_TERM = { 'quote.samplePrice': 'samplePrice', 'offer.packaging': 'packaging', 'offer.productionDays': 'productionDays', 'offer.customization': 'customization', 'offer.paymentMethods': 'paymentMethods', 'offer.sampleRefund': 'sampleRefund', 'offer.accessories': 'accessories', 'offer.warranty': 'warranty', 'spec.material': 'material' };

/** the terms carried by one quote object (the authoritative current-quote shape) */
function quoteTerms(q) {
  if (!q) return {};
  const tiers = normalizeTiers(q.tiers).map((t) => ({ minQty: t.minQty, unitPrice: t.unitPrice }));
  const qty = num(q.qty) ?? num(q.moq); const r = resolveUnitPrice(q, qty);
  return { currency: q.currency ?? null, unitPrice: q.unitPrice ?? null, tiers: tiers.length ? tiers : null, moq: num(q.moq), qty, priceAtQty: r.unitPrice === null ? null : String(r.unitPrice), incoterm: q.incoterm ?? null, port: q.port ?? null, leadDays: num(q.leadTimeDays), depositPct: q.payment?.depositPct ?? null, balancePct: q.payment?.balancePct ?? null };
}
const pairedQuoteEvents = (state) => {
  const evs = (state.events ?? []).filter((e) => e.type === 'QUOTE'); // each QUOTE event appended exactly one quote
  return evs.length === state.quotes.length ? evs : null;
};

/**
 * Revisions of the supplier's offer, oldest first. @returns {{ n:number, id:string, kind:'OFFER'|'FORM', offerId:string|null, at:string, quoteIndex:number, terms:object, label:string }[]}
 * A quote typed in the form is a revision of its own; an imported offer is a revision once at least one of its facts was reviewed into the case.
 */
export function offerRevisions(state) {
  const pairs = pairedQuoteEvents(state); const out = [];
  const offers = state.offers ?? []; const seqOf = new Map(offers.map((o) => [o.id, o.seq]));
  const lastQuoteIdxByOffer = new Map(); const formIdx = [];
  state.quotes.forEach((q, i) => { const ref = pairs?.[i]?.ref; if (ref?.offerId) lastQuoteIdxByOffer.set(ref.offerId, i); else if (!ref || !pairs) formIdx.push(i); });
  const used = (o) => state.ledger.filter((e) => e.offerId === o.id);
  for (const o of offers) {
    const entries = used(o); if (!entries.length) continue;
    const upto = state.ledger.filter((e) => e.offerId && (seqOf.get(e.offerId) ?? 0) <= o.seq);
    let quoteIndex = -1; for (const [oid, idx] of lastQuoteIdxByOffer) if ((seqOf.get(oid) ?? 0) <= o.seq && idx > quoteIndex) quoteIndex = idx;
    const terms = { ...quoteTerms(state.quotes[quoteIndex]) };
    const latest = {}; for (const e of upto) latest[e.key] = e; // the newest reviewed statement per key, up to this offer
    for (const [k, t] of Object.entries(LEDGER_TERM)) if (latest[k]) terms[t] = latest[k].value;
    for (const k of Object.keys(latest)) if (k.startsWith('docClaim.')) (terms.certificates ??= []).push(k.slice(9));
    if (terms.certificates) terms.certificates = [...new Set(terms.certificates)].sort();
    const at = entries.map((e) => e.confirmedAt).sort().at(-1);
    out.push({ kind: 'OFFER', offerId: o.id, at, quoteIndex, terms, label: `offer ${o.seq}` });
  }
  for (const i of formIdx) out.push({ kind: 'FORM', offerId: null, at: state.quotes[i].at, quoteIndex: i, terms: quoteTerms(state.quotes[i]), label: 'quote form' });
  // ordered by what the case recorded (the quote list is append-only), never by a clock: a phone whose date is wrong must not reorder the supplier's offers
  const seqOf2 = new Map(offers.map((o) => [o.id, o.seq]));
  out.sort((a, b) => a.quoteIndex - b.quoteIndex || (a.kind === b.kind ? 0 : a.kind === 'OFFER' ? -1 : 1) || (seqOf2.get(a.offerId) ?? 0) - (seqOf2.get(b.offerId) ?? 0));
  return out.map((r, i) => ({ ...r, n: i + 1, id: `rev-${state.id}-${i + 1}` }));
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const show = (key, v) => {
  if (v === null || v === undefined) return null;
  if (key === 'tiers') return v.map((t) => `${t.minQty}+ = ${t.unitPrice}`).join(' / ');
  if (key === 'moq') return `${v} pcs`; if (key === 'leadDays' || key === 'productionDays') return `${v} d`;
  if (key === 'depositPct' || key === 'balancePct') return `${v} %`; if (Array.isArray(v)) return v.join(', ');
  return String(v);
};
/** deterministic diff of two term sets. UNKNOWN -> value is ADDED (new information, not a "change" of the offer); value -> UNKNOWN is REMOVED (the statement was withdrawn: said out loud). */
export function termsDiff(a, b, { cur = null } = {}) {
  const out = [];
  for (const t of TERMS) {
    if (t.key === 'priceAtQty' && !same(a.tiers, b.tiers) && a.priceAtQty === b.priceAtQty && a.qty === b.qty) continue;
    const x = a[t.key] ?? null; const y = b[t.key] ?? null; if (same(x, y)) continue;
    const kind = x === null ? 'ADDED' : y === null ? 'REMOVED' : 'CHANGED';
    let direction = 'NEUTRAL';
    if (kind === 'CHANGED' && t.better) { const nx = num(x); const ny = num(y); if (nx !== null && ny !== null && nx !== ny) direction = (ny < nx) === (t.better === 'lower') ? 'BETTER' : 'WORSE'; }
    const delta = kind === 'CHANGED' && num(x) !== null && num(y) !== null ? Math.round((num(y) - num(x)) * 1e6) / 1e6 : null;
    out.push({ field: t.key, category: t.cat, label: t.label, labelFr: t.fr, kind, from: x, to: y, fromText: show(t.key, x), toText: show(t.key, y), direction, delta, ...(t.key === 'priceAtQty' && cur ? { currency: cur } : {}) });
  }
  return out;
}

export const stateAtRevision = (state, rev) => ({ ...state, quotes: state.quotes.slice(0, rev.quoteIndex + 1) });

/** The sourcing recommendation of ONE case read on its own (the same rules the comparison applies: BLOCKED -> PASS; the only viable offer with a concluded assessment -> BUY_CANDIDATE; else INVESTIGATE). Pending approval, always. */
export function recommendationOf(state, a) {
  const cells = cellsOf({ state }, a); const r = roleOf(a, cells);
  const value = r.role === ROLE.BLOCKED ? RECOMMENDATION.PASS : r.role === ROLE.VIABLE && a.decision.verdict !== 'INSUFFICIENT_INFORMATION' ? RECOMMENDATION.BUY_CANDIDATE : RECOMMENDATION.INVESTIGATE;
  return { value, role: r.role, why: r.why, verdict: a.decision.verdict, status: 'RECOMMENDATION_PENDING_APPROVAL', businessDecision: 'NOT_DECIDED', requiresMerchantApproval: true, canCommitMoney: false };
}
const landedOf = (a) => { const m = a.landed?.totals?.landedPerUnitEurMinor; return m === null || m === undefined || a.landed.status === 'INFORMATION_INSUFFICIENT' ? null : { perUnitEurMinor: m, isLowerBound: a.landed.isLowerBound === true, display: `${fmt(m, 'EUR')}${a.landed.isLowerBound ? ' (lower bound)' : ''}` }; };

/**
 * WHAT CHANGED between two revisions (default: the last two). Landed cost and recommendation are RECOMPUTED for each revision from the case as it stood then
 * (older quotes only), unless the caller passes the recommendation that was actually recorded at the time (`recorded`).
 */
export function whatChanged(state, { fromRev = null, toRev = null, now = new Date(), externals = {}, recorded = null } = {}) {
  const revs = offerRevisions(state);
  if (revs.length < 2) return { available: false, revisionCount: revs.length, reason: revs.length ? 'only one revision of the offer: nothing to compare yet' : 'no revision of the offer yet', changes: [], from: null, to: revs[0] ? { n: revs[0].n, at: revs[0].at } : null };
  const to = toRev ? revs.find((r) => r.n === toRev) : revs.at(-1); const from = fromRev ? revs.find((r) => r.n === fromRev) : revs[revs.indexOf(to) - 1];
  if (!from || !to) throw new Error('unknown revision');
  const changes = termsDiff(from.terms, to.terms, { cur: to.terms.currency ?? from.terms.currency });
  const aFrom = assess(stateAtRevision(state, from), { now, externals }); const aTo = assess(stateAtRevision(state, to), { now, externals });
  const lf = landedOf(aFrom); const lt = landedOf(aTo);
  const landed = { from: lf, to: lt, change: lf && lt ? lt.perUnitEurMinor - lf.perUnitEurMinor : null, direction: lf && lt ? (lt.perUnitEurMinor === lf.perUnitEurMinor ? 'NEUTRAL' : lt.perUnitEurMinor < lf.perUnitEurMinor ? 'BETTER' : 'WORSE') : 'UNKNOWN', note: lf && lt ? null : 'landed cost is UNKNOWN for at least one of the two revisions: nothing is compared' };
  const rf = recorded?.from ?? recommendationOf(stateAtRevision(state, from), aFrom); const rt = recorded?.to ?? recommendationOf(stateAtRevision(state, to), aTo);
  const maxF = aFrom.maxPurchasePrice?.maxUnitPriceMinor ?? null; const maxT = aTo.maxPurchasePrice?.maxUnitPriceMinor ?? null;
  return { available: true, revisionCount: revs.length, from: { n: from.n, at: from.at, offerId: from.offerId, kind: from.kind }, to: { n: to.n, at: to.at, offerId: to.offerId, kind: to.kind }, changes,
    landed, maxPurchasePrice: { from: maxF, to: maxT }, recommendation: { from: rf.value, to: rt.value, changed: rf.value !== rt.value, fromWhy: rf.why, toWhy: rt.why, source: recorded ? 'RECORDED' : 'RECOMPUTED_FROM_THE_CASE_AS_IT_STOOD' }, verdict: { from: aFrom.decision.verdict, to: aTo.decision.verdict },
    summary: changes.length ? changes.map((c) => `${c.label}: ${c.fromText ?? 'unknown'} -> ${c.toText ?? 'unknown'}`).join('; ') : 'no term changed', previousPreserved: true };
}

/** how often the supplier moved a term across revisions (behaviour memory input): { field, times, values[] } */
export function movementOf(state) {
  const revs = offerRevisions(state); const m = new Map();
  for (let i = 1; i < revs.length; i += 1) for (const c of termsDiff(revs[i - 1].terms, revs[i].terms)) if (c.kind === 'CHANGED') { const e = m.get(c.field) ?? { field: c.field, label: c.label, times: 0, values: [c.from] }; e.times += 1; e.values.push(c.to); m.set(c.field, e); }
  return [...m.values()];
}
