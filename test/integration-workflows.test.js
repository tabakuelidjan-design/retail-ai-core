// Nordla pre-China integration: the three cross-module workflows and the failure tests, over the REAL Sourcing engine, the REAL Finance memory store/service and the
// REAL Creative end-to-end pipeline (scripted fakes for the Brain / layer ports only). No provider call, no purchase, no payment, no stock mutation, no Shopify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import {
  MODULE as M, ID_KIND as K, ERR, createIntegration, routeUtterance, STATUS, handoffs, ref,
} from '../src/integration/index.js';
import { evaluateIntegrationReadiness } from '../src/integration/readiness.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial } from './sourcing-fixtures.js';
import { makeService, MERCHANT, MERCHANT_ACTOR } from './finance-fixtures.js';
import { e2eWorld } from './creative-e2e-world.js';

const TENANT = MERCHANT;
const NAME_A = 'Yiwu Greenline Housewares Co., Ltd';
const human = (action, subject_ref) => ({ action, subject_ref, approver: { kind: 'HUMAN', id: 'owner-1', role: 'OWNER' }, approved_at: '2026-10-14T10:00:00Z' });

function mkCase(id, supplier, unitPrice) {
  let c = newCase({ id, name: 'Bamboo kitchen organiser', now: NOW });
  for (const e of [...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, { type: 'SUPPLIER', supplier: { name: supplier } }, ...commercial({ unitPrice })]) c = dispatch(c, e, NOW);
  return c;
}
const externals = { safety: LIVE_CLEAN };
const BRAND = {
  tenant_id: TENANT, brand_ref: 'nordla:brand:habb',
  approved_claims: [
    { ref: 'claim://test/promise', wording: 'Coque personnalisée en 5 minutes' }, { ref: 'claim://test/price', wording: '25 €' },
    { ref: 'claim://nordla/instock', wording: 'Disponible maintenant' }, { ref: 'claim://nordla/soon', wording: 'Bientôt disponible' },
  ],
};
const claim = (r, kind, role, wording, mode) => ({ ref: r, kind, role, wording, ...(mode ? { mode } : {}) });

const fin = makeService();
let onHand = new Map(); // product_ref -> integer (the Stock/Sales reader)
let reads = 0;
const creativeWorld = () => e2eWorld({ assets: 1 });
const analyticsReads = [];
const nx = createIntegration({
  tenant_id: TENANT, finance: { store: fin.store, svc: fin.svc, merchantId: MERCHANT },
  readOnHand: (p) => { reads += 1; return onHand.get(p); }, brand: BRAND, creativeWorld,
  analytics: { explainChange: (a) => { analyticsReads.push(a); return { net_sales_change: 'read-only figure', period: a?.period ?? null }; }, read: () => ({}) },
  now: () => '2026-10-14T10:00:00.000Z',
});
const callA = (module, command, args, ctx = {}) => nx.call(module, command, args, { workflow_id: ctx.workflow_id ?? 'wf-china-to-store', initiated_by: 'owner-1', from: M.PARLE_A_NORDLA, ...ctx });

const caseA = mkCase('case-a', NAME_A, 4.2);
const caseB = mkCase('case-b', 'Dongguan Pioneer Plastics Ltd', 4.6);
let financeAnalysis; let supplier_ref; let handoff; let plan; let expectation; let contract; let creativeDraft;

// =========================================================================================== workflow 1: CHINA -> STORE
test('W1.1 supplier identity: Finance company + Sourcing name are ONE canonical supplier (no duplicate record)', async () => {
  const company = await fin.svc.saveCompany({ merchantId: MERCHANT, kind: 'supplier', name: NAME_A, vatNumber: 'CN9100234' }, MERCHANT_ACTOR);
  supplier_ref = nx.registry.link({ kind: K.SUPPLIER, canonical_id: 'sup-greenline', module: M.FINANCE, local_id: company.id, name: NAME_A, vat_number: 'CN9100234' });
  nx.registry.link({ kind: K.SUPPLIER, canonical_id: 'sup-greenline', module: M.CHINA_SOURCING, local_id: NAME_A, name: NAME_A });
  nx.registry.link({ kind: K.SUPPLIER, canonical_id: 'sup-pioneer', module: M.CHINA_SOURCING, local_id: 'Dongguan Pioneer Plastics Ltd', name: 'Dongguan Pioneer Plastics Ltd' });
  assert.equal(supplier_ref, 'nordla:supplier:sup-greenline');
  assert.equal(nx.registry.all(K.SUPPLIER).length, 2);
});

