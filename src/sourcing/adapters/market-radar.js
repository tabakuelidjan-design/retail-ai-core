// MARKET RADAR analysis (pure, no network): case input -> queries; listing -> honest match class; anomalies, packs, accessories and different capacities are FLAGGED and kept apart from the reference range, never silently removed;
// supplier price vs what was observed, converted at a dated ECB rate. Observed market signals only: not a margin, not a purchase decision, not proof of legal marketability.
import { MATCH } from '../core/market-search.js';
import { validGtin } from './market-vision.js';

export const FLAG = Object.freeze({
  PACK_OR_LOT: 'PACK_OR_LOT', ACCESSORY_SUSPECTED: 'ACCESSORY_SUSPECTED', PRICE_OUTLIER_HIGH: 'PRICE_OUTLIER_HIGH', PRICE_OUTLIER_LOW: 'PRICE_OUTLIER_LOW',
  CAPACITY_DIFFERS: 'CAPACITY_DIFFERS', PROMO_PRINTED: 'PROMO_PRINTED', NO_TEXT_OVERLAP: 'NO_TEXT_OVERLAP', CAPACITY_NOT_STATED: 'CAPACITY_NOT_STATED', MODEL_NOT_IN_TITLE: 'MODEL_NOT_IN_TITLE', BRAND_NOT_IN_TITLE: 'BRAND_NOT_IN_TITLE', VARIANT_DIFFERS: 'VARIANT_DIFFERS', VARIANT_NOT_STATED: 'VARIANT_NOT_STATED', TYPE_DIFFERS: 'TYPE_DIFFERS', NO_PRICE: 'NO_PRICE', FOREIGN_CURRENCY_NO_RATE: 'FOREIGN_CURRENCY_NO_RATE',
});
const STOP = new Set(['the', 'and', 'for', 'with', 'pour', 'avec', 'voor', 'met', 'les', 'des', 'une', 'een', 'van', 'new', 'neuf', 'nieuw']);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const alnum = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));
/** Distinctive words of a product name: keeps model-like tokens ("h2.0"), drops capacities and bare numbers (a volume is checked separately). */
const nameTokens = (s) => norm(s).split(/[\s,;:()/–—-]+/).map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter((t) => t.length >= 3 && !STOP.has(t) && !/^[\d.,]+$/.test(t) && !volumeMl(t));

/** Words that name a KIND of product (a bottle, a tumbler, a flask...) in several languages: synonyms, not identifiers. A case named only with such words ("water bottle") is identified by its brand and its verified traits, not by these words. */
export const CATEGORY_WORDS = new Set(['bottle', 'bottles', 'fles', 'flessen', 'thermosfles', 'drinkfles', 'waterfles', 'bidon', 'gourde', 'flask', 'thermos', 'tumbler', 'beker', 'thermosbeker', 'drinkbeker', 'mug', 'cup', 'gobelet', 'kan', 'water', 'eau', 'insulated', 'isotherme', 'steel', 'stainless', 'vacuum', 'sport', 'drink', 'travel']);
export const nameIsCategory = (input) => { const bt = new Set(nameTokens(input.brand)); const want = nameTokens(input.name).filter((w) => !bt.has(w)); return want.every((w) => CATEGORY_WORDS.has(w)); };
export const titleWords = (title) => new Set(norm(title).split(/[^a-z0-9]+/).filter(Boolean));
export const fmtMl = (ml) => (ml >= 1000 ? `${(ml / 1000).toFixed(2).replace(/0$/, '').replace(/\.$/, '').replace('.', ',')} L` : `${Math.round(ml)} ml`);
/** Product-type FAMILIES (generic synonyms in several languages): a bottle / gourde is not a travel tumbler / gobelet, and neither is a jug. The brand's own words are removed first ("Hydro Flask" is not a flask).
 *  A title that names words of two families (or none) has NO determinable type: it is never excluded for its type, and never trusted to be the same type either. */
