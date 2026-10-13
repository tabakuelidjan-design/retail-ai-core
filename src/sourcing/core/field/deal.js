// DEAL INTELLIGENCE. What an offer means in money, from the economics the case already has. Nothing is guessed: customs, VAT, freight and fees come only from what the owner entered (or an
// official lookup that says so); a missing cost makes the figure a LOWER BOUND or UNKNOWN, never a number. Pure and deterministic.
import { assess, economicsScenario } from '../case.js';
import { INCOTERMS } from '../landed.js';
import { resolveUnitPrice, normalizeTiers, effectiveQuote } from '../offers.js';
import { fmt } from '../money.js';

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const SUPPLIER_PAYS = { originCharges: 'origin charges (export clearance, loading)', mainFreight: 'main freight', insurance: 'insurance', importDuties: 'import duties' };

/** What the Incoterm puts on the supplier / on you, in the simplification the landed-cost engine uses (not a contract interpretation). */
export function incotermEffect(incoterm, unknownComponents = []) {
  if (!incoterm) return { incoterm: null, status: 'UNKNOWN', supplierCovers: null, youPay: null, unknownCostComponents: unknownComponents, text: 'No Incoterm on record: it is not known which costs the price already includes. The landed cost is incomplete.' };
  const t = INCOTERMS[incoterm]; if (!t) return { incoterm, status: 'UNKNOWN', supplierCovers: null, youPay: null, unknownCostComponents: unknownComponents, text: `${incoterm} is not an Incoterm the landed-cost engine supports.` };
  // in the engine's table a flag set to true means the cost is already INSIDE the supplier's price (landed-cost lines are then not added again)
  const supplierCovers = Object.entries(SUPPLIER_PAYS).filter(([k]) => t[k] === true).map(([, v]) => v); const buyerBears = Object.entries(SUPPLIER_PAYS).filter(([k]) => t[k] !== true).map(([, v]) => v);
  return { incoterm, status: 'KNOWN', supplierCovers, youPay: buyerBears, unknownCostComponents: unknownComponents, text: `${incoterm}: the price already covers ${supplierCovers.length ? supplierCovers.join(', ') : 'nothing beyond the goods'}; you pay ${buyerBears.length ? buyerBears.join(', ') : 'nothing more at this stage'}.` };
}

/** price tiers + the MOQ as ordering points, each priced with the real landed-cost and economics functions (a tier is only as good as the costs entered) */
function breakpoints(state, a, qty) {
  const q = state.quotes.at(-1) ?? null; if (!q) return [];
  const tiers = normalizeTiers(q.tiers); const points = tiers.length ? tiers.map((t) => ({ minQty: t.min, unitPrice: t.unitPrice, source: 'TIER' })) : (num(q.moq) !== null && q.unitPrice ? [{ minQty: num(q.moq), unitPrice: String(q.unitPrice), source: 'QUOTE_AT_MOQ' }] : []);
  const maxMinor = a.maxPurchasePrice?.maxUnitPriceMinor ?? null; const cur = q.currency ?? 'USD';
  return points.map((p, i) => {
    const sc = economicsScenario(state, { tiers: null, unitPrice: p.unitPrice, qty: p.minQty }); const landed = sc.landed.status === 'INFORMATION_INSUFFICIENT' ? null : sc.landed;
    const per = landed?.totals?.landedPerUnitEurMinor ?? null; const total = landed?.totals?.landedTotalEurMinor ?? null;
    const unitMinor = Math.round(Number(p.unitPrice) * 100);
    return { minQty: p.minQty, maxQty: tiers[i + 1] ? tiers[i + 1].min - 1 : null, unitPrice: p.unitPrice, currency: cur, source: p.source, landedPerUnitEurMinor: per, landedIsLowerBound: landed?.isLowerBound === true, cashTotalEurMinor: total, marginPct: sc.economics.contributionPct ?? null, marginIsUpperBound: sc.economics.contributionIsUpperBound === true, classification: sc.economics.classification, withinMaxPrice: maxMinor !== null && Number.isFinite(unitMinor) ? unitMinor <= maxMinor : null, status: per === null ? 'UNKNOWN' : landed.isLowerBound ? 'LOWER_BOUND' : 'ESTIMATED', plannedQty: qty };
  });
}

