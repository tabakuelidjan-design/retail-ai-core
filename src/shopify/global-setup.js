// The GLOBAL SHOPIFY_* setup (one shop for the whole deployment) is a historical path, not a merchant lookup: it reads no shop from Shopify. It may serve ONE merchant only, and only when that merchant
// is named explicitly by SHOPIFY_LEGACY_MERCHANT_ID. Every other merchant without its own OAuth connection gets "Shopify non connecte".
export const LEGACY_MERCHANT_ENV = 'SHOPIFY_LEGACY_MERCHANT_ID';

/** True only when the global setup is explicitly declared for THIS merchant. An empty or missing declaration never matches. */
/** Named so that it can never be mistaken for the removed lookup that chose a merchant from a Shopify shop: this only checks a declared merchant id. */
export function globalShopifySetupFor(env = process.env, merchantId = null) {
  const declared = String(env?.[LEGACY_MERCHANT_ENV] ?? '').trim().toLowerCase();
  const asked = String(merchantId ?? '').trim().toLowerCase();
  return declared !== '' && asked !== '' && declared === asked;
}