test('W1.2 SUPPLIER -> SOURCING CASE -> COMPARE: the real Sourcing deal comparison runs through the hub', async () => {
  const r = await callA(M.CHINA_SOURCING, 'compare', { cases: [caseA, caseB], externals, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.result.cheapestQuote.caseId, 'case-a');
  assert.ok(r.result.verdicts['case-a'] && r.result.verdicts['case-b']);
  const s = await callA(M.CHINA_SOURCING, 'summarize_case', { case_state: caseA, externals });
  assert.equal(s.result.case_ref, 'nordla:sourcing_case:case-a');
});

let assessment;
test('W1.3 BUY CANDIDATE needs a verdict that allows buying AND a named human approval; nothing is created without both', async () => {
  assessment = (await callA(M.CHINA_SOURCING, 'assess', { case_state: caseA, externals, now: NOW })).result;
  assert.equal(assessment.decision.verdict, 'GO');
  const caseRef = 'nordla:sourcing_case:case-a';
  // no approval at all
  const none = await callA(M.CHINA_SOURCING, 'mark_buy_candidate', { case_state: caseA, assessment, supplier_ref });
  assert.equal(none.status, 'APPROVAL_REQUIRED'); assert.equal(nx.store.buy_candidates.size, 0);
  // an approval for ANOTHER case does not count
  const wrong = await callA(M.CHINA_SOURCING, 'mark_buy_candidate', { case_state: caseA, assessment, supplier_ref, approval: human(`${M.CHINA_SOURCING}.mark_buy_candidate`, 'nordla:sourcing_case:case-b') }, { approvals: [human(`${M.CHINA_SOURCING}.mark_buy_candidate`, 'nordla:sourcing_case:case-b')], subject_ref: caseRef });
  assert.equal(wrong.status, 'APPROVAL_REQUIRED'); assert.equal(nx.store.buy_candidates.size, 0);
  // a machine "approval" does not count
  const machine = { ...human(`${M.CHINA_SOURCING}.mark_buy_candidate`, caseRef), approver: { kind: 'HUMAN', id: 'llm' } };
  assert.equal((await callA(M.CHINA_SOURCING, 'mark_buy_candidate', { case_state: caseA, assessment, supplier_ref, approval: machine }, { approvals: [machine], subject_ref: caseRef })).status, 'APPROVAL_REQUIRED');
  // a verdict that does not allow buying cannot be approved into a candidate (pure check)
  assert.throws(() => handoffs.markBuyCandidate({ tenant_id: TENANT, case_state: caseA, assessment: { decision: { verdict: 'NO_GO', hardBlockers: ['X'] } }, approval: human(`${M.CHINA_SOURCING}.mark_buy_candidate`, caseRef), supplier_ref }), (e) => e.code === ERR.NOT_A_BUY_CANDIDATE);
  const ok = human(`${M.CHINA_SOURCING}.mark_buy_candidate`, caseRef);
  const yes = await callA(M.CHINA_SOURCING, 'mark_buy_candidate', { case_state: caseA, assessment, supplier_ref, approval: ok }, { approvals: [ok], subject_ref: caseRef });
  assert.equal(yes.ok, true); assert.equal(yes.result.state, 'BUY_CANDIDATE'); assert.equal(nx.store.buy_candidates.size, 1);
});

test('W1.4 BUYING HANDOFF carries supplier, product, quote, MOQ, price, currency, incoterm, lead time, evidence, risks, documents, history, approval - and creates NO purchase', async () => {
  const bc = nx.store.buy_candidates.get('nordla:sourcing_case:case-a');
  const r = await callA(M.BUYING, 'prepare_handoff', { case_state: caseA, assessment, buy_candidate: bc });
  assert.equal(r.ok, true); handoff = r.result;
  assert.equal(handoff.supplier_ref, supplier_ref);
  assert.equal(handoff.supplier_claims.name.provenance, 'SUPPLIER_CLAIM');
  assert.equal(handoff.quote.unit_price.value, '4.2'); assert.equal(handoff.quote.unit_price.currency, 'USD'); assert.equal(handoff.quote.unit_price.provenance, 'SUPPLIER_CLAIM', 'a quote is a claim, not a verified fact');
  assert.equal(handoff.quote.moq.value, 500); assert.equal(handoff.quote.incoterm.value, 'FOB'); assert.equal(handoff.quote.lead_time_days.value, 20);
  assert.equal(handoff.evidence.verdict, 'GO'); assert.ok(Array.isArray(handoff.documents)); assert.equal(handoff.negotiation_history.length, 1);
  assert.equal(handoff.owner_approval.state, 'APPROVED_AS_BUY_CANDIDATE'); assert.equal(handoff.owner_approval.approver.id, 'owner-1');
  assert.equal(handoff.purchase_created, false); assert.equal(nx.store.purchase_plans.size, 0);
  assert.equal(handoff.product.status, 'PROSPECT_NOT_IN_CATALOG');
  // a handoff without an approved candidate is refused
  assert.throws(() => handoffs.buildBuyingHandoff({ tenant_id: TENANT, case_state: caseA, assessment, buy_candidate: { state: 'PROPOSED' } }), (e) => e.code === ERR.NOT_A_BUY_CANDIDATE);
  assert.throws(() => handoffs.buildBuyingHandoff({ tenant_id: 'other-tenant', case_state: caseA, assessment, buy_candidate: bc }), (e) => e.code === ERR.TENANT_MISMATCH);
});

const PLANNER = { qty: 1000, freight_total: '600', other_costs_total: '100', duty_rate_pct: '2.7', expected_selling_price_gross: '19.99' };
test('W1.5 FINANCE ANALYSIS: Sourcing says USD -> Finance refuses to convert silently (failure B); with the owner\'s rate it returns cash requirement, landed cost, margin, scenarios', async () => {
  const req = handoffs.financeRequestFromHandoff(handoff, PLANNER);
  assert.equal(req.currency, 'USD');
  const noFx = await callA(M.FINANCE, 'analyze_purchase', req);
  assert.equal(noFx.ok, true); assert.equal(noFx.result.status, 'CURRENCY_CONFLICT'); assert.equal(noFx.result.conflict.converted, false);
  const withFx = (await callA(M.FINANCE, 'analyze_purchase', { ...req, fx: { rate: '0.92', provenance: 'USER_PROVIDED' } })).result;
  assert.equal(withFx.status, 'ANALYZED'); assert.equal(withFx.fx.provenance, 'USER_PROVIDED');
  assert.ok(withFx.cash_requirement.total > withFx.landed_cost.total); assert.ok(withFx.margin.gross_margin_per_unit > 0); assert.equal(withFx.landed_cost.basis, 'ESTIMATED');
  assert.throws(() => handoffs.financeRequestFromHandoff(handoff, { ...PLANNER, qty: 100 }), (e) => e.code === ERR.HANDOFF_INVALID, 'below the supplier MOQ');
  const sc = (await callA(M.FINANCE, 'compare_scenarios', { base: { ...req, fx: { rate: '0.92', provenance: 'USER_PROVIDED' } }, scenarios: [{ qty: 500, label: 'MOQ' }, { qty: 1000, label: 'plan' }] })).result;
  assert.equal(sc.scenarios.length, 2); assert.equal(sc.by_axis.lowest_cash, 'MOQ');
  // Finance's number is the authority: it does NOT equal Sourcing's own advisory landed cost by construction, and the two are never silently merged
  assert.ok(assessment.landed.totals.landedPerUnitEurMinor > 0);
  financeAnalysis = withFx;
});

test('W1.6 PURCHASE PLAN: a plan is only a plan (REVIEW_REQUIRED); approving it needs the owner by name (failure E); no order is placed', async () => {
  const planned = await callA(M.BUYING, 'create_purchase_plan', { handoff, finance_analysis: financeAnalysis, qty: 1000, destination: { location_ref: 'location:namur-store' }, eta: '2026-12-05' });
  assert.equal(planned.status, 'REVIEW_REQUIRED'); plan = planned.result;
  assert.equal(plan.status, 'PLANNED'); assert.equal(plan.order_placed, false); assert.equal(plan.owner_review, 'PENDING');
  // no analysis => no plan
  const noAn = await callA(M.BUYING, 'create_purchase_plan', { handoff, finance_analysis: { status: 'CURRENCY_CONFLICT' }, qty: 1000, destination: { location_ref: 'l' }, eta: '2026-12-05' });
  assert.equal(noAn.status, 'BLOCKED');
  // E: purchase approval requested without owner approval
  const un = await callA(M.BUYING, 'approve_purchase_plan', { purchase_ref: plan.purchase_ref });
  assert.equal(un.status, 'APPROVAL_REQUIRED');
  assert.equal(nx.store.purchase_plans.get(plan.purchase_ref).status, 'PLANNED');
  // placing the order has no adapter command at all, and is approval-gated in the policy anyway
  assert.equal((await callA(M.BUYING, 'place_order', { purchase_ref: plan.purchase_ref })).status, 'APPROVAL_REQUIRED');
  assert.equal((await callA(M.FINANCE, 'pay_supplier', {})).status, 'APPROVAL_REQUIRED');
});

test('W1.7 INCOMING STOCK: nothing is expected before approval; after approval the goods are EXPECTED, never available, and on-hand does not move', async () => {
  const early = await callA(M.STOCK_SALES, 'expect_incoming', { purchase_ref: plan.purchase_ref });
  assert.equal(early.status, 'BLOCKED'); assert.equal(early.code, ERR.APPROVAL_REQUIRED); assert.equal(nx.store.incoming.size, 0);
  const a = human(`${M.BUYING}.approve_purchase_plan`, plan.purchase_ref);
  const ap = await callA(M.BUYING, 'approve_purchase_plan', { purchase_ref: plan.purchase_ref, approval: a }, { approvals: [a], subject_ref: plan.purchase_ref });
  assert.equal(ap.ok, true); assert.equal(ap.result.status, 'APPROVED_TO_ORDER'); assert.equal(ap.result.order_placed, false);
  const e = await callA(M.STOCK_SALES, 'expect_incoming', { purchase_ref: plan.purchase_ref });
  assert.equal(e.ok, true); expectation = e.result;
  assert.equal(expectation.state, 'EXPECTED'); assert.equal(expectation.counted_in_available, false); assert.equal(expectation.qty, 1000); assert.equal(expectation.eta, '2026-12-05');
  assert.equal(expectation.supplier_ref, supplier_ref); assert.equal(expectation.destination.location_ref, 'location:namur-store'); assert.equal(expectation.purchase_unit_cost.provenance, 'SUPPLIER_CLAIM');
  onHand.set(plan.product_ref, 0);
  const av = (await callA(M.STOCK_SALES, 'read_availability', { product_ref: plan.product_ref })).result;
  assert.equal(av.on_hand_available, 0, 'incoming goods are not stock'); assert.equal(av.incoming[0].qty, 1000); assert.equal(av.earliest_eta, '2026-12-05');
});

test('W1.8 MARKETING <-> STOCK <-> BRAND: "in stock" is refused while Stock says 0 (failure C); an unapproved claim never reaches Creative (failure D)', async () => {
  const product_ref = plan.product_ref;
  const base = { product_ref, objective: 'Faire connaître la nouvelle gamme', audience: 'Foyers belges', offer: 'Lancement', channel: 'SOCIAL_FEED' };
  const inStock = [claim('claim://nordla/instock', 'AVAILABILITY', 'CAPTION', 'Disponible maintenant', 'IN_STOCK')];
  const c1 = (await callA(M.MARKETING, 'build_campaign_contract', { ...base, claims: inStock })).result;
  assert.equal(c1.ready_for_creative, false); assert.equal(c1.checks.stock.verdicts[0].verdict, 'BLOCKED'); assert.equal(c1.checks.stock.verdicts[0].code, ERR.STOCK_CLAIM_UNSUPPORTED);
  const blocked = await callA(M.CREATIVE, 'produce_draft', { campaign_ref: c1.campaign_ref, run_id: 'run-wf1-blocked', at: '2026-10-14T10:00:00.000Z' });
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.code, ERR.STOCK_CLAIM_UNSUPPORTED);
  // D: a claim that Branding never approved (or with altered wording)
  const rogue = [claim('claim://nordla/best-ever', 'DESCRIPTIVE', 'CAPTION', 'Le meilleur du monde'), claim('claim://test/price', 'PRICE', 'PRICE', '24,90 €')];
  const c2 = (await callA(M.MARKETING, 'build_campaign_contract', { ...base, claims: rogue })).result;
  assert.equal(c2.checks.brand.ok, false); assert.deepEqual(c2.checks.brand.verdicts.map((v) => v.verdict), ['NOT_APPROVED', 'NOT_APPROVED']);
  const rogueRun = await callA(M.CREATIVE, 'produce_draft', { campaign_ref: c2.campaign_ref, run_id: 'run-wf1-rogue', at: '2026-10-14T10:00:00.000Z' });
  assert.equal(rogueRun.status, 'BLOCKED'); assert.equal(rogueRun.code, ERR.CLAIM_NOT_APPROVED);
  // BRANDING also answers directly
  const b = await callA(M.BRANDING, 'check_claims', { claims: rogue }); assert.equal(b.result.ok, false);
});

