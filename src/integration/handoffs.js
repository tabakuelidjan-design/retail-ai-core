// Pure handoff builders: each takes the SOURCE module's own output and returns the contract the DESTINATION consumes. No I/O, no clock, no randomness
// (ids are content hashes). Nothing here creates a purchase, moves stock or publishes anything: it prepares, and says what is still missing.
import { createHash } from 'node:crypto';
import { MODULE as M, PROVENANCE as P, ID_KIND as K, ERR, fail, deepFreeze } from './constants.js';
import { makeFact } from './provenance.js';
import { validateApproval } from './approval.js';
import { ref } from './ids.js';

const hid = (prefix, body) => `${prefix}_${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)}`;
const BUYABLE = new Set(['GO', 'CONDITIONAL_GO']);

// ---------------------------------------------------------------- 1. Sourcing -> BUY_CANDIDATE (owner decision, integration-held)
/** A BUY_CANDIDATE is a sourcing verdict that allows buying AND a named human's approval. Sourcing alone never produces one (its verdict is advisory). */
export function markBuyCandidate({ tenant_id, case_state, assessment, approval, supplier_ref }) {
  const verdict = assessment?.decision?.verdict;
  const blockers = assessment?.decision?.hardBlockers ?? [];
  if (!BUYABLE.has(verdict) || blockers.length) fail(ERR.NOT_A_BUY_CANDIDATE, `sourcing verdict ${verdict ?? 'none'} (hard blockers: ${blockers.length}) does not allow a buy candidate`, { verdict, blockers });
  const case_ref = ref(K.SOURCING_CASE, case_state.id);
  const a = validateApproval(approval);
  if (!a.ok) fail(a.code, a.reason, { action: `${M.CHINA_SOURCING}.mark_buy_candidate` });
  if (approval.action !== `${M.CHINA_SOURCING}.mark_buy_candidate` || approval.subject_ref !== case_ref) fail(ERR.APPROVAL_REQUIRED, 'the approval does not name this action and this case', { expected: case_ref, got: approval.subject_ref });
  return deepFreeze({ case_ref, tenant_id, supplier_ref, verdict, conditions: assessment.decision.conditions ?? [], approval, state: 'BUY_CANDIDATE' });
}

// ---------------------------------------------------------------- 2. Sourcing -> Buying handoff
const quoteFacts = (quote, caseId) => {
  const f = (value, unit = null, currency = null) => makeFact({ value, provenance: P.SUPPLIER_CLAIM, source_module: M.CHINA_SOURCING, source_ref: `case:${caseId}#quote@${quote.at}`, unit, currency });
  return {
    unit_price: f(String(quote.unitPrice), 'unit', quote.currency), currency: f(quote.currency), moq: f(quote.moq ?? null, 'units'), qty: f(quote.qty ?? null, 'units'),
    incoterm: f(quote.incoterm ?? null), port: f(quote.port ?? null), lead_time_days: f(quote.leadTimeDays ?? null, 'days'), tiers: f(quote.tiers ?? []), payment_terms: f(quote.payment ?? null),
  };
};

