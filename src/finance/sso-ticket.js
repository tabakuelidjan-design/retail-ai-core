// Single sign-on from the Nordla server to the Finance dashboard (its own domain): a SIGNED, SHORT-LIVED, SINGLE-USE ticket.
//  - issued by the Nordla server for a person who already holds a valid Nordla session (the caller checks the session and the role BEFORE issuing);
//  - carries only the merchant, an expiry and a random id: no person, no role, no secret;
//  - signed with HMAC-SHA256 under a key derived from a server-side secret that both servers hold in their own environment (never sent to a browser);
//  - Finance verifies: signature, audience, shape, lifetime (60 s by default, never more than 120 s), the merchant it serves, and that the id was never used.
//  The ticket travels once, in the URL of one navigation; a copy of it is useless after its first use or after its expiry.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseSsoKey } from '../identity/sso-keys.js';

export const SSO_AUDIENCE = 'nordla-finance';
export const SSO_MAX_TTL_SECONDS = 120;
export const SSO_MIN_SECRET_LENGTH = 32; // bytes of entropy (base64url, 43 characters): see identity/sso-keys.js

const b64u = (buf) => Buffer.from(buf).toString('base64url');
// The Finance key derivation is unchanged; any other audience (e.g. the Analytics dashboard) derives its own key, so a ticket never works for another audience even with the same secret.
const keyOf = (secret, audience = SSO_AUDIENCE) => createHash('sha256').update(audience === SSO_AUDIENCE ? `nordla-finance-sso-v1:${String(secret)}` : `nordla-sso-v1:${audience}:${String(secret)}`).digest();
const sign = (secret, body, audience = SSO_AUDIENCE) => createHmac('sha256', keyOf(secret, audience)).update(body).digest();
const secretOk = (secret) => parseSsoKey(secret).ok;
const secretError = (secret) => parseSsoKey(secret).message ?? 'la clé SSO est invalide';

/** @returns {string} `<payload>.<signature>` (base64url) */
export function issueTicket({ secret, merchantId, audience = SSO_AUDIENCE, ttlSeconds = 60, now = () => Date.now(), id = () => randomBytes(16).toString('hex'), person = null }) {
  if (!secretOk(secret)) throw Object.assign(new Error(secretError(secret)), { code: 'SSO_NOT_CONFIGURED', keyCode: parseSsoKey(secret).code });
  if (typeof merchantId !== 'string' || !merchantId) throw Object.assign(new Error('a merchant is required'), { code: 'SSO_MERCHANT_REQUIRED' });
  const ttl = Math.min(Math.max(1, Math.trunc(ttlSeconds)), SSO_MAX_TTL_SECONDS);
  const iat = Math.floor(now() / 1000);
  // Person claims (contract v2, see identity/sso-contract.js): the person, their role and the module they open. Set by the Nordla server only.
  const personClaims = person ? (() => {
    if (typeof person.userId !== 'string' || !person.userId || typeof person.role !== 'string' || !person.role || typeof person.module !== 'string' || !person.module) throw Object.assign(new Error('a person needs userId, role and module'), { code: 'SSO_PERSON_REQUIRED' });
    if (person.authSessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(person.authSessionId)) throw Object.assign(new Error('a valid source session is required'), {code:'SSO_SOURCE_SESSION_INVALID'});
    return { u: person.userId, r: person.role, mod: person.module, iss: 'nordla-core', ...(person.authSessionId ? {sid:person.authSessionId.toLowerCase()} : {}) };
  })() : {};
  const body = b64u(JSON.stringify({ v: person ? 2 : 1, aud: audience, m: merchantId, ...personClaims, jti: id(), iat, exp: iat + ttl }));
  return `${body}.${b64u(sign(secret, body, audience))}`;
}

/** The verifier keeps the ids it has accepted (in memory, until they expire): one ticket opens ONE session. */
/**
 * @param {object} o
 * @param {boolean} [o.requirePerson=false] refuse any ticket without person claims (contract v2): the service then knows who opens it
 * @param {string|null} [o.module=null] when set, the ticket must be for this module (SSO_WRONG_MODULE otherwise)
 * @param {Function|null} [o.checkAccess=null] async ({merchantId,userId,role,module}) => {ok:true}|{ok:false,code}: re-checked at USE time
 */