test('W1.9 -> OWNER REVIEW: with a supported, approved "coming soon" claim the real Creative pipeline produces a draft that stays PENDING owner review; no provider is used', async () => {
  const claims = [claim('claim://test/price', 'PRICE', 'PRICE', '25 €'), claim('claim://nordla/soon', 'AVAILABILITY', 'CAPTION', 'Bientôt disponible', 'COMING_SOON')];
  contract = (await callA(M.MARKETING, 'build_campaign_contract', { product_ref: plan.product_ref, objective: 'Annoncer l\'arrivée', audience: 'Foyers belges', offer: 'Pré-lancement', channel: 'SOCIAL_FEED', claims })).result;
  assert.equal(contract.ready_for_creative, true); assert.equal(contract.checks.stock.verdicts[1].launch_date, '2026-12-05'); assert.equal(contract.published, false);
  const r = await callA(M.CREATIVE, 'produce_draft', { campaign_ref: contract.campaign_ref, run_id: 'run-wf1-ok', at: '2026-10-14T10:00:00.000Z' });
  assert.equal(r.status, 'REVIEW_REQUIRED'); creativeDraft = r.result;
  assert.equal(creativeDraft.creative_state, 'NEEDS_OWNER_REVIEW'); assert.ok(creativeDraft.asset_id);
  assert.equal(creativeDraft.owner_approval, 'PENDING'); assert.equal(creativeDraft.live_provider, false);
  assert.equal(creativeDraft.campaign_ref, contract.campaign_ref);
  // the campaign contract has not been published and no activation adapter exists in the hub
  assert.equal((await callA(M.MARKETING, 'publish', {})).status, 'APPROVAL_REQUIRED');
  const pubOk = human(`${M.MARKETING}.publish`, contract.campaign_ref);
  assert.equal((await callA(M.MARKETING, 'publish', {}, { approvals: [pubOk], subject_ref: contract.campaign_ref })).status, 'COMMAND_NOT_AVAILABLE', 'even approved, nothing can publish in this phase: no adapter command exists');
  assert.equal((await callA(M.CREATIVE, 'call_live_provider', {})).status, 'BLOCKED', 'live providers are blocked by policy in this phase');
});