export const TYPE_FAMILIES = Object.freeze({
  bottle: ['bottle', 'bottles', 'fles', 'flessen', 'waterfles', 'drinkfles', 'thermosfles', 'thermosflessen', 'bidon', 'gourde', 'gourdes'],
  tumbler: ['tumbler', 'tumblers', 'beker', 'bekers', 'drinkbeker', 'thermosbeker', 'gobelet', 'gobelets', 'mug', 'mugs', 'cup', 'cups'],
  jug: ['jug', 'jugs', 'kan', 'kannen', 'cruche', 'pitcher', 'carafe'],
});
export const TYPE_KEYS = Object.keys(TYPE_FAMILIES);
/** Nouns of ACCESSORY parts (generic): never a product variant. */
export const ACCESSORY_WORDS = new Set(['cap', 'caps', 'lid', 'lids', 'straw', 'straws', 'dop', 'dopje', 'deksel', 'tote', 'sling', 'sleeve', 'strap', 'boot', 'handle', 'cover', 'spout', 'replacement', 'accessory']);
export const TYPE_LABELS = Object.freeze({ bottle: 'gourde / bouteille', tumbler: 'gobelet de voyage', jug: 'cruche / carafe' });
export function typeOf(text, brand = '') {
  const bw = new Set(norm(brand).split(/[^a-z0-9]+/).filter(Boolean)); const words = [...titleWords(text)].filter((w) => !bw.has(w));
  const hit = TYPE_KEYS.filter((k) => TYPE_FAMILIES[k].some((w) => words.includes(w))); return hit.length === 1 ? hit[0] : null;
}
/** Pack size read in a title ("5 st.", "50st.", "2 x", "2 Pack", "6-pack"); null when none. */
export function packOf(title) { const t = norm(title); const m = /(?:^|\s)(\d{1,3})\s?(?:x|×)\s?(?=\d|[a-z]{3})/.exec(t) ?? /(?:^|\s)(\d{1,3})\s?(?:st\.?|stuks?|stk\.?|pcs|pieces|pc)(?=\s|$|\W)/.exec(t) ?? /(?:^|\s)(\d{1,3})[- ]?pack\b/.exec(t); const n = m ? Number(m[1]) : null; return n && n > 1 ? n : null; }
/** The facet value a title states: exactly ONE value whose words are all in the title; otherwise null (unstated or ambiguous). */
export function variantOf(title, facet) { if (!facet?.values?.length) return null; const w = titleWords(title); const hit = facet.values.filter((v) => v.tokens.every((tk) => w.has(tk))); return hit.length === 1 ? hit[0] : null; }

/** Volume in millilitres from a text ("1.18L", "1,18 l", "500ml", "50cl", "40oz"); null when none. */
export function volumeMl(text) {
  const t = norm(text).replace(',', '.'); const out = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s?(ml|cl|l|liter|litre|oz)\b/g)) { const v = Number(m[1]); const u = m[2]; out.push(u === 'ml' ? v : u === 'cl' ? v * 10 : u === 'oz' ? v * 29.5735 : v * 1000); }
  return out.length ? out[0] : null;
}
// Calibrated on REAL Belgian Google Shopping titles (19/10/2026): Dutch "5 st." / "50st." = pieces, "1913 x FARM Rio" is a collaboration (not a multiplier), "avec anse" / "met Rietje" / "avec paille" describe a tumbler that comes WITH a handle or straw (not an accessory).
/** Mass in grams from a text ("400 g", "1,5 kg"); null when none. */
export function massG(text) { const t = norm(text).replace(',', '.'); const m = /(\d+(?:\.\d+)?)\s?(kg|gram|grams|gr|g)\b/.exec(t); return m ? Number(m[1]) * (m[2] === 'kg' ? 1000 : 1) : null; }
const PACK_RE = /(\b\d{1,3}\s?(?:x|×)\s?(?=\d|[a-z]{3})|\b\d{1,3}\s?(?:st\.?|stuks?|stk\.?|pcs|pieces|pièces|pc)(?=\s|$|\W)|\b(?:pack|lot|bundle|paquet|assortiment|sortiment|wholesale|gros|groothandel|bulk|duopack|multipack)\b|\b\d+[- ]?pack\b|\bset\s+(?:of|van|de)\s+\d+)/i;
const PROMO_RE = /\b(bedrukken|bedrukt|bedrukking|met logo|met uw logo|relatiegeschenk\w*|promotioneel|promotional|promo|gepersonaliseerd|personnalis\w+|personalis\w+|gravure|gegraveerd|engraved|sublimati\w+)\b/i;
const ACCESSORY_RE = /\b(replacement|vervangings\w*|vervang\w*|remplacement|rechange|accessoire|accessoires|accessory|accessories|sticker|stickers|autocollant|charm|sleeve|boot|hoes|housse|etui|étui|borstel|brosse|brush|lid only|deksel(?: alleen)?)\b/i;
const STRAW_ONLY = (t) => { const end = /\b(straws?|rietjes?|pailles?)\W*$/i.test(t); return end && !/\b(met|avec|with|mit|incl\w*|et|and|\+)\s+(?:\d+\s*)?(?:\w+\s+){0,2}(?:straws?|rietjes?|pailles?)\W*$/i.test(t); };

