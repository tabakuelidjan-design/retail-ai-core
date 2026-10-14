// Treasury V1 engine. PURE and deterministic: integer cents, civil dates (YYYY-MM-DD, the merchant's calendar), no clock, no store, no LLM, no I/O.
//
//   source facts (Bank balances/transactions, cash, receivables.remaining_due, payables.remaining) -> normalized cash-flow items -> position + forecast + risk -> explanation
//
// Treasury is a READ MODEL. It never writes (and cannot: it receives plain values), never keeps a second version of a payment, a balance, an invoice or an allocation.
// Every number says what KIND of number it is:
//   OBSERVED    what the bank said / what a person counted (with its observation time and freshness)
//   CALCULATED  observed + later transactions / later cash movements (never a new observation)
//   FORECAST    known future flows applied to the calculated position
//   SCENARIO    a user hypothesis applied on top of the baseline (ephemeral)
// Future flows are classed by certainty, never by invented probability:
//   COMMITTED   an obligation / claim with a known due date (supplier invoice owed, customer invoice not yet due)
//   EXPECTED    expected but not guaranteed (an overdue customer invoice: it may be paid, nobody knows when)
//   SCENARIO    a user hypothesis
// Overdue items never disappear and their date is never silently moved:
//   OVERDUE_RECEIVABLE  stays visible with its original due date, is NOT counted in the projection (timing unknown) unless a scenario says when it is collected
//   OVERDUE_PAYABLE     stays visible with its original due date and is counted TODAY (it is owed now): the earliest possible payment, stated as such
// No FX: each currency is computed on its own; a consolidated figure exists only when there is a single currency.

import { addDays, daysBetween } from './document.js';
import { civilDateIn } from './civil-date.js';
import { observedBalance } from './bank.js';

export const HORIZONS = [7, 30, 90];
export const CASH_FRESH_DAYS = 2;
export const SOURCE_TYPES = ['CUSTOMER_INVOICE', 'SUPPLIER_INVOICE', 'BANK', 'CASH', 'MANUAL_SCENARIO'];
const isCents = (x) => Number.isInteger(x);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const RANK = { FRESH: 0, STALE: 1, UNKNOWN: 2 }; const worst = (xs) => xs.reduce((w, x) => (RANK[x] > RANK[w] ? x : w), 'FRESH');

export class TreasuryError extends Error { constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail ?? null; } }

