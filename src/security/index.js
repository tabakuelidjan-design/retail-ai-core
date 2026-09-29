// Nordla HTTP security (Core C4) - ONE frozen entry point for a module service's HTTP protections.
//
//   createHttpSecurity({
//     environment: 'local' | 'hosted',          hosted = staging / production (HTTPS behind Railway)
//     proxy: 'none' | 'railway',                local -> 'none' (socket address, proxy headers ignored); hosted -> 'railway'
//     allowedHosts: ['growth.example.app'],     exact host[:port], lower case; no wildcard; loopback only in local, never hosted
//     allowedOrigins: ['https://growth.example.app'],   exact origins of those hosts; https only hosted
//     moduleCode: 'growth',                     a registered module (finance | analytics | growth)
//     csrfKey,                                  NORDLA_CSRF_KEY: >= 32 bytes, not repetitive, different from rateLimitKey; required
//                                               hosted (local without it: a random per-process key, sessions do not survive restarts)
//     rateLimitKey?,                            only to check that the two secrets differ
//     loginTiming?: { minMs: 900, jitterMs: 100 },   bounds 200..5000 / 0..500
//     bodyLimitBytes?: 16384,                   1024..65536
//     sessionMaxAgeSeconds?: 43200,             60..43200 (never longer than the 12 h session)
//   })
//
// Returns a frozen object: request context, origin check, guards (read / login / authenticated mutation), cookie jar, CSRF,
// security headers, login time normalisation, body readers, redaction and public errors. Nothing here sends a response,
// sets a real cookie or opens a route: the modules wire it in C5 (Growth), C10 (Finances) and C11 (Analyses).

import { randomBytes, randomUUID } from 'node:crypto';
import { isModuleCode } from '../identity/modules.js';
import { requestContext, checkOrigin, normalizeHost, normalizeOrigin, SAFE_METHODS } from './request.js';
import { createCookieJar } from './cookies.js';
import { createCsrf, CSRF_HEADER } from './csrf.js';
import { securityHeaders } from './headers.js';
import { createLoginTiming } from './timing.js';
import { readJsonBody, readLoginBody } from './body.js';
import { redact, requestLogEntry, publicError, PUBLIC_ERRORS, HttpSecurityError } from './redact.js';

export const CSRF_KEY_ENV = 'NORDLA_CSRF_KEY';
const KEYS = Object.freeze(['environment', 'proxy', 'allowedHosts', 'allowedOrigins', 'moduleCode', 'csrfKey', 'rateLimitKey', 'loginTiming', 'bodyLimitBytes', 'sessionMaxAgeSeconds', 'imgSources', 'now', 'sleep', 'randomInt', 'newId']);
const LOOPBACK = (hostname) => hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.endsWith('.localhost');

export class HttpSecurityConfigError extends Error {
  constructor(field, message) { super(message); this.name = 'HttpSecurityConfigError'; this.code = 'HTTP_SECURITY_CONFIG_INVALID'; this.field = field; }
}
const bad = (field, message) => { throw new HttpSecurityConfigError(field, message); };

function keyBytes(raw, field) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const b = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(String(raw).trim(), 'utf8');
  if (b.length < 32) bad(field, `${field} must be at least 32 bytes.`);
  if (new Set(b).size < 10) bad(field, `${field} is too repetitive to be a secret key.`);
  return b;
}
const bounded = (v, dflt, min, max, field) => {
  if (v === undefined) return dflt;
  if (!Number.isInteger(v) || v < min || v > max) bad(field, `${field} must be a whole number between ${min} and ${max}.`);
  return v;
};

