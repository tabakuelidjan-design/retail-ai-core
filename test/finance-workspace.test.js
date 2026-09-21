import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActions, quarterInfo } from '../src/finance/actions.js';
import { NoAccountingExport, NoBankReconciliation, NoCustomerPortal, assertAdapter, connectorStatus } from '../src/finance/connectors.js';
import { validateSettings } from '../src/finance/settings.js';
import { baseSettings, invoiceBody, startApp } from './finance-dashboard-helpers.js';

const facts = (over = {}) => ({
  today: '2026-09-26', currency: 'EUR', dueSoonDays: 7, receivables: { overdue: { count: 0, outstandingCents: 0 }, due_soon: { count: 0, outstandingCents: 0 } }, inbox: { toReview: 0, TO_PAY: 0, toPayCents: 0 },
  stock: { counts: { FAILED: 0, UNCERTAIN: 0 } }, draftsMissingVat: 0, awaitingApproval: 0, quotesToConvert: 0, pack: null, settingsMissing: 0, ...over,
});

test('Action Center: nothing to do -> only the calendar reminder; facts become prioritised, actionable items with a target screen', () => {
  const idle = buildActions(facts({ today: '2026-08-01' })); assert.deepEqual(idle, []);
  const a = buildActions(facts({
    receivables: { overdue: { count: 2, outstandingCents: 30000 }, due_soon: { count: 3, outstandingCents: 142000 } }, inbox: { toReview: 3, TO_PAY: 1, toPayCents: 5000 }, draftsMissingVat: 2, awaitingApproval: 1, quotesToConvert: 1, settingsMissing: 2,
    stock: { counts: { FAILED: 1, UNCERTAIN: 1 } }, pack: { status: 'OK', period: { start: '2026-04-01', end: '2026-06-30' }, completeness: 'COMPLETE', reconciliation: 'CLEAN', anomalies: 0, orders: 71 },
  }));
  const byKind = Object.fromEntries(a.map((x) => [x.kind, x]));
  assert.equal(byKind.overdue_invoices.count, 2); assert.equal(byKind.overdue_invoices.cents, 30000); assert.equal(byKind.overdue_invoices.tone, 'bad'); assert.equal(byKind.overdue_invoices.href, '#/receivables');
  assert.equal(byKind.to_collect_soon.cents, 142000); assert.equal(byKind.to_collect_soon.params.days, 7);
  assert.equal(byKind.supplier_invoices_to_review.count, 3); assert.equal(byKind.supplier_invoices_to_review.href, '#/inbox'); assert.equal(byKind.supplier_invoices_to_pay.cents, 5000);
  assert.equal(byKind.documents_missing_vat.count, 2); assert.equal(byKind.stock_movements_need_attention.count, 2);
  assert.equal(byKind.quarter_closes_soon.params.days, 4); assert.deepEqual([byKind.quarter_closes_soon.params.quarter, byKind.quarter_closes_soon.params.year], [3, 2026]);
  assert.equal(byKind.accountant_pack_ready.tone, 'ok'); assert.equal(byKind.orders_reconciled.count, 71);
  const order = a.map((x) => x.tone); assert.deepEqual(order, [...order].sort((x, y) => ({ bad: 0, warn: 1, info: 2, ok: 3 }[x] - { bad: 0, warn: 1, info: 2, ok: 3 }[y])), 'most urgent first');
  assert.equal(buildActions(facts({ pack: { status: 'OK', period: { start: 'a', end: 'b' }, completeness: 'PARTIAL', reconciliation: 'REVIEW_REQUIRED', anomalies: 3, orders: 5 } })).find((x) => x.id === 'pack').kind, 'accountant_pack_needs_review');
  assert.deepEqual(quarterInfo('2026-09-26'), { year: 2026, quarter: 3, end: '2026-09-30', daysLeft: 4 });
  assert.equal(quarterInfo('2026-12-31').daysLeft, 0);
});

