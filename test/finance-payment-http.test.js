// HTTP level of the payment idempotency (Phase 1): the dashboard form sends one idempotency key per opened form, an API client may send an Idempotency-Key header;
// a double click or a retry after a lost answer is the SAME payment and never a second one. (The database proofs are in test/pg.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceBody, startApp } from './finance-dashboard-helpers.js';

const withApp = (fn) => async () => { const a = await startApp({}); try { await fn(a); } finally { await a.close(); } };
const issue = async (c) => { const d = (await c.post('/api/documents', invoiceBody())).data; await c.post(`/api/documents/${d.id}/submit`, {}); return (await c.post(`/api/documents/${d.id}/approve`, {})).data; };

test('double click: the same idempotencyKey in the body records ONE payment, the answer is the same, nothing is added', withApp(async (a) => {
  const c = await a.authed(); const inv = await issue(c); const body = { amount: '30.00', paidOn: '2026-09-25', method: 'bank_transfer', idempotencyKey: 'ui-form-key-0001' };
  const first = await c.post(`/api/documents/${inv.id}/payments`, body); const second = await c.post(`/api/documents/${inv.id}/payments`, body);
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  assert.equal(second.data.payments.length, 1, 'one payment, not two'); assert.equal(second.data.settlement.paidCents, 3000);
  const other = await c.post(`/api/documents/${inv.id}/payments`, { ...body, idempotencyKey: 'ui-form-key-0002' });
  assert.equal(other.data.payments.length, 2, 'a new form (new key) is a new payment');
}));

test('retry after the invoice became PAID still returns the committed payment instead of "invoice not open"', withApp(async (a) => {
  const c = await a.authed(); const inv = await issue(c); const body = { amount: '71.90', paidOn: '2026-09-25', method: 'bank_transfer', idempotencyKey: 'ui-form-key-paid' };
  assert.equal((await c.post(`/api/documents/${inv.id}/payments`, body)).data.status, 'PAID');
  const retry = await c.post(`/api/documents/${inv.id}/payments`, body);
  assert.equal(retry.status, 201); assert.equal(retry.data.status, 'PAID'); assert.equal(retry.data.payments.length, 1);
}));

test('the Idempotency-Key header works and wins; the same key with another amount is refused (422), never replayed', withApp(async (a) => {
  const c = await a.authed(); const inv = await issue(c);
  const h = (key) => ({ headers: { 'Idempotency-Key': key } });
  const r1 = await c.raw('POST', `/api/documents/${inv.id}/payments`, { amount: '10.00', paidOn: '2026-09-25', method: 'cash' }, h('api-client-key-1'));
  const r2 = await c.raw('POST', `/api/documents/${inv.id}/payments`, { amount: '10.00', paidOn: '2026-09-25', method: 'cash' }, h('api-client-key-1'));
  assert.equal(r1.status, 201); assert.equal(r2.status, 201); assert.equal(r2.data.payments.length, 1);
  const reuse = await c.raw('POST', `/api/documents/${inv.id}/payments`, { amount: '20.00', paidOn: '2026-09-25', method: 'cash' }, h('api-client-key-1'));
  assert.ok([409, 422].includes(reuse.status), `refused, got ${reuse.status}`); assert.equal((await c.get(`/api/documents/${inv.id}`)).data.payments.length, 1);
}));

test('a malformed key is ignored (a fresh operation), never trusted as an identifier', withApp(async (a) => {
  const c = await a.authed(); const inv = await issue(c);
  const r = await c.post(`/api/documents/${inv.id}/payments`, { amount: '10.00', paidOn: '2026-09-25', method: 'cash', idempotencyKey: 'x' });
  assert.equal(r.status, 201); const r2 = await c.post(`/api/documents/${inv.id}/payments`, { amount: '10.00', paidOn: '2026-09-25', method: 'cash', idempotencyKey: 'x' });
  assert.equal(r2.data.payments.length, 2, 'too short to be a key: each call is its own payment');
}));
