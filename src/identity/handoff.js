// Single sign-on from the Nordla server to Nordla Growth (its own domain): a SIGNED, SHORT-LIVED, SINGLE-USE ticket, then a Growth session
// opened by the SAME database function as a password sign-in (identity_open_session).
//  - issued by the Nordla server ONLY for a person who holds a valid Nordla session at that moment (the caller checks it BEFORE issuing);
//  - carries the merchant, the person (user id), an expiry and a random id: no role, no e-mail, no secret. The ROLE is never taken from the ticket;
//  - signed with HMAC-SHA256 under a key derived from a server-side secret (GROWTH_SSO_SECRET) that both servers hold in their own environment;
//  - Growth verifies signature, audience, shape, lifetime (60 s by default, never more than 120 s), the merchant it serves, and that the id was never used;
//  - Growth then asks the database to open the session: it re-checks, in one transaction, the ACTIVE membership and the ACTIVE Growth module and reads the CURRENT
//    role. A person without Growth access, a suspended person, or another merchant's person gets nothing (no session, no data).
// This file is identical in the Sourcing and Growth trees (they deploy separately). It does not touch the Finance ticket.
import { createSessionAssurance } from './session-assurance.js';
import { createEventLog } from './events.js';
import { createMfaRule } from '../settings-security/mfa-rule.js';
import { createHash, createHmac, randomBytes as cryptoRandomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { generateSessionToken, hashSessionToken } from './sessions.js';

export const HANDOFF_AUDIENCE = 'nordla-growth';
export const HANDOFF_MAX_TTL_SECONDS = 120;
export const HANDOFF_MIN_SECRET_LENGTH = 24;
export const HANDOFF_DESTINATIONS = Object.freeze({ dropoff: '/#/dropoff', opportunities: '/#/opportunities' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const keyOf = (secret) => createHash('sha256').update(`nordla-growth-sso-v1:${String(secret)}`).digest();
const sign = (secret, body) => createHmac('sha256', keyOf(secret)).update(body).digest();
const secretOk = (secret) => typeof secret === 'string' && secret.length >= HANDOFF_MIN_SECRET_LENGTH;

/** @returns {string} `<payload>.<signature>` (base64url) */
export function issueHandoff({ secret, merchantId, userId, authSessionId = null, ttlSeconds = 60, now = () => Date.now(), id = () => cryptoRandomBytes(16).toString('hex') }) {
  if (!secretOk(secret)) throw Object.assign(new Error('the Growth SSO secret is missing or shorter than 24 characters'), { code: 'SSO_NOT_CONFIGURED' });
  if (typeof merchantId !== 'string' || !merchantId) throw Object.assign(new Error('a merchant is required'), { code: 'SSO_MERCHANT_REQUIRED' });
  if (typeof userId !== 'string' || !UUID.test(userId)) throw Object.assign(new Error('a signed-in person is required'), { code: 'SSO_USER_REQUIRED' });
  if (authSessionId !== null && !UUID.test(authSessionId)) throw Object.assign(new Error('a valid source session is required'),{code:'SSO_SOURCE_SESSION_INVALID'});
  const ttl = Math.min(Math.max(1, Math.trunc(ttlSeconds)), HANDOFF_MAX_TTL_SECONDS);
  const iat = Math.floor(now() / 1000);
  const body = b64u(JSON.stringify({ v: 1, aud: HANDOFF_AUDIENCE, m: merchantId, u: userId.toLowerCase(), ...(authSessionId ? {sid:authSessionId.toLowerCase()} : {}), jti: id(), iat, exp: iat + ttl }));
  return `${body}.${b64u(sign(secret, body))}`;
}

/** The verifier keeps the ids it has accepted (in memory, until they expire): one ticket opens ONE session. */
export function createHandoffVerifier({ secret, merchantId, now = () => Date.now(), skewSeconds = 30 }) {
  if (!secretOk(secret)) throw Object.assign(new Error('the Growth SSO secret is missing or shorter than 24 characters'), { code: 'SSO_NOT_CONFIGURED' });
  const used = new Map();
  const prune = (nowS) => { for (const [k, exp] of used) if (exp < nowS - skewSeconds) used.delete(k); };
  /** @returns {{ ok: true, userId: string } | { ok: false, code: string }} */
  function verify(ticket) {
    const parts = typeof ticket === 'string' && ticket.length <= 2000 ? ticket.split('.') : [];
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return { ok: false, code: 'SSO_MALFORMED' };
    const expected = sign(secret, parts[0]); const given = Buffer.from(parts[1], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: 'SSO_BAD_SIGNATURE' };
    let p; try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return { ok: false, code: 'SSO_INVALID' }; }
    if (!p || p.v !== 1 || p.aud !== HANDOFF_AUDIENCE || typeof p.m !== 'string' || typeof p.u !== 'string' || !UUID.test(p.u) || typeof p.jti !== 'string' || !/^[0-9a-f]{16,64}$/.test(p.jti)
        || !Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp <= p.iat || p.exp - p.iat > HANDOFF_MAX_TTL_SECONDS) return { ok: false, code: 'SSO_INVALID' };
    if (p.sid !== undefined && (typeof p.sid !== 'string' || !UUID.test(p.sid))) return {ok:false,code:'SSO_INVALID'};
    const nowS = Math.floor(now() / 1000);
    if (p.iat > nowS + skewSeconds) return { ok: false, code: 'SSO_NOT_YET_VALID' };
    if (p.exp < nowS) return { ok: false, code: 'SSO_EXPIRED' };
    if (p.m.toLowerCase() !== String(merchantId).toLowerCase()) return { ok: false, code: 'SSO_WRONG_MERCHANT' };
    prune(nowS);
    if (used.has(p.jti)) return { ok: false, code: 'SSO_REPLAYED' };
    used.set(p.jti, p.exp);
    return { ok: true, userId: p.u, ...(p.sid ? {authSessionId:p.sid} : {}) };
  }
  return Object.freeze({ verify });
}

/** Opens a session of THIS merchant and module for the person in a verified ticket, through the same database function as a password sign-in
 *  (membership + module re-checked in one transaction, current role read, token hash only stored). No password is involved: the Nordla session already proved the person.
 *  @returns {Promise<{ ok: true, token: string, role: string } | { ok: false }>} a refusal is always the same bare `{ ok: false }` (the journal keeps the real reason). */
export async function openSessionForHandoff({ supabase, merchantId, moduleCode, userId, authSessionId = null, requireCoreSession = false, absoluteMs, now = () => new Date(), newId = randomUUID, randomBytes = cryptoRandomBytes }) {
  if (!Number.isInteger(absoluteMs) || absoluteMs <= 0) throw new TypeError('absoluteMs (the identity session lifetime) is required');
  const token = generateSessionToken(randomBytes); const at = now(); const correlationId = newId();
  if (requireCoreSession || authSessionId) {
    const source = await createSessionAssurance({supabase,now:()=>now().getTime()}).check({merchantId:String(merchantId).toLowerCase(),userId,sessionId:authSessionId,module:'sourcing'});
    if (!source.ok) return {ok:false};
    try {
      if(await createMfaRule({supabase,ttlMs:0}).blocked({merchantId,userId,sessionId:authSessionId,module:'sourcing'}))return {ok:false};
      await createEventLog({supabase,now:()=>at,newId}).record({merchantId,userId,module:moduleCode,type:'AUTH_SUCCEEDED',outcome:'SUCCESS',correlationId,detail:{via:'CORE_HANDOFF',sourceSessionId:authSessionId}});
    } catch {return {ok:false};}
  }
  let out;
  try { out = await supabase.rpc('identity_open_session', { p_user: userId, p_merchant: String(merchantId).toLowerCase(), p_module: moduleCode, p_token_hash: hashSessionToken(token), p_now: at.toISOString(), p_expires_at: new Date(at.getTime() + absoluteMs).toISOString(), p_correlation: correlationId }); } catch { return { ok: false }; }
  if (!out || out.ok !== true || typeof out.session_id !== 'string') return { ok: false };
  return { ok: true, token, role: out.role };
}
