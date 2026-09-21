import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemandFacts } from '../src/demand/build.js';
import { evaluateCandidate, VERDICTS } from '../src/buying/evaluate.js';
import { normalizeCandidate } from '../src/buying/contract.js';
import { landedCost, percentile } from '../src/buying/economics.js';
import { prepareStockVerification, reconcileVerification } from '../src/buying/inventory-trust.js';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { CONFIG as DEMAND_CONFIG, NOW as DEMAND_NOW, TZ, makeDemandData } from './fixtures/demand-sample.js';
import { NOW, SNAPSHOT, candidate, healthyPeerFacts, mkFacts, peer, policy, stockVariant } from './fixtures/buying-sample.js';

const run = (raw, { facts = healthyPeerFacts(), config = policy(), prepared = new Map() } = {}) =>
  evaluateCandidate({ rawCandidate: raw, demandFacts: facts, config, preparedVerification: prepared, now: NOW });
const check = (r, id) => r.checks.find((c) => c.id === id);

// Peer facts whose stock is physically verified: counts reconcile with Shopify.
function verifiedPrepared(facts) {
  const counted = new Date('2026-09-20T12:00:00Z');
  return new Map(facts.variants.map((v) => [v.variant_id, { counted_units: v.inventory.stock_units, counted_at: counted, units_sold_since: 0 }]));
}

// ---------- The three approved examples ----------

test('example 1: attractive low-MOQ test -> TEST CANDIDATE (evidence supported), every conditional stated', () => {
  const raw = candidate({
    unit_price: { value: 4, basis: 'QUOTED' },
    landed_cost: { freight_per_unit: { value: 0.6, basis: 'ESTIMATED' }, duties_per_unit: { value: 0.4, basis: 'ESTIMATED' } },
    expected_retail_price: { value: 18, tax_basis: 'excl', basis: 'ASSUMPTION' },
  });
  const r = run(raw);
  assert.equal(r.verdict, VERDICTS.TEST);
  assert.equal(r.test_type, 'EVIDENCE_SUPPORTED');
  const m = check(r, 'unit_margin');
  assert.equal(m.status, 'PASS');
  assert.equal(m.evidence.margin_pct.nominal, 0.6972); // (18 - 5.00 - 0.45) / 18
  assert.equal(m.evidence.margin_pct.worst, 0.6833); // estimates 25% high: landed 5.25
  assert.equal(check(r, 'test_capital').evidence.capital_at_risk.nominal, 60);
  const st = check(r, 'sell_through');
  assert.deepEqual(st.evidence.by_peer_set[0].weeks_to_sell_if_it_sells_like, { p25_peer: 20, median_peer: 10, p75_peer: 6 });
  assert.equal(check(r, 'peer_exposure').status, 'PASS');
  for (const c of ['EXPECTED_RETAIL_PRICE_IS_ASSUMPTION', 'LANDED_COST_INCLUDES_ESTIMATES', 'PEER_STOCK_UNVERIFIED', 'SHORT_HISTORY_55_DAYS', 'SEASONALITY_NOT_ASSESSED']) {
    assert.ok(r.caveats.includes(c) || m.conditional_on.includes(c), `missing caveat ${c}`);
  }
  assert.equal(r.conditions.this_is_also_the_maximum_loss, true);
  assert.equal(r.blocked_conclusions.find((b) => b.id === 'seasonal_fit').status, 'BLOCKED');
});

test('example 2: strong economics and demand, but poor stock/cost data -> NEED MORE DATA, never AVOID', () => {
  const facts = healthyPeerFacts({ quality: 'SUSPECT_ROUND_QUANTITY' }); // every peer quantity is a suspect round number
  const raw = candidate({
    unit_price: { value: 1.2, basis: 'QUOTED' }, landed_cost: { freight_per_unit: { value: 0.4, basis: 'QUOTED' } }, // duties missing
    moq: { value: 12, basis: 'QUOTED' }, expected_retail_price: { value: 4.5, tax_basis: 'excl', basis: 'ASSUMPTION' },
  });
  const r = run(raw, { facts });
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
  assert.equal(check(r, 'peer_exposure').status, 'BLOCKED');
  assert.equal(check(r, 'unit_margin').status, 'INCOMPLETE'); // duties are missing, not zero
  assert.equal(check(r, 'test_capital').status, 'INCOMPLETE');
  assert.equal(check(r, 'test_capital').evidence.capital_at_risk.lower_bound, true);
  assert.ok(r.missing.some((m) => m.item === 'landed_cost.duties_per_unit_per_unit' || m.item === 'landed_cost.duties_per_unit'));
  assert.ok(r.unlocks.some((u) => u.check === 'peer_exposure' && u.needs[0].code === 'count_peer_stock'));
  assert.ok(!r.reason_codes.some((c) => c.endsWith('FAIL_ROBUST')));
});

