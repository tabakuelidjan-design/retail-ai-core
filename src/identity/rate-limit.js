// Nordla identity - limitation of repeated failed identity verifications (ADR 0004, Core C1b; table identity_rate_limits).
//
// Two independent dimensions, each counted in a fixed window and blocked for a fixed time once its maximum is reached:
//   'email'  the normalised e-mail address        (default 5 failures / 15 min)
//   'ip'     the normalised client address, IPv6 grouped by /64   (default 20 failures / 15 min)
// A subject is stored ONLY as HMAC-SHA-256(key, "<dimension>:<normalised value>"). The key is NORDLA_IDENTITY_RATE_LIMIT_KEY:
// at least 32 bytes, never defaulted, never logged, never put in an error. A plain SHA-256 is not used: an e-mail address can be
// recovered from its plain hash by guessing; not from an HMAC without the key.

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { loadRateLimitConfig } from './config.js';

export const TABLE = 'identity_rate_limits';
export const RECORD_FAILURE_FN = 'identity_rate_limit_record_failure';
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
 * @param {{ supabase: { select: Function, rpc: Function }, key: string|Buffer, config?: ReturnType<typeof loadRateLimitConfig>, now?: () => Date }} deps
 */
export function createRateLimiter({ supabase, key, config = loadRateLimitConfig(), now = () => new Date() } = {}) {
  if (!supabase || typeof supabase.select !== 'function' || typeof supabase.rpc !== 'function') throw new TypeError('createRateLimiter needs a Supabase client with select() and rpc()');
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

  /** True when either dimension is blocked now. One read (primary-key lookups). A read failure throws (callers fail closed). */
  async function isBlocked(s) {
    let rows;
    try {
      rows = await supabase.select(TABLE, { select: 'dimension,subject_hmac,blocked_until', subject_hmac: `in.(${s.email},${s.ip})` });
    } catch (e) { throw new RateLimitError('RATE_LIMIT_STORE_FAILED', 'The attempt limits could not be read.'); }
    const t = now().getTime();
    return (rows ?? []).some((r) => ((r.dimension === 'email' && r.subject_hmac === s.email) || (r.dimension === 'ip' && r.subject_hmac === s.ip))
      && r.blocked_until && new Date(r.blocked_until).getTime() > t);
  }

  /** Records one failed verification on both dimensions (atomic per dimension, in the database). Returns whether either is now blocked. */
  async function recordFailure(s) {
    const at = now().toISOString();
    const call = (dimension, subject, max) => supabase.rpc(RECORD_FAILURE_FN, {
      p_dimension: dimension, p_subject: subject, p_now: at, p_window_seconds: config.windowSeconds, p_max_failures: max, p_block_seconds: config.blockSeconds,
    });
    try {
      const [e, i] = await Promise.all([call('email', s.email, config.maxEmailFailures), call('ip', s.ip, config.maxIpFailures)]);
      return { blocked: Boolean(e) || Boolean(i) };
    } catch { throw new RateLimitError('RATE_LIMIT_STORE_FAILED', 'The attempt limits could not be written.'); }
  }

  return Object.freeze({ subjects, isBlocked, recordFailure });
}
