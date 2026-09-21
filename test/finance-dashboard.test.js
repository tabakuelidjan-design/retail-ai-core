import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { computeTotals, createDraft, normalizeLine } from '../src/finance/document.js';
import { createViesProvider, ManualProvider } from '../src/finance/company.js';
import { unzip } from '../src/finance/xlsx.js';
import { CUSTOMER_BODY, LINES_BODY, TOKEN, VALID_IBAN, baseSettings, invoiceBody, startApp } from './finance-dashboard-helpers.js';

const withApp = (opts, fn) => async () => { const a = await startApp(opts); try { await fn(a); } finally { await a.close(); } };
const create = async (c, body = invoiceBody()) => { const r = await c.post('/api/documents', body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
const issue = async (c, over = {}) => { const d = await create(c, invoiceBody(over)); assert.equal((await c.post(`/api/documents/${d.id}/submit`, {})).status, 200); const r = await c.post(`/api/documents/${d.id}/approve`, {}); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };

// ---------- authentication and transport security ----------
test('every finance route requires a session; static pages carry a strict CSP and no sniffing', withApp({}, async (a) => {
  const anon = a.client();
  for (const [m, p] of [['GET', '/api/overview'], ['GET', '/api/documents'], ['GET', '/api/companies'], ['GET', '/api/settings'], ['GET', '/api/receivables'], ['POST', '/api/pack'], ['GET', '/api/orders'], ['POST', '/api/calc']]) assert.equal((await anon.raw(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p}`);
  const page = await anon.raw('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await anon.raw('GET', '/etc/passwd')).status, 404);
  assert.equal((await anon.raw('GET', '/../package.json')).status, 404);
}));

test('login: wrong token refused, brute force locked out, cookie is HttpOnly + SameSite=Strict', withApp({}, async (a) => {
  const c = a.client();
  const ok = await c.login();
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.ok(!JSON.stringify(ok.data).includes(TOKEN));
  const bad = a.client();
  for (let i = 0; i < 5; i += 1) assert.equal((await bad.login('wrong-token-wrong-token-wrong')).status, 401);
  assert.equal((await bad.login('wrong-token-wrong-token-wrong')).status, 429);
  assert.equal((await bad.login(TOKEN)).status, 429); // locked even for the right token during the lockout
  assert.ok(a.audits.some((e) => e.action === 'LOGIN') && a.audits.some((e) => e.action === 'LOGIN_FAILED'));
}));

test('CSRF, content type, origin and host protections', withApp({}, async (a) => {
  const c = await a.authed();
  assert.equal((await c.raw('POST', '/api/calc', { lines: [] }, { noCsrf: true })).status, 403);
  assert.equal((await c.raw('POST', '/api/calc', { lines: [] }, { headers: { 'X-CSRF-Token': 'nope' } })).status, 403);
  assert.equal((await c.raw('POST', '/api/calc', { lines: [] }, { headers: { 'Content-Type': 'text/plain' }, rawBody: '{}' })).status, 415);
  assert.equal((await c.raw('POST', '/api/calc', { lines: [] }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.raw('POST', '/api/calc', { lines: [] })).status, 200);
  const status = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: a.port, path: '/api/session', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); r.end(); });
  assert.equal(status, 403); // DNS-rebinding style Host header
  const big = await c.raw('POST', '/api/calc', { x: 'y'.repeat(1_300_000) });
  assert.equal(big.status, 413);
  assert.equal(big.data.error.code, 'BODY_TOO_LARGE');
}));

// ---------- create / validate ----------
test('CREATE INVOICE: totals come from the engine, mass assignment is ignored, readiness is reported', withApp({}, async (a) => {
  const c = await a.authed();
  const d = await create(c, { ...invoiceBody(), id: 'attacker-id', status: 'PAID', number: 'INV-1', merchantId: 'other', lockedAt: 'x', totals: { grossCents: 1 } });
  assert.equal(d.status, 'DRAFT');
  assert.notEqual(d.id, 'attacker-id');
  assert.equal(d.number, null);
  assert.equal(d.doc.merchantId, 'merchant-test-1');
  assert.equal(d.totals.grossCents, 7190);
  assert.equal(d.totals.gross, '71,90');
  assert.deepEqual(d.totals.vatBreakdown.map((g) => [g.vatRateBp, g.taxableCents, g.vatCents]), [[600, 4500, 270], [2100, 2000, 420]]);
  assert.equal(d.readiness.ready, true);
  assert.equal(d.peppol.status, 'NOT_CONFIGURED');
  assert.ok(d.nextNumber.startsWith('INV-2026-'));
}));

test('INVALID INVOICE is blocked: field errors on input, and issuance blockers on submit', withApp({}, async (a) => {
  const c = await a.authed();
  const bad = await c.post('/api/documents', { type: 'invoice', customer: { name: '' }, lines: [{ description: '', quantity: '-1', unitPrice: '1e3', vatRate: 'x' }] });
  assert.equal(bad.status, 422);
  const codes = bad.data.error.fields.map((f) => f.code);
  for (const code of ['REQUIRED', 'QUANTITY_INVALID', 'UNIT_PRICE_INVALID', 'VAT_RATE_INVALID']) assert.ok(codes.includes(code), code);
  assert.equal((await c.post('/api/documents', { type: 'invoice', customer: CUSTOMER_BODY, lines: [] })).status, 422);
  assert.equal((await c.post('/api/documents', { type: 'credit_note', customer: CUSTOMER_BODY, lines: LINES_BODY })).status, 422); // a credit note is not created this way
  const d = await create(c, invoiceBody({ vat: { regime: 'domestic', confirmed: false }, revenueBasis: undefined, customer: { ...CUSTOMER_BODY, vatNumber: undefined, address: { street: 'x' } } }));
  assert.equal(d.readiness.ready, false);
  const sub = await c.post(`/api/documents/${d.id}/submit`, {});
  assert.equal(sub.status, 422);
  assert.equal(sub.data.error.code, 'NOT_READY_FOR_APPROVAL');
  for (const code of ['VAT_TREATMENT_NOT_CONFIRMED_BY_MERCHANT', 'REVENUE_BASIS_NOT_DECLARED', 'CUSTOMER_COMPANY_NUMBER_MISSING']) assert.ok(d.readiness.errors.includes(code), code);
  const zeroRates = baseSettings(); zeroRates.vat.allowedRatesBp = [];
  a.setSettings(zeroRates);
  const noRate = await create(c, invoiceBody());
  assert.ok(noRate.readiness.errors.some((e) => e.includes('RATE_NOT_ALLOWED')));
}));

test('NO DRIFT: the live-totals endpoint, the saved document and the engine agree exactly', withApp({}, async (a) => {
  const c = await a.authed();
  const cases = [
    LINES_BODY,
    [{ description: 'x', quantity: '2.5', unitPrice: '3.3333', vatRate: '21' }],
    [1, 2, 3].map((n) => ({ description: `L${n}`, quantity: '1', unitPrice: '0.50', vatRate: '21' })),
    [{ description: 'y', quantity: '1', unitPrice: '10.00', discountAmount: '2.50', vatRate: '21' }, { description: 'z', quantity: '7', unitPrice: '1.99', discountPercent: '12.5', vatRate: '6' }],
  ];
  for (const lines of cases) {
    const engine = computeTotals(lines.map((l, i) => normalizeLine(l, i + 1).line));
    const calc = await c.post('/api/calc', { lines, vat: { regime: 'domestic' }, currency: 'EUR', language: 'fr' });
    assert.equal(calc.data.ok, true);
    assert.equal(calc.data.totals.grossCents, engine.grossCents);
    assert.equal(calc.data.totals.vatCents, engine.vatCents);
    assert.deepEqual(calc.data.totals.vatBreakdown.map((g) => [g.vatRateBp, g.taxableCents, g.vatCents]), engine.vatBreakdown.map((g) => [g.vatRateBp, g.taxableCents, g.vatCents]));
    const saved = await create(c, invoiceBody({ lines }));
    assert.equal(saved.totals.grossCents, engine.grossCents);
    assert.deepEqual(saved.totals.lines.map((l) => l.netCents), calc.data.totals.lines.map((l) => l.netCents));
  }
  const bad = await c.post('/api/calc', { lines: [{ description: 'x', quantity: 'abc', unitPrice: '1', vatRate: '21' }] });
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.totals, null);
}));

test('editing a draft recalculates on the server; an issued invoice can never be edited or cancelled', withApp({}, async (a) => {
  const c = await a.authed();
  const d = await create(c);
  const upd = await c.put(`/api/documents/${d.id}`, invoiceBody({ lines: [{ description: 'Only', quantity: '1', unitPrice: '100.00', vatRate: '21' }] }));
  assert.equal(upd.status, 200);
  assert.equal(upd.data.totals.grossCents, 12100);
  await c.post(`/api/documents/${d.id}/submit`, {});
  const issued = (await c.post(`/api/documents/${d.id}/approve`, {})).data;
  assert.equal(issued.status, 'ISSUED');
  assert.ok(issued.number);
  const edit = await c.put(`/api/documents/${d.id}`, invoiceBody({ notes: 'sneaky' }));
  assert.equal(edit.status, 409);
  assert.equal(edit.data.error.code, 'DOCUMENT_LOCKED');
  assert.equal((await c.post(`/api/documents/${d.id}/cancel`, {})).status, 409);
  assert.equal((await c.post(`/api/documents/${d.id}/approve`, {})).status, 409); // cannot be issued twice
  assert.equal(issued.actions.includes('edit'), false);
  assert.ok(issued.actions.includes('add_payment') && issued.actions.includes('credit_note') && issued.actions.includes('mark_sent'));
  assert.equal(issued.integrity.ok, true);
}));

// ---------- approval ----------
test('APPROVAL: review data is complete; APPROVE issues, MODIFY returns to draft, REJECT cancels without using a number', withApp({}, async (a) => {
  const c = await a.authed();
  const d = await create(c);
  const sub = (await c.post(`/api/documents/${d.id}/submit`, {})).data;
  assert.equal(sub.status, 'READY_FOR_APPROVAL');
  assert.deepEqual(sub.actions.filter((x) => ['approve', 'modify', 'reject'].includes(x)).sort(), ['approve', 'modify', 'reject']);
  for (const k of ['seller', 'customer']) assert.ok(sub.doc[k].name);
  assert.ok(sub.doc.seller.iban); assert.ok(sub.revenueNote.startsWith('STANDALONE')); assert.ok(sub.totals.vatBreakdown.length); assert.ok(sub.nextNumber);
  const back = (await c.post(`/api/documents/${d.id}/modify`, { note: 'change the notes' })).data;
  assert.equal(back.status, 'DRAFT');
  await c.post(`/api/documents/${d.id}/submit`, {});
  const rej = (await c.post(`/api/documents/${d.id}/reject`, {})).data;
  assert.equal(rej.status, 'CANCELLED');
  assert.equal(rej.number, null);
  const next = await issue(c);
  assert.equal(next.number, 'INV-2026-0001'); // the rejected draft used no number
  const expectedPeek = (await c.post('/api/documents', invoiceBody())).data;
  assert.equal(expectedPeek.nextNumber, 'INV-2026-0002');
}));

test('the displayed next number is the number the approval actually assigns', withApp({}, async (a) => {
  const c = await a.authed();
  const d = await create(c);
  const ready = (await c.post(`/api/documents/${d.id}/submit`, {})).data;
  const issued = (await c.post(`/api/documents/${d.id}/approve`, {})).data;
  assert.equal(issued.number, ready.nextNumber);
}));

// ---------- quotes ----------
test('QUOTES: create -> send (numbered, locked) -> accept -> convert reuses everything; rejected quotes cannot convert', withApp({}, async (a) => {
  const c = await a.authed();
  const q = await create(c, { ...invoiceBody(), type: 'quote', revenueBasis: undefined, validUntil: '2026-10-21', notes: 'Delivery in 2 weeks' });
  assert.equal(q.type, 'quote');
  assert.ok(q.actions.includes('send_quote') && !q.actions.includes('submit'));
  assert.equal((await c.post(`/api/documents/${q.id}/convert`, {})).status, 409); // not accepted yet
  const sent = (await c.post(`/api/documents/${q.id}/send-quote`, {})).data;
  assert.equal(sent.number, 'QT-2026-0001');
  assert.equal(sent.status, 'SENT');
  assert.equal((await c.put(`/api/documents/${q.id}`, { ...invoiceBody(), type: 'quote' })).status, 409);
  assert.ok(sent.actions.includes('accept') && sent.actions.includes('reject_quote'));
  await c.post(`/api/documents/${q.id}/accept`, {});
  const inv = (await c.post(`/api/documents/${q.id}/convert`, {})).data;
  assert.equal(inv.type, 'invoice');
  assert.equal(inv.status, 'DRAFT');
  assert.equal(inv.related.id, q.id); // quote -> invoice relationship
  assert.equal(inv.totals.grossCents, q.totals.grossCents);
  assert.equal(inv.doc.notes, 'Delivery in 2 weeks');
  const quote = (await c.get(`/api/documents/${q.id}`)).data;
  assert.equal(quote.status, 'CONVERTED');
  assert.equal(quote.convertedInvoice.id, inv.id);
  const q2 = await create(c, { ...invoiceBody(), type: 'quote', revenueBasis: undefined });
  await c.post(`/api/documents/${q2.id}/send-quote`, {});
  await c.post(`/api/documents/${q2.id}/reject-quote`, {});
  assert.equal((await c.post(`/api/documents/${q2.id}/convert`, {})).status, 409);
  const list = (await c.get('/api/documents?type=quote&status=CONVERTED')).data.rows;
  assert.equal(list.length, 1);
}));

// ---------- Shopify / POS linking ----------
test('SOURCE-ORDER LINK: search shows no customer data, linking is explained, duplicates are blocked', withApp({}, async (a) => {
  const c = await a.authed();
  const orders = (await c.get('/api/orders')).data.rows;
  assert.ok(orders.length >= 5);
  for (const o of orders) { assert.deepEqual(Object.keys(o).sort(), ['channel', 'date', 'invoiced', 'items', 'moreItems', 'ref', 'refunded', 'sourceOrderId', 'total', 'totalCents']); }
  assert.ok(!/customer|email|phone|name/i.test(Object.keys(orders[0]).join(',')));
  const target = orders.find((o) => o.totalCents === 2000) ?? orders[0];
  assert.equal((await c.get('/api/orders?min=19.99&max=20.01')).data.rows.every((o) => o.totalCents === 2000), true);
  assert.ok((await c.get(`/api/orders?q=${target.ref}`)).data.rows.some((o) => o.ref === target.ref));
  const lines = [{ description: 'Order', quantity: '1', unitPrice: (Math.round(target.totalCents / 1.21) / 100).toFixed(2), vatRate: '21' }];
  const inv = await create(c, invoiceBody({ revenueBasis: 'linked_source_order', sourceOrderId: target.sourceOrderId, lines }));
  assert.match(inv.revenueNote, /does NOT create additional revenue/);
  assert.equal(inv.sourceOrder.ref, target.ref);
  const flagged = (await c.get('/api/orders')).data.rows.find((o) => o.sourceOrderId === target.sourceOrderId);
  assert.equal(flagged.invoiced.id, inv.id); // the picker marks it as already invoiced
  const dup = await c.post('/api/documents', invoiceBody({ revenueBasis: 'linked_source_order', sourceOrderId: target.sourceOrderId, lines }));
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'SOURCE_ORDER_ALREADY_INVOICED');
  const ghost = await create(c, invoiceBody({ revenueBasis: 'linked_source_order', sourceOrderId: 'does-not-exist', lines }));
  assert.ok(ghost.readiness.errors.includes('SOURCE_ORDER_NOT_FOUND_IN_RETAIL_CORE'));
  const standalone = await create(c, invoiceBody());
  assert.match(standalone.revenueNote, /ADDITIVE/);
}));

test('a linked invoice adds no revenue to the accountant pack; a standalone one does', withApp({}, async (a) => {
  const c = await a.authed();
  const target = (await c.get('/api/orders')).data.rows.find((o) => o.totalCents === 2000);
  const before = (await c.post('/api/pack', { from: '2026-09-01', to: '2026-09-30' })).data.pack.totals;
  await issue(c, { revenueBasis: 'linked_source_order', sourceOrderId: target.sourceOrderId, issueDate: target.date, lines: [{ description: 'Order', quantity: '1', unitPrice: '16.53', vatRate: '21' }] });
  const afterLinked = (await c.post('/api/pack', { from: '2026-09-01', to: '2026-09-30' })).data.pack;
  assert.deepEqual(afterLinked.totals, before);
  assert.equal(afterLinked.b2b_linked.documents, 1);
  await issue(c, { issueDate: '2026-09-25' });
  const afterStandalone = (await c.post('/api/pack', { from: '2026-09-01', to: '2026-09-30' })).data.pack;
  assert.equal(afterStandalone.totals.sales_ex_vat_cents, before.sales_ex_vat_cents + 6500);
}));

// ---------- payments, overdue ----------
test('PAYMENTS: partial then full, overpayment refused, bad input refused, overdue is derived', withApp({}, async (a) => {
  const c = await a.authed();
  const inv = await issue(c);
  assert.equal(inv.status, 'ISSUED');
  const p1 = await c.post(`/api/documents/${inv.id}/payments`, { amount: '30.00', paidOn: '2026-09-25', method: 'bank_transfer', reference: 'REF1', note: 'first part' });
  assert.equal(p1.status, 201);
  assert.equal(p1.data.status, 'PARTIALLY_PAID');
  assert.equal(p1.data.settlement.remainingCents, 4190);
  assert.equal(p1.data.payments.length, 1);
  assert.ok(p1.data.events.some((e) => e.action === 'PAYMENT_NOTE' && e.detail.note === 'first part'));
  assert.equal((await c.post(`/api/documents/${inv.id}/payments`, { amount: '50.00', paidOn: '2026-09-26' })).status, 422);
  assert.equal((await c.post(`/api/documents/${inv.id}/payments`, { amount: 'abc', paidOn: '2026-09-26' })).status, 422);
  assert.equal((await c.post(`/api/documents/${inv.id}/payments`, { amount: '1.00', paidOn: '26/09/2026' })).status, 422);
  assert.equal((await c.post(`/api/documents/${inv.id}/payments`, { amount: '1.00', paidOn: '2026-09-26', method: 'bitcoin' })).status, 422);
  a.setToday('2026-12-01');
  const overdue = (await c.get(`/api/documents/${inv.id}`)).data;
  assert.equal(overdue.effectiveStatus, 'OVERDUE'); // derived from the due date, not stored
  assert.equal(overdue.status, 'PARTIALLY_PAID');
  assert.equal((await c.get('/api/documents?status=OVERDUE')).data.rows.length, 1);
  const rec = (await c.get('/api/receivables')).data;
  assert.equal(rec.overdue.count, 1);
  assert.equal(rec.aging['31_60'].count, 1); // 41 days past a 2026-10-21 due date
  const paid = await c.post(`/api/documents/${inv.id}/payments`, { amount: '41.90', paidOn: '2026-12-01', method: 'cash' });
  assert.equal(paid.data.status, 'PAID');
  assert.equal(paid.data.effectiveStatus, 'PAID');
  assert.equal((await c.get('/api/receivables')).data.unpaid.count, 0);
}));

test('CREDIT NOTE from the dashboard: whole or partial, capped at the invoice, then approved', withApp({}, async (a) => {
  const c = await a.authed();
  const inv = await issue(c);
  assert.equal((await c.post(`/api/documents/${inv.id}/credit-note`, { reason: '' })).status, 422);
  assert.equal((await c.post(`/api/documents/${inv.id}/credit-note`, { reason: 'too much', lines: [{ description: 'x', quantity: '1', unitPrice: '500.00', vatRate: '21' }] })).status, 422);
  const cn = (await c.post(`/api/documents/${inv.id}/credit-note`, { reason: 'Returned Item A', lines: [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }] })).data;
  assert.equal(cn.type, 'credit_note');
  assert.equal(cn.totals.grossCents, 1210);
  await c.post(`/api/documents/${cn.id}/submit`, {});
  const issuedCn = (await c.post(`/api/documents/${cn.id}/approve`, {})).data;
  assert.equal(issuedCn.number, 'CN-2026-0001');
  const after = (await c.get(`/api/documents/${inv.id}`)).data;
  assert.equal(after.settlement.creditedCents, 1210);
  assert.equal(after.creditNotes.length, 1);
  assert.ok(after.actions.includes('credit_note'));
}));

// ---------- PDF and UBL ----------
test('PDF preview/download for drafts, issued documents, quotes and credit notes; UBL is prepared but never transmitted', withApp({}, async (a) => {
  const c = await a.authed();
  const draft = await create(c);
  const pdf = await c.get(`/api/documents/${draft.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^inline; filename="invoice_draft\.pdf"/);
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  assert.match((await c.get(`/api/documents/${draft.id}/pdf?download=1`)).headers.get('content-disposition'), /^attachment/);
  const inv = await issue(c, { customer: { ...CUSTOMER_BODY, buyerReference: 'PO-1' } });
  assert.equal((await c.get(`/api/documents/${inv.id}/pdf`)).status, 200);
  const q = await create(c, { ...invoiceBody(), type: 'quote', revenueBasis: undefined });
  assert.equal((await c.get(`/api/documents/${q.id}/pdf`)).status, 200);
  const cn = (await c.post(`/api/documents/${inv.id}/credit-note`, { reason: 'r' })).data;
  assert.equal((await c.get(`/api/documents/${cn.id}/pdf`)).status, 200);
  const ubl = await c.get(`/api/documents/${inv.id}/ubl`);
  assert.equal(ubl.status, 200);
  assert.equal(ubl.headers.get('x-peppol-transmitted'), 'false');
  assert.match(ubl.data.toString(), /<cbc:InvoiceTypeCode>380</);
  const blocked = await c.get(`/api/documents/${draft.id}/ubl`);
  assert.equal(blocked.status, 422);
  assert.equal(blocked.data.error.transmitted, false);
  assert.ok(blocked.data.error.errors.includes('DOCUMENT_NOT_ISSUED'));
}));

// ---------- companies / lookup ----------
test('COMPANIES: directory CRUD, duplicate refusal, history and outstanding amounts, no scoring', withApp({}, async (a) => {
  const c = await a.authed();
  const made = await c.post('/api/companies', { ...CUSTOMER_BODY, source: 'manual' });
  assert.equal(made.status, 201);
  assert.equal((await c.post('/api/companies', { ...CUSTOMER_BODY })).status, 409);
  assert.equal((await c.post('/api/companies', { name: 'Bad', vatNumber: 'BE0123456789' })).status, 422); // checksum
  assert.equal((await c.get('/api/companies?q=exemple')).data.rows.length, 1);
  assert.equal((await c.put(`/api/companies/${made.data.id}`, { ...CUSTOMER_BODY, name: 'Client Exemple SA (renamed)' })).data.name, 'Client Exemple SA (renamed)');
  const inv = await issue(c, { customer: { ...CUSTOMER_BODY, companyId: made.data.id } });
  await c.post(`/api/documents/${inv.id}/payments`, { amount: '20.00', paidOn: '2026-09-25', method: 'cash' });
  const hist = (await c.get(`/api/companies/${made.data.id}`)).data;
  assert.equal(hist.documents.length, 1);
  assert.equal(hist.outstandingCents, 5190);
  assert.equal(hist.payments.totalPaidCents, 2000);
  assert.equal(hist.credit.scoring, 'NOT_IMPLEMENTED');
  assert.equal(inv.doc.customer.companyId, made.data.id);
  assert.equal((await c.get(`/api/companies/${made.data.id}`)).status, 200);
}));

test('COMPANY LOOKUP: VIES prefill, manual fallback when it fails, invalid numbers never leave the machine', async () => {
  const calls = [];
  const fetchImpl = async (u, init) => { calls.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ valid: true, name: 'CLIENT EXEMPLE SA', address: 'AVENUE TEST 2\n5000 NAMUR' }) }; };
  let mode = 'ok';
  const flaky = async (u, init) => { if (mode === 'down') throw new Error('offline'); return fetchImpl(u, init); };
  const a = await startApp({ lookupProviders: () => [createViesProvider({ fetchImpl: flaky }), ManualProvider] });
  try {
    const c = await a.authed();
    const found = (await c.post('/api/companies/lookup', { vatNumber: 'BE0000000196' })).data;
    assert.equal(found.status, 'FOUND');
    assert.deepEqual([found.company.name, found.company.vatNumber, found.company.address.street, found.company.address.postalCode, found.company.address.city], ['CLIENT EXEMPLE SA', 'BE0000000196', 'AVENUE TEST 2', '5000', 'NAMUR']);
    assert.equal(found.manualEntryAvailable, true);
    const invalid = (await c.post('/api/companies/lookup', { vatNumber: 'BE0123456789' })).data;
    assert.equal(invalid.status, 'INVALID_NUMBER');
    assert.equal(calls.length, 1);
    mode = 'down';
    const down = (await c.post('/api/companies/lookup', { vatNumber: 'BE0000000196' })).data;
    assert.equal(down.status, 'UNAVAILABLE');
    assert.equal(down.company, null);
    assert.equal(down.manualEntryAvailable, true); // manual entry is always the fallback
    assert.match(down.message, /manually/);
    const byName = (await c.post('/api/companies/lookup', { name: 'Some Company' })).data;
    assert.equal(byName.status, 'MANUAL_ENTRY_REQUIRED');
    assert.equal((await c.post('/api/companies/lookup', {})).status, 422);
    const saved = await c.post('/api/companies', { ...found.company, source: 'vies' });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.source, 'vies');
    assert.ok(saved.data.verifiedAt);
  } finally { await a.close(); }
});

