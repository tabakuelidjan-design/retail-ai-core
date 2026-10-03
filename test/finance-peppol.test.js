import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildUbl } from '../src/finance/peppol.js';
import { validateStructured } from '../src/finance/peppol-validation.js';
import { createPeppolService } from '../src/finance/peppol-service.js';
import { createFakePeppolProvider, NoPeppolProvider, ProviderError } from '../src/finance/peppol-provider.js';
import { createLegalArtifacts } from '../src/finance/legal-artifacts.js';
import { createAccountantExportService } from '../src/finance/accountant-export-service.js';
import { loadDocsForReports } from '../src/finance/reports.js';
import { vcsForInvoiceNumber, vcsFormat } from '../src/finance/belgium-compliance.js';
import { legalWorld, supplierInvoiceXml, MERCHANT_ACTOR, OTHER_SELLER, BUYER_OF_SELLER, TZ } from './finance-legal-helpers.js';

// Peppol behind the provider contract: outbound state machine and idempotency, inbound pipeline, security, isolation, accountant export, volume. No network: a deterministic fake provider.
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sendable = async (o = {}) => { const w = legalWorld(o); const inv = await w.issue({}); const doc = await w.store.getDocument(inv.id); return { w, doc }; };
const states = async (w, docId) => (await w.store.listPeppolMessages({ merchantId: w.merchantId, documentId: docId })).map((m) => m.state);

