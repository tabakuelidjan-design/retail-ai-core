// Bank information boundary: STRICTLY READ ONLY.
//
// The Finance module may READ accounts, balances and transactions. It has NO capability to initiate, schedule, approve or change a payment,
// a transfer or a beneficiary, and this file defines no such method. `assertReadOnlyAdapter` refuses any adapter that exposes one, so a
// provider that also sells payment initiation can only be plugged in through its account-information half.
//
// Threat model (design assumption: "this application may someday be compromised"):
//   - a stolen read-only consent can expose balances, counterparties and cash flow (sensitive, mitigated by encryption at rest, expiry,
//     revocation and audit) but gives NO technical path to move money: the token's scopes are account-information only, and the app holds
//     no bank credentials, no PIN, no itsme credentials (authentication always happens at the bank / provider, with strong customer authentication);
//   - the token is server-side only, never sent to the browser, never logged, never part of a report or an export.
//
//   BankInformationAdapter contract:
//     name, label, configured: boolean, scopes: string[]                       (only READ_ONLY_SCOPES)
//     beginConsent({ redirectUri }) => { authorizationUrl, state }              (the merchant authenticates AT THE BANK)
//     completeConsent({ code, state }) => { token, expiresAt, accountIds }
//     accounts(token) => [{ id, iban, name, currency }]
//     balances(token, accountId) => { balanceCents, currency, asOf }
//     transactions(token, accountId, { from, to }) => [{ id, date, amountCents, currency, counterpartyName?, reference?, structuredReference? }]
//     revoke(token) => void                                                    (revokes the remote consent where the provider supports it)

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { FinanceError } from './document.js';

export const READ_ONLY_SCOPES = ['accounts:read', 'balances:read', 'transactions:read'];
/** Anything that could move money or change who can receive it. An adapter exposing one of these is refused. */
const FORBIDDEN = /(pay(ment)?s?$|^pay|transfer|initiat|beneficiar|payee|standing|schedul|approve|authoriz(e)?Payment|sendMoney|createOrder|moveMoney|debit|withdraw)/i;
const ALLOWED = new Set(['name', 'label', 'configured', 'scopes', 'beginConsent', 'completeConsent', 'accounts', 'balances', 'transactions', 'revoke', 'calls' /* test instrumentation (data only) */]);

export function assertReadOnlyAdapter(adapter) {
  for (const k of Object.keys(adapter)) if (FORBIDDEN.test(k) || !ALLOWED.has(k)) throw new FinanceError('BANK_ADAPTER_MUST_BE_READ_ONLY', k);
  for (const k of ['name', 'label', 'configured', 'scopes', 'accounts', 'balances', 'transactions', 'revoke']) if (!(k in adapter)) throw new FinanceError('BANK_ADAPTER_INCOMPLETE', k);
  const extra = (adapter.scopes ?? []).filter((s) => !READ_ONLY_SCOPES.includes(s));
  if (extra.length) throw new FinanceError('BANK_ADAPTER_SCOPE_NOT_READ_ONLY', extra.join(','));
  return adapter;
}

export const NoBankAdapter = {
  name: 'none', label: 'Aucune banque connectée', configured: false, scopes: [],
  async accounts() { throw new FinanceError('BANK_NOT_CONFIGURED'); }, async balances() { throw new FinanceError('BANK_NOT_CONFIGURED'); },
  async transactions() { throw new FinanceError('BANK_NOT_CONFIGURED'); }, async revoke() {},
};

// ---------- encrypted consent vault ----------
/** AES-256-GCM. The key comes from the environment (never the repository, never the database) and is 32 bytes, base64. */
export function loadVaultKey(env = process.env) {
  const raw = env.BANK_VAULT_KEY; if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new FinanceError('BANK_VAULT_KEY_MUST_BE_32_BYTES_BASE64');
  return key;
}
const seal = (key, text) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'); };
const unseal = (key, b64) => { const b = Buffer.from(b64, 'base64'); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };

/**
 * The only place a bank token is ever held. `use(fn)` hands the token to a server-side function and returns fn's result; the token itself
 * is never returned, logged or serialised. `view()` returns the safe metadata only.
 */
