// Nordla HTTP security (Core C4) - response security headers.
//
// CSP: closed by default - same-origin only, no 'unsafe-inline' / 'unsafe-eval', no framing of Nordla, no plugins, no <base>,
// forms only to self; scripts / styles may carry a per-response nonce. A service may open FOUR directives, and only through typed,
// validated lists (never a raw CSP string):
//
//   option          directive     default            accepted keywords        + exact origins
//   imgSources      img-src       'self' data:       'self', data:, blob:      https://host[:port]
//   connectSources  connect-src   'self'             'self'                    https://host[:port]
//   frameSources    frame-src     'none'             'self', blob:             https://host[:port]
//   objectSources   object-src    'none'             'self'                    https://host[:port]
//
// Origins are normalised (lower case, one trailing slash tolerated), must be https (hosted) - locally http is accepted for
// loopback hosts only -, carry no wildcard, path, query or credentials; duplicates are removed; keywords come first in a fixed
// order, then origins sorted: the header is deterministic. Unknown option, keyword or value -> TypeError.
//
// Permissions-Policy: a closed list of features, all disabled by default (camera, microphone, geolocation, payment, usb). A service
// may enable one explicitly, for `self` and / or exact https origins only (never *), e.g. { microphone: ['self'] }.
//
// HSTS only for hosted HTTPS (no includeSubDomains: the *.up.railway.app parent is on the Public Suffix List and not ours).
// Authentication responses are never cached.
//
// Future needs this makes possible WITHOUT wiring them now (no module is configured in C4):
//   Growth / Finances catalogue pictures:  csp: { imgSources: ['https://cdn.shopify.com'] }
//   Finances PDF preview (iframes on its own /api/documents/:id/pdf and /api/inbox/:id/file):  csp: { frameSources: ["'self'"] }
//   Analytics voice input (C11):           permissions: { microphone: ['self'] }

import { normalizeOrigin } from './request.js';

const NONCE = /^[A-Za-z0-9+/_-]{16,64}={0,2}$/;
const LOOPBACK = (hostname) => hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/** The four openable CSP directives: defaults and accepted keywords (in output order). */
export const CSP_OPTIONS = Object.freeze({
  imgSources: Object.freeze({ directive: 'img-src', defaults: Object.freeze(["'self'", 'data:']), keywords: Object.freeze(["'self'", 'data:', 'blob:']) }),
  connectSources: Object.freeze({ directive: 'connect-src', defaults: Object.freeze(["'self'"]), keywords: Object.freeze(["'self'"]) }),
  frameSources: Object.freeze({ directive: 'frame-src', defaults: Object.freeze([]), keywords: Object.freeze(["'self'", 'blob:']) }),
  objectSources: Object.freeze({ directive: 'object-src', defaults: Object.freeze([]), keywords: Object.freeze(["'self'"]) }),
});
/** Permissions-Policy features Nordla knows; all disabled unless a service enables one explicitly. */
export const PERMISSION_FEATURES = Object.freeze(['camera', 'microphone', 'geolocation', 'payment', 'usb']);

/** An exact origin for a policy, or throws. https only, except http on a loopback host when not hosted. */
function policyOrigin(raw, { hosted, allowLocalHttp }, where) {
  if (typeof raw !== 'string' || raw.includes('*')) throw new TypeError(`${where}: wildcards are not allowed`);
  const trimmed = raw.trim().replace(/\/$/, '');
  const o = normalizeOrigin(trimmed);
  if (!o) throw new TypeError(`${where}: "${raw}" is not an exact origin (scheme://host[:port], no path)`);
  const u = new URL(o);
  if (u.protocol === 'https:') return o;
  if (u.protocol === 'http:' && allowLocalHttp && !hosted && LOOPBACK(u.hostname)) return o;
  throw new TypeError(`${where}: only https origins are accepted${hosted ? ' in hosted mode' : ''}`);
}

/**
 * Validates and normalises CSP extensions. Returns a frozen object of four frozen, de-duplicated, ordered lists (extras only).
 * @param {{ imgSources?: string[], connectSources?: string[], frameSources?: string[], objectSources?: string[] }} csp
 * @param {{ hosted: boolean }} mode
 */
