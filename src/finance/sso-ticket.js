// Single sign-on from the Nordla server to the Finance dashboard (its own domain): a SIGNED, SHORT-LIVED, SINGLE-USE ticket.
//  - issued by the Nordla server for a person who already holds a valid Nordla session (the caller checks the session and the role BEFORE issuing);
//  - carries only the merchant, an expiry and a random id: no person, no role, no secret;
//  - signed with HMAC-SHA256 under a key derived from a server-side secret that both servers hold in their own environment (never sent to a browser);
//  - Finance verifies: signature, audience, shape, lifetime (60 s by default, never more than 120 s), the merchant it serves, and that the id was never used.
//  The ticket travels once, in the URL of one navigation; a copy of it is useless after its first use or after its expiry.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SSO_AUDIENCE = 'nordla-finance';
export const SSO_MAX_TTL_SECONDS = 120;
export const SSO_MIN_SECRET_LENGTH = 24;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const keyOf = (secret) => createHash('sha256').update(`nordla-finance-sso-v1:${String(secret)}`).digest();
const sign = (secret, body) => createHmac('sha256', keyOf(secret)).update(body).digest();
const secretOk = (secret) => typeof secret === 'string' && secret.length >= SSO_MIN_SECRET_LENGTH;

/** @returns {string} `<payload>.<signature>` (base64url) */
export function issueTicket({ secret, merchantId, ttlSeconds = 60, now = () => Date.now(), id = () => randomBytes(16).toString('hex') }) {
  if (!secretOk(secret)) throw Object.assign(new Error('the SSO secret is missing or shorter than 24 characters'), { code: 'SSO_NOT_CONFIGURED' });
  if (typeof merchantId !== 'string' || !merchantId) throw Object.assign(new Error('a merchant is required'), { code: 'SSO_MERCHANT_REQUIRED' });
  const ttl = Math.min(Math.max(1, Math.trunc(ttlSeconds)), SSO_MAX_TTL_SECONDS);
  const iat = Math.floor(now() / 1000);
  const body = b64u(JSON.stringify({ v: 1, aud: SSO_AUDIENCE, m: merchantId, jti: id(), iat, exp: iat + ttl }));
  return `${body}.${b64u(sign(secret, body))}`;
}

/** The verifier keeps the ids it has accepted (in memory, until they expire): one ticket opens ONE session. */
export function createTicketVerifier({ secret, merchantId, now = () => Date.now(), skewSeconds = 30 }) {
  if (!secretOk(secret)) throw Object.assign(new Error('the SSO secret is missing or shorter than 24 characters'), { code: 'SSO_NOT_CONFIGURED' });
  const used = new Map(); // jti -> exp (seconds)
  const prune = (nowS) => { for (const [k, exp] of used) if (exp < nowS - skewSeconds) used.delete(k); };
  /** @returns {{ ok: true } | { ok: false, code: 'SSO_MALFORMED'|'SSO_BAD_SIGNATURE'|'SSO_INVALID'|'SSO_EXPIRED'|'SSO_NOT_YET_VALID'|'SSO_WRONG_MERCHANT'|'SSO_REPLAYED' }} */
  function verify(ticket) {
    const parts = typeof ticket === 'string' && ticket.length <= 2000 ? ticket.split('.') : [];
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return { ok: false, code: 'SSO_MALFORMED' };
    const expected = sign(secret, parts[0]); const given = Buffer.from(parts[1], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: 'SSO_BAD_SIGNATURE' };
    let p; try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return { ok: false, code: 'SSO_INVALID' }; }
    if (!p || p.v !== 1 || p.aud !== SSO_AUDIENCE || typeof p.m !== 'string' || typeof p.jti !== 'string' || !/^[0-9a-f]{16,64}$/.test(p.jti)
        || !Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp <= p.iat || p.exp - p.iat > SSO_MAX_TTL_SECONDS) return { ok: false, code: 'SSO_INVALID' };
    const nowS = Math.floor(now() / 1000);
    if (p.iat > nowS + skewSeconds) return { ok: false, code: 'SSO_NOT_YET_VALID' };
    if (p.exp < nowS) return { ok: false, code: 'SSO_EXPIRED' };
    if (p.m !== merchantId) return { ok: false, code: 'SSO_WRONG_MERCHANT' };
    prune(nowS);
    if (used.has(p.jti)) return { ok: false, code: 'SSO_REPLAYED' };
    used.set(p.jti, p.exp);
    return { ok: true };
  }
  return Object.freeze({ verify });
}
