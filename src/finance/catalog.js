// Product picker for invoice / quote lines. Retail Core (Shopify-synced) stays the ONLY product catalogue: this module reads it and
// prepares a line; it never stores products, never writes to Retail Core and never writes to Shopify.
//
//   search(q)        -> matching product/variant rows (names, variant names, SKU) with their canonical Retail Core ids
//   select(variantId) -> the line to prefill: description, SKU, current selling price (read from Shopify, read-only),
//                        canonical ids, and a VAT rate ONLY when every past sale of that variant used the same configured rate.
//
// The chosen product data is then COPIED onto the document line (description, SKU, price, ids, price snapshot). Later changes or
// deletions in the catalogue never touch an existing document: nothing here is consulted when a document is read, edited or issued.

import { computeTotals, normalizeLine } from './document.js';
import { BP, divRound, formatCents, fromScaled, toPriceMicro } from './money.js';

const label = (r) => (r.variantTitle ? `${r.productTitle} - ${r.variantTitle}` : r.productTitle);
export const LOW_STOCK_AT = 3;
const stockOf = (q) => ({ qty: q, state: q == null ? 'unknown' : q <= 0 ? 'out' : q <= LOW_STOCK_AT ? 'low' : 'ok' });
const exVatMicro = (micro, bp) => Number(divRound(BigInt(micro) * BP, BP + BigInt(bp)));
const toCentsSafe = (v) => { const m = toPriceMicro(v); return m === null ? null : Math.round(m / 100); };

/** What the merchant sees for the catalogue price: as published in the shop, and whether it includes VAT. */
const priceView = (p) => (p ? { amount: String(p.amount), taxesIncluded: p.taxesIncluded === true } : null);
const publicRow = (r, price) => ({
  productId: r.productId, variantId: r.variantId, name: label(r), productTitle: r.productTitle, variantTitle: r.variantTitle, sku: r.sku,
  status: r.status, archived: !!r.status && r.status !== 'ACTIVE', stock: stockOf(r.stock), price: priceView(price), imageUrl: price?.imageUrl ?? null,
});

/**
 * @param {{retail: {searchCatalog: Function, getCatalogVariant: Function}, priceSource?: (variantSourceIds: string[]) => Promise<Record<string, {amount: string, taxesIncluded: boolean, imageUrl?: string}>>, now?: () => string}} deps
 * priceSource is READ-ONLY (a Shopify query, batched); when it is missing or fails, price and picture are simply left out.
 */
export function createCatalogPicker({ retail, priceSource = null, now = () => new Date().toISOString() }) {
  const prices = async (ids) => {
    if (!priceSource || !ids.length) return {};
    try { return (await priceSource(ids)) ?? {}; } catch { return {}; }
  };
  return {
    async search(q) {
      const rows = await retail.searchCatalog(q, 20);
      const p = await prices(rows.map((r) => r.variantSourceId).filter(Boolean));
      return rows.map((r) => publicRow(r, p[r.variantSourceId] ?? null));
    },

    /** @returns {Promise<{found: boolean, line?: object, notes?: string[]}>} */
    async select(variantId, { allowedRatesBp = [] } = {}) {
      const r = await retail.getCatalogVariant(variantId);
      if (!r) return { found: false };
      const notes = [];
      const price = r.variantSourceId ? (await prices([r.variantSourceId]))[r.variantSourceId] ?? null : null;
      // VAT only when it is safely known: every past sale used one rate AND that rate is configured for this seller
      const vatBp = r.vatRateBp != null && allowedRatesBp.includes(r.vatRateBp) ? r.vatRateBp : null;

      let unitPrice = '';
      let snapshot = null;
      let check = null;
      let gross = null; // set when the catalogue price incl. VAT is kept as the authoritative amount (PRICE_ORIGIN = GROSS_CATALOGUE)
      if (!price) notes.push('Current price could not be read: type the unit price yourself.');
      else {
        const micro = toPriceMicro(price.amount);
        if (micro === null) notes.push('Current price could not be read: type the unit price yourself.');
        else if (!price.taxesIncluded) { unitPrice = fromScaled(micro, 4); snapshot = { amount: String(price.amount), taxesIncluded: false, at: now() }; }
        else if (vatBp != null) {
          // the shop price incl. VAT stays authoritative: the engine derives the ex-VAT price at full precision and rounds only once
          gross = { priceOrigin: 'GROSS_CATALOGUE', grossUnitPrice: fromScaled(micro, 4), grossVatRate: String(vatBp / 100) };
          snapshot = { amount: String(price.amount), taxesIncluded: true, at: now() };
        }
      }
      if (vatBp == null) notes.push(price && price.taxesIncluded ? `VAT rate: not set automatically (no consistent sales history for this product). The catalogue price is ${price.amount} including VAT and will be kept once you choose the rate.` : 'VAT rate: not set automatically (no consistent sales history for this product). Choose it yourself.');
      // what the deterministic finance engine makes of one unit (never the browser)
      const probe = gross ? { ...gross, description: 'x', quantity: '1', vatRate: String(vatBp / 100) } : unitPrice !== '' && vatBp != null ? { description: 'x', quantity: '1', unitPrice, vatRate: String(vatBp / 100) } : null;
      if (probe) {
        const n = normalizeLine(probe, 1);
        if (!n.errors.length) {
          const t = computeTotals([n.line]);
          if (gross) unitPrice = fromScaled(n.line.priceMicro, 4); // derived ex-VAT price for display; the gross price stays the source of truth
          check = { net: formatCents(t.netCents), vat: formatCents(t.vatCents), gross: formatCents(t.grossCents), rounding: formatCents(t.roundingCents), payable: formatCents(t.grossCents + t.roundingCents), roundingCents: t.roundingCents, matchesCatalogue: price.taxesIncluded ? t.grossCents + t.roundingCents === toCentsSafe(price.amount) : null };
        }
      }
      return {
        found: true, notes, archived: !!r.status && r.status !== 'ACTIVE', stock: stockOf(r.stock), imageUrl: price?.imageUrl ?? null,
        catalogue: price ? { priceInclVat: price.taxesIncluded ? String(price.amount) : null, priceExclVat: unitPrice || null, taxesIncluded: price.taxesIncluded === true, check } : null,
        line: {
          description: label(r), sku: r.sku ?? '', quantity: '1', unit: '', unitPrice, vatRate: vatBp != null ? String(vatBp / 100) : '', ...(gross ?? { priceOrigin: 'NET_MANUAL' }),
          catalog: { source: 'retail_core', productId: r.productId, variantId: r.variantId, productTitle: r.productTitle, variantTitle: r.variantTitle, sku: r.sku, ...(snapshot ? { priceSnapshot: snapshot } : {}) },
        },
      };
    },
  };
}

/** Read-only Shopify lookup (a GraphQL query, batched): price and a small picture per variant. It can never modify a product or a price. */
export function createShopifyPriceSource(shopify) {
  const QUERY = 'query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id price image { url(transform:{maxWidth:96,maxHeight:96}) } product { featuredImage { url(transform:{maxWidth:96,maxHeight:96}) } } } } shop{ taxesIncluded } }';
  return async (variantSourceIds) => {
    const ids = [...new Set(variantSourceIds)].slice(0, 50);
    const r = await shopify.graphql(QUERY, { ids });
    const out = {};
    for (const node of r?.nodes ?? []) {
      if (!node?.id || !node.price) continue;
      out[node.id] = { amount: String(node.price), taxesIncluded: r.shop?.taxesIncluded === true, imageUrl: node.image?.url ?? node.product?.featuredImage?.url ?? null };
    }
    return out;
  };
}