// ---------------------------------------------------------------- items
/** A customer invoice with something left to collect -> one item, or one per instalment when a valid schedule exists. remainingCents comes from the Payments engine (never the gross). */
function receivableItems(r, asOf) {
  if (!isCents(r.remainingCents) || r.remainingCents <= 0) return { items: [], undated: null };
  const cur = r.currency ?? 'EUR'; const ev = { grossCents: r.grossCents ?? null, creditedCents: r.creditedCents ?? null, paidCents: r.paidCents ?? null, remainingCents: r.remainingCents };
  const base = { direction: 'IN', currency: cur, sourceType: 'CUSTOMER_INVOICE', sourceId: r.id, label: r.number ?? null, counterparty: r.customer ?? null, evidence: ev };
  const parts = scheduleParts(r);
  const rows = parts ?? [{ dueDate: r.dueDate, remainingCents: r.remainingCents, installment: null }];
  const items = []; let undated = null;
  rows.forEach((p) => {
    if (p.remainingCents <= 0) return;
    if (!isDate(p.dueDate)) { undated = { ...(undated ?? { ...base, id: `CUSTOMER_INVOICE:${r.id}`, amountCents: 0 }), amountCents: (undated?.amountCents ?? 0) + p.remainingCents }; return; }
    const overdue = p.dueDate < asOf; const id = `CUSTOMER_INVOICE:${r.id}${p.installment ? `#${p.installment}` : ''}`;
    items.push({ ...base, id, installment: p.installment, amountCents: p.remainingCents, dueDate: p.dueDate, date: p.dueDate, overdue, overdueDays: overdue ? daysBetween(p.dueDate, asOf) : 0, certainty: overdue ? 'EXPECTED' : 'COMMITTED',
      included: !overdue, treatment: overdue ? 'OVERDUE_RECEIVABLE_NOT_IN_PROJECTION' : 'DUE_ON_DATE', dueOrigin: p.installment ? 'SCHEDULE' : 'INVOICE' });
  });
  return { items, undated };
}
/** Instalments of an invoice, ONLY when a schedule exists on the document (shares in basis points, or amounts). Paid money is applied to the earliest instalments first. Null = single due date. */
function scheduleParts(r) {
  const s = r.schedule; if (!Array.isArray(s) || s.length < 2 || !isCents(r.effectiveDueCents) || r.effectiveDueCents <= 0) return null;
  const due = r.effectiveDueCents; let amounts;
  if (s.every((x) => isCents(x.shareBp) && x.shareBp > 0)) { if (sum(s, (x) => x.shareBp) !== 10000) return null; let left = due; amounts = s.map((x, i) => { const a = i === s.length - 1 ? left : Math.round((due * x.shareBp) / 10000); left -= a; return a; }); }
  else if (s.every((x) => isCents(x.amountCents) && x.amountCents > 0)) { if (sum(s, (x) => x.amountCents) !== due) return null; amounts = s.map((x) => x.amountCents); }
  else return null;
  const ordered = s.map((x, i) => ({ dueDate: x.dueDate, amount: amounts[i], i })).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || a.i - b.i);
  let paid = due - r.remainingCents; if (paid < 0) return null;
  const parts = ordered.map((x, n) => { const used = Math.min(paid, x.amount); paid -= used; return { dueDate: x.dueDate, remainingCents: x.amount - used, installment: n + 1 }; });
  return sum(parts, (p) => p.remainingCents) === r.remainingCents ? parts : null;
}
/** A supplier invoice with something left to pay. remainingCents = gross - allocations (Payments), never the gross. No due date = not in the forecast, but reported (never invented). */
function payableItem(p, asOf) {
  if (!isCents(p.remainingCents) || p.remainingCents <= 0) return { item: null, undated: null };
  const cur = p.currency ?? 'EUR'; const base = { direction: 'OUT', currency: cur, sourceType: 'SUPPLIER_INVOICE', sourceId: p.id, label: p.invoiceNumber ?? null, counterparty: p.supplierName ?? null, evidence: { grossCents: p.grossCents ?? null, paidCents: p.paidCents ?? null, remainingCents: p.remainingCents }, id: `SUPPLIER_INVOICE:${p.id}` };
  if (!isDate(p.dueDate)) return { item: null, undated: { ...base, amountCents: p.remainingCents, treatment: 'NO_DUE_DATE_NOT_IN_FORECAST', dueOrigin: p.dueOrigin ?? 'UNKNOWN' } };
  const overdue = p.dueDate < asOf;
  return { item: { ...base, amountCents: p.remainingCents, dueDate: p.dueDate, date: overdue ? asOf : p.dueDate, overdue, overdueDays: overdue ? daysBetween(p.dueDate, asOf) : 0, certainty: 'COMMITTED', included: true,
    treatment: overdue ? 'OVERDUE_PAYABLE_ASSUMED_PAID_TODAY' : 'DUE_ON_DATE', dueOrigin: p.dueOrigin ?? 'PRINTED' }, undated: null };
}

