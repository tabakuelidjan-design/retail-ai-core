// PRODUCT OBSERVER contract (provider-independent). China Sourcing must understand a product from SEVERAL signals, not only its name:
//
//   SIGNALS (product name, product photo, owner, supplier speech, documents, barcode/model data later)
//     -> ProductObserver.observe(input) -> { observations[], hypotheses[] }
//     -> ProductHypothesis (core/product-hypothesis.js): traits WITH provenance and confidence
//     -> applicability / needs / rules
//
// An observation is a PROPOSAL: { trait, value, confidence, source, provenance }. It becomes identity evidence at the PROBABLE level (a name or a category profile) or AI_SUGGESTED (an image model) and
// never above: the owner, the supplier and documents stay stronger (core/identity.js), and inference is never turned into fact. A category is ONE source of probable traits, not the ontology: a product
// may keep category = UNKNOWN while Nordla still knows batteryPresent / capacityRelevant / customisable...; an unknown product is never forced into the nearest category.
//
// Observers implemented here:
//   NAME  - real and deterministic (generic trait CUES + the bootstrap category keywords). No model, no network.
//   IMAGE - the contract is real, the provider is NOT: without an approved provider it answers PROVIDER_NOT_CONFIGURED (or NO_IMAGE). A photo is never uploaded from here. An approved adapter (for example
//           behind adapters/ai-provider.js, after the owner's consent) returns the same shape and is recorded with the same PRODUCT_OBSERVED event.
import { CATEGORIES, inferCategories } from './taxonomy.js';