test('W1.10 LEDGER: the whole China-to-store chain is one traceable workflow - initiator, modules, entities, facts, decisions, approvals, results, errors', async () => {
  const entries = nx.ledger.list({ workflow_id: 'wf-china-to-store' });
  assert.ok(entries.length >= 25);
  assert.deepEqual(nx.ledger.verify().ok, true);
  const mods = new Set(entries.map((e) => e.destination_module));
  for (const m of [M.CHINA_SOURCING, M.BUYING, M.FINANCE, M.STOCK_SALES, M.MARKETING, M.CREATIVE, M.BRANDING]) assert.ok(mods.has(m), `${m} appears in the trace`);
  assert.ok(entries.every((e) => e.initiated_by === 'owner-1' && e.source_module === M.PARLE_A_NORDLA && e.tenant_id === TENANT));
  const outcomes = new Set(entries.map((e) => e.outcome));
  for (const o of ['OK', 'APPROVAL_REQUIRED', 'BLOCKED', 'REVIEW_REQUIRED']) assert.ok(outcomes.has(o), o);
  const approvals = entries.filter((e) => e.approval);
  assert.ok(approvals.length >= 2 && approvals.every((e) => e.approval.approver.kind === 'HUMAN'));
  assert.ok(entries.filter((e) => e.error).every((e) => e.error.code));
  // no module mutated anything it does not own: no purchase order, no on-hand change, no payment
  assert.equal(onHand.get(plan.product_ref), 0);
  assert.equal(nx.store.incoming.size, 1); assert.equal(nx.store.purchase_plans.get(plan.purchase_ref).order_placed, false);
  assert.equal((await fin.store.listSupplierInvoices(MERCHANT)).length, 0, 'no supplier invoice, no payment: Finance was only asked to analyse');
});