export function createConsentVault({ store, merchantId, key, now = () => new Date().toISOString() }) {
  const need = () => { if (!key) throw new FinanceError('BANK_VAULT_NOT_CONFIGURED'); return key; };
  const isExpired = (c) => c.expiresAt && c.expiresAt <= now();
  return {
    async save({ provider, token, expiresAt, accountIds, scopes }) {
      const bad = (scopes ?? []).filter((s) => !READ_ONLY_SCOPES.includes(s)); if (bad.length) throw new FinanceError('BANK_SCOPE_NOT_READ_ONLY', bad.join(','));
      return store.saveBankConnection({ merchantId, provider, tokenCipher: seal(need(), token), tokenFingerprint: createHash('sha256').update(token).digest('hex').slice(0, 12), scopes, accountIds, grantedAt: now(), expiresAt: expiresAt ?? null, revokedAt: null });
    },
    async view() {
      const c = await store.getBankConnection(merchantId); if (!c) return { connected: false, state: 'NOT_CONNECTED' };
      const state = c.revokedAt ? 'REVOKED' : isExpired(c) ? 'EXPIRED' : 'ACTIVE';
      return { connected: state === 'ACTIVE', state, provider: c.provider, scopes: c.scopes, accountIds: c.accountIds, grantedAt: c.grantedAt, expiresAt: c.expiresAt, revokedAt: c.revokedAt, lastUsedAt: c.lastUsedAt ?? null };
    },
    async use(fn) {
      const c = await store.getBankConnection(merchantId);
      if (!c) throw new FinanceError('BANK_NOT_CONNECTED'); if (c.revokedAt) throw new FinanceError('BANK_CONSENT_REVOKED'); if (isExpired(c)) throw new FinanceError('BANK_CONSENT_EXPIRED');
      const token = unseal(need(), c.tokenCipher);
      await store.touchBankConnection(merchantId, now());
      return fn(token, c);
    },
    async revoke(adapter) {
      const c = await store.getBankConnection(merchantId); if (!c || c.revokedAt) return { revoked: false };
      let remote = 'NOT_ATTEMPTED';
      try { await adapter.revoke(unseal(need(), c.tokenCipher)); remote = 'REVOKED'; } catch { remote = 'REMOTE_REVOCATION_FAILED'; } // local authorisation is revoked either way
      await store.revokeBankConnection(merchantId, now());
      return { revoked: true, remote };
    },
  };
}

// ---------- CSV statement import: the no-credentials route ----------
/**
 * Bank CSV exports (downloaded by the merchant) parsed into transactions. Read-only by nature: no bank access at all.
 *
 * What is supported (generic, no bank-specific format):
 *   - header on the FIRST non-empty line; columns found by name (FR / NL / EN): date (date, datum, valeur), amount (amount, montant,
 *     bedrag) - both required -, and optional reference, counterparty and id columns
 *   - delimiter ';' or ',' (whichever splits the header into more cells), or given explicitly; double-quoted cells
 *   - dates YYYY-MM-DD or DD/MM/YYYY (also DD.MM.YYYY, DD-MM-YYYY); an impossible calendar date (31/13/2026) is rejected
 *   - amounts with a decimal comma or point (12,50 / 12.50 / -1.234,56 / 1,234.56); a leading minus is a debit;
 *     at most 2 decimals - a trailing group of 3 digits is read as thousands (1.234 = 1234,00)
 *   - text must be valid UTF-8 (a U+FFFD replacement character means the file was decoded with the wrong encoding and is refused)
 * Not supported (reported, never guessed): introduction lines before the header, separate debit / credit columns, 2-digit years.
 *
 * Every data line becomes either a row or an error (line number + reason): nothing is dropped silently. `id` comes from the file's
 * id column only when its values are present and unique across the file; otherwise a content hash (date|amount|reference|counterparty).
 */