test('example 3a: exposure already high on VERIFIED peer stock -> AVOID FOR NOW', () => {
  const facts = healthyPeerFacts({ noSaleUnits: 375, otherStock: 105 }); // 480 units, 78% with no sale in the window
  const raw = candidate({
    unit_price: { value: 12, basis: 'QUOTED' }, landed_cost: { freight_per_unit: { value: 1.5, basis: 'QUOTED' }, duties_per_unit: { value: 0.5, basis: 'QUOTED' } },
    moq: { value: 50, basis: 'QUOTED' }, expected_retail_price: { value: 32, tax_basis: 'excl', basis: 'DECIDED' },
  });
  const r = run(raw, { facts, config: policy({ testBudget: 1000 }), prepared: verifiedPrepared(facts) });
  const e = check(r, 'peer_exposure');
  const ev = e.evidence.by_peer_set[0];
  assert.equal(ev.stock_trust, 'TRUSTED');
  assert.equal(ev.no_sale_share, 0.7813);
  assert.equal(e.status, 'FAIL_ROBUST');
  assert.equal(check(r, 'unit_margin').status, 'PASS'); // the economics are fine: exposure is what rejects it
  assert.equal(r.verdict, VERDICTS.AVOID);
  assert.deepEqual(r.reason_codes, ['peer_exposure:FAIL_ROBUST']);
  assert.ok(ev.moq_weeks_of_supply_at_peer_median > 12);
});

test('example 3b: the SAME exposure on merely UNVERIFIED stock cannot reject -> NEED MORE DATA with what to count', () => {
  const facts = healthyPeerFacts({ noSaleUnits: 375, otherStock: 105 });
  const raw = candidate({
    unit_price: { value: 12, basis: 'QUOTED' }, landed_cost: { freight_per_unit: { value: 1.5, basis: 'QUOTED' }, duties_per_unit: { value: 0.5, basis: 'QUOTED' } },
    moq: { value: 50, basis: 'QUOTED' }, expected_retail_price: { value: 32, tax_basis: 'excl', basis: 'DECIDED' },
  });
  const r = run(raw, { facts, config: policy({ testBudget: 1000 }) });
  const e = check(r, 'peer_exposure');
  assert.equal(e.evidence.by_peer_set[0].stock_trust, 'UNVERIFIED');
  assert.equal(e.status, 'FAIL_CONDITIONAL');
  assert.deepEqual(e.conditional_on, ['PEER_STOCK_UNVERIFIED']);
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
  assert.ok(e.evidence.by_peer_set[0].largest_unverified_variants.length > 0);
  assert.ok(r.unlocks.find((u) => u.check === 'peer_exposure').needs.some((n) => n.code === 'verify_peer_stock'));
});

// ---------- Reliability rule for negative verdicts ----------

const lowMargin = (retailBasis, landed = { freight: 1, duties: 1 }) => candidate({
  unit_price: { value: 10, basis: 'QUOTED' },
  landed_cost: { freight_per_unit: { value: landed.freight, basis: 'QUOTED' }, ...(landed.duties != null ? { duties_per_unit: { value: landed.duties, basis: 'QUOTED' } } : {}) },
  expected_retail_price: { value: 15, tax_basis: 'excl', basis: retailBasis },
});

test('margin below hurdle: robust only with a DECIDED price and all-quoted costs', () => {
  const decided = run(lowMargin('DECIDED'));
  assert.equal(check(decided, 'unit_margin').status, 'FAIL_ROBUST');
  assert.equal(decided.verdict, VERDICTS.AVOID);

  const assumed = run(lowMargin('ASSUMPTION'));
  const m = check(assumed, 'unit_margin');
  assert.equal(m.status, 'FAIL_CONDITIONAL'); // an assumed price could be raised
  assert.ok(m.conditional_on.includes('EXPECTED_RETAIL_PRICE_IS_ASSUMPTION'));
  assert.ok(m.needs.some((n) => n.code === 'confirm_retail_price'));
  assert.equal(assumed.verdict, VERDICTS.MORE_DATA);
});

test('incomplete landed cost: a margin that fails EVEN AT ZERO for the missing component is robust; one that passes on a lower bound is INCOMPLETE', () => {
  // Duties missing. Best case treats them as 0: landed 11 -> margin (15-11-.375)/15 = 24% < 50%: adding duties can only make it worse.
  const robust = run(lowMargin('DECIDED', { freight: 1, duties: null }));
  const m = check(robust, 'unit_margin');
  assert.equal(m.status, 'FAIL_ROBUST');
  assert.deepEqual(m.evidence.landed_unit_cost.missing_components, ['duties']);
  assert.equal(m.evidence.landed_unit_cost.worst, null);

  // Passes only as a lower bound -> not a pass, not a rejection.
  const passing = run(candidate({ landed_cost: { freight_per_unit: { value: 0.6, basis: 'QUOTED' } } }));
  assert.equal(check(passing, 'unit_margin').status, 'INCOMPLETE');
  assert.equal(passing.verdict, VERDICTS.MORE_DATA);
});

test('estimated costs that straddle the hurdle are conditional, not a rejection', () => {
  const raw = candidate({
    unit_price: { value: 8, basis: 'QUOTED' }, landed_cost: { freight_per_unit: { value: 1, basis: 'ESTIMATED' }, duties_per_unit: { value: 1, basis: 'ESTIMATED' } },
    expected_retail_price: { value: 18, tax_basis: 'excl', basis: 'DECIDED' },
  }); // landed 10.00 nominal / 9.50 best / 10.50 worst -> margin 41.9% / 44.7% / 39.2%
  const r = run(raw, { config: policy({ minUnitMarginPct: 0.42 }) }); // hurdle between worst and best: the estimates decide
  assert.equal(check(r, 'unit_margin').status, 'FAIL_CONDITIONAL');
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
});