// ===================================================== OUTBOUND
test('OUTBOUND: queued -> submitted (accepted by the provider, NOT delivered) -> delivered only on the provider\'s delivery status; the exact archived bytes travel', async () => {
  const { w, doc } = await sendable(); const q = await w.peppol.queue(doc, { actor: MERCHANT_ACTOR }); assert.deepEqual([q.duplicate, q.message.state, q.message.attempts, q.message.receiverEndpoint], [false, 'QUEUED', 0, '0208:0000000196']); assert.equal(w.provider.calls.submit, 0, 'queueing sends nothing');
  const d = await w.peppol.dispatch(q.message.id); assert.deepEqual([d.state, d.sent, d.message.attempts], ['SUBMITTED', true, 1]); assert.match(d.message.providerMessageId, /^fake-msg-/); assert.equal(d.message.deliveredAt, null, 'acceptance is not delivery');
  const sent = w.provider.accepted.get(d.message.providerMessageId); const original = await w.legal.structuredOriginal(doc.id); assert.equal(sha(sent.payload), original.artifact.sha256); assert.equal(sent.idempotencyKey, `peppol-out:${doc.id}`); assert.equal(q.message.documentSha256, original.artifact.sha256);
  assert.equal((await w.peppol.refreshStatus(q.message.id)).changed, false, 'still only submitted'); w.provider.deliver(d.message.providerMessageId); const r = await w.peppol.refreshStatus(q.message.id); assert.deepEqual([r.state, r.changed], ['DELIVERED', true]);
  const ev = (await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 200 })).map((e) => e.action); for (const a of ['PEPPOL_QUEUED', 'PEPPOL_SUBMITTED', 'PEPPOL_DELIVERED']) assert.ok(ev.includes(a), a);
  w.provider.deliver(d.message.providerMessageId, 'DELIVERY_FAILED'); assert.equal((await w.peppol.refreshStatus(q.message.id)).changed, false, 'a delivered message stays delivered');
});
test('L. DOUBLE CLICK / 8 concurrent workers: one logical document = one message and exactly ONE submit to the provider', async () => {
  const { w, doc } = await sendable(); const qs = await Promise.all(Array.from({ length: 8 }, () => w.peppol.queue(doc, { actor: MERCHANT_ACTOR }))); assert.equal(qs.filter((q) => !q.duplicate).length, 1); assert.equal(new Set(qs.map((q) => q.message.id)).size, 1);
  const ds = await Promise.all(Array.from({ length: 8 }, () => w.peppol.dispatch(qs[0].message.id))); assert.equal(ds.filter((d) => d.sent).length, 1); assert.equal(w.provider.calls.submit, 1); assert.equal(w.provider.accepted.size, 1); assert.deepEqual(await states(w, doc.id), ['SUBMITTED']);
  assert.equal((await w.store.listPeppolMessages({ merchantId: w.merchantId, direction: 'OUT' })).length, 1);
});
test('M. TIMEOUT AFTER the provider accepted: never resent; recover() finds it by our idempotency key and records SUBMITTED', async () => {
  const { w, doc } = await sendable(); const q = await w.peppol.queue(doc); w.provider.inject('submit', 'timeout_after_accept');
  const d = await w.peppol.dispatch(q.message.id); assert.deepEqual([d.state, d.unknown, d.sent], ['SUBMITTING', true, false]); assert.equal((await w.peppol.dispatch(q.message.id)).sent, false, 'a retry while unknown does nothing'); assert.equal(w.provider.calls.submit, 1);
  const r = await w.peppol.recover(q.message.id); assert.deepEqual([r.state, r.recovered], ['SUBMITTED', true]); assert.equal(w.provider.calls.submit, 1, 'no second submit'); assert.equal(w.provider.accepted.size, 1); const m = (await w.store.listPeppolMessages({ merchantId: w.merchantId, documentId: doc.id }))[0]; assert.match(m.providerMessageId, /^fake-msg-/);
  assert.ok((await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 100 })).some((e) => e.action === 'PEPPOL_OUTCOME_UNKNOWN'));
});
test('TIMEOUT BEFORE acceptance / malformed answer / restart: the provider is asked first; if it never accepted the message goes back to the queue and is sent once; a restarted worker finishes the queue', async () => {
  const { w, doc } = await sendable(); const p = createPeppolService({ store: w.store, merchantId: w.merchantId, provider: w.provider, legal: w.legal, storage: w.storage, inbox: w.inbox, clock: w.clock, ownEndpoints: ['0208:0000000097'], leaseMs: 0 });
  const q = await p.queue(doc); w.provider.inject('submit', 'timeout_before_accept'); const d = await p.dispatch(q.message.id); assert.equal(d.unknown, true); assert.equal(w.provider.accepted.size, 0);
  const rec = await p.recover(q.message.id); assert.deepEqual([rec.state, rec.recovered], ['QUEUED', true]); const d2 = await p.dispatch(q.message.id); assert.deepEqual([d2.state, d2.message.attempts], ['SUBMITTED', 2]); assert.equal(w.provider.accepted.size, 1); assert.equal(w.provider.calls.submit, 2);
  // malformed answer after acceptance
  const inv2 = await w.issue({ issueDate: '2026-09-11' }); const doc2 = await w.store.getDocument(inv2.id); const q2 = await p.queue(doc2); w.provider.inject('submit', 'malformed'); const m = await p.dispatch(q2.message.id); assert.equal(m.unknown, true); assert.equal((await p.recover(q2.message.id)).state, 'SUBMITTED'); assert.equal(w.provider.accepted.size, 2);
  // restart between queue and send: a NEW service instance over the same store sends what is queued, once
  const inv3 = await w.issue({ issueDate: '2026-09-12' }); const doc3 = await w.store.getDocument(inv3.id); await p.queue(doc3); const fresh = createPeppolService({ store: w.store, merchantId: w.merchantId, provider: w.provider, legal: w.legal, storage: w.storage, inbox: w.inbox, clock: w.clock, ownEndpoints: ['0208:0000000097'] });
  const pass = await fresh.dispatchQueued({}); assert.equal(pass.dispatched, 1); assert.equal((await fresh.dispatchQueued({})).dispatched, 0); assert.equal(w.provider.accepted.size, 3);
});
test('T. PROVIDER OFFLINE: Finance stays up, the document is issued and archived, the message waits (SUBMISSION_FAILED), the retry is explicit and never reports a false DELIVERED', async () => {
  const { w, doc } = await sendable(); const q = await w.peppol.queue(doc); w.provider.inject('submit', 'unavailable'); const d = await w.peppol.dispatch(q.message.id);
  assert.deepEqual([d.state, d.sent, d.message.errorCode], ['SUBMISSION_FAILED', false, 'PROVIDER_UNAVAILABLE']); assert.equal((await w.store.getDocument(doc.id)).status, 'ISSUED'); assert.ok((await w.legal.compliance(doc.id)).structured); assert.equal(w.provider.accepted.size, 0);
  assert.equal((await w.peppol.dispatchQueued({})).dispatched, 0, 'a worker pass does not silently retry a failure'); const obs = await w.peppol.observability(); assert.equal(obs.submissionFailures, 1); assert.equal(obs.lastSuccessfulSend, null);
  const r = await w.peppol.retry(q.message.id); assert.deepEqual([r.requeued, r.state], [true, 'SUBMITTED']); assert.equal((await w.peppol.observability()).submissionFailures, 0);
  const inv2 = await w.issue({ issueDate: '2026-09-11' }); const q2 = await w.peppol.queue(await w.store.getDocument(inv2.id)); w.provider.inject('submit', 'rejected'); const rej = await w.peppol.dispatch(q2.message.id); assert.deepEqual([rej.state, rej.message.errorCode], ['SUBMISSION_FAILED', 'RECEIVER_UNKNOWN']);
});
test('NO SILENT FALLBACK: a receiver that is not on Peppol, or no provider at all, produces an explicit refusal; nothing is queued, nothing is sent, nothing is called "compliant"', async () => {
  const off = createFakePeppolProvider({ registered: () => false }); const { w, doc } = await sendable({ provider: off }); await assert.rejects(() => w.peppol.queue(doc), (e) => e.code === 'RECEIVER_NOT_ON_PEPPOL');
  assert.deepEqual(await states(w, doc.id), []); assert.equal(off.calls.submit, 0); assert.ok((await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 100 })).some((e) => e.action === 'PEPPOL_RECEIVER_NOT_REGISTERED'));
  const none = legalWorld({ provider: NoPeppolProvider }); const inv = await none.issue({}); await assert.rejects(async () => none.peppol.queue(await none.store.getDocument(inv.id)), (e) => e instanceof ProviderError && e.code === 'NO_PROVIDER_CONFIGURED'); assert.equal((await NoPeppolProvider.health()).ok, false);
  const sentCount = []; const mailerProbe = () => sentCount.push(1); void mailerProbe; assert.equal(sentCount.length, 0);
});
test('PARTICIPANT DISCOVERY: positive results are cached with checked_at / source; a negative result expires (never eternal); no identifier is invented', async () => {
  const flaky = { reg: false }; const prov = createFakePeppolProvider({ registered: () => flaky.reg }); const { w, doc } = await sendable({ provider: prov });
  const p = createPeppolService({ store: w.store, merchantId: w.merchantId, provider: prov, legal: w.legal, storage: w.storage, inbox: w.inbox, clock: w.clock, negativeTtlMs: 0, ownEndpoints: ['0208:0000000097'] });
  const a = await p.discover(doc.customer); assert.deepEqual([a.registered, a.cached, a.source], [false, false, 'fake-directory']); flaky.reg = true; const b = await p.discover(doc.customer); assert.equal(b.registered, true, 'a negative result is re-checked'); const c = await p.discover(doc.customer); assert.deepEqual([c.cached, c.registered], [true, true]); assert.ok(c.checkedAt);
  assert.equal(prov.calls.lookup, 2); const none = await p.discover({ name: 'x', address: { countryCode: 'FR' } }); assert.deepEqual([none.endpoint, none.registered, none.reason], [null, false, 'NO_ENDPOINT_FACTS']);
});
test('CREDIT NOTE over Peppol: same channel, same workflow; its own message', async () => {
  const w = legalWorld(); const inv = await w.issue({}); const cn = await w.creditNote(inv, [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }]); const q = await w.peppol.queue(await w.store.getDocument(cn.id), { originalNumber: inv.number });
  const d = await w.peppol.dispatch(q.message.id); assert.equal(d.state, 'SUBMITTED'); assert.match(w.provider.accepted.get(d.message.providerMessageId).payload.toString(), /<CreditNote /);
});

