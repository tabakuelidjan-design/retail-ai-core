// Deterministic checks of an editorial proposal (a campaign handoff) against HABB facts. It does NOT judge taste: it refuses what is provably
// wrong (a price that is not the catalogue price, a forbidden decorative motif, a missing real product, a wrong count, an unapproved claim
// presented as approved).

import { AssetLibraryError, LIBRARY_ERROR as E } from './constants.js';
import { ITEM_KIND, validateCampaignHandoff } from './contract.js';

const FORBIDDEN_MOTIF = /\b(c[œo]eurs?|feuilles?|branch(?:e|es|age)|feuillage|dor[ée]e?s?|glow|paillett\w+|brillants?)\b/i;
const PRICE = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur\b)/gi;
// Facts this proposal may not assert without a recorded approval (see docs/chantier-d/ETAT-REEL.md)
const UNVERIFIED_FACT = /\b(ouvert\s+(?:7|tous)|livraison\s+gratuite|garantie|meilleur\s+prix|(?:le\s+)?moins\s+cher|-\s?\d+\s?%|promo(?:tion)?)\b/i;

export const DEFAULT_COUNTS = Object.freeze({ posts: 8, stories: 14, reels: 3 });

/**
 * @param plan campaign handoff
 * @param opts.catalogue Map product_ref -> { title, price_eur } read from Shopify (never typed by hand)
 * @param opts.counts expected counts; reels may be fewer when footage is missing, if `reels_blocked_reason` is given
 */
export function checkEditorialPlan(plan, { catalogue, counts = DEFAULT_COUNTS, reelsBlockedReason = null } = {}) {
  validateCampaignHandoff(plan);
  const problems = [];
  const n = { posts: 0, stories: 0, reels: 0 };
  for (const it of plan.items) {
    if (it.kind === ITEM_KIND.POST) n.posts += 1;
    else if (it.kind === ITEM_KIND.STORY) n.stories += 1;
    else n.reels += 1;
    const where = it.item_id;
    const product = catalogue.get(it.product_ref);
    if (!product) problems.push({ item: where, code: 'PRODUCT_NOT_IN_CATALOGUE', detail: it.product_ref });
    const prose = `${it.hook}\n${it.caption ?? ''}\n${it.claims.map((c) => c.text).join('\n')}`;
    for (const m of prose.matchAll(PRICE)) {
      const amount = Number(m[1].replace(',', '.'));
      if (product && Math.abs(amount - product.price_eur) > 1e-9) problems.push({ item: where, code: 'PRICE_MISMATCH', detail: `${m[0].trim()} vs ${product.price_eur}` });
    }
    const motif = it.concept.match(FORBIDDEN_MOTIF);
    if (motif && !(product && FORBIDDEN_MOTIF.test(product.title))) problems.push({ item: where, code: 'FORBIDDEN_DECORATIVE_MOTIF', detail: motif[0] });
    if (UNVERIFIED_FACT.test(prose)) problems.push({ item: where, code: 'UNVERIFIED_COMMERCIAL_CLAIM', detail: prose.match(UNVERIFIED_FACT)[0] });
    for (const c of it.claims) if (!c.claim_ref && it.validation_status === 'APPROVED') problems.push({ item: where, code: 'APPROVED_WITH_UNAPPROVED_CLAIM', detail: c.text });
  }
  if (n.posts !== counts.posts) problems.push({ item: '*', code: 'WRONG_COUNT_POSTS', detail: `${n.posts}/${counts.posts}` });
  if (n.stories !== counts.stories) problems.push({ item: '*', code: 'WRONG_COUNT_STORIES', detail: `${n.stories}/${counts.stories}` });
  if (n.reels !== counts.reels && !(reelsBlockedReason && n.reels < counts.reels)) problems.push({ item: '*', code: 'WRONG_COUNT_REELS', detail: `${n.reels}/${counts.reels}` });
  return { ok: problems.length === 0, counts: n, problems };
}

export function assertEditorialPlan(plan, opts) {
  const r = checkEditorialPlan(plan, opts);
  if (!r.ok) throw new AssetLibraryError(E.INVALID_CONTRACT, 'editorial plan rejected', { problems: r.problems });
  return r;
}
