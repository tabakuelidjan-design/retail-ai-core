// Finance -> Core and Analytics -> Core, READ-ONLY, on SYNTHETIC data (Finance's acceptance world, Analytics' synthetic dataset).
// Proves: the figures are Finance's / Analytics' own; nothing is written (the store refuses every write method here); one merchant
// never sees another's invoices; stale or missing analytics data is said so, with no number invented; causes are never stated as facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accWorld } from './finance-acceptance-world.js';
import { settlementOf } from '../src/finance/payables/index.js';
import { createFinanceReader } from '../src/core-pilot/finance-reader.js';
import { createAnalyticsReader } from '../src/core-pilot/analytics-reader.js';
import { askNordla } from '../src/core-pilot/ask.js';
import { writeDataset, NOW as AN_NOW } from './fixtures/analytics-dataset.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = '2026-10-03T10:00:00.000Z';
const READS = /^(list|get|latest|find|load)/;
/** The store as the reader sees it: any method that is not a read throws. */
const readOnly = (store, calls) => new Proxy(store, { get(t, k) { const v = t[k]; if (typeof v !== 'function') return v; return (...a) => { calls.push(String(k)); if (!READS.test(String(k))) throw new Error(`WRITE ATTEMPT: ${String(k)}`); return v.apply(t, a); }; } });

async function financeWorld() {
  const w = accWorld();
  const a = await w.supplier(121000, { dueDate: '2026-09-28', supplierName: 'Yiwu Greenline', invoiceNumber: 'YG-1' });
  await w.supplier(48400, { dueDate: '2026-10-08', supplierName: 'Dongguan Pioneer', invoiceNumber: 'DP-7' });
  await w.supplier(30000, { dueDate: '2026-11-20', supplierName: 'Later Supplier', invoiceNumber: 'LS-2' });
  await w.supplier(5000, { status: 'TO_REVIEW', supplierName: 'Not validated yet', invoiceNumber: 'NV-1' });
  await w.paySupplier(21000, [[a.id, 21000]]);
  return w;
}

test('Finance -> Core: invoices to pay, most urgent first, Finance\'s own amounts and due states; nothing written; no payment', async () => {
  const w = await financeWorld(); const calls = [];
  const reader = createFinanceReader({ store: readOnly(w.st, calls), merchantId: w.mid, timeZone: 'Europe/Brussels', now: () => AT, source: 'Finance · synthétique' });
  const p = await reader.payables();
  assert.deepEqual(p.items.map((i) => [i.invoiceNumber, i.calendar, i.remainingCents]), [['YG-1', 'OVERDUE', 100000], ['DP-7', 'NOT_DUE', 48400], ['LS-2', 'NOT_DUE', 30000]]);
  for (const i of p.items) { const row = (await w.st.listSupplierInvoices(w.mid)).find((r) => r.id === i.id); assert.equal(i.remainingCents, settlementOf(row).remainingCents, 'the amount is Finance\'s settlement'); }
  assert.equal(p.notYetValidated, 1, 'a document not validated in Finance is not counted as payable');
  assert.deepEqual(p.totals, { EUR: 178400 }); assert.equal(p.overdue, 1); assert.equal(p.dueSoon, 1); assert.equal(p.asOf, '2026-10-03');
  const a = await askNordla({ text: 'Nordla, quelles factures fournisseurs dois-je payer et quelles sont les échéances ?' }, { finance: reader, runtime: null, getCase: async () => null });
  assert.equal(a.status, 'ANSWERED');
  assert.match(a.answer, /EN RETARD de 5 j — Yiwu Greenline, facture YG-1 : reste 1[  ]000,00 € \(échéance 28\/09\/2026\), déjà payée en partie/);
  assert.match(a.answer, /reste total 1[  ]784,00 €/); assert.ok(a.limits.some((l) => /aucun paiement/.test(l))); assert.ok(a.limits.some((l) => /pas encore validée/.test(l)));
  assert.equal(a.sources[0].kind, 'finance'); assert.equal(a.sources[0].asOf, '2026-10-03');
  // treasury: the not-yet-validated document is not a committed payment either
  const t = await reader.treasury();
  assert.equal(t.forecast.EUR.horizons['30'].payments.committedCents, 148400);
  assert.ok(calls.length > 0 && calls.every((c) => READS.test(c)), `only reads: ${[...new Set(calls)].join(', ')}`);
});

test('Finance -> Core: another merchant\'s reader sees none of these invoices; no time zone = refused (no silent UTC)', async () => {
  const w = await financeWorld(); const other = await w.otherWorld();
  const r2 = createFinanceReader({ store: other.st, merchantId: other.mid, timeZone: 'Europe/Brussels', now: () => AT, source: 'x' });
  assert.equal((await r2.payables()).items.length, 0);
  assert.throws(() => createFinanceReader({ store: w.st, merchantId: w.mid, timeZone: '', source: 'x' }), /time zone/);
});

test('Analytics -> Core: sales of a period vs the previous one, movers as FACTS, causes never asserted; stale data flagged', async () => {
  const dir = await writeDataset();
  const reader = createAnalyticsReader({ reportsDir: dir, now: () => AN_NOW, source: 'Analytics · synthétique' });
  const a = await askNordla({ text: 'Nordla, comment évoluent mes ventes et pourquoi certaines performances changent-elles ?' }, { analytics: reader, runtime: null, getCase: async () => null });
  assert.equal(a.status, 'ANSWERED');
  assert.match(a.answer, /Ventes du 27\/08\/2026 au 25\/09\/2026 \(30 j\)/); assert.match(a.answer, /Chiffre d’affaires net HT : 489,25 € \(\+1,7 % vs 480,98 €\)/);
  assert.match(a.answer, /pas la cause/); assert.match(a.answer, /hypothèse/); assert.doesNotMatch(a.answer, /parce que|à cause de|because/i);
  assert.equal(a.sources[0].kind, 'analytics'); assert.deepEqual(a.sources[0].period, { from: '2026-08-27', to: '2026-09-25' });
  const stale = createAnalyticsReader({ reportsDir: dir, now: () => new Date(AN_NOW.getTime() + 2 * 86_400_000), source: 'x' });
  const s = await askNordla({ text: 'comment évoluent mes ventes ?' }, { analytics: stale, runtime: null, getCase: async () => null });
  assert.ok(s.limits.some((l) => /Données ANCIENNES/.test(l)), 'a stale period is never presented as current');
});

test('Analytics -> Core: no data = said so, with no figure; no reader = NOT connected', async () => {
  const empty = createAnalyticsReader({ reportsDir: await mkdtemp(join(tmpdir(), 'no-reports-')), now: () => AN_NOW, source: 'x' });
  const a = await askNordla({ text: 'comment évoluent mes ventes ?' }, { analytics: empty, runtime: null, getCase: async () => null });
  assert.equal(a.status, 'DATA_UNAVAILABLE'); assert.doesNotMatch(a.answer, /\d/);
  for (const q of ['comment évoluent mes ventes ?', 'quelles factures fournisseurs dois-je payer ?', 'ma trésorerie']) {
    const r = await askNordla({ text: q }, { runtime: null, getCase: async () => null });
    assert.equal(r.status, 'MODULE_NOT_CONNECTED', q); assert.doesNotMatch(r.answer, /\d/, q);
  }
});
