// Peppol service: outbound state machine + inbound pipeline, behind the provider contract (peppol-provider.js). No provider is chosen here.
//
// OUTBOUND   DRAFT -> ISSUED (legal issue, elsewhere) -> VALIDATED (structured original archived, official validation OK) -> QUEUED -> SUBMITTING -> SUBMITTED -> DELIVERED
//            errors: VALIDATION_FAILED (terminal, never sent) | SUBMISSION_FAILED (retry is an explicit act) | DELIVERY_FAILED.   A provider's "accepted" is SUBMITTED, never DELIVERED.
//            ONE logical document = ONE message; the QUEUED -> SUBMITTING claim is a compare-and-set in the database, so concurrent senders produce exactly one submit.
//            An unknown outcome (timeout) is never retried blindly: the provider is asked first, by our idempotency key.
// INBOUND    provider -> exact bytes archived BEFORE any transformation -> hash -> deduplicate -> official validation -> parse (supplier invoice candidate in the inbox) -> TO_REVIEW -> a person accepts or rejects.
//            Receiving never validates anything accounting-wise.
// There is no silent fallback: a failed structured document is never sent as a PDF by e-mail and never marked compliant.

import { FinanceError } from './document.js';
import { endpointOf, MAX_ATTACHMENT_BYTES, safeFileName } from './peppol.js';
import { CURRENT_PEPPOL_VERSION, MAX_XML_BYTES, PEPPOL_RULESETS, validateStructured } from './peppol-validation.js';
import { parseXml, XmlError } from './purchase-document.js';
import { ProviderError } from './peppol-provider.js';
import { sha256, summarize } from './legal-artifacts.js';
import { DEFAULT_RETENTION } from './legal-ledger.js';

const SAFE_CODE = (c) => (/^[A-Z0-9_.:-]{1,80}$/.test(String(c ?? '')) ? String(c) : 'PROVIDER_ERROR');
const kid = (el, name) => el?.children.find((c) => c.name === name) ?? null;
const at = (el, path) => path.split('/').reduce((e, n) => kid(e, n), el);
const txt = (el) => { const t = el?.text?.trim(); return t || null; };
const walk = (el, f) => { f(el); for (const c of el.children) walk(c, f); };
export const endpointKey = (e) => (e ? `${e.scheme}:${e.id}` : null);

