// Enable Banking (Open Banking aggregator) as a READ-ONLY BankInformationAdapter (contract: src/finance/bank.js). Account information only: accounts, balances, transactions.
// No payment initiation exists here and assertReadOnlyAdapter refuses any adapter that exposes one.
//
// Built from the OFFICIAL pages (consulted 2026-11-17): enablebanking.com/docs/api/quick-start and /docs/api/reference.
//   base https://api.enablebanking.com ; JWT RS256 signed with the application's private key, header {typ JWT, alg RS256, kid <application id>}, claims iss "enablebanking.com",
//   aud "api.enablebanking.com", iat, exp = iat + 3600 (the API rejects a lifetime above 86400 s);
//   POST /auth {access:{valid_until}, aspsp:{name,country}, state, redirect_url, psu_type} -> {url} ; the bank redirects back with ?code ;
//   POST /sessions {code} -> {session_id, accounts:[{uid, account_id:{iban}, name, currency}], access:{valid_until}} ;
//   GET /accounts/{uid}/balances -> {balances:[{balance_amount:{amount,currency}, balance_type, reference_date}]} ;
//   GET /accounts/{uid}/transactions?date_from&date_to&transaction_status&continuation_key -> {transactions:[...], continuation_key} ;
//   DELETE /sessions/{session_id} (closes the consent at the bank when possible).
// NOT TESTED AGAINST THE REAL SERVICE: it has only run on test doubles. The first real call (the owner's consent at the bank) must re-check the response shapes.
//
// The adapter's "token" is an opaque JSON string: the session id and the authorised accounts (Enable Banking has no list-accounts call). It is stored ONLY by the encrypted consent vault.
import { createSign, randomUUID } from 'node:crypto';
import { FinanceError } from './document.js';
import { READ_ONLY_SCOPES, assertReadOnlyAdapter } from './bank.js';
import { toCents } from './money.js';

const BASE = 'https://api.enablebanking.com';
const MAX_PAGES = 20;
const b64u = (b) => Buffer.from(b).toString('base64url');
const OGM = /\+\+\+(\d{3})\/(\d{4})\/(\d{5})\+\+\+|\b(\d{12})\b/; // Belgian structured communication (OGM/VCS) when the remittance carries one