test('company lookup provider is a setting: manual only means VIES is never contacted', async () => {
  const s = baseSettings(); s.companyLookup.provider = 'manual';
  const a = await startApp({ settings: s });
  try {
    const c = await a.authed();
    const r = (await c.post('/api/companies/lookup', { vatNumber: 'BE0000000196' })).data;
    assert.equal(r.status, 'MANUAL_ENTRY_REQUIRED');
    assert.equal(r.provider, 'manual');
  } finally { await a.close(); }
});

test('a directory company id alone is enough: the identity is loaded from the directory, and an unknown id is refused', withApp({}, async (a) => {
  const c = await a.authed();
  const company = (await c.post('/api/companies', CUSTOMER_BODY)).data;
  const d = await create(c, invoiceBody({ customer: { companyId: company.id } }));
  assert.equal(d.doc.customer.name, 'Client Exemple SA');
  assert.equal(d.doc.customer.vatNumber, 'BE0000000196');
  assert.equal(d.doc.customer.address.city, 'Namur');
  assert.equal((await c.post('/api/documents', invoiceBody({ customer: { companyId: 'no-such-company' } }))).status, 422);
  assert.equal((await c.post('/api/documents', invoiceBody({ customer: {} }))).status, 422); // no id and no name: still required
}));

// ---------- overview ----------
test('OVERVIEW: unpaid, overdue, outstanding, paid this month, awaiting approval, quotes, pack status', withApp({}, async (a) => {
  const c = await a.authed();
  const empty = (await c.get('/api/overview')).data;
  assert.equal(empty.counts.unpaid, 0);
  assert.equal(empty.settingsMissing.length, 0);
  const i1 = await issue(c, { issueDate: '2026-08-01', dueDate: '2026-08-31' }); // overdue at 2026-09-21
  const i2 = await issue(c, { issueDate: '2026-09-15', dueDate: '2026-09-25' }); // due soon
  await c.post(`/api/documents/${i2.id}/payments`, { amount: '10.00', paidOn: '2026-09-20', method: 'cash' });
  const draft = await create(c); await c.post(`/api/documents/${draft.id}/submit`, {});
  const q = await create(c, { ...invoiceBody(), type: 'quote', revenueBasis: undefined }); await c.post(`/api/documents/${q.id}/send-quote`, {});
  const o = (await c.get('/api/overview')).data;
  assert.deepEqual([o.counts.unpaid, o.counts.overdue, o.counts.dueSoon, o.counts.awaitingApproval, o.counts.quotesAwaitingResponse, o.counts.partiallyPaid], [2, 1, 1, 1, 1, 1]);
  assert.equal(o.amounts.outstandingCents, 7190 + 6190);
  assert.equal(o.amounts.paidThisMonthCents, 1000);
  assert.equal(o.attention.overdue[0].number, i1.number);
  assert.equal(o.peppol.status, 'NOT_CONFIGURED');
  const pack = (await c.get('/api/overview/pack')).data;
  assert.equal(pack.status, 'OK');
  assert.ok(['COMPLETE', 'PARTIAL'].includes(pack.completeness));
}));

