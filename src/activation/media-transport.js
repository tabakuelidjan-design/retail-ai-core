// MediaTransportProvider: how an approved, DURABLE asset_ref becomes an EPHEMERAL location a provider can fetch.
//
//   mediaTransport.resolve({ asset_ref, provider, purpose }) -> { transport_mode, ephemeral_location?, text?, content_type?,
//                                                                  byte_length?, expires_at?, domain_verified? }
//
// The durable reference is what Nordla stores; the transport location (a signed / public URL) is held in a SealedSecret, used for
// one provider call and NEVER persisted, logged or put in a fingerprint. This layer converts, crops, transcodes and captions nothing:
// an incompatible asset is MEDIA_NOT_COMPATIBLE and goes back to Creative / Production.
// CONTROLLED_MEDIA_DELIVERY (a public, controlled media service) is an OPEN DEPENDENCY: no public server is improvised here.

import { ACT_ERROR as E } from './constants.js';
import {
  deepFreeze, fail, isPlainObject, iso, ref, seal,
} from './validation.js';

const PURPOSES = ['MEDIA', 'TEXT', 'LINK'];

export class MediaTransportError extends Error {
  /** @param {'MEDIA_TRANSPORT_MISSING'|'MEDIA_TRANSPORT_UNAVAILABLE'} code */
  constructor(code) { super(code); this.name = 'MediaTransportError'; this.code = code; }
}

/** In-memory fake: entries are keyed by `${provider}:${asset_ref}`. For tests / sandboxes only. */
export function createInMemoryMediaTransport(entries = {}, { failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    async resolve(request) {
      calls.push({ asset_ref: request.asset_ref, provider: request.provider, purpose: request.purpose });
      if (failWith) throw new MediaTransportError(failWith);
      const entry = entries[`${request.provider}:${request.asset_ref}`] ?? entries[request.asset_ref];
      if (!entry) throw new MediaTransportError('MEDIA_TRANSPORT_MISSING');
      return { ...entry };
    },
  };
}

// The only locations a provider can fetch: public https URLs. Never a file path, a data / blob URI, plain http or a credentialed URL.
function safeLocation(value) {
  let url;
  try { url = new URL(value); } catch { fail(E.MEDIA_LOCATION_REFUSED, 'the transport location is not a URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) {
    fail(E.MEDIA_LOCATION_REFUSED, 'the transport location must be a public https URL without credentials');
  }
  return value;
}

/**
 * Resolves one asset for one provider and purpose. Returns a frozen object whose location (if any) is sealed.
 * @throws ActivationError(MEDIA_TRANSPORT_MISSING | MEDIA_LOCATION_REFUSED) / MediaTransportError(MEDIA_TRANSPORT_UNAVAILABLE)
 */
export async function resolveMediaTransport(mediaTransport, {
  assetRef, provider, purpose = 'MEDIA', asOf,
}) {
  if (!mediaTransport || typeof mediaTransport.resolve !== 'function') fail(E.MEDIA_TRANSPORT_MISSING, 'no media transport is configured (CONTROLLED_MEDIA_DELIVERY is an open dependency)');
  if (!PURPOSES.includes(purpose)) fail(E.INVALID_FIELD, 'purpose is not allowed', { field: 'purpose' });
  let raw;
  try {
    raw = await mediaTransport.resolve({ asset_ref: ref(assetRef, 'asset_ref'), provider, purpose });
  } catch (error) {
    if (error instanceof MediaTransportError && error.code === 'MEDIA_TRANSPORT_MISSING') fail(E.MEDIA_TRANSPORT_MISSING, 'the asset has no transport for this provider');
    throw new MediaTransportError('MEDIA_TRANSPORT_UNAVAILABLE');
  }
  if (!isPlainObject(raw)) fail(E.MEDIA_TRANSPORT_MISSING, 'the media transport returned nothing for this asset');
  const expiresAt = raw.expires_at == null ? null : iso(raw.expires_at, 'transport.expires_at');
  if (expiresAt && asOf && Date.parse(expiresAt) <= Date.parse(asOf)) fail(E.MEDIA_TRANSPORT_MISSING, 'the transport location has expired');
  if (purpose === 'TEXT') {
    if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 5000) fail(E.MEDIA_NOT_COMPATIBLE, 'the approved text asset has no usable text');
    return deepFreeze({ transport_mode: 'INLINE_TEXT', text: raw.text, content_type: 'text/plain' });
  }
  return deepFreeze({
    transport_mode: raw.transport_mode === 'PUBLIC_URL' || raw.transport_mode == null ? 'PUBLIC_URL' : fail(E.MEDIA_NOT_COMPATIBLE, 'unsupported transport mode'),
    ephemeral_location: seal(safeLocation(raw.ephemeral_location)),
    content_type: typeof raw.content_type === 'string' ? raw.content_type.toLowerCase() : null,
    byte_length: Number.isInteger(raw.byte_length) && raw.byte_length > 0 ? raw.byte_length : null,
    expires_at: expiresAt,
    domain_verified: raw.domain_verified === true,
  });
}

/** What may be logged or stored about a transport: never the location. */
export const describeMediaTransport = (transport) => deepFreeze({
  transport_mode: transport.transport_mode, content_type: transport.content_type ?? null, byte_length: transport.byte_length ?? null,
  expires_at: transport.expires_at ?? null, domain_verified: transport.domain_verified ?? false,
});