test('Action Center endpoint: overdue invoices, supplier invoices to review and the closing quarter come from the real workspace data', async () => {
  const a = await startApp({ today: '2026-09-26' }); const c = await a.authed();
  try {
    const d = (await c.post('/api/documents', invoiceBody({ issueDate: '2026-08-01', dueDate: '2026-08-10' }))).data;
    await c.post(`/api/documents/${d.id}/submit`, {}); assert.equal((await c.post(`/api/documents/${d.id}/approve`, {})).status, 200);
    await c.post('/api/inbox/upload', { fileName: 'f.pdf', dataBase64: Buffer.from('%PDF-1.4 synthetic').toString('base64') });
    const r = (await c.get('/api/actions')).data;
    const kinds = r.actions.map((x) => x.kind);
    for (const k of ['overdue_invoices', 'supplier_invoices_to_review', 'quarter_closes_soon']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
    const od = r.actions.find((x) => x.kind === 'overdue_invoices'); assert.equal(od.count, 1); assert.match(od.amount, /\d/);
    assert.equal((await a.client().raw('GET', '/api/actions')).status, 401);
  } finally { await a.close(); }
});

test('Peppol UX is provider-neutral: no Access Point -> NOT CONFIGURED, nothing can be sent, and the topology questions are explicit', async () => {
  const a = await startApp(); const c = await a.authed();
  try {
    const st = (await c.get('/api/peppol/status')).data;
    assert.equal(st.outgoing.configured, false); assert.equal(st.incoming.configured, false); assert.equal(st.decided, false); assert.equal(st.topology.mode, 'undecided');
    assert.ok(st.questions.includes('WHO_OWNS_THE_RECEIVING_REGISTRATION') && st.questions.includes('IS_CODABOX_VOILA_THE_RECEIVER')); assert.match(st.warning, /DO_NOT_REGISTER_A_SECOND_RECEIVING/);
    const d = (await c.post('/api/documents', invoiceBody({}))).data; await c.post(`/api/documents/${d.id}/submit`, {}); await c.post(`/api/documents/${d.id}/approve`, {});
    const doc = (await c.get(`/api/documents/${d.id}`)).data; assert.equal(doc.peppol.status, 'NOT_CONFIGURED'); assert.equal(doc.peppol.canSend, false); assert.equal(doc.peppol.transmitted, false);
    assert.equal((await c.post(`/api/documents/${d.id}/peppol/send`, {})).status, 422, 'approval is always required');
    const r = await c.post(`/api/documents/${d.id}/peppol/send`, { approve: true }); assert.equal(r.status, 409); assert.equal(r.data.error.code, 'PEPPOL_ACCESS_POINT_NOT_CONFIGURED');
  } finally { await a.close(); }
});
test('Peppol outgoing lifecycle behind the adapter: approve -> SENT -> DELIVERED / REJECTED; refused while the topology is undecided; never twice', async () => {
  const sent = [];
  const ap = { name: 'fake-ap', status: 'DELIVERED', async submit(m) { sent.push(m); return { providerMessageId: `pm-${sent.length}` }; }, async fetchStatus() { return { status: this.status, at: '2026-09-26T10:00:00Z' }; } };
  const s = baseSettings(); s.seller.enterpriseNumber = '0000.000.097'; s.seller.peppolId = undefined;
  const a = await startApp({ accessPoint: ap, settings: s }); const c = await a.authed();
  try {
    const cust = { ...invoiceBody({}).customer, enterpriseNumber: '0000.000.196' };
    const d = (await c.post('/api/documents', invoiceBody({ customer: cust }))).data; await c.post(`/api/documents/${d.id}/submit`, {}); await c.post(`/api/documents/${d.id}/approve`, {});
    assert.equal((await c.post(`/api/documents/${d.id}/peppol/send`, { approve: true })).data.error.code, 'PEPPOL_TOPOLOGY_NOT_CONFIRMED'); assert.equal(sent.length, 0);
    const st = a.getSettings(); st.peppol.topology = { receiverAccessPoint: 'codabox', mode: 'send_only', confirmedWith: 'Comptable', confirmedOn: '2026-09-30', note: '' }; a.setSettings(st);
    assert.equal((await c.get(`/api/documents/${d.id}`)).data.peppol.canSend, true);
    const r = await c.post(`/api/documents/${d.id}/peppol/send`, { approve: true }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.status, 'SENT'); assert.equal(sent.length, 1); assert.match(sent[0].payloadXml, /<Invoice/);
    assert.equal((await c.get(`/api/documents/${d.id}`)).data.peppol.status, 'SENT');
    assert.equal((await c.post(`/api/documents/${d.id}/peppol/send`, { approve: true })).status, 409, 'not twice'); assert.equal(sent.length, 1);
    assert.equal((await c.post(`/api/documents/${d.id}/peppol/refresh`, {})).data.status, 'DELIVERED'); assert.equal((await c.get(`/api/documents/${d.id}`)).data.peppol.status, 'DELIVERED');
  } finally { await a.close(); }
});
test('Peppol topology answers are merchant-local settings, validated', () => {
  assert.equal(validateSettings({}, undefined).settings.peppol.topology.mode, 'undecided');
  assert.equal(validateSettings({ peppol: { topology: { receiverAccessPoint: 'codabox', mode: 'send_only', confirmedOn: '2026-10-01' } } }, undefined).settings.peppol.topology.receiverAccessPoint, 'codabox');
  assert.ok(validateSettings({ peppol: { topology: { mode: 'register_second_ap' } } }, undefined).errors.some((e) => e.code === 'VALUE_INVALID'));
  assert.ok(validateSettings({ peppol: { topology: { confirmedOn: '1 Oct' } } }, undefined).errors.some((e) => e.code === 'DATE_INVALID'));
});

test('connector boundaries: accounting export, bank reconciliation and customer portal are replaceable contracts, NOT CONFIGURED by default', async () => {
  assert.equal(NoAccountingExport.configured, false); await assert.rejects(() => NoAccountingExport.export({}), /NOT_CONFIGURED/);
  await assert.rejects(() => NoBankReconciliation.transactions({}), /NOT_CONFIGURED/); assert.deepEqual(await NoBankReconciliation.suggestMatches([], {}), []); await assert.rejects(() => NoCustomerPortal.publish({}), /NOT_CONFIGURED/);
  assert.deepEqual(Object.values(NoAccountingExport.capabilities()), [false, false, false, false, false, false]);
  assert.ok(assertAdapter('accountingExport', { name: 'x', label: 'x', configured: true, capabilities: () => ({}), export: async () => ({}) }));
  assert.throws(() => assertAdapter('accountingExport', { name: 'x' }), /missing: label, configured, capabilities, export/); assert.throws(() => assertAdapter('nope', {}), /unknown adapter kind/);
  const a = await startApp(); const c = await a.authed();
  try {
    const list = (await c.get('/api/connectors')).data.connectors;
    assert.deepEqual(list.map((x) => x.kind), ['accountingExport', 'bankReconciliation', 'customerPortal', 'mailDelivery', 'peppolAccessPoint', 'inbox', 'inbox', 'inbox']);
    assert.ok(list.filter((x) => x.kind !== 'inbox').every((x) => x.configured === false)); assert.equal(connectorStatus().length, 3);
  } finally { await a.close(); }
});