test('the overview warns when settings are incomplete', withApp({ settings: (() => { const s = baseSettings(); s.seller.iban = null; s.vat.allowedRatesBp = []; return s; })() }, async (a) => {
  const c = await a.authed();
  const o = (await c.get('/api/overview')).data;
  assert.ok(o.settingsMissing.includes('seller.iban') && o.settingsMissing.includes('vat.allowedRatesBp'));
}));

// ---------- accountant pack ----------
test('ACCOUNTANT PACK from the UI API: period, completeness, retail, B2B, VAT, reconciliation and downloads (CSV, PDF, XLSX)', withApp({ history: { completeFrom: '2026-05-11', storeCreatedOn: '2026-05-11', lastSyncedAt: '2026-10-05T00:00:00.000Z' }, today: '2026-10-05' }, async (a) => {
  const c = await a.authed();
  await issue(c, { issueDate: '2026-09-20' });
  const r = await c.post('/api/pack', { from: '2026-08-01', to: '2026-09-30' });
  assert.equal(r.status, 200);
  const p = r.data.pack;
  assert.equal(p.completeness.status, 'COMPLETE'); // closed period, backfill marker, VAT rates captured
  assert.equal(p.reconciliation.status, 'CLEAN');
  assert.equal(p.b2b.standalone_invoices, 1);
  assert.equal(p.retail.vat_by_rate.status, 'COMPLETE');
  assert.equal(p.credit_notes.issued, 0);
  const names = r.data.downloads.map((d) => d.name);
  for (const suffix of ['_summary.csv', '_vat_by_rate.csv', '_documents.csv', '_anomalies.csv', '_summary.pdf', '.xlsx', '.json']) assert.ok(names.some((n) => n.endsWith(suffix)), suffix);
  const pdf = r.data.downloads.find((d) => d.name.endsWith('.pdf'));
  const dl = await c.get(pdf.url);
  assert.equal(dl.status, 200);
  assert.equal(dl.data.subarray(0, 5).toString(), '%PDF-');
  const x = await c.get(r.data.downloads.find((d) => d.name.endsWith('.xlsx')).url);
  const parts = unzip(x.data);
  assert.ok(parts.has('xl/workbook.xml') && parts.has('xl/worksheets/sheet1.xml'));
  assert.match(parts.get('xl/workbook.xml').toString(), /VAT by rate/);
  const csv = (await c.get(r.data.downloads.find((d) => d.name.endsWith('_summary.csv')).url)).data.toString('utf8');
  assert.ok(csv.includes('TOTAL sales excl. VAT'));
  assert.equal((await c.get('/api/pack/file?from=2026-08-01&to=2026-09-30&name=../../.env')).status, 404);
  assert.equal((await c.post('/api/pack', { from: '2026-09-30', to: '2026-09-01' })).status, 422);
  assert.equal((await c.post('/api/pack', { from: 'x', to: 'y' })).status, 422);
  assert.ok(a.audits.some((e) => e.action === 'PACK_GENERATED'));
}));