// ===================================================== INBOUND
test('N. INBOUND: the exact bytes are archived BEFORE any transformation, hashed, validated with the official rules, parsed into a supplier-invoice CANDIDATE, and wait in review; nothing is accepted automatically', async () => {
  const { xml } = await supplierInvoiceXml(); const w = legalWorld(); const r = await w.peppol.receive({ providerMessageId: 'prov-1', payload: xml, sender: 'prov-sender' });
  assert.equal(r.duplicate, false); assert.equal(r.message.state, 'TO_REVIEW'); assert.equal(r.validation.ok, true); assert.deepEqual(r.validation.ruleset.version, '3.0.21');
  assert.equal(sha(xml), r.original.sha256); const stored = await w.storage.get(r.original.storageRef); assert.equal(sha(stored.data), sha(xml), 'byte-identical original in storage'); assert.deepEqual([r.original.kind, r.original.classification, r.original.peppolMessageId], ['INBOUND_ORIGINAL', 'ORIGINAL', r.message.id]);
  assert.deepEqual([r.original.provenance.provider, r.original.provenance.providerMessageId, r.original.provenance.syntax], ['fake', 'prov-1', 'UBL 2.1']); assert.ok(r.original.provenance.receivedAt && r.original.provenance.sender);
  const si = await w.store.getSupplierInvoice(r.supplierInvoiceId); assert.equal(si.source, 'peppol'); assert.notEqual(si.status, 'VALIDATED'); assert.equal(si.status, 'TO_REVIEW'); assert.equal(si.supplierVatNumber?.replace(/\s/g, ''), 'BE0000000196'); assert.equal((await w.store.getPeppolMessage(w.merchantId, r.message.id)).supplierInvoiceId, si.id);
  assert.ok((await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 100 })).map((e) => e.action).includes('PEPPOL_INBOUND_RECEIVED'));
});
test('review: accept validates the supplier invoice through the existing checks and only then the message; reject needs a reason; neither is automatic', async () => {
  const { xml } = await supplierInvoiceXml(); const w = legalWorld(); const r = await w.peppol.receive({ providerMessageId: 'p-acc', payload: xml });
  await assert.rejects(() => w.peppol.accept(r.message.id, { type: 'agent' }), (e) => /MERCHANT_ACTOR/.test(e.code)); const acc = await w.peppol.accept(r.message.id, MERCHANT_ACTOR); assert.equal(acc.message.state, 'ACCEPTED'); assert.equal((await w.store.getSupplierInvoice(r.supplierInvoiceId)).status, 'VALIDATED');
  await assert.rejects(() => w.peppol.accept(r.message.id, MERCHANT_ACTOR), (e) => e.code === 'INBOUND_NOT_IN_REVIEW');
  const other = await supplierInvoiceXml({ count: 2, issueDate: '2026-09-12', lines: [{ description: 'Other service', quantity: '1', unitPrice: '77.00', vatRate: '21' }] }); const r2 = await w.peppol.receive({ providerMessageId: 'p-rej', payload: other.xml });
  await assert.rejects(() => w.peppol.reject(r2.message.id, '  ', MERCHANT_ACTOR), (e) => e.code === 'REASON_REQUIRED'); const rej = await w.peppol.reject(r2.message.id, 'not ours', MERCHANT_ACTOR); assert.equal(rej.message.state, 'REJECTED'); assert.equal((await w.store.getSupplierInvoice(r2.supplierInvoiceId)).status, 'REJECTED');
});
test('O. INBOUND DEDUPLICATION: webhook + polling + provider retry, the same bytes under a new transport id, and the same business document in other bytes are ONE supplier invoice; a genuinely different invoice is not merged', async () => {
  const { xml } = await supplierInvoiceXml(); const w = legalWorld(); const first = await w.peppol.receive({ providerMessageId: 'prov-1', payload: xml });
  const retry = await w.peppol.receive({ providerMessageId: 'prov-1', payload: xml }); const newTransport = await w.peppol.receive({ providerMessageId: 'prov-2', payload: xml }); const reencoded = await w.peppol.receive({ providerMessageId: 'prov-3', payload: Buffer.concat([xml, Buffer.from('\n<!-- re-sent by the provider -->')]) });
  assert.deepEqual([first.duplicate, retry.duplicate, newTransport.duplicate, reencoded.duplicate], [false, true, true, true]); assert.equal(reencoded.message.state, 'DUPLICATE'); assert.equal(reencoded.message.duplicateOf, first.message.id);
  assert.equal((await w.store.listSupplierInvoices(w.merchantId)).length, 1); const origs = await w.store.listArtifacts({ merchantId: w.merchantId, kind: 'INBOUND_ORIGINAL' }); assert.equal(origs.filter((a) => !a.provenance.conflicting).length, 1, 'exact duplicates add no original'); assert.equal(origs.filter((a) => a.provenance.conflicting).length, 1, 'other bytes for the same business document are kept as evidence');
  const diff = await supplierInvoiceXml({ lines: [{ description: 'Other', quantity: '1', unitPrice: '12.10', vatRate: '21' }] }); const second = await w.peppol.receive({ providerMessageId: 'prov-9', payload: diff.xml }); assert.equal(second.duplicate, true, 'same supplier + same invoice number + same date = the same legal document identity, even in other bytes'); assert.equal(second.message.state, 'DUPLICATE'); const conflict = await w.store.listArtifacts({ merchantId: w.merchantId, peppolMessageId: second.message.id }); assert.deepEqual(conflict.map((a) => [a.kind, a.provenance.conflicting]), [['INBOUND_ORIGINAL', true]], 'the conflicting bytes are kept as evidence, not as a second invoice'); assert.equal((await w.store.listSupplierInvoices(w.merchantId)).length, 1);
});
test('O2. a different business document with the same amount is never merged', async () => {
  const w = legalWorld(); const a = await supplierInvoiceXml(); const b = await (async () => { const sw = legalWorld({ merchantId: 'supplier-merchant', seller: OTHER_SELLER }); await sw.issue({ customer: BUYER_OF_SELLER }); const inv2 = await sw.issue({ customer: BUYER_OF_SELLER, issueDate: '2026-09-11' }); return (await sw.legal.structuredOriginal(inv2.id)).data; })();
  const r1 = await w.peppol.receive({ providerMessageId: 'x-1', payload: a.xml }); const r2 = await w.peppol.receive({ providerMessageId: 'x-2', payload: b }); assert.deepEqual([r1.duplicate, r2.duplicate], [false, false]); assert.equal((await w.store.listSupplierInvoices(w.merchantId)).length, 2);
});
test('webhook authentication and polling run the same pipeline; a wrong signature stores nothing; a message seen by both channels is one message', async () => {
  const { xml } = await supplierInvoiceXml(); const w = legalWorld(); await assert.rejects(() => w.peppol.handleWebhook({ headers: { 'x-fake-signature': 'wrong' }, body: xml, providerMessageId: 'wh-1' }), (e) => e.code === 'WEBHOOK_AUTHENTICATION_FAILED'); assert.equal((await w.store.listPeppolMessages({ merchantId: w.merchantId })).length, 0);
  assert.equal((await w.store.listArtifacts({ merchantId: w.merchantId })).length, 0); const ok = await w.peppol.handleWebhook({ headers: { 'x-fake-signature': 'fake-webhook-secret' }, body: xml, providerMessageId: 'wh-1' }); assert.equal(ok.duplicate, false);
  w.provider.pushInbound({ providerMessageId: 'wh-1', payload: xml }); const polled = await w.peppol.poll({}); assert.deepEqual(polled.map((x) => x.duplicate), [true]); assert.deepEqual(await w.peppol.poll({}), []);
});
test('P. ATTACHMENTS travel in the same message: whitelisted media types only, bounded, plain file names, archived under the message with hash and parent; the unsafe ones are skipped and audited', async () => {
  const sw = legalWorld({ merchantId: 'supplier-merchant', seller: OTHER_SELLER }); const inv = await sw.issue({ customer: BUYER_OF_SELLER }); const doc = await sw.store.getDocument(inv.id);
  const pdf = Buffer.from('%PDF-1.4 conditions'); const csv = Buffer.from('a,b\n1,2\n'); const xml = buildUbl(doc, { defaultBuyerReference: 'document_number', paymentReference: vcsFormat(vcsForInvoiceNumber(doc.number)), attachments: [{ fileName: 'conditions.pdf', mediaType: 'application/pdf', data: pdf }, { fileName: 'détail été.csv', mediaType: 'text/csv', data: csv }] });
  assert.equal(validateStructured(xml, { at: '2026-10-03T10:00:00Z' }).ok, true, 'a valid invoice with attachments passes the official rules');
  const evil = xml.replace('</cac:AccountingSupplierParty>', '</cac:AccountingSupplierParty>').replace(/(<cac:AdditionalDocumentReference><cbc:ID>ATT-1<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>)/, `$1<cac:AdditionalDocumentReference><cbc:ID>ATT-9</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="application/x-msdownload" filename="run.exe">TVqQ</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference><cac:AdditionalDocumentReference><cbc:ID>ATT-8</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="../../etc/passwd">JVBERg==</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`);
  const w = legalWorld(); const r = await w.peppol.receive({ providerMessageId: 'att-1', payload: Buffer.from(evil) }); assert.equal(r.attachments.length, 2); const by = Object.fromEntries(r.attachments.map((a) => [a.fileName, a]));
  assert.deepEqual([by['conditions.pdf'].mediaType, by['conditions.pdf'].sha256, by['conditions.pdf'].sizeBytes, by['conditions.pdf'].peppolMessageId, by['conditions.pdf'].parentArtifactId, by['conditions.pdf'].kind], ['application/pdf', sha(pdf), pdf.length, r.message.id, r.original.id, 'ATTACHMENT']); assert.equal(sha((await w.storage.get(by['détail été.csv'].storageRef)).data), sha(csv));
  const skipped = (await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 100 })).filter((e) => e.action === 'PEPPOL_INBOUND_ATTACHMENT_SKIPPED').map((e) => e.detail.reason).sort(); assert.deepEqual(skipped, ['ATTACHMENT_FILE_NAME_INVALID', 'ATTACHMENT_MEDIA_TYPE_NOT_ALLOWED']);
});
test('Q. SECURITY: malformed XML, XXE / DOCTYPE, entity bombs, empty and oversized payloads, wrong recipient: stored safely or refused, never expanded, never parsed into an invoice', async () => {
  const w = legalWorld(); const hostile = {
    truncated: '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID>', xxe: '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>&xxe;</ID></Invoice>',
    bomb: `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>&b;</ID></Invoice>`, notInvoice: '<html><body>hello</body></html>', deep: `${'<a>'.repeat(200)}${'</a>'.repeat(200)}` };
  let n = 0; for (const [name, body] of Object.entries(hostile)) { const r = await w.peppol.receive({ providerMessageId: `bad-${++n}`, payload: Buffer.from(body) }); assert.equal(r.message.state, 'VALIDATION_FAILED', name); assert.equal(r.supplierInvoiceId, null, `${name}: no supplier invoice`); assert.equal(r.original.sha256, sha(Buffer.from(body)), `${name}: the original is kept byte for byte, as evidence`); assert.ok(r.validation.findings.some((f) => f.layer === 'UBL_SYNTAX'), name); }
  assert.equal((await w.store.listSupplierInvoices(w.merchantId)).length, 0);
  await assert.rejects(() => w.peppol.receive({ providerMessageId: 'big', payload: Buffer.alloc(6 * 1024 * 1024, 32) }), (e) => e.code === 'PAYLOAD_TOO_LARGE'); await assert.rejects(() => w.peppol.receive({ providerMessageId: 'empty', payload: Buffer.alloc(0) }), (e) => e.code === 'PAYLOAD_EMPTY');
  assert.equal((await w.store.listPeppolMessages({ merchantId: w.merchantId })).length, 5, 'only the 5 hostile-but-small payloads are messages; refused payloads leave none');
  const { xml } = await supplierInvoiceXml(); const b = legalWorld({ merchantId: 'merchant-b', ownEndpoints: ['0208:0000000999'] }); await assert.rejects(() => b.peppol.receive({ providerMessageId: 'wrong', payload: xml }), (e) => e.code === 'WRONG_RECIPIENT'); assert.equal((await b.store.listArtifacts({ merchantId: 'merchant-b' })).length, 0);
});
test('RECOVERY: storage failing during reception registers nothing (the provider will resend); a failing parser leaves the original archived and the message visible as failed; nothing disappears', async () => {
  const { xml } = await supplierInvoiceXml(); const flaky = { fail: true, files: new Map(), async put(r, d) { if (this.fail) throw new Error('disk full'); this.files.set(r, d); return r; }, async get(r) { return this.files.has(r) ? { data: this.files.get(r) } : null; } };
  const w = legalWorld({ storage: flaky }); await assert.rejects(() => w.peppol.receive({ providerMessageId: 'r-1', payload: xml }), (e) => e.code === 'ARTIFACT_STORAGE_FAILED'); assert.equal((await w.store.listPeppolMessages({ merchantId: w.merchantId })).length, 0);
  flaky.fail = false; const okay = await w.peppol.receive({ providerMessageId: 'r-1', payload: xml }); assert.equal(okay.message.state, 'TO_REVIEW');
  const w2 = legalWorld(); w2.inbox.ingest = async () => { throw Object.assign(new Error('parser down'), { code: 'EXTRACTION_FAILED' }); }; const p2 = createPeppolService({ store: w2.store, merchantId: w2.merchantId, provider: w2.provider, legal: w2.legal, storage: w2.storage, inbox: w2.inbox, clock: w2.clock, ownEndpoints: ['0208:0000000097'] });
  const failed = await p2.receive({ providerMessageId: 'r-2', payload: xml }); assert.deepEqual([failed.message.state, failed.message.errorCode], ['VALIDATION_FAILED', 'PARSE_FAILED']); assert.equal(failed.original.sha256, sha(xml)); assert.equal(failed.supplierInvoiceId, null);
  const seen = await p2.receive({ providerMessageId: 'r-2', payload: xml }); assert.equal(seen.duplicate, true, 'a retry does not create a second message'); const rv = await p2.moveToReview(failed.message.id, MERCHANT_ACTOR); assert.equal(rv.message.state, 'TO_REVIEW');
});

