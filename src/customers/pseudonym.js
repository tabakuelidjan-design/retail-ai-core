// Pseudonymous customer key. The source's customer id is never stored: only HMAC-SHA256(secret, id) is.
// The secret lives in a local environment variable (CUSTOMER_HASH_KEY), never in git. Without the secret the
// key cannot be recomputed or reversed, and a different secret yields unrelated keys.

import { createHmac } from 'node:crypto';

export const MIN_SECRET_LENGTH = 32;

export class CustomerKeyConfigError extends Error {}

/** @returns {string|null} the secret when customer keys are enabled, null when they are off. Throws on a weak secret. */
export function loadCustomerKeySecret(env = process.env) {
  if (env.SYNC_CUSTOMER_KEY !== '1') return null;
  const secret = env.CUSTOMER_HASH_KEY;
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new CustomerKeyConfigError(`CUSTOMER_HASH_KEY must be set (at least ${MIN_SECRET_LENGTH} characters) when SYNC_CUSTOMER_KEY=1`);
  return secret;
}

/** @param {string|null|undefined} sourceCustomerId @returns {string|null} 64-char hex, or null for an anonymous order */
export function pseudonymizeCustomerId(sourceCustomerId, secret) {
  if (!sourceCustomerId) return null;
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new CustomerKeyConfigError('a strong secret is required to pseudonymize a customer id');
  return createHmac('sha256', secret).update(String(sourceCustomerId)).digest('hex');
}