/** @param {{ applicationId?: string, privateKeyPem?: string, aspsp?: {name: string, country: string}, psuType?: 'personal'|'business', consentDays?: number, baseUrl?: string, fetchImpl?: Function, now?: () => Date }} o */
export function createEnableBankingAdapter({ applicationId = null, privateKeyPem = null, aspsp = null, psuType = 'business', consentDays = 90, baseUrl = BASE, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const configured = Boolean(applicationId && privateKeyPem && aspsp?.name && aspsp?.country);
  const calls = { auth: 0, sessions: 0, balances: 0, transactions: 0, revoked: 0 };

  const jwt = () => {
    const iat = Math.floor(now().getTime() / 1000);
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: applicationId }));
    const body = b64u(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 }));
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
    return `${head}.${body}.${b64u(sig)}`;
  };
  const need = () => { if (!configured) throw new FinanceError('BANK_NOT_CONFIGURED'); };
  async function call(method, path, { query, body } = {}) {
    need();
    const url = new URL(path, baseUrl); for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v);
    let res;
    try { res = await fetchImpl(url.toString(), { method, headers: { authorization: `Bearer ${jwt()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new FinanceError('BANK_PROVIDER_UNREACHABLE'); }
    if (res.status === 401 || res.status === 403) throw new FinanceError('BANK_CONSENT_REJECTED'); // expired / revoked consent or a refused application: the merchant must connect again
    if (res.status === 429) throw new FinanceError('BANK_PROVIDER_RATE_LIMITED');
    if (!res.ok) throw new FinanceError('BANK_PROVIDER_ERROR', String(res.status));
    return res.status === 204 ? {} : res.json();
  }
  const parse = (token) => { try { const t = JSON.parse(token); if (t?.sid && Array.isArray(t.accounts)) return t; } catch { /* below */ } throw new FinanceError('BANK_CONSENT_REJECTED'); };

  const adapter = {
    name: 'enable-banking', label: 'Enable Banking (lecture seule)', configured, scopes: [...READ_ONLY_SCOPES], calls,

    async beginConsent({ redirectUri }) {
      need(); calls.auth += 1;
      const state = randomUUID();
      const validUntil = new Date(now().getTime() + consentDays * 86_400_000).toISOString();
      const r = await call('POST', '/auth', { body: { access: { valid_until: validUntil }, aspsp: { name: aspsp.name, country: aspsp.country }, state, redirect_url: redirectUri, psu_type: psuType } });
      if (typeof r?.url !== 'string' || !r.url.startsWith('https://')) throw new FinanceError('BANK_PROVIDER_ERROR', 'no authorisation url');
      return { authorizationUrl: r.url, state };
    },

    async completeConsent({ code }) {
      need(); calls.sessions += 1;
      if (typeof code !== 'string' || !code) throw new FinanceError('BANK_CONSENT_REJECTED');
      const s = await call('POST', '/sessions', { body: { code } });
      const accounts = (s.accounts ?? []).filter((a) => a?.uid).map((a) => ({ uid: String(a.uid), iban: a.account_id?.iban ?? null, name: a.name ?? null, currency: a.currency ?? 'EUR' }));
      if (!s.session_id || !accounts.length) throw new FinanceError('BANK_PROVIDER_ERROR', 'no session or no account');
      return { token: JSON.stringify({ sid: String(s.session_id), accounts }), expiresAt: s.access?.valid_until ?? null, accountIds: accounts.map((a) => a.uid) };
    },

    async accounts(token) { return parse(token).accounts.map((a) => ({ id: a.uid, iban: a.iban, name: a.name ?? 'Compte', currency: a.currency })); },

    async balances(token, accountId) {
      parse(token); calls.balances += 1;
      const r = await call('GET', `/accounts/${encodeURIComponent(accountId)}/balances`);
      const list = Array.isArray(r.balances) ? r.balances : [];
      const b = list.find((x) => x.balance_type === 'CLBD') ?? list.find((x) => x.balance_type === 'ITBD') ?? list[0]; // booked closing balance first
      const cents = toCents(b?.balance_amount?.amount);
      if (!b || cents === null) throw new FinanceError('BANK_PROVIDER_ERROR', 'no usable balance');
      return { balanceCents: cents, currency: b.balance_amount.currency ?? 'EUR', asOf: b.last_change_date_time ?? (b.reference_date ? `${b.reference_date}T00:00:00.000Z` : now().toISOString()) };
    },

    async transactions(token, accountId, { from, to }) {
      parse(token);
      const out = []; let key = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        calls.transactions += 1;
        const r = await call('GET', `/accounts/${encodeURIComponent(accountId)}/transactions`, { query: { date_from: from, date_to: to, transaction_status: 'BOOK', continuation_key: key } });
        for (const t of r.transactions ?? []) {
          const id = t.entry_reference || t.transaction_id; const date = t.booking_date || t.value_date || t.transaction_date;
          const abs = toCents(t.transaction_amount?.amount);
          if (!id || !date || abs === null) throw new FinanceError('BANK_PROVIDER_ERROR', 'a transaction without id, date or amount'); // never guessed, never skipped silently: the whole import stops
          const debit = t.credit_debit_indicator === 'DBIT';
          const remit = Array.isArray(t.remittance_information) ? t.remittance_information.join(' ').trim() : '';
          const ogm = OGM.exec(remit);
          out.push({ id: String(id), date, valueDate: t.value_date ?? null, amountCents: debit ? -Math.abs(abs) : Math.abs(abs), currency: t.transaction_amount.currency ?? 'EUR',
            counterpartyName: (debit ? t.creditor?.name : t.debtor?.name) ?? null, reference: remit || null, structuredReference: ogm ? ogm[0] : null, bankReference: t.entry_reference ?? null });
        }
        key = r.continuation_key ?? null; if (!key) return out;
      }
      throw new FinanceError('BANK_PROVIDER_ERROR', 'too many pages'); // an unbounded history is refused rather than truncated
    },

    async revoke(token) {
      const t = parse(token); calls.revoked += 1;
      await call('DELETE', `/sessions/${encodeURIComponent(t.sid)}`);
    },
  };
  return assertReadOnlyAdapter(adapter);
}
