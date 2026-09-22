// Treasury facts. Deterministic, integer cents, no LLM. Every number carries its BASIS so an observed fact is never mistaken for a forecast:
//   OBSERVED  read from a bank balance or confirmed by a person (a cash count)
//   EXPECTED  known documents with a due date (open customer invoices, supplier invoices to pay)
//   ASSUMED   an assumption that is NOT counted in the projection (for example overdue receivables that may or may not be collected)
// This is a short-term liquidity view, NOT accounting cash flow: it says so, and it says what is missing (no bank connected, no cash count).

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * @param {{asOf: string, horizonDays?: number, currency?: string,
 *   bank: Array<{accountId: string, balanceCents: number, asOf: string}>|null,
 *   cashCount: {amountCents: number, countedOn: string}|null, cashMovements?: Array<{date: string, kind: string, amountCents: number}>,
 *   receivables: Array<{number: string, dueDate: string, remainingCents: number}>,
 *   payables: Array<{invoiceNumber: string, supplierName: string, dueDate: string|null, grossCents: number}>}} f
 */
export function buildTreasury(f) {
  const horizon = f.horizonDays ?? 7; const end = addDays(f.asOf, horizon);
  const warnings = [];
  const bankConnected = Array.isArray(f.bank) && f.bank.length > 0;
  const bankCents = bankConnected ? f.bank.reduce((a, b) => a + b.balanceCents, 0) : null;
  if (!bankConnected) warnings.push('NO_BANK_BALANCE_AVAILABLE');

  // physical cash: the last CONFIRMED count, plus movements recorded after it. Never assumed from POS sales.
  let cashCents = null; let cashAsOf = null;
  if (f.cashCount) {
    const after = (f.cashMovements ?? []).filter((m) => m.date > f.cashCount.countedOn && m.date <= f.asOf);
    const delta = after.reduce((a, m) => a + (m.kind === 'CASH_IN' ? m.amountCents : m.kind === 'CASH_OUT' || m.kind === 'DEPOSIT_TO_BANK' ? -m.amountCents : 0), 0);
    cashCents = f.cashCount.amountCents + delta; cashAsOf = f.cashCount.countedOn;
  } else warnings.push('NO_CASH_COUNT_CONFIRMED');

  const liquidCents = bankCents === null && cashCents === null ? null : (bankCents ?? 0) + (cashCents ?? 0);
  const incoming = f.receivables.filter((r) => r.remainingCents > 0 && r.dueDate >= f.asOf && r.dueDate <= end);
  const overdueIn = f.receivables.filter((r) => r.remainingCents > 0 && r.dueDate < f.asOf);
  const outgoing = f.payables.filter((p) => p.dueDate && p.dueDate <= end); // includes payables already past due: they must be paid
  const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
  const expectedIn = sum(incoming, 'remainingCents'); const expectedOut = sum(outgoing, 'grossCents'); const overdueCents = sum(overdueIn, 'remainingCents');
  const projectionCents = liquidCents === null ? null : liquidCents + expectedIn - expectedOut;

  // day by day: observed start, then expected movements on their due dates
  const series = [];
  if (liquidCents !== null) { let run = liquidCents; for (let d = 0; d <= horizon; d += 1) { const day = addDays(f.asOf, d); const inn = sum(incoming.filter((r) => r.dueDate === day), 'remainingCents'); const out = sum(outgoing.filter((p) => (p.dueDate <= f.asOf ? d === 0 : p.dueDate === day)), 'grossCents'); run += inn - out; series.push({ date: day, incomingCents: inn, outgoingCents: out, balanceCents: run, basis: d === 0 ? 'OBSERVED_PLUS_EXPECTED' : 'PROJECTED' }); } }

  return {
    asOf: f.asOf, horizonDays: horizon, currency: f.currency ?? 'EUR',
    observed: { bankCents, bankAsOf: bankConnected ? f.bank.map((b) => b.asOf).sort().at(-1) : null, cashCents, cashAsOf, liquidCents },
    expected: { incomingCents: expectedIn, incomingCount: incoming.length, outgoingCents: expectedOut, outgoingCount: outgoing.length },
    assumed: { overdueReceivablesCents: overdueCents, overdueCount: overdueIn.length, note: 'NOT_INCLUDED_IN_THE_PROJECTION' },
    projection: { cents: projectionCents, basis: 'PROJECTED', horizonEnd: end, formula: 'OBSERVED_LIQUIDITY + EXPECTED_IN - EXPECTED_OUT' },
    items: [
      { key: 'bank', cents: bankCents, basis: 'OBSERVED' }, { key: 'cash', cents: cashCents, basis: 'OBSERVED' }, { key: 'liquid', cents: liquidCents, basis: 'OBSERVED' },
      { key: 'receivables_due', cents: expectedIn, basis: 'EXPECTED' }, { key: 'payables_due', cents: expectedOut, basis: 'EXPECTED' }, { key: 'overdue_receivables', cents: overdueCents, basis: 'ASSUMED' }, { key: 'projection', cents: projectionCents, basis: 'PROJECTED' },
    ],
    series, warnings,
    disclaimer: 'SHORT_TERM_LIQUIDITY_VIEW_NOT_ACCOUNTING_CASH_FLOW',
  };
}