/** Accessory by NOUN (calibrated on real Hydro Flask listings: "Standard Flex Cap", "Wide Flex Straw", "Press-In Lid", "Insulated Tote" are not bottles). The brand is removed first ("Hydro FLASK" contains a container word); a title that ALSO names a container ("Wide Flex Cap Thermosfles") is a bottle with that cap. */
const ACC_NOUN = /\b(caps?|lids?|straws?|dop|dopje|deksel|tote|sling|sleeve|strap|boot)\b/i;
const CONTAINER_NOUN = /\b(bottles?|fles|flessen|thermosfles|drinkfles|bidon|beker|tumbler|gourde|gobelet|mug|cup|flask|thermos|kan)\b/i;
const accessoryByNoun = (title, brand) => { let t = String(title ?? ''); if (brand) t = t.replace(new RegExp(String(brand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' '); return ACC_NOUN.test(t) && !CONTAINER_NOUN.test(t); };

export function linkInfo(url) {
  let u; try { u = new URL(url); } catch { return { kind: 'UNKNOWN', host: null }; }
  const google = /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && (/oshop|shopping/.test(u.search) || /^\/(shopping|search)/.test(u.pathname));
  return google ? { kind: 'GOOGLE_SHOPPING_PAGE', host: u.hostname } : { kind: 'MERCHANT_DIRECT', host: u.hostname.replace(/^www\./, '') };
}
/** Marketplace named by the SELLER field (what Google Shopping says), never by the link. */
export function marketplaceOf(seller, url) {
  const h = `${seller ?? ''} ${linkInfo(url).kind === 'MERCHANT_DIRECT' ? url : ''}`.toLowerCase();
  const a = /amazon[.\s]?(com\.be|be|nl|fr|de|co\.uk|es|it)\b/.exec(h); if (a) return `amazon.${a[1] === 'com.be' ? 'be' : a[1]}`; if (/amazon/.test(h)) return 'amazon';
  if (/(^|[\s.])bol(\.com)?($|[\s.])/.test(h)) return 'bol.com'; return null;
}

/** Search input from the case (and an OPTIONAL identification, e.g. from a future photo step: it only fills what the case lacks, and says where each value came from). */
export function mergeIdentification(input, ident) {
  const out = { ...input, sources: {} }; if (!ident || typeof ident !== 'object') return out;
  const fill = (k, v, src) => { if (v && !out[k]) { out[k] = v; out.sources[k] = src; } };
  fill('gtin', (ident.eans ?? [])[0], ident.source ?? 'IDENTIFICATION'); fill('brand', (ident.logos ?? [])[0], ident.source ?? 'IDENTIFICATION');
  // a model is taken automatically only when the label gave ONE candidate: two different candidates are a question for the owner, never a silent pick
  const models = [...new Set((ident.models ?? []).map((m) => String(m)))];
  if (models.length === 1) fill('model', models[0], ident.source ?? 'IDENTIFICATION'); else if (models.length > 1 && !out.model) out.modelCandidates = models;
  fill('name', (ident.bestGuess ?? [])[0], ident.source ?? 'IDENTIFICATION');
  // a size read on the label (OCR) or in the guessed name is used automatically only when ALL the volumes found agree (within 3 %): otherwise it is a question
  const vols = volumesIn([ident.ocrText, ...(ident.bestGuess ?? [])].join(' ')); const clusters = clusterVolumes(vols);
  if (clusters.length === 1 && !out.traits?.capacity) out.capacityHint = { ml: clusters[0], source: 'ÉTIQUETTE (OCR)' }; else if (clusters.length > 1) out.capacityCandidates = clusters.map((ml) => ({ ml, source: 'ÉTIQUETTE (OCR)' }));
  return out;
}
/** Every volume (in millilitres) written in a text, in order. */
export function volumesIn(text) { const t = norm(text).replace(/(\d),(\d)/g, '$1.$2'); const out = []; for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s?(ml|cl|l|liter|litre|oz)\b/g)) { const v = Number(m[1]); const u = m[2]; out.push(Math.round(u === 'ml' ? v : u === 'cl' ? v * 10 : u === 'oz' ? v * 29.5735 : v * 1000)); } return out; }
/** Volumes that differ by less than 3 % are the same size written two ways (40 oz = 1.18 L). */
export function clusterVolumes(vols) { const cs = []; for (const v of [...vols].sort((a, b) => a - b)) { const last = cs[cs.length - 1]; if (last && Math.abs(v - last) / last <= 0.03) continue; cs.push(v); } return cs; }
export const capacityOf = (input) => { if (input.confirmed?.capacityMl) return Number(input.confirmed.capacityMl); const t = input.traits ?? {}; for (const k of ['capacity', 'volume', 'capacite', 'contenance']) { const v = t[k]?.value ?? t[k]; if (v) { const ml = volumeMl(String(v)); if (ml) return ml; } } return volumeMl(input.name) ?? volumeMl(input.quantity) ?? input.capacityHint?.ml ?? null; };
/** Strict comparability applies once the owner has CONFIRMED a model or a size: what cannot be verified against it (size or model not written in the title, another brand) leaves the median, but stays visible with its reason. */
export const isStrict = (input) => !!(input.confirmed && (input.confirmed.capacityMl || input.confirmed.model || input.confirmed.variant));

