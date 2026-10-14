// Nordla pre-China integration: the shared contracts (identity, provenance, approval, ownership, ledger, hub, module map, router). No provider, no network, no store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULE as M, ENTITY as E, ID_KIND as K, PROVENANCE as P, LEVEL as L, ERR, IntegrationError,
  createIdentityRegistry, ref, parseRef, createTraceLedger, createHub, routeUtterance, STATUS, authorize, ACTION_POLICY, validateApproval,
  OWNERSHIP, KNOWN_DUPLICATIONS, assertCanWrite, assertCanRead, MODULE_MAP, makeFact, promote, reconcile, toShared, MAPPINGS,
} from '../src/integration/index.js';
import { evaluateIntegrationReadiness } from '../src/integration/readiness.js';
import { analyzePurchase, compareScenarios, RISK } from '../src/finance/purchase-analysis.js';

const T = 'merchant-test-1';
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const human = (action, subject_ref) => ({ action, subject_ref, approver: { kind: 'HUMAN', id: 'owner-1', role: 'OWNER' }, approved_at: '2026-10-14T10:00:00Z' });

test('ids: a reference is nordla:<kind>:<id>; unknown kinds and empty ids are refused', () => {
  assert.equal(ref(K.SUPPLIER, 's1'), 'nordla:supplier:s1');
  assert.deepEqual(parseRef('nordla:product:abc:def'), { kind: 'product', id: 'abc:def' });
  assert.equal(parseRef('supplier:s1'), null);
  assert.equal(code(() => ref('widget', 'x')), ERR.IDENTITY_UNKNOWN);
  assert.equal(code(() => ref(K.SUPPLIER, '')), ERR.IDENTITY_UNKNOWN);
});

test('identity: one real supplier, one canonical id - a second canonical for the same name or VAT is a conflict (failure test A)', () => {
  const r = createIdentityRegistry({ tenant_id: T });
  r.link({ kind: K.SUPPLIER, canonical_id: 'sup-1', module: M.FINANCE, local_id: 'uuid-fin-1', name: 'Yiwu Greenline Housewares Co., Ltd', vat_number: 'CN 123' });
  // Sourcing knows the same supplier by name only: it attaches to the SAME canonical id
  r.link({ kind: K.SUPPLIER, canonical_id: 'sup-1', module: M.CHINA_SOURCING, local_id: 'Yiwu Greenline Housewares', name: 'Yiwu Greenline Housewares' });
  assert.equal(r.resolveOne({ kind: K.SUPPLIER, name: 'yiwu greenline housewares' }).ref, 'nordla:supplier:sup-1');
  // a different canonical id claiming the same name, or the same VAT, is refused
  assert.equal(code(() => r.link({ kind: K.SUPPLIER, canonical_id: 'sup-2', module: M.BUYING, local_id: 'b-9', name: 'YIWU GREENLINE HOUSEWARES LTD' })), ERR.IDENTITY_CONFLICT);
  assert.equal(code(() => r.link({ kind: K.SUPPLIER, canonical_id: 'sup-3', module: M.BUYING, local_id: 'b-10', name: 'Other name', vat_number: 'cn123' })), ERR.IDENTITY_CONFLICT);
  // one module-local id cannot be bound to two canonicals
  assert.equal(code(() => r.link({ kind: K.SUPPLIER, canonical_id: 'sup-9', module: M.FINANCE, local_id: 'uuid-fin-1', name: 'Zed' })), ERR.IDENTITY_CONFLICT);
  assert.equal(r.all(K.SUPPLIER).length, 1, 'no duplicate supplier record was created');
});

test('identity: an ambiguous or unknown mention is never guessed (failure test G, registry side)', () => {
  const r = createIdentityRegistry({ tenant_id: T });
  r.link({ kind: K.SUPPLIER, canonical_id: 'a', module: M.FINANCE, local_id: '1', name: 'Shenzhen Brightway Electronics' });
  r.link({ kind: K.SUPPLIER, canonical_id: 'b', module: M.FINANCE, local_id: '2', name: 'Shenzhen Brightstar Plastics' });
  assert.equal(code(() => r.resolveOne({ kind: K.SUPPLIER, name: 'shenzhen' })), ERR.IDENTITY_AMBIGUOUS);
  assert.equal(code(() => r.resolveOne({ kind: K.SUPPLIER, name: 'nobody' })), ERR.IDENTITY_UNKNOWN);
  assert.equal(code(() => createIdentityRegistry({ tenant_id: '' })), ERR.TENANT_MISMATCH);
});

