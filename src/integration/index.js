// Nordla integration (pre-China): wires the EXISTING modules behind one hub, one identity registry, one approval policy and one trace ledger.
// It does not move, rewrite or replace any module. Every adapter below calls the module's own exported functions; the few new objects the platform lacked
// (BUY_CANDIDATE, PurchasePlan, IncomingExpectation, CampaignContract, TrackingDefinition) live in an in-memory store here and are listed as NOT_PERSISTED.
import { MODULE as M, ID_KIND as K, ERR, IntegrationError, fail, INTEGRATION_VERSION } from './constants.js';
import { createIdentityRegistry, ref, parseRef } from './ids.js';
import { createTraceLedger } from './ledger.js';
import { createHub } from './hub.js';
import {
  markBuyCandidate, buildBuyingHandoff, financeRequestFromHandoff, buildPurchasePlan, approvePurchasePlan, buildIncomingExpectation,
  availabilityOf, checkClaimsAgainstBrand, buildCampaignContract, creativeInputsFrom, buildTrackingDefinition,
} from './handoffs.js';
import { analyzePurchase, compareScenarios } from '../finance/purchase-analysis.js';
import { assess as sourcingAssess } from '../sourcing/core/case.js';
import { dealIntelligence, compareDeals } from '../sourcing/core/field/deal.js';
import { runCreativeEndToEnd } from '../creative-e2e/index.js';
import { eurOfSupplier } from '../finance/currency.js';
import { mergeProcurementAdapters } from './procurement.js';
import { createSocialAdapter } from './social.js';

export * from './constants.js';
export { createIdentityRegistry, ref, parseRef } from './ids.js';
export { createTraceLedger, verifyEntries } from './ledger.js';
export { createHub } from './hub.js';
export { routeUtterance, INTENT, STATUS } from './router.js';
export { authorize, ACTION_POLICY, validateApproval } from './approval.js';
export { OWNERSHIP, KNOWN_DUPLICATIONS, assertCanWrite, assertCanRead } from './ownership.js';
export { MODULE_MAP, NOT_MERGED } from './module-map.js';
export { makeFact, promote, reconcile, toShared, MAPPINGS } from './provenance.js';
export * as handoffs from './handoffs.js';

/** In-memory store for the objects no module owned before. NOT_PERSISTED: a process restart forgets them (documented gap, separate task). */
export function createIntegrationStore() {
  const m = { buy_candidates: new Map(), purchase_plans: new Map(), incoming: new Map(), campaigns: new Map(), tracking: new Map() };
  return Object.freeze({ ...m, persisted: false });
}

/**
 * @param {object} deps
 *  tenant_id            merchant id (UUID in production)
 *  finance              { store, svc, merchantId }            -> Finance module (memory or Supabase store)
 *  readOnHand           (product_ref) => integer|undefined     -> Stock/Sales reader (ledger.stockByVariant in production)
 *  brand                { tenant_id, brand_ref, approved_claims:[{ref, wording}] }  -> Branding
 *  creativeWorld        ports + base brief/request for Creative, or a factory returning a fresh one per run (fakes in tests; no provider is ever created here)
 *  analytics            { explainChange(args) }               -> optional; absent => MODULE_NOT_AVAILABLE
 *  social               { service, credentialPort? } of Social Publishing (createSocialService): adds the SOCIAL_PUBLISHING reads and the proposal command; absent => MODULE_NOT_AVAILABLE
 *  procurement          the assistant of createProcurement()   -> optional; adds `proc_*` read/proposal commands to STOCK_SALES and BUYING (nothing existing is replaced)
 *  unavailable          modules to simulate as down
 */
