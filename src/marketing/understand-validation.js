// Shared validators for the Marketing M1 contracts. Pure and side-effect free.
// Messages never echo submitted values (a value could be sensitive); they name the field only.
//
// Privacy by construction (no PII detector): contracts are closed schemas and every reference is an OPAQUE token
// (letters, digits and : _ . / # -). No whitespace, '@', '?' or '&' can pass, so an e-mail, a phone number,
// a customer name or a query string carrying a click id cannot be stored in a reference.

import { createHash } from 'node:crypto';
import { TENANT_SOURCES, isUuid } from '../tenant/index.js';
import { normalizeBrandIdentity } from '../branding/brand.js';
import { BRAND_STATUS } from '../branding/constants.js';
import { MKT_ERROR as E, MarketingUnderstandError } from './understand-constants.js';

export function fail(code, message, detail = {}) {
  throw new MarketingUnderstandError(code, message, detail);
}

export const isPlainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

const REF = /^[A-Za-z0-9][A-Za-z0-9:_./#-]*$/;
const TOKEN = /^[A-Z][A-Z0-9_]*$/;
const LOWER_TOKEN = /^[a-z][a-z0-9_]*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;
const MARKET = /^([A-Z]{2}|[0-9]{3})$/;

export const MAX_TEXT = 500;
export const MAX_SHORT_TEXT = 300;
export const MAX_REFS = 100;

export function closedObject(value, allowedKeys, field) {
  if (!isPlainObject(value)) fail(E.INVALID_FIELD, `${field} must be an object`, { field });
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(E.UNKNOWN_KEY, `${field}.${key} is not part of this contract`, { field, key });
  }
  return value;
}

export function requiredText(value, field, { max = MAX_TEXT, code = E.INVALID_FIELD } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail(code, `${field} must be a non-empty string`, { field });
  const text = value.trim();
  if (text.length > max) fail(code, `${field} is too long`, { field });
  return text;
}

export const optionalText = (value, field, options) => (value == null ? null : requiredText(value, field, options));

export function pattern(value, field, regex, { max = 64, code = E.INVALID_FIELD } = {}) {
  const text = requiredText(value, field, { max, code });
  if (!regex.test(text)) fail(code, `${field} has an invalid format`, { field });
  return text;
}

export const opaqueRef = (value, field, { max = 200, code } = {}) => pattern(value, field, REF, { max, code });
export const upperToken = (value, field, { max = 64, code } = {}) => pattern(value, field, TOKEN, { max, code });
export const lowerToken = (value, field, { max = 64, code } = {}) => pattern(value, field, LOWER_TOKEN, { max, code });
export const idValue = (value, field, code) => pattern(value, field, ID, { max: 128, code });
export const optionalRef = (value, field) => (value == null ? null : opaqueRef(value, field));

export function enumValue(value, allowed, field, code = E.INVALID_FIELD) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!Object.values(allowed).includes(text)) fail(code, `${field} is not an allowed value`, { field });
  return text;
}

function listOf(value, field, max) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(E.INVALID_FIELD, `${field} must be an array`, { field });
  if (value.length > max) fail(E.INVALID_FIELD, `${field} must contain at most ${max} items`, { field });
  return value;
}

// Duplicates are removed (first occurrence wins) - the Branding convention for string lists.
export function refList(value, field, { max = MAX_REFS } = {}) {
  return [...new Set(listOf(value, field, max).map((item, i) => opaqueRef(item, `${field}[${i}]`)))];
}

export function textList(value, field, { max = 50, maxLength = MAX_SHORT_TEXT } = {}) {
  return [...new Set(listOf(value, field, max).map((item, i) => requiredText(item, `${field}[${i}]`, { max: maxLength })))];
}

export function tokenList(value, field, { max = 20 } = {}) {
  return [...new Set(listOf(value, field, max).map((item, i) => upperToken(item, `${field}[${i}]`)))];
}

export function objectList(value, field, normalizer, { max = 20, keyOf } = {}) {
  const out = listOf(value, field, max).map((item, i) => normalizer(item, `${field}[${i}]`));
  if (keyOf && new Set(out.map(keyOf)).size !== out.length) fail(E.DUPLICATE_ENTRY, `${field} contains a duplicate entry`, { field });
  return out;
}