// ---------------------------------------------------------------- scenarios (hypotheses applied on a COPY of the baseline items)
export const HYPOTHESIS_TYPES = ['DELAY_RECEIVABLE', 'DELAY_PAYABLE', 'ADD_EXPENSE', 'ADD_INCOME', 'REDUCE_INFLOW', 'COLLECT_OVERDUE'];
export function validateHypotheses(list, { asOf }) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 20) throw new TreasuryError('SCENARIO_HYPOTHESES_INVALID', '1 to 20 hypotheses');
  return list.map((h, i) => {
    const bad = (why) => new TreasuryError('SCENARIO_HYPOTHESIS_INVALID', `#${i + 1} ${why}`);
    if (!h || typeof h !== 'object' || !HYPOTHESIS_TYPES.includes(h.type)) throw bad('type');
    if (h.type === 'DELAY_RECEIVABLE' || h.type === 'DELAY_PAYABLE') { if (typeof h.id !== 'string' || !h.id) throw bad('id'); if (!Number.isInteger(h.days) || h.days < -365 || h.days > 365) throw bad('days'); return { type: h.type, id: h.id, days: h.days }; }
    if (h.type === 'ADD_EXPENSE' || h.type === 'ADD_INCOME') { if (!isCents(h.amountCents) || h.amountCents <= 0) throw bad('amountCents'); if (!isDate(h.date) || h.date < asOf) throw bad('date'); const currency = h.currency ?? 'EUR'; if (!/^[A-Z]{3}$/.test(currency)) throw bad('currency'); return { type: h.type, amountCents: h.amountCents, date: h.date, currency, label: typeof h.label === 'string' ? h.label.slice(0, 120) : null }; }
    if (h.type === 'REDUCE_INFLOW') { if (!Number.isInteger(h.percentBp) || h.percentBp < 1 || h.percentBp > 10000) throw bad('percentBp'); const currency = h.currency ?? null; if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw bad('currency'); return { type: h.type, percentBp: h.percentBp, currency }; }
    if (typeof h.id !== 'string' || !h.id) throw bad('id'); if (!isDate(h.date) || h.date < asOf) throw bad('date'); return { type: 'COLLECT_OVERDUE', id: h.id, date: h.date };
  });
}
function applyHypotheses(items, hyps, asOf) {
  let out = items.map((x) => ({ ...x })); const log = [];
  hyps.forEach((h, n) => {
    const src = `SCENARIO:${n + 1}`;
    if (h.type === 'DELAY_RECEIVABLE' || h.type === 'DELAY_PAYABLE') {
      const want = h.type === 'DELAY_RECEIVABLE' ? 'IN' : 'OUT'; const hit = out.filter((x) => x.direction === want && (x.id === h.id || x.sourceId === h.id) && x.sourceType !== 'MANUAL_SCENARIO'); if (!hit.length) throw new TreasuryError('SCENARIO_TARGET_NOT_FOUND', h.id);
      hit.forEach((x) => { const from = x.date; x.date = addDays(x.date, h.days); x.scenario = { ...(x.scenario ?? {}), delayedDays: (x.scenario?.delayedDays ?? 0) + h.days, originalDate: x.scenario?.originalDate ?? from }; if (x.date < asOf) x.date = asOf; });
      log.push({ ...h, affected: hit.map((x) => x.id) });
    } else if (h.type === 'ADD_EXPENSE' || h.type === 'ADD_INCOME') {
      out.push({ id: src, direction: h.type === 'ADD_EXPENSE' ? 'OUT' : 'IN', currency: h.currency, amountCents: h.amountCents, date: h.date, dueDate: h.date, sourceType: 'MANUAL_SCENARIO', sourceId: src, label: h.label, counterparty: null, certainty: 'SCENARIO', included: true, overdue: false, overdueDays: 0, treatment: 'SCENARIO_HYPOTHESIS', dueOrigin: 'SCENARIO', evidence: null });
      log.push({ ...h, affected: [src] });
    } else if (h.type === 'REDUCE_INFLOW') {
      const hit = out.filter((x) => x.direction === 'IN' && x.included && x.sourceType !== 'MANUAL_SCENARIO' && (!h.currency || x.currency === h.currency));
      hit.forEach((x) => { const cut = Math.round((x.amountCents * h.percentBp) / 10000); x.scenario = { ...(x.scenario ?? {}), reducedByCents: (x.scenario?.reducedByCents ?? 0) + cut, originalAmountCents: x.scenario?.originalAmountCents ?? x.amountCents }; x.amountCents -= cut; });
      out = out.filter((x) => x.amountCents > 0); log.push({ ...h, affected: hit.map((x) => x.id) });
    } else {
      const hit = out.filter((x) => x.direction === 'IN' && x.overdue && (x.id === h.id || x.sourceId === h.id)); if (!hit.length) throw new TreasuryError('SCENARIO_TARGET_NOT_FOUND', h.id);
      hit.forEach((x) => { x.scenario = { ...(x.scenario ?? {}), collectedOn: h.date }; x.date = h.date; x.included = true; x.certainty = 'SCENARIO'; x.treatment = 'OVERDUE_RECEIVABLE_COLLECTED_IN_SCENARIO'; });
      log.push({ ...h, affected: hit.map((x) => x.id) });
    }
  });
  return { items: out, log };
}

