// One-time recovery codes for the second factor. Format XXXXX-XXXXX (alphabet without look-alikes, ~50 random bits), shown ONCE; only a SHA-256 is stored.
// consume() is atomic: a single UPDATE ... WHERE used_at IS NULL, so a code works once even under concurrent attempts.
import { createHash, randomInt } from 'node:crypto';

export const TABLE = 'mfa_recovery_codes';
export const COUNT = 10;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Upper case, no spaces or dashes: what is hashed. Returns null for anything that cannot be a recovery code. */
export function normalizeCode(raw) {
  const c = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{10}$/.test(c) ? c : null;
}
export const hashCode = (normalized) => createHash('sha256').update(normalized, 'utf8').digest('hex');
export function generateCode(rand = randomInt) { let c = ''; for (let i = 0; i < 10; i += 1) c += ALPHABET[rand(ALPHABET.length)]; return `${c.slice(0, 5)}-${c.slice(5)}`; }

export function createRecoveryCodes({ supabase, now = () => new Date(), rand = randomInt }) {
  if (!supabase) throw new TypeError('createRecoveryCodes needs the database client');
  const uid = (u) => (typeof u === 'string' && UUID.test(u) ? u.toLowerCase() : (() => { throw new TypeError('userId invalid'); })());
  return Object.freeze({
    /** Replaces every code of the person by COUNT new ones. Returns the clear codes ONCE. */
    async renew(userId) {
      const id = uid(userId);
      await supabase.delete(TABLE, { user_id: `eq.${id}` });
      const codes = Array.from({ length: COUNT }, () => generateCode(rand));
      await supabase.insert(TABLE, codes.map((c) => ({ user_id: id, code_hash: hashCode(normalizeCode(c)) })));
      return codes;
    },
    /** True only when an unused code matched (and is now used). */
    async consume(userId, raw) {
      const n = normalizeCode(raw); if (!n) return false;
      const rows = await supabase.update(TABLE, { user_id: `eq.${uid(userId)}`, code_hash: `eq.${hashCode(n)}`, used_at: 'is.null' }, { used_at: now().toISOString() });
      return Array.isArray(rows) && rows.length === 1;
    },
    async remaining(userId) { const rows = await supabase.select(TABLE, { select: 'id', user_id: `eq.${uid(userId)}`, used_at: 'is.null', limit: '50' }); return rows?.length ?? 0; },
    async clear(userId) { await supabase.delete(TABLE, { user_id: `eq.${uid(userId)}` }); },
  });
}
