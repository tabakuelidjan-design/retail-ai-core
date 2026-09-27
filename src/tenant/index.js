// Nordla tenant resolver - the ONE place a service learns which tenant (merchants.id) it serves. See ADR 0003.
//
// Sources, in strict priority order:
//   1. 'session'        - tenant bound to an authenticated session (future multi-tenant). Reserved: not implemented yet.
//   2. 'env'            - NORDLA_MERCHANT_ID, for today's single-tenant services (Finance, Core, Analytics). Implemented.
//   3. 'legacy_shopify' - migration-only fallback, only when NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP is explicitly enabled.
//                         Contract defined below; not wired in this step (no Shopify request is ever made here).
//
// Rules (ADR 0003 section 3): never picks "the first" or "the only" merchant, never creates a merchant, makes no Shopify
// call, and the only I/O is one Supabase read of the requested merchant. Every failure is a TenantResolutionError
// with a stable code; messages never contain secrets.

export const MERCHANT_ID_ENV = 'NORDLA_MERCHANT_ID';
export const LEGACY_SHOPIFY_LOOKUP_ENV = 'NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP';
export const TENANT_SOURCES = Object.freeze(['session', 'env', 'legacy_shopify']);

export const TENANT_ERROR_CODES = Object.freeze({
  MERCHANT_ID_MISSING: 'MERCHANT_ID_MISSING', // no tenant source available (NORDLA_MERCHANT_ID not set)
  MERCHANT_ID_INVALID: 'MERCHANT_ID_INVALID', // NORDLA_MERCHANT_ID is not a UUID
  MERCHANT_NOT_FOUND: 'MERCHANT_NOT_FOUND', // well-formed UUID, no such merchant
  TENANT_SOURCE_NOT_AVAILABLE: 'TENANT_SOURCE_NOT_AVAILABLE', // a reserved source (session, legacy_shopify) was requested
  TENANT_LOOKUP_FAILED: 'TENANT_LOOKUP_FAILED', // the merchant read itself failed (network, database)
});

export class TenantResolutionError extends Error {
  /** @param {string} code one of TENANT_ERROR_CODES @param {string} message @param {object} [detail] non-secret context */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'TenantResolutionError';
    this.code = code;
    this.detail = detail;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRUTHY = /^(1|true|yes|on)$/i;

export const isUuid = (value) => typeof value === 'string' && UUID.test(value);

/**
 * The single validation of NORDLA_MERCHANT_ID (services must not re-implement it).
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} the lower-cased UUID, or null when the variable is not set (empty or blank counts as not set)
 * @throws {TenantResolutionError} MERCHANT_ID_INVALID when set but not a UUID
 */
export function readMerchantIdFromEnv(env = process.env) {
  const raw = env[MERCHANT_ID_ENV];
  if (raw == null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (!isUuid(value)) throw new TenantResolutionError(TENANT_ERROR_CODES.MERCHANT_ID_INVALID, `${MERCHANT_ID_ENV} is not a valid UUID.`, { variable: MERCHANT_ID_ENV });
  return value.toLowerCase();
}

/** True only when the legacy Shopify fallback is explicitly enabled. */
export const isLegacyShopifyLookupEnabled = (env = process.env) => TRUTHY.test(String(env[LEGACY_SHOPIFY_LOOKUP_ENV] ?? '').trim());

/**
 * Contract of the migration-only legacy source (ADR 0003, source 3). NOT wired in this step.
 * When implemented, it will map a Shopify shop id to its tenant through merchant_connectors
 * (kind = 'shopify', external_id = shop id) - never through merchants.source_id, never by creating a merchant.
 * @typedef {{ findShopId(): Promise<string> }} LegacyShopifyShopSource  the caller's connector, used only to read the shop id
 */

/**
 * @typedef {{ id: string, name: string, vertical: string|null }} TenantMerchant  non-secret identity of the tenant
 * @typedef {{ merchantId: string, merchant: TenantMerchant, source: 'session'|'env'|'legacy_shopify' }} ResolvedTenant
 */

/**
 * Resolve the tenant a service serves.
 * @param {{
 *   supabase: { select(table: string, params: Record<string, string>): Promise<object[]> },
 *   env?: Record<string, string|undefined>,
 *   session?: unknown,
 * }} options  `session` is reserved for the future multi-tenant source; passing one today is refused.
 * @returns {Promise<ResolvedTenant>}
 * @throws {TenantResolutionError}
 */
export async function resolveTenant({ supabase, env = process.env, session } = {}) {
  if (session !== undefined && session !== null) {
    throw new TenantResolutionError(TENANT_ERROR_CODES.TENANT_SOURCE_NOT_AVAILABLE, 'Session-based tenant resolution is not available yet.', { source: 'session' });
  }

  const merchantId = readMerchantIdFromEnv(env);
  if (merchantId) return resolveMerchantById({ supabase, merchantId, source: 'env' });

  if (isLegacyShopifyLookupEnabled(env)) {
    throw new TenantResolutionError(TENANT_ERROR_CODES.TENANT_SOURCE_NOT_AVAILABLE, `The legacy Shopify tenant lookup is not available in this version; set ${MERCHANT_ID_ENV}.`, { source: 'legacy_shopify' });
  }
  throw new TenantResolutionError(TENANT_ERROR_CODES.MERCHANT_ID_MISSING, `${MERCHANT_ID_ENV} is not set; this service needs an explicit tenant.`, { variable: MERCHANT_ID_ENV });
}

/**
 * Validate that an explicitly requested merchant exists and return its identity. Read-only: one select on `merchants`.
 * @param {{ supabase: object, merchantId: string, source: 'session'|'env'|'legacy_shopify' }} options
 * @returns {Promise<ResolvedTenant>}
 */
export async function resolveMerchantById({ supabase, merchantId, source }) {
  if (!TENANT_SOURCES.includes(source)) throw new TypeError(`unknown tenant source: ${source}`);
  if (!isUuid(merchantId)) throw new TenantResolutionError(TENANT_ERROR_CODES.MERCHANT_ID_INVALID, 'The requested merchant id is not a valid UUID.', { source });
  if (!supabase || typeof supabase.select !== 'function') throw new TypeError('resolveTenant needs a Supabase client with select()');
  const id = merchantId.toLowerCase();
  let rows;
  try {
    rows = await supabase.select('merchants', { select: 'id,name,vertical', id: `eq.${id}`, limit: '1' });
  } catch (e) {
    throw new TenantResolutionError(TENANT_ERROR_CODES.TENANT_LOOKUP_FAILED, 'The merchant could not be read.', { source, cause: e?.name ?? 'Error' });
  }
  const row = Array.isArray(rows) ? rows.find((r) => String(r.id).toLowerCase() === id) : undefined;
  if (!row) throw new TenantResolutionError(TENANT_ERROR_CODES.MERCHANT_NOT_FOUND, 'No merchant exists with the requested id.', { source, merchantId: id });
  return Object.freeze({ merchantId: id, merchant: Object.freeze({ id, name: row.name, vertical: row.vertical ?? null }), source });
}
