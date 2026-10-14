// PRODUCT / COPY CONSISTENCY. A deterministic compatibility gate between what the product IS (declared in the brief) and what the copy SAYS (the locked or adaptable request copy and the approved claims).
// It detects the obvious category contradiction ("protège ton téléphone" on a power bank, "20 000 mAh" on a phone case) and stops BEFORE anything is spent. It never rewrites a word.
//
// Limits, stated: the product category comes only from the DECLARED product (`public_facts.product`, `product_category`); an undeclared or unknown category is `CATEGORY_NOT_DECLARED` (a warning, never a pass of
// the content), and the gate looks only at the cues of the table below. It is a guard against the obvious, not a reader of meaning.

export const CATEGORY = Object.freeze({
  PHONE_CASE: 'PHONE_CASE', POWER_BANK: 'POWER_BANK', WATER_BOTTLE: 'WATER_BOTTLE', GIFT_BOX: 'GIFT_BOX', PHOTO_FRAME: 'PHOTO_FRAME',
});

// how a declared product is recognised (its description names it)
const PRODUCT_CUES = Object.freeze({
  [CATEGORY.PHONE_CASE]: /\bcoques?\b|\bphone ?case\b|\bhousses? (?:de |pour )?(?:t[ée]l[ée]phone|smartphone|portable)|\bcase\b/i,
  [CATEGORY.POWER_BANK]: /power ?bank|batteries? externes?|chargeur(?:s)? portables?|\bmah\b/i,
  [CATEGORY.WATER_BOTTLE]: /\bgourdes?\b|\bbouteilles?\b|\bwater ?bottle\b|\btumbler\b/i,
  [CATEGORY.GIFT_BOX]: /bo[iî]tes? cadeaux?|\bgift ?box\b|\bcoffrets?\b/i,
  [CATEGORY.PHOTO_FRAME]: /\bcadres?\b|\bplaques? photo\b|\bphoto ?frame\b/i,
});

// what copy says that only fits one category: an ATTRIBUTE of the product ("protège ton téléphone", "20 000 mAh") or the product named as THE product of the visual ("votre coque", "cette gourde").
// A bare mention of another product of the shop ("HABB propose aussi des gourdes") is a cross-sell, not a contradiction, and is not matched.
const THE = '(?:votre|vos|ton|ta|tes|notre|nos|cette|cet|ce|la|le|sa|son)';
export const COPY_CUES = Object.freeze({
  [CATEGORY.PHONE_CASE]: new RegExp(String.raw`prot[èe]ge(?:r|z)?\s+(?:ton|votre|son|ta|vos)\s+(?:t[ée]l[ée]phone|smartphone|portable|iphone|galaxy)|\b${THE}\s+coques?\b|\b(?:iphone|galaxy|pixel)\b|\bphone ?case\b|\b[ée]tui\b`, 'i'),
  [CATEGORY.POWER_BANK]: /\bmah\b|\bpower ?bank\b|batteries? externes?|\bautonomie\b|\brecharg(?:e|er|ez)\b|charge rapide/i,
  [CATEGORY.WATER_BOTTLE]: new RegExp(String.raw`\b${THE}\s+(?:gourdes?|bouteilles?)\b|\bisotherme\b|\bhydrat`, 'i'),
  [CATEGORY.GIFT_BOX]: new RegExp(String.raw`\b${THE}\s+(?:bo[iî]tes? cadeaux?|coffrets?)\b`, 'i'),
  [CATEGORY.PHOTO_FRAME]: new RegExp(String.raw`\b${THE}\s+(?:cadres?|plaques? photo)\b`, 'i'),
});

const text = (v) => String(v ?? '');

/** The category named by the declared product, or null (also null when the description names two). */
export function categoryOfProduct(brief) {
  if (brief?.product_category && CATEGORY[brief.product_category]) return brief.product_category;
  const description = text(brief?.public_facts?.product);
  const hits = Object.entries(PRODUCT_CUES).filter(([, re]) => re.test(description)).map(([k]) => k);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * @param {object} input { brief, request } — the texts are the request copy (locked and adaptable) and the claims / approved copy of the brief
 * @returns {{ status: 'CONSISTENT'|'CONFLICT'|'CATEGORY_NOT_DECLARED', product_category: string|null, findings: object[] }}
 */
export function checkProductCopyConsistency({ brief, request }) {
  const category = categoryOfProduct(brief);
  const units = [
    ...(request?.copy ?? []).map((c) => ({ source: `request.copy:${c.copy_ref ?? '?'}`, text: text(c.text ?? c.content) })),
    ...(brief?.claims ?? []).map((c) => ({ source: `brief.claims:${c.ref ?? '?'}`, text: text(c.wording) })),
    ...(brief?.approved_copy ?? []).map((c) => ({ source: `brief.approved_copy:${c.ref ?? '?'}`, text: text(c.content) })),
  ];
  if (!category) return { status: 'CATEGORY_NOT_DECLARED', product_category: null, findings: [] };
  const findings = [];
  for (const unit of units) {
    for (const [other, re] of Object.entries(COPY_CUES)) {
      if (other === category) continue;
      const m = unit.text.match(re);
      if (m) findings.push({ code: 'PRODUCT_COPY_CONFLICT', source: unit.source, product_category: category, copy_says: other, evidence: m[0] });
    }
  }
  return { status: findings.length ? 'CONFLICT' : 'CONSISTENT', product_category: category, findings };
}
