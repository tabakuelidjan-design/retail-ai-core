// NEGOTIATION COACH. Nordla does not negotiate: it prepares the next move. Every target is traceable to a number the owner entered or the economics produced; every lever to a gap in the offer.
// Targets: the walk-away is the MAXIMUM PURCHASE PRICE of the economics engine; the opening target is a merchant-configured step below it. With no maximum price there is NO target:
// the plan says INSUFFICIENT_DATA_FOR_NEGOTIATION_TARGET and lists what is missing. Nothing predicts what a supplier will accept.
import { offerRevisions, termsDiff } from './revisions.js';

export const NO_TARGET = 'INSUFFICIENT_DATA_FOR_NEGOTIATION_TARGET';
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const latest = (state, key) => state.ledger.filter((e) => e.key === key).at(-1) ?? null;
// the order in which levers are used when the price is refused: the more it moves the landed cost or the risk, the earlier
const WEIGHT = { PRICE: 100, TIER: 90, DOCUMENTS: 85, INCOTERM: 80, MOQ: 75, LEAD_TIME_HELD: 70, SAMPLE_COST: 60, PAYMENT: 55, PACKAGING: 40, CUSTOMIZATION: 35, ACCESSORIES: 20 };

const lever = (dimension, ask, why, extra = {}) => ({ dimension, weight: WEIGHT[dimension] ?? 10, ask, askFr: extra.askFr ?? null, why, current: extra.current ?? null, desired: extra.desired ?? null, basis: extra.basis ?? null, questionId: extra.questionId ?? null, en: extra.en ?? null, zh: extra.zh ?? null, zhNote: extra.zh ? null : 'No Chinese sentence exists for this ask yet: none is invented.' });

/**
 * @param {{ state: object, a: object, deal: object, profile?: object|null, questions?: object[] }} ctx  (`deal` = dealIntelligence(state, a))
 * @returns the plan: current offer, target, walk-away, what to ask now, what to trade if the price is refused
 */
