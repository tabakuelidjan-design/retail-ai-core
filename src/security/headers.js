// Nordla HTTP security (Core C4) - response security headers.
//
// CSP: same-origin only, no 'unsafe-inline' anywhere, no framing, no plugins, no <base>, forms only to self; scripts / styles may
// additionally carry a per-response nonce (future inline bootstrap). HSTS only for hosted HTTPS (no includeSubDomains: the
// *.up.railway.app parent is on the Public Suffix List and not ours). Authentication responses are never cached.
//
// Known incompatibilities to settle before C5 (not changed now): Growth and Finances currently allow img-src
// https://cdn.shopify.com (catalogue pictures); Finances allows frame-src 'self' (PDF preview) and object-src 'self'; Analytics
// sends no CSP at all today.

const NONCE = /^[A-Za-z0-9+/_-]{16,64}={0,2}$/;

/**
 * @param {{ hosted: boolean, nonce?: string|null, authentication?: boolean, imgSources?: readonly string[] }} o
 *   imgSources: extra exact https origins for images (e.g. a CDN), decided per module in C5
 */
export function securityHeaders({ hosted, nonce = null, authentication = false, imgSources = [] } = {}) {
  if (nonce !== null && !NONCE.test(nonce)) throw new TypeError('securityHeaders: invalid nonce');
  for (const s of imgSources) if (!/^https:\/\/[a-z0-9.-]+$/.test(s)) throw new TypeError('securityHeaders: imgSources must be exact https origins');
  const n = nonce ? ` 'nonce-${nonce}'` : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self'${n}`,
    `style-src 'self'${n}`,
    `img-src 'self' data:${imgSources.length ? ` ${imgSources.join(' ')}` : ''}`,
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const h = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (hosted) h['Strict-Transport-Security'] = 'max-age=31536000';
  if (authentication) { h['Cache-Control'] = 'no-store'; h.Pragma = 'no-cache'; }
  return Object.freeze(h);
}