test('an ASSUMPTION cost component can never support a rejection', () => {
  const raw = lowMargin('DECIDED');
  raw.landed_cost.freight_per_unit = { value: 5, basis: 'ASSUMPTION' };
  assert.equal(check(run(raw), 'unit_margin').status, 'FAIL_CONDITIONAL');
});

test('capital: a quoted MOQ over the budget is robust; an estimated MOQ is conditional', () => {
  const big = candidate({ moq: { value: 200, basis: 'QUOTED' } }); // 200 x 5.00 = 1000 > 500
  const r = run(big);
  assert.equal(check(r, 'test_capital').status, 'FAIL_ROBUST');
  assert.equal(r.verdict, VERDICTS.AVOID);
  const est = run(candidate({ moq: { value: 200, basis: 'ESTIMATED' } }));
  assert.equal(check(est, 'test_capital').status, 'FAIL_CONDITIONAL');
  assert.equal(est.verdict, VERDICTS.MORE_DATA);
});

test('capability: a stated "no" rejects, "unknown" is incomplete', () => {
  const no = run(candidate({ required_capabilities: ['customization'], supplier_capabilities: { customization: 'no' } }));
  assert.equal(no.verdict, VERDICTS.AVOID);
  const unknown = run(candidate({ required_capabilities: ['customization'] }));
  assert.equal(check(unknown, 'capability_fit').status, 'INCOMPLETE');
  assert.equal(unknown.verdict, VERDICTS.MORE_DATA);
  assert.equal(run(candidate({ required_capabilities: ['customization'], supplier_capabilities: { customization: 'yes' } })).verdict, VERDICTS.TEST);
});

test('lead time: quoted over the limit rejects; estimated is conditional; no configured limit means not applicable', () => {
  assert.equal(run(candidate({ lead_time_days: { value: 90, basis: 'QUOTED' } })).verdict, VERDICTS.AVOID);
  assert.equal(check(run(candidate({ lead_time_days: { value: 90, basis: 'ESTIMATED' } })), 'lead_time').status, 'FAIL_CONDITIONAL');
  assert.equal(check(run(candidate(), { config: policy({ maxLeadTimeDays: null }) }), 'lead_time').status, 'NOT_APPLICABLE');
});

test('a sell-through failure alone never rejects: it asks for a smaller quantity or more evidence', () => {
  const r = run(candidate({ moq: { value: 100, basis: 'QUOTED' } }), { config: policy({ testBudget: 5000 }) }); // 100 / 1.2 = 83 weeks
  const s = check(r, 'sell_through');
  assert.equal(s.status, 'FAIL_CONDITIONAL');
  assert.match(s.needs[0].text, /at most 14/); // 12 weeks x 1.2/week
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
});

// ---------- Stock trust hierarchy ----------

test('stock hierarchy: TRUSTED may reject, UNVERIFIED cannot, unreliable BLOCKS; unverified may support a pass only if policy allows', () => {
  const hi = { noSaleUnits: 375, otherStock: 105 };
  const raw = candidate({ unit_price: { value: 12, basis: 'QUOTED' }, moq: { value: 50, basis: 'QUOTED' }, expected_retail_price: { value: 32, tax_basis: 'excl', basis: 'DECIDED' } });
  const cfg = policy({ testBudget: 1000 });
  const trusted = run(raw, { facts: healthyPeerFacts(hi), config: cfg, prepared: verifiedPrepared(healthyPeerFacts(hi)) });
  assert.equal(check(trusted, 'peer_exposure').status, 'FAIL_ROBUST');
  assert.equal(check(run(raw, { facts: healthyPeerFacts(hi), config: cfg }), 'peer_exposure').status, 'FAIL_CONDITIONAL');
  for (const quality of ['SUSPECT_ROUND_QUANTITY', 'STALE', 'NO_STOCK_DATA']) {
    assert.equal(check(run(raw, { facts: healthyPeerFacts({ ...hi, quality }), config: cfg }), 'peer_exposure').status, 'BLOCKED', quality);
  }
  const strict = policy({ stockTrust: { unverifiedMaySupportPass: false } });
  assert.equal(check(run(candidate(), { config: strict }), 'peer_exposure').status, 'INCOMPLETE');
  assert.equal(check(run(candidate()), 'peer_exposure').status, 'PASS'); // default: pass with a caveat
});