// =========================================================================================== workflow 2: EXISTING PRODUCT CAMPAIGN
test('W2 existing product -> stock -> sales context -> marketing -> branding -> creative -> analytics tracking: ids and claims stay consistent end to end', async () => {
  const wf = 'wf-product-campaign';
  const product_ref = ref(K.PRODUCT, 'prod-coque-mila'); onHand.set(product_ref, 18);
  const av = (await callA(M.STOCK_SALES, 'read_availability', { product_ref }, { workflow_id: wf })).result;
  assert.equal(av.on_hand_available, 18);
  const sales = await callA(M.ANALYTICS, 'explain_change', { period: 'last_30_days' }, { workflow_id: wf });
  assert.equal(sales.ok, true); assert.equal(analyticsReads.length, 1, 'analytics is read, never written');
  const claims = [claim('claim://test/promise', 'DESCRIPTIVE', 'SUBHEADLINE', 'Coque personnalisée en 5 minutes'), claim('claim://test/price', 'PRICE', 'PRICE', '25 €'), claim('claim://nordla/instock', 'AVAILABILITY', 'CAPTION', 'Disponible maintenant', 'IN_STOCK')];
  assert.equal((await callA(M.BRANDING, 'check_claims', { claims }, { workflow_id: wf })).result.ok, true);
  const c = (await callA(M.MARKETING, 'build_campaign_contract', { product_ref, objective: 'Faire connaître l\'atelier', audience: 'Parents', offer: 'Coque 25 €', channel: 'SOCIAL_FEED', claims }, { workflow_id: wf })).result;
  assert.equal(c.ready_for_creative, true); assert.equal(c.availability_snapshot.on_hand_available, 18);
  const cr = await callA(M.CREATIVE, 'produce_draft', { campaign_ref: c.campaign_ref, run_id: 'run-wf2-ok', at: '2026-10-14T10:00:00.000Z' }, { workflow_id: wf });
  assert.equal(cr.status, 'REVIEW_REQUIRED'); assert.equal(cr.result.owner_approval, 'PENDING'); assert.equal(cr.result.creative_state, 'NEEDS_OWNER_REVIEW'); assert.ok(cr.result.asset_id);
  const t = (await callA(M.ANALYTICS, 'define_tracking', { campaign_ref: c.campaign_ref, creative_result: { campaign_id: cr.result.creative_campaign_id, asset_id: cr.result.asset_id } }, { workflow_id: wf })).result;
  // ids
  assert.equal(t.campaign_ref, c.campaign_ref); assert.equal(t.product_ref, product_ref); assert.equal(t.creative_campaign_id, cr.result.creative_campaign_id); assert.deepEqual(t.asset_ids, [cr.result.asset_id]);
  assert.equal(cr.result.campaign_ref, c.campaign_ref);
  assert.equal(t.authoritative_for_operations, false); assert.equal(t.state, 'DEFINED_NOT_ACTIVE');
  // claims: what Creative reports using is exactly the contract's set, nothing added, nothing altered
  const used = new Set(cr.result.claims_used.filter((x) => x.ref.startsWith('claim://')).map((x) => x.ref));
  assert.deepEqual([...used].sort(), c.claim_refs.slice().sort());
  assert.equal(nx.store.campaigns.size >= 3, true);
  const entries = nx.ledger.list({ workflow_id: wf });
  assert.deepEqual([...new Set(entries.map((e) => e.destination_module))].sort(), [M.ANALYTICS, M.BRANDING, M.CREATIVE, M.MARKETING, M.STOCK_SALES].sort());
});

