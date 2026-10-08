import { BRAND_STATUS } from './constants.js';
import {
  assertObject,
  brandIdValue,
  deepFreeze,
  enumValue,
  isoDate,
  merchantIdValue,
  requiredString,
  tenantMerchantId,
  validationResult,
} from './validation.js';

// Brand Identity = the minimal referential that says WHICH brand a Branding object is about.
//   merchant_id  answers "which company/tenant owns this data?"  (from the canonical tenant resolver)
//   brand_id     answers "which brand is this data about?"
// One merchant can own several brands (house brand + sub-brand, a webshop brand distinct from the
// legal entity, a brand launched later...). Brand Identity is NOT a fifth Branding engine and NOT a
// governed document (no draft/review/approval): it holds no positioning, promise, voice, rules or
// tokens - those stay in Brand Core and Brand Memory. No portfolio logic lives here.
//
// `brand_id` is issued by the server side (a future `brands` registry) and, like `resolvedActor`,
// a brand object must come from trusted server context, never from an untrusted client payload.
// Branding only verifies shape, tenant ownership and status.

const KEYS = ['brand_id', 'merchant_id', 'name', 'status', 'created_at', 'parent_brand_id', 'default_locale', 'supported_locales'];
const MAX_NAME = 120;
const MAX_LOCALES = 30;
// Only canonical BCP 47 locales are STORED, restricted to the simple shape language[-Script][-REGION]
// (fr-BE, nl-BE, en-GB, zh-Hant-TW, es-419): no variants, no extensions, no private use in V1.
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

// A valid locale is NORMALIZED on the way in ("fr-be" -> "fr-BE", legacy "iw" -> "he") by the platform's
// own `Intl.getCanonicalLocales` - no home-made normalizer - instead of being refused for its casing.
// Without Intl, only an already-canonical value is accepted.
const canonicalize = typeof Intl?.getCanonicalLocales === 'function'
  ? (text) => Intl.getCanonicalLocales(text)[0]
  : (text) => text;

function locale(value, field) {
  const text = requiredString(value, field);
  let canonical;
  try {
    canonical = canonicalize(text);
  } catch {
    throw new TypeError(`${field} must be a BCP 47 locale such as fr-BE`);
  }
  if (!LOCALE.test(canonical)) {
    throw new TypeError(`${field} must be a BCP 47 locale of the form language[-Script][-REGION] such as fr-BE`);
  }
  return canonical;
}

export function normalizeBrandIdentity(input) {
  assertObject(input, 'brand');
  for (const key of Object.keys(input)) {
    if (!KEYS.includes(key)) throw new TypeError(`brand.${key} is not part of Brand Identity V1`);
  }

  const merchantId = merchantIdValue(input.merchant_id, 'brand.merchant_id');
  const brandId = brandIdValue(input.brand_id, 'brand.brand_id');
  if (brandId === merchantId) throw new TypeError('brand.brand_id must be distinct from brand.merchant_id');

  const name = requiredString(input.name, 'brand.name');
  if (name.length > MAX_NAME) throw new RangeError('brand.name is too long');

  if (!Array.isArray(input.supported_locales) || input.supported_locales.length === 0) {
    throw new TypeError('brand.supported_locales must be a non-empty array');
  }
  if (input.supported_locales.length > MAX_LOCALES) {
    throw new RangeError(`brand.supported_locales must contain at most ${MAX_LOCALES} locales`);
  }
  const supported = input.supported_locales.map((value, index) => locale(value, `brand.supported_locales[${index}]`));
  // duplicates are detected AFTER normalization, so fr-BE and fr-be count as the same locale
  if (new Set(supported).size !== supported.length) throw new TypeError('brand.supported_locales contains duplicates');

  const defaultLocale = locale(input.default_locale, 'brand.default_locale');
  if (!supported.includes(defaultLocale)) {
    throw new TypeError('brand.default_locale must be one of brand.supported_locales');
  }

  const parent = input.parent_brand_id == null ? null : brandIdValue(input.parent_brand_id, 'brand.parent_brand_id');
  if (parent === brandId) throw new TypeError('brand.parent_brand_id cannot reference the brand itself');

  return deepFreeze({
    brand_id: brandId,
    merchant_id: merchantId,
    name,
    status: enumValue(input.status, BRAND_STATUS, 'brand.status'),
    created_at: isoDate(input.created_at, 'brand.created_at'),
    parent_brand_id: parent,
    default_locale: defaultLocale,
    supported_locales: supported,
  });
}

/** merchant_id always comes from the canonical tenant, never from the caller. */
export function buildBrandIdentity({
  tenant,
  brandId,
  name,
  status = BRAND_STATUS.ACTIVE,
  createdAt,
  parentBrandId = null,
  defaultLocale,
  supportedLocales,
} = {}) {
  return normalizeBrandIdentity({
    brand_id: brandId,
    merchant_id: tenantMerchantId(tenant),
    name,
    status,
    created_at: createdAt,
    parent_brand_id: parentBrandId,
    default_locale: defaultLocale,
    supported_locales: supportedLocales,
  });
}

/**
 * Entry point used by every governed Branding operation: the brand must exist, belong to the
 * canonical tenant and (by default) be ACTIVE. Returns the normalized brand and both ids.
 */
export function resolveBrand(tenant, brand, { requireActive = true } = {}) {
  const merchantId = tenantMerchantId(tenant);
  if (brand == null) throw new Error('BRAND_IDENTITY_MISSING');
  const normalized = normalizeBrandIdentity(brand);
  if (normalized.merchant_id !== merchantId) throw new Error('BRAND_TENANT_MISMATCH');
  if (requireActive && normalized.status !== BRAND_STATUS.ACTIVE) throw new Error('BRAND_INACTIVE');
  return Object.freeze({ brand: normalized, merchantId, brandId: normalized.brand_id });
}

/**
 * A parent must be another brand of the SAME merchant, present in `brands`, without cycles.
 * Validation of a list the caller loaded from its registry; no portfolio logic.
 */
export function validateBrandHierarchy(brands, tenant) {
  const merchantId = tenantMerchantId(tenant);
  const list = brands.map(normalizeBrandIdentity);
  const byId = new Map(list.map((brand) => [brand.brand_id, brand]));
  const reasons = [];

  if (byId.size !== list.length) reasons.push('BRAND_DUPLICATE_ID');
  for (const brand of list) {
    if (brand.merchant_id !== merchantId) reasons.push('BRAND_TENANT_MISMATCH');
    if (brand.parent_brand_id == null) continue;
    const parent = byId.get(brand.parent_brand_id);
    if (!parent) reasons.push('BRAND_PARENT_NOT_FOUND');
    else if (parent.merchant_id !== brand.merchant_id) reasons.push('BRAND_PARENT_TENANT_MISMATCH');
  }
  for (const brand of list) {
    const seen = new Set([brand.brand_id]);
    for (let node = byId.get(brand.parent_brand_id); node; node = byId.get(node.parent_brand_id)) {
      if (seen.has(node.brand_id)) { reasons.push('BRAND_PARENT_CYCLE'); break; }
      seen.add(node.brand_id);
    }
  }
  return validationResult(reasons);
}