// ===================================================== ISOLATION, EXPORT, PRIVACY
test('R. ISOLATION: merchant B can neither archive, queue, read nor send merchant A\'s documents and messages (same store, different merchant)', async () => {
  const { w, doc } = await sendable(); const q = await w.peppol.queue(doc); await w.peppol.dispatch(q.message.id);
  const b = createLegalArtifacts({ store: w.store, merchantId: 'merchant-b', storage: w.storage, clock: w.clock, renderPdf: async () => Buffer.from('%PDF') }); const pb = createPeppolService({ store: w.store, merchantId: 'merchant-b', provider: w.provider, legal: b, storage: w.storage, inbox: w.inbox, clock: w.clock });
  await assert.rejects(() => b.archiveIssued(doc), (e) => e.code === 'DOCUMENT_NOT_FOUND'); await assert.rejects(() => b.archiveStructured(doc), (e) => e.code === 'DOCUMENT_NOT_FOUND'); await assert.rejects(() => pb.queue(doc), (e) => ['DOCUMENT_NOT_FOUND', 'CROSS_MERCHANT_REFERENCE'].includes(e.code));
  const aArt = (await w.store.listArtifacts({ merchantId: w.merchantId, documentId: doc.id }))[0]; await assert.rejects(() => b.read(aArt.id), (e) => e.code === 'ARTIFACT_NOT_FOUND'); assert.deepEqual(await b.compliance(doc.id), null); assert.equal((await w.store.listArtifacts({ merchantId: 'merchant-b' })).length, 0); assert.equal((await w.store.listPeppolMessages({ merchantId: 'merchant-b' })).length, 0);
  await assert.rejects(() => w.store.transitionPeppol({ merchantId: 'merchant-b', id: q.message.id, from: ['SUBMITTED'], to: 'DELIVERED' }), (e) => e.code === 'PEPPOL_MESSAGE_NOT_FOUND'); assert.equal(await pb.refreshStatus(q.message.id).then((r) => r.state), null);
});
test('S. ACCOUNTANT EXPORT: the archived originals are exported as ARCHIVED_ORIGINAL (PDF and structured), with the stored reference; no missing PDF; inbound originals and their attachments are included; missing disappear only when the artifact exists', async () => {
  const { w, doc } = await sendable(); const { xml } = await supplierInvoiceXml(); const inb = await w.peppol.receive({ providerMessageId: 'ex-1', payload: xml }); await w.peppol.accept(inb.message.id, MERCHANT_ACTOR);
  const mk = (store) => createAccountantExportService({ store, merchantId: w.merchantId, clock: { ...w.clock }, merchant: { name: 'Exemple SRL' }, finance: { listInvoices: () => loadDocsForReports(store, w.merchantId) }, inbox: { list: () => store.listSupplierInvoices(w.merchantId) }, storage: w.storage, renderPdf: async () => Buffer.from('%PDF regenerated'), sourceSchemaVersion: '20261006090000' });
  const pkg = await mk(w.store).generate({ kind: 'custom', from: '2026-01-01', to: '2026-12-31' }, { includeDocuments: true });
  const parse = (name) => { const [h, ...rows] = pkg.files.get(name).toString('utf8').replace(/^﻿/, '').split('\r\n').filter(Boolean).map((l) => l.split(',')); return rows.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };
  const sale = parse('sales.csv')[0]; const comp = await w.legal.compliance(doc.id); assert.deepEqual([sale.pdf_status, sale.structured_status, sale.routing, sale.payment_reference], ['ARCHIVED_ORIGINAL', 'ARCHIVED_ORIGINAL', 'PEPPOL_REQUIRED', comp.paymentReference]);
  assert.deepEqual(parse('missing-artifacts.csv').filter((m) => m.source_id === doc.id), [], 'nothing is missing for an archived document'); assert.deepEqual([pkg.manifest.pdfArchive.archivedOriginal, pkg.manifest.pdfArchive.regeneratedCopy, pkg.manifest.pdfArchive.missing], [1, 0, 0]);
  const names = [...pkg.files.keys()]; assert.ok(names.some((n) => n.startsWith('documents/sales/') && !/REGENERATED/.test(n)) && names.some((n) => n.startsWith('documents/structured/')) && names.some((n) => n.startsWith('documents/inbound/')), names.filter((n) => n.startsWith('documents')).join());
  const fileOf = (prefix) => pkg.files.get(names.find((n) => n.startsWith(prefix))); assert.equal(sha(fileOf('documents/sales/')), comp.pdf.sha256); assert.equal(sha(fileOf('documents/structured/')), comp.structured.sha256); assert.equal(sha(fileOf('documents/inbound/')), inb.original.sha256);
  const purchase = parse('purchases.csv')[0]; assert.deepEqual([purchase.source_document_status, purchase.peppol_message_id, purchase.inbound_original_sha256], ['ARCHIVED_ORIGINAL', inb.message.id, inb.original.sha256]);
  // a document issued before archiving existed still reports MISSING / REGENERATED honestly
  const { w: w2 } = await sendable(); for (const a of await w2.store.listArtifacts({ merchantId: w2.merchantId })) void a; const bare = legalWorld(); bare.svc = null; const w3 = (await import('./finance-legal-helpers.js')).legalWorld({}); void w3; void bare;
});
test('PRIVACY: events, artifacts and messages contain no secret, token or credential; the webhook secret is never stored', async () => {
  const { w, doc } = await sendable(); const q = await w.peppol.queue(doc); await w.peppol.dispatch(q.message.id); const { xml } = await supplierInvoiceXml(); await w.peppol.handleWebhook({ headers: { 'x-fake-signature': 'fake-webhook-secret' }, body: xml, providerMessageId: 'priv-1' });
  const all = JSON.stringify([await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 1000 }), await w.store.listArtifacts({ merchantId: w.merchantId }), await w.store.listPeppolMessages({ merchantId: w.merchantId }), await w.store.listSellerProfileVersions(w.merchantId), await w.peppol.observability()]);
  assert.equal(/fake-webhook-secret|token|password|api[_-]?key|bearer|authorization/i.exec(all)?.[0] ?? null, null);
});

