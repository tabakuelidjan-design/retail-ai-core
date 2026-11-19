// Nordla single sign-on keys (HMAC-SHA-256). One key per module; never the dashboard token; never shared between modules.
//
// Format, enforced: base64url WITHOUT padding, exactly 43 characters, which decodes to exactly 32 random bytes.
// Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
// A length check on text is not proof of entropy: the value must decode to >= 32 bytes AND re-encode to itself (no padding, no
// stray characters, no standard-base64 '+' or '/').
//
// Error codes (named in logs and in tests):
//   SSO_KEY_MISSING        no value (or empty)
//   SSO_KEY_BAD_ENCODING   not canonical base64url (wrong characters, padding, whitespace, wrong length)
//   SSO_KEY_TOO_SHORT      decodes to fewer than 32 bytes

import { createHash } from 'node:crypto';

export const SSO_KEY_BYTES = 32;
export const SSO_KEY_CHARS = 43; // ceil(32 * 8 / 6) without padding

const CANONICAL = /^[A-Za-z0-9_-]+$/;

/**
 * @param {unknown} value
 * @returns {{ ok: true, key: Buffer } | { ok: false, code: 'SSO_KEY_MISSING'|'SSO_KEY_BAD_ENCODING'|'SSO_KEY_TOO_SHORT', message: string }}
 */
export function parseSsoKey(value) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, code: 'SSO_KEY_MISSING', message: 'la clé SSO est absente' };
  if (!CANONICAL.test(value) || value.length !== SSO_KEY_CHARS) {
    // a short value of the right alphabet is "too short", anything else is a bad encoding
    if (CANONICAL.test(value) && value.length < SSO_KEY_CHARS) return { ok: false, code: 'SSO_KEY_TOO_SHORT', message: 'la clé SSO doit faire 32 octets aléatoires (43 caractères base64url)' };
    return { ok: false, code: 'SSO_KEY_BAD_ENCODING', message: 'la clé SSO doit être en base64url sans remplissage (43 caractères)' };
  }
  const key = Buffer.from(value, 'base64url');
  if (key.length < SSO_KEY_BYTES) return { ok: false, code: 'SSO_KEY_TOO_SHORT', message: 'la clé SSO doit décoder en 32 octets' };
  if (key.toString('base64url') !== value) return { ok: false, code: 'SSO_KEY_BAD_ENCODING', message: 'la clé SSO n’est pas en base64url canonique' };
  return { ok: true, key };
}

/** A fingerprint for comparing keys without ever printing them (SHA-256, hex). */
export const ssoKeyFingerprint = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');

/**
 * True when a candidate key must be refused because it is the dashboard token or another module's key.
 * Compared on fingerprints, so no secret is compared in clear text or logged.
 */
export function ssoKeyReuseOf(candidate, { dashboardToken = null, otherKeys = [] } = {}) {
  const c = ssoKeyFingerprint(candidate);
  if (dashboardToken && c === ssoKeyFingerprint(dashboardToken)) return 'DASHBOARD_TOKEN';
  for (const k of otherKeys) if (k && c === ssoKeyFingerprint(k)) return 'OTHER_MODULE_KEY';
  return null;
}