test('provenance: every module enum maps into the shared vocabulary; unknown values become UNKNOWN, never something stronger', () => {
  for (const [table, map] of Object.entries(MAPPINGS)) for (const [k, v] of Object.entries(map)) assert.ok(Object.values(P).includes(v), `${table}.${k} -> ${v}`);
  assert.equal(toShared('buying_basis', 'QUOTED'), P.SUPPLIER_CLAIM, 'a quoted price is the supplier\'s claim, not a verified fact');
  assert.equal(toShared('sourcing_fact_status', 'DOCUMENT_RECEIVED'), P.DOCUMENT_OBSERVED);
  assert.equal(toShared('sourcing_source_type', 'UNATTRIBUTED_LEGACY'), P.UNKNOWN);
  assert.equal(toShared('buying_basis', 'SOMETHING_NEW'), P.UNKNOWN);
  assert.equal(toShared('marketing_evidence_kind', 'attributed'), P.ESTIMATED);
});

test('provenance: no silent promotion - only a named human or an official source verifies, a conflict needs an explicit resolution', () => {
  const claim = makeFact({ value: '4.20', provenance: P.SUPPLIER_CLAIM, source_module: M.CHINA_SOURCING, currency: 'USD' });
  assert.equal(code(() => promote(claim, P.VERIFIED, undefined)), ERR.PROVENANCE_PROMOTION_REFUSED);
  assert.equal(code(() => promote(claim, P.VERIFIED, { verifier_kind: 'HUMAN', verifier: 'llm', evidence_ref: 'x' })), ERR.PROVENANCE_PROMOTION_REFUSED);
  assert.equal(code(() => promote(claim, P.VERIFIED, { verifier_kind: 'SYSTEM', verifier: 'engine', evidence_ref: 'x' })), ERR.PROVENANCE_PROMOTION_REFUSED);
  assert.equal(code(() => promote(claim, P.DOCUMENT_OBSERVED, { verifier_kind: 'HUMAN', verifier: 'owner-1', evidence_ref: 'doc:1' })), ERR.PROVENANCE_PROMOTION_REFUSED, 'the only promotion is to VERIFIED');
  const ok = promote(claim, P.VERIFIED, { verifier_kind: 'HUMAN', verifier: 'owner-1', evidence_ref: 'proforma:PI-77' });
  assert.equal(ok.provenance, P.VERIFIED); assert.equal(ok.promoted_from, P.SUPPLIER_CLAIM); assert.equal(claim.provenance, P.SUPPLIER_CLAIM, 'the original fact is untouched');
  const conflict = reconcile(claim, makeFact({ value: '4.50', provenance: P.DOCUMENT_OBSERVED, source_module: M.FINANCE, currency: 'USD' }));
  assert.equal(conflict.provenance, P.CONFLICT);
  assert.equal(code(() => promote(conflict, P.VERIFIED, { verifier_kind: 'HUMAN', verifier: 'owner-1', evidence_ref: 'x' })), ERR.PROVENANCE_PROMOTION_REFUSED);
  assert.equal(promote(conflict, P.VERIFIED, { verifier_kind: 'HUMAN', verifier: 'owner-1', evidence_ref: 'x', resolves_conflict: true }).provenance, P.VERIFIED);
});

test('provenance: equal facts keep the weaker provenance; a different currency is a CONFLICT, never converted (failure test B, fact side)', () => {
  const a = makeFact({ value: 100, provenance: P.VERIFIED, source_module: M.FINANCE, currency: 'EUR' });
  const b = makeFact({ value: 100, provenance: P.SUPPLIER_CLAIM, source_module: M.CHINA_SOURCING, currency: 'EUR' });
  assert.equal(reconcile(a, b).provenance, P.SUPPLIER_CLAIM);
  const usd = makeFact({ value: 100, provenance: P.SUPPLIER_CLAIM, source_module: M.CHINA_SOURCING, currency: 'USD' });
  const r = reconcile(a, usd);
  assert.equal(r.provenance, P.CONFLICT); assert.match(r.note, /CURRENCY_MISMATCH EUR vs USD/);
});

