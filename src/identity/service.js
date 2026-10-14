// Nordla identity - ONE factory for a service's identity stack (ADR 0004, Core C3).
//
// Builds, from a single trusted configuration validated once and frozen, everything a module service needs: the C1b verifier
// (Supabase Auth + attempt limits + journal), the C3 session opening and the session resolution. The merchant and the module are
// written once and shared by every part, so a verifier of merchant A can never be combined with an access service of merchant B,
// a Growth verifier with a Finances service, a journal of another merchant, or a session of another module.
//
//   merchantId   from the tenant resolver (NORDLA_MERCHANT_ID today, ADR 0003) - never from a request
//   moduleCode   the module THIS service is (finance | analytics | growth) - written in the service's code, never from a request
//   supabase     the server's database client (service role)
//   auth         { baseUrl, anonKey } for Supabase Auth (loadGoTrueConfig)
//   sessions     session timing (loadIdentityConfig)
//   rateLimits   attempt limits (loadRateLimitConfig)
//   rateLimitKey NORDLA_IDENTITY_RATE_LIMIT_KEY (secret, >= 32 bytes)
//   fetchImpl, now, newId, randomBytes   injectable for tests only
//
// Nothing is called while building: no Supabase request, no database write. Any inconsistency throws at construction.

import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { loadIdentityConfig, loadRateLimitConfig } from './config.js';
import { createGoTrueVerifier, loadGoTrueConfig } from './gotrue.js';
import { createRateLimiter, RATE_LIMIT_KEY_ENV } from './rate-limit.js';
import { createEventLog } from './events.js';
import { createIdentityVerifier } from './verify.js';
import { createAccessService } from './access.js';
import { isModuleCode } from './modules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = Object.freeze(['merchantId', 'moduleCode', 'supabase', 'auth', 'sessions', 'rateLimits', 'rateLimitKey', 'fetchImpl', 'now', 'newId', 'randomBytes']);

export class IdentityServiceConfigError extends Error {
  constructor(field, message) { super(message); this.name = 'IdentityServiceConfigError'; this.code = 'IDENTITY_SERVICE_CONFIG_INVALID'; this.field = field; }
}
const bad = (field, message) => { throw new IdentityServiceConfigError(field, message); };

/**
 * The environment part of the configuration (secrets and durations), validated. The merchant and the module are NOT read here:
 * they come from the tenant resolver and from the service's own code.
 */
export function loadIdentityServiceEnv(env = process.env) {
  return Object.freeze({
    auth: loadGoTrueConfig(env),
    sessions: loadIdentityConfig(env),
    rateLimits: loadRateLimitConfig(env),
    rateLimitKey: env[RATE_LIMIT_KEY_ENV],
  });
}

/**
 * @param {{ merchantId: string, moduleCode: string, supabase: object, auth: { baseUrl: string, anonKey: string },
 *   sessions: object, rateLimits: object, rateLimitKey: string|Buffer, fetchImpl?: Function, now?: () => Date,
 *   newId?: () => string, randomBytes?: (n: number) => Buffer }} config
 */
export function createIdentityService(config = {}) {
  if (config === null || typeof config !== 'object') bad('config', 'The identity service needs one configuration object.');
  for (const k of Object.keys(config)) if (!KEYS.includes(k)) bad(k, `Unknown identity service setting "${k}".`);
  const { merchantId, moduleCode, supabase, auth, sessions, rateLimits, rateLimitKey } = config;
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) bad('merchantId', 'merchantId must be the UUID given by the tenant resolver.');
  if (!isModuleCode(moduleCode)) bad('moduleCode', 'moduleCode must be a registered module (finance, analytics, growth).');
  if (!supabase || ['select', 'insert', 'update', 'rpc'].some((m) => typeof supabase[m] !== 'function')) bad('supabase', 'supabase must be the server database client.');
  if (!auth || typeof auth.baseUrl !== 'string' || typeof auth.anonKey !== 'string') bad('auth', 'auth must come from loadGoTrueConfig().');
  if (!sessions || !['absoluteMs', 'idleMs', 'touchMs'].every((k) => Number.isInteger(sessions[k]) && sessions[k] > 0)) bad('sessions', 'sessions must come from loadIdentityConfig().');
  if (!rateLimits || !['maxEmailFailures', 'maxIpFailures', 'windowSeconds', 'blockSeconds', 'reservationSeconds'].every((k) => Number.isInteger(rateLimits[k]) && rateLimits[k] > 0)) bad('rateLimits', 'rateLimits must come from loadRateLimitConfig().');
  const now = config.now ?? (() => new Date());
  const newId = config.newId ?? randomUUID;
  const randomBytes = config.randomBytes ?? cryptoRandomBytes;

  // ONE frozen context, shared by every part built below
  const context = Object.freeze({ merchantId: merchantId.toLowerCase(), module: moduleCode });
  const verifier = createIdentityVerifier({
    gotrue: createGoTrueVerifier({ config: Object.freeze({ baseUrl: auth.baseUrl, anonKey: auth.anonKey }), ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}) }),
    limiter: createRateLimiter({ supabase, key: rateLimitKey, config: rateLimits, now }),
    events: createEventLog({ supabase, now, newId }),
    service: context,
    newId,
  });
  const access = createAccessService({ supabase, merchantId: context.merchantId, moduleCode: context.module, verifier, config: sessions, now, newId, randomBytes });
  return Object.freeze({ context, authenticateAndOpenSession: access.authenticateAndOpenSession, resolveAccessSession: access.resolveAccessSession });
}