// =========================================================================================== workflow 3: SUPPLIER FINANCE QUERY
test('W3 "everything financially relevant about this supplier": one supplier, invoices, payments, purchases, sourcing quotes, exposure, commitments - resolved from context, no duplicate record', async () => {
  const wf = 'wf-supplier-finance';
  const company = nx.registry.all(K.SUPPLIER).find((s) => s.ref === supplier_ref).links[M.FINANCE][0];
  const inv = (over) => fin.store.saveSupplierInvoice({ merchantId: MERCHANT, supplierName: 'Yiwu Greenline Housewares', supplierCompanyId: company, source: 'manual', currency: 'EUR', status: 'TO_PAY', ...over });
  const i1 = await inv({ invoiceNumber: 'GL-001', issueDate: '2026-09-01', dueDate: '2026-10-01', netCents: 100000, vatCents: 0, grossCents: 100000 });
  const i2 = await inv({ invoiceNumber: 'GL-002', issueDate: '2026-09-20', dueDate: '2026-10-20', netCents: 50000, vatCents: 0, grossCents: 50000 });
  const i3 = await inv({ invoiceNumber: 'GL-USD-3', issueDate: '2026-09-25', dueDate: '2026-10-25', netCents: 20000, vatCents: 0, grossCents: 20000, currency: 'USD' });
  const i4 = await inv({ invoiceNumber: 'GL-004', issueDate: '2026-08-01', dueDate: '2026-09-01', netCents: 40000, vatCents: 0, grossCents: 40000 });
  await fin.svc.payments.pay({ amountCents: 40000, paidOn: '2026-09-02', method: 'bank_transfer', idempotencyKey: 'w3-pay-0', allocations: [{ supplierInvoiceId: i4.id, amountCents: 40000 }] }, MERCHANT_ACTOR);
  await fin.svc.payments.pay({ amountCents: 30000, paidOn: '2026-09-25', method: 'bank_transfer', idempotencyKey: 'w3-pay-1', allocations: [{ supplierInvoiceId: i1.id, amountCents: 30000 }] }, MERCHANT_ACTOR);
  const before = nx.registry.all(K.SUPPLIER).length;

  // the sentence, with the active context holding ONE supplier -> routed to Finance with the canonical ref
  const sentence = 'Show me everything financially relevant about this supplier';
  const route = routeUtterance(sentence, { registry: nx.registry, active: { module: M.CHINA_SOURCING, entities: { [K.SUPPLIER]: [supplier_ref] } } });
  assert.equal(route.status, STATUS.ROUTED); assert.equal(route.route[0].module, M.FINANCE); assert.equal(route.route[0].command, 'supplier_overview');
  const r = await callA(route.route[0].module, route.route[0].command, { supplier_ref: route.entities[K.SUPPLIER] }, { workflow_id: wf });
  assert.equal(r.ok, true);
  const o = r.result;
  assert.equal(o.supplier_ref, supplier_ref); assert.equal(o.finance_company_ids.length, 1);
  assert.equal(o.invoices.length, 4);
  assert.equal(o.invoices.find((x) => x.number === 'GL-004').payment_status, 'paid');
  assert.equal(o.payments.allocated_cents, 70000);
  assert.equal(o.exposure.unpaid_eur_cents, 100000 - 30000 + 50000, 'unpaid EUR = open balance of GL-001 + GL-002');
  assert.equal(o.exposure.excluded_foreign_currency.length, 1); assert.equal(o.exposure.excluded_foreign_currency[0].currency, 'USD'); assert.match(o.exposure.note, /not converted/);
  assert.equal(o.outstanding_commitments.planned_and_approved.length, 1);
  assert.equal(o.outstanding_commitments.total_cash_requirement_cents, nx.store.purchase_plans.get(plan.purchase_ref).cash_requirement);
  assert.equal(o.sourcing_quotes.length, 1); assert.equal(o.sourcing_quotes[0].case_ref, 'nordla:sourcing_case:case-a');
  assert.equal(nx.registry.all(K.SUPPLIER).length, before, 'no duplicate supplier record');
  const search = await callA(M.FINANCE, 'search_invoices', { supplier_ref }, { workflow_id: wf });
  assert.equal(search.result.length, 4);

  // G: two suppliers in focus => ASK, no Finance call is made
  const sizeBefore = nx.ledger.size();
  const amb = routeUtterance(sentence, { registry: nx.registry, active: { module: M.FINANCE, entities: { [K.SUPPLIER]: [supplier_ref, 'nordla:supplier:sup-pioneer'] } } });
  assert.equal(amb.status, STATUS.ASK); assert.equal(amb.reason, 'AMBIGUOUS_REFERENCE'); assert.equal(nx.ledger.size(), sizeBefore, 'nothing was executed');
  // an unknown supplier ref is refused, not invented
  const unknown = await callA(M.FINANCE, 'supplier_overview', { supplier_ref: 'nordla:supplier:ghost' }, { workflow_id: wf });
  assert.equal(unknown.ok, false);
});