test('approval: the policy is default-deny and every level behaves as documented', () => {
  assert.equal(authorize(`${M.FINANCE}.search_invoices`).decision, 'ALLOW');
  assert.equal(authorize(`${M.FINANCE}.analyze_purchase`).decision, 'ALLOW');
  assert.equal(authorize(`${M.CREATIVE}.final_asset`).decision, 'REVIEW_REQUIRED');
  assert.equal(authorize(`${M.BUYING}.place_order`).decision, 'APPROVAL_REQUIRED');
  assert.equal(authorize(`${M.FINANCE}.pay_supplier`).decision, 'APPROVAL_REQUIRED');
  assert.equal(authorize(`${M.CREATIVE}.call_live_provider`).code, ERR.ACTION_BLOCKED);
  assert.equal(authorize('NOPE.whatever').code, ERR.ACTION_UNKNOWN, 'an action outside the table is blocked');
  for (const [a, l] of Object.entries(ACTION_POLICY)) assert.ok(Object.values(L).includes(l), a);
});

test('approval: an approval is a named HUMAN, for this action and this subject; machines and mismatches are refused', () => {
  const a = `${M.BUYING}.approve_purchase_plan`; const s = 'nordla:purchase:pp1';
  assert.equal(authorize(a, { approvals: [human(a, s)], subject_ref: s }).decision, 'ALLOW');
  assert.equal(authorize(a, { approvals: [human(a, 'nordla:purchase:other')], subject_ref: s }).decision, 'APPROVAL_REQUIRED', 'approval of another subject does not count');
  assert.equal(authorize(a, { approvals: [human(`${M.BUYING}.place_order`, s)], subject_ref: s }).decision, 'APPROVAL_REQUIRED', 'approval of another action does not count');
  for (const id of ['llm', 'nordla', 'agent', 'AUTO']) assert.equal(validateApproval({ ...human(a, s), approver: { kind: 'HUMAN', id } }).code, ERR.APPROVER_NOT_HUMAN, id);
  assert.equal(validateApproval({ ...human(a, s), approver: { kind: 'AGENT', id: 'owner-1' } }).code, ERR.APPROVER_NOT_HUMAN);
  assert.equal(authorize(a, { approvals: [{ ...human(a, s), approver: { kind: 'AGENT', id: 'owner-1' } }], subject_ref: s }).code, ERR.APPROVER_NOT_HUMAN);
});

test('ownership: one owner per entity, writes only by the owner, reads only as declared; the known duplications are written down', () => {
  for (const e of Object.values(E)) assert.ok(OWNERSHIP[e]?.owner, `${e} has an owner`);
  assert.equal(OWNERSHIP[E.SUPPLIER].owner, M.FINANCE);
  assert.equal(code(() => assertCanWrite(M.CHINA_SOURCING, E.SUPPLIER)), ERR.OWNERSHIP_VIOLATION, 'Sourcing must not keep a competing supplier ledger');
  assert.equal(code(() => assertCanWrite(M.MARKETING, E.STOCK)), ERR.OWNERSHIP_VIOLATION, 'Marketing must not own product inventory');
  assert.equal(code(() => assertCanWrite(M.CREATIVE, E.CLAIM_EVIDENCE)), ERR.OWNERSHIP_VIOLATION, 'Creative must not create verified facts');
  assert.equal(code(() => assertCanWrite(M.CREATIVE, E.FINANCIAL_FACT)), ERR.OWNERSHIP_VIOLATION);
  assert.equal(code(() => assertCanWrite(M.FINANCE, E.SUPPLIER)), null);
  assert.equal(code(() => assertCanRead(M.MARKETING, E.STOCK)), null);
  assert.equal(code(() => assertCanRead(M.CREATIVE, E.PAYMENT)), ERR.OWNERSHIP_VIOLATION);
  assert.ok(KNOWN_DUPLICATIONS.some((d) => d.id === 'DUP-LANDED-COST'));
});