export function createIntegration({ tenant_id, finance = null, readOnHand = () => undefined, brand = null, creativeWorld = null, analytics = null, procurement = null, social = null, unavailable = [], now = () => new Date().toISOString() }) {
  const registry = createIdentityRegistry({ tenant_id });
  const ledger = createTraceLedger({ tenant_id, now });
  const store = createIntegrationStore();
  const down = new Set(unavailable);
  const avail = (m, extra = true) => () => !down.has(m) && extra;

  const expectations = () => [...store.incoming.values()];
  const availabilityFor = (product_ref) => availabilityOf({ product_ref, on_hand: readOnHand(product_ref), expectations: expectations() });

  const adapters = {
    [M.CHINA_SOURCING]: { available: avail(M.CHINA_SOURCING), commands: {
      assess: ({ case_state, externals, now: at }) => sourcingAssess(case_state, { now: at ?? new Date(now()), externals }),
      compare: ({ cases, externals, now: at }) => {
        const entries = cases.map((c) => { const a = sourcingAssess(c, { now: at ?? new Date(now()), externals }); return { caseId: c.id, name: c.name ?? c.identity?.workingName, deal: dealIntelligence(c, a), verdict: a.decision.verdict }; });
        return { ...compareDeals(entries.map(({ verdict, ...e }) => e)), verdicts: Object.fromEntries(entries.map((e) => [e.caseId, e.verdict])) };
      },
      summarize_case: ({ case_state, externals }) => {
        const a = sourcingAssess(case_state, { now: new Date(now()), externals });
        return { case_ref: ref(K.SOURCING_CASE, case_state.id), verdict: a.decision.verdict, can_commit_money: a.decision.canCommitMoney, next_action: a.decision.nextAction, blockers: a.decision.hardBlockers, quotes: case_state.quotes?.length ?? 0 };
      },
      mark_buy_candidate: (args) => { const bc = markBuyCandidate({ tenant_id, ...args }); store.buy_candidates.set(bc.case_ref, bc); return bc; },
    } },
    [M.BUYING]: { available: avail(M.BUYING), commands: {
      prepare_handoff: ({ case_state, assessment, buy_candidate }) => buildBuyingHandoff({ tenant_id, case_state, assessment, buy_candidate }),
      create_purchase_plan: (args) => { const p = buildPurchasePlan({ tenant_id, ...args }); store.purchase_plans.set(p.purchase_ref, p); return p; },
      approve_purchase_plan: ({ purchase_ref, approval }) => {
        const p = store.purchase_plans.get(purchase_ref); if (!p) fail(ERR.HANDOFF_INVALID, 'unknown purchase plan');
        const a = approvePurchasePlan(p, approval); store.purchase_plans.set(purchase_ref, a); return a;
      },
    } },
    [M.FINANCE]: { available: avail(M.FINANCE, Boolean(finance)), commands: {
      analyze_purchase: (req) => analyzePurchase(req),
      compare_scenarios: ({ base, scenarios }) => compareScenarios(base, scenarios),
      supplier_overview: (a) => supplierOverview(a),
      search_invoices: async (a) => (await supplierOverview(a)).invoices,
    } },
    [M.STOCK_SALES]: { available: avail(M.STOCK_SALES), commands: {
      read_availability: ({ product_ref }) => availabilityFor(product_ref),
      expect_incoming: ({ purchase_ref }) => {
        const plan = store.purchase_plans.get(purchase_ref); if (!plan) fail(ERR.HANDOFF_INVALID, 'unknown purchase plan');
        const e = buildIncomingExpectation(plan); store.incoming.set(e.expectation_id, e); return e;
      },
    } },
    [M.BRANDING]: { available: avail(M.BRANDING, Boolean(brand)), commands: { check_claims: ({ claims }) => checkClaimsAgainstBrand({ claims, brand }) } },
    [M.MARKETING]: { available: avail(M.MARKETING), commands: {
      build_campaign_contract: (a) => { const c = buildCampaignContract({ tenant_id, brand, availability: availabilityFor(a.product_ref), ...a }); store.campaigns.set(c.campaign_ref, c); return c; },
    } },
    [M.CREATIVE]: { available: avail(M.CREATIVE, Boolean(creativeWorld)), commands: {
      produce_draft: async ({ campaign_ref, run_id, at, ceiling_eur = 2 }) => {
        const contract = store.campaigns.get(campaign_ref); if (!contract) fail(ERR.HANDOFF_INVALID, 'unknown campaign contract');
        const world = typeof creativeWorld === 'function' ? await creativeWorld() : creativeWorld; // scripted ports are single-use: one fresh world per run
        const inputs = creativeInputsFrom(contract, { base_brief: world.brief, base_request: world.request });
        const r = await runCreativeEndToEnd({ run_id, at, ceiling_eur, ...world, brief: inputs.brief, request: inputs.request });
        return { campaign_ref, creative_state: r.state, creative_campaign_id: r.campaign_id, asset_id: r.asset_id, creative_operations: Array.isArray(r.provider_calls) ? r.provider_calls.length : r.provider_calls, live_provider: false, owner_approval: r.owner_approval, claims_used: (r.claims ?? []).map((c) => ({ ref: c.ref, disposition: c.disposition })), warnings: r.warnings, block: r.block ?? null, png_sha256: r.final?.png_sha256 ?? null };
      },
    } },
    [M.ANALYTICS]: { available: avail(M.ANALYTICS), commands: {
      define_tracking: ({ campaign_ref, creative_result }) => { const c = store.campaigns.get(campaign_ref); if (!c) fail(ERR.HANDOFF_INVALID, 'unknown campaign contract'); const t = buildTrackingDefinition({ contract: c, creative_result }); store.tracking.set(t.tracking_id, t); return t; },
      read: (a) => analytics?.read?.(a) ?? fail(ERR.MODULE_NOT_AVAILABLE, 'no analytics reader configured'),
      explain_change: (a) => analytics?.explainChange?.(a) ?? fail(ERR.MODULE_NOT_AVAILABLE, 'no analytics reader configured'),
    } },
    [M.PARLE_A_NORDLA]: { available: avail(M.PARLE_A_NORDLA), commands: {} },
  };

  adapters[M.SOCIAL_PUBLISHING] = social ? { ...createSocialAdapter(social), available: avail(M.SOCIAL_PUBLISHING) } : { available: () => false, commands: {} }; // absent => MODULE_NOT_AVAILABLE, never a crash

  if (procurement) mergeProcurementAdapters(adapters, procurement);

  /** Everything financially relevant about ONE supplier (a canonical supplier ref). Exposure counts EUR only; foreign-currency documents are listed, never converted. */
  async function supplierOverview({ supplier_ref }) {
    const p = parseRef(supplier_ref);
    if (!p || p.kind !== K.SUPPLIER) fail(ERR.IDENTITY_UNKNOWN, 'a canonical supplier ref is required');
    const rec = registry.all(K.SUPPLIER).find((r) => r.ref === supplier_ref); if (!rec) fail(ERR.IDENTITY_UNKNOWN, 'unknown supplier');
    const companyIds = rec.links[M.FINANCE] ?? [];
    const rows = finance ? (await finance.store.listSupplierInvoices(finance.merchantId)).filter((r) => companyIds.includes(r.supplierCompanyId)) : [];
    const invoices = rows.map((r) => ({ invoice_id: r.id, number: r.invoiceNumber, issue_date: r.issueDate, due_date: r.dueDate, gross_cents: r.grossCents, currency: r.currency, status: r.status, payment_status: r.paymentStatus, allocated_cents: r.allocatedCents ?? 0 }));
    let unpaidEur = 0; const foreign = [];
    for (const r of rows) {
      if (r.paymentStatus === 'paid') continue;
      const eur = eurOfSupplier(r);
      if (eur === null) { foreign.push({ invoice_id: r.id, currency: r.currency, gross_cents: r.grossCents }); continue; }
      unpaidEur += eur - (r.allocatedCents ?? 0);
    }
    const plans = [...store.purchase_plans.values()].filter((pl) => pl.supplier_ref === supplier_ref);
    const commitments = plans.filter((pl) => pl.status === 'APPROVED_TO_ORDER').map((pl) => ({ purchase_ref: pl.purchase_ref, cash_requirement_cents: pl.cash_requirement, eta: pl.eta }));
    const quotes = [...store.buy_candidates.values()].filter((b) => b.supplier_ref === supplier_ref).map((b) => ({ case_ref: b.case_ref, verdict: b.verdict }));
    return {
      supplier_ref, display: rec.display, finance_company_ids: companyIds, invoices,
      payments: { allocated_cents: rows.reduce((s, r) => s + (r.allocatedCents ?? 0), 0) },
      exposure: { unpaid_eur_cents: unpaidEur, excluded_foreign_currency: foreign, note: foreign.length ? 'foreign-currency documents are excluded from EUR exposure, not converted' : null },
      outstanding_commitments: { planned_and_approved: commitments, total_cash_requirement_cents: commitments.reduce((s, c) => s + c.cash_requirement_cents, 0), plans_not_approved: plans.filter((pl) => pl.status === 'PLANNED').length },
      sourcing_quotes: quotes,
    };
  }

  const call = (module, command, args, ctx) => hub.call(module, command, args, ctx);
  const hub = createHub({ ledger, adapters });
  return Object.freeze({ version: INTEGRATION_VERSION, tenant_id, registry, ledger, store, hub, call, availabilityFor, supplierOverview });
}

export { IntegrationError };