test('the pack from the API uses the Phase 2A definitions (no second definition of sales)', withApp({}, async (a) => {
  const c = await a.authed();
  const { computeSalesMetrics } = await import('../src/metrics/sales.js');
  const { localMidnight } = await import('../src/metrics/windows.js');
  const p = (await c.post('/api/pack', { from: '2026-09-01', to: '2026-09-30' })).data.pack;
  const m = computeSalesMetrics(a.fake.ledger, { key: 'custom', start: localMidnight('2026-09-01', 'UTC'), end: localMidnight('2026-10-01', 'UTC'), timeZone: 'UTC' });
  assert.equal(p.retail.net_sales, m.net_sales);
  assert.equal(p.retail.net_sales_ex_vat, m.net_sales_ex_tax);
  assert.equal(p.retail.vat, m.tax);
}));

// ---------- settings ----------
test('SETTINGS: validated, persisted, secrets never exposed, logo checked by content, logo path not client-controlled', withApp({}, async (a) => {
  const c = await a.authed();
  const get = await c.get('/api/settings');
  assert.ok(!JSON.stringify(get.data).includes(TOKEN));
  assert.equal(get.data.settings.peppol.status, 'NOT_CONFIGURED');
  assert.equal((await c.put('/api/settings', { seller: { iban: 'BE00 0000 0000 0000' } })).status, 422);
  assert.equal((await c.put('/api/settings', { seller: { vatNumber: 'BE0123456789' } })).status, 422);
  assert.equal((await c.put('/api/settings', { numbering: { format: 'NO-SEQUENCE' } })).status, 422);
  assert.equal((await c.put('/api/settings', { numbering: { format: '{prefix}/{year}/{seq};DROP' } })).status, 422);
  assert.equal((await c.put('/api/settings', { branding: { accent: 'red' } })).status, 422);
  assert.equal((await c.put('/api/settings', { vat: { allowedRatesPercent: ['21', 'abc'] } })).status, 422);
  const ok = await c.put('/api/settings', { seller: { name: 'New Name SRL', iban: 'be68539007547034' }, vat: { allowedRatesPercent: ['21', '12', '6', '0'] }, numbering: { invoice: { prefix: 'FAC', pad: 5 }, format: '{prefix}-{seq}' }, branding: { logoPath: '/etc/passwd', accent: '#112233' }, seller_extra: 'ignored', hacker: true });
  assert.equal(ok.status, 200);
  assert.equal(a.getSettings().seller.name, 'New Name SRL');
  assert.deepEqual(a.getSettings().vat.allowedRatesBp, [2100, 1200, 600, 0]);
  assert.equal(a.getSettings().branding.logoPath, null); // the client cannot set a file path
  assert.equal('hacker' in a.getSettings(), false);
  const inv = await issue(c);
  assert.equal(inv.number, 'FAC-00001'); // the configured numbering format is used
  assert.equal((await c.post('/api/settings/logo', { dataUrl: 'data:text/html;base64,PGh0bWw+' })).status, 422);
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
  assert.equal((await c.post('/api/settings/logo', { dataUrl: png })).status, 200);
  assert.equal((await c.post('/api/settings/logo', { dataUrl: 'data:image/png;base64,' + Buffer.from('not a png at all').toString('base64') })).status, 422);
  assert.ok(a.audits.some((e) => e.action === 'SETTINGS_CHANGED'));
}));