/**
 * @param {object} state the case @param {object} a its assessment @param {{ profile?: object|null }} opts
 */
export function dealIntelligence(state, a, { profile = null } = {}) {
  const q = state.quotes.at(-1) ?? null; const cur = q?.currency ?? null; const eq = q ? effectiveQuote(q) : null; const qty = q ? (num(q.qty) ?? num(q.moq)) : null; const r = q ? resolveUnitPrice(q, qty) : { unitPrice: null, source: 'NONE' };
  const quoted = q ? { status: r.unitPrice === null ? 'UNKNOWN' : 'SUPPLIER_CLAIM', unitPrice: r.unitPrice, currency: cur, atQty: qty, source: r.source, tiers: normalizeTiers(q.tiers).map((t) => ({ minQty: t.minQty, unitPrice: t.unitPrice })), moq: num(q.moq), incoterm: q.incoterm ?? null, port: q.port ?? null, reason: r.reason ?? null } : { status: 'UNKNOWN', unitPrice: null, currency: null, atQty: null, source: 'NONE', tiers: [], moq: null, incoterm: null, port: null, reason: 'no quote' };
  const L = a.landed; const known = L && L.status !== 'INFORMATION_INSUFFICIENT';
  const landed = known ? { status: L.status, perUnitEurMinor: L.totals.landedPerUnitEurMinor, totalEurMinor: L.totals.landedTotalEurMinor ?? null, isLowerBound: L.isLowerBound === true, display: `${fmt(L.totals.landedPerUnitEurMinor, 'EUR')}${L.isLowerBound ? ' (LOWER BOUND)' : ''}`, unknownCostComponents: (L.unknownCostComponents ?? []).map((u) => String(u).replace(/^costs\./, '')) } : { status: 'UNKNOWN', perUnitEurMinor: null, totalEurMinor: null, isLowerBound: false, display: null, unknownCostComponents: L?.criticalUnknown ?? [], reason: `cannot be calculated: missing ${(L?.criticalUnknown ?? []).join(', ') || 'inputs'}` };
  const mp = a.maxPurchasePrice; const max = mp?.maxUnitPriceMinor !== undefined && mp?.maxUnitPriceMinor !== null ? { status: mp.upperBound || mp.status === 'UPPER_BOUND' ? 'UPPER_BOUND' : 'CALCULATED', minor: mp.maxUnitPriceMinor, currency: mp.currency ?? cur, display: fmt(mp.maxUnitPriceMinor, mp.currency ?? cur ?? 'EUR') } : { status: 'UNKNOWN', minor: null, currency: cur, display: null, reason: mp?.reason ?? 'not computable yet' };
  const step = num(profile?.negotiation?.targetBelowMaxPct);
  const target = max.minor === null ? { status: 'UNKNOWN', minor: null, reason: 'no maximum purchase price yet' } : step === null ? { status: 'NOT_CONFIGURED', minor: null, reason: 'the merchant has not configured how far below the maximum to open (negotiation.targetBelowMaxPct)' } : { status: 'CONFIGURED_STEP', minor: Math.round(max.minor * (1 - step / 100)), currency: max.currency, display: fmt(Math.round(max.minor * (1 - step / 100)), max.currency ?? 'EUR'), basis: `${step}% below the maximum purchase price (merchant setting)` };
  const e = a.economics; const floor = num(profile?.margin?.minContributionPct);
  const margin = { status: e?.contributionPct === null || e?.contributionPct === undefined ? 'UNKNOWN' : e.contributionIsUpperBound ? 'UPPER_BOUND' : 'ESTIMATED', pct: e?.contributionPct ?? null, classification: e?.classification ?? 'UNKNOWN', targetPct: e?.targetContributionPct ?? null, minAcceptablePct: e?.targetContributionPct ?? floor, floorPct: floor, priceBasis: e?.priceBasis ?? null, reason: e?.reason ?? null };
  // cash: what has to be paid when ordering (goods, import costs known so far) and the deposit
  const goods = L?.goods?.totalEurMinor ?? null; const dep = num(q?.payment?.depositPct); const sample = state.ledger.filter((x) => x.key === 'quote.samplePrice').at(-1) ?? null;
  const fx = state.costs?.fx?.rate ? Number(state.costs.fx.rate) : null; const sampleMinor = sample ? Math.round(Number(sample.value) * 100) : null;
  const cash = { goodsEurMinor: goods, depositPct: dep, depositEurMinor: goods !== null && dep !== null ? Math.round((goods * dep) / 100) : null, importCostEurMinor: L?.totals?.importCostEurMinor ?? null, landedTotalEurMinor: known ? landed.totalEurMinor : null, status: goods === null ? 'UNKNOWN' : known && !landed.isLowerBound ? 'ESTIMATED' : 'LOWER_BOUND',
    sample: sample ? { status: 'SUPPLIER_CLAIM', amount: String(sample.value), currency: cur, eurMinor: cur === 'EUR' ? sampleMinor : fx && sampleMinor !== null ? Math.round(sampleMinor * fx) : null, refundable: state.ledger.filter((x) => x.key === 'offer.sampleRefund').at(-1)?.value ?? null } : { status: 'UNKNOWN', amount: null, currency: cur, eurMinor: null, refundable: null } };
  const inc = incotermEffect(q?.incoterm ?? null, landed.unknownCostComponents);
  const bps = breakpoints(state, a, qty);
  const insights = [];
  if (landed.isLowerBound) insights.push(`The landed cost is a LOWER BOUND: ${landed.unknownCostComponents.join(', ')} are not entered. The real cost is higher.`);
  if (max.status === 'UPPER_BOUND') insights.push('The maximum purchase price is an UPPER BOUND: some costs are not entered, the real maximum is lower.');
  if (quoted.status === 'SUPPLIER_CLAIM' && max.minor !== null && cur && max.currency === cur) { const qm = Math.round(Number(quoted.unitPrice) * 100); insights.push(qm <= max.minor ? `The quoted price (${quoted.unitPrice} ${cur}) is within the maximum purchase price (${max.display}).` : `The quoted price (${quoted.unitPrice} ${cur}) is ABOVE the maximum purchase price (${max.display}).`); }
  for (let i = 1; i < bps.length; i += 1) { const a0 = bps[i - 1]; const b0 = bps[i]; if (a0.landedPerUnitEurMinor !== null && b0.landedPerUnitEurMinor !== null && a0.cashTotalEurMinor !== null && b0.cashTotalEurMinor !== null) insights.push(`Going from ${a0.minQty} to ${b0.minQty} pcs lowers the landed cost per unit by ${fmt(a0.landedPerUnitEurMinor - b0.landedPerUnitEurMinor, 'EUR')} but raises the cash needed from ${fmt(a0.cashTotalEurMinor, 'EUR')} to ${fmt(b0.cashTotalEurMinor, 'EUR')}.`); }
  const unknown = []; if (quoted.status === 'UNKNOWN') unknown.push('unit price'); if (quoted.moq === null) unknown.push('MOQ'); if (!quoted.incoterm) unknown.push('Incoterm'); if (landed.status === 'UNKNOWN') unknown.push('landed cost'); if (max.status === 'UNKNOWN') unknown.push('maximum purchase price'); if (cash.sample.status === 'UNKNOWN') unknown.push('sample cost');
  return { type: 'DealIntelligence', caseId: state.id, quoted, landed, maxPurchasePrice: max, targetPurchasePrice: target, margin, cash, incotermEffect: inc, breakpoints: bps, insights, unknown, note: 'Customs, VAT, freight and fees are never guessed: only what was entered. A figure with a missing cost is a lower bound or UNKNOWN.' };
}

