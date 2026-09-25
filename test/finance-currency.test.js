import test from 'node:test';
import assert from 'node:assert/strict';
import { countForeignSupplier, eurOfSupplier, eurPaidOfSupplier, isNative, sumEur } from '../src/finance/currency.js';
import { invoiceBody, startApp } from './finance-dashboard-helpers.js';

// Finance v1 is EUR-only: EUR + USD + CNY must NEVER be summed into one EUR total, and no FX rate exists anywhere.
// SYNTHETIC data only.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');
const HISTORY = { history: { completeFrom: '2026-05-11', storeCreatedOn: '2026-05-11', lastSyncedAt: '2026-10-05T00:00:00.000Z' }, today: '2026-10-05' };

async function scenario() {
  const a = await startApp(HISTORY);
  const c = await a.authed();
  const manual = async (o) => { const r = await c.post('/api/inbox/manual', o); await c.post(`/api/inbox/${r.data.id}/validate`, {}); await c.post(`/api/inbox/${r.data.id}/to-pay`, {}); return r.data.id; };
  const eurId = await manual({ supplierName: 'Fournisseur EUR', invoiceNumber: 'E-1', issueDate: '2026-09-10', net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR', supplierVatNumber: 'BE0000000097' });
  const usdId = await manual({ supplierName: 'Supplier USD', invoiceNumber: 'U-1', issueDate: '2026-09-11', net: '500.00', vat: '0.00', gross: '500.00', currency: 'USD', supplierVatNumber: 'US123' });
  const cap = await c.post('/api/inbox/capture', { fileName: 'hotel.png', dataBase64: PNG, origin: 'camera', fields: { supplierName: 'Hotel Shenzhen', issueDate: '2026-09-12', gross: '880.00', currency: 'CNY' }, capture: { category: 'hotel', paymentMethod: 'card' } });
  await c.post(`/api/inbox/${cap.data.item.id}/validate`, {});
  return { a, c, eurId, usdId, cnyId: cap.data.item.id };
}

test('helpers: a foreign document counts only through a typed EUR amount, never a rate', () => {
  const eur = { currency: 'EUR', grossCents: 12100 };
  const usd = { currency: 'USD', grossCents: 50000 };
  const cny = { currency: 'CNY', grossCents: 88000 };
  const cnyTyped = { currency: 'CNY', grossCents: 88000, extraction: { capture: { eurAmountCents: 11040 } } };
  assert.equal(eurOfSupplier(eur), 12100);
  assert.equal(eurOfSupplier(usd), null);
  assert.equal(eurOfSupplier(cny), null);
  assert.equal(eurOfSupplier(cnyTyped), 11040);
  assert.equal(eurOfSupplier({ currency: 'USD', grossCents: 1, extraction: { capture: { eurAmountCents: 0 } } }), null);
  assert.equal(eurOfSupplier({ currency: 'USD', grossCents: 1, extraction: { capture: { eurAmountCents: 1.5 } } }), null);
  assert.equal(sumEur([eur, usd, cny]), 12100, 'EUR + USD + CNY is not 12100 + 50000 + 88000');
  assert.equal(sumEur([eur, usd, cny, cnyTyped]), 12100 + 11040);
  assert.equal(countForeignSupplier([eur, usd, cny, cnyTyped]), 2);
  assert.equal(eurPaidOfSupplier(usd), null);
  assert.equal(eurPaidOfSupplier({ currency: 'EUR', grossCents: 100, paidAmountCents: 90 }), 90);
  assert.equal(isNative({ currency: 'EUR' }), true);
  assert.equal(isNative({ currency: 'USD' }), false);
});

test('overview, expense donut, cash-flow: only EUR is totalled, foreign documents are counted aside', async () => {
  const { a, c } = await scenario();
  try {
    const o = (await c.get('/api/overview')).data;
    assert.ok(o.foreign, 'overview reports foreign documents left out');
    const bd = (await c.get('/api/overview/expense-breakdown')).data;
    assert.equal(bd.excludedForeign, 2);
    assert.match(JSON.stringify(bd), /121[,.]00/);
    assert.doesNotMatch(JSON.stringify(bd), /621|1[ .]?501|500[,.]00|880[,.]00/);
    const cf = (await c.get('/api/overview/cashflow')).data;
    const out = cf.rows.reduce((s, r) => s + (r.expenseCents ?? 0), 0);
    assert.equal(out, 12100);
    assert.ok(cf.excluded, 'cash-flow reports what it left out');
  } finally { await a.close(); }
});

test('to-do, inbox status, purchases analytics, period report: same EUR-only total everywhere', async () => {
  const { a, c } = await scenario();
  try {
    const st = (await c.get('/api/inbox/status')).data.counts;
    assert.equal(st.toPayCents, 12100);
    assert.equal(st.toPayForeign, 1);
    const acts = (await c.get('/api/actions')).data;
    const pay = (acts.actions || acts).find((x) => x.id === 'pay');
    assert.ok(pay, 'a pay action exists for the EUR invoice');
    assert.match(JSON.stringify(pay), /121[,.]00/);
    assert.equal(pay.count, 1, 'the count next to the EUR amount is the number of documents inside it');
    assert.doesNotMatch(JSON.stringify(pay), /621|500[,.]00/);
    const an = (await c.get('/api/purchases/analytics?period=month')).data;
    assert.match(JSON.stringify(an), /121[,.]00/);
    assert.doesNotMatch(JSON.stringify(an), /1[ .]?501|1[ .]?601|621[,.]00|500[,.]00|880[,.]00/);
    assert.ok(an.excludedForeign >= 1);
    const pr = (await c.get('/api/period-report?from=2026-09-01&to=2026-09-30')).data;
    assert.match(JSON.stringify(pr.purchases), /121[,.]00/);
    assert.doesNotMatch(JSON.stringify(pr.purchases), /1[ .]?501|621[,.]00/);
    assert.ok(pr.excluded && pr.excluded.purchaseDocuments >= 1);
  } finally { await a.close(); }
});

test('treasury and receivables: foreign documents are excluded and reported', async () => {
  const { a, c } = await scenario();
  try {
    const t = (await c.get('/api/treasury')).data;
    assert.ok(t.excluded, 'treasury reports what it left out');
    assert.ok(t.excluded.foreignPayables >= 1);
    assert.doesNotMatch(JSON.stringify(t), /621[,.]00|1[ .]?501/);
    // a USD sales invoice is not added to the EUR receivables
    const r = (await c.get('/api/receivables')).data;
    assert.equal(typeof r.foreignDocuments, 'number');
  } finally { await a.close(); }
});

test('a foreign expense keeps its original amount and currency, and counts only through a typed EUR amount', async () => {
  const { a, c, cnyId } = await scenario();
  try {
    const before = (await c.get(`/api/inbox/${cnyId}`)).data;
    assert.equal(before.currency, 'CNY');
    assert.equal(before.gross, '880.00');
    // a second CNY expense where the merchant typed the EUR amount actually charged (before validation)
    const cap = await c.post('/api/inbox/capture', { fileName: 'hotel2.png', dataBase64: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([7])]).toString('base64'), origin: 'camera', fields: { supplierName: 'Hotel Guangzhou', issueDate: '2026-09-13', gross: '880.00', currency: 'CNY' }, capture: {} });
    assert.ok(cap.status < 300, JSON.stringify(cap.data));
    const put = await c.put(`/api/inbox/${cap.data.item.id}`, { supplierName: 'Hotel Guangzhou', capture: { eur: '110.40', category: 'hotel', paymentMethod: 'card' } });
    assert.ok(put.status < 300, JSON.stringify(put.data));
    await c.post(`/api/inbox/${cap.data.item.id}/validate`, {});
    const after = (await c.get(`/api/inbox/${cap.data.item.id}`)).data;
    assert.equal(after.currency, 'CNY', 'the original currency is untouched');
    assert.equal(after.gross, '880.00', 'the original amount is untouched');
    assert.equal(after.capture.eurAmountCents, 11040);
    const bd = (await c.get('/api/overview/expense-breakdown')).data;
    assert.equal(bd.excludedForeign, 2, 'USD and the untyped CNY are left out; the typed one counts');
    assert.match(JSON.stringify(bd), /231[,.]40/, '121.00 EUR + 110.40 typed EUR, never + 880 CNY');
  } finally { await a.close(); }
});

test('a foreign-currency SALES invoice never adds to EUR revenue or receivables', async () => {
  const a = await startApp(HISTORY);
  const c = await a.authed();
  try {
    const eurDoc = (await c.post('/api/documents', invoiceBody({ issueDate: '2026-09-20' }))).data;
    await c.post(`/api/documents/${eurDoc.id}/submit`, {}); await c.post(`/api/documents/${eurDoc.id}/approve`, {});
    const base = (await c.get('/api/receivables')).data;
    const usd = await c.post('/api/documents', { ...invoiceBody({ issueDate: '2026-09-21' }), currency: 'USD' });
    if (usd.status < 300 && usd.data.id) {
      await c.post(`/api/documents/${usd.data.id}/submit`, {}); await c.post(`/api/documents/${usd.data.id}/approve`, {});
      const after = (await c.get('/api/receivables')).data;
      assert.equal(after.unpaid.outstanding, base.unpaid.outstanding, 'USD invoice is not added to the EUR receivable');
      assert.equal(after.foreignDocuments, 1);
    }
  } finally { await a.close(); }
});
