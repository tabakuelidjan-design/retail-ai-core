// Common Socle Resource Resolver: closed vocabularies and stable error codes.
//
// A reference (asset://..., claim://..., format://... or anything else) is an OPAQUE identifier. What it names - a product, an asset, a
// claim, a font, a format - is told by the registry / owner adapter that owns it, never by the shape of the string. This module is a
// SHARED capability of the Socle: it composes owner adapters and never duplicates the data they own.

export const RESOURCE_RESOLVER_VERSION = 'socle-resource-resolver.v1';

export class ResourceResolverError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ResourceResolverError';
    this.code = code;
    this.detail = detail;
  }
}

export const RES_ERROR = Object.freeze({
  INVALID_REFERENCE: 'RES_INVALID_REFERENCE',
  INVALID_TENANT: 'RES_INVALID_TENANT',
  INVALID_ADAPTER: 'RES_INVALID_ADAPTER',
  DUPLICATE_ADAPTER: 'RES_DUPLICATE_ADAPTER',
  ADAPTER_FAILED: 'RES_ADAPTER_FAILED',
  ADAPTER_KIND_UNDECLARED: 'RES_ADAPTER_KIND_UNDECLARED',
  INVALID_RESOLUTION: 'RES_INVALID_RESOLUTION',
  CROSS_MERCHANT: 'RES_CROSS_MERCHANT',
  CONFLICT: 'RES_CONFLICT',
  EVIDENCE_REQUIRED: 'RES_EVIDENCE_REQUIRED',
  METADATA_INVALID: 'RES_METADATA_INVALID',
  METADATA_LOCATION: 'RES_METADATA_LOCATION',
  NOT_ACTIVE: 'RES_NOT_ACTIVE',
  KIND_MISMATCH: 'RES_KIND_MISMATCH',
  NO_PAYLOAD: 'RES_NO_PAYLOAD',
  PAYLOAD_HASH_MISMATCH: 'RES_PAYLOAD_HASH_MISMATCH',
  PAYLOAD_TOO_LARGE: 'RES_PAYLOAD_TOO_LARGE',
});

// Kinds required now. A future kind is added explicitly, never inferred.
export const RESOURCE_KIND = Object.freeze({
  PRODUCT: 'PRODUCT',
  CATEGORY: 'CATEGORY',
  COLLECTION: 'COLLECTION',
  SUBJECT_OTHER: 'SUBJECT_OTHER',
  ASSET: 'ASSET',
  CLAIM: 'CLAIM',
  FONT: 'FONT',
  FORMAT: 'FORMAT',
  POLICY: 'POLICY',
});

export const RESOURCE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE', UNRESOLVED: 'UNRESOLVED', REVOKED: 'REVOKED', EXPIRED: 'EXPIRED', RESTRICTED: 'RESTRICTED',
});

// Only an explicitly designated shared / platform resource may belong to no merchant. Assets, products and claims never do.
export const PLATFORM_LEVEL_KINDS = Object.freeze(['FONT', 'FORMAT']);

// Kinds whose bytes can be loaded (ephemerally) through the trusted adapter that owns them.
export const PAYLOAD_KINDS = Object.freeze(['ASSET', 'FONT']);
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export const FORMAT_UNITS = Object.freeze(['px', 'mm', 'pt']);
export const FORMAT_MEDIUM = Object.freeze({ DIGITAL: 'DIGITAL', PHYSICAL: 'PHYSICAL' });
export const FONT_STYLES = Object.freeze(['normal', 'italic', 'oblique']);
export const FONT_FORMATS = Object.freeze(['ttf', 'otf']);
export const ASSET_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const ASSET_ORIGIN = Object.freeze({ MERCHANT_PROVIDED: 'MERCHANT_PROVIDED', GENERATED: 'GENERATED', SYNTHETIC: 'SYNTHETIC' });