export const OBSERVER_STATUS = Object.freeze({ OK: 'OK', NO_INPUT: 'NO_INPUT', NO_IMAGE: 'NO_IMAGE', PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED', ERROR: 'ERROR' });
export const OBSERVATION_SOURCE = Object.freeze({ PRODUCT_NAME: 'PRODUCT_NAME', IMAGE_OBSERVATION: 'IMAGE_OBSERVATION', OWNER: 'OWNER', SUPPLIER_SPEECH: 'SUPPLIER_SPEECH', DOCUMENT: 'DOCUMENT', BARCODE_MODEL_DATA: 'BARCODE_MODEL_DATA' });
const CONF = ['LOW', 'MEDIUM', 'HIGH'];

/**
 * GENERIC trait cues (DATA, not product names): a word that says something about a TRAIT, wherever it appears. The list is a bootstrap and is meant to grow; an unknown name simply yields no cue.
 * Each entry: { id, re, traits: [[trait, value, confidence]] }.
 */
export const TRAIT_CUES = Object.freeze([
  { id: 'capacity-rating', re: /\b\d[\d.,\s]*\s?(?:mah|wh)\b/i, traits: [['battery.present', true, 'HIGH'], ['electrical.present', true, 'HIGH'], ['capacity.relevant', true, 'HIGH']] },
  { id: 'battery-words', re: /\b(?:batter(?:y|ies)|rechargeable|lithium|li-?ion|li-?po|power ?bank|powerbank|batterie|accu|充电宝|电池)\b/i, traits: [['battery.present', true, 'MEDIUM'], ['electrical.present', true, 'MEDIUM'], ['capacity.relevant', true, 'MEDIUM']] },
  { id: 'radio-words', re: /\b(?:bluetooth|wi-?fi|wireless (?:speaker|earbuds?|headphones?|mouse|keyboard)|tws|nfc|zigbee|蓝牙)\b/i, traits: [['radio.present', true, 'MEDIUM'], ['electrical.present', true, 'MEDIUM']] },
  { id: 'powered-words', re: /\b(?:usb|charger|adapter|adaptor|led|lamp|light|speaker|headphones?|earbuds?|earphones?|chargeur|oplader)\b/i, traits: [['electrical.present', true, 'MEDIUM']] },
  { id: 'children-words', re: /\b(?:kids?|child(?:ren)?|baby|babies|toddler|infant|toys?|jouets?|speelgoed|enfants?|玩具|儿童)\b/i, traits: [['childrenUse', true, 'MEDIUM']] },
  { id: 'food-contact-words', re: /\b(?:food|bottle|flask|thermos|tumbler|mug|cup|lunch ?box|tableware|cutlery|bowl|plate|kitchenware|gourde|tasse|drinkfles|杯|水壶)\b/i, traits: [['foodContact', true, 'MEDIUM']] },
  { id: 'liquid-capacity-words', re: /\b(?:bottle|flask|thermos|tumbler|mug|cup|gourde|tasse|drinkfles|jug|jar|\d+\s?(?:ml|cl|l|oz))\b/i, traits: [['capacity.relevant', true, 'MEDIUM']] },
  { id: 'phone-fit-words', re: /\b(?:iphone|ipad|airpods|galaxy|pixel|samsung|xiaomi|huawei|oppo|oneplus|magsafe|macbook|apple watch)\b|\b(?:phone|mobile|smartphone|tablet|laptop)\s+(?:case|cover|holder|stand|sleeve|protector)\b|\b(?:case|cover|coque|hoesje|sleeve|screen protector)\b.*\b(?:phone|iphone|galaxy|pixel|samsung|ipad|airpods|tablet|laptop)\b/i, traits: [['compatibility.required', true, 'MEDIUM']] },
  { id: 'device-case', re: /\b(?:case|cover|coque|hoesje|sleeve|screen protector|protector)\b(?=.*\b(?:phone|iphone|galaxy|pixel|samsung|xiaomi|ipad|airpods|tablet|laptop|macbook)\b)|\b(?:phone|iphone|galaxy|pixel|samsung|xiaomi|ipad|airpods|tablet|laptop|macbook)\b.*\b(?:case|cover|coque|hoesje|sleeve|screen protector|protector)\b/i, traits: [['electrical.present', false, 'MEDIUM'], ['battery.present', false, 'MEDIUM'], ['radio.present', false, 'MEDIUM'], ['capacity.relevant', false, 'MEDIUM']] }, // a case/cover for a device is a passive accessory (a name that also says battery/charger contradicts this and the trait becomes unknown again)
  { id: 'custom-words', re: /\b(?:logo|custom(?:i[sz]ed|i[sz]able)?|personali[sz]ed|personnalis\w*|oem|odm|private label|sublimation|engraved|engraving)\b/i, traits: [['customisable', true, 'MEDIUM']] },
  { id: 'textile-words', re: /\b(?:t-?shirts?|shirts?|hoodies?|jackets?|dress(?:es)?|socks?|apparel|clothing|textile|fabric|cotton|vêtements?|kleding|服装)\b/i, traits: [['textile', true, 'MEDIUM']] },
  { id: 'cosmetic-words', re: /\b(?:cream|lotion|lipstick|shampoo|mascara|serum|perfume|cosmetics?|crème|cosmetica|面霜|化妆品)\b/i, traits: [['cosmetic', true, 'MEDIUM']] },
  { id: 'ppe-words', re: /\b(?:helmet|safety gloves?|goggles|respirator|face mask|hard hat)\b/i, traits: [['ppe', true, 'MEDIUM']] },
]);

const inputName = (i) => String(i?.name ?? '').trim();
const confMax = (a, b) => (CONF.indexOf(a) >= CONF.indexOf(b) ? a : b);

/** How reliable is a category match made of keywords only? A name never reaches HIGH. An ambiguous match (a tie with the runner-up) stays LOW. */
export function categoryConfidence(top, second) {
  if (!top) return 'LOW'; if (second && second.score >= top.score) return 'LOW';
  return top.matched.length >= 2 || top.matched.some((k) => k.length >= 8) ? 'MEDIUM' : 'LOW';
}

export const nameObserver = Object.freeze({
  id: 'name-cues', version: '1', source: OBSERVATION_SOURCE.PRODUCT_NAME, sync: true,
  /** @param {{ name?: string }} input @returns {{ status: string, observations: object[], hypotheses: object[] }} */
  observe(input) {
    const name = inputName(input); if (!name) return { status: OBSERVER_STATUS.NO_INPUT, observations: [], hypotheses: [] };
    const prov = (extra) => ({ observer: 'name-cues', version: '1', input: name, ...extra });
    const observations = []; const seen = new Map();
    const put = (trait, value, confidence, provenance) => { const k = `${trait}|${JSON.stringify(value)}`; if (seen.has(k)) { const o = seen.get(k); o.confidence = confMax(o.confidence, confidence); o.provenance.matched = [...new Set([...(o.provenance.matched ?? []), ...(provenance.matched ?? [])])]; return; } const o = { trait, value, confidence, source: OBSERVATION_SOURCE.PRODUCT_NAME, provenance }; seen.set(k, o); observations.push(o); };
    for (const cue of TRAIT_CUES) { const m = cue.re.exec(name); if (m) for (const [trait, value, confidence] of cue.traits) put(trait, value, confidence, prov({ via: 'trait-cue', cue: cue.id, matched: [m[0].trim()] })); }
    // the bootstrap categories: a HYPOTHESIS (never the ontology). Its profile traits are proposed only when the match is reliable enough, and never override a stronger source (they enter as PROBABLE).
    const ranked = inferCategories(name).slice(0, 3); const conf = categoryConfidence(ranked[0], ranked[1]);
    const hypotheses = ranked.map((r, i) => ({ category: r.categoryId, confidence: i === 0 ? conf : 'LOW', source: OBSERVATION_SOURCE.PRODUCT_NAME, evidence: r.matched.map((k) => `name contains "${k}"`), score: r.score, provenance: prov({ via: 'category-keywords', matched: r.matched }) }));
    if (ranked[0] && conf !== 'LOW') for (const [trait, value] of Object.entries(CATEGORIES[ranked[0].categoryId].traits)) put(trait, value, 'MEDIUM', prov({ via: 'category-hypothesis', category: ranked[0].categoryId, matched: ranked[0].matched, note: 'profile default of a probable category, not observed' }));
    return { status: OBSERVER_STATUS.OK, observations, hypotheses };
  },
});

export const imageObserver = Object.freeze({
  id: 'image', version: '0', source: OBSERVATION_SOURCE.IMAGE_OBSERVATION, sync: true,
  /** No image provider is approved or configured: the photo is kept as evidence of the case and nothing is interpreted. It is never sent anywhere from here. */
  observe(input) {
    if (!input?.imageRef) return { status: OBSERVER_STATUS.NO_IMAGE, observations: [], hypotheses: [] };
    return { status: OBSERVER_STATUS.PROVIDER_NOT_CONFIGURED, observations: [], hypotheses: [], note: 'No image-understanding provider is approved or configured: the photo is kept but not interpreted.' };
  },
});

export const DEFAULT_OBSERVERS = Object.freeze([nameObserver, imageObserver]);

/** Runs the synchronous observers. Returns one result per observer plus the merged proposals. Asynchronous adapters call `observe` themselves and record their result with the PRODUCT_OBSERVED event. */
export function observeProductSync(input, observers = DEFAULT_OBSERVERS) {
  const results = observers.filter((o) => o.sync).map((o) => { try { return { observer: o.id, version: o.version, source: o.source, ...o.observe(input) }; } catch (e) { return { observer: o.id, version: o.version, source: o.source, status: OBSERVER_STATUS.ERROR, observations: [], hypotheses: [], error: String(e?.message ?? e) }; } });
  return { results, observations: results.flatMap((r) => r.observations), hypotheses: results.flatMap((r) => r.hypotheses) };
}

/** A well-formed observation record from any provider (the shape a future adapter must return). Anything else is dropped, never repaired. */
export function sanitizeObservations(list, source) {
  return (Array.isArray(list) ? list : []).filter((o) => o && typeof o.trait === 'string' && o.trait && 'value' in o && CONF.includes(o.confidence)).map((o) => ({ trait: o.trait, value: o.value, confidence: o.confidence, source: o.source ?? source, provenance: o.provenance ?? {} }));
}