export function negotiationPlan({ state, a, deal, profile = null, questions = [] }) {
  const q = state.quotes.at(-1) ?? null; const qs = new Map((a.questions ?? []).map((x) => [x.id, x])); const cur = deal.quoted.currency;
  const current = { unitPrice: deal.quoted.unitPrice, currency: cur, atQty: deal.quoted.atQty, tiers: deal.quoted.tiers, moq: deal.quoted.moq, incoterm: deal.quoted.incoterm, leadDays: num(q?.leadTimeDays), productionDays: latest(state, 'offer.productionDays')?.value ?? null, depositPct: num(q?.payment?.depositPct), samplePrice: latest(state, 'quote.samplePrice')?.value ?? null, sampleRefund: latest(state, 'offer.sampleRefund')?.value ?? null, packaging: latest(state, 'offer.packaging')?.value ?? null, customization: latest(state, 'offer.customization')?.value ?? null, accessories: latest(state, 'offer.accessories')?.value ?? null };
  const max = deal.maxPurchasePrice; const target = deal.targetPurchasePrice;
  const missing = [];
  if (max.minor === null) {
    if (!state.sale?.sellingPriceGross) missing.push('selling price (VAT included)');
    if (state.sale?.targetContributionPct === null || state.sale?.targetContributionPct === undefined) missing.push('target margin');
    if (deal.landed.status === 'UNKNOWN' || /CRITICAL_COST_UNKNOWN/.test(String(max.reason ?? ''))) missing.push('landed-cost inputs (freight, duty, FX)');
    if (!missing.length) missing.push(String(max.reason ?? 'maximum purchase price'));
  }
  const walkAway = max.minor === null ? { status: NO_TARGET, reason: max.reason ?? 'no maximum purchase price', missing } : { status: max.status, minor: max.minor, currency: max.currency, display: max.display, basis: max.status === 'UPPER_BOUND' ? 'maximum purchase price from the economics engine (an UPPER BOUND: some costs are not entered)' : 'maximum purchase price from the economics engine' };
  const opening = max.minor === null ? { status: NO_TARGET, reason: 'no walk-away price to derive a target from', missing } : target.status === 'CONFIGURED_STEP' ? { status: 'CONFIGURED_STEP', minor: target.minor, currency: target.currency, display: target.display, basis: target.basis } : { status: NO_TARGET, reason: target.reason, missing: ['merchant setting: how far below the maximum to open'] };

  const levers = [];
  const unitMinor = deal.quoted.status === 'SUPPLIER_CLAIM' && cur && max.currency === cur ? Math.round(Number(deal.quoted.unitPrice) * 100) : null;
  // PRICE
  if (deal.quoted.status !== 'SUPPLIER_CLAIM') levers.push(lever('PRICE', 'Get a clear unit price for your quantity first.', 'there is no usable unit price on record', { questionId: 'price', en: qs.get('price')?.en ?? null, zh: qs.get('price')?.zh ?? null, basis: 'no quote' }));
  else if (unitMinor !== null && max.minor !== null && unitMinor > max.minor) levers.push(lever('PRICE', `The quote (${deal.quoted.unitPrice} ${cur}) is above your walk-away (${walkAway.display}): do not accept this price.`, `above the maximum purchase price by ${(unitMinor - max.minor) / 100} ${cur}`, { current: deal.quoted.unitPrice, desired: opening.status === 'CONFIGURED_STEP' ? opening.display : walkAway.display, basis: walkAway.basis }));
  else if (unitMinor !== null && opening.status === 'CONFIGURED_STEP' && unitMinor > opening.minor) levers.push(lever('PRICE', `Ask for ${opening.display} (the quote is ${deal.quoted.unitPrice} ${cur}); your limit is ${walkAway.display}.`, `${(unitMinor - opening.minor) / 100} ${cur} above the opening target, ${(max.minor - unitMinor) / 100} ${cur} below the limit`, { current: deal.quoted.unitPrice, desired: opening.display, basis: opening.basis }));
  else if (unitMinor !== null && opening.status === 'CONFIGURED_STEP') levers.push(lever('PRICE', 'The price is already at or below your opening target: do not spend effort on price, secure the other terms.', 'quote at or below the target', { current: deal.quoted.unitPrice, desired: opening.display, basis: opening.basis }));
  else if (unitMinor !== null && max.minor !== null) levers.push(lever('PRICE', `You can accept up to ${walkAway.display}; the quote is ${deal.quoted.unitPrice} ${cur}. Nordla has no opening target configured.`, 'inside the limit; no target step configured', { current: deal.quoted.unitPrice, desired: null, basis: walkAway.basis }));
  // TIER: the next tier above the planned quantity, only when its price is inside the limit
  const bps = deal.breakpoints ?? []; const qty = deal.quoted.atQty; const next = qty !== null ? bps.find((b) => b.minQty > qty) : null;
  if (next && next.withinMaxPrice !== false) levers.push(lever('TIER', `A higher quantity reaches the next price tier: ${next.minQty} pcs at ${next.unitPrice} ${next.currency}.`, next.cashTotalEurMinor !== null ? `landed cost per unit ${next.landedPerUnitEurMinor !== null ? (next.landedPerUnitEurMinor / 100).toFixed(2) : '?'} EUR, cash needed ${(next.cashTotalEurMinor / 100).toFixed(2)} EUR` : 'cash impact not computable yet', { current: String(qty), desired: String(next.minQty), basis: 'supplier price tiers' }));
  // DOCUMENTS before deposit (the engine's own list)
  const docs = a.negotiation?.documentsBeforeDeposit ?? []; if (docs.length) levers.push(lever('DOCUMENTS', `Do not pay a deposit before you hold: ${docs.slice(0, 4).join('; ')}.`, 'required evidence is missing for the rules that apply', { basis: 'regulatory assessment (decision support)', questionId: (a.questions ?? []).find((x) => x.docType)?.id ?? null, en: (a.questions ?? []).find((x) => x.docType)?.en ?? null, zh: (a.questions ?? []).find((x) => x.docType)?.zh ?? null }));
  // INCOTERM
  if (!current.incoterm) levers.push(lever('INCOTERM', 'Get the Incoterm and the port in writing.', 'without it the landed cost cannot be completed', { questionId: 'incoterm', en: qs.get('incoterm')?.en ?? null, zh: qs.get('incoterm')?.zh ?? null, basis: 'no Incoterm on record' }));
  else if (current.incoterm === 'EXW') levers.push(lever('INCOTERM', 'The price is EXW: ask for an FOB price too, so origin charges are visible and offers are comparable.', 'EXW leaves origin charges and loading to you', { current: 'EXW', desired: 'FOB', basis: 'Incoterm table of the landed-cost engine' }));
  // MOQ: only against the quantity the OWNER plans
  const planned = num(q?.qty); if (current.moq !== null && planned !== null && planned < current.moq) levers.push(lever('MOQ', `The MOQ is ${current.moq} pcs but you plan ${planned}: ask whether ${planned} pcs is possible (at the same or a close price).`, 'MOQ above the planned quantity', { current: String(current.moq), desired: String(planned), basis: 'your planned quantity' }));
  else if (current.moq === null) levers.push(lever('MOQ', 'Ask the minimum order quantity.', 'MOQ not stated', { questionId: 'price', en: qs.get('price')?.en ?? null, zh: qs.get('price')?.zh ?? null, basis: 'no MOQ on record' }));
  // LEAD TIME held / unknown
  const revs = offerRevisions(state); const last = revs.at(-1); const prev = revs.at(-2); const moved = last && prev ? termsDiff(prev.terms, last.terms).find((c) => c.field === 'leadDays' && c.kind === 'CHANGED' && c.direction === 'WORSE') : null;
  if (moved) levers.push(lever('LEAD_TIME_HELD', `The lead time moved from ${moved.from} to ${moved.to} days between two offers: ask to keep ${moved.from} days.`, 'the supplier lengthened the lead time', { current: String(moved.to), desired: String(moved.from), basis: `offer ${prev.n} -> offer ${last.n}` }));
  else if (current.leadDays === null && current.productionDays === null) levers.push(lever('LEAD_TIME_HELD', 'Ask the production lead time and the payment terms.', 'lead time not stated', { questionId: 'lead_time', en: qs.get('lead_time')?.en ?? null, zh: qs.get('lead_time')?.zh ?? null, basis: 'no lead time on record' }));
  // SAMPLE
  const sp = num(current.samplePrice);
  if (sp !== null && sp > 0 && current.sampleRefund !== 'REFUNDABLE') levers.push(lever('SAMPLE_COST', `The sample costs ${current.samplePrice} ${cur ?? ''}: ask to have it deducted from the first order.`.replace('  ', ' '), current.sampleRefund === 'NOT_REFUNDABLE' ? 'the supplier said it is not refundable' : 'refund not mentioned', { current: `${current.samplePrice} ${cur ?? ''}`.trim(), desired: 'refundable on the first order', basis: 'sample price in the offer' }));
  else if (sp === null) levers.push(lever('SAMPLE_COST', 'Ask whether a sample is possible, its cost and its lead time.', 'sample terms not stated', { questionId: 'sample', en: qs.get('sample')?.en ?? null, zh: qs.get('sample')?.zh ?? null, basis: 'no sample price on record' }));
  // PAYMENT
  if (current.depositPct === null) levers.push(lever('PAYMENT', 'Ask the payment terms (deposit and balance).', 'payment terms not stated', { questionId: 'lead_time', en: qs.get('lead_time')?.en ?? null, zh: qs.get('lead_time')?.zh ?? null, basis: 'no deposit on record' }));
  // PACKAGING / CUSTOMIZATION / ACCESSORIES: asked only when the offer is silent
  if (!current.packaging) levers.push(lever('PACKAGING', 'Ask how the product is packed and what packaging is included in the price.', 'packaging not stated', { basis: 'no packaging on record' }));
  if (!current.customization) levers.push(lever('CUSTOMIZATION', 'Ask whether it can be supplied blank or with your logo, and at which MOQ and extra cost.', 'customisation not stated', { basis: 'no customisation on record' }));
  levers.sort((x, y) => y.weight - x.weight || x.dimension.localeCompare(y.dimension));

  // what to trade when the price is refused: the non-price levers that exist, in weight order, plus the volume lever if a tier is within the limit
  const ifPriceRefused = levers.filter((l) => l.dimension !== 'PRICE' && l.dimension !== 'DOCUMENTS').slice(0, 3).map((l) => ({ dimension: l.dimension, ask: l.ask, why: l.why, basis: l.basis }));
  const priceLever = levers.find((l) => l.dimension === 'PRICE');
  const status = deal.quoted.status !== 'SUPPLIER_CLAIM' || max.minor === null ? NO_TARGET : 'READY';
  const now = levers.filter((l) => l.dimension !== 'TIER' || next).slice(0, 5);
  return { type: 'NegotiationPlan', caseId: state.id, status, currentOffer: current, target: opening, walkAway, askNow: now, ifPriceRefused, priceGuidance: priceLever?.ask ?? null,
    missingForTarget: status === NO_TARGET ? (missing.length ? missing : ['a usable unit price']) : [], noForecast: 'Nordla does not predict what the supplier will accept: targets are arithmetic from your own numbers, not a market forecast.', autonomous: false };
}