// ---------------------------------------------------------------- position
function buildPosition({ asOf, nowInstant, timeZone, currency, balances, accounts, transactions, cashCount, cashMovements, freshHours }) {
  const byCur = new Map(); const get = (c) => { if (!byCur.has(c)) byCur.set(c, { currency: c, components: [], warnings: [] }); return byCur.get(c); };
  const seen = new Set();
  for (const b of balances ?? []) {
    const c = get(b.currency ?? currency); const ob = observedBalance(b, nowInstant, { freshHours }); seen.add(`${b.accountId}|${b.currency ?? currency}`);
    const obsDay = b.asOf ? civilDateIn(b.asOf, timeZone) : null;
    const mine = (transactions ?? []).filter((t) => t.accountId === b.accountId && (t.currency ?? currency) === (b.currency ?? currency));
    const later = obsDay ? mine.filter((t) => t.date > obsDay && t.date <= asOf) : [];
    const sameDay = obsDay ? mine.filter((t) => t.date === obsDay) : [];
    const unreconciled = later.filter((t) => (t.remainingCents ?? 0) > 0);
    c.components.push({ kind: 'BANK_BALANCE', sourceType: 'BANK', sourceId: b.accountId, amountCents: b.balanceCents, observedAt: ob.observedAt, source: ob.source, freshness: ob.freshness, ageHours: ob.ageHours, basis: 'OBSERVED' });
    if (later.length) c.components.push({ kind: 'BANK_LATER_TRANSACTIONS', sourceType: 'BANK', sourceId: b.accountId, amountCents: sum(later, (t) => t.amountCents), count: later.length, from: obsDay, transactionIds: later.map((t) => t.id), basis: 'CALCULATED' });
    if (sameDay.length) c.warnings.push({ code: 'SAME_DAY_TRANSACTIONS_NOT_COUNTED', accountId: b.accountId, count: sameDay.length, detail: 'transactions dated the day of the balance may already be in it: not added' });
    if (unreconciled.length) c.warnings.push({ code: 'UNRECONCILED_LATER_TRANSACTIONS', accountId: b.accountId, count: unreconciled.length, amountCents: sum(unreconciled, (t) => t.amountCents), detail: 'cash already moved but not reconciled with a payment: the matching invoice may still appear as open' });
    if (ob.freshness === 'STALE') c.warnings.push({ code: 'STALE_BANK_BALANCE', accountId: b.accountId, ageHours: ob.ageHours });
    if (ob.freshness === 'UNKNOWN') c.warnings.push({ code: 'BANK_BALANCE_TIME_UNKNOWN', accountId: b.accountId });
  }
  for (const a of accounts ?? []) {
    const cur = a.currency ?? currency; if (seen.has(`${a.externalId}|${cur}`)) continue;
    const c = get(cur); c.components.push({ kind: 'BANK_BALANCE', sourceType: 'BANK', sourceId: a.externalId, amountCents: null, observedAt: null, source: null, freshness: 'UNKNOWN', ageHours: null, basis: 'OBSERVED' }); c.warnings.push({ code: 'ACCOUNT_WITHOUT_BALANCE', accountId: a.externalId });
  }
  if (cashCount && isDate(cashCount.countedOn)) {
    const c = get(currency); const days = Math.max(0, daysBetween(cashCount.countedOn, asOf)); const freshness = days <= CASH_FRESH_DAYS ? 'FRESH' : 'STALE';
    c.components.push({ kind: 'CASH_COUNT', sourceType: 'CASH', sourceId: cashCount.id ?? cashCount.countedOn, amountCents: cashCount.amountCents, countedOn: cashCount.countedOn, freshness, ageDays: days, basis: 'OBSERVED' });
    const after = (cashMovements ?? []).filter((m) => m.date > cashCount.countedOn && m.date <= asOf); // a movement ON the counting day is already in the count: never added twice
    const delta = sum(after, (m) => (m.kind === 'CASH_IN' ? m.amountCents : m.kind === 'CASH_OUT' || m.kind === 'DEPOSIT_TO_BANK' ? -m.amountCents : 0));
    if (after.length) c.components.push({ kind: 'CASH_LATER_MOVEMENTS', sourceType: 'CASH', sourceId: cashCount.id ?? cashCount.countedOn, amountCents: delta, count: after.length, from: cashCount.countedOn, basis: 'CALCULATED' });
    if (freshness === 'STALE') c.warnings.push({ code: 'STALE_CASH_COUNT', ageDays: days });
  }
  const out = {};
  for (const [cur, c] of byCur) {
    const obs = c.components.filter((x) => x.basis === 'OBSERVED' && x.amountCents !== null); const calc = c.components.filter((x) => x.amountCents !== null);
    const observedCents = obs.length ? sum(obs, (x) => x.amountCents) : null; const calculatedCents = obs.length ? sum(calc, (x) => x.amountCents) : null;
    const freshness = obs.length ? worst(c.components.filter((x) => x.basis === 'OBSERVED').map((x) => x.freshness)) : 'UNKNOWN';
    const warnings = [...c.warnings]; if (!obs.length) warnings.push({ code: 'NO_OBSERVED_CASH' }); else if (freshness !== 'FRESH') warnings.push({ code: 'STARTING_POSITION_NOT_FRESH', freshness });
    out[cur] = { currency: cur, observed: { totalCents: observedCents, basis: 'OBSERVED' }, calculated: { totalCents: calculatedCents, basis: 'OBSERVED_PLUS_LATER_TRANSACTIONS', laterCents: calculatedCents === null ? null : calculatedCents - observedCents }, freshness, components: c.components, warnings };
  }
  return out;
}

