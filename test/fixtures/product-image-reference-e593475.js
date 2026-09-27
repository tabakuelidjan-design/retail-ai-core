// TEST ORACLE ONLY - never imported by src/. The product-image lines of normalizeProduct exactly as the historical Analytics-branch
// sync variant had them (e593475, src/sync/normalize.js), so the canonical Core sync can be compared with what that variant wrote.
export function referenceProductImage(node) {
  return {
    // The product's real primary image from Shopify, if it has one. Null stays null - never
    // substituted with another product's image or a generic placeholder.
    image_url: node.featuredImage?.url ?? null,
    image_alt_text: node.featuredImage?.altText ?? null,
  };
}