export function createHttpSecurity(config = {}) {
  if (config === null || typeof config !== 'object') bad('config', 'createHttpSecurity needs one configuration object.');
  for (const k of Object.keys(config)) if (!KEYS.includes(k)) bad(k, `Unknown HTTP security setting "${k}".`);
  const { environment, proxy, moduleCode } = config;
  if (!['local', 'hosted'].includes(environment)) bad('environment', 'environment must be "local" or "hosted".');
  const hosted = environment === 'hosted';
  if (hosted && proxy !== 'railway') bad('proxy', 'Hosted mode runs behind Railway: proxy must be "railway".');
  if (!hosted && proxy !== 'none') bad('proxy', 'Local mode trusts no proxy: proxy must be "none".');
  if (!isModuleCode(moduleCode)) bad('moduleCode', 'moduleCode must be a registered module (finance, analytics, growth).');

  // hosts: exact, normalised, no wildcard; loopback only in local, never hosted
  if (!Array.isArray(config.allowedHosts) || !config.allowedHosts.length) bad('allowedHosts', 'allowedHosts must list the exact host names.');
  const allowedHosts = config.allowedHosts.map((h) => {
    if (typeof h !== 'string' || h.includes('*')) bad('allowedHosts', 'allowedHosts accepts no wildcard.');
    const n = normalizeHost(h, hosted ? 'https' : 'http');
    if (!n || n !== h) bad('allowedHosts', 'allowedHosts entries must be exact, lower-case host[:port] values.');
    const name = n.replace(/:\d+$/, '');
    if (hosted && LOOPBACK(name)) bad('allowedHosts', 'A local host cannot be allowed in hosted mode.');
    if (!hosted && !LOOPBACK(name)) bad('allowedHosts', 'Local mode only serves loopback hosts (localhost, 127.0.0.1, [::1]).');
    return n;
  });
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length) bad('allowedOrigins', 'allowedOrigins must list the exact origins.');
  const allowedOrigins = config.allowedOrigins.map((o) => {
    const n = typeof o === 'string' ? normalizeOrigin(o) : null;
    if (!n || n !== o) bad('allowedOrigins', 'allowedOrigins entries must be exact scheme://host[:port] origins (no wildcard, no path).');
    const u = new URL(n);
    if (hosted && u.protocol !== 'https:') bad('allowedOrigins', 'Hosted origins must use https.');
    if (!allowedHosts.includes(u.host)) bad('allowedOrigins', 'Every allowed origin must be one of the allowed hosts.');
    return n;
  });

  // secrets
  let csrfKey = keyBytes(config.csrfKey, CSRF_KEY_ENV);
  if (!csrfKey) { if (hosted) bad('csrfKey', `${CSRF_KEY_ENV} is required in hosted mode.`); csrfKey = randomBytes(32); }
  const rl = config.rateLimitKey === undefined ? null : Buffer.isBuffer(config.rateLimitKey) ? config.rateLimitKey : Buffer.from(String(config.rateLimitKey).trim(), 'utf8');
  if (rl && rl.equals(csrfKey)) bad('csrfKey', `${CSRF_KEY_ENV} must differ from the rate-limit key.`);

  const loginTiming = config.loginTiming ?? {};
  for (const k of Object.keys(loginTiming)) if (!['minMs', 'jitterMs'].includes(k)) bad('loginTiming', `Unknown loginTiming setting "${k}".`);
  const minMs = bounded(loginTiming.minMs, 900, 200, 5000, 'loginTiming.minMs');
  const jitterMs = bounded(loginTiming.jitterMs, 100, 0, 500, 'loginTiming.jitterMs');
  const bodyLimitBytes = bounded(config.bodyLimitBytes, 16 * 1024, 1024, 64 * 1024, 'bodyLimitBytes');
  const sessionMaxAgeSeconds = bounded(config.sessionMaxAgeSeconds, 12 * 3600, 60, 12 * 3600, 'sessionMaxAgeSeconds');
  const imgSources = Object.freeze([...(config.imgSources ?? [])]);
  securityHeaders({ hosted, imgSources }); // validates imgSources now

  const newId = config.newId ?? randomUUID;
  const cfg = Object.freeze({ hosted, proxy, allowedHosts: Object.freeze(allowedHosts), allowedOrigins: Object.freeze(allowedOrigins) });
  const cookies = createCookieJar({ moduleCode, secure: hosted, maxAgeSeconds: sessionMaxAgeSeconds });
  const csrf = createCsrf({ key: csrfKey, moduleCode });
  const timing = createLoginTiming({ minMs, jitterMs, ...(config.now ? { now: config.now } : {}), ...(config.sleep ? { sleep: config.sleep } : {}), ...(config.randomInt ? { randomInt: config.randomInt } : {}) });

  const context = (req) => requestContext(req, cfg, { newId });
  const refuse = (code, publicCode = 'FORBIDDEN', requestId = null) => Object.freeze({ ok: false, code, response: publicError({ publicCode }, { requestId }) });
  const guarded = (req, f) => {
    let ctx;
    try { ctx = context(req); } catch (e) { return refuse(e instanceof HttpSecurityError ? e.code : 'REQUEST_INVALID', e instanceof HttpSecurityError ? e.publicCode : 'BAD_REQUEST'); }
    return f(ctx);
  };

  /** GET / HEAD: host checked; an Origin, if sent, must be allowed. OPTIONS (CORS preflight) is refused: no CORS. */
  const guardRead = (req) => guarded(req, (ctx) => {
    if (ctx.method === 'OPTIONS') return refuse('CORS_NOT_SUPPORTED', 'METHOD_NOT_ALLOWED', ctx.requestId);
    if (!['GET', 'HEAD'].includes(ctx.method)) return refuse('METHOD_NOT_ALLOWED', 'METHOD_NOT_ALLOWED', ctx.requestId);
    const o = checkOrigin(ctx, cfg, { requireOrigin: false });
    return o.ok ? Object.freeze({ ok: true, ctx }) : refuse(o.code, 'FORBIDDEN', ctx.requestId);
  });

  /** Login (no session yet): POST only, exact same-origin Origin required. */
  const guardLogin = (req) => guarded(req, (ctx) => {
    if (ctx.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', 'METHOD_NOT_ALLOWED', ctx.requestId);
    const o = checkOrigin(ctx, cfg, { requireOrigin: true });
    return o.ok ? Object.freeze({ ok: true, ctx }) : refuse(o.code, 'FORBIDDEN', ctx.requestId);
  });

  /**
   * Authenticated mutation: exact Origin + valid CSRF pair bound to the session cookie + a valid session (resolveSession, the C3
   * resolver of the SAME service, called last). Returns { ok: true, ctx, sessionToken, access } or a refusal.
   * @param {(token: string) => Promise<{ ok: boolean }>} resolveSession
   */
  async function guardMutation(req, resolveSession) {
    if (typeof resolveSession !== 'function') throw new TypeError('guardMutation needs the session resolver of this service');
    const first = guarded(req, (ctx) => {
      if (SAFE_METHODS.includes(ctx.method)) return refuse('METHOD_NOT_A_MUTATION', 'METHOD_NOT_ALLOWED', ctx.requestId);
      const o = checkOrigin(ctx, cfg, { requireOrigin: true });
      if (!o.ok) return refuse(o.code, 'FORBIDDEN', ctx.requestId);
      const jar = cookies.read(req.headers?.cookie);
      const header = req.headers?.[CSRF_HEADER];
      const c = csrf.verify({ sessionToken: jar.session, cookieToken: jar.csrf, headerToken: Array.isArray(header) ? undefined : header });
      if (!c.ok) return refuse(c.code, 'FORBIDDEN', ctx.requestId);
      return { ok: true, ctx, sessionToken: jar.session };
    });
    if (!first.ok) return first;
    const access = await resolveSession(first.sessionToken);
    if (!access || access.ok !== true) return refuse('SESSION_INVALID', 'FORBIDDEN', first.ctx.requestId);
    return Object.freeze({ ok: true, ctx: first.ctx, sessionToken: first.sessionToken, access });
  }

  return Object.freeze({
    environment, hosted, module: moduleCode,
    allowedHosts: cfg.allowedHosts, allowedOrigins: cfg.allowedOrigins,
    context, checkOrigin: (ctx, o) => checkOrigin(ctx, cfg, o),
    guardRead, guardLogin, guardMutation,
    cookies, csrfTokenFor: csrf.tokenFor,
    headers: (o = {}) => securityHeaders({ hosted, imgSources, ...o }),
    normalizeLogin: timing.normalize, loginTiming: Object.freeze({ minMs, jitterMs }),
    readLoginBody: (req) => readLoginBody(req, { maxBytes: bodyLimitBytes }),
    readJsonBody,
    redact, requestLogEntry, publicError, PUBLIC_ERRORS,
  });
}