// ---------------------------------------------------------------- forecast + risk
function forecastFor({ currency, position, items, undated, asOf }) {
  const mine = items.filter((x) => x.currency === currency); const start = position?.calculated.totalCents ?? null;
  const included = mine.filter((x) => x.included); const horizonsOut = {};
  const flow = (xs, certainty) => sum(xs.filter((x) => certainty.includes(x.certainty)), (x) => x.amountCents);
  const maxH = Math.max(...HORIZONS); const days = []; for (let d = 0; d <= maxH; d += 1) days.push(addDays(asOf, d));
  const series = []; let run = start;
  for (const day of days) { const inn = sum(included.filter((x) => x.date === day && x.direction === 'IN'), (x) => x.amountCents); const out = sum(included.filter((x) => x.date === day && x.direction === 'OUT'), (x) => x.amountCents); if (run !== null) run += inn - out; series.push({ date: day, inCents: inn, outCents: out, balanceCents: run }); }
  for (const h of HORIZONS) {
    const end = addDays(asOf, h); const inH = included.filter((x) => x.date >= asOf && x.date <= end); const ins = inH.filter((x) => x.direction === 'IN'); const outs = inH.filter((x) => x.direction === 'OUT');
    const excluded = mine.filter((x) => !x.included && x.direction === 'IN');
    const slice = series.slice(0, h + 1);
    horizonsOut[h] = {
      horizonDays: h, endDate: end, currency, startingCents: start, startingBasis: position?.calculated.basis ?? null, startingFreshness: position?.freshness ?? 'UNKNOWN',
      receipts: { committedCents: flow(ins, ['COMMITTED']), expectedCents: flow(ins, ['EXPECTED']), scenarioCents: flow(ins, ['SCENARIO']), itemIds: ins.map((x) => x.id) },
      payments: { committedCents: flow(outs, ['COMMITTED']), expectedCents: flow(outs, ['EXPECTED']), scenarioCents: flow(outs, ['SCENARIO']), itemIds: outs.map((x) => x.id) },
      overduePayablesCents: sum(outs.filter((x) => x.overdue), (x) => x.amountCents),
      excluded: { overdueReceivablesCents: sum(excluded, (x) => x.amountCents), count: excluded.length, itemIds: excluded.map((x) => x.id), treatment: 'OVERDUE_RECEIVABLE_NOT_IN_PROJECTION' },
      undated: { payablesCents: sum(undated.filter((x) => x.currency === currency && x.direction === 'OUT'), (x) => x.amountCents), count: undated.filter((x) => x.currency === currency).length },
      netFlowCents: sum(ins, (x) => x.amountCents) - sum(outs, (x) => x.amountCents),
      projectedCents: start === null ? null : start + sum(ins, (x) => x.amountCents) - sum(outs, (x) => x.amountCents), basis: 'FORECAST',
      risk: riskOf(slice, outs),
    };
  }
  return { currency, startingCents: start, series, horizons: horizonsOut, risk: horizonsOut[maxH].risk };
}
function riskOf(series, outs) {
  if (!series.length || series[0].balanceCents === null) return { computable: false, reason: 'NO_STARTING_POSITION', negative: null };
  let min = series[0]; for (const p of series) if (p.balanceCents < min.balanceCents) min = p;
  const first = series.find((p) => p.balanceCents < 0) ?? null;
  const recovery = first ? series.find((p) => p.date > first.date && p.balanceCents >= 0) ?? null : null; // first day back at or above zero
  const causes = first ? outs.filter((x) => x.date <= first.date).sort((a, b) => b.amountCents - a.amountCents || a.id.localeCompare(b.id)) : [];
  return { computable: true, negative: !!first, firstNegativeDate: first?.date ?? null, firstNegativeCents: first?.balanceCents ?? null, minimumCents: min.balanceCents, minimumDate: min.date, deficitCents: Math.max(0, -min.balanceCents), recoveryDate: recovery?.date ?? null,
    causes: { totalCents: sum(causes, (x) => x.amountCents), count: causes.length, top: causes.slice(0, 5).map((x) => ({ id: x.id, amountCents: x.amountCents, date: x.date, label: x.label, counterparty: x.counterparty })) } };
}

