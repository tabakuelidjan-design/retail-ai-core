// ProviderProvisioningService: the OAuth lifecycle of a merchant's provider account, end to end - and nothing else.
//
//   startConnection -> (merchant consents AT THE PROVIDER) -> handleCallback -> listAuthorizedTargets -> bindSelectedTarget (EXPLICIT choice)
//   -> verifyConnection -> refreshConnection -> disconnectConnection
//
// It never publishes, edits or deletes anything at a provider; never auto-picks an account or a location (the merchant chooses, even
// when there is only one); never stores a token, an authorization code, a PKCE verifier or a raw state in plaintext; and takes the merchant
// ONLY from the server-side tenant, never from a callback parameter. A raw provider response is parsed, allow-listed and discarded.

import {
  CONNECTION_STATE as C, OAUTH_ERROR, OAUTH_SESSION_STATUS as S, PC_ERROR as E, PENDING_BINDING_TTL_MS, ProvisioningError, PROVIDERS,
} from './constants.js';
import { buildChannelConnectionView, normalizeChannelConnector } from '../activation/connection-view.js';
import { parseBundle, serializeBundle } from './credential-store.js';
import { buildOAuthSession } from './oauth-session.js';
import {
  deepFreeze, fail, merchantOf, providerOf, sha256Hex, sortedUnique, uuid,
} from './validation.js';

const oauthError = (code, message = 'the OAuth flow failed', extra = {}) => new ProvisioningError(E.OAUTH, message, { oauth: code, ...extra });

/**
 * @param {object} deps { sessions, sessionSecrets, credentialStore, tokenManager, oauthAdapters, appConfigFor, connectorRepository,
 *                        clock?, rng?, logger?, returnToAllowlist? }
 */
