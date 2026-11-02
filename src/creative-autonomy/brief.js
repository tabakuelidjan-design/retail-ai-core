// THE AUTONOMOUS BRIEF. The owner gives four things: a Shopify product, a commercial objective, the tenant's brand (its creative profile) and a format. Nordla builds the
// Creative Brain's brief from them WITHOUT a human writing any copy, concept or position: only VERIFIED facts become claims (price and stock come from
// the Shopify snapshot, a personalisation promise only from the product's own type/tags/description), everything else is left to the Brain or marked UNKNOWN.
import { createHash } from 'node:crypto';
import { brandBriefFacts, commercialBrief } from './brand-guard.js';
import { resolveBrandProfile } from './brand-profile.js';

export const FORMATS = Object.freeze({
  INSTAGRAM_FEED_4_5: { ref: 'format://instagram/feed-1080x1350', canvas: { width: 1080, height: 1350 }, medium: 'DIGITAL', aspect_ratio: '4:5' },
  INSTAGRAM_STORY_9_16: { ref: 'format://instagram/story-1080x1920', canvas: { width: 1080, height: 1920 }, medium: 'DIGITAL', aspect_ratio: '9:16' },
  WEB_BANNER_16_9: { ref: 'format://web/banner-1920x1080', canvas: { width: 1920, height: 1080 }, medium: 'DIGITAL', aspect_ratio: '16:9' },
});

const sha = (b) => createHash('sha256').update(b).digest('hex');
const euro = (amount) => `${Number(amount).toFixed(2).replace('.', ',')} €`;
const PERSONALISATION = /(personnalis|graver|gravure|imprim[ée]e? avec (?:votre|ta|vos)|vos images|votre texte|vos initiales|votre nom)/i;

/** Facts Nordla may state, each with its source. A fact that is not in the snapshot does not exist. */
export function verifiedFacts({ product, variantTitle = null, readAt }) {
  const variants = product.variants?.nodes ?? [];
  const variant = variantTitle ? variants.find((v) => v.title === variantTitle) : variants[0];
  if (!variant) throw new Error(`variant not found in the Shopify snapshot: ${variantTitle}`);
  const personalisation = PERSONALISATION.test(product.description ?? '') || (product.tags ?? []).some((t) => /personnalis/i.test(t)) || /personnalis/i.test(product.productType ?? '');
  return Object.freeze({
    product_title: product.title,
    variant: variant.title === 'Default Title' ? null : variant.title,
    price: euro(variant.price),
    in_stock: variant.inventoryQuantity > 0,
    description: product.description,
    personalisation_offered: personalisation,
    // the colours that EXIST in the snapshot (variant titles), never an invented one; stock is not claimed as in-store availability
    colours_available: variants.map((v) => v.title).filter((t) => t && t !== 'Default Title'),
    personalisation_evidence: personalisation ? 'type, tags or description of the Shopify product' : 'nothing in the Shopify product states a personalisation',
    source: { system: 'shopify', product_id: product.id, variant_id: variant.id, read_at: readAt, status: product.status },
  });
}

/**
 * The Brain brief. owner input: { product (Shopify snapshot), variantTitle?, objective, audience?, occasion?, brand, format (key of FORMATS), photo: { bytes, media_type, width_px, height_px, origin, rights_class }, merchant }
 * Returns { brief, facts }.
 */
export function buildAutonomousBrief({ product, variantTitle = null, readAt, objective, audience = null, occasion = null, brand, format, photo, merchant = null }) {
  const profile = resolveBrandProfile(brand);
  merchant = merchant ?? profile.merchant_display; // the ACTIVE tenant's name, never another merchant's
  if (!FORMATS[format]) throw new Error(`unknown format ${format}`);
  if (!objective) throw new Error('a commercial objective is required');
  const facts = verifiedFacts({ product, variantTitle, readAt });
  const productRef = `product://shopify/${product.id.split('/').pop()}${facts.variant ? `/${facts.variant}` : ''}`;
  const describe = [facts.product_title, facts.variant ? `coloris ${facts.variant}` : null].filter(Boolean).join(', ');
  const brief = {
    ids: { merchant_id: brand.merchant_id, brand_id: brand.brand_id, brief_ref: `brief:autonomy/${sha(JSON.stringify([productRef, objective, format])).slice(0, 12)}`, product_ref: productRef },
    public_facts: {
      product: `${describe}. ${facts.description}`,
      ...(merchant ? { merchant } : {}),
      objective,
      ...(audience ? { audience } : {}),
      ...(occasion ? { occasion } : {}),
      personalisation: facts.personalisation_offered ? 'offerte pour ce produit (fiche Shopify)' : 'NON offerte pour ce produit : aucune promesse de personnalisation',
      // who the merchant is and what it never shows or claims (its creative profile), given to the Brain from the FRAME on
      ...(brand.expression ? brandBriefFacts(brand, profile) : {}),
      // what Nordla may build the reason to come on, and what the concept must achieve: from verified facts only (see commercialBrief)
      ...(brand.expression ? commercialBrief(facts, { ...profile, merchant_display: merchant }) : {}),
    },
    approved_copy: [],
    claims: [{ ref: `claim://shopify/price/${facts.source.variant_id.split('/').pop()}`, role: 'PRICE', wording: facts.price }],
    format: { ...FORMATS[format], safe_zones: [], forbidden_zones: [], locale: profile.locale ?? 'fr-BE' },
    brand: brand.expression ? { expression: brand.expression, colors: brand.colors } : brand,
    asset: { ref: `asset://shopify/${product.id.split('/').pop()}/${sha(photo.bytes).slice(0, 12)}`, bytes: photo.bytes, media_type: photo.media_type, width_px: photo.width_px, height_px: photo.height_px, origin: photo.origin, sha256: sha(photo.bytes), rights_class: photo.rights_class, privacy_class: 'BUSINESS' },
  };
  return { brief, facts };
}