// ---------------------------------------------------------------- the model
/**
 * @param {object} f
 * @param {string} f.asOf civil today  @param {string} f.nowInstant ISO instant  @param {string} f.timeZone  @param {string} [f.currency] merchant default (cash has no currency of its own)
 * @param {Array} f.balances [{accountId, currency, balanceCents, asOf, source}]  @param {Array} [f.accounts] [{externalId, currency}]  @param {Array} [f.transactions] [{id, accountId, currency, date, amountCents, remainingCents}]
 * @param {object|null} f.cashCount  @param {Array} [f.cashMovements]
 * @param {Array} f.receivables [{id, number, customer, currency, dueDate, remainingCents, grossCents, creditedCents, paidCents, effectiveDueCents, schedule}]
 * @param {Array} f.payables [{id, invoiceNumber, supplierName, currency, dueDate, dueOrigin, remainingCents, grossCents, paidCents}]
 * @param {Array} [f.hypotheses] already validated (see validateHypotheses)
 */
export function buildTreasuryModel(f) {
  if (!isDate(f.asOf)) throw new TreasuryError('AS_OF_INVALID');
  const currency = f.currency ?? 'EUR'; const freshHours = f.freshHours ?? 36;
  const recv = (f.receivables ?? []).map((r) => receivableItems(r, f.asOf)); const pay = (f.payables ?? []).map((p) => payableItem(p, f.asOf));
  let items = [...recv.flatMap((r) => r.items), ...pay.map((p) => p.item).filter(Boolean)];
  const undated = [...recv.map((r) => r.undated).filter(Boolean), ...pay.map((p) => p.undated).filter(Boolean)];
  let applied = [];
  if (f.hypotheses?.length) { const r = applyHypotheses(items, f.hypotheses, f.asOf); items = r.items; applied = r.log; }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const position = buildPosition({ asOf: f.asOf, nowInstant: f.nowInstant, timeZone: f.timeZone, currency, balances: f.balances, accounts: f.accounts, transactions: f.transactions, cashCount: f.cashCount, cashMovements: f.cashMovements, freshHours });
  const currencies = [...new Set([...Object.keys(position), ...items.map((x) => x.currency), ...undated.map((x) => x.currency)])].sort();
  const forecast = {}; for (const c of currencies) forecast[c] = forecastFor({ currency: c, position: position[c] ?? null, items, undated, asOf: f.asOf });
  const consolidation = currencies.length <= 1 ? { available: true, currency: currencies[0] ?? currency } : { available: false, reason: 'NO_RELIABLE_FX_RATE', currencies };
  const warnings = [...currencies.flatMap((c) => (position[c]?.warnings ?? []).map((w) => ({ currency: c, ...w })))];
  for (const c of currencies) if (!position[c]) warnings.push({ currency: c, code: 'NO_OBSERVED_CASH' });
  if (!consolidation.available) warnings.push({ code: 'CURRENCIES_NOT_CONSOLIDATED' });
  return { asOf: f.asOf, currencies, position, items, undated, forecast, consolidation, warnings, scenario: applied.length ? { applied, persisted: false } : null, defaultCurrency: currency,
    legend: { OBSERVED: 'observed by the bank or counted by a person', CALCULATED: 'observed + later transactions (not a new observation)', FORECAST: 'known future flows applied to the calculated position', SCENARIO: 'a user hypothesis (never stored)' } };
}

