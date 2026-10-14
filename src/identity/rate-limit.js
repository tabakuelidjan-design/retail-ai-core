// Nordla identity - limitation of repeated failed identity verifications (ADR 0004, Core C1b; table identity_rate_limits).
//
// Two independent dimensions, each counted in a fixed window and blocked for a fixed time once its maximum is reached. Every attempt
// is RESERVED atomically in the database before Supabase is called and settled afterwards (see the migration), so simultaneous
// attempts - in one process or across instances - can never exceed a maximum. No in-memory lock is used or needed.
//   'email'  the normalised e-mail address        (default 5 failures / 15 min)
//   'ip'     the normalised client address, IPv6 grouped by /64   (default 20 failures / 15 min)
// A subject is stored ONLY as HMAC-SHA-256(key, "<dimension>:<normalised value>"). The key is NORDLA_IDENTITY_RATE_LIMIT_KEY:
// at least 32 bytes, never defaulted, never logged, never put in an error. A plain SHA-256 is not used: an e-mail address can be
// recovered from its plain hash by guessing; not from an HMAC without the key.

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { loadRateLimitConfig } from './config.js';

export const TABLE = 'identity_rate_limits';
export const RESERVE_FN = 'identity_auth_reserve';
export const SETTLE_FN = 'identity_auth_settle';
export const SETTLE_OUTCOMES = Object.freeze(['FAILURE', 'SUCCESS', 'RELEASE']);
export const RATE_LIMIT_KEY_ENV = 'NORDLA_IDENTITY_RATE_LIMIT_KEY';
export const MIN_KEY_BYTES = 32;
export const DIMENSIONS = Object.freeze(['email', 'ip']);

export class RateLimitError extends Error {
  constructor(code, message) { super(message); this.name = 'RateLimitError'; this.code = code; }
}

/**
 * The HMAC key as bytes. Accepts the raw variable value; refuses a missing, short or trivially repetitive key. There is no default:
 * without a key the service must refuse to start. The value is never part of an error message.
 * @param {string|Buffer|undefined} raw
 */
export function parseRateLimitKey(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') throw new RateLimitError('RATE_LIMIT_KEY_MISSING', `${RATE_LIMIT_KEY_ENV} is not set.`);
  const bytes = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(String(raw).trim(), 'utf8');
  if (bytes.length < MIN_KEY_BYTES) throw new RateLimitError('RATE_LIMIT_KEY_TOO_SHORT', `${RATE_LIMIT_KEY_ENV} must be at least ${MIN_KEY_BYTES} bytes.`);
  if (new Set(bytes).size < 10) throw new RateLimitError('RATE_LIMIT_KEY_WEAK', `${RATE_LIMIT_KEY_ENV} is too repetitive to be a secret key.`);
  return bytes;
}

/** Prudent normalisation of an e-mail address: trimmed, lower-cased, nothing else (no provider-specific rewriting). null if not an address. */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (s.length < 3 || s.length > 254 || /\s/.test(s)) return null;
  return /^[^@]{1,64}@[^@]+\.[^@.]{2,}$/.test(s) ? s : null;
}

/** Normalised client address: IPv4 as is (IPv4-mapped IPv6 unwrapped), IPv6 reduced to its /64 prefix; anything else -> 'unknown'. */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return 'unknown';
  let s = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  const kind = isIP(s);
  if (kind === 4) return s;
  if (kind !== 6) return 'unknown';
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : []; const t = tail ? tail.split(':') : [];
  const full = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

/**
 * @param {{ supabase: { rpc: Function }, key: string|Buffer, config?: ReturnType<typeof loadRateLimitConfig>, now?: () => Date }} deps
 */
export function createRateLimiter({ supabase, key, config = loadRateLimitConfig(), now = () => new Date() } = {}) {
  if (!supabase || typeof supabase.rpc !== 'function') throw new TypeError('createRateLimiter needs a Supabase client with rpc()');
  const secret = parseRateLimitKey(key);
  const hmac = (dimension, value) => createHmac('sha256', secret).update(`${dimension}:${value}`, 'utf8').digest('hex');

  /** The two HMAC subjects of an attempt. `email` may be null (not an address): its subject is then derived from the raw input. */
  function subjects({ email, ip }) {
    const normEmail = normalizeEmail(email);
    return Object.freeze({
      email: hmac('email', normEmail ?? `invalid:${typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : ''}`),
      ip: hmac('ip', normalizeIp(ip)),
    });
  }

  const limits = () => ({
    p_now: now().toISOString(), p_window_seconds: config.windowSeconds, p_max_email: config.maxEmailFailures, p_max_ip: config.maxIpFailures,
    p_block_seconds: config.blockSeconds,
  });

  /**
   * Reserves one attempt in the database BEFORE Supabase is called (atomic, shared by every process and instance). Returns the
   * reservation id, or null when the attempt must be refused (blocked, or failures + attempts in flight at a maximum). A store
   * failure throws (callers fail closed).
   */
  async function reserve(s) {
    try {
      const id = await supabase.rpc(RESERVE_FN, { p_email_subject: s.email, p_ip_subject: s.ip, ...limits(), p_lease_seconds: config.reservationSeconds });
      return typeof id === 'string' && id ? id : null;
    } catch { throw new RateLimitError('RATE_LIMIT_STORE_FAILED', 'The attempt limits could not be checked.'); }
  }

  /**
   * Settles a reservation: 'FAILURE' (counted on both dimensions), 'SUCCESS' (released; e-mail failures reset, IP untouched) or
   * 'RELEASE' (released, nothing counted). Idempotent in the database. Returns whether a subject is now blocked.
   */
  async function settle(reservationId, outcome) {
    if (!SETTLE_OUTCOMES.includes(outcome)) throw new RateLimitError('RATE_LIMIT_OUTCOME_INVALID', 'Unknown settlement outcome.');
    try {
      const blockedUntil = await supabase.rpc(SETTLE_FN, { p_reservation: reservationId, p_outcome: outcome, ...limits() });
      return { blocked: Boolean(blockedUntil) };
    } catch { throw new RateLimitError('RATE_LIMIT_STORE_FAILED', 'The attempt limits could not be written.'); }
  }

  return Object.freeze({ subjects, reserve, settle });
}