export function createProviderProvisioningService({
  sessions, sessionSecrets, credentialStore, tokenManager, oauthAdapters, appConfigFor, connectorRepository, clock = Date.now, rng, logger = () => {}, returnToAllowlist,
}) {
  const adapterOf = (provider) => oauthAdapters[providerOf(provider)] ?? fail(E.PROVIDER_UNSUPPORTED, 'this provider has no OAuth adapter');
  const nowIso = () => new Date(clock()).toISOString();
  const log = (event, extra) => logger({ event, ...extra }); // ids and safe codes only

  /** Temporary OAuth secrets (PKCE verifier, tokens waiting for the target choice). Idempotent; never touches a credential bound to a connector. */
  async function dropSessionSecrets(session) {
    for (const kind of ['PKCE_VERIFIER', 'PENDING_TOKENS']) await sessionSecrets.delete({ merchantId: session.merchant_id, sessionId: session.id, kind });
  }

  async function failSession(session, code) {
    await sessions.markFailed({ merchantId: session.merchant_id, id: session.id, code, nowIso: nowIso() });
    await dropSessionSecrets(session);
    log('oauth.session_failed', { session_id: session.id, merchant_id: session.merchant_id, provider: session.provider, safe_code: code });
  }

  // ---------------------------------------------------------------- start
  async function startConnection({ tenant, provider, returnTo = null, actorRef = null }) {
    const merchantId = merchantOf(tenant);
    const adapter = adapterOf(provider);
    const appConfig = appConfigFor(provider); // APP_MISCONFIGURED names the missing variables, never a value
    const { session, state, pkceVerifier } = buildOAuthSession({
      merchantId, provider, redirectUri: appConfig.redirectUri, descriptor: adapter.descriptor, returnTo, returnToAllowlist, actorRef, nowMs: clock(), rng,
    });
    const row = await sessions.create(session);
    if (pkceVerifier) await sessionSecrets.put({ merchantId, sessionId: row.id, kind: 'PKCE_VERIFIER', secret: pkceVerifier, ttlMs: new Date(row.expires_at).getTime() - clock() });
    let authorizationUrl;
    try {
      authorizationUrl = adapter.buildAuthorizationRequest({ appConfig, state: state.reveal(), pkceChallenge: row.pkce_challenge, redirectUri: row.redirect_uri });
    } catch (error) {
      await failSession(row, OAUTH_ERROR.APP_MISCONFIGURED);
      throw oauthError(adapter.normalizeOAuthError(error).code, 'the provider app settings are not valid for this provider', { provider });
    }
    log('oauth.session_started', { session_id: row.id, merchant_id: merchantId, provider });
    return deepFreeze({ authorization_url: authorizationUrl, session_ref: row.id, expires_at: row.expires_at });
  }

  // ---------------------------------------------------------------- callback
  /** `query` is what the provider sent to the redirect URI: { code, state, error, error_description }. The merchant is the server-side tenant. */
  async function handleCallback({ tenant, provider, query = {} }) {
    const merchantId = merchantOf(tenant);
    providerOf(provider);
    const adapter = adapterOf(provider);
    if (typeof query.state !== 'string' || !query.state) throw oauthError(OAUTH_ERROR.INVALID_STATE, 'the callback carries no state');
    const found = await sessions.findByStateHash({ merchantId, stateHash: sha256Hex(query.state) });
    if (!found || found.provider !== provider || found.merchant_id !== merchantId) throw oauthError(OAUTH_ERROR.INVALID_STATE, 'the callback does not match a pending authorization'); // unknown, other merchant or other provider
    if (sessions.isExpired(found, clock())) {
      if (await sessions.markExpired({ merchantId, id: found.id, nowIso: nowIso() })) await dropSessionSecrets(found);
      throw oauthError(OAUTH_ERROR.SESSION_EXPIRED, 'the authorization request has expired');
    }
    if (typeof query.error === 'string' && query.error) { // the merchant refused (or the provider refused): the state is consumed either way
      await failSession(found, OAUTH_ERROR.USER_DENIED);
      throw oauthError(OAUTH_ERROR.USER_DENIED, 'the merchant did not grant the access');
    }
    const session = await sessions.authorize({ merchantId, id: found.id, nowIso: nowIso() }); // single use: a replay gets null
    if (!session) throw oauthError(OAUTH_ERROR.INVALID_STATE, 'this authorization was already used');
    if (typeof query.code !== 'string' || !query.code) { await failSession(session, OAUTH_ERROR.CODE_EXCHANGE_FAILED); throw oauthError(OAUTH_ERROR.CODE_EXCHANGE_FAILED, 'the callback carries no code'); }

    const appConfig = appConfigFor(provider);
    const pkceVerifier = adapter.descriptor.uses_pkce ? await sessionSecrets.take({ merchantId, sessionId: session.id, kind: 'PKCE_VERIFIER' }) : null;
    if (adapter.descriptor.uses_pkce && !pkceVerifier) { await failSession(session, OAUTH_ERROR.INVALID_STATE); throw oauthError(OAUTH_ERROR.INVALID_STATE, 'the PKCE verifier is gone'); }
    let tokens;
    try {
      tokens = await adapter.exchangeCode({ appConfig, code: query.code, redirectUri: session.redirect_uri, pkceVerifier }); // server side; the browser never sees a token
    } catch (error) {
      const normalized = adapter.normalizeOAuthError(error);
      await failSession(session, normalized.code);
      throw oauthError(normalized.code, 'the provider did not accept the authorization code', { provider, safe_provider_code: normalized.safe_provider_code });
    }
    const missing = adapter.descriptor.minimum_scopes.filter((scope) => !tokens.scopes.includes(scope));
    if (missing.length) { await failSession(session, OAUTH_ERROR.SCOPE_MISSING); throw oauthError(OAUTH_ERROR.SCOPE_MISSING, 'the merchant did not grant a required permission', { missing }); }
    await sessionSecrets.put({ merchantId, sessionId: session.id, kind: 'PENDING_TOKENS', secret: serializeBundle(tokens), ttlMs: PENDING_BINDING_TTL_MS });
    log('oauth.callback_consumed', { session_id: session.id, merchant_id: merchantId, provider });
    return deepFreeze({ status: S.AUTHORIZED, session_ref: session.id, provider, return_to: session.return_to, granted_scopes: [...tokens.scopes], next: 'SELECT_TARGET' });
  }

  async function authorizedSession(merchantId, sessionRef) {
    const session = await sessions.getById({ merchantId, id: uuid(sessionRef, 'session_ref') });
    if (!session) throw new ProvisioningError(E.SESSION_NOT_FOUND, 'unknown authorization session');
    if (session.status !== S.AUTHORIZED) throw new ProvisioningError(E.SESSION_STATE_CONFLICT, `the session is ${session.status}`);
    const secret = await sessionSecrets.peek({ merchantId, sessionId: session.id, kind: 'PENDING_TOKENS' });
    if (!secret) { if (await sessions.markExpired({ merchantId, id: session.id, nowIso: nowIso() })) await dropSessionSecrets(session); throw oauthError(OAUTH_ERROR.SESSION_EXPIRED, 'the target selection window has expired'); }
    return { session, tokens: parseBundle(secret.reveal()) };
  }

  // ---------------------------------------------------------------- targets
  async function listAuthorizedTargets({ tenant, sessionRef }) {
    const merchantId = merchantOf(tenant);
    const { session, tokens } = await authorizedSession(merchantId, sessionRef);
    const adapter = adapterOf(session.provider);
    try {
      return deepFreeze(await adapter.discoverTargets({ tokens, appConfig: appConfigFor(session.provider) }));
    } catch (error) {
      const normalized = adapter.normalizeOAuthError(error);
      throw oauthError(normalized.code, 'the provider accounts could not be listed', { provider: session.provider });
    }
  }

  const accountState = (candidate) => candidate.account_type ?? null;
  const configOf = (candidate, extra = {}) => ({
    granted_scopes: [...candidate.granted_scopes], account_state: accountState(candidate), display_name: candidate.display_name, provisioned_via: 'oauth', ...extra,
    ...(candidate.location_name ? { location_name: candidate.location_name } : {}),
  });

  async function connectorOf(merchantId, connectorId) {
    const all = await connectorRepository.listForMerchant(merchantId);
    const connector = all.find((c) => c.id === uuid(connectorId, 'connector_id') && PROVIDERS.includes(c.kind));
    if (!connector) throw new ProvisioningError(E.CONNECTOR_NOT_FOUND, 'unknown connector for this merchant');
    return connector;
  }

  const decorate = (view, connectionState, extraSignals = []) => deepFreeze({
    ...view, connection_state: connectionState, review_signals: sortedUnique([...view.review_signals, ...extraSignals, ...(connectionState === C.REAUTH_REQUIRED ? ['REAUTH_REQUIRED'] : [])]),
  });

  // ---------------------------------------------------------------- verify
  /**
   * Live check of a bound connection. CONFIGURED only when the credential is valid, the required scopes are granted and the bound
   * account / location is still the authorized one. Persisted: CONFIGURED / MISCONFIGURED. Runtime only (never written): UNAVAILABLE, REAUTH_REQUIRED.
   */
  async function verifyConnection({ tenant, connectorId, persist = true }) {
    const merchantId = merchantOf(tenant);
    const stored = await connectorOf(merchantId, connectorId);
    const provider = stored.kind;
    const adapter = adapterOf(provider);
    const result = (state, reasons, extra = {}, signals = []) => ({ state, reasons: sortedUnique(reasons), extra, signals });
    let outcome;
    try {
      const { tokens } = await tokenManager.getValidCredential({ merchantId, connectorId: stored.id, provider });
      const candidate = await adapter.verifyTarget({ tokens, appConfig: appConfigFor(provider), externalId: stored.externalId });
      outcome = candidate.eligibility.eligible
        ? result(C.CONFIGURED, [], { candidate }, candidate.review_signals)
        : result(C.MISCONFIGURED, candidate.eligibility.reasons, { candidate }, candidate.review_signals);
    } catch (error) {
      if (error instanceof ProvisioningError) {
        if (error.code === E.REAUTH_REQUIRED) outcome = result(C.REAUTH_REQUIRED, ['REAUTH_REQUIRED']);
        else if (error.code === E.CREDENTIAL_NOT_FOUND || error.code === E.CREDENTIAL_REVOKED) outcome = result(C.MISCONFIGURED, ['CREDENTIAL_MISSING']);
        else outcome = result(C.UNAVAILABLE, [error.code]); // vault / refresh / provider outage: temporary
      } else {
        const normalized = adapter.normalizeOAuthError(error);
        if (normalized.reauth) { await credentialStore.markExpired({ merchantId, connectorId: stored.id }); outcome = result(C.REAUTH_REQUIRED, ['REAUTH_REQUIRED']); }
        else if (normalized.code === OAUTH_ERROR.PROVIDER_UNAVAILABLE) outcome = result(C.UNAVAILABLE, [normalized.code]);
        else outcome = result(C.MISCONFIGURED, [normalized.code, normalized.safe_provider_code ?? 'NOT_AUTHORIZED'].filter(Boolean));
      }
    }
    const persistable = outcome.state === C.CONFIGURED || outcome.state === C.MISCONFIGURED;
    let connector = stored;
    if (persist && persistable) {
      const config = outcome.extra.candidate ? { ...stored.config, ...configOf(outcome.extra.candidate), last_verified_at: nowIso() } : { ...stored.config, last_verified_at: nowIso() };
      connector = await connectorRepository.update({ merchantId, connectorId: stored.id, status: outcome.state, config });
    }
    const normalizedConnector = normalizeChannelConnector(connector, { merchantId });
    const candidate = outcome.extra.candidate;
    const view = buildChannelConnectionView({
      connector: normalizedConnector,
      runtime: { account_state: candidate ? accountState(candidate) : undefined, granted_scopes: candidate?.granted_scopes, external_display_name: candidate?.display_name ?? null, last_verified_at: nowIso(), status: persistable ? outcome.state : (outcome.state === C.UNAVAILABLE ? C.UNAVAILABLE : undefined) },
    });
    log('connection.verified', { merchant_id: merchantId, connector_id: stored.id, provider, state: outcome.state });
    return deepFreeze({
      state: outcome.state, persist_status: persist && persistable ? outcome.state : null, reason_codes: outcome.reasons, review_signals: sortedUnique(outcome.signals),
      view: decorate(view, outcome.state, outcome.signals),
    });
  }

  // ---------------------------------------------------------------- bind
  /** The merchant's EXPLICIT choice. Even a single discovered account must be chosen: nothing is ever picked by default. */
  async function bindSelectedTarget({ tenant, sessionRef, externalId, actorRef = null }) {
    const merchantId = merchantOf(tenant);
    if (typeof externalId !== 'string' || !externalId.trim()) throw new ProvisioningError(E.TARGET_REQUIRED, 'the merchant must choose the account (or location) to connect');
    const { session, tokens } = await authorizedSession(merchantId, sessionRef);
    const provider = session.provider;
    const adapter = adapterOf(provider);
    const appConfig = appConfigFor(provider);
    let discovered;
    try { discovered = await adapter.discoverTargets({ tokens, appConfig }); } catch (error) {
      throw oauthError(adapter.normalizeOAuthError(error).code, 'the provider accounts could not be listed', { provider });
    }
    const chosen = discovered.find((candidate) => candidate.external_id === externalId);
    if (!chosen) throw new ProvisioningError(E.TARGET_NOT_FOUND, 'this account is not among the accounts the merchant authorized');
    if (!chosen.eligibility.eligible) throw new ProvisioningError(E.TARGET_INELIGIBLE, 'this account cannot be used for publishing', { reasons: chosen.eligibility.reasons });
    try { await adapter.verifyTarget({ tokens, appConfig, externalId }); } catch (error) { // re-verified against the provider right before binding
      throw oauthError(adapter.normalizeOAuthError(error).code, 'the account could not be re-verified', { provider });
    }

    const { connector } = await connectorRepository.link({ merchantId, kind: provider, externalId, status: C.NOT_CONFIGURED, config: configOf(chosen) });
    const existing = await credentialStore.readMetadata({ merchantId, connectorId: connector.id });
    if (!existing || existing.status === 'REVOKED') {
      await credentialStore.storeMerchantCredential({ merchantId, connectorId: connector.id, provider, tokens });
    } else {
      const rotated = await credentialStore.updateMerchantCredential({ merchantId, connectorId: connector.id, tokens, expectedVersion: existing.rotation_version });
      if (!rotated) throw new ProvisioningError(E.CREDENTIAL_VERSION_CONFLICT, 'the credential changed while connecting: try again');
    }
    const verification = await verifyConnection({ tenant, connectorId: connector.id });
    if (verification.state === C.CONFIGURED) {
      await sessions.markBound({ merchantId, id: session.id, connectorId: connector.id, nowIso: nowIso() });
      await sessionSecrets.delete({ merchantId, sessionId: session.id, kind: 'PENDING_TOKENS' });
    }
    log('connection.bound', { merchant_id: merchantId, connector_id: connector.id, provider, state: verification.state, session_id: session.id, actor_ref: actorRef });
    return deepFreeze({ connector_id: connector.id, session_ref: session.id, verification });
  }

  // ---------------------------------------------------------------- temporary secret lifecycle
  /**
   * Expires the merchant's dead OAuth sessions and deletes their temporary Vault secrets: a PENDING session past its expiry (never
   * consented / abandoned), an AUTHORIZED one whose target-selection window has passed, and FAILED / EXPIRED ones that may still hold a secret.
   * Merchant scoped (the tenant; a sessionRef of another merchant is refused). Idempotent. A BOUND session and every credential bound
   * to a connector are never touched: only session secrets are deleted, and only after the session is provably dead.
   */
  async function cleanupExpiredOAuthSessions({ tenant, sessionRef = null }) {
    const merchantId = merchantOf(tenant);
    let rows;
    if (sessionRef) {
      const one = await sessions.getById({ merchantId, id: uuid(sessionRef, 'session_ref') });
      if (!one) throw new ProvisioningError(E.SESSION_NOT_FOUND, 'unknown authorization session');
      rows = [one];
    } else rows = await sessions.listOpen({ merchantId });
    const now = clock();
    const result = { sessions_expired: 0, sessions_cleaned: 0 };
    for (const session of rows) {
      if (session.merchant_id !== merchantId || session.status === S.BOUND) continue;
      const dead = session.status === S.FAILED || session.status === S.EXPIRED
        || (session.status === S.PENDING && sessions.isExpired(session, now))
        || (session.status === S.AUTHORIZED && Date.parse(session.authorized_at) + PENDING_BINDING_TTL_MS <= now);
      if (!dead) continue;
      if (session.status === S.PENDING || session.status === S.AUTHORIZED) {
        if (!(await sessions.markExpired({ merchantId, id: session.id, nowIso: nowIso() }))) continue; // it changed meanwhile (callback / bind): leave its secrets alone
        result.sessions_expired += 1;
      }
      await dropSessionSecrets(session);
      result.sessions_cleaned += 1;
    }
    log('oauth.sessions_cleaned', { merchant_id: merchantId, ...result });
    return deepFreeze(result);
  }

  // ---------------------------------------------------------------- refresh / disconnect
  async function refreshConnection({ tenant, connectorId }) {
    const merchantId = merchantOf(tenant);
    const connector = await connectorOf(merchantId, connectorId);
    const { metadata, refreshed } = await tokenManager.forceRefresh({ merchantId, connectorId: connector.id, provider: connector.kind });
    return deepFreeze({ connector_id: connector.id, refreshed, expires_at: metadata.expires_at, rotation_version: metadata.rotation_version });
  }

  /** Revokes the credential locally (always) and at the provider (when an official endpoint exists). Publication history is untouched. */
  async function disconnectConnection({ tenant, connectorId }) {
    const merchantId = merchantOf(tenant);
    const connector = await connectorOf(merchantId, connectorId);
    const revoked = await tokenManager.revoke({ merchantId, connectorId: connector.id, provider: connector.kind });
    const updated = await connectorRepository.update({ merchantId, connectorId: connector.id, status: C.NOT_CONFIGURED });
    log('connection.disconnected', { merchant_id: merchantId, connector_id: connector.id, provider: connector.kind, remote: revoked.remote });
    return deepFreeze({ connector_id: connector.id, status: updated.status, remote_revoked: revoked.remote, local_revoked: revoked.local, remote_note: revoked.reason ?? null });
  }

  return {
    startConnection, handleCallback, listAuthorizedTargets, bindSelectedTarget, verifyConnection, refreshConnection, disconnectConnection, connectorOf, cleanupExpiredOAuthSessions,
  };
}