export function buildBuyingHandoff({ tenant_id, case_state, assessment, buy_candidate }) {
  if (buy_candidate?.state !== 'BUY_CANDIDATE') fail(ERR.NOT_A_BUY_CANDIDATE, 'a Buying handoff needs an approved BUY_CANDIDATE');
  if (buy_candidate.tenant_id !== tenant_id) fail(ERR.TENANT_MISMATCH, 'buy candidate belongs to another tenant');
  const quote = case_state.quotes?.at(-1);
  if (!quote) fail(ERR.HANDOFF_INVALID, 'the case holds no quote: nothing to hand over');
  const documents = (case_state.documents ?? []).map((d) => ({ id: d.id, file_name: d.fileName, doc_type: d.docType, confirmed: Boolean(d.confirmed) }));
  const body = {
    tenant_id, source_module: M.CHINA_SOURCING, destination_module: M.BUYING,
    sourcing_case_ref: buy_candidate.case_ref, supplier_ref: buy_candidate.supplier_ref,
    supplier_claims: { name: makeFact({ value: case_state.supplier?.name ?? null, provenance: P.SUPPLIER_CLAIM, source_module: M.CHINA_SOURCING, source_ref: `case:${case_state.id}#supplier` }) },
    product: { ref: ref(K.PRODUCT, `prospect-${case_state.id}`), status: 'PROSPECT_NOT_IN_CATALOG', name: makeFact({ value: case_state.identity?.workingName ?? case_state.name ?? null, provenance: P.USER_PROVIDED, source_module: M.CHINA_SOURCING }) },
    quote: quoteFacts(quote, case_state.id),
    negotiation_history: (case_state.quotes ?? []).map((q) => ({ at: q.at, unit_price: String(q.unitPrice), currency: q.currency, moq: q.moq ?? null, incoterm: q.incoterm ?? null })),
    evidence: { verdict: buy_candidate.verdict, dimensions: assessment.decision.dimensions ?? null, data_mode: assessment.dataMode ?? null, as_of: assessment.asOf ?? null },
    risks: { conditions: assessment.decision.conditions ?? [], gaps: assessment.decision.gaps ?? [], contradictions: assessment.decision.contradictions ?? [] },
    documents,
    owner_approval: { state: 'APPROVED_AS_BUY_CANDIDATE', approver: buy_candidate.approval.approver, approved_at: buy_candidate.approval.approved_at },
    purchase_created: false, // a handoff is a preparation: never an order
  };
  return deepFreeze({ handoff_id: hid('bhf', { c: body.sourcing_case_ref, q: quote.at, t: tenant_id }), ...body });
}

// ---------------------------------------------------------------- 3. Buying handoff -> Finance request (units parsed from claims, never converted here)
/** What Finance needs, taken from the handoff and from the planner's own assumptions (each with provenance). Finance does the maths. */
export function financeRequestFromHandoff(handoff, { qty, freight_total, duty_rate_pct, other_costs_total, import_vat_rate_pct = '21', expected_selling_price_gross, selling_vat_rate_pct = '21', fx = null, cash_available_cents }) {
  const q = handoff.quote;
  const quantity = qty ?? q.qty.value ?? q.moq.value;
  if (!Number.isInteger(quantity) || quantity <= 0) fail(ERR.HANDOFF_INVALID, 'a quantity is needed (plan qty, quote qty or MOQ)');
  if (Number.isInteger(q.moq.value) && quantity < q.moq.value) fail(ERR.HANDOFF_INVALID, `planned quantity ${quantity} is below the supplier MOQ ${q.moq.value}`);
  const terms = q.payment_terms.value;
  return deepFreeze({
    supplier_unit_price: q.unit_price.value, currency: q.currency.value, qty: quantity, freight_total, other_costs_total, duty_rate_pct, import_vat_rate_pct,
    expected_selling_price_gross, selling_vat_rate_pct, fx: fx ?? undefined, cash_available_cents,
    payment_terms: terms ? { deposit_pct: String(terms.depositPct ?? 0), balance_pct: String(terms.balancePct ?? 0) } : undefined,
    provenance_of_inputs: { supplier_unit_price: q.unit_price.provenance, currency: q.currency.provenance, moq: q.moq.provenance, incoterm: q.incoterm.provenance, assumptions: 'freight, duty, other costs, selling price are planner inputs, not supplier facts' },
  });
}