test('stock verification: a count only counts while it reconciles with Shopify', () => {
  const facts = mkFacts({ products: [], variants: [stockVariant('p', 'v1', 40)] });
  const variants = facts.variants;
  const ledger = buildLedger(makeDemandData(), { config: DEMAND_CONFIG });
  const prepared = prepareStockVerification([{ variant_id: 'v1', counted_units: 40, counted_at: '2026-09-20T12:00:00Z' }], ledger);
  const recon = (p, opts = {}) => reconcileVerification(p, variants, { now: NOW, maxAgeDays: 45, ...opts }).get('v1');
  assert.deepEqual(recon(prepared), { trusted: true, reason: 'RECONCILES' });
  const sold = new Map([['v1', { counted_units: 43, counted_at: new Date('2026-09-20T12:00:00Z'), units_sold_since: 3 }]]);
  assert.equal(recon(sold).trusted, true); // 43 counted - 3 sold = 40 in Shopify
  assert.match(recon(new Map([['v1', { counted_units: 50, counted_at: new Date('2026-09-20T12:00:00Z'), units_sold_since: 0 }]])).reason, /DOES_NOT_RECONCILE/);
  assert.equal(recon(new Map([['v1', { counted_units: 40, counted_at: new Date('2026-06-01T00:00:00Z'), units_sold_since: 0 }]])).reason, 'COUNT_TOO_OLD');
  assert.equal(recon(new Map([['v1', { counted_units: 40, counted_at: new Date('2026-09-21T08:00:00Z'), units_sold_since: 0 }]])).reason, 'STOCK_NOT_SYNCED_AFTER_COUNT');
  assert.equal(SNAPSHOT < '2026-09-21T08:00:00Z', true);
});

// ---------- Required price, exploratory, missing inputs ----------

test('the expected retail price is required: the peer median is never used as the selling price', () => {
  const raw = candidate();
  delete raw.expected_retail_price;
  const r = run(raw);
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
  assert.ok(check(r, 'inputs_complete').needs.some((n) => n.code === 'expected_retail_price' && /never used as the price/.test(n.text)));
  assert.equal(r.derived.retail_ex_tax.status, 'MISSING');
  assert.equal(check(r, 'unit_margin').status, 'INCOMPLETE');
});

test('a tax-inclusive price needs a tax rate; the rate is an assumption and keeps the margin conditional', () => {
  const raw = candidate({ expected_retail_price: { value: 21.78, tax_basis: 'incl', basis: 'DECIDED' } });
  assert.equal(check(run(raw), 'inputs_complete').needs[0].code, 'expected_retail_price.tax_rate');
  const r = run(raw, { config: policy({ taxRateAssumption: 0.21 }) });
  const m = check(r, 'unit_margin');
  assert.equal(m.evidence.retail_ex_tax, 18);
  assert.ok(m.conditional_on.includes('TAX_RATE_IS_ASSUMPTION'));
});

test('merchant money policies are never defaulted: without them the checks are INCOMPLETE', () => {
  const r = run(candidate(), { config: mergeConfig() });
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
  const codes = check(r, 'inputs_complete').needs.map((n) => n.code);
  assert.deepEqual(codes, ['config.testBudget', 'config.minUnitMarginPct', 'config.paymentCostPct']);
});

test('exploratory tests are OFF by default: no peers -> NEED MORE DATA', () => {
  const r = run(candidate({ peer_sets: [] }));
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
  assert.ok(check(r, 'inputs_complete').needs.some((n) => n.code === 'peer_sets'));
  const noEvidence = run(candidate({ peer_sets: [{ product_type: 'Nothing' }] }));
  assert.equal(check(noEvidence, 'peer_benchmark').status, 'BLOCKED');
});

test('exploratory tests when enabled: waives peer demand checks, caps capital at the exploratory budget, still respects economics', () => {
  const cfg = policy({ allowExploratoryTests: true, exploratoryBudget: 100 });
  const ok = run(candidate({ peer_sets: [] }), { config: cfg });
  assert.equal(ok.verdict, VERDICTS.TEST);
  assert.equal(ok.test_type, 'EXPLORATORY');
  assert.equal(check(ok, 'peer_benchmark').status, 'WAIVED');
  assert.equal(ok.conditions.budget_kind, 'exploratory');
  // 12 x 5.00 = 60 fits; MOQ 30 -> 150 > 100 exceeds even the exploratory budget on quoted numbers.
  const over = run(candidate({ peer_sets: [], moq: { value: 30, basis: 'QUOTED' } }), { config: cfg });
  assert.equal(over.verdict, VERDICTS.AVOID);
  assert.equal(over.checks.find((c) => c.id === 'test_capital').evidence.budget_kind, 'exploratory');
  // A usable peer benchmark means it is an evidence-supported test, not exploratory.
  assert.equal(run(candidate(), { config: cfg }).test_type, 'EVIDENCE_SUPPORTED');
  // Bad economics still reject an exploratory test.
  assert.equal(run({ ...lowMargin('DECIDED'), peer_sets: [] }, { config: cfg }).verdict, VERDICTS.AVOID);
  // Exploratory enabled but no budget set: incomplete, not free.
  assert.ok(check(run(candidate({ peer_sets: [] }), { config: policy({ allowExploratoryTests: true }) }), 'inputs_complete').needs.some((n) => n.code === 'config.exploratoryBudget'));
});

// ---------- Peer sets, identity ----------