test('module map: every entry has readiness and a reference; the router module is honestly NOT_IMPLEMENTED beyond text; dependencies are classified', () => {
  for (const [id, m] of Object.entries(MODULE_MAP)) {
    assert.ok(m.readiness, `${id} readiness`);
    assert.ok(m.ref?.branch && m.ref?.sha, `${id} branch/sha`);
    for (const [dep, kind] of Object.entries(m.depends ?? {})) { assert.ok(MODULE_MAP[dep], `${id} -> ${dep} exists`); assert.ok(['HARD', 'SOFT', 'OPTIONAL', 'HISTORICAL_ONLY'].includes(kind)); }
  }
  assert.equal(MODULE_MAP[M.PARLE_A_NORDLA].implemented, false);
  assert.equal(MODULE_MAP[M.BUYING].owns[0], E.PURCHASE);
});

test('ledger: append-only, hash-chained, tenant-scoped; tampering is detected; facts are cloned so callers cannot mutate history', () => {
  const l = createTraceLedger({ tenant_id: T, now: () => '2026-10-14T10:00:00Z' });
  const facts = [{ name: 'price', value: '4.20' }];
  l.append({ workflow_id: 'w1', source_module: M.CHINA_SOURCING, destination_module: M.BUYING, action: 'prepare', facts, outcome: 'OK' });
  l.append({ workflow_id: 'w1', source_module: M.BUYING, destination_module: M.FINANCE, action: 'analyze', outcome: 'BLOCKED', error: { code: 'X' } });
  facts[0].value = 'changed';
  assert.equal(l.list()[0].facts[0].value, '4.20');
  assert.deepEqual(l.verify(), { ok: true, length: 2 });
  assert.equal(code(() => l.append({ workflow_id: 'w1', source_module: M.CORE, action: 'a', outcome: 'WEIRD' })), ERR.HANDOFF_INVALID);
  assert.equal(code(() => l.append({ tenant_id: 'other', workflow_id: 'w1', source_module: M.CORE, action: 'a', outcome: 'OK' })), ERR.TENANT_MISMATCH);
  assert.throws(() => { l.list()[0].facts.push(1); }, TypeError, 'entries are frozen');
  assert.equal(l.list({ module: M.FINANCE }).length, 1);
});

test('hub: MODULE_NOT_AVAILABLE is explicit and traced (failure test F); blocked and approval-required calls never reach the module', async () => {
  const ledger = createTraceLedger({ tenant_id: T });
  let reached = 0;
  const hub = createHub({ ledger, adapters: {
    [M.FINANCE]: { commands: { search_invoices: () => ({ n: 1 }), pay_supplier: () => { reached += 1; return {}; } } },
    [M.CREATIVE]: { available: () => false, commands: { produce_draft: () => ({}) } },
  } });
  assert.deepEqual((await hub.call(M.FINANCE, 'search_invoices', {}, { workflow_id: 'w' })).ok, true);
  const down = await hub.call(M.CREATIVE, 'produce_draft', {}, { workflow_id: 'w' });
  assert.equal(down.status, 'MODULE_NOT_AVAILABLE'); assert.equal(down.code, ERR.MODULE_NOT_AVAILABLE);
  assert.equal((await hub.call(M.STOCK_SALES, 'read_availability', {}, { workflow_id: 'w' })).status, 'MODULE_NOT_AVAILABLE', 'no adapter at all = not available');
  const pay = await hub.call(M.FINANCE, 'pay_supplier', {}, { workflow_id: 'w' });
  assert.equal(pay.status, 'APPROVAL_REQUIRED'); assert.equal(reached, 0);
  assert.equal((await hub.call(M.FINANCE, 'unknown_cmd', {}, { workflow_id: 'w' })).status, 'COMMAND_NOT_AVAILABLE');
  const outcomes = ledger.list().map((e) => e.outcome);
  assert.deepEqual(outcomes, ['OK', 'MODULE_NOT_AVAILABLE', 'MODULE_NOT_AVAILABLE', 'APPROVAL_REQUIRED', 'ERROR']);
  assert.equal(ledger.verify().ok, true);
});

test('hub: an IntegrationError inside a module becomes BLOCKED with its code, not a crash; other errors are ERROR', async () => {
  const ledger = createTraceLedger({ tenant_id: T });
  const hub = createHub({ ledger, adapters: { [M.FINANCE]: { commands: { analyze_purchase: () => { throw new IntegrationError(ERR.CURRENCY_CONFLICT, 'x'); }, search_invoices: () => { throw new Error('boom'); } } } } });
  assert.equal((await hub.call(M.FINANCE, 'analyze_purchase', {}, { workflow_id: 'w' })).status, 'BLOCKED');
  assert.equal((await hub.call(M.FINANCE, 'search_invoices', {}, { workflow_id: 'w' })).status, 'ERROR');
});