/** At most `max` queries (each is a paid call): GTIN, then brand+model, then brand+name+capacity. */
export function queriesFromInput(input, max = 2) {
  const qs = []; const add = (text, via, strength) => { const t = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 140); if (t.length >= 3 && !qs.some((q) => q.text.toLowerCase() === t.toLowerCase())) qs.push({ text: t, via, strength }); };
  if (input.gtin && !input.gtinResolved) add(input.gtin, 'code-barres (GTIN)', 'GTIN'); // once the barcode is resolved to a NAME, the bare number is not searched (Google Shopping does not match it reliably)
  if (input.brand && input.model) add(`${input.brand} ${input.model}`, 'marque + modèle', 'MODEL'); else if (input.model) add(input.model, 'modèle', 'MODEL');
  const cap = capacityOf(input); const capText = cap && !volumeMl(input.name) ? `${cap >= 1000 ? cap / 1000 : cap}${cap >= 1000 ? 'L' : 'ml'}` : '';
  if (input.name) add([input.brand && !norm(input.name).includes(norm(input.brand)) ? input.brand : '', input.name, capText, input.quantity && !norm(input.name).includes(norm(input.quantity)) ? input.quantity : ''].filter(Boolean).join(' '), input.gtinResolved ? 'code-barres reconnu (base ouverte)' : input.brand ? 'marque + nom' : 'nom', input.brand ? 'BRAND_NAME' : 'NAME_ONLY');
  return qs.slice(0, max);
}