test('peer benchmarks: thin sets are INCOMPLETE, unresolved ids are reported, non-active and too-new products do not count', () => {
  const facts = mkFacts({
    products: [
      peer({ id: 'a', collections: ['c1'], units: 4, velocity: 0.5, price: 10, stock: 5, cls: 'ACTIVE_COVER' }),
      peer({ id: 'b', collections: ['c1'], units: 4, velocity: 0.5, price: 12, stock: 5, cls: 'ACTIVE_COVER' }),
      peer({ id: 'draft', collections: ['c1'], units: 9, velocity: 1, price: 9, status: 'DRAFT' }),
      peer({ id: 'new', collections: ['c1'], observable: 2, units: 5, velocity: 2, price: 9 }),
    ],
    variants: [],
  });
  const r = run(candidate({ peer_sets: [{ collection_ids: ['c1', 'missing-collection'] }] }), { facts });
  const set = r.facts.peer_sets[0];
  assert.equal(set.observable_peers, 2);
  assert.equal(set.selling_peers, 2);
  assert.equal(set.quality, 'THIN'); // needs 3
  assert.equal(set.non_active_excluded, 1);
  assert.deepEqual(set.unresolved_ids, ['missing-collection']);
  assert.equal(set.velocity.median, null); // no point estimate from a thin set
  assert.deepEqual(set.velocity.observed, [0.5, 0.5]);
  assert.equal(check(r, 'peer_benchmark').status, 'INCOMPLETE');
});

test('multiple peer sets are evaluated separately and never blended; the most severe result decides', () => {
  const facts = healthyPeerFacts();
  facts.products.push(peer({ id: 'x1', type: 'Other', stock: 100 }), peer({ id: 'x2', type: 'Other', stock: 100 }));
  const r = run(candidate({ peer_sets: [{ collection_ids: ['c-main'] }, { product_type: 'Other' }] }), { facts });
  assert.equal(r.facts.peer_sets.length, 2);
  assert.equal(r.facts.peer_sets[0].quality, 'USABLE');
  assert.equal(r.facts.peer_sets[1].quality, 'NO_DEMAND_EVIDENCE');
  assert.equal(check(r, 'peer_benchmark').status, 'PASS'); // one usable set is enough for a benchmark
  assert.equal(check(r, 'sell_through').evidence.by_peer_set.length, 1); // only usable sets feed demand
});

test('SKU is never an identity: sku fields are ignored with a warning, supplier refs are free text, duplicates are allowed', () => {
  const r = run(candidate({ sku: 'SHARED', supplier_item_ref: 'A-1' }));
  assert.ok(r.validation_warnings.some((w) => /never an identity/.test(w)));
  assert.equal(r.inputs.supplier_item_ref, 'A-1');
  const two = [run(candidate({ candidate_id: 'c1', supplier_item_ref: 'SAME' })), run(candidate({ candidate_id: 'c2', supplier_item_ref: 'SAME' }))];
  assert.notEqual(two[0].candidate_id, two[1].candidate_id);
});

test('a foreign-currency candidate needs the merchant\'s fx assumption, and converted quotes drop to ESTIMATED', () => {
  const raw = candidate({ currency: 'USD' });
  assert.ok(check(run(raw), 'inputs_complete').needs.some((n) => n.code === 'fx_rate_assumption'));
  const c = normalizeCandidate({ ...raw, fx_rate_assumption: 0.9 }, { merchantCurrency: 'EUR' }).candidate;
  const L = landedCost(c, { merchantCurrency: 'EUR', tol: 0.25 });
  assert.equal(L.basis, 'ESTIMATED');
  assert.equal(Math.round(L.nominal * 1000) / 1000, 4.5); // (4 + .6 + .4) x 0.9
  assert.ok(L.worst > L.nominal);
});

test('contract validation: malformed files are rejected with precise errors', () => {
  const bad = evaluateCandidate({ rawCandidate: { candidate_id: 'x', unit_price: -1, peer_sets: [{ product_type: 'UNCLASSIFIED' }, { collection_ids: ['a'], product_type: 'b' }], moq: { value: 5, basis: 'GUESS' } }, demandFacts: healthyPeerFacts(), config: policy(), now: NOW });
  assert.equal(bad.reason_codes[0], 'INVALID_CANDIDATE_FILE');
  assert.ok(bad.validation_errors.length >= 3);
  assert.equal(evaluateCandidate({ rawCandidate: { unit_price: 1 }, demandFacts: healthyPeerFacts(), config: policy(), now: NOW }).reason_codes[0], 'INVALID_CANDIDATE_FILE');
});

// ---------- Structure, determinism, configuration ----------

test('output separates facts, inputs, assumptions, missing, derived and blocked conclusions, and carries provenance', () => {
  const r = run(candidate({ landed_cost: { freight_per_unit: { value: 0.6, basis: 'ESTIMATED' } }, expected_retail_price: { value: 18, tax_basis: 'excl', basis: 'ASSUMPTION' } }));
  for (const k of ['facts', 'inputs', 'assumptions', 'missing', 'derived', 'blocked_conclusions', 'checks', 'unlocks']) assert.ok(k in r, k);
  assert.ok(r.assumptions.some((a) => a.item === 'expected_retail_price' && a.basis === 'ASSUMPTION'));
  assert.ok(r.assumptions.some((a) => a.item === 'landed_cost.freight_per_unit' && a.basis === 'ESTIMATED'));
  assert.equal(r.derived.landed_unit_cost.lower_bound, true);
  assert.equal(r.facts.source.history_days, 55);
  assert.equal(r.facts.gates.margin, 'GATED');
  assert.equal(r.blocked_conclusions.find((b) => b.id === 'margin_vs_existing_products').status, 'BLOCKED');
  assert.equal(r.derived.arrival_date_if_ordered_now, '2026-10-21');
});

