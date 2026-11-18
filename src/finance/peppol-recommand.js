// Recommand provider for the Peppol provider contract (src/finance/peppol-provider.js). SEND ONLY: HABB receives through CodaBox.
// Credentials are read on the SERVER only (environment). They are never returned to the browser and never logged.
//   RECOMMAND_API_KEY, RECOMMAND_API_SECRET   HTTP Basic (key = username, secret = password)
//   RECOMMAND_COMPANY_ID                      the Recommand company that sends
//   RECOMMAND_WEBHOOK_SECRET                  HMAC-SHA256 secret of delivery-status webhooks (X-Signature: sha256=<hex>)
//   RECOMMAND_ENV                             'playground' | 'production' (the playground = another team's credentials on the same host)
//
// Documented by Recommand: POST /api/v1/{companyId}/send with raw XML (documentType 'xml', document, doctypeId, pdfGeneration.enabled);
// GET /api/core/auth/verify; webhook signature; deliveries pending | delivered | failed.
// NOT documented, so NOT assumed:
//   - an idempotency key: a retry is allowed only when THIS adapter itself recorded a definite refusal (see outcomes below);
//   - a document-status endpoint: status comes from the webhook, not from polling;
//   - the doctypeId of a CREDIT NOTE: a credit note is refused until it is confirmed (never sent with a guessed type).
// Anti-duplicate rule: after an unknown outcome (timeout, garbled answer, restart) the answer is found: null -> the service HOLDS the message.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from './peppol-provider.js';

export const RECOMMAND_HOST = 'https://app.recommand.eu';
export const RECOMMAND_API = `${RECOMMAND_HOST}/api/v1`;
export const RECOMMAND_INVOICE_DOCTYPE_ID = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1';
export const RECOMMAND_CREDIT_NOTE_DOCTYPE_ID = null; // NOT confirmed by Recommand's documentation: credit notes stay refused until it is
export const RECOMMAND_SECRET_NAMES = ['RECOMMAND_API_KEY', 'RECOMMAND_API_SECRET', 'RECOMMAND_COMPANY_ID', 'RECOMMAND_WEBHOOK_SECRET', 'RECOMMAND_ENV'];

/** Names of the server-side variables that are missing. Returns NAMES only, never values. */
export function recommandConfigStatus(env = process.env) {
  const required = ['RECOMMAND_API_KEY', 'RECOMMAND_API_SECRET', 'RECOMMAND_COMPANY_ID'];
  const missing = required.filter((n) => !env[n]);
  return { configured: missing.length === 0, missing, environment: env.RECOMMAND_ENV === 'production' ? 'production' : 'playground' };
}

/**
 * @param {{apiKey?: string, apiSecret?: string, companyId?: string, webhookSecret?: string, environment?: 'playground'|'production',
 *          fetchImpl?: Function, timeoutMs?: number}} cfg
 */
export function createRecommandProvider(cfg = {}) {
  const { apiKey, apiSecret, companyId, webhookSecret, environment = 'playground', fetchImpl = fetch, timeoutMs = 30000 } = cfg;
  const configured = !!(apiKey && apiSecret && companyId);
  const auth = configured ? `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}` : null;
  // Outcomes recorded BY THIS PROCESS only: a restart forgets them, and then an unknown attempt is held (safe).
  const outcomes = new Map(); // idempotencyKey -> { state: 'ACCEPTED'|'REFUSED'|'UNKNOWN', providerMessageId? }
  const notConfigured = () => { throw new ProviderError('UNAVAILABLE', 'A_CONFIGURER'); };

  async function call(url, method, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try { res = await fetchImpl(url, { method, headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal }); }
    catch (e) { throw new ProviderError('UNKNOWN', e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'); }
    finally { clearTimeout(t); }
    const json = await res.json().catch(() => null);
    if (res.status === 401) throw new ProviderError('UNAVAILABLE', 'CREDENTIALS_REJECTED'); // nothing was accepted
    if (res.status >= 500) throw new ProviderError('UNKNOWN', `HTTP_${res.status}`);        // may have been accepted
    if (!res.ok || json?.success === false) throw new ProviderError('REJECTED', 'RECOMMAND_REFUSED', json?.errors ?? null); // definite refusal
    return json;
  }

  return {
    name: 'recommand',
    environment,
    configured,
    async health() {
      if (!configured) return { ok: false, detail: 'A_CONFIGURER' };
      try { await call(`${RECOMMAND_HOST}/api/core/auth/verify`, 'GET'); return { ok: true, detail: environment }; }
      catch (e) { return { ok: false, detail: e.code ?? 'ERROR' }; }
    },
    // Send-only: Nordla does not look up the recipient's SMP itself; Recommand decides delivery on send.
    async lookupParticipant() { notConfigured(); },
    /** Sends the exact UBL XML Nordla generated and validated (the service never calls this without a validated structured original). */
    async submit({ idempotencyKey, payload, receiver }) {
      if (!configured) notConfigured();
      const xml = Buffer.from(payload).toString('utf8');
      const isCredit = /<(?:[A-Za-z0-9]+:)?CreditNote[\s>]/.test(xml.slice(0, 2000));
      const doctypeId = isCredit ? RECOMMAND_CREDIT_NOTE_DOCTYPE_ID : RECOMMAND_INVOICE_DOCTYPE_ID;
      if (!doctypeId) { outcomes.set(idempotencyKey, { state: 'REFUSED' }); throw new ProviderError('REJECTED', 'CREDIT_NOTE_DOCTYPE_NOT_CONFIRMED'); }
      const body = { recipient: receiver ? `${receiver.scheme}:${receiver.id}` : null, documentType: 'xml', document: xml, doctypeId, pdfGeneration: { enabled: false } };
      let json;
      try { json = await call(`${RECOMMAND_API}/${encodeURIComponent(companyId)}/send`, 'POST', body); }
      catch (e) {
        outcomes.set(idempotencyKey, { state: e.outcome === 'UNKNOWN' ? 'UNKNOWN' : 'REFUSED' });
        throw e;
      }
      const id = json?.deliveries?.[0]?.id ?? json?.id ?? null;
      if (!id) { outcomes.set(idempotencyKey, { state: 'UNKNOWN' }); throw new ProviderError('UNKNOWN', 'NO_ID_IN_RESPONSE'); }
      outcomes.set(idempotencyKey, { state: 'ACCEPTED', providerMessageId: String(id) });
      return { providerMessageId: String(id), deliveryStatus: json.deliveryStatus ?? null };
    },
    /** Anti-duplicate answer: true = accepted (we recorded it), false = a definite refusal (safe to resend), null = unknown (HOLD). */
    async findByIdempotencyKey(key) {
      const o = outcomes.get(key);
      if (!o) return { found: null };
      if (o.state === 'ACCEPTED') return { found: true, providerMessageId: o.providerMessageId };
      if (o.state === 'REFUSED') return { found: false };
      return { found: null };
    },
    async status() { throw new ProviderError('UNKNOWN', 'STATUS_ENDPOINT_NOT_CONFIRMED'); }, // delivery status arrives by webhook
    async fetchInbound() { return []; }, // reception stays with CodaBox
    /** X-Signature: sha256=<hex>, HMAC-SHA256 over the RAW request body. */
    verifyWebhook(headers, rawBody) {
      if (!webhookSecret) return { ok: false, reason: 'A_CONFIGURER' };
      const got = String(headers?.['x-signature'] ?? '');
      const want = `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
      const a = Buffer.from(got); const b = Buffer.from(want);
      return { ok: a.length === b.length && timingSafeEqual(a, b) };
    },
    _outcomesForTest: outcomes,
  };
}
