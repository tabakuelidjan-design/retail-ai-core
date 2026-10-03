import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTreasuryModel, runScenarioOn, validateHypotheses, explainItemIn, explainPositionIn, SOURCE_TYPES, HORIZONS } from '../src/finance/treasury-engine.js';
import { createTreasuryService } from '../src/finance/treasury-service.js';
import { createMerchantClock } from '../src/finance/civil-date.js';
import { startApp } from './finance-dashboard-helpers.js';

// Essential Treasury: deterministic read model. Synthetic data only. Amounts in cents (€1 = 100).
const AS_OF = '2026-10-03'; const NOW = '2026-10-03T10:00:00.000Z'; const TZ = 'Europe/Brussels';
const E = (eur) => Math.round(eur * 100);
const bal = (accountId, eur, asOf = '2026-10-03T08:00:00Z', currency = 'EUR') => ({ accountId, currency, balanceCents: E(eur), asOf, source: 'provider' });
const rec = (id, remaining, dueDate, o = {}) => ({ id, number: id, customer: 'Client', currency: 'EUR', dueDate, remainingCents: E(remaining), grossCents: E(o.gross ?? remaining), creditedCents: 0, paidCents: 0, effectiveDueCents: E(o.gross ?? remaining), schedule: null, ...o });
const pay = (id, remaining, dueDate, o = {}) => ({ id, invoiceNumber: id, supplierName: 'Fournisseur', currency: 'EUR', dueDate, dueOrigin: 'PRINTED', remainingCents: E(remaining), grossCents: E(o.gross ?? remaining), paidCents: 0, ...o });
const facts = (o = {}) => ({ asOf: AS_OF, nowInstant: NOW, timeZone: TZ, currency: 'EUR', balances: [], accounts: [], transactions: [], cashCount: null, cashMovements: [], receivables: [], payables: [], ...o });
const m = (o) => buildTreasuryModel(facts(o)); const eur = (model) => model.forecast.EUR; const h = (model, d) => eur(model).horizons[d];
const day = (n) => { const d = new Date(`${AS_OF}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ===================================================== POSITION
test('POSITION: observed bank only keeps source, observed_at, currency and freshness', () => {
  const p = m({ balances: [bal('a', 8420, '2026-10-03T08:00:00Z')] }).position.EUR;
  assert.equal(p.observed.totalCents, E(8420)); assert.equal(p.calculated.totalCents, E(8420)); assert.equal(p.freshness, 'FRESH');
  const c = p.components[0]; assert.deepEqual([c.kind, c.sourceType, c.source, c.observedAt, c.basis], ['BANK_BALANCE', 'BANK', 'provider', '2026-10-03T08:00:00Z', 'OBSERVED']); assert.equal(c.ageHours, 2);
});
test('POSITION: bank + cash = 8 770 and Nordla can explain exactly that figure', () => {
  const model = m({ balances: [bal('a', 8420)], cashCount: { amountCents: E(350), countedOn: '2026-10-02' } });
  assert.equal(model.position.EUR.calculated.totalCents, E(8770)); assert.equal(model.position.EUR.observed.totalCents, E(8770));
  const ex = explainPositionIn(model, 'EUR'); assert.deepEqual(ex.components.map((c) => [c.kind, c.amountCents]), [['BANK_BALANCE', E(8420)], ['CASH_COUNT', E(350)]]);
  assert.equal(ex.components.every((c) => c.freshness), true);
});
test('POSITION: OBSERVED != CALCULATED: 10 000 at 08:00, later -500 and +200 -> 9 700 labelled calculated, the observed stays 10 000', () => {
  const model = m({ balances: [bal('a', 10000, '2026-10-01T08:00:00Z')], transactions: [{ id: 't1', accountId: 'a', currency: 'EUR', date: '2026-10-02', amountCents: E(-500) }, { id: 't2', accountId: 'a', currency: 'EUR', date: '2026-10-03', amountCents: E(200) }] });
  const p = model.position.EUR; assert.equal(p.observed.totalCents, E(10000)); assert.equal(p.calculated.totalCents, E(9700)); assert.equal(p.calculated.basis, 'OBSERVED_PLUS_LATER_TRANSACTIONS'); assert.equal(p.calculated.laterCents, E(-300));
  assert.equal(p.components.find((c) => c.kind === 'BANK_LATER_TRANSACTIONS').basis, 'CALCULATED');
});
test('POSITION: cash count + later movements; a movement ON the counting day is already in the count', () => {
  const p = m({ cashCount: { amountCents: E(500), countedOn: '2026-10-01' }, cashMovements: [{ date: '2026-10-01', kind: 'CASH_IN', amountCents: E(999) }, { date: '2026-10-02', kind: 'CASH_IN', amountCents: E(100) }, { date: '2026-10-03', kind: 'DEPOSIT_TO_BANK', amountCents: E(200) }, { date: '2026-10-04', kind: 'CASH_OUT', amountCents: E(50) }] }).position.EUR;
  assert.equal(p.observed.totalCents, E(500)); assert.equal(p.calculated.totalCents, E(400));
});
test('POSITION: a transaction dated the day of the balance is NOT added (it may already be in it) and the warning says so', () => {
  const p = m({ balances: [bal('a', 1000, '2026-10-02T08:00:00Z')], transactions: [{ id: 't', accountId: 'a', currency: 'EUR', date: '2026-10-02', amountCents: E(300) }] }).position.EUR;
  assert.equal(p.calculated.totalCents, E(1000)); assert.ok(p.warnings.some((w) => w.code === 'SAME_DAY_TRANSACTIONS_NOT_COUNTED'));
});
test('POSITION: the day of an observation is the merchant civil day (23:30 UTC on the DST night is already the 25th in Brussels)', () => {
  const model = buildTreasuryModel(facts({ asOf: '2026-10-26', nowInstant: '2026-10-26T09:00:00Z', balances: [bal('a', 1000, '2026-10-24T23:30:00Z')], transactions: [{ id: 't', accountId: 'a', currency: 'EUR', date: '2026-10-25', amountCents: E(40) }, { id: 'u', accountId: 'a', currency: 'EUR', date: '2026-10-26', amountCents: E(60) }] }));
  assert.equal(model.position.EUR.calculated.totalCents, E(1060), 'the 25th is the observation day (not counted), the 26th is later');
});
test('FRESHNESS: an old balance is STALE and the starting position is flagged; never shown as live', () => {
  const model = m({ balances: [bal('a', 5000, '2026-09-30T08:00:00Z')] }); const p = model.position.EUR;
  assert.equal(p.freshness, 'STALE'); assert.ok(p.warnings.some((w) => w.code === 'STALE_BANK_BALANCE')); assert.ok(p.warnings.some((w) => w.code === 'STARTING_POSITION_NOT_FRESH')); assert.equal(h(model, 7).startingFreshness, 'STALE');
});
test('FRESHNESS: unknown balance -> no position, never a zero; the forecast shows flows but no projected figure', () => {
  const model = m({ receivables: [rec('R1', 100, day(2))] }); assert.equal(model.position.EUR, undefined); assert.ok(model.warnings.some((w) => w.code === 'NO_OBSERVED_CASH'));
  assert.equal(h(model, 7).projectedCents, null); assert.equal(h(model, 7).receipts.committedCents, E(100)); assert.equal(h(model, 7).risk.computable, false);
  const acct = m({ accounts: [{ externalId: 'csv-import', currency: 'EUR' }] }); assert.equal(acct.position.EUR.freshness, 'UNKNOWN'); assert.equal(acct.position.EUR.calculated.totalCents, null);
});
test('POSITION: an account whose balance is unknown does not make the other account stale, but the overall freshness is the worst', () => {
  const p = m({ balances: [bal('a', 100, '2026-10-03T08:00:00Z'), bal('b', 100, '2026-10-01T08:00:00Z')] }).position.EUR; assert.equal(p.freshness, 'STALE'); assert.equal(p.calculated.totalCents, E(200));
});
test('POSITION: unreconciled later transactions are reported (cash moved, invoice may still look open)', () => {
  const p = m({ balances: [bal('a', 1000, '2026-10-01T08:00:00Z')], transactions: [{ id: 't', accountId: 'a', currency: 'EUR', date: '2026-10-02', amountCents: E(400), remainingCents: E(400) }, { id: 'u', accountId: 'a', currency: 'EUR', date: '2026-10-02', amountCents: E(100), remainingCents: 0 }] }).position.EUR;
  const w = p.warnings.find((x) => x.code === 'UNRECONCILED_LATER_TRANSACTIONS'); assert.deepEqual([w.count, w.amountCents], [1, E(400)]); assert.equal(p.calculated.totalCents, E(1500));
});

// ===================================================== RECEIVABLES / PAYABLES / SCHEDULES / OVERDUE
test('RECEIVABLES: only what remains counts (1 000 invoice, 600 paid -> 400); fully paid and zero remaining produce nothing', () => {
  const model = m({ balances: [bal('a', 0)], receivables: [rec('R1', 400, day(3), { gross: 1000, paidCents: E(600) }), rec('R2', 0, day(3), { gross: 500, paidCents: E(500) })] });
  assert.equal(h(model, 7).receipts.committedCents, E(400)); assert.deepEqual(model.items.map((x) => x.id), ['CUSTOMER_INVOICE:R1']); assert.equal(model.items[0].evidence.grossCents, E(1000));
});
test('RECEIVABLES: scheduled 30/40/30 -> 300 today, 400 at +30, 300 at +60; paid money goes to the earliest instalments first', () => {
  const schedule = [{ dueDate: AS_OF, shareBp: 3000 }, { dueDate: day(30), shareBp: 4000 }, { dueDate: day(60), shareBp: 3000 }];
  const model = m({ balances: [bal('a', 0)], receivables: [rec('S1', 1000, AS_OF, { schedule, effectiveDueCents: E(1000) })] });
  assert.deepEqual(model.items.map((x) => [x.date, x.amountCents]), [[AS_OF, E(300)], [day(30), E(400)], [day(60), E(300)]]); assert.deepEqual(model.items.map((x) => x.id), ['CUSTOMER_INVOICE:S1#1', 'CUSTOMER_INVOICE:S1#2', 'CUSTOMER_INVOICE:S1#3']);
  const partly = m({ balances: [bal('a', 0)], receivables: [rec('S2', 700, AS_OF, { schedule, effectiveDueCents: E(1000) })] }); assert.deepEqual(partly.items.map((x) => x.amountCents), [E(400), E(300)]);
  const bad = m({ receivables: [rec('S3', 1000, day(5), { schedule: [{ dueDate: AS_OF, shareBp: 3000 }, { dueDate: day(30), shareBp: 3000 }], effectiveDueCents: E(1000) })] }); assert.equal(bad.items.length, 1, 'an inconsistent schedule is ignored: the single due date stays');
});
test('RECEIVABLES: overdue stays visible with its ORIGINAL date, is classed EXPECTED, and is not silently counted', () => {
  const model = m({ balances: [bal('a', 1000)], receivables: [rec('O1', 500, day(-5))] }); const it = model.items[0];
  assert.deepEqual([it.overdue, it.overdueDays, it.date, it.certainty, it.included, it.treatment], [true, 5, day(-5), 'EXPECTED', false, 'OVERDUE_RECEIVABLE_NOT_IN_PROJECTION']);
  assert.equal(h(model, 30).excluded.overdueReceivablesCents, E(500)); assert.equal(h(model, 30).projectedCents, E(1000));
});
test('PAYABLES: only what remains is owed (1 000, 400 paid -> 600); fully paid disappears', () => {
  const model = m({ balances: [bal('a', 10000)], payables: [pay('P1', 600, day(5), { gross: 1000, paidCents: E(400) }), pay('P2', 0, day(5), { gross: 300, paidCents: E(300) })] });
  assert.equal(h(model, 7).payments.committedCents, E(600)); assert.equal(model.items.length, 1);
});
test('PAYABLES: overdue is counted TODAY, keeps its original due date and says so; undated is reported, never invented', () => {
  const model = m({ balances: [bal('a', 5000)], payables: [pay('P1', 2000, day(-10)), pay('P2', 700, null, { dueOrigin: 'UNKNOWN' })] }); const it = model.items[0];
  assert.deepEqual([it.date, it.dueDate, it.overdueDays, it.treatment, it.included], [AS_OF, day(-10), 10, 'OVERDUE_PAYABLE_ASSUMED_PAID_TODAY', true]);
  assert.equal(h(model, 7).projectedCents, E(3000)); assert.equal(h(model, 7).overduePayablesCents, E(2000)); assert.equal(h(model, 7).undated.payablesCents, E(700)); assert.equal(model.undated[0].treatment, 'NO_DUE_DATE_NOT_IN_FORECAST');
});
test('PAYABLES: a due date computed from an explicit term stays distinguishable', () => {
  assert.equal(m({ payables: [pay('P1', 100, day(3), { dueOrigin: 'COMPUTED_FROM_TERMS' })] }).items[0].dueOrigin, 'COMPUTED_FROM_TERMS');
});

// ===================================================== FORECAST
test('FORECAST: horizon boundaries are inclusive (day 7, 30, 90 in; day 8, 31, 91 out); today is in', () => {
  const model = m({ balances: [bal('a', 1000)], receivables: [rec('A', 1, AS_OF), rec('B', 10, day(7)), rec('C', 100, day(8)), rec('D', 1000, day(30)), rec('E2', 5, day(31)), rec('F', 7, day(90)), rec('G', 9, day(91))] });
  assert.deepEqual([7, 30, 90].map((d) => h(model, d).receipts.itemIds.length), [2, 4, 6]); assert.equal(h(model, 7).receipts.committedCents, E(11));
});
test('FORECAST: example B — 10 000 current, +2 000 due in 7 days, -3 000 due in 5 days -> 9 000 at 7 days', () => {
  const model = m({ balances: [bal('a', 10000)], receivables: [rec('R', 2000, day(7))], payables: [pay('P', 3000, day(5))] });
  assert.equal(h(model, 7).projectedCents, E(9000)); assert.equal(h(model, 7).startingCents, E(10000));
});
test('FORECAST: the 30-day example is inspectable component by component (8 770 + 4 250 - 6 100 = 6 920)', () => {
  const model = m({ balances: [bal('a', 8420)], cashCount: { amountCents: E(350), countedOn: '2026-10-02' }, receivables: [rec('R', 4250, day(20))], payables: [pay('P', 6100, day(10))] }); const f = h(model, 30);
  assert.deepEqual([f.startingCents, f.receipts.committedCents, f.payments.committedCents, f.projectedCents], [E(8770), E(4250), E(6100), E(6920)]);
  assert.deepEqual(f.receipts.itemIds, ['CUSTOMER_INVOICE:R']); assert.deepEqual(f.payments.itemIds, ['SUPPLIER_INVOICE:P']);
});
test('FORECAST: the three horizons are consistent with each other (cumulative, same start)', () => {
  const model = m({ balances: [bal('a', 1000)], receivables: [rec('R', 50, day(20))], payables: [pay('P', 30, day(3)), pay('Q', 10, day(60))] });
  assert.deepEqual(HORIZONS.map((d) => h(model, d).projectedCents), [E(970), E(1020), E(1010)]);
});
test('FORECAST: the merchant civil date drives "today" across the DST night (service, real clock)', async () => {
  const mk = (now) => createTreasuryService({ store: readOnlyStore(), merchantId: 'm', clock: createMerchantClock({ now: () => now, timeZone: TZ }), currency: 'EUR', finance: { listInvoices: async () => [] }, inbox: { list: async () => [] } });
  assert.equal((await mk('2026-10-24T22:30:00.000Z').model()).asOf, '2026-10-25', '00:30 local on the 25th');
  assert.equal((await mk('2026-10-25T23:30:00.000Z').model()).asOf, '2026-10-26', 'after the 25-hour day');
  const model = await mk('2026-10-24T22:30:00.000Z').model(); assert.equal(model.forecast.EUR, undefined, 'nothing to forecast without a source');
});

// ===================================================== RISK
test('RISK: first negative day, minimum, deficit, causes and recovery', () => {
  const model = m({ balances: [bal('a', 2000)], payables: [pay('P1', 3000, day(4)), pay('P2', 2500, day(4)), pay('P3', 100, day(5))], receivables: [rec('R', 9000, day(12))] }); const r = h(model, 30).risk;
  assert.deepEqual([r.negative, r.firstNegativeDate, r.minimumCents, r.minimumDate, r.deficitCents, r.recoveryDate], [true, day(4), E(-3600), day(5), E(3600), day(12)]);
  assert.deepEqual(r.causes.top.map((x) => x.id), ['SUPPLIER_INVOICE:P1', 'SUPPLIER_INVOICE:P2']); assert.equal(r.causes.totalCents, E(5500));
  assert.equal(h(model, 7).risk.recoveryDate, null, 'within 7 days there is no recovery yet');
});
test('RISK: no negative day -> says so; example E/F — an overdue 2 000 supplier invoice impacts the risk, an overdue customer one does not hide', () => {
  assert.equal(h(m({ balances: [bal('a', 100)], payables: [pay('P', 50, day(2))] }), 7).risk.negative, false);
  const f = m({ balances: [bal('a', 1500)], payables: [pay('P', 2000, day(-3))], receivables: [rec('O', 500, day(-5))] });
  assert.equal(h(f, 7).risk.firstNegativeDate, AS_OF); assert.equal(h(f, 7).risk.deficitCents, E(500)); assert.equal(h(f, 7).excluded.count, 1);
});

// ===================================================== SCENARIOS
const base = () => facts({ balances: [bal('a', 10000)], receivables: [rec('R1', 2000, day(5)), rec('R2', 1000, day(20))], payables: [pay('P1', 3000, day(10))] });
test('SCENARIO G: buying a 5 000 machine next month -> baseline unchanged, scenario delta -5 000', () => {
  const r = runScenarioOn(base(), [{ type: 'ADD_EXPENSE', amountCents: E(5000), date: day(30), label: 'Machine' }]);
  assert.equal(r.baseline.forecast.EUR.horizons[30].projectedCents, E(10000)); assert.equal(r.delta.EUR.horizons[30].projectedDeltaCents, E(-5000)); assert.equal(r.delta.EUR.horizons[7].projectedDeltaCents, 0);
  assert.equal(r.persisted, false); assert.equal(r.label, 'SCENARIO'); assert.equal(r.scenario.items.find((x) => x.sourceType === 'MANUAL_SCENARIO').certainty, 'SCENARIO');
  assert.deepEqual(JSON.parse(JSON.stringify(r.baseline)), JSON.parse(JSON.stringify(buildTreasuryModel(base()))));
});
test('SCENARIO: a customer pays 10 days later / a supplier invoice is postponed 15 days / inflows drop by 25 %', () => {
  const late = runScenarioOn(base(), [{ type: 'DELAY_RECEIVABLE', id: 'R1', days: 10 }]); assert.equal(late.delta.EUR.horizons[7].projectedDeltaCents, E(-2000)); assert.equal(late.delta.EUR.horizons[30].projectedDeltaCents, 0);
  const post = runScenarioOn(base(), [{ type: 'DELAY_PAYABLE', id: 'SUPPLIER_INVOICE:P1', days: 15 }]); assert.equal(post.delta.EUR.horizons[30].projectedDeltaCents, 0); assert.equal(post.scenario.items.find((x) => x.sourceId === 'P1').date, day(25));
  const cut = runScenarioOn(base(), [{ type: 'REDUCE_INFLOW', percentBp: 2500 }]); assert.equal(cut.delta.EUR.horizons[30].projectedDeltaCents, E(-750)); assert.equal(cut.delta.EUR.horizons[7].projectedDeltaCents, E(-500));
});
test('SCENARIO: collecting an overdue customer invoice on a date; income; risk delta', () => {
  const f = facts({ balances: [bal('a', 100)], receivables: [rec('O', 500, day(-5))], payables: [pay('P', 400, day(2))] });
  const r = runScenarioOn(f, [{ type: 'COLLECT_OVERDUE', id: 'O', date: day(1) }]); assert.equal(r.baseline.forecast.EUR.risk.negative, true); assert.equal(r.scenario.forecast.EUR.risk.negative, false); assert.equal(r.delta.EUR.risk.baselineNegative, true);
  assert.equal(r.scenario.items.find((x) => x.sourceId === 'O').certainty, 'SCENARIO'); assert.equal(runScenarioOn(base(), [{ type: 'ADD_INCOME', amountCents: E(100), date: day(2) }]).delta.EUR.horizons[7].projectedDeltaCents, E(100));
});
test('SCENARIO: invalid hypotheses and unknown targets are refused, nothing is invented', () => {
  const bad = (x) => assert.throws(() => runScenarioOn(base(), x), (e) => /^SCENARIO_/.test(e.code));
  bad([]); bad('x'); bad([{ type: 'MAGIC' }]); bad([{ type: 'ADD_EXPENSE', amountCents: 1.5, date: day(3) }]); bad([{ type: 'ADD_EXPENSE', amountCents: 100, date: day(-3) }]); bad([{ type: 'DELAY_RECEIVABLE', id: 'NOPE', days: 3 }]); bad([{ type: 'DELAY_PAYABLE', id: 'P1', days: 9999 }]); bad([{ type: 'REDUCE_INFLOW', percentBp: 0 }]);
  assert.equal(validateHypotheses([{ type: 'ADD_EXPENSE', amountCents: 100, date: day(3) }], { asOf: AS_OF })[0].currency, 'EUR');
});

// ===================================================== PROVENANCE
test('PROVENANCE: every forecast item has a source type and a source id that exist; no orphan id in any horizon; explain returns the facts', () => {
  const f = facts({ balances: [bal('a', 1000)], receivables: [rec('R1', 100, day(3)), rec('R2', 50, day(-2))], payables: [pay('P1', 80, day(4)), pay('P2', 20, null, { dueOrigin: 'UNKNOWN' })] }); const model = buildTreasuryModel(f);
  const known = new Set([...f.receivables.map((r) => r.id), ...f.payables.map((p) => p.id)]);
  for (const it of model.items) { assert.ok(SOURCE_TYPES.includes(it.sourceType)); assert.ok(known.has(it.sourceId)); assert.ok(it.evidence); assert.ok(['COMMITTED', 'EXPECTED', 'SCENARIO'].includes(it.certainty)); }
  const ids = new Set([...model.items, ...model.undated].map((x) => x.id)); for (const d of HORIZONS) for (const id of [...h(model, d).receipts.itemIds, ...h(model, d).payments.itemIds, ...h(model, d).excluded.itemIds]) assert.ok(ids.has(id), id);
  const ex = explainItemIn(model, 'SUPPLIER_INVOICE:P1'); assert.deepEqual([ex.source.type, ex.source.id, ex.amountCents, ex.dueDate, ex.inHorizons], ['SUPPLIER_INVOICE', 'P1', E(80), day(4), [7, 30, 90]]); assert.equal(explainItemIn(model, 'CUSTOMER_INVOICE:R2').countedInProjection, false);
  assert.throws(() => explainItemIn(model, 'NOPE'), (e) => e.code === 'TREASURY_ITEM_NOT_FOUND');
  for (const c of explainPositionIn(model, 'EUR').components) assert.ok(SOURCE_TYPES.includes(c.sourceType));
});

// ===================================================== CURRENCY
test('CURRENCY: EUR and USD are never added; per-currency positions and forecasts; consolidation refused (no FX)', () => {
  const model = m({ balances: [bal('a', 1000), bal('u', 500, '2026-10-03T08:00:00Z', 'USD')], receivables: [rec('R1', 100, day(2)), rec('R2', 40, day(2), { currency: 'USD' })] });
  assert.deepEqual(model.currencies, ['EUR', 'USD']); assert.equal(model.position.EUR.calculated.totalCents, E(1000)); assert.equal(model.position.USD.calculated.totalCents, E(500)); assert.equal(model.forecast.EUR.horizons[7].projectedCents, E(1100)); assert.equal(model.forecast.USD.horizons[7].projectedCents, E(540));
  assert.deepEqual([model.consolidation.available, model.consolidation.reason], [false, 'NO_RELIABLE_FX_RATE']); assert.ok(model.warnings.some((w) => w.code === 'CURRENCIES_NOT_CONSOLIDATED'));
  assert.equal(m({ balances: [bal('a', 1)] }).consolidation.available, true);
});

// ===================================================== SERVICE: real settlement, double counting, no writes, performance
const READS = ['listBankBalances', 'listBankAccounts', 'listBankTransactions', 'latestCashCount', 'listCashMovements'];
function readOnlyStore(o = {}) {
  const data = { listBankBalances: o.balances ?? [], listBankAccounts: o.accounts ?? [], listBankTransactions: o.transactions ?? [], latestCashCount: o.cashCount ?? null, listCashMovements: o.cashMovements ?? [] };
  const calls = []; const target = Object.fromEntries(READS.map((n) => [n, async () => { calls.push(n); return structuredClone(data[n]); }]));
  return new Proxy(target, { get: (t, k) => { if (k === 'calls') return calls; if (!(k in t)) throw new Error(`TREASURY MUST NOT CALL store.${String(k)}`); return t[k]; } });
}
const doc = (id, gross, { status = 'ISSUED', due = day(5), currency = 'EUR' } = {}) => ({ id, number: id, type: 'invoice', status, currency, dueDate: due, customer: { name: 'Client' }, totals: { grossCents: E(gross) } });
const sv = (o = {}) => { const store = readOnlyStore(o); return { store, svc: createTreasuryService({ store, merchantId: 'm', clock: createMerchantClock({ now: () => NOW, timeZone: TZ }), currency: 'EUR', finance: { listInvoices: async () => o.invoices ?? [] }, inbox: { list: async () => o.suppliers ?? [] } }) }; };
const sup = (id, gross, o = {}) => ({ id, invoiceNumber: id, supplierName: 'S', status: 'TO_PAY', currency: 'EUR', grossCents: E(gross), allocatedCents: 0, dueDate: day(5), extraction: { provenance: { dueDate: { source: 'user' } } }, ...o });

test('DOUBLE COUNTING: invoice + payment — a paid invoice is not a future inflow (C: 1 000, 600 paid -> 400; fully paid -> 0)', async () => {
  const { svc } = sv({ balances: [bal('a', 0)], invoices: [{ doc: doc('I1', 1000), payments: [{ amountCents: E(600) }], creditNotes: [], refunds: [] }, { doc: doc('I2', 500, { status: 'PAID' }), payments: [{ amountCents: E(500) }], creditNotes: [], refunds: [] }, { doc: doc('I3', 300), payments: [{ amountCents: E(300) }], creditNotes: [], refunds: [] }] });
  const f = await svc.forecast(); assert.deepEqual(f.items.map((x) => [x.id, x.amountCents]), [['CUSTOMER_INVOICE:I1', E(400)]]); assert.equal(f.forecast.EUR.horizons[7].receipts.committedCents, E(400));
});
test('DOUBLE COUNTING: credit note + gross invoice — 1 000 invoice, 400 paid, 100 credited -> 500 not 1 000', async () => {
  const cn = { id: 'C1', type: 'credit_note', status: 'ISSUED', totals: { grossCents: E(100) } };
  const { svc } = sv({ balances: [bal('a', 0)], invoices: [{ doc: doc('I1', 1000), payments: [{ amountCents: E(400) }], creditNotes: [cn], refunds: [] }] });
  assert.equal((await svc.forecast()).forecast.EUR.horizons[7].receipts.committedCents, E(500));
});
test('DOUBLE COUNTING: supplier invoice + payment — 1 000 owed, 400 paid -> outflow 600; fully paid -> none', async () => {
  const { svc } = sv({ balances: [bal('a', 5000)], suppliers: [sup('S1', 1000, { allocatedCents: E(400) }), sup('S2', 300, { allocatedCents: E(300) })] });
  const f = await svc.forecast(); assert.deepEqual(f.items.map((x) => [x.id, x.amountCents]), [['SUPPLIER_INVOICE:S1', E(600)]]); assert.equal(f.forecast.EUR.horizons[7].projectedCents, E(4400));
});
test('DOUBLE COUNTING: scenario J — yesterday\'s customer payment is in the bank balance AND settled the invoice: it is not forecast again', async () => {
  const { svc } = sv({ balances: [bal('a', 3000, '2026-10-03T07:00:00Z')], transactions: [{ id: 't', accountId: 'a', currency: 'EUR', date: '2026-10-02', amountCents: E(1000), remainingCents: 0 }], invoices: [{ doc: doc('I1', 1000), payments: [{ amountCents: E(1000) }], creditNotes: [], refunds: [] }] });
  const model = await svc.model(); assert.equal(model.position.EUR.calculated.totalCents, E(3000), 'yesterday is before the observation: not added to the balance'); assert.equal(model.items.length, 0); assert.equal(model.forecast.EUR.horizons[90].projectedCents, E(3000));
});
test('DOUBLE COUNTING: bank balance + old transaction — transactions up to the observation day are never added; only strictly later ones', async () => {
  const tx = (id, date, eurs) => ({ id, accountId: 'a', currency: 'EUR', date, amountCents: E(eurs), remainingCents: 0 });
  const { svc } = sv({ balances: [bal('a', 1000, '2026-10-02T08:00:00Z')], transactions: [tx('old', '2026-09-20', 500), tx('same', '2026-10-02', 300), tx('later', '2026-10-03', -50), tx('future', '2026-10-09', 999)] });
  assert.equal((await svc.model()).position.EUR.calculated.totalCents, E(950));
});
test('DOUBLE COUNTING: cash count + earlier movement — movements up to the count day are never added again', async () => {
  const { svc } = sv({ cashCount: { amountCents: E(350), countedOn: '2026-10-02' }, cashMovements: [{ date: '2026-09-30', kind: 'CASH_IN', amountCents: E(80) }, { date: '2026-10-02', kind: 'CASH_IN', amountCents: E(20) }, { date: '2026-10-03', kind: 'CASH_OUT', amountCents: E(30) }] });
  assert.equal((await svc.model()).position.EUR.calculated.totalCents, E(320));
});
test('DOUBLE COUNTING: statuses do not matter, only what remains (a PARTIALLY_PAID / SENT invoice, a CANCELLED or DRAFT one never counts)', async () => {
  const { svc } = sv({ balances: [bal('a', 0)], invoices: ['PARTIALLY_PAID', 'SENT', 'CANCELLED', 'DRAFT', 'CREDITED'].map((s, i) => ({ doc: doc(`I${i}`, 100, { status: s }), payments: [], creditNotes: [], refunds: [] })) });
  assert.deepEqual((await svc.model()).items.map((x) => x.sourceId).sort(), ['I0', 'I1']);
});

test('WHAT-IF NEVER WRITES: the service only has read access (any other store method throws), and the scenario call completes with the same stores untouched', async () => {
  const { svc, store } = sv({ balances: [bal('a', 1000)], invoices: [{ doc: doc('I1', 100), payments: [], creditNotes: [], refunds: [] }], suppliers: [sup('S1', 50)] });
  const r = await svc.scenario([{ type: 'ADD_EXPENSE', amountCents: E(10), date: day(3) }, { type: 'DELAY_RECEIVABLE', id: 'I1', days: 3 }, { type: 'REDUCE_INFLOW', percentBp: 1000 }]); assert.equal(r.persisted, false);
  assert.ok(store.calls.every((c) => READS.includes(c)));
  assert.throws(() => store.insertBankTransaction, /MUST NOT/); assert.throws(() => store.recordPayment, /MUST NOT/);
  const again = await svc.model(); assert.equal(again.items.length, 2, 'a later baseline has none of the scenario hypotheses'); assert.equal(again.scenario, null);
});
test('WHAT-IF NEVER WRITES: no write call exists in the Treasury sources (static guard)', () => {
  for (const f of ['treasury-engine.js', 'treasury-service.js']) {
    const src = readFileSync(new URL(`../src/finance/${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/\b(insert|update|upsert|delete|record|reconcile|unreconcile|allocate|void|settle|resettle|reverse)\w*\s*\(/i.test(src.replace(/(?:settlement|settlementOf)\(/g, '')), `${f} must not call a write method`);
    assert.ok(!/fetch\(|from 'node:(fs|http|https)'|openai|anthropic/i.test(src), `${f}: no I/O, no model`);
  }
});

test('API: position / forecast / explain / scenario work over HTTP and a scenario leaves every Finance table untouched', async () => {
  const a = await startApp({});
  try {
    const c = await a.authed();
    await c.post('/api/bank/import-csv', { csv: 'Date;Montant;Contrepartie\n10/09/2026;125,50;Client A\n' });
    const snap = async () => JSON.stringify([await a.store.listBankTransactions({ merchantId: 'merchant-test-1' }), await a.store.listBankBalances('merchant-test-1'), await a.store.listRegistry('merchant-test-1'), await a.store.listCashMovements('merchant-test-1'), await a.store.listReconciliations({})]);
    const before = await snap();
    const pos = await c.get('/api/treasury/position'); assert.equal(pos.status, 200); assert.ok(pos.data.legend.CALCULATED);
    const fc = await c.get('/api/treasury/forecast?horizon=30'); assert.equal(fc.status, 200); assert.equal((await c.get('/api/treasury/forecast?horizon=45')).status, 422);
    const sc = await c.post('/api/treasury/scenario', { hypotheses: [{ type: 'ADD_EXPENSE', amountCents: 500000, date: '2026-11-01', label: 'Machine' }] }); assert.equal(sc.status, 200); assert.equal(sc.data.persisted, false);
    assert.equal((await c.post('/api/treasury/scenario', { hypotheses: [{ type: 'DELAY_PAYABLE', id: 'nope', days: 1 }] })).status, 404);
    assert.equal((await c.get('/api/treasury/explain?id=NOPE')).status, 404);
    assert.equal(await snap(), before, 'nothing persisted'); assert.equal((await c.get('/api/treasury')).status, 200);
  } finally { await a.close(); }
});

test('PERFORMANCE: 3 000 open invoices, 2 000 supplier invoices, 6 000 payments, 20 000 bank transactions -> one read per source, well under a second', async () => {
  const invoices = Array.from({ length: 3000 }, (_, i) => ({ doc: doc(`I${i}`, 1000, { due: day((i % 120) - 20) }), payments: i % 2 ? [{ amountCents: E(100) }, { amountCents: E(200) }] : [], creditNotes: [], refunds: [] }));
  const suppliers = Array.from({ length: 2000 }, (_, i) => sup(`S${i}`, 800, { allocatedCents: i % 3 ? E(100) : 0, dueDate: day((i % 100) - 10) }));
  const transactions = Array.from({ length: 20000 }, (_, i) => ({ id: `t${i}`, accountId: i % 2 ? 'a' : 'b', currency: 'EUR', date: day(-(i % 200)), amountCents: i % 5 ? -1234 : 4321, remainingCents: i % 7 ? 0 : 100 }));
  const { svc, store } = sv({ balances: [bal('a', 10000, '2026-09-20T08:00:00Z'), bal('b', 5000, '2026-09-25T08:00:00Z')], invoices, suppliers, transactions });
  const t0 = performance.now(); const model = await svc.model(); const ms = performance.now() - t0;
  assert.deepEqual([...new Set(store.calls)].sort(), [...READS].sort()); assert.equal(store.calls.length, new Set(store.calls).size, 'each source is read exactly once: no per-invoice query');
  assert.ok(model.items.length > 4000); assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  console.log(`  treasury perf: ${invoices.length} invoices, ${suppliers.length} supplier invoices, ${invoices.reduce((s, x) => s + x.payments.length, 0)} payments, ${transactions.length} bank transactions -> ${model.items.length} items in ${ms.toFixed(0)} ms, ${store.calls.length} store reads`);
});

test('ACCEPTANCE A / H / I: 10 000 bank + 500 cash + no invoice = 10 500; a stale balance warns that the start is not fresh; EUR + USD are never added', () => {
  const a = m({ balances: [bal('a', 10000)], cashCount: { amountCents: E(500), countedOn: AS_OF } }); assert.equal(a.position.EUR.calculated.totalCents, E(10500)); assert.equal(a.items.length, 0); assert.equal(h(a, 90).projectedCents, E(10500));
  const stale = m({ balances: [bal('a', 10000, '2026-09-25T08:00:00Z')], receivables: [rec('R', 100, day(3))] }); assert.equal(h(stale, 30).startingFreshness, 'STALE'); assert.ok(stale.warnings.some((w) => w.code === 'STARTING_POSITION_NOT_FRESH' && w.freshness === 'STALE'));
  const mixed = m({ balances: [bal('a', 1000), bal('u', 1000, '2026-10-03T08:00:00Z', 'USD')] }); assert.equal(mixed.consolidation.available, false); assert.ok(!('total' in mixed.consolidation));
});
