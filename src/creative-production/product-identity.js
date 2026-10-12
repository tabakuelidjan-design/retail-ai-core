import { createHash } from 'node:crypto';

import { substituteWordsIn } from '../creative-brain/substitutes.js';
import { deepFreeze, deriveId, wordsOf } from '../creative-brain/validation.js';
import { PRODUCT_REASON, PRODUCT_STATUS, SCHEMA } from './constants.js';

// PRODUCT IDENTITY. The real product is a pinned asset (its reference, its photograph, the hash of its bytes); everything else in a scene is something else. This module answers two questions before any
// layer is specified:
//   1. Is the product known well enough to be placed? VERIFIED, or an explicit AMBIGUOUS / MISSING / UNSUPPORTED with the reasons: never a guess and never a replacement.
//   2. Does a text that would feed a generator (a prop, a plate) name or describe the product, a look-alike of it, or an unfinished version of it? A generated layer must never be able to stand in for the
//      requested product: Attempt 12 asked for "a bare polymer shell resting on a worn wooden counter, half its surface still untouched", the generator drew exactly such a hero object, and the lexicon of the
//      time did not know the word. The detection is therefore RELATIVE to the product (the family of object it belongs to), not only a list of words.
//
// The product families are neutral vertical data (a family of objects, in English, French and Dutch), opt-in by the words of the product description; no merchant is named here.

export const PRODUCT_FAMILIES = Object.freeze({
  PROTECTIVE_CASE: Object.freeze({
    triggers: ['case', 'coque', 'cover', 'étui', 'hoesje', 'housing', 'shell', 'boîtier', 'phone', 'téléphone', 'smartphone'],
    words: ['case', 'coque', 'cover', 'étui', 'hoesje', 'hoes', 'housing', 'shell', 'casing', 'sleeve', 'bumper', 'protector', 'blank', 'polymer', 'silicone', 'plastic', 'plastique', 'phone', 'smartphone', 'téléphone', 'device', 'handset'],
  }),
  DRINKWARE: Object.freeze({
    triggers: ['gourde', 'bottle', 'bouteille', 'tumbler', 'mug', 'tasse', 'flask', 'thermos', 'cup', 'fles', 'beker'],
    words: ['bottle', 'flask', 'tumbler', 'mug', 'cup', 'gourde', 'bouteille', 'thermos', 'straw', 'lid', 'paille', 'couvercle', 'tasse', 'fles', 'beker', 'canteen', 'jug'],
  }),
  FRAMED_PRINT: Object.freeze({
    triggers: ['cadre', 'frame', 'plaque', 'tile', 'puzzle', 'poster', 'canvas', 'lijst', 'tegel'],
    words: ['frame', 'cadre', 'tile', 'plaque', 'puzzle', 'canvas', 'poster', 'lijst', 'tegel', 'mount', 'passe-partout'],
  }),
  GIFT_BOX: Object.freeze({
    triggers: ['box', 'boîte', 'coffret', 'doos', 'hamper'],
    words: ['box', 'boîte', 'coffret', 'crate', 'doos', 'hamper', 'casket', 'carton'],
  }),
});

const STOP = new Set(['pour', 'avec', 'for', 'with', 'voor', 'met', 'the', 'les', 'des', 'une', 'de', 'du', 'la', 'le', 'un', 'et', 'and', 'en', 'van', 'het', 'een']);
const clean = (v) => (typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '');
// a word and its plural forms: "gourdes" is "gourde" and "cups" is "cup"
const forms = (w) => [w, w.replace(/s$/u, ''), w.replace(/es$/u, '')];

/** The families a product description belongs to (by its words). */
export function familiesOf(description) {
  const tokens = new Set(wordsOf(description).flatMap(forms));
  return Object.entries(PRODUCT_FAMILIES).filter(([, f]) => f.triggers.some((t) => tokens.has(t))).map(([id]) => id);
}

