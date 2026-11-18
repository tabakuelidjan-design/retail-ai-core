import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRecommandProvider, recommandConfigStatus, RECOMMAND_INVOICE_DOCTYPE_ID, RECOMMAND_API } from '../src/finance/peppol-recommand.js';
import { ProviderError } from '../src/finance/peppol-provider.js';

// SIMULATED transport: the fetch stub records requests and answers as the documented API would. No network, no real company.
const INVOICE = '<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID xmlns:cbc="x">FICTIF-1</cbc:ID></Invoice>';
const CREDIT = '<?xml version="1.0"?><CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"><cbc:ID xmlns:cbc="x">FICTIF-CN-1</cbc:ID></CreditNote>';
const cfg = { apiKey: 'key_fictif', apiSecret: 'secret_fictif', companyId: 'co_fictif', webhookSecret: 'whsec_fictif', environment: 'playground' };
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function stub(answer) { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return typeof answer === 'function' ? answer(url, init) : answer; }; f.calls = calls; return f; }
const RECEIVER = { scheme: '0208', id: '0123456848' };

test('not configured: the card says A CONFIGURER, nothing is sent', async () => {
  const p = createRecommandProvider({});
  assert.equal(p.configured, false);
  assert.deepEqual((await p.health()), { ok: false, detail: 'A_CONFIGURER' });
  await assert.rejects(p.submit({ idempotencyKey: 'k', payload: INVOICE, receiver: RECEIVER }), (e) => e instanceof ProviderError && e.code === 'A_CONFIGURER');
});

test('server-side secrets: names only are reported, missing ones listed', () => {
  assert.deepEqual(recommandConfigStatus({}).missing, ['RECOMMAND_API_KEY', 'RECOMMAND_API_SECRET', 'RECOMMAND_COMPANY_ID']);
  assert.equal(recommandConfigStatus({ RECOMMAND_API_KEY: 'a', RECOMMAND_API_SECRET: 'b', RECOMMAND_COMPANY_ID: 'c' }).configured, true);
});

test('invoice XML: POST /send with Basic auth, the documented doctypeId, raw XML, no PDF generated', async () => {
  const f = stub(reply(200, { success: true, deliveries: [{ id: 'dlv_1', status: 'pending' }], deliveryStatus: 'pending' }));
  const p = createRecommandProvider({ ...cfg, fetchImpl: f });
  const r = await p.submit({ idempotencyKey: 'msg-1', payload: INVOICE, receiver: RECEIVER });
  assert.equal(r.providerMessageId, 'dlv_1');
  const { url, init } = f.calls[0];
  assert.equal(url, `${RECOMMAND_API}/co_fictif/send`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from('key_fictif:secret_fictif').toString('base64')}`);
  const body = JSON.parse(init.body);
  assert.equal(body.documentType, 'xml');
  assert.equal(body.doctypeId, RECOMMAND_INVOICE_DOCTYPE_ID);
  assert.equal(body.recipient, '0208:0123456848');
  assert.equal(body.pdfGeneration.enabled, false);
  assert.equal(body.document, INVOICE);
  assert.equal((await p.findByIdempotencyKey('msg-1')).found, true);
});

test('CREDIT NOTE: refused before any request, because its doctypeId is not confirmed (never sent with a guessed type)', async () => {
  const f = stub(reply(200, { success: true, deliveries: [{ id: 'x' }] }));
  const p = createRecommandProvider({ ...cfg, fetchImpl: f });
  await assert.rejects(p.submit({ idempotencyKey: 'cn-1', payload: CREDIT, receiver: RECEIVER }), (e) => e.outcome === 'REJECTED' && e.code === 'CREDIT_NOTE_DOCTYPE_NOT_CONFIRMED');
  assert.equal(f.calls.length, 0);
  assert.equal((await p.findByIdempotencyKey('cn-1')).found, false, 'a definite refusal: a resend is safe');
});

test('timeout: UNKNOWN, and the anti-duplicate answer is HOLD (found: null), never a resend', async () => {
  const f = stub(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const p = createRecommandProvider({ ...cfg, fetchImpl: f, timeoutMs: 5 });
  await assert.rejects(p.submit({ idempotencyKey: 'msg-2', payload: INVOICE, receiver: RECEIVER }), (e) => e.outcome === 'UNKNOWN');
  assert.equal((await p.findByIdempotencyKey('msg-2')).found, null);
});

test('HTTP 500 after a possible acceptance: UNKNOWN and HOLD', async () => {
  const p = createRecommandProvider({ ...cfg, fetchImpl: stub(reply(500, {})) });
  await assert.rejects(p.submit({ idempotencyKey: 'msg-3', payload: INVOICE, receiver: RECEIVER }), (e) => e.outcome === 'UNKNOWN');
  assert.equal((await p.findByIdempotencyKey('msg-3')).found, null);
});

test('HTTP 401 and validation errors: nothing accepted (safe to fix and retry)', async () => {
  const p1 = createRecommandProvider({ ...cfg, fetchImpl: stub(reply(401, {})) });
  await assert.rejects(p1.submit({ idempotencyKey: 'a', payload: INVOICE, receiver: RECEIVER }), (e) => e.outcome === 'UNAVAILABLE' && e.code === 'CREDENTIALS_REJECTED');
  const p2 = createRecommandProvider({ ...cfg, fetchImpl: stub(reply(422, { success: false, errors: { 'buyer.vatNumber': ['invalid'] } })) });
  await assert.rejects(p2.submit({ idempotencyKey: 'b', payload: INVOICE, receiver: RECEIVER }), (e) => e.outcome === 'REJECTED');
  assert.equal((await p2.findByIdempotencyKey('b')).found, false);
});

test('a restarted process forgets its outcomes: an earlier attempt is UNKNOWN, so it is HELD', async () => {
  const p = createRecommandProvider({ ...cfg, fetchImpl: stub(reply(200, { success: true, deliveries: [{ id: 'dlv_9' }] })) });
  await p.submit({ idempotencyKey: 'msg-4', payload: INVOICE, receiver: RECEIVER });
  const restarted = createRecommandProvider({ ...cfg, fetchImpl: stub(reply(200, {})) });
  assert.equal((await restarted.findByIdempotencyKey('msg-4')).found, null);
});

test('webhook: X-Signature sha256=<hex> over the raw body; a wrong or missing signature is refused', () => {
  const p = createRecommandProvider({ ...cfg });
  const raw = '{"eventType":"document.delivery_status_changed"}';
  const good = `sha256=${createHmac('sha256', 'whsec_fictif').update(raw).digest('hex')}`;
  assert.equal(p.verifyWebhook({ 'x-signature': good }, raw).ok, true);
  assert.equal(p.verifyWebhook({ 'x-signature': good }, raw + ' ').ok, false);
  assert.equal(p.verifyWebhook({}, raw).ok, false);
});

test('inbound: reception stays with CodaBox (nothing is fetched from Recommand)', async () => {
  const p = createRecommandProvider({ ...cfg, fetchImpl: stub(reply(200, {})) });
  assert.deepEqual(await p.fetchInbound(), []);
});