// ---------------------------------------------------------------- 4. Purchase plan (Buying owns) and incoming expectation (Stock owns)
export function buildPurchasePlan({ tenant_id, handoff, finance_analysis, qty, destination, eta }) {
  if (finance_analysis?.status !== 'ANALYZED') fail(ERR.HANDOFF_INVALID, `Finance analysis is ${finance_analysis?.status ?? 'missing'}: no plan without a computed cash requirement`);
  if (!destination?.location_ref) fail(ERR.HANDOFF_INVALID, 'a destination (warehouse/store location) is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(eta ?? ''))) fail(ERR.HANDOFF_INVALID, 'an ETA date (YYYY-MM-DD) is required');
  const body = { tenant_id, handoff_id: handoff.handoff_id, qty, destination, eta, cash_requirement: finance_analysis.cash_requirement.total };
  return deepFreeze({
    purchase_ref: ref(K.PURCHASE, hid('pp', body)), ...body, status: 'PLANNED', owner_review: 'PENDING',
    supplier_ref: handoff.supplier_ref, product_ref: handoff.product.ref, sourcing_case_ref: handoff.sourcing_case_ref,
    unit_cost: makeFact({ value: handoff.quote.unit_price.value, provenance: handoff.quote.unit_price.provenance, source_module: M.CHINA_SOURCING, currency: handoff.quote.currency.value }),
    finance_analysis_version: finance_analysis.version, landed_cost_per_unit: finance_analysis.landed_cost.per_unit, order_placed: false,
  });
}

export function approvePurchasePlan(plan, approval) {
  if (plan.status !== 'PLANNED') fail(ERR.HANDOFF_INVALID, `plan is ${plan.status}`);
  const a = validateApproval(approval);
  if (!a.ok) fail(a.code, a.reason);
  if (approval.action !== `${M.BUYING}.approve_purchase_plan` || approval.subject_ref !== plan.purchase_ref) fail(ERR.APPROVAL_REQUIRED, 'the approval does not name this action and this plan');
  return deepFreeze({ ...plan, status: 'APPROVED_TO_ORDER', owner_review: 'APPROVED', approval, order_placed: false });
}

/** Stock's view of an approved purchase: EXPECTED goods. Never counted as available; becomes on-hand only through an approved receipt (not part of this phase). */
export function buildIncomingExpectation(plan) {
  if (plan.status !== 'APPROVED_TO_ORDER') fail(ERR.APPROVAL_REQUIRED, `a purchase plan that is ${plan.status} creates no incoming stock`);
  return deepFreeze({
    expectation_id: hid('inc', { p: plan.purchase_ref }), purchase_ref: plan.purchase_ref, product_ref: plan.product_ref, supplier_ref: plan.supplier_ref,
    qty: plan.qty, eta: plan.eta, destination: plan.destination, purchase_unit_cost: plan.unit_cost, state: 'EXPECTED', counted_in_available: false, received_qty: 0,
  });
}

/** Availability for claims: on-hand is what can be sold; incoming is shown beside it and never added. */
export function availabilityOf({ product_ref, on_hand, expectations = [] }) {
  const incoming = expectations.filter((e) => e.product_ref === product_ref && e.state === 'EXPECTED');
  return deepFreeze({
    product_ref, on_hand_available: Number.isInteger(on_hand) ? on_hand : null, on_hand_known: Number.isInteger(on_hand),
    incoming: incoming.map((e) => ({ expectation_id: e.expectation_id, qty: e.qty, eta: e.eta })),
    earliest_eta: incoming.map((e) => e.eta).sort()[0] ?? null,
  });
}

// ---------------------------------------------------------------- 5. Marketing claims vs Stock and Branding
export const CLAIM_KIND = Object.freeze({ AVAILABILITY: 'AVAILABILITY', PRICE: 'PRICE', DESCRIPTIVE: 'DESCRIPTIVE' });
export const AVAILABILITY_MODE = Object.freeze({ IN_STOCK: 'IN_STOCK', COMING_SOON: 'COMING_SOON' });

/** @returns {{ ok, verdicts: [{ref, verdict: 'SUPPORTED'|'BLOCKED'|'UNVERIFIABLE', reason}] }} */
export function checkClaimsAgainstStock({ claims, availability }) {
  const verdicts = claims.map((c) => {
    if (c.kind !== CLAIM_KIND.AVAILABILITY) return { ref: c.ref, verdict: 'SUPPORTED', reason: 'not an availability claim' };
    if (!availability.on_hand_known) return { ref: c.ref, verdict: 'UNVERIFIABLE', reason: 'stock is unknown: availability cannot be claimed' };
    if (c.mode === AVAILABILITY_MODE.IN_STOCK) {
      return availability.on_hand_available > 0 ? { ref: c.ref, verdict: 'SUPPORTED', reason: `${availability.on_hand_available} on hand` } : { ref: c.ref, verdict: 'BLOCKED', code: ERR.STOCK_CLAIM_UNSUPPORTED, reason: 'Stock says 0 on hand: incoming goods are not stock' };
    }
    if (c.mode === AVAILABILITY_MODE.COMING_SOON) {
      return availability.earliest_eta ? { ref: c.ref, verdict: 'SUPPORTED', reason: `expected ${availability.earliest_eta} (an expectation, not a guarantee)`, launch_date: availability.earliest_eta } : { ref: c.ref, verdict: 'BLOCKED', code: ERR.STOCK_CLAIM_UNSUPPORTED, reason: 'no incoming stock is recorded for this product' };
    }
    return { ref: c.ref, verdict: 'BLOCKED', code: ERR.STOCK_CLAIM_UNSUPPORTED, reason: `availability mode ${c.mode} is not supported` };
  });
  return deepFreeze({ ok: verdicts.every((v) => v.verdict === 'SUPPORTED'), verdicts });
}

/** Branding owns the approved-claim registry: a claim is usable only if its ref is registered with EXACTLY this wording. */
export function checkClaimsAgainstBrand({ claims, brand }) {
  const reg = new Map((brand.approved_claims ?? []).map((c) => [c.ref, c.wording]));
  const verdicts = claims.map((c) => (reg.has(c.ref) && reg.get(c.ref) === c.wording ? { ref: c.ref, verdict: 'APPROVED' } : { ref: c.ref, verdict: 'NOT_APPROVED', code: ERR.CLAIM_NOT_APPROVED, reason: reg.has(c.ref) ? 'wording differs from the approved wording' : 'claim is not in the approved registry' }));
  return deepFreeze({ ok: verdicts.every((v) => v.verdict === 'APPROVED'), verdicts });
}

// ---------------------------------------------------------------- 6. Campaign contract (Marketing owns) and its Creative projection
export function buildCampaignContract({ tenant_id, product_ref, brand, objective, audience, offer, channel, claims, availability }) {
  if (brand.tenant_id !== tenant_id) fail(ERR.TENANT_MISMATCH, 'brand profile belongs to another tenant');
  const body = { tenant_id, product_ref, brand_ref: brand.brand_ref, objective, audience, offer, channel, claim_refs: claims.map((c) => c.ref) };
  const stock = checkClaimsAgainstStock({ claims, availability });
  const brandCheck = checkClaimsAgainstBrand({ claims, brand });
  return deepFreeze({
    campaign_ref: ref(K.CAMPAIGN, hid('cmpn', body)), ...body, claims, availability_snapshot: availability,
    checks: { stock, brand: brandCheck }, ready_for_creative: stock.ok && brandCheck.ok, owner_review: 'PENDING', published: false,
  });
}

/** The projection Creative consumes. Only approved + stock-supported claims pass; anything else is refused here, before a single plate is drawn. */
export function creativeInputsFrom(contract, { base_brief, base_request }) {
  if (!contract.checks.brand.ok) fail(ERR.CLAIM_NOT_APPROVED, 'an unapproved claim cannot reach Creative', { verdicts: contract.checks.brand.verdicts.filter((v) => v.verdict !== 'APPROVED') });
  if (!contract.checks.stock.ok) fail(ERR.STOCK_CLAIM_UNSUPPORTED, 'a claim that Stock does not support cannot reach Creative', { verdicts: contract.checks.stock.verdicts.filter((v) => v.verdict !== 'SUPPORTED') });
  const claims = contract.claims.map((c) => ({ ref: c.ref, role: c.role ?? 'BODY', wording: c.wording }));
  return {
    brief: { ...base_brief, ids: { ...base_brief.ids, product_ref: `product://nordla/${contract.product_ref.split(':').slice(2).join(':')}` }, claims },
    request: { ...base_request, request_ref: `campaign:${contract.campaign_ref.split(':').slice(2).join(':')}` },
    campaign_ref: contract.campaign_ref,
  };
}

// ---------------------------------------------------------------- 7. Analytics tracking definition (read-only consumer of the above)
export function buildTrackingDefinition({ contract, creative_result }) {
  const body = { campaign_ref: contract.campaign_ref, product_ref: contract.product_ref, channel: contract.channel, creative_campaign_id: creative_result?.campaign_id ?? null, asset_ids: creative_result?.asset_id ? [creative_result.asset_id] : [] };
  return deepFreeze({
    tracking_id: hid('trk', body), ...body, claims: contract.claims.map((c) => ({ ref: c.ref, wording_sha: createHash('sha256').update(c.wording).digest('hex').slice(0, 12) })),
    measures: ['orders_attributed', 'units', 'net_sales', 'stock_on_hand_at_start'], source_of_truth: M.MARKETING, authoritative_for_operations: false, state: 'DEFINED_NOT_ACTIVE',
  });
}
