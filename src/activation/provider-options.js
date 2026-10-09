// Provider options are CLOSED schemas per provider: a raw `provider_options` object is never forwarded to a provider.
// Only fields the current official documentation defines, and only values the approved order carries, can pass.

import { ACT_ERROR as E, CHANNEL_PROVIDER as P } from './constants.js';
import { fail } from './validation.js';
import { normalizeInstagramOptions } from './providers/instagram.js';
import { normalizeTikTokOptions } from './providers/tiktok.js';
import { normalizeGoogleBusinessOptions } from './providers/google-business-profile.js';

const NORMALIZERS = {
  [P.INSTAGRAM]: normalizeInstagramOptions,
  [P.TIKTOK]: normalizeTikTokOptions,
  [P.GOOGLE_BUSINESS_PROFILE]: normalizeGoogleBusinessOptions,
};

export function normalizeProviderOptions(provider, options) {
  const normalize = NORMALIZERS[provider];
  if (!normalize) fail(E.CONNECTOR_KIND_UNSUPPORTED, 'this provider has no option schema');
  return normalize(options ?? {});
}

/** The asset refs an options object points at (captions, titles, CTA urls...): all of them must belong to the approved content. */
export function optionAssetRefs(options) {
  return Object.entries(options).filter(([key, value]) => key.endsWith('_asset_ref') && typeof value === 'string').map(([, value]) => value);
}
