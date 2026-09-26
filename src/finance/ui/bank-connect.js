'use strict';
// Bank connection entry - provider-neutral, DOM-free helpers (no network, no storage, no markup). Nothing here knows any bank data provider:
// the only contract is  POST /api/bank/connect -> { authorizationUrl, state }  and  POST /api/bank/consent { code, state }.

/** sessionStorage key holding the consent state between leaving for the bank and coming back. */
const BANK_STATE_KEY = 'nordla.bank.state';

/** The bank's authorization page is only ever opened when it is a well-formed https URL (never javascript:, data:, http: or a relative path). */
function safeAuthorizationUrl(url) {
  try { const u = new URL(String(url)); return u.protocol === 'https:' && u.hostname ? u.href : null; } catch (e) { return null; }
}

/** What the connect window offers, from the real bank status: the automatic connection only exists when a provider is configured; the CSV import is always the working path. */
function bankConnectPlan(status) {
  const configured = !!(status && status.adapter && status.adapter.configured);
  return { automatic: configured, csvImport: !status || status.csvImportAvailable !== false, connected: !!(status && status.state === 'ACTIVE') };
}

/**
 * The bank sends the user back to Nordla with ?code&state (success) or ?error (refused / cancelled). Returns null when the URL is not a bank return.
 * Only fixed categories are returned - a provider's free text is never displayed.
 */
function parseBankReturn(search) {
  const p = new URLSearchParams(search || '');
  const code = p.get('code'); const state = p.get('state'); const error = p.get('error');
  if (!code && !state && !error) return null;
  if (error) return { kind: /access_denied|cancel|denied|declined/i.test(error) ? 'cancelled' : 'error' };
  if (!code || !state) return { kind: 'error' };
  return { kind: 'callback', code: code.slice(0, 500), state: state.slice(0, 200) };
}

/** The state we kept before leaving must be the state we got back; otherwise the return is refused and nothing is sent to the backend. */
function bankStateMatches(saved, got) { return typeof saved === 'string' && saved.length > 0 && saved === got; }
