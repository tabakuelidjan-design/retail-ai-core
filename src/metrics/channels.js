// Sales-channel semantics shared by the engines that classify an order's channel (customers, marketing, Growth).
// Sources spell the same channel differently: Shopify's in-store app is reported as `pos` by some fields and as
// `point_of_sale` by the order's channel definition handle. Both mean "sold in the physical store", so they are compared
// in one normalized form. The merchant's configured lists (config.marketing.posChannelHandles / onlineChannelHandles)
// keep their meaning and are normalized the same way; only spellings with an IDENTICAL business meaning are aliased here.

/** Spelling -> canonical handle. Add a pair only when the two handles are provably the same channel. */
export const CHANNEL_ALIASES = Object.freeze({ point_of_sale: 'pos' });

/** Lower-case, trimmed, '-' / ' ' as '_', then the canonical alias. null for an empty handle. */
export function normalizeChannelHandle(handle) {
  if (handle == null) return null;
  const h = String(handle).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!h) return null;
  return CHANNEL_ALIASES[h] ?? h;
}

const inList = (handle, list) => {
  const h = normalizeChannelHandle(handle);
  return h != null && (list ?? []).some((x) => normalizeChannelHandle(x) === h);
};
/** In-store (point of sale) channel, whatever the spelling. */
export const isPosChannel = (handle, config) => inList(handle, config.marketing.posChannelHandles);
/** Online store channel, whatever the spelling. */
export const isOnlineChannel = (handle, config) => inList(handle, config.marketing.onlineChannelHandles);