export function createTicketVerifier({ secret, merchantId, audience = SSO_AUDIENCE, now = () => Date.now(), skewSeconds = 30, requirePerson = false, module = null, checkAccess = null }) {
  if (!secretOk(secret)) throw Object.assign(new Error(secretError(secret)), { code: 'SSO_NOT_CONFIGURED', keyCode: parseSsoKey(secret).code });
  const used = new Map(); // jti -> exp (seconds)
  const prune = (nowS) => { for (const [k, exp] of used) if (exp < nowS - skewSeconds) used.delete(k); };
  /** @returns {{ ok: true } | { ok: false, code: 'SSO_MALFORMED'|'SSO_BAD_SIGNATURE'|'SSO_INVALID'|'SSO_EXPIRED'|'SSO_NOT_YET_VALID'|'SSO_WRONG_MERCHANT'|'SSO_REPLAYED' }} */
  function verify(ticket) {
    const parts = typeof ticket === 'string' && ticket.length <= 2000 ? ticket.split('.') : [];
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return { ok: false, code: 'SSO_MALFORMED' };
    const expected = sign(secret, parts[0]); const given = Buffer.from(parts[1], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: 'SSO_BAD_SIGNATURE' };
    let p; try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return { ok: false, code: 'SSO_INVALID' }; }
    if (!p || (p.v !== 1 && p.v !== 2) || p.aud !== audience || typeof p.m !== 'string' || typeof p.jti !== 'string' || !/^[0-9a-f]{16,64}$/.test(p.jti)
        || !Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp <= p.iat || p.exp - p.iat > SSO_MAX_TTL_SECONDS) return { ok: false, code: 'SSO_INVALID' };
    const nowS = Math.floor(now() / 1000);
    if (p.iat > nowS + skewSeconds) return { ok: false, code: 'SSO_NOT_YET_VALID' };
    if (p.exp < nowS) return { ok: false, code: 'SSO_EXPIRED' };
    if (p.m !== merchantId) return { ok: false, code: 'SSO_WRONG_MERCHANT' };
    const hasPerson = typeof p.u === 'string' && typeof p.r === 'string' && typeof p.mod === 'string';
    if (p.sid !== undefined && (typeof p.sid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.sid))) return {ok:false,code:'SSO_INVALID'};
    if (p.v === 2 && !hasPerson) return { ok: false, code: 'SSO_INVALID' };
    if (requirePerson && !hasPerson) return { ok: false, code: 'SSO_NO_PERSON' };
    if (module !== null && (!hasPerson || p.mod !== module)) return { ok: false, code: 'SSO_WRONG_MODULE' };
    prune(nowS);
    if (used.has(p.jti)) return { ok: false, code: 'SSO_REPLAYED' };
    used.set(p.jti, p.exp);
    return hasPerson ? { ok: true, claims: Object.freeze({ userId: p.u, role: p.r, module: p.mod, ...(p.sid ? {authSessionId:p.sid} : {}) }) } : { ok: true };
  }
  /**
   * The full check, used by the services: the ticket (as verify) AND, when a checkAccess is given, the person's CURRENT access
   * (membership, role, entitlement) at the moment of use. Any error in the check is a refusal (SSO_ACCESS_UNAVAILABLE).
   */
  async function verifyAsync(ticket) {
    const r = verify(ticket);
    if (!r.ok || !checkAccess || !r.claims) return r;
    let a;
    try { a = await checkAccess({ merchantId, userId: r.claims.userId, role: r.claims.role, module: r.claims.module, ...(r.claims.authSessionId ? {authSessionId:r.claims.authSessionId} : {}) }); } catch { return { ok: false, code: 'SSO_ACCESS_UNAVAILABLE' }; }
    if (!a || a.ok !== true) return { ok: false, code: (a && typeof a.code === 'string' && a.code) || 'SSO_ACCESS_DENIED' };
    return { ok: true, claims: r.claims, access: Object.freeze({ role: a.role ?? r.claims.role }) };
  }
  return Object.freeze({ verify, verifyAsync });
}
