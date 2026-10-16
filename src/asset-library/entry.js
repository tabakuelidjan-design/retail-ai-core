import { createHash } from 'node:crypto';
import { APPROVAL_STATUS, ASSET_KIND, ASSET_STAGE, AssetLibraryError, LIBRARY_ERROR as E, ORIGIN_CLASS, RIGHTS_STATUS } from './constants.js';

const ID = /^[a-z0-9][a-z0-9-]{5,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OPAQUE = /^(private-asset|asset):\/\/[A-Za-z0-9._:/-]+$/;
const KEYS = [
  'asset_id', 'source_ref', 'kind', 'stage', 'media_type', 'width_px', 'height_px', 'has_alpha', 'content_hash', 'bytes', 'original_name',
  'origin_class', 'rights_status', 'rights_evidence_ref', 'approval_status', 'approval_ref', 'product_refs', 'collection_refs', 'tags', 'version',
  'derived_from', 'notes',
];

const fail = (message, detail) => { throw new AssetLibraryError(E.INVALID_ENTRY, message, detail); };
const oneOf = (v, set, field) => { if (!Object.values(set).includes(v)) fail(`${field} is not an allowed value`, { field }); return v; };
const strings = (v, field, max = 50) => {
  if (!Array.isArray(v) || v.length > max || v.some((s) => typeof s !== 'string' || !s || s.length > 160)) fail(`${field} must be a short list of strings`, { field });
  return [...new Set(v)].sort();
};
const posInt = (v, field) => (v == null ? null : Number.isInteger(v) && v > 0 ? v : fail(`${field} must be a positive integer`, { field }));

/** Deterministic id from the content: the same bytes are the same asset. */
export const assetIdFor = (contentHash) => `a-${contentHash.slice(0, 16)}`;
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function normalizeEntry(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) fail('entry must be an object');
  for (const k of Object.keys(input)) if (!KEYS.includes(k)) fail(`entry.${k} is not part of this contract`, { key: k });
  if (typeof input.asset_id !== 'string' || !ID.test(input.asset_id)) fail('asset_id must be a short slug', { field: 'asset_id' });
  if (typeof input.source_ref !== 'string' || !OPAQUE.test(input.source_ref)) fail('source_ref must be an opaque asset:// or private-asset:// reference (never a path)', { field: 'source_ref' });
  if (typeof input.content_hash !== 'string' || !HEX64.test(input.content_hash)) fail('content_hash must be a sha-256 hex digest', { field: 'content_hash' });
  const out = {
    asset_id: input.asset_id,
    source_ref: input.source_ref,
    kind: oneOf(input.kind, ASSET_KIND, 'kind'),
    stage: oneOf(input.stage, ASSET_STAGE, 'stage'),
    media_type: typeof input.media_type === 'string' && input.media_type ? input.media_type : fail('media_type is required', { field: 'media_type' }),
    width_px: posInt(input.width_px, 'width_px'),
    height_px: posInt(input.height_px, 'height_px'),
    has_alpha: input.has_alpha === true,
    content_hash: input.content_hash,
    bytes: Number.isInteger(input.bytes) && input.bytes >= 0 ? input.bytes : fail('bytes must be a non-negative integer', { field: 'bytes' }),
    original_name: typeof input.original_name === 'string' && input.original_name.length <= 200 ? input.original_name : fail('original_name is required', { field: 'original_name' }),
    origin_class: oneOf(input.origin_class ?? ORIGIN_CLASS.UNCLASSIFIED, ORIGIN_CLASS, 'origin_class'),
    rights_status: oneOf(input.rights_status ?? RIGHTS_STATUS.UNVERIFIED, RIGHTS_STATUS, 'rights_status'),
    rights_evidence_ref: input.rights_evidence_ref ?? null,
    approval_status: oneOf(input.approval_status ?? APPROVAL_STATUS.NOT_REVIEWED, APPROVAL_STATUS, 'approval_status'),
    approval_ref: input.approval_ref ?? null,
    product_refs: strings(input.product_refs ?? [], 'product_refs'),
    collection_refs: strings(input.collection_refs ?? [], 'collection_refs'),
    tags: strings(input.tags ?? [], 'tags'),
    version: Number.isInteger(input.version) && input.version >= 1 ? input.version : 1,
    derived_from: input.derived_from == null ? null : (HEX64.test(input.derived_from) ? input.derived_from : fail('derived_from must be a content hash', { field: 'derived_from' })),
    notes: strings(input.notes ?? [], 'notes', 20),
  };
  // a status that claims a human decision must name it
  if (out.rights_status === RIGHTS_STATUS.OWNER_CONFIRMED && !out.rights_evidence_ref) fail('OWNER_CONFIRMED rights need an evidence reference', { field: 'rights_evidence_ref' });
  if (out.approval_status === APPROVAL_STATUS.APPROVED && !out.approval_ref) fail('APPROVED needs an approval reference', { field: 'approval_ref' });
  return Object.freeze(out);
}

/** An asset may enter something that will be published only if it is a genuine HABB asset, rights confirmed AND approved. */
export function publishability(entry) {
  const reasons = [];
  if ([ORIGIN_CLASS.AI_GENERATED, ORIGIN_CLASS.SUPPLIER_IMAGE, ORIGIN_CLASS.SCREENSHOT_OR_SOCIAL, ORIGIN_CLASS.UNCLASSIFIED].includes(entry.origin_class)) {
    reasons.push(`ORIGIN_${entry.origin_class}`);
  }
  if (entry.rights_status !== RIGHTS_STATUS.OWNER_CONFIRMED) reasons.push(`RIGHTS_${entry.rights_status}`);
  if (entry.approval_status !== APPROVAL_STATUS.APPROVED) reasons.push(`APPROVAL_${entry.approval_status}`);
  return { publishable: reasons.length === 0, reasons };
}
