// Growth behind the Core gateway: the Core adds x-nordla-proxy-secret to every request it forwards. With a secret configured, a request
// without the exact secret (a direct call to the module's own address) is refused before anything else. No secret configured: unchanged.
import { timingSafeEqual } from 'node:crypto';

export const MIN_PROXY_SECRET_LENGTH = 24;

export function proxySecretGuard(handler, secret) {
  const want = Buffer.from(String(secret ?? '').trim());
  if (want.length < MIN_PROXY_SECRET_LENGTH) return handler;
  return (req, res) => {
    const got = Buffer.from(String(req.headers['x-nordla-proxy-secret'] ?? ''));
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: 'PROXY_SECRET_REQUIRED' }));
    }
    // The Core passes the Nordla host in x-nordla-public-host (Railway overwrites x-forwarded-host on this hop). Trusted only now, after the secret check.
    const publicHost = req.headers['x-nordla-public-host'];
    if (publicHost) req.headers['x-forwarded-host'] = String(publicHost);
    return handler(req, res);
  };
}