/**
 * Compares the deals of several cases. "Cheapest quote" and "best landed" are two different questions; when they have different answers the reason is spelled out
 * (an EXW price omits what an FOB price includes). Only deals in the same currency, with a known landed cost, are compared; a lower bound makes the answer PROVISIONAL.
 */
export function compareDeals(entries) {
  const rows = entries.map(({ caseId, name, deal }) => ({ caseId, name, deal, unit: deal.quoted.status === 'SUPPLIER_CLAIM' ? Number(deal.quoted.unitPrice) : null, cur: deal.quoted.currency, landed: deal.landed.perUnitEurMinor, lb: deal.landed.isLowerBound }));
  const priced = rows.filter((r) => r.unit !== null); const sameCur = priced.length > 0 && new Set(priced.map((r) => r.cur)).size === 1;
  const cheapest = sameCur ? priced.slice().sort((x, y) => x.unit - y.unit || x.caseId.localeCompare(y.caseId))[0] : null;
  const withLanded = rows.filter((r) => r.landed !== null); const bestLanded = withLanded.length ? withLanded.slice().sort((x, y) => x.landed - y.landed || x.caseId.localeCompare(y.caseId))[0] : null;
  const provisional = withLanded.length !== rows.length || withLanded.some((r) => r.lb);
  const out = { cheapestQuote: cheapest ? { caseId: cheapest.caseId, name: cheapest.name, unitPrice: cheapest.unit, currency: cheapest.cur, incoterm: cheapest.deal.quoted.incoterm } : null, bestLanded: bestLanded ? { caseId: bestLanded.caseId, name: bestLanded.name, perUnitEurMinor: bestLanded.landed, display: fmt(bestLanded.landed, 'EUR'), incoterm: bestLanded.deal.quoted.incoterm } : null, provisional, reasons: [], inversion: false,
    notComparable: [...rows.filter((r) => r.unit === null).map((r) => ({ caseId: r.caseId, why: 'no usable unit price' })), ...rows.filter((r) => r.landed === null).map((r) => ({ caseId: r.caseId, why: 'landed cost unknown' }))] };
  if (!sameCur && priced.length > 1) out.reasons.push('The quotes are in different currencies: unit prices are not compared with each other, only the landed cost in EUR.');
  if (provisional && withLanded.length) out.reasons.push(withLanded.length !== rows.length ? 'Some offers have no landed cost yet: the best landed cost among the others is PROVISIONAL.' : 'At least one landed cost is a lower bound: the ranking is PROVISIONAL.');
  if (cheapest && bestLanded && cheapest.caseId !== bestLanded.caseId) {
    out.inversion = true; const c = cheapest.deal; const b = bestLanded.deal; const ci = c.quoted.incoterm; const bi = b.quoted.incoterm;
    out.reasons.push(`${cheapest.name || cheapest.caseId} has the lowest quote (${cheapest.unit} ${cheapest.cur}${ci ? `, ${ci}` : ''}) but ${bestLanded.name || bestLanded.caseId} has the lowest landed cost (${out.bestLanded.display}${bi ? `, ${bi}` : ''}).`);
    if (ci && bi && ci !== bi) { const cc = INCOTERMS[ci]; const bc = INCOTERMS[bi]; const extra = Object.entries(SUPPLIER_PAYS).filter(([k]) => bc?.[k] === true && cc?.[k] !== true).map(([, v]) => v); if (extra.length) out.reasons.push(`${ci} excludes ${extra.join(', ')} that ${bi} already includes: the ${ci} price looks lower only until those costs are added.`); }
    else if (c.landed.unknownCostComponents.length) out.reasons.push(`For ${cheapest.name || cheapest.caseId} these costs are not entered yet (${c.landed.unknownCostComponents.join(', ')}).`);
  }
  return out;
}