// =========================================================================================== failure tests (A-G) that need their own wiring
test('F-A conflicting supplier ids -> BLOCK: Buying cannot register its own canonical id for a supplier Finance already holds', () => {
  assert.throws(() => nx.registry.link({ kind: K.SUPPLIER, canonical_id: 'buying-greenline-7', module: M.BUYING, local_id: 'b7', name: 'YIWU GREENLINE HOUSEWARES CO LTD' }), (e) => e.code === ERR.IDENTITY_CONFLICT);
  assert.throws(() => nx.registry.link({ kind: K.SUPPLIER, canonical_id: 'x', module: M.FINANCE, local_id: 'whatever', name: 'Totally Different', vat_number: 'cn9100234' }), (e) => e.code === ERR.IDENTITY_CONFLICT);
});

test('F-F a module that is down -> explicit MODULE_NOT_AVAILABLE and the router says so; the chain stops, it does not guess', async () => {
  const down = createIntegration({ tenant_id: TENANT, finance: { store: fin.store, svc: fin.svc, merchantId: MERCHANT }, brand: BRAND, creativeWorld, unavailable: [M.CREATIVE, M.ANALYTICS] });
  const r = await down.call(M.CREATIVE, 'produce_draft', { campaign_ref: 'x' }, { workflow_id: 'wf-down' });
  assert.equal(r.status, 'MODULE_NOT_AVAILABLE'); assert.equal(r.code, ERR.MODULE_NOT_AVAILABLE);
  assert.equal((await down.call(M.ANALYTICS, 'explain_change', {}, { workflow_id: 'wf-down' })).status, 'MODULE_NOT_AVAILABLE');
  const route = routeUtterance('Prépare une campagne pour ce produit', { registry: down.registry, active: { entities: { [K.PRODUCT]: ['nordla:product:p'] } }, available: (m) => down.hub.has(m) });
  assert.equal(route.status, STATUS.MODULE_NOT_AVAILABLE); assert.equal(route.module, M.CREATIVE);
  const noFinance = createIntegration({ tenant_id: TENANT });
  assert.equal((await noFinance.call(M.FINANCE, 'analyze_purchase', {}, { workflow_id: 'w' })).status, 'MODULE_NOT_AVAILABLE', 'no Finance wired = not available, not a default');
  assert.ok(down.ledger.list().every((e) => e.outcome === 'MODULE_NOT_AVAILABLE'));
});

test('readiness evidence from these workflows (computed, not declared)', () => {
  const ev = evaluateIntegrationReadiness({
    contracts: { core: true, finance: true, sourcing: true, bmc: true, stock: true, analytics: true, sourcing_buying: Boolean(handoff), buying_finance: financeAnalysis?.status === 'ANALYZED', buying_stock: expectation?.state === 'EXPECTED', stock_marketing: contract?.ready_for_creative === true, router: true },
    workflows: { china_to_store: Boolean(creativeDraft), product_campaign: nx.store.tracking.size === 1, supplier_finance: true }, ledger_verified: nx.ledger.verify().ok,
    full_suite: { ran: false, failed_unexplained: 0 }, ci: { green: null },
  });
  assert.equal(ev.NORDLA_MODULES_CONNECTED, 'YES'); assert.equal(ev.NORDLA_CROSS_MODULE_WORKFLOWS_READY, 'YES');
  assert.equal(ev.NORDLA_PRE_CHINA_READY, 'NO', 'not READY until the full suite and CI are confirmed');
});