export function normalizeCspOptions(csp = {}, { hosted }) {
  if (csp === null || typeof csp !== 'object' || Array.isArray(csp)) throw new TypeError('csp must be an object of source lists');
  for (const k of Object.keys(csp)) if (!(k in CSP_OPTIONS)) throw new TypeError(`csp: unknown option "${k}"`);
  const out = {};
  for (const [option, rule] of Object.entries(CSP_OPTIONS)) {
    const list = csp[option] ?? [];
    if (!Array.isArray(list)) throw new TypeError(`csp.${option} must be a list`);
    const keywords = new Set(); const origins = new Set();
    for (const v of list) {
      if (typeof v !== 'string') throw new TypeError(`csp.${option}: invalid value`);
      if (v.startsWith("'") || v.endsWith(':')) {
        if (!rule.keywords.includes(v)) throw new TypeError(`csp.${option}: ${v} is not allowed in ${rule.directive}`);
        keywords.add(v);
      } else origins.add(policyOrigin(v, { hosted, allowLocalHttp: true }, `csp.${option}`));
    }
    out[option] = Object.freeze([...rule.keywords.filter((k) => keywords.has(k)), ...[...origins].sort()]);
  }
  return Object.freeze(out);
}

/**
 * Validates Permissions-Policy grants: { feature: ['self' | 'https://origin', ...] }. Returns a frozen object with one frozen,
 * de-duplicated, ordered list per known feature (empty = disabled).
 */
export function normalizePermissions(permissions = {}) {
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) throw new TypeError('permissions must be an object');
  for (const k of Object.keys(permissions)) if (!PERMISSION_FEATURES.includes(k)) throw new TypeError(`permissions: unknown feature "${k}"`);
  const out = {};
  for (const feature of PERMISSION_FEATURES) {
    const list = permissions[feature] ?? [];
    if (!Array.isArray(list)) throw new TypeError(`permissions.${feature} must be a list`);
    let self = false; const origins = new Set();
    for (const v of list) {
      if (v === 'self' || v === "'self'") self = true;
      else if (v === '*' || v === "'*'") throw new TypeError(`permissions.${feature}: * is never allowed`);
      else origins.add(policyOrigin(v, { hosted: true, allowLocalHttp: false }, `permissions.${feature}`));
    }
    out[feature] = Object.freeze([...(self ? ['self'] : []), ...[...origins].sort()]);
  }
  return Object.freeze(out);
}

const cspValue = (keyword) => keyword; // keywords are already in CSP syntax
const permissionsValue = (grants) => PERMISSION_FEATURES.map((f) => `${f}=(${grants[f].map((v) => (v === 'self' ? 'self' : `"${v}"`)).join(' ')})`).join(', ');

/**
 * @param {{ hosted: boolean, nonce?: string|null, authentication?: boolean, csp?: object, permissions?: object }} o
 */
export function securityHeaders({ hosted, nonce = null, authentication = false, csp = {}, permissions = {} } = {}) {
  if (nonce !== null && !NONCE.test(nonce)) throw new TypeError('securityHeaders: invalid nonce');
  const extra = normalizeCspOptions(csp, { hosted });
  const grants = normalizePermissions(permissions);
  const n = nonce ? ` 'nonce-${nonce}'` : '';
  const directive = (option) => {
    const rule = CSP_OPTIONS[option];
    const values = [...rule.keywords.filter((k) => rule.defaults.includes(k) || extra[option].includes(k)), ...extra[option].filter((v) => !rule.keywords.includes(v))];
    return `${rule.directive} ${values.length ? values.map(cspValue).join(' ') : "'none'"}`;
  };
  const policy = [
    "default-src 'self'",
    `script-src 'self'${n}`,
    `style-src 'self'${n}`,
    directive('imgSources'),
    "font-src 'self'",
    directive('connectSources'),
    directive('frameSources'),
    directive('objectSources'),
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const h = {
    'Content-Security-Policy': policy,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': permissionsValue(grants),
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (hosted) h['Strict-Transport-Security'] = 'max-age=31536000';
  if (authentication) { h['Cache-Control'] = 'no-store'; h.Pragma = 'no-cache'; }
  return Object.freeze(h);
}