test('no numeric score anywhere, and the result is deterministic', () => {
  const a = run(candidate());
  const b = run(candidate());
  assert.deepEqual(a, b);
  assert.ok(!/"score"|opportunity_score|"rank"/.test(JSON.stringify(a)));
});

test('required checks are merchant-editable: a non-required check reports but cannot decide', () => {
  const raw = candidate({ lead_time_days: { value: 90, basis: 'QUOTED' } });
  assert.equal(run(raw).verdict, VERDICTS.AVOID);
  const r = run(raw, { config: policy({ requiredChecks: ['inputs_complete', 'unit_margin', 'test_capital', 'peer_benchmark', 'sell_through', 'peer_exposure', 'capability_fit'] }) });
  assert.equal(check(r, 'lead_time').status, 'FAIL_ROBUST');
  assert.equal(check(r, 'lead_time').required, false);
  assert.equal(r.verdict, VERDICTS.TEST);
});

test('percentiles interpolate; a robust rejection outranks open questions', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([], 0.5), null);
  const facts = healthyPeerFacts({ quality: 'STALE' }); // exposure BLOCKED
  const r = run(lowMargin('DECIDED'), { facts });
  assert.equal(check(r, 'peer_exposure').status, 'BLOCKED');
  assert.equal(r.verdict, VERDICTS.AVOID); // a trustworthy rejection stands even while other questions are open
});

test('integration: evaluates against facts produced by the real Phase 2B builder', () => {
  const data = makeDemandData();
  const ledger = buildLedger(data, { config: DEMAND_CONFIG });
  const facts = buildDemandFacts({ ledger, data, now: DEMAND_NOW, timeZone: TZ, config: DEMAND_CONFIG, salesReconciled: true });
  const cfg = mergeConfig({ buying: { testBudget: 500, minUnitMarginPct: 0.5, paymentCostPct: 0.02 } });
  const r = evaluateCandidate({
    rawCandidate: candidate({ peer_sets: [{ product_type: 'Beta' }], expected_retail_price: { value: 16.53, tax_basis: 'excl', basis: 'ASSUMPTION' } }),
    demandFacts: facts, config: cfg, now: DEMAND_NOW,
  });
  assert.equal(r.facts.peer_sets[0].quality, 'USABLE'); // 4 selling Beta products
  assert.equal(r.facts.peer_sets[0].selling_peers, 4);
  assert.ok(r.facts.peer_sets[0].stock_trust.total_units > 0);
  assert.equal(r.blocked_conclusions.find((b) => b.id === 'capital_exposure_value').status, 'BLOCKED');
});

// ---------- Null policy safety (a placeholder template must never decide anything) ----------

const fromFile = async (path) => {
  const { readFile } = await import('node:fs/promises');
  return mergeConfig(JSON.parse(await readFile(path, 'utf8')));
};

test('the all-null policy template yields NEED MORE DATA listing every unset decision - never AVOID or TEST', async () => {
  const cfg = await fromFile('docs/examples/buying-policy.example.json');
  const r = run(candidate(), { config: cfg });
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
  const codes = check(r, 'inputs_complete').needs.map((n) => n.code).sort();
  assert.deepEqual(codes, [
    'config.exposure.coverWeeks', 'config.exposure.noSaleShare', 'config.maxSellThroughWeeks', 'config.minUnitMarginPct', 'config.paymentCostPct',
    'config.stockTrust.blockedShare', 'config.stockTrust.trustedShare', 'config.testBudget',
  ]);
  assert.ok(!r.reason_codes.some((c) => c.endsWith('FAIL_ROBUST')));
  assert.equal(check(r, 'lead_time').status, 'NOT_APPLICABLE');
  assert.ok(r.caveats.includes('LEAD_TIME_LIMIT_NOT_CONFIGURED'));
});

test('unset thresholds are never compared as 0: horizon, exposure and stock-trust thresholds produce INCOMPLETE, not a verdict', () => {
  const hi = healthyPeerFacts({ noSaleUnits: 375, otherStock: 105 });
  const raw = candidate({ unit_price: { value: 12, basis: 'QUOTED' }, moq: { value: 50, basis: 'QUOTED' }, expected_retail_price: { value: 32, tax_basis: 'excl', basis: 'DECIDED' } });
  const base = { testBudget: 1000 };
  const noHorizon = run(raw, { facts: hi, config: policy({ ...base, maxSellThroughWeeks: null }) });
  assert.equal(check(noHorizon, 'sell_through').status, 'INCOMPLETE');
  assert.equal(check(noHorizon, 'peer_exposure').status, 'INCOMPLETE');
  const noExposure = run(raw, { facts: hi, config: policy({ ...base, exposure: { noSaleShare: null } }) });
  assert.equal(check(noExposure, 'peer_exposure').status, 'INCOMPLETE');
  const noTrust = run(raw, { facts: hi, config: policy({ ...base, stockTrust: { blockedShare: null } }), prepared: verifiedPrepared(hi) });
  assert.equal(check(noTrust, 'peer_exposure').status, 'INCOMPLETE'); // not BLOCKED, not TRUSTED
  assert.notEqual(noTrust.verdict, VERDICTS.AVOID);
});

