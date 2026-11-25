// The Connection Center view of a Shopify connector provisioned by Nordla (per merchant). It is NOT a publishing-channel view: Shopify
// is a sales source, so the channel model (activation) does not apply. Only non-secret fields: the shop domain, scopes, status, times.
import { deepFreeze, sortedUnique } from './validation.js';

/** @param {{ id: string, status: string, config: object }} stored a connector row (merchant_connectors) */
export function shopifyConnectionView(stored, { runtime = {} } = {}) {
  const config = stored.config ?? {};
  return deepFreeze({
    provider: 'shopify',
    connector_id: stored.id,
    shop_domain: config.shop_domain ?? null,
    status: stored.status,
    granted_scopes: [...(runtime.granted_scopes ?? config.granted_scopes ?? [])],
    display_name: runtime.display_name ?? config.display_name ?? null,
    last_verified_at: runtime.last_verified_at ?? config.last_verified_at ?? null,
    review_signals: sortedUnique(runtime.signals ?? []),
  });
}