/** Honest class of one listing. EXACT needs the exact model (with the brand when the brand is known); a GTIN query alone is PROBABLE (Google does not give the GTIN of a listing). A similar-looking title is never EXACT. */
export function classifyListing(l, input) {
  const flags = []; const title = l.title ?? ''; const t = alnum(title); const brand = alnum(input.brand); const model = alnum(input.model);
  const brandHit = !!brand && t.includes(brand); const modelOk = model.length >= 4 && /\d/.test(model); const modelHit = modelOk && t.includes(model);
  const brandTok = new Set(nameTokens(input.brand)); const want = nameTokens(input.name).filter((w) => !brandTok.has(w)); const have = new Set(nameTokens(title));
  const overlap = want.length ? want.filter((w) => have.has(w) || t.includes(alnum(w))).length / want.length : 0; // share of the product's distinctive words found in the title (brand excluded)
  const wantMl = capacityOf(input); const gotMl = volumeMl(title); const wantG = massG(input.quantity) ?? massG(input.name); const gotG = massG(title);
  const volTol = input.confirmed?.capacityMl ? 0.04 : 0.12; /* a size the owner CONFIRMED is matched tightly (946 ml is not 1 L); a size inferred from the case keeps the looser 12 % */
  if ((wantMl && gotMl && Math.abs(gotMl - wantMl) / wantMl > volTol) || (wantG && gotG && Math.abs(gotG - wantG) / wantG > 0.12)) flags.push(FLAG.CAPACITY_DIFFERS); else if ((wantMl && !gotMl) || (wantG && !gotG && !wantMl)) flags.push(FLAG.CAPACITY_NOT_STATED);
  const noOverlap = brand ? (!brandHit && (!want.length || overlap === 0)) : (want.length ? overlap === 0 : true); /* true when there is nothing to compare (a bare barcode search): nothing ties the title to the search */ if (noOverlap && !modelHit) flags.push(FLAG.NO_TEXT_OVERLAP); // nothing in the title ties it to the search: kept visible, never in a price range
  if (PACK_RE.test(title)) flags.push(FLAG.PACK_OR_LOT); if ((ACCESSORY_RE.test(title) || STRAW_ONLY(title) || (accessoryByNoun(title, input.brand) && !ACC_NOUN.test(input.name ?? ''))) && !ACCESSORY_RE.test(input.name ?? '')) flags.push(FLAG.ACCESSORY_SUSPECTED); if (PROMO_RE.test(title) && !PROMO_RE.test(input.name ?? '')) flags.push(FLAG.PROMO_PRINTED);
  if (modelOk && !modelHit) flags.push(FLAG.MODEL_NOT_IN_TITLE);
  const ptype = input.productType ?? typeOf(input.name, input.brand); const ltype = typeOf(title, input.brand); if (ptype && ltype && ptype !== ltype) flags.push(FLAG.TYPE_DIFFERS); // another KIND of product (tumbler vs bottle): never comparable, never in the same price
  let matchType; let confidence; let reason;
  const downgraded = flags.includes(FLAG.CAPACITY_DIFFERS) || flags.includes(FLAG.ACCESSORY_SUSPECTED) || flags.includes(FLAG.PACK_OR_LOT) || flags.includes(FLAG.PROMO_PRINTED) || flags.includes(FLAG.TYPE_DIFFERS);
  const variantOk = (input.confirmed?.variant?.tokens ?? []).length > 0 && input.confirmed.variant.tokens.every((tk) => titleWords(title).has(tk)); const sizeOk = ((!!wantMl && !!gotMl) || (!!wantG && !!gotG)) && !flags.includes(FLAG.CAPACITY_DIFFERS); // a volume OR a weight, written in the title and agreeing with the product's
  const categoryPromotion = !downgraded && brandHit && nameIsCategory(input) && (sizeOk || variantOk); // brand + a VERIFIED size or variant, and no contradicting type: enough, the generic noun ("bottle") is not required // a known brand + a verified size + the same kind of product: enough for PROBABLE even when the case name is only a category
  if (!downgraded && modelHit && (brandHit || !brand)) { matchType = MATCH.EXACT_MATCH; confidence = 'MEDIUM'; reason = 'le modèle exact figure dans le titre'; }
  else if (!downgraded && (categoryPromotion || (brandHit && want.length >= 2 && overlap >= 0.75) /* a case named with the brand ALONE identifies nothing: every listing of that brand would be "probable" (only a verified size or variant promotes it, see categoryPromotion) */ || (modelHit && !!brand) || (!brand && want.length >= 3 && overlap >= 0.9) || (!!brand && !brandHit && want.length >= 3 && overlap >= 0.99) || (l.queryVia?.includes('GTIN') && (brandHit || overlap >= 0.5)))) { matchType = MATCH.PROBABLE_MATCH; confidence = categoryPromotion && !modelHit && !ltype ? 'LOW' : 'MEDIUM'; reason = categoryPromotion && !modelHit ? (ltype ? 'marque et taille ou variante vérifiées, même type de produit' : 'marque et taille ou variante vérifiées ; type de produit non précisé dans le titre (prudence)') : modelHit ? 'modèle trouvé mais marque absente du titre' : l.queryVia?.includes('GTIN') ? 'trouvé par code-barres, titre non confirmé' : brandHit ? `marque et ${Math.round(overlap * 100)} % des mots distinctifs du nom dans le titre` : `tous les mots distinctifs du nom dans le titre, mais marque absente`; }
  else { matchType = MATCH.SIMILAR_PRODUCT; confidence = 'LOW'; reason = flags.includes(FLAG.NO_TEXT_OVERLAP) ? 'aucun mot du titre ne se rapporte à la recherche' : downgraded ? (flags.includes(FLAG.TYPE_DIFFERS) ? 'autre type de produit' : flags.includes(FLAG.CAPACITY_DIFFERS) ? 'capacité différente' : flags.includes(FLAG.ACCESSORY_SUSPECTED) ? 'accessoire probable' : flags.includes(FLAG.PACK_OR_LOT) ? 'lot ou pack probable' : 'article promotionnel / personnalisé probable') : `ressemblance seulement (${Math.round(overlap * 100)} % des mots du nom)`; }
  return { matchType, confidence, reason, flags };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const round2 = (x) => Math.round(x * 100) / 100;
export const toEur = (amount, currency, ecb) => (currency === 'EUR' ? amount : ecb?.perEur?.[currency] ? amount / ecb.perEur[currency] : null);

/** Annotates every listing and computes the reference range from the INCLUDED ones only (nothing is deleted: excluded listings stay visible with their reasons). */
export const MIN_COMPARABLE = 3;
const CLASS_ORDER = [MATCH.EXACT_MATCH, MATCH.PROBABLE_MATCH];
const repOf = (clusters, ml) => clusters.reduce((best, c) => (best == null || Math.abs(c - ml) < Math.abs(best - ml) ? c : best), null);

/** Annotates every listing and builds the reference prices from the INCLUDED, COMPARABLE ones only (nothing is deleted: excluded listings stay visible with their reasons).
 *  Statistics are made per CLASS (exact / probable) and per HOMOGENEOUS group (one size, one variant): different things are never averaged together. Below MIN_COMPARABLE in a group there is no median. */
export function analyseListings(listings, input, { ecb = null } = {}) {
  const strict = isStrict(input); const conf = input.confirmed ?? {}; const facet = input.variantFacet ?? null;
  const rows = listings.map((l, i) => { const c = classifyListing(l, input); const eur = l.price != null ? toEur(l.price, l.currency, ecb) : null; const f = [...c.flags];
    if (strict && input.brand && !alnum(l.title).includes(alnum(input.brand))) f.push(FLAG.BRAND_NOT_IN_TITLE);
    const v = variantOf(l.title, facet);
    if (conf.variant?.tokens?.length) { const w = titleWords(l.title); if (!conf.variant.tokens.every((tk) => w.has(tk))) f.push(v && v.key !== conf.variant.key ? FLAG.VARIANT_DIFFERS : FLAG.VARIANT_NOT_STATED); }
    if (l.price == null) f.push(FLAG.NO_PRICE); else if (eur == null) f.push(FLAG.FOREIGN_CURRENCY_NO_RATE);
    let { matchType, confidence, reason } = c;
    // EXACT needs every determining trait verified: a variant the title states and the owner has not confirmed keeps the listing at PROBABLE
    if (matchType === MATCH.EXACT_MATCH && facet && v && !conf.variant) { matchType = MATCH.PROBABLE_MATCH; reason = `modèle trouvé, mais la variante (${v.label}) n’est pas confirmée`; }
    const li = linkInfo(l.url); const n = f.includes(FLAG.PACK_OR_LOT) ? packOf(l.title) : null;
    return { id: `l${i + 1}`, title: l.title, seller: l.seller, marketplace: marketplaceOf(l.seller, l.url), price: l.price != null ? { amount: l.price, currency: l.currency, eur: eur != null ? round2(eur) : null } : null, url: l.url, linkKind: li.kind, linkHost: li.host,
      matchType, confidence, reason, flags: f, observedAt: l.observedAt, source: 'google-shopping via dataforseo', query: l.query, queryVia: l.queryVia, productId: l.productId,
      variant: v ? { key: v.key, label: v.label } : null, type: typeOf(l.title, input.brand), sizeMl: volumeMl(l.title), pack: n && eur != null ? { n, unitEur: round2(eur / n), estimated: true } : null }; });
  const OUT = [FLAG.PACK_OR_LOT, FLAG.ACCESSORY_SUSPECTED, FLAG.CAPACITY_DIFFERS, FLAG.PROMO_PRINTED, FLAG.NO_TEXT_OVERLAP, FLAG.TYPE_DIFFERS]; if (strict) OUT.push(FLAG.CAPACITY_NOT_STATED, FLAG.MODEL_NOT_IN_TITLE, FLAG.BRAND_NOT_IN_TITLE, FLAG.VARIANT_DIFFERS, FLAG.VARIANT_NOT_STATED);
  // outliers: among listings that are not already out for another reason, against the median of those (needs 5 priced listings: otherwise no judgement)
  const base = rows.filter((r) => r.price?.eur != null && !r.flags.some((f) => OUT.includes(f)));
  if (base.length >= 5) { const m = median(base.map((r) => r.price.eur)); for (const r of base) { if (r.price.eur > m * 2.5) r.flags.push(FLAG.PRICE_OUTLIER_HIGH); else if (r.price.eur < m * 0.4) r.flags.push(FLAG.PRICE_OUTLIER_LOW); } }
  const EXCL = [...OUT, FLAG.PRICE_OUTLIER_HIGH, FLAG.PRICE_OUTLIER_LOW]; for (const r of rows) r.excludedFromReference = r.price?.eur == null || r.flags.some((f) => EXCL.includes(f));
  const incl = rows.filter((r) => !r.excludedFromReference); const comparable = incl.filter((r) => CLASS_ORDER.includes(r.matchType));
  // homogeneous groups: per class, per size (only while the size is unknown) and per variant (only while a variant facet exists and is not confirmed)
  const sizeKnown = !!capacityOf(input) || !!input.model; /* a model determines the size: no split by size */ const byVariant = !!facet && !conf.variant; const clusters = clusterVolumes(comparable.map((r) => r.sizeMl).filter(Boolean));
  const ptypeKnown = !!(input.productType ?? typeOf(input.name, input.brand)); /* while the product's own type is unknown, listings of different types are grouped apart */ const gm = new Map(); for (const r of comparable) { const tp = ptypeKnown ? '' : (r.type ?? 'none'); const sz = sizeKnown ? '' : (r.sizeMl ? String(repOf(clusters, r.sizeMl)) : 'none'); const k = `${r.matchType}|${tp}|${sz}|${byVariant ? (r.variant?.key ?? 'none') : ''}`; (gm.get(k) ?? gm.set(k, []).get(k)).push(r); }
  const groups = [...gm.values()].map((rs) => { const prices = rs.map((r) => r.price.eur).sort((x, y) => x - y); const reliable = prices.length >= MIN_COMPARABLE; const rep = !sizeKnown && rs[0].sizeMl ? repOf(clusters, rs[0].sizeMl) : null;
    return { class: rs[0].matchType, type: ptypeKnown ? null : (rs[0].type ?? 'none'), size: rep ? { ml: Math.round(rep), label: fmtMl(rep) } : null, variant: byVariant ? (rs[0].variant ?? { key: 'none', label: 'variante non indiquée' }) : null, count: prices.length, reliable, minEur: round2(prices[0]), medianEur: reliable ? round2(median(prices)) : null, maxEur: round2(prices[prices.length - 1]), pricesEur: prices.map(round2), ids: rs.map((r) => r.id) }; })
    .sort((x, y) => CLASS_ORDER.indexOf(x.class) - CLASS_ORDER.indexOf(y.class) || y.count - x.count);
  const count = (t) => rows.filter((r) => r.matchType === t).length; const flagCount = {}; for (const r of rows) for (const f of r.flags) flagCount[f] = (flagCount[f] ?? 0) + 1;
  return { listings: rows, groups, summary: { total: rows.length, exact: count(MATCH.EXACT_MATCH), probable: count(MATCH.PROBABLE_MATCH), similar: count(MATCH.SIMILAR_PRODUCT), excluded: rows.filter((r) => r.excludedFromReference).length, exactNone: count(MATCH.EXACT_MATCH) === 0, flags: flagCount },
    reference: referenceFrom(groups, comparable, incl), ...indicativeFrom(rows, input),
    marketplaces: { 'amazon.be': rows.filter((r) => r.marketplace === 'amazon.be').length, 'bol.com': rows.filter((r) => r.marketplace === 'bol.com').length } };
}
/** ONE reference price only when exactly one reliable homogeneous group exists in the best class; several groups = no single price; otherwise "non fiable". */
function referenceFrom(groups, comparable, incl) {
  for (const cls of CLASS_ORDER) {
    const gs = groups.filter((g) => g.class === cls && g.reliable);
    if (gs.length === 1) { const g = gs[0]; return { reliable: true, matchClass: cls, count: g.count, minEur: g.minEur, medianEur: g.medianEur, maxEur: g.maxEur, variant: g.variant, size: g.size, note: null }; }
    if (gs.length > 1) return { reliable: false, multiple: true, matchClass: cls, count: gs.reduce((n, g) => n + g.count, 0), minEur: null, medianEur: null, maxEur: null, pricesEur: [], note: `${gs.length} groupes distincts (tailles ou variantes différentes) : pas de prix unique, un prix par groupe` };
  }
  const prices = comparable.map((r) => r.price.eur).sort((x, y) => x - y); const similar = incl.length - comparable.length;
  return { reliable: false, matchClass: comparable[0]?.matchType ?? null, count: comparable.length, minEur: prices.length ? round2(prices[0]) : null, medianEur: null, maxEur: prices.length ? round2(prices[prices.length - 1]) : null, pricesEur: prices.map(round2),
    note: comparable.length ? (groups.length > 1 ? `${comparable.length} annonce(s) comparable(s) réparties en ${groups.length} groupes de moins de ${MIN_COMPARABLE} : pas de médiane` : `seulement ${comparable.length} annonce(s) comparable(s) (minimum ${MIN_COMPARABLE}) : pas de médiane`) : similar ? `aucune annonce comparable : ${similar} produit(s) seulement similaire(s), pas de médiane` : 'aucune annonce comparable retenue' };
}

/** INDICATIVE prices per product-type FAMILY: the SIMILAR (not comparable) listings still in scope, one family at a time, at least MIN_COMPARABLE per family. Context only: never a reference price, never promoted to "probable",
 *  never used for the supplier comparison. Different families are never averaged together. */
/** A brand that is KNOWN (the case, the barcode database, the label) is respected: a listing whose title does not name it is another brand and is left out of the indicative prices (counted, said). The test is on the letters and digits only
 *  (case, accents, spaces, hyphens and symbols ignored: "Hydro Flask" = "HYDROFLASK" = "Hydro-Flask®"), so a spelling variant never excludes a valid listing. Brand unknown: nothing is filtered and the screen says the comparison mixes brands. */
export const brandInTitle = (title, brand) => !String(brand ?? '').trim() || alnum(title).includes(alnum(brand));
function indicativeFrom(rows, input) {
  const brandKnown = !!String(input.brand ?? '').trim(); const by = new Map(); let otherBrand = 0;
  for (const r of rows) {
    if (r.excludedFromReference || r.matchType !== MATCH.SIMILAR_PRODUCT || !r.type || r.price?.eur == null) continue;
    if (brandKnown && !brandInTitle(r.title, input.brand)) { otherBrand += 1; continue; }
    (by.get(r.type) ?? by.set(r.type, []).get(r.type)).push(r.price.eur);
  }
  const indicative = [...by.entries()].filter(([, ps]) => ps.length >= MIN_COMPARABLE).map(([type, ps]) => { const s = [...ps].sort((x, y) => x - y); return { type, count: s.length, minEur: round2(s[0]), medianEur: round2(median(s)), maxEur: round2(s[s.length - 1]) }; });
  return { indicative, indicativeBasis: { brandKnown, brand: brandKnown ? String(input.brand).trim() : null, brandSource: brandKnown ? (input.sources?.brand ?? null) : null, otherBrandLeftOut: otherBrand } };
}

/** Supplier price against the observed reference. Never a verdict. */
export function compareWithSupplier({ reference, supplier, ecb }) {
  const caveats = ['TVA : la source ne précise pas si le prix inclut la TVA (prix de détail grand public en général TTC) ; le prix fournisseur est hors TVA', 'Transport, droits d\'importation, TVA à l\'importation et frais de dédouanement NE SONT PAS inclus', 'Ce n\'est ni une marge, ni une décision d\'achat'];
  const out = { ecbDate: ecb?.date ?? null, supplierInput: supplier?.price != null ? { price: Number(supplier.price), currency: supplier.currency ?? null } : null, supplierEur: null, referenceMedianEur: reference?.medianEur ?? null, ratio: null, caveats };
  if (!out.supplierInput) { out.note = 'aucun prix fournisseur dans le dossier : pas de comparaison'; return out; }
  const eur = out.supplierInput.currency ? toEur(out.supplierInput.price, out.supplierInput.currency, ecb) : null;
  if (eur == null) { out.note = 'devise du fournisseur inconnue ou sans taux BCE : pas de conversion inventée'; return out; }
  out.supplierEur = round2(eur); if (reference?.medianEur) { out.ratio = round2(eur / reference.medianEur); out.note = `le prix fournisseur converti (taux BCE du ${ecb?.date ?? '?'}) représente ${Math.round(out.ratio * 100)} % de la médiane observée (${reference.matchClass === MATCH.SIMILAR_PRODUCT ? 'produits similaires' : reference.matchClass === MATCH.PROBABLE_MATCH ? 'correspondances probables' : 'correspondances exactes'})`; } else out.note = 'prix de référence non fiable : aucune comparaison avec le prix fournisseur (trop peu d’annonces vraiment comparables)';
  return out;
}

/** Listing -> the evidence record stored in the case (provenance and date kept; flags and link kind in `specs`). */
export function toStoredEvidence(r, country) {
  return { seller: r.seller, sellerType: 'UNKNOWN', country, url: r.url, source: 'google-shopping', price: r.price ? { amount: r.price.amount, currency: r.price.currency, vatIncluded: null } : null, brand: null, model: null,
    specs: { type: r.type ?? null, variant: r.variant ?? null, pack: r.pack ?? null, sizeMl: r.sizeMl ?? null, title: r.title, marketplace: r.marketplace, linkKind: r.linkKind, linkHost: r.linkHost, flags: r.flags, excluded: r.excludedFromReference, eur: r.price?.eur ?? null, query: r.query, queryVia: r.queryVia, productId: r.productId },
    availability: null, matchType: r.matchType, confidence: r.confidence, observedAt: r.observedAt, reason: r.reason };
}

// ---- identification (what a PHOTO, a LOCAL barcode read or the owner says about the product) -------------------------------------------------------------------------------------------------------
export const IDENT_SOURCES = Object.freeze(['LOCAL_BARCODE', 'PHOTO_VISION', 'OWNER']);
const cl = (v, n = 120) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
/** Server-side cleaning of an identification sent by a phone: the source is whitelisted, a GTIN must have a valid check digit, strings are clamped. Nothing the client says is trusted as is. */
export function sanitizeIdentification(raw) {
  if (!raw || typeof raw !== 'object') return null; const source = IDENT_SOURCES.includes(raw.source) ? raw.source : null; if (!source) return null;
  const arr = (a, n, f) => (Array.isArray(a) ? a.map(f).filter(Boolean).slice(0, n) : []);
  const out = { source, provider: source === 'PHOTO_VISION' ? 'google-cloud-vision' : source === 'LOCAL_BARCODE' ? 'local-barcode-reader' : 'owner', eans: arr(raw.eans, 2, (e) => { const d = String(e ?? '').replace(/\D/g, ''); return validGtin(d) ? d : null; }),
    models: arr(raw.models, 3, (m) => { const t = cl(m, 40).toUpperCase(); return /^[A-Z0-9][A-Z0-9-]{3,39}$/.test(t) && /\d/.test(t) && /[A-Z]/.test(t) ? t : null; }), logos: arr(raw.logos, 2, (l) => cl(l, 60) || null), bestGuess: arr(raw.bestGuess, 2, (g) => cl(g) || null) };
  if (source === 'LOCAL_BARCODE') { out.engine = ['BarcodeDetector', 'local-js'].includes(raw.engine) ? raw.engine : 'unknown'; out.format = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].includes(raw.format) ? raw.format : null; }
  if (source === 'PHOTO_VISION') { out.entities = arr(raw.entities, 5, (e) => (e && e.description ? { description: cl(e.description), score: Number.isFinite(e.score) ? e.score : null } : null)); out.ocrText = cl(raw.ocrText, 300); }
  return out;
}
/** HIGH: a valid barcode. MEDIUM: brand and model both read. LOW: only a name guess (category level): the owner confirms with one tap before any search. NONE: nothing usable. */
export function identificationConfidence(i) {
  if (!i) return 'NONE'; if ((i.eans ?? []).length) return 'HIGH'; if ((i.logos ?? []).length && (i.models ?? []).length) return 'MEDIUM';
  if ((i.models ?? []).length || (i.logos ?? []).length || (i.bestGuess ?? []).length) return 'LOW'; return 'NONE';
}