test('unverifiedMaySupportPass left null is the strict reading (no pass on unverified stock)', () => {
  const r = run(candidate(), { config: policy({ stockTrust: { unverifiedMaySupportPass: null } }) });
  assert.equal(check(r, 'peer_exposure').status, 'INCOMPLETE');
});

// ---------- Policy sensitivity tool ----------

test('policy sensitivity: varies one setting at a time around the operator baseline, shows verdict changes, skips unset settings', async () => {
  const { runSensitivity, renderSensitivity } = await import('../src/buying/calibrate.js');
  const raw = candidate({ expected_retail_price: { value: 10, tax_basis: 'excl', basis: 'DECIDED' } }); // margin 47.5%
  const basePolicy = { buying: { testBudget: 500, minUnitMarginPct: 0.5, paymentCostPct: 0.025, maxSellThroughWeeks: 12, exposure: { noSaleShare: 0.6, coverWeeks: 26 }, stockTrust: { blockedShare: 0.2, trustedShare: 0.8, unverifiedMaySupportPass: true } } };
  const out = runSensitivity({ rawCandidate: raw, policy: basePolicy, demandFacts: healthyPeerFacts(), preparedVerification: new Map(), now: NOW });
  assert.equal(out.baseline.verdict, VERDICTS.AVOID); // 47.5% < 50%
  const margin = out.rows.filter((r) => r.setting === 'minUnitMarginPct');
  assert.deepEqual(margin.map((r) => r.value), [0.4, 0.5, 0.6]);
  assert.deepEqual(margin.map((r) => r.verdict), [VERDICTS.TEST, VERDICTS.AVOID, VERDICTS.AVOID]); // a looser hurdle admits it
  assert.equal(margin.find((r) => r.value === 0.5).is_baseline, true);
  const budget = out.rows.filter((r) => r.setting === 'testBudget').map((r) => r.value);
  assert.deepEqual(budget, [250, 500, 1000]);
  assert.ok(out.skipped.some((s) => s.setting === 'maxLeadTimeDays' && /unset/.test(s.reason))); // never invents a baseline
  assert.ok(out.skipped.some((s) => s.setting === 'allowExploratoryTests'));
  assert.match(renderSensitivity('c', out), /not recommendations/);
  // The input policy object is not mutated by the sweeps.
  assert.equal(basePolicy.buying.minUnitMarginPct, 0.5);
});

test('an unfilled count-sheet row is not a count: it is ignored, never treated as zero stock', () => {
  const ledger = buildLedger(makeDemandData(), { config: DEMAND_CONFIG });
  const prepared = prepareStockVerification([
    { variant_id: 'v1', counted_units: null, counted_at: null }, { variant_id: 'v2', counted_units: 5, counted_at: null },
    { variant_id: 'v3', counted_units: 0, counted_at: '2026-09-20T12:00:00Z' },
  ], ledger);
  assert.deepEqual([...prepared.keys()], ['v3']); // a real count of 0 is kept; blanks are not
});

test('unknown stays unknown: a template with null values is valid and reports exactly what is missing', async () => {
  const { readFile } = await import('node:fs/promises');
  const template = JSON.parse(await readFile('data/local/habb/candidate.template.json', 'utf8').catch(() => '{"candidate_id":"T","unit_price":{"value":null,"basis":"QUOTED"},"moq":{"value":null,"basis":"QUOTED","per":"per_order"},"lead_time_days":{"value":null,"basis":"QUOTED"},"landed_cost":{"freight_per_unit":{"value":null,"basis":"ESTIMATED"},"duties_per_unit":{"value":null,"basis":"ESTIMATED"},"other_per_unit":null,"not_applicable":[]},"expected_retail_price":{"value":null,"tax_basis":"incl","basis":"ASSUMPTION"},"peer_sets":[]}'));
  const r = run(template, { config: policy() });
  assert.notEqual(r.reason_codes[0], 'INVALID_CANDIDATE_FILE');
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
  const codes = check(r, 'inputs_complete').needs.map((n) => n.code);
  for (const c of ['unit_price', 'moq', 'expected_retail_price', 'peer_sets']) assert.ok(codes.includes(c), c);
  // A genuinely malformed number is still rejected.
  assert.equal(evaluateCandidate({ rawCandidate: { candidate_id: 'x', unit_price: { value: -3 } }, demandFacts: healthyPeerFacts(), config: policy(), now: NOW }).reason_codes[0], 'INVALID_CANDIDATE_FILE');
});

