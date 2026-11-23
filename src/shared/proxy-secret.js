// The shared proxy secret: the Nordla gateway (Core origin) adds it to every request it forwards to a module service, and a service
// refuses any request that does not carry it. A direct call to a service's own address therefore fails, even with a valid token.
import { timingSafeEqual } from 'node:crypto';

export const PROXY_SECRET_HEADER = 'x-nordla-proxy-secret';
const MIN_LENGTH = 24;

/** The secret from the environment, or a thrown error: a hosted service must not start without it. */
export function requiredProxySecret(env, name = 'NORDLA_PROXY_SECRET') {
  const v = String(env?.[name] ?? '');
  if (v.length < MIN_LENGTH) throw new Error(`${name} must be set (at least ${MIN_LENGTH} characters) on a hosted module`);
  return v;
}

/** True when the request carries the expected secret (constant-time). `expected` null: no secret configured, the check is off. */
export function proxySecretOk(req, expected) {
  if (expected == null) return true;
  const got = Buffer.from(String(req.headers[PROXY_SECRET_HEADER] ?? ''));
  const want = Buffer.from(String(expected));
  return got.length === want.length && timingSafeEqual(got, want);
}