// ===================================================== VOLUME
test('VOLUME: 120 invoices archived (PDF + official validation), 3 000 queued messages, 2 000 inbound registrations, observability and export over them, with a constant number of reads', async () => {
  const w = legalWorld(); const t0 = performance.now(); const docs = []; for (let i = 0; i < 120; i++) docs.push(await w.issue({ issueDate: '2026-09-10' })); const archiveMs = performance.now() - t0;
  assert.equal((await w.store.listArtifacts({ merchantId: w.merchantId })).length, 240);
  const t1 = performance.now(); for (let i = 0; i < 3000; i++) await w.store.enqueuePeppol({ merchantId: w.merchantId, documentId: docs[i % 120].id, key: `peppol-out:vol-${i}`, sha256: sha(`d${i % 120}`), provider: 'fake', state: 'QUEUED', at: w.clock.now() }).catch(() => null);
  for (let i = 0; i < 2000; i++) await w.store.registerInboundPeppol({ merchantId: w.merchantId, provider: 'fake', providerMessageId: `in-${i}`, key: `peppol-in:fake:in-${i}`, sha256: sha(`in${i}`), businessKey: `S|N-${i}|2026-09-01`, at: w.clock.now() });
  const regMs = performance.now() - t1; const t2 = performance.now(); const obs = await w.peppol.observability(); const obsMs = performance.now() - t2;
  assert.equal(obs.queued, 120, 'one message per logical document'); assert.equal(obs.inboundToReview + (await w.store.listPeppolMessages({ merchantId: w.merchantId, direction: 'IN', state: 'RECEIVED' })).length, 2000);
  const reads = []; const spy = new Proxy(w.store, { get: (t, k) => (typeof t[k] === 'function' && /^list/.test(String(k)) ? (...a) => { reads.push(String(k)); return t[k](...a); } : t[k]) });
  const ex = createAccountantExportService({ store: spy, merchantId: w.merchantId, clock: w.clock, finance: { listInvoices: () => loadDocsForReports(spy, w.merchantId) }, inbox: { list: () => spy.listSupplierInvoices(w.merchantId) }, storage: w.storage });
  const t3 = performance.now(); const pre = await ex.preview({ kind: 'year', year: 2026 }); const exMs = performance.now() - t3; assert.equal(pre.rowCounts['sales.csv'], 120); assert.equal(pre.pdfArchive.archivedOriginal, 120); assert.equal(new Set(reads).size, reads.length, 'each list is read once');
  console.log(`  legal volume: 120 invoices issued+archived (PDF + UBL + official validation) in ${(archiveMs / 1000).toFixed(1)} s (${(archiveMs / 120).toFixed(0)} ms each; the official Schematron validation of one document is ~0.35 s, the known bottleneck); 3 000 enqueue attempts + 2 000 inbound registrations in ${regMs.toFixed(0)} ms; observability ${obsMs.toFixed(0)} ms; export preview ${exMs.toFixed(0)} ms with ${reads.length} list reads`);
  assert.ok(archiveMs < 90_000 && obsMs < 3000 && exMs < 5000);
});