test('reference peers are named by Shopify product id (gid or the numeric admin id); internal database keys are never accepted', () => {
  const facts = mkFacts({
    products: [
      { ...peer({ id: 'a', units: 4, velocity: 0.5, price: 10, stock: 5, cls: 'ACTIVE_COVER' }), shopify_product_id: 'gid://shopify/Product/111' },
      { ...peer({ id: 'b', units: 4, velocity: 0.7, price: 12, stock: 5, cls: 'ACTIVE_COVER' }), shopify_product_id: 'gid://shopify/Product/222' },
      { ...peer({ id: 'c', units: 4, velocity: 0.9, price: 14, stock: 5, cls: 'ACTIVE_COVER' }), shopify_product_id: 'gid://shopify/Product/333' },
    ],
    variants: [],
  });
  const set = (ids) => run(candidate({ peer_sets: [{ reference_product_ids: ids }] }), { facts }).facts.peer_sets[0];
  const mixed = set(['gid://shopify/Product/111', '222', '333']);
  assert.equal(mixed.peers_total, 3); // gid and numeric ids both resolve
  assert.equal(mixed.quality, 'USABLE');
  const internal = set(['a', 'b']); // internal product_key values are not identities here
  assert.equal(internal.peers_total, 0);
  assert.deepEqual(internal.unresolved_ids, ['a', 'b']);
});

// ---------- Provisional policy and decided-price requirement ----------

test('a provisional policy value can never support a rejection: it is withheld and named for confirmation', () => {
  const raw = lowMargin('DECIDED'); // margin far below the hurdle, decided price, all-quoted costs
  assert.equal(run(raw).verdict, VERDICTS.AVOID);
  const r = run(raw, { config: policy({ provisional: ['minUnitMarginPct'] }) });
  const m = check(r, 'unit_margin');
  assert.equal(m.status, 'FAIL_CONDITIONAL');
  assert.ok(m.conditional_on.includes('PROVISIONAL_POLICY:minUnitMarginPct'));
  assert.ok(m.needs.some((n) => n.code === 'confirm_policy_minUnitMarginPct'));
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
  assert.ok(r.caveats.includes('PROVISIONAL_POLICY:minUnitMarginPct'));
});

test('provisional values still allow a pass, but the result carries them as caveats; non-provisional values still reject', () => {
  const ok = run(candidate(), { config: policy({ provisional: ['minUnitMarginPct', 'paymentCostPct'] }) });
  assert.equal(ok.verdict, VERDICTS.TEST);
  assert.ok(ok.caveats.includes('PROVISIONAL_POLICY:minUnitMarginPct') && ok.caveats.includes('PROVISIONAL_POLICY:paymentCostPct'));
  // The lead-time limit is not provisional here, so a quoted breach still rejects.
  const late = run(candidate({ lead_time_days: { value: 90, basis: 'QUOTED' } }), { config: policy({ provisional: ['minUnitMarginPct'] }) });
  assert.equal(late.verdict, VERDICTS.AVOID);
});

test('provisional exposure thresholds withhold a stock-based rejection even on trusted stock', () => {
  const facts = healthyPeerFacts({ noSaleUnits: 375, otherStock: 105 });
  const raw = candidate({ unit_price: { value: 12, basis: 'QUOTED' }, moq: { value: 50, basis: 'QUOTED' }, expected_retail_price: { value: 32, tax_basis: 'excl', basis: 'DECIDED' } });
  const base = { testBudget: 1000 };
  assert.equal(run(raw, { facts, config: policy(base), prepared: verifiedPrepared(facts) }).verdict, VERDICTS.AVOID);
  const r = run(raw, { facts, config: policy({ ...base, provisional: ['exposure.noSaleShare'] }), prepared: verifiedPrepared(facts) });
  assert.equal(check(r, 'peer_exposure').status, 'FAIL_CONDITIONAL');
  assert.equal(r.verdict, VERDICTS.MORE_DATA);
});

test('requireDecidedRetailPrice: an assumed price makes the inputs incomplete; a decided price passes', () => {
  const cfg = policy({ requireDecidedRetailPrice: true });
  const assumed = run(candidate({ expected_retail_price: { value: 18, tax_basis: 'excl', basis: 'ASSUMPTION' } }), { config: cfg });
  assert.equal(check(assumed, 'inputs_complete').status, 'INCOMPLETE');
  assert.ok(check(assumed, 'inputs_complete').needs.some((n) => n.code === 'expected_retail_price.basis'));
  assert.equal(assumed.verdict, VERDICTS.MORE_DATA);
  assert.equal(run(candidate(), { config: cfg }).verdict, VERDICTS.TEST); // candidate() price is DECIDED
  assert.equal(run(candidate({ expected_retail_price: { value: 18, tax_basis: 'excl', basis: 'ASSUMPTION' } })).verdict, VERDICTS.TEST); // option is off by default
});

test('a confirmed tax rate (QUOTED) is trusted for a rejection; a merely assumed rate is not', () => {
  const inclusive = (rate) => candidate({
    unit_price: { value: 10, basis: 'QUOTED' }, landed_cost: { freight_per_unit: { value: 1, basis: 'QUOTED' }, duties_per_unit: { value: 1, basis: 'QUOTED' } },
    expected_retail_price: { value: 18.15, tax_basis: 'incl', basis: 'DECIDED', tax_rate: rate }, // 15.00 ex tax at 21%
  });
  const confirmed = run(inclusive({ value: 0.21, basis: 'QUOTED' }));
  assert.equal(check(confirmed, 'unit_margin').evidence.retail_ex_tax, 15);
  assert.equal(check(confirmed, 'unit_margin').status, 'FAIL_ROBUST');
  assert.equal(check(run(inclusive({ value: 0.21, basis: 'ASSUMPTION' })), 'unit_margin').status, 'FAIL_CONDITIONAL');
});