/** Baseline vs scenario: what changed, nothing else. Pure. */
export function runScenarioOn(facts, hypotheses) {
  const hyps = validateHypotheses(hypotheses, { asOf: facts.asOf });
  const baseline = buildTreasuryModel({ ...facts, hypotheses: undefined }); const scenario = buildTreasuryModel({ ...facts, hypotheses: hyps });
  const delta = {};
  for (const c of scenario.currencies) {
    const b = baseline.forecast[c]; const s = scenario.forecast[c]; delta[c] = { horizons: {} };
    for (const h of HORIZONS) { const bh = b?.horizons[h]; const sh = s.horizons[h]; delta[c].horizons[h] = { projectedDeltaCents: bh?.projectedCents == null || sh.projectedCents == null ? null : sh.projectedCents - bh.projectedCents, netFlowDeltaCents: sh.netFlowCents - (bh?.netFlowCents ?? 0) }; }
    const br = b?.risk; const sr = s.risk;
    delta[c].risk = { baselineNegative: br?.negative ?? null, scenarioNegative: sr.negative ?? null, minimumDeltaCents: br?.minimumCents == null || sr.minimumCents == null ? null : sr.minimumCents - br.minimumCents, firstNegativeDate: { baseline: br?.firstNegativeDate ?? null, scenario: sr.firstNegativeDate ?? null } };
  }
  return { persisted: false, hypotheses: scenario.scenario?.applied ?? [], baseline, scenario, delta, label: 'SCENARIO' };
}

/** Why a figure is what it is. Returns structured facts (codes + numbers), never prose; the UI words them. */
export function explainItemIn(model, id) {
  const item = model.items.find((x) => x.id === id) ?? model.undated.find((x) => x.id === id); if (!item) throw new TreasuryError('TREASURY_ITEM_NOT_FOUND', id);
  const inH = HORIZONS.filter((h) => item.included !== false && item.date && item.date >= model.asOf && item.date <= addDays(model.asOf, h));
  return { id: item.id, direction: item.direction, currency: item.currency, amountCents: item.amountCents, date: item.date ?? null, dueDate: item.dueDate ?? null, certainty: item.certainty ?? null, treatment: item.treatment,
    source: { type: item.sourceType, id: item.sourceId, label: item.label, counterparty: item.counterparty }, evidence: item.evidence, dueOrigin: item.dueOrigin ?? null, overdueDays: item.overdueDays ?? 0, installment: item.installment ?? null, scenario: item.scenario ?? null,
    countedInProjection: item.included !== false, inHorizons: inH };
}
export function explainPositionIn(model, currency) {
  const p = model.position[currency]; if (!p) throw new TreasuryError('TREASURY_CURRENCY_NOT_FOUND', currency);
  return { currency, observedCents: p.observed.totalCents, calculatedCents: p.calculated.totalCents, laterCents: p.calculated.laterCents, freshness: p.freshness, components: p.components, warnings: p.warnings, formula: 'CALCULATED = sum(OBSERVED components) + later bank transactions + later cash movements' };
}