// ------------------------------------------------------------------------------------------------ Finance purchase analysis (Finance stays authoritative)
const BASE = { supplier_unit_price: '4.20', currency: 'EUR', qty: 1000, freight_total: '600', other_costs_total: '100', duty_rate_pct: '2.7', import_vat_rate_pct: '21', expected_selling_price_gross: '19.99', selling_vat_rate_pct: '21' };

test('Finance purchase analysis: integer cents, landed cost, cash requirement, margin - checked by hand', () => {
  const a = analyzePurchase(BASE);
  assert.equal(a.status, 'ANALYZED');
  // goods 4200.00 + freight 600.00 = customs value 4800.00 ; duty 2.7 % = 129.60 ; other 100.00
  assert.equal(a.components.goods, 420000); assert.equal(a.components.freight, 60000); assert.equal(a.components.duty, 12960); assert.equal(a.components.other, 10000);
  assert.equal(a.landed_cost.total, 420000 + 60000 + 12960 + 10000); assert.equal(a.landed_cost.per_unit, 503); // 502.96 -> 503 cents
  assert.equal(a.components.import_vat_advanced, Math.round((480000 + 12960) * 0.21)); // 103522 (half-up)
  assert.equal(a.cash_requirement.total, a.landed_cost.total + a.components.import_vat_advanced);
  // net price 19.99 / 1.21 = 16.52 ; margin = 1652 - 503 = 1149
  assert.equal(a.margin.net_price_per_unit, 1652); assert.equal(a.margin.gross_margin_per_unit, 1149);
  assert.equal(a.margin.basis, 'CALCULATED'); assert.deepEqual(a.risks, []); assert.equal(a.owner_approval, 'NOT_REQUESTED');
  assert.throws(() => { a.components.goods = 1; }, TypeError);
});

test('Finance purchase analysis: a foreign currency is a CURRENCY_CONFLICT unless a human states the rate; then it is flagged ESTIMATED (failure test B)', () => {
  const usd = { ...BASE, currency: 'USD' };
  const a = analyzePurchase(usd);
  assert.equal(a.status, RISK.CURRENCY_CONFLICT); assert.equal(a.conflict.converted, false);
  assert.equal(analyzePurchase({ ...usd, fx: { rate: '0.92', provenance: 'SUPPLIER_CLAIM' } }).status, RISK.CURRENCY_CONFLICT, 'a supplier-stated rate is not a human decision');
  assert.equal(analyzePurchase({ ...usd, fx: { rate: 'abc', provenance: 'USER_PROVIDED' } }).status, RISK.CURRENCY_CONFLICT);
  const b = analyzePurchase({ ...usd, fx: { rate: '0.92', provenance: 'USER_PROVIDED' } });
  assert.equal(b.status, 'ANALYZED'); assert.equal(b.components.goods, 386400); // 4200.00 USD * 0.92
  assert.equal(b.landed_cost.basis, 'ESTIMATED'); assert.ok(b.risks.includes(RISK.FX_ESTIMATED));
  assert.equal(analyzePurchase({ ...BASE, cost_currency: 'USD' }).status, RISK.CURRENCY_CONFLICT, 'freight in another currency is not silently mixed in');
});