export function createPeppolService({ store, merchantId, provider, legal, storage, inbox = null, clock, ownEndpoints = [], leaseMs = 5 * 60_000, positiveTtlMs = 24 * 3600_000, negativeTtlMs = 15 * 60_000, peppolVersion = CURRENT_PEPPOL_VERSION, validate = validateStructured }) {
  const ev = (documentId, action, detail, actor = { type: 'system', id: 'peppol' }) => store.appendEvent({ merchantId, documentId, at: clock.now(), actor, action, detail });
  const discovery = new Map(); // endpoint -> { registered, checkedAt, source, expiresAt }: a negative result is never eternal
  const nowMs = () => Date.parse(clock.now());

  async function markSubmitted(m, providerMessageId) {
      const r = await store.transitionPeppol({ merchantId, id: m.id, from: ['SUBMITTING'], to: 'SUBMITTED', patch: { providerMessageId }, at: clock.now() });
      if (r.changed) await ev(m.documentId, 'PEPPOL_SUBMITTED', { messageId: m.id, providerMessageId, note: 'accepted by the provider, not yet delivered' });
      return { state: r.message.state, sent: r.changed, message: r.message };
  }
  const api = {
    /** Participant discovery: explicit id, then the Belgian enterprise-number scheme, always confirmed against the provider; cached with checked_at / source / expiry. */
    async discover(party) {
      const ep = endpointOf(party); if (!ep) return { endpoint: null, registered: false, reason: 'NO_ENDPOINT_FACTS' };
      const k = endpointKey(ep); const hit = discovery.get(k);
      if (hit && hit.expiresAt > nowMs()) return { endpoint: ep, registered: hit.registered, checkedAt: hit.checkedAt, source: hit.source, cached: true };
      const r = await provider.lookupParticipant(ep);
      const entry = { registered: r.registered === true, checkedAt: clock.now(), source: r.source ?? provider.name, expiresAt: nowMs() + (r.registered ? positiveTtlMs : negativeTtlMs) }; discovery.set(k, entry);
      return { endpoint: ep, registered: entry.registered, checkedAt: entry.checkedAt, source: entry.source, cached: false };
    },

    /** Queue the structured original of an issued document for sending. Never sends anything itself. If none was archived yet (a document issued before archiving existed) it is produced now from the snapshot and validated. */
    async queue(doc, { actor = null, originalNumber = null } = {}) {
      let structured = (await legal.compliance(doc.id))?.structured ?? null; let validation = structured?.provenance?.validation ?? null;
      if (!structured) { const r = await legal.archiveStructured(doc, { originalNumber, source: 'send_time', actor }); structured = r.structured; validation = r.validation; }
      if (!structured || validation?.ok !== true) {
        // the failure is recorded (state VALIDATION_FAILED, terminal) so it is visible and countable; nothing is queued, nothing is sent
        await store.enqueuePeppol({ merchantId, documentId: doc.id, key: `peppol-out:${doc.id}`, sha256: validation?.documentSha256 ?? sha256(String(doc.snapshotHash)), provider: provider.name, state: 'VALIDATION_FAILED', validation, errorCode: 'VALIDATION_FAILED', at: clock.now() }).catch(() => null);
        const err = new FinanceError('PEPPOL_NOT_READY', 'a structured original passing the official validation is required to send through Peppol'); err.errors = validation?.errors ?? (validation?.findings ?? []).filter((f) => f.severity === 'fatal').map((f) => f.ruleId); throw err;
      }
      const sender = endpointOf(doc.seller); const d = await api.discover(doc.customer);
      if (!d.endpoint || !d.registered) { await ev(doc.id, 'PEPPOL_RECEIVER_NOT_REGISTERED', { endpoint: endpointKey(d.endpoint), reason: d.reason ?? 'NOT_REGISTERED' }, actor ?? undefined); throw new FinanceError('RECEIVER_NOT_ON_PEPPOL', 'no fallback is applied: decide explicitly how this invoice is delivered'); }
      const r = await store.enqueuePeppol({ merchantId, documentId: doc.id, key: `peppol-out:${doc.id}`, sha256: structured.sha256, provider: provider.name, state: 'QUEUED', validation, sender: endpointKey(sender), receiver: endpointKey(d.endpoint), documentVersion: `${PEPPOL_RULESETS[peppolVersion].bis} ${peppolVersion}`, at: clock.now() });
      if (!r.duplicate) await ev(doc.id, 'PEPPOL_QUEUED', { messageId: r.message.id, receiver: r.message.receiverEndpoint }, actor ?? undefined);
      return r;
    },

    /** One send attempt. Safe to call any number of times, from any number of workers: exactly one claim, never a second submit. */
    async dispatch(messageId) {
      const m0 = await store.getPeppolMessage(merchantId, messageId); if (!m0) throw new FinanceError('PEPPOL_MESSAGE_NOT_FOUND', String(messageId));
      if (m0.state !== 'QUEUED') return { state: m0.state, sent: false, message: m0 };
      const claim = await store.transitionPeppol({ merchantId, id: messageId, from: ['QUEUED'], to: 'SUBMITTING', at: clock.now() });
      if (!claim.changed) return { state: claim.message.state, sent: false, message: claim.message };
      const m = claim.message; const fail = async (code, to = 'SUBMISSION_FAILED') => { const r = await store.transitionPeppol({ merchantId, id: messageId, from: ['SUBMITTING'], to, patch: { errorCode: SAFE_CODE(code) }, at: clock.now() }); await ev(m.documentId, 'PEPPOL_SUBMISSION_FAILED', { messageId, code: SAFE_CODE(code), attempts: m.attempts }); return { state: r.message.state, sent: false, message: r.message }; };
      // an earlier attempt may have been accepted before we lost the connection: ask the provider by our key BEFORE submitting again
      if (m.attempts > 1) { const f = await provider.findByIdempotencyKey(m.idempotencyKey).catch(() => ({ found: false })); if (f.found) return markSubmitted(m, f.providerMessageId); }
      const a = (await store.listArtifacts({ merchantId, documentId: m.documentId, kind: 'STRUCTURED_ORIGINAL' }))[0]; if (!a) return fail('STRUCTURED_ORIGINAL_MISSING');
      const bytes = await legal.read(a.id); if (!bytes.verified) return fail('ARTIFACT_INTEGRITY_FAILED');
      if (!m.validation || m.validation.ok !== true) return fail('VALIDATION_REQUIRED'); // an invalid document is never submitted
      let res;
      try { res = await provider.submit({ idempotencyKey: m.idempotencyKey, payload: bytes.data, sender: m.senderEndpoint, receiver: m.receiverEndpoint, documentId: m.documentId, documentType: 'invoice-or-credit-note' }); } catch (e) {
        if (e instanceof ProviderError && e.outcome === 'UNAVAILABLE') return fail(e.code);
        if (e instanceof ProviderError && e.outcome === 'REJECTED') return fail(e.code);
        await ev(m.documentId, 'PEPPOL_OUTCOME_UNKNOWN', { messageId, code: SAFE_CODE(e?.code) }); // timeout: the provider may have accepted; never retried blindly, see recover()
        return { state: 'SUBMITTING', sent: false, unknown: true, message: (await store.getPeppolMessage(merchantId, messageId)) };
      }
      if (!res || typeof res.providerMessageId !== 'string' || !res.providerMessageId) { await ev(m.documentId, 'PEPPOL_OUTCOME_UNKNOWN', { messageId, code: 'MALFORMED_PROVIDER_RESPONSE' }); return { state: 'SUBMITTING', sent: false, unknown: true, message: await store.getPeppolMessage(merchantId, messageId) }; }
      return markSubmitted(m, res.providerMessageId);
    },
    /** A message stuck in SUBMITTING (crash, timeout): ask the provider; accepted -> SUBMITTED; unknown to it and the lease expired -> back to QUEUED. */
    async recover(messageId) {
      const m = await store.getPeppolMessage(merchantId, messageId); if (!m || m.state !== 'SUBMITTING') return { state: m?.state ?? null, recovered: false };
      const f = await provider.findByIdempotencyKey(m.idempotencyKey).catch(() => null); if (f === null) return { state: m.state, recovered: false, reason: 'PROVIDER_UNREACHABLE' };
      if (f.found) { const r = await markSubmitted(m, f.providerMessageId); return { state: r.state, recovered: true }; }
      if (nowMs() - Date.parse(m.lastAttemptAt) < leaseMs) return { state: m.state, recovered: false, reason: 'LEASE_NOT_EXPIRED' };
      const r = await store.transitionPeppol({ merchantId, id: messageId, from: ['SUBMITTING'], to: 'QUEUED', at: clock.now() }); await ev(m.documentId, 'PEPPOL_REQUEUED', { messageId, reason: 'NOT_ACCEPTED_BY_PROVIDER' });
      return { state: r.message.state, recovered: r.changed };
    },
    /** The explicit retry of a failed submission (never automatic, never silent). */
    async retry(messageId) { const r = await store.transitionPeppol({ merchantId, id: messageId, from: ['SUBMISSION_FAILED'], to: 'QUEUED', at: clock.now() }); if (!r.changed) return { state: r.message.state, requeued: false }; return { ...(await api.dispatch(messageId)), requeued: true }; },
    /** A worker pass (also what runs after a restart): recover stale submissions, then send what is queued. */
    async dispatchQueued({ limit = 50 } = {}) {
      const out = { recovered: 0, dispatched: 0, results: [] };
      for (const m of (await store.listPeppolMessages({ merchantId, direction: 'OUT', state: 'SUBMITTING' })).slice(0, limit)) { const r = await api.recover(m.id); if (r.recovered) out.recovered += 1; }
      for (const m of (await store.listPeppolMessages({ merchantId, direction: 'OUT', state: 'QUEUED' })).slice(0, limit)) { const r = await api.dispatch(m.id); out.results.push({ id: m.id, state: r.state }); if (r.sent) out.dispatched += 1; }
      return out;
    },
    /** Delivery truth comes from the provider's status, not from the acceptance. */
    async refreshStatus(messageId) {
      const m = await store.getPeppolMessage(merchantId, messageId); if (!m || m.state !== 'SUBMITTED' || !m.providerMessageId) return { state: m?.state ?? null, changed: false };
      let s; try { s = await provider.status(m.providerMessageId); } catch { return { state: m.state, changed: false, reason: 'PROVIDER_UNREACHABLE' }; }
      if (!['DELIVERED', 'DELIVERY_FAILED'].includes(s.status)) return { state: m.state, changed: false };
      const r = await store.transitionPeppol({ merchantId, id: messageId, from: ['SUBMITTED'], to: s.status, patch: s.status === 'DELIVERY_FAILED' ? { errorCode: SAFE_CODE(s.detail ?? 'DELIVERY_FAILED') } : {}, at: s.at ?? clock.now() });
      if (r.changed) await ev(m.documentId, s.status === 'DELIVERED' ? 'PEPPOL_DELIVERED' : 'PEPPOL_DELIVERY_FAILED', { messageId, providerMessageId: m.providerMessageId });
      return { state: r.message.state, changed: r.changed };
    },

    // ------------------------------------------------------------------ inbound
    /** Webhook entry: the provider's authentication is verified BEFORE anything is read or stored. */
    async handleWebhook({ headers, body, providerMessageId, sender = null, receiver = null }) {
      if (!provider.verifyWebhook(headers ?? {}, body).ok) { await ev(null, 'PEPPOL_INBOUND_REJECTED', { reason: 'WEBHOOK_AUTHENTICATION_FAILED' }); throw new FinanceError('WEBHOOK_AUTHENTICATION_FAILED'); }
      return api.receive({ providerMessageId, payload: body, sender, receiver });
    },
    /** Polling entry (same pipeline as the webhook; a message seen by both is one message). */
    async poll({ since = null } = {}) { const out = []; for (const m of await provider.fetchInbound({ since })) out.push(await api.receive(m)); return out; },

    async receive({ providerMessageId, payload, sender = null, receiver = null, receivedAt = null }) {
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
      if (bytes.length === 0 || bytes.length > MAX_XML_BYTES) { await ev(null, 'PEPPOL_INBOUND_REJECTED', { reason: bytes.length ? 'PAYLOAD_TOO_LARGE' : 'PAYLOAD_EMPTY', providerMessageId: String(providerMessageId ?? '').slice(0, 80) }); throw new FinanceError(bytes.length ? 'PAYLOAD_TOO_LARGE' : 'PAYLOAD_EMPTY'); }
      const hash = sha256(bytes);
      // 1. a cheap, SAFE read for identity only (no entity can be expanded: DOCTYPE is refused); a payload that cannot be read is still archived and goes to review as failed
      let tree = null; try { tree = parseXml(bytes.toString('utf8')); } catch (e) { tree = null; void XmlError; void e; }
      const ids = tree ? { id: txt(kid(tree, 'ID')), issueDate: txt(kid(tree, 'IssueDate')), supplierEp: txt(at(tree, 'AccountingSupplierParty/Party/EndpointID')), customerEp: txt(at(tree, 'AccountingCustomerParty/Party/EndpointID')), supplierScheme: at(tree, 'AccountingSupplierParty/Party/EndpointID')?.attrs?.schemeID ?? null, customerScheme: at(tree, 'AccountingCustomerParty/Party/EndpointID')?.attrs?.schemeID ?? null } : null;
      // wrong recipient: a document addressed to somebody else is not ours to store
      const customerKey = ids?.customerEp ? `${ids.customerScheme ?? ''}:${ids.customerEp}` : null;
      if (ownEndpoints.length && customerKey && !ownEndpoints.includes(customerKey)) { await ev(null, 'PEPPOL_INBOUND_REJECTED', { reason: 'WRONG_RECIPIENT', sha256: hash }); throw new FinanceError('WRONG_RECIPIENT'); }
      const senderKey = ids?.supplierEp ? `${ids.supplierScheme ?? ''}:${ids.supplierEp}` : sender;
      const business = ids?.id && senderKey && ids.issueDate ? `${senderKey}|${ids.id}|${ids.issueDate}` : null;
      // 2. exact original into durable storage first (content-addressed: storing twice is harmless), then the message row decides whether it is new
      const ref = `${merchantId}/legal/inbound/${hash}`; try { await storage.put(ref, bytes, { contentType: 'application/xml' }); } catch (e) { await ev(null, 'ARTIFACT_STORAGE_FAILED', { kind: 'INBOUND', error: String(e.message).slice(0, 120) }); throw new FinanceError('ARTIFACT_STORAGE_FAILED', 'nothing was registered; the provider will resend'); }
      const reg = await store.registerInboundPeppol({ merchantId, provider: provider.name, providerMessageId: providerMessageId ?? `h-${hash.slice(0, 40)}`, key: `peppol-in:${provider.name}:${providerMessageId ?? hash.slice(0, 40)}`.slice(0, 200), sha256: hash, sender: senderKey, receiver: receiver ?? customerKey, businessKey: business, at: receivedAt ?? clock.now() });
      if (reg.duplicate) {
        await ev(null, 'PEPPOL_INBOUND_DUPLICATE_IGNORED', { messageId: reg.message.id, firstMessageId: reg.first?.id ?? null });
        // the same business document in DIFFERENT bytes is kept as evidence (a conflicting duplicate may be a corrected resend): archived under its own message, never turned into a second supplier invoice
        if (reg.first && reg.first.documentSha256 !== hash && reg.message.state === 'DUPLICATE') {
          await store.archiveArtifact({ merchantId, kind: 'INBOUND_ORIGINAL', classification: 'ORIGINAL', peppolMessageId: reg.message.id, storageRef: ref, sha256: hash, sizeBytes: bytes.length, mediaType: 'application/xml', fileName: 'conflicting-duplicate.xml', retentionClass: DEFAULT_RETENTION.INBOUND_ORIGINAL, provenance: { provider: provider.name, providerMessageId: providerMessageId ?? null, duplicateOf: reg.first.id, conflicting: true, receivedAt: reg.message.receivedAt }, createdAt: clock.now() }).catch(() => null);
          await ev(null, 'PEPPOL_INBOUND_CONFLICTING_DUPLICATE', { messageId: reg.message.id, firstMessageId: reg.first.id, sha256: hash });
        }
        return { duplicate: true, message: reg.message, first: reg.first ?? null };
      }
      const m = reg.message;
      const original = (await store.archiveArtifact({ merchantId, kind: 'INBOUND_ORIGINAL', classification: 'ORIGINAL', peppolMessageId: m.id, storageRef: ref, sha256: hash, sizeBytes: bytes.length, mediaType: 'application/xml', fileName: `${String(ids?.id ?? 'invoice').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)}.xml`, retentionClass: DEFAULT_RETENTION.INBOUND_ORIGINAL,
        provenance: { provider: provider.name, providerMessageId: providerMessageId ?? null, sender: senderKey, receiver: receiver ?? customerKey, receivedAt: m.receivedAt, syntax: 'UBL 2.1' }, createdAt: clock.now() })).artifact;
      await ev(null, 'PEPPOL_INBOUND_RECEIVED', { messageId: m.id, sha256: hash, sender: senderKey, artifactId: original.id });
      // 3. validation (official artifacts), recorded
      const result = validate(bytes, { version: peppolVersion, at: clock.now() }); const summary = summarize(result);
      // 4. attachments (whitelisted, bounded, archived); the invoice itself becomes a supplier-invoice CANDIDATE, never an accepted one
      const attachments = tree ? await archiveAttachments(m, tree, original) : [];
      let supplierInvoiceId = null;
      if (tree && inbox) { try { const r = await inbox.ingest({ source: 'peppol', fileName: `${String(ids.id ?? 'invoice').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)}.xml`, data: bytes, receivedAt: m.receivedAt }); supplierInvoiceId = r.item?.id ?? null; } catch (e) { await ev(null, 'PEPPOL_INBOUND_PARSE_FAILED', { messageId: m.id, code: SAFE_CODE(e?.code) }); } }
      const to = result.ok && supplierInvoiceId ? 'TO_REVIEW' : 'VALIDATION_FAILED';
      const done = await store.transitionPeppol({ merchantId, id: m.id, from: ['RECEIVED'], to, patch: { validation: summary, supplierInvoiceId, ...(to === 'VALIDATION_FAILED' ? { errorCode: result.ok ? 'PARSE_FAILED' : 'VALIDATION_FAILED' } : {}) }, at: clock.now() });
      await ev(null, result.ok ? 'PEPPOL_INBOUND_VALIDATED' : 'PEPPOL_INBOUND_VALIDATION_FAILED', { messageId: m.id, fatal: summary.fatal, bis: summary.ruleset.version });
      return { duplicate: false, message: done.message, original, attachments, validation: summary, supplierInvoiceId };
    },
    /** A person looked at a failed validation and wants to review it anyway (never automatic). */
    async moveToReview(messageId, actor) { const r = await store.transitionPeppol({ merchantId, id: messageId, from: ['VALIDATION_FAILED'], to: 'TO_REVIEW', at: clock.now() }); if (r.changed) await ev(null, 'PEPPOL_INBOUND_SENT_TO_REVIEW', { messageId }, actor); return r; },
    async accept(messageId, actor) {
      const m = await store.getPeppolMessage(merchantId, messageId); if (!m || m.direction !== 'IN') throw new FinanceError('PEPPOL_MESSAGE_NOT_FOUND', String(messageId));
      if (m.state !== 'TO_REVIEW') throw new FinanceError('INBOUND_NOT_IN_REVIEW', m.state);
      if (inbox && m.supplierInvoiceId) await inbox.validate(m.supplierInvoiceId, actor); // the person validates the supplier invoice itself (existing checks apply)
      const r = await store.transitionPeppol({ merchantId, id: messageId, from: ['TO_REVIEW'], to: 'ACCEPTED', at: clock.now() }); await ev(null, 'PEPPOL_INBOUND_ACCEPTED', { messageId, supplierInvoiceId: m.supplierInvoiceId }, actor); return r;
    },
    async reject(messageId, reason, actor) {
      if (!String(reason ?? '').trim()) throw new FinanceError('REASON_REQUIRED');
      const m = await store.getPeppolMessage(merchantId, messageId); if (!m || m.direction !== 'IN') throw new FinanceError('PEPPOL_MESSAGE_NOT_FOUND', String(messageId));
      if (m.state !== 'TO_REVIEW') throw new FinanceError('INBOUND_NOT_IN_REVIEW', m.state);
      if (inbox && m.supplierInvoiceId) await inbox.reject(m.supplierInvoiceId, reason, actor);
      const r = await store.transitionPeppol({ merchantId, id: messageId, from: ['TO_REVIEW'], to: 'REJECTED', at: clock.now() }); await ev(null, 'PEPPOL_INBOUND_REJECTED_BY_USER', { messageId, reason: String(reason).slice(0, 200) }, actor); return r;
    },

    /** Operational view, no secrets: what is waiting, what failed, when it last worked. */
    async observability() {
      const all = await store.listPeppolMessages({ merchantId }); const out = all.filter((m) => m.direction === 'OUT'); const inn = all.filter((m) => m.direction === 'IN'); const queued = out.filter((m) => m.state === 'QUEUED');
      const last = (xs, f) => xs.map(f).filter(Boolean).sort().at(-1) ?? null; const health = await provider.health().catch(() => ({ ok: false, detail: 'UNREACHABLE' }));
      return { provider: { name: provider.name, ok: health.ok, detail: health.detail ?? null }, queued: queued.length, oldestQueuedAgeSeconds: queued.length ? Math.max(0, Math.round((nowMs() - Math.min(...queued.map((m) => Date.parse(m.queuedAt)))) / 1000)) : null,
        submitting: out.filter((m) => m.state === 'SUBMITTING').length, validationFailures: out.filter((m) => m.state === 'VALIDATION_FAILED').length, submissionFailures: out.filter((m) => m.state === 'SUBMISSION_FAILED').length, deliveryFailures: out.filter((m) => m.state === 'DELIVERY_FAILED').length,
        inboundFailures: inn.filter((m) => m.state === 'VALIDATION_FAILED').length, inboundToReview: inn.filter((m) => m.state === 'TO_REVIEW').length, inboundDuplicates: inn.filter((m) => m.state === 'DUPLICATE').length,
        lastSuccessfulSend: last(out.filter((m) => ['SUBMITTED', 'DELIVERED'].includes(m.state)), (m) => m.submittedAt), lastSuccessfulReceive: last(inn.filter((m) => ['TO_REVIEW', 'ACCEPTED'].includes(m.state)), (m) => m.receivedAt) };
    },
  };

  /** Embedded binary objects (BG-24): only whitelisted media types, bounded size, plain file names; archived as ATTACHMENT artifacts under the same message. Nothing is ever executed or written to a path. */
  async function archiveAttachments(m, tree, original) {
    const allowed = PEPPOL_RULESETS[peppolVersion].attachmentMediaTypes; const out = []; const found = [];
    walk(tree, (e) => { if (e.name === 'EmbeddedDocumentBinaryObject') found.push(e); });
    for (const e of found.slice(0, 20)) {
      const mime = e.attrs.mimeCode; const name = e.attrs.filename; const reason = !allowed.includes(mime) ? 'ATTACHMENT_MEDIA_TYPE_NOT_ALLOWED' : !safeFileName(name) ? 'ATTACHMENT_FILE_NAME_INVALID' : !/^[A-Za-z0-9+/=\s]*$/.test(e.text) ? 'ATTACHMENT_NOT_BASE64' : null;
      let data = null; if (!reason) { data = Buffer.from(e.text.replace(/\s+/g, ''), 'base64'); if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) data = null; }
      if (reason || !data) { await ev(null, 'PEPPOL_INBOUND_ATTACHMENT_SKIPPED', { messageId: m.id, reason: reason ?? 'ATTACHMENT_SIZE_INVALID' }); continue; }
      const h = sha256(data); const ref = `${merchantId}/legal/inbound/${m.id}/attachments/${h}`; await storage.put(ref, data, { contentType: mime });
      out.push((await store.archiveArtifact({ merchantId, kind: 'ATTACHMENT', classification: 'ORIGINAL', peppolMessageId: m.id, parentArtifactId: original.id, storageRef: ref, sha256: h, sizeBytes: data.length, mediaType: mime, fileName: name, retentionClass: DEFAULT_RETENTION.ATTACHMENT, provenance: { messageId: m.id, parentSha256: original.sha256 }, createdAt: clock.now() })).artifact);
    }
    return out;
  }
  return api;
}