export function parseBankCsv(text, { delimiter, columns } = {}) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  if (raw.includes('\uFFFD')) throw new FinanceError('BANK_CSV_ENCODING_INVALID');
  const all = raw.split(/\r?\n/);
  const numbered = all.map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.trim());
  if (numbered.length < 2) throw new FinanceError('BANK_CSV_EMPTY');
  const headLine = numbered[0].l;
  const delim = delimiter ?? (headLine.split(';').length > headLine.split(',').length ? ';' : ',');
  const cells = (l) => { const out = []; let cur = ''; let q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === delim && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
  const headRaw = cells(headLine); const head = headRaw.map((h) => h.toLowerCase());
  const pick = (names) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const map = { date: columns?.date ?? pick(['date', 'datum', 'valeur']), amount: columns?.amount ?? pick(['amount', 'montant', 'bedrag']), ref: columns?.reference ?? pick(['communication', 'mededeling', 'reference', 'référence', 'message']), name: columns?.counterparty ?? pick(['counterparty', 'contrepartie', 'tegenpartij', 'name', 'nom', 'naam']), id: columns?.id ?? pick(['id', 'transaction', 'number', 'numéro', 'nummer']) };
  if (map.date < 0 || map.amount < 0) throw new FinanceError('BANK_CSV_COLUMNS_NOT_FOUND');
  const toIso = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) ?? /^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec(d); if (!m) return null;
    const [y, mo, da] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
    const t = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(da)));
    return t.getUTCFullYear() === Number(y) && t.getUTCMonth() === Number(mo) - 1 && t.getUTCDate() === Number(da) ? `${y}-${mo}-${da}` : null;
  };
  const toCents = (a) => {
    const src = String(a).trim(); if (!/\d/.test(src) || /[a-df-z]/i.test(src.replace(/eur|€/gi, ''))) return null; // letters (other than a currency) = not an amount
    let t = src.replace(/[^\d,.\-]/g, ''); const neg = t.startsWith('-'); t = t.replace(/-/g, '');
    const last = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'));
    if (last < 0) t = `${t}.00`; else { const dec = t.slice(last + 1); if (dec.length > 2) t = `${t.replace(/[.,]/g, '')}.00`; else t = `${t.slice(0, last).replace(/[.,]/g, '')}.${dec.padEnd(2, '0')}`; }
    const [i, d] = t.split('.'); if (!/^\d+$/.test(i || '') || !/^\d{2}$/.test(d)) return null;
    const v = Number(i) * 100 + Number(d); return Number.isSafeInteger(v) ? (neg ? -v : v) : null;
  };
  const parsed = []; const errors = [];
  for (const { l, n } of numbered.slice(1)) {
    const c = cells(l); const date = toIso(c[map.date] ?? ''); const amountCents = toCents(c[map.amount] ?? '');
    if (!date || amountCents === null) { errors.push({ line: n, code: 'ROW_INVALID', reason: !date ? 'DATE_INVALID' : 'AMOUNT_INVALID' }); continue; }
    const reference = map.ref >= 0 ? (c[map.ref] ?? '') : ''; const counterpartyName = map.name >= 0 ? (c[map.name] ?? '') : '';
    parsed.push({ line: n, fileId: map.id >= 0 ? (c[map.id] ?? '') : '', date, amountCents, currency: 'EUR', counterpartyName, reference, structuredReference: (/\+\+\+\s*(\d{3})\s*\/\s*(\d{4})\s*\/\s*(\d{5})\s*\+\+\+/.exec(reference) ?? []).slice(1).join('') || null });
  }
  // The file's own id column is only trusted when every row has a distinct value (a "Type de transaction" column would otherwise merge rows).
  const fileIds = parsed.map((r) => r.fileId);
  const idsUsable = map.id >= 0 && fileIds.every(Boolean) && new Set(fileIds).size === fileIds.length;
  const rows = parsed.map(({ line, fileId, ...r }) => ({ id: idsUsable ? fileId : createHash('sha256').update(`${r.date}|${r.amountCents}|${r.reference}|${r.counterpartyName}`).digest('hex').slice(0, 24), line, ...r }));
  const dates = rows.map((r) => r.date).sort();
  const colName = (i) => (i >= 0 ? headRaw[i] : null);
  return {
    rows, errors, delimiter: delim, dataLines: numbered.length - 1,
    columns: { date: colName(map.date), amount: colName(map.amount), reference: colName(map.ref), counterparty: colName(map.name), id: idsUsable ? colName(map.id) : null },
    period: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
  };
}

/** A synthetic in-memory bank for tests and the demo. It exposes exactly the read-only contract and nothing else. */
export function createFakeBankAdapter({ accounts = [{ id: 'acc-1', iban: 'BE68539007547034', name: 'Compte courant', currency: 'EUR' }], balances = { 'acc-1': 842000 }, transactions = [], grants = 'ok' } = {}) {
  const calls = { accounts: 0, balances: 0, transactions: 0, revoked: 0 };
  return assertReadOnlyAdapter({
    name: 'fake-bank', label: 'Banque synthétique (test)', configured: true, scopes: [...READ_ONLY_SCOPES], calls,
    async beginConsent({ redirectUri }) { return { authorizationUrl: `https://bank.example.test/authorize?redirect=${encodeURIComponent(redirectUri)}`, state: 'st-1' }; },
    async completeConsent() { return { token: 'synthetic-read-only-token-0123456789', expiresAt: '2026-12-31T00:00:00.000Z', accountIds: accounts.map((a) => a.id) }; },
    async accounts() { calls.accounts += 1; return accounts; },
    async balances(_t, id) { calls.balances += 1; return { balanceCents: balances[id] ?? 0, currency: 'EUR', asOf: '2026-09-21T08:00:00.000Z' }; },
    async transactions(_t, id, { from, to }) { calls.transactions += 1; return transactions.filter((t) => t.accountId === id && t.date >= from && t.date <= to); },
    async revoke() { calls.revoked += 1; if (grants === 'revoke-fails') throw new Error('provider down'); },
  });
}
