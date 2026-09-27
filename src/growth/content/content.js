// Growth > Contenu - the content-quality engine. Pure and deterministic: product facts in, detected content problems out.
// It answers "what is missing or should be improved in the product content, and what first?" - not "which product to push"
// (Produits Potentiels) and not "what is happening" (Analytics). No score, no uplift, no generated content.
//
// Only fields that really exist in Nordla are checked (products: title, product_type, image_url, image_alt_text, source_status;
// variants: sku; product_collections). Description, customer reviews, several images, SEO title / meta and product attributes
// are NOT synced: they are reported as NOT_AVAILABLE capabilities, never as problems or as "correct".
//
// A check is only run when the merchant's data proves the field is synced (CAPABILITIES): Shopify writes image_url for every
// product once the image sync ran, but a null can also mean "never synced" - so the image checks run only when at least one of
// the merchant's products carries an image. Same for collections. An unverifiable check never turns a product "Correct".

export const CONTENT_VERSION = 'growth-content.1';
/** Checks run by this engine, in display order. `major` problems make a product "Prioritaire" on their own. */
export const CHECKS = [
  { code: 'noImage', major: true, capability: 'image' },
  { code: 'noAltText', major: false, capability: 'image' },
  { code: 'noType', major: false, capability: 'type' },
  { code: 'noCollection', major: false, capability: 'collections' },
  { code: 'missingSku', major: false, capability: 'sku' },
  { code: 'duplicateTitle', major: false, capability: 'title' },
];
/** Content dimensions that Nordla does not sync today: shown as "not available with the current data". */
export const NOT_AVAILABLE = ['description', 'reviews', 'multipleImages', 'seo', 'attributes'];
export const STATUSES = ['priority', 'improve', 'insufficient', 'correct'];
/** Prioritaire: a major problem, or at least this many problems at once. */
export const MANY_PROBLEMS = 3;
const STATUS_RANK = Object.fromEntries(STATUSES.map((s, i) => [s, i]));

const blank = (v) => v == null || String(v).trim() === '';
const normTitle = (t) => String(t ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * @param {{ products: object[], variants: object[], collections: object[], sales: Map<string, {units:number, netSales:number}>,
 *   window: object, currency: string }} p  products/variants/collections = loadDataset() rows of ONE merchant
 */
export function buildContent({ products, variants, collections, sales, window, currency }) {
  // Scope: products the source marks ACTIVE (drafts and archived products are not shown to customers). When the source never
  // gave a status (older sync), every product is analysed and the payload says so.
  const statusKnown = products.some((p) => p.source_status != null);
  const scope = statusKnown ? products.filter((p) => String(p.source_status).toUpperCase() === 'ACTIVE') : products;
  const variantsBy = new Map();
  for (const v of variants) (variantsBy.get(v.product_id) ?? variantsBy.set(v.product_id, []).get(v.product_id)).push(v);
  const inCollection = new Set(collections.filter((c) => c.is_current !== false).map((c) => c.product_id));
  const titleCount = new Map();
  for (const p of scope) titleCount.set(normTitle(p.title), (titleCount.get(normTitle(p.title)) ?? 0) + 1);

  const capabilities = {
    image: products.some((p) => !blank(p.image_url)), // proof that the image field is synced for this merchant
    type: true, // product_type is part of every catalog sync; an empty value is the source's own value
    collections: collections.length > 0, // proof that collection memberships are synced
    sku: variants.length > 0,
    title: true,
  };
  const checks = CHECKS.map((c) => ({ ...c, available: capabilities[c.capability] }));
  const active = checks.filter((c) => c.available);

  const rows = scope.map((p) => {
    const vs = variantsBy.get(p.id) ?? [];
    const hasImage = !blank(p.image_url);
    const found = [];
    const test = {
      noImage: () => !hasImage,
      noAltText: () => hasImage && blank(p.image_alt_text),
      noType: () => blank(p.product_type),
      noCollection: () => !inCollection.has(p.id),
      missingSku: () => vs.length > 0 && vs.some((v) => blank(v.sku)),
      duplicateTitle: () => !blank(p.title) && (titleCount.get(normTitle(p.title)) ?? 0) > 1,
    };
    for (const c of active) if (test[c.code]()) found.push(c.code);
    const facts = {
      variants: vs.length, variantsWithoutSku: vs.filter((v) => blank(v.sku)).length,
      sameTitle: (titleCount.get(normTitle(p.title)) ?? 1) - 1,
    };
    const major = found.some((code) => CHECKS.find((c) => c.code === code).major);
    const unverified = checks.filter((c) => !c.available).map((c) => c.code);
    // ---- status: explicit rules, first match wins ----
    let status; let rule;
    if (major) { status = 'priority'; rule = 'MAJOR_PROBLEM'; }
    else if (found.length >= MANY_PROBLEMS) { status = 'priority'; rule = 'MANY_PROBLEMS'; }
    else if (found.length) { status = 'improve'; rule = 'MINOR_PROBLEMS'; }
    else if (!capabilities.image) { status = 'insufficient'; rule = 'ESSENTIAL_CHECK_UNAVAILABLE'; } // the image cannot be verified
    else { status = 'correct'; rule = 'NO_DETECTABLE_PROBLEM'; }
    const s = sales.get(p.id) ?? { units: 0, netSales: 0 };
    return {
      id: p.id, title: p.title, imageUrl: hasImage ? p.image_url : null, category: blank(p.product_type) ? null : String(p.product_type).trim(),
      skus: vs.map((v) => v.sku).filter((x) => !blank(x)).slice(0, 3),
      status, rule, problems: found, facts, unverified,
      units: s.units, netSales: s.netSales,
    };
  });

  // Order: status, then commercial activity (sales help decide what to fix FIRST - they never change the problem itself),
  // then number of problems, then title (fully deterministic).
  rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.units - a.units || b.problems.length - a.problems.length
    || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)));

  const count = (fn) => rows.filter(fn).length;
  const byStatus = STATUSES.map((s) => ({ status: s, count: count((r) => r.status === s) }));
  const problems = active.map((c) => ({ code: c.code, count: count((r) => r.problems.includes(c.code)) }))
    .filter((x) => x.count > 0).sort((a, b) => b.count - a.count || CHECKS.findIndex((c) => c.code === a.code) - CHECKS.findIndex((c) => c.code === b.code));
  const kpi = (code) => (checks.find((c) => c.code === code).available ? count((r) => r.problems.includes(code)) : null);
  return {
    version: CONTENT_VERSION, currency, window,
    scope: { analysed: rows.length, catalog: products.length, activeOnly: statusKnown },
    capabilities, checks: checks.map(({ code, major, available }) => ({ code, major, available })), notAvailable: NOT_AVAILABLE,
    kpis: {
      toImprove: count((r) => r.status === 'priority' || r.status === 'improve'),
      noImage: kpi('noImage'), noAltText: kpi('noAltText'), noType: kpi('noType'), missingSku: kpi('missingSku'),
    },
    byStatus, problems: problems.slice(0, 5), rows,
    filters: {
      statuses: byStatus.filter((s) => s.count > 0).map((s) => s.status),
      problems: problems.map((p) => p.code),
      categories: [...new Set(rows.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      uncategorised: rows.some((r) => r.category == null),
    },
    thresholds: { manyProblems: MANY_PROBLEMS },
  };
}