test('Finance purchase analysis: unknown costs make a LOWER_BOUND, thin and negative margins and a cash shortfall are flagged, bad input is refused', () => {
  const { freight_total, ...noFreight } = BASE;
  const lb = analyzePurchase(noFreight);
  assert.equal(lb.landed_cost.basis, 'LOWER_BOUND'); assert.ok(lb.risks.includes(RISK.COST_UNKNOWN)); assert.deepEqual(lb.landed_cost.unknown_inputs, ['freight_total']);
  assert.ok(analyzePurchase({ ...BASE, expected_selling_price_gross: '5.00' }).risks.includes(RISK.NEGATIVE_MARGIN));
  assert.ok(analyzePurchase({ ...BASE, expected_selling_price_gross: '7.00' }).risks.includes(RISK.THIN_MARGIN));
  const s = analyzePurchase({ ...BASE, cash_available_cents: 100000 });
  assert.ok(s.risks.includes(RISK.EXCEEDS_AVAILABLE_CASH)); assert.equal(s.cash_shortfall, s.cash_requirement.total - 100000);
  assert.equal(analyzePurchase({ ...BASE, qty: 0 }).status, RISK.INPUT_INVALID);
  assert.equal(analyzePurchase({ ...BASE, supplier_unit_price: '4.123456' }).status, RISK.INPUT_INVALID, 'never silently truncate a monetary input');
  const p = analyzePurchase({ ...BASE, payment_terms: { deposit_pct: '30', balance_pct: '70' } });
  assert.equal(p.payment_schedule.deposit, 126000); assert.equal(p.payment_schedule.deposit + p.payment_schedule.balance_and_charges, p.cash_requirement.total);
});

test('Finance scenarios: the axes are reported apart, no opaque score', () => {
  const c = compareScenarios(BASE, [{ qty: 500, label: '500' }, { qty: 1000, label: '1000' }, { qty: 2000, label: '2000' }]);
  assert.equal(c.by_axis.lowest_cash, '500'); assert.ok(c.by_axis.highest_margin);
  assert.equal(c.scenarios.length, 3); assert.match(c.note, /no multiplicative score/);
});

// ------------------------------------------------------------------------------------------------ router
const reg = createIdentityRegistry({ tenant_id: T });
reg.link({ kind: K.SUPPLIER, canonical_id: 'sup-1', module: M.FINANCE, local_id: 'f1', name: 'Greenline Housewares' });
reg.link({ kind: K.PRODUCT, canonical_id: 'prod-1', module: M.STOCK_SALES, local_id: 'p1', name: 'Coque Samsung' });
const ctx = (over = {}) => ({ registry: reg, active: { module: M.CHINA_SOURCING, entities: { [K.SUPPLIER]: ['nordla:supplier:sup-1'], [K.PRODUCT]: ['nordla:product:prod-1'] } }, ...over });

test('router: the six required sentences resolve to the right module(s)', () => {
  const r = (s, c = ctx()) => routeUtterance(s, c);
  const chain = (x) => x.route.map((s) => s.module);
  assert.deepEqual(chain(r('Compare mes fournisseurs pour ce produit')), [M.CHINA_SOURCING]);
  assert.deepEqual(chain(r('Montre-moi les factures de ce fournisseur')), [M.FINANCE]);
  assert.deepEqual(chain(r('Combien me reste-t-il de ce produit ?')), [M.STOCK_SALES]);
  assert.deepEqual(chain(r('Prépare une campagne pour ce produit')), [M.MARKETING, M.CREATIVE]);
  assert.deepEqual(chain(r('Pourquoi les ventes ont baissé ?')), [M.ANALYTICS]);
  assert.deepEqual(chain(r('Résume-moi ce dossier')), [M.CHINA_SOURCING], 'the active context decides');
  assert.deepEqual(chain(r('Résume-moi ce dossier', ctx({ active: { module: M.FINANCE } }))), [M.FINANCE]);
  assert.equal(r('Montre-moi les factures de ce fournisseur').entities[K.SUPPLIER], 'nordla:supplier:sup-1');
  assert.equal(r('Montre-moi les factures de ce fournisseur').intent, 'SEARCH');
  assert.deepEqual(chain(r('Show me everything financially relevant about this supplier')), [M.FINANCE]);
});