// Timestamps are ISO-8601 with an EXPLICIT offset and a real calendar date; the engine has no implicit clock or timezone.
export function isoTimestamp(value, field, code = E.INVALID_TIMESTAMP) {
  const match = typeof value === 'string' ? ISO.exec(value) : null;
  const ms = match ? Date.parse(value) : NaN;
  if (!match || Number.isNaN(ms)) fail(code, `${field} must be an ISO-8601 timestamp with an explicit offset`, { field });
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    fail(code, `${field} is not a real calendar date/time`, { field });
  }
  return new Date(ms).toISOString();
}

export const optionalTimestamp = (value, field) => (value == null ? null : isoTimestamp(value, field));

// The explicit clock handed to every freshness decision.
export function asOfValue(value, field = 'asOf') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return isoTimestamp(value, field);
}

export const toMs = (isoValue) => Date.parse(isoValue);

export function uuidValue(value, field, code = E.INVALID_FIELD) {
  const text = requiredText(value, field, { max: 64, code });
  if (!isUuid(text)) fail(code, `${field} must be a UUID`, { field });
  return text.toLowerCase();
}

// The tenant comes from the canonical resolver (src/tenant); a payload merchant_id is never trusted on its own.
export function tenantMerchantId(tenant) {
  if (!isPlainObject(tenant) || !TENANT_SOURCES.includes(tenant.source) || !isUuid(tenant.merchantId)) {
    fail(E.TENANT_INVALID, 'tenant must be the result of the canonical tenant resolver');
  }
  return tenant.merchantId.toLowerCase();
}

// A Brand Identity must come from trusted server context. brand_id is never inferred from a payload.
export function brandIdentity(brand, merchantId, mismatchCode) {
  let identity;
  try {
    identity = normalizeBrandIdentity(brand);
  } catch {
    fail(E.BRAND_IDENTITY_INVALID, 'brand is not a valid Brand Identity');
  }
  if (identity.merchant_id !== merchantId) fail(mismatchCode, 'brand does not belong to the resolved tenant');
  if (identity.status !== BRAND_STATUS.ACTIVE) fail(E.BRAND_INACTIVE, 'brand is not active');
  return identity;
}

/**
 * brand_id is optional (a merchant-wide object has none). When declared it must be a UUID distinct from the merchant,
 * and - if a resolved Brand Identity is supplied - it must be that brand and belong to the same merchant.
 */
export function declaredBrandId(value, brand, merchantId, field, mismatchCode) {
  const declared = value == null ? null : uuidValue(value, `${field}.brand_id`);
  if (declared === merchantId) fail(E.INVALID_FIELD, `${field}.brand_id must be distinct from the merchant`, { field });
  if (brand != null) {
    const identity = brandIdentity(brand, merchantId, mismatchCode);
    if (declared != null && declared !== identity.brand_id) fail(mismatchCode, `${field}.brand_id does not match the resolved brand`);
  }
  return declared;
}

// BCP 47 language[-Script][-REGION], normalized by the platform (fr-be -> fr-BE), like Brand Identity.
const canonicalize = typeof Intl?.getCanonicalLocales === 'function' ? (text) => Intl.getCanonicalLocales(text)[0] : (text) => text;

export function localeValue(value, field) {
  const text = requiredText(value, field, { max: 35 });
  let canonical;
  try {
    canonical = canonicalize(text);
  } catch {
    fail(E.INVALID_FIELD, `${field} must be a BCP 47 locale such as fr-BE`, { field });
  }
  if (!LOCALE.test(canonical)) fail(E.INVALID_FIELD, `${field} must be of the form language[-Script][-REGION]`, { field });
  return canonical;
}

export const optionalLocale = (value, field) => (value == null ? null : localeValue(value, field));
export const optionalMarket = (value, field) => (value == null ? null : pattern(value, field, MARKET, { max: 3 }));

// ---- immutability / determinism ----
export function deepFreeze(value) {
  if (value != null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const stable = (value) => {
  if (value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
};

// Same convention as Branding decision events: replaying the same content yields the same id.
export const deriveId = (prefix, body) => `${prefix}_${createHash('sha256').update(stable(body)).digest('hex').slice(0, 32)}`;