/** The words that name the product itself: the first significant words of its description. */
export function productNameWords(description) {
  return wordsOf(clean(description)).filter((w) => !STOP.has(w) && w.length >= 4).slice(0, 3);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {object} input { brief, bytes?, campaignProductRef? }
 * @returns the frozen identity: { identity_id, status, reasons, product_ref, asset_ref, sha256, family, description, protected_region_count, rights_class, privacy_class }
 */
export function resolveProductIdentity({ brief, bytes = null, campaignProductRef = null }) {
  const reasons = [];
  const productRef = clean(brief?.ids?.product_ref);
  const assetRef = clean(brief?.asset?.ref);
  const description = clean(brief?.public_facts?.product);
  const pinned = clean(brief?.asset?.sha256);
  let status = PRODUCT_STATUS.VERIFIED;
  const raise = (s, reason) => {
    reasons.push(reason);
    const rank = [PRODUCT_STATUS.VERIFIED, PRODUCT_STATUS.UNSUPPORTED, PRODUCT_STATUS.AMBIGUOUS, PRODUCT_STATUS.MISSING];
    if (rank.indexOf(s) > rank.indexOf(status)) status = s;
  };
  if (!productRef) raise(PRODUCT_STATUS.MISSING, PRODUCT_REASON.NO_PRODUCT_REFERENCE);
  if (!assetRef) raise(PRODUCT_STATUS.MISSING, PRODUCT_REASON.NO_PRODUCT_ASSET);
  if (description.length < 2) raise(PRODUCT_STATUS.AMBIGUOUS, PRODUCT_REASON.PRODUCT_NOT_DESCRIBED);
  if (!pinned) raise(PRODUCT_STATUS.AMBIGUOUS, PRODUCT_REASON.ASSET_NOT_PINNED);
  if (pinned && bytes && sha256(bytes) !== pinned) raise(PRODUCT_STATUS.AMBIGUOUS, PRODUCT_REASON.ASSET_BYTES_DO_NOT_MATCH_THE_PINNED_HASH);
  const families = familiesOf(description);
  if (families.length > 1) raise(PRODUCT_STATUS.AMBIGUOUS, PRODUCT_REASON.PRODUCT_DESCRIPTION_MATCHES_SEVERAL_FAMILIES);
  if (campaignProductRef && productRef && clean(campaignProductRef) !== productRef) raise(PRODUCT_STATUS.AMBIGUOUS, PRODUCT_REASON.CAMPAIGN_NAMES_ANOTHER_PRODUCT);
  const outline = brief?.identity_annotations?.outline;
  if (!Array.isArray(outline) || outline.length < 3) raise(PRODUCT_STATUS.UNSUPPORTED, PRODUCT_REASON.NO_OUTLINE_FOR_LOCAL_SEGMENTATION);
  const body = {
    schema: SCHEMA.identity,
    status,
    reasons,
    product_ref: productRef || null,
    asset_ref: assetRef || null,
    sha256: pinned || null,
    family: families.length === 1 ? families[0] : null,
    description,
    protected_region_count: (brief?.identity_annotations?.text_regions?.length ?? 0) + (brief?.identity_annotations?.artwork_region ? 1 : 0),
    rights_class: brief?.asset?.rights_class ?? null,
    privacy_class: brief?.asset?.privacy_class ?? null,
  };
  return deepFreeze({ identity_id: deriveId('pid', body), ...body });
}

const wholeWordsIn = (text, list) => {
  const words = new Set(wordsOf(text).flatMap(forms));
  return list.filter((w) => words.has(w));
};

/**
 * What in a text could make a generator draw the requested product, a look-alike of it or an unfinished version of it. Empty means nothing was found; it is never a proof of safety, only the absence of a
 * known way in.
 * @returns {{ kind: 'LEXICON'|'FAMILY'|'PRODUCT_NAME', words: string[] }[]}
 */
export function detectSubstitutes({ text, identity }) {
  const hits = [];
  const lexicon = substituteWordsIn(text);
  if (lexicon.length) hits.push({ kind: 'LEXICON', words: lexicon });
  const family = identity?.family ? PRODUCT_FAMILIES[identity.family] : null;
  const families = identity?.family ? [family] : familiesOf(identity?.description ?? '').map((id) => PRODUCT_FAMILIES[id]);
  const familyWords = [...new Set(families.flatMap((f) => wholeWordsIn(text, f.words)))].filter((w) => !lexicon.includes(w));
  if (familyWords.length) hits.push({ kind: 'FAMILY', words: familyWords });
  const names = wholeWordsIn(text, productNameWords(identity?.description ?? '')).filter((w) => !lexicon.includes(w) && !familyWords.includes(w));
  if (names.length) hits.push({ kind: 'PRODUCT_NAME', words: names });
  return hits;
}

export const isSafeText = (text, identity) => detectSubstitutes({ text, identity }).length === 0;