test('router: an ambiguous "this supplier" is a question, never a guess (failure test G); missing context asks too', () => {
  const two = ctx({ active: { module: M.FINANCE, entities: { [K.SUPPLIER]: ['nordla:supplier:a', 'nordla:supplier:b'] } } });
  const a = routeUtterance('Montre-moi les factures de ce fournisseur', two);
  assert.equal(a.status, STATUS.ASK); assert.equal(a.reason, 'AMBIGUOUS_REFERENCE'); assert.deepEqual(a.options, ['nordla:supplier:a', 'nordla:supplier:b']);
  assert.equal(routeUtterance('Montre-moi les factures de ce fournisseur', { registry: reg, active: {} }).status, STATUS.ASK);
  assert.equal(routeUtterance('Résume-moi ce dossier', { registry: reg }).reason, 'NO_ACTIVE_CONTEXT');
  const names = createIdentityRegistry({ tenant_id: T });
  names.link({ kind: K.SUPPLIER, canonical_id: 'a', module: M.FINANCE, local_id: '1', name: 'Brightway Electronics' });
  names.link({ kind: K.SUPPLIER, canonical_id: 'b', module: M.FINANCE, local_id: '2', name: 'Brightway Plastics' });
  const n = routeUtterance('factures du fournisseur Brightway', { registry: names });
  assert.equal(n.status, STATUS.ASK); assert.equal(n.reason, 'AMBIGUOUS_NAME'); assert.equal(n.options.length, 2);
  const one = routeUtterance('factures du fournisseur Greenline', { registry: reg });
  assert.equal(one.status, STATUS.ROUTED); assert.equal(one.entities[K.SUPPLIER], 'nordla:supplier:sup-1');
});

test('router: unavailable module, missing permission, unroutable sentence', () => {
  assert.equal(routeUtterance('Prépare une campagne pour ce produit', ctx({ available: (m) => m !== M.CREATIVE })).status, STATUS.MODULE_NOT_AVAILABLE);
  assert.equal(routeUtterance('Prépare une campagne pour ce produit', ctx({ available: (m) => m !== M.CREATIVE })).module, M.CREATIVE);
  const denied = routeUtterance('Montre-moi les factures de ce fournisseur', ctx({ permissions: { modules: [M.STOCK_SALES] } }));
  assert.equal(denied.status, STATUS.BLOCKED);
  assert.equal(routeUtterance('quelle heure est-il', ctx()).status, STATUS.UNROUTABLE);
  assert.equal(routeUtterance('Prépare une campagne pour ce produit', ctx()).needs_review, true, 'Creative output is reviewed by the owner');
});

test('readiness: global flags are computed from evidence and never inferred from module-local readiness', () => {
  const none = evaluateIntegrationReadiness();
  assert.equal(none.NORDLA_PRE_CHINA_READY, 'NO'); assert.equal(none.NORDLA_MODULES_CONNECTED, 'NO'); assert.equal(none.CORE_READY, 'NO');
  const contracts = { core: true, finance: true, sourcing: true, bmc: true, stock: true, analytics: true, sourcing_buying: true, buying_finance: true, buying_stock: true, stock_marketing: true, router: true };
  const wf = { china_to_store: true, product_campaign: true, supplier_finance: true };
  const noCi = evaluateIntegrationReadiness({ contracts, workflows: wf, ledger_verified: true, full_suite: { ran: true, failed_unexplained: 0 } });
  assert.equal(noCi.NORDLA_MODULES_CONNECTED, 'YES'); assert.equal(noCi.NORDLA_CROSS_MODULE_WORKFLOWS_READY, 'YES');
  assert.equal(noCi.NORDLA_PRE_CHINA_READY, 'NO', 'CI not confirmed'); assert.ok(noCi.blockers.includes('CI not confirmed green'));
  assert.equal(evaluateIntegrationReadiness({ contracts, workflows: { ...wf, supplier_finance: false }, ledger_verified: true, full_suite: { ran: true, failed_unexplained: 0 }, ci: { green: true } }).NORDLA_PRE_CHINA_READY, 'NO');
  assert.equal(evaluateIntegrationReadiness({ contracts, workflows: wf, ledger_verified: true, full_suite: { ran: true, failed_unexplained: 2 }, ci: { green: true } }).NORDLA_PRE_CHINA_READY, 'NO');
  assert.equal(evaluateIntegrationReadiness({ contracts, workflows: wf, ledger_verified: false, full_suite: { ran: true, failed_unexplained: 0 }, ci: { green: true } }).NORDLA_MODULES_CONNECTED, 'NO');
  const all = evaluateIntegrationReadiness({ contracts, workflows: wf, ledger_verified: true, full_suite: { ran: true, failed_unexplained: 0 }, ci: { green: true } });
  assert.equal(all.NORDLA_PRE_CHINA_READY, 'YES'); assert.deepEqual(all.modules_not_implemented, [M.PARLE_A_NORDLA]); assert.match(all.voice, /no voice/);
});
