// The Peppol provider boundary. Finance depends on THIS contract only, never on a concrete provider; credentials live in the adapter, never in business logic.
//   Nordla Finance -> Nordla Peppol Adapter (this contract) -> Provider
//
// PeppolProvider {
//   name: string
//   health():                                   Promise<{ ok: boolean, detail?: string }>
//   lookupParticipant({ scheme, id }):          Promise<{ registered: boolean, source: string }>          (may throw ProviderError)
//   submit({ idempotencyKey, payload, sender, receiver, documentId, documentType }): Promise<{ providerMessageId: string }>   acceptance by the provider, NOT delivery
//   findByIdempotencyKey(key):                  Promise<{ found: boolean, providerMessageId?: string }>   (asks the provider whether it already accepted this intent)
//   status(providerMessageId):                  Promise<{ status: 'SUBMITTED' | 'DELIVERED' | 'DELIVERY_FAILED', at: string, detail?: string }>
//   fetchInbound({ since }):                    Promise<Array<{ providerMessageId: string, payload: Buffer, sender?: string, receiver?: string, receivedAt: string }>>
//   verifyWebhook(headers, body):               { ok: boolean }                                              (authentication of an inbound webhook call)
// }
// ProviderError.outcome: 'UNAVAILABLE' (nothing was accepted: safe to retry), 'REJECTED' (the provider refused: code in .code), 'UNKNOWN' (timeout or garbled answer: the provider MAY have accepted).

export class ProviderError extends Error {
  constructor(outcome, code = 'PROVIDER_ERROR', detail = null) { super(`${outcome}:${code}`); this.outcome = outcome; this.code = code; this.detail = detail; }
}

/** Adapts the earlier Access Point contract { submit({payloadXml, sender, receiver, documentNumber}) -> {providerMessageId}, fetchStatus(id) } to the provider contract. It cannot look an intent up by key, so a retry after an unknown outcome is never assumed safe by it. */
export function legacyAdapterAsProvider(ap) {
  return {
    name: ap.name,
    async health() { return { ok: true, detail: 'legacy-adapter' }; },
    async lookupParticipant() { return { registered: true, source: 'legacy-adapter-assumed' }; },
    async submit({ payload, sender, receiver, documentId }) { const r = await ap.submit({ payloadXml: Buffer.from(payload).toString('utf8'), sender: sender ? { scheme: sender.split(':')[0], id: sender.split(':').slice(1).join(':') } : null, receiver: receiver ? { scheme: receiver.split(':')[0], id: receiver.split(':').slice(1).join(':') } : null, documentNumber: documentId }); return { providerMessageId: r?.providerMessageId }; },
    async findByIdempotencyKey() { return { found: false }; },
    async status(id) { const s = await ap.fetchStatus(id); return { status: s.status === 'DELIVERED' ? 'DELIVERED' : ['REJECTED', 'FAILED'].includes(s.status) ? 'DELIVERY_FAILED' : 'SUBMITTED', at: s.at, detail: s.detail }; },
    async fetchInbound() { return []; },
    verifyWebhook() { return { ok: false }; },
  };
}

/** Used when no real provider is configured: nothing is ever transmitted and nothing pretends to be. */
export const NoPeppolProvider = {
  name: 'none',
  async health() { return { ok: false, detail: 'NO_PROVIDER_CONFIGURED' }; },
  async lookupParticipant() { throw new ProviderError('UNAVAILABLE', 'NO_PROVIDER_CONFIGURED'); },
  async submit() { throw new ProviderError('UNAVAILABLE', 'NO_PROVIDER_CONFIGURED'); },
  async findByIdempotencyKey() { return { found: false }; },
  async status() { throw new ProviderError('UNAVAILABLE', 'NO_PROVIDER_CONFIGURED'); },
  async fetchInbound() { return []; },
  verifyWebhook() { return { ok: false }; },
};

/**
 * Deterministic fake provider for tests and local demos. No network. Failure injection:
 *   fake.inject('submit', 'unavailable' | 'rejected' | 'timeout_before_accept' | 'timeout_after_accept' | 'malformed')   (consumed by the next submit)
 */
export function createFakePeppolProvider({ registered = () => true, webhookSecret = 'fake-webhook-secret', now = () => new Date().toISOString() } = {}) {
  const accepted = new Map(); const byKey = new Map(); const statuses = new Map(); const inbound = []; const injected = []; let n = 0; const calls = { submit: 0, lookup: 0 };
  return {
    name: 'fake',
    calls, accepted,
    inject(op, mode) { injected.push({ op, mode }); },
    deliver(providerMessageId, status = 'DELIVERED', detail = null) { statuses.set(providerMessageId, { status, at: now(), detail }); },
    pushInbound(msg) { inbound.push({ receivedAt: now(), sender: null, receiver: null, ...msg }); },
    async health() { return { ok: true, detail: 'fake' }; },
    async lookupParticipant({ scheme, id }) { calls.lookup += 1; return { registered: !!registered({ scheme, id }), source: 'fake-directory' }; },
    async submit({ idempotencyKey, payload, sender, receiver, documentId, documentType }) {
      calls.submit += 1; const inj = injected.findIndex((x) => x.op === 'submit'); const mode = inj >= 0 ? injected.splice(inj, 1)[0].mode : null;
      if (mode === 'unavailable') throw new ProviderError('UNAVAILABLE', 'PROVIDER_UNAVAILABLE');
      if (mode === 'rejected') throw new ProviderError('REJECTED', 'RECEIVER_UNKNOWN');
      if (mode === 'timeout_before_accept') throw new ProviderError('UNKNOWN', 'TIMEOUT');
      // provider-side idempotency: the same key is the same intent
      if (!byKey.has(idempotencyKey)) { n += 1; const id = `fake-msg-${n}`; byKey.set(idempotencyKey, id); accepted.set(id, { idempotencyKey, payload: Buffer.from(payload), sender, receiver, documentId, documentType, at: now() }); statuses.set(id, { status: 'SUBMITTED', at: now() }); }
      const providerMessageId = byKey.get(idempotencyKey);
      if (mode === 'timeout_after_accept') throw new ProviderError('UNKNOWN', 'TIMEOUT');
      if (mode === 'malformed') return { unexpected: true };
      return { providerMessageId };
    },
    async findByIdempotencyKey(key) { return byKey.has(key) ? { found: true, providerMessageId: byKey.get(key) } : { found: false }; },
    async status(providerMessageId) { const s = statuses.get(providerMessageId); if (!s) throw new ProviderError('REJECTED', 'UNKNOWN_MESSAGE'); return s; },
    async fetchInbound() { return inbound.splice(0); },
    verifyWebhook(headers) { return { ok: headers?.['x-fake-signature'] === webhookSecret }; },
  };
}