// ---------- tenant isolation / IDOR ----------
test('TENANT ISOLATION: a second merchant cannot read, act on, pay, print or list the first merchant data (404, no enumeration)', async () => {
  const shared = createMemoryStore();
  const A = await startApp({ merchantId: 'merchant-A', store: shared });
  const B = await startApp({ merchantId: 'merchant-B', store: shared });
  try {
    const ca = await A.authed(); const cb = await B.authed();
    const inv = await issue(ca);
    const company = (await ca.post('/api/companies', CUSTOMER_BODY)).data;
    const draft = await create(ca);
    for (const [m, p, b] of [
      ['GET', `/api/documents/${inv.id}`], ['GET', `/api/documents/${inv.id}/pdf`], ['GET', `/api/documents/${inv.id}/ubl`], ['PUT', `/api/documents/${draft.id}`, invoiceBody()],
      ['POST', `/api/documents/${draft.id}/submit`, {}], ['POST', `/api/documents/${inv.id}/payments`, { amount: '1.00', paidOn: '2026-09-25' }], ['POST', `/api/documents/${inv.id}/credit-note`, { reason: 'x' }],
      ['POST', `/api/documents/${inv.id}/mark-sent`, {}], ['GET', `/api/companies/${company.id}`], ['PUT', `/api/companies/${company.id}`, CUSTOMER_BODY],
    ]) { const r = await cb.raw(m, p, b); assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`); }
    assert.equal((await cb.get('/api/documents')).data.rows.length, 0);
    assert.equal((await cb.get('/api/companies')).data.rows.length, 0);
    assert.equal((await cb.get('/api/receivables')).data.unpaid.count, 0);
    assert.equal((await cb.get('/api/overview')).data.counts.unpaid, 0);
    assert.equal((await cb.post('/api/pack', { from: '2026-09-01', to: '2026-09-30' })).data.pack.documents.length, 0);
    const forged = await cb.post('/api/documents', invoiceBody({ customer: { ...CUSTOMER_BODY, companyId: company.id } })); // A's company id used by B
    assert.equal(forged.status, 422);
    assert.equal((await ca.get(`/api/documents/${inv.id}`)).status, 200); // A still sees it
    assert.equal((await ca.get(`/api/documents/${inv.id}`)).data.status, 'ISSUED'); // and it was not modified
  } finally { await A.close(); await B.close(); }
});

test('malformed ids are rejected before touching the store', withApp({}, async (a) => {
  const c = await a.authed();
  for (const id of ['..%2f..%2fetc', 'a b', 'x'.repeat(80), '%00']) assert.ok([400, 404].includes((await c.get(`/api/documents/${id}`)).status));
  assert.equal((await c.get('/api/documents/nonexistent-id')).status, 404);
}));

// ---------- XSS / injection ----------
test('free text is stored as data, control characters are stripped, and the UI builds no HTML from it', withApp({}, async (a) => {
  const c = await a.authed();
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const d = await create(c, invoiceBody({ customer: { ...CUSTOMER_BODY, name: `${evil}\x07\x00` }, notes: `${evil}\x1b[31m`, lines: [{ description: `${evil}\x08`, quantity: '1', unitPrice: '1.00', vatRate: '21' }] }));
  assert.equal(d.doc.customer.name, evil);
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(JSON.stringify(d.doc)));
  const pdf = await c.get(`/api/documents/${d.id}/pdf`);
  assert.equal(pdf.status, 200);
  const ui = readFileSync(new URL('../src/finance/ui/app.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(ui));
  const html = readFileSync(new URL('../src/finance/ui/index.html', import.meta.url), 'utf8');
  assert.ok(!/<script>[^<]|\son\w+=/i.test(html)); // no inline script or handlers
  const csv = readFileSync(new URL('../src/finance/export-csv.js', import.meta.url), 'utf8');
  assert.match(csv, /FORMULA_START/);
}));

test('the UI never calculates money: no arithmetic on amount fields, only display of server values', () => {
  const ui = readFileSync(new URL('../src/finance/ui/app.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/parseFloat|parseInt\(.*(price|amount|total|vat)/i.test(ui));
  assert.ok(!/(unitPrice|quantity|price)\s*\*\s*/i.test(ui));
  assert.ok(!/Math\.round\(.*(price|total|vat|amount)/i.test(ui));
  assert.match(ui, /\/api\/calc/); // totals are requested from the server
});

// ---------- audit ----------
test('AUDIT: every lifecycle action is recorded with actor, transition and time', withApp({}, async (a) => {
  const c = await a.authed();
  const d = await create(c);
  await c.post(`/api/documents/${d.id}/submit`, {});
  await c.post(`/api/documents/${d.id}/approve`, {});
  await c.post(`/api/documents/${d.id}/mark-sent`, {});
  await c.post(`/api/documents/${d.id}/payments`, { amount: '71.90', paidOn: '2026-09-22', method: 'cash', note: 'paid in shop' });
  const events = (await c.get(`/api/documents/${d.id}`)).data.events;
  assert.deepEqual(events.map((e) => e.action).filter((x) => x !== 'PAYMENT_NOTE'), ['CREATE_DRAFT', 'SUBMIT_FOR_APPROVAL', 'APPROVE_AND_ISSUE', 'MARK_SENT', 'RECORD_PAYMENT', 'STATUS_CHANGE']);
  assert.ok(events.every((e) => e.actor && e.actor.type && e.at));
  assert.ok(events.filter((e) => ['APPROVE_AND_ISSUE', 'MARK_SENT'].includes(e.action)).every((e) => e.actor.type === 'merchant'));
}));

// ---------- END TO END ----------
test('END TO END (synthetic): company -> quote -> accept -> convert -> approve -> issue -> PDF -> payment -> PAID', withApp({}, async (a) => {
  const c = await a.authed();
  const company = (await c.post('/api/companies', CUSTOMER_BODY)).data;
  const quote = await create(c, { type: 'quote', customer: { companyId: company.id, name: 'ignored-client-value' }, lines: LINES_BODY, vat: { regime: 'domestic', confirmed: true }, issueDate: '2026-09-21', validUntil: '2026-10-21', paymentTerms: '30 days net', notes: 'Thanks' });
  assert.equal(quote.doc.customer.name, 'Client Exemple SA'); // identity comes from the directory, not the client
  const sent = (await c.post(`/api/documents/${quote.id}/send-quote`, {})).data;
  assert.equal(sent.number, 'QT-2026-0001');
  assert.equal((await c.post(`/api/documents/${quote.id}/accept`, {})).data.status, 'ACCEPTED');
  const invoice = (await c.post(`/api/documents/${quote.id}/convert`, {})).data;
  assert.equal(invoice.relatedDocumentId, quote.id);
  assert.equal(invoice.totals.grossCents, 7190);
  assert.equal((await c.post(`/api/documents/${invoice.id}/submit`, {})).data.status, 'READY_FOR_APPROVAL');
  const issued = (await c.post(`/api/documents/${invoice.id}/approve`, {})).data;
  assert.equal(issued.number, 'INV-2026-0001');
  assert.equal(issued.status, 'ISSUED');
  const pdf = await c.get(`/api/documents/${invoice.id}/pdf`);
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  await c.post(`/api/documents/${invoice.id}/mark-sent`, {});
  const paid = (await c.post(`/api/documents/${invoice.id}/payments`, { amount: '71.90', paidOn: '2026-09-28', method: 'bank_transfer', reference: 'INV-2026-0001' })).data;
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.settlement.remainingCents, 0);
  assert.equal(paid.integrity.ok, true);
  assert.equal((await c.get(`/api/companies/${company.id}`)).data.outstandingCents, 0);
  assert.equal((await c.get('/api/receivables')).data.unpaid.count, 0);
  assert.equal((await c.post(`/api/documents/${invoice.id}/payments`, { amount: '1.00', paidOn: '2026-09-29' })).status, 409); // nothing left to pay
}));
