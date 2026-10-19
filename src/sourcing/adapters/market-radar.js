// MARKET RADAR analysis (pure, no network): case input -> queries; listing -> honest match class; anomalies, packs, accessories and different capacities are FLAGGED and kept apart from the reference range, never silently removed;
// supplier price vs what was observed, converted at a dated ECB rate. Observed market signals only: not a margin, not a purchase decision, not proof of legal marketability.
import { MATCH } from '../core/market-search.js';
import { validGtin } from './market-vision.js';

export const FLAG = Object.freeze({
  PACK_OR_LOT: 'PACK_OR_LOT', ACCESSORY_SUSPECTED: 'ACCESSORY_SUSPECTED', PRICE_OUTLIER_HIGH: 'PRICE_OUTLIER_HIGH', PRICE_OUTLIER_LOW: 'PRICE_OUTLIER_LOW',
  CAPACITY_DIFFERS: 'CAPACITY_DIFFERS', PROMO_PRINTED: 'PROMO_PRINTED', NO_TEXT_OVERLAP: 'NO_TEXT_OVERLAP', CAPACITY_NOT_STATED: 'CAPACITY_NOT_STATED', MODEL_NOT_IN_TITLE: 'MODEL_NOT_IN_TITLE', NO_PRICE: 'NO_PRICE', FOREIGN_CURRENCY_NO_RATE: 'FOREIGN_CURRENCY_NO_RATE',
});
const STOP = new Set(['the', 'and', 'for', 'with', 'pour', 'avec', 'voor', 'met', 'les', 'des', 'une', 'een', 'van', 'new', 'neuf', 'nieuw']);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const alnum = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));
/** Distinctive words of a product name: keeps model-like tokens ("h2.0"), drops capacities and bare numbers (a volume is checked separately). */
const nameTokens = (s) => norm(s).split(/[\s,;:()/–—-]+/).map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter((t) => t.length >= 3 && !STOP.has(t) && !/^[\d.,]+$/.test(t) && !volumeMl(t));

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
  fill('gtin', (ident.eans ?? [])[0], ident.source ?? 'IDENTIFICATION'); fill('model', (ident.models ?? [])[0], ident.source ?? 'IDENTIFICATION'); fill('brand', (ident.logos ?? [])[0], ident.source ?? 'IDENTIFICATION');
  fill('name', (ident.bestGuess ?? [])[0], ident.source ?? 'IDENTIFICATION');
  return out;
}
const capacityOf = (input) => { const t = input.traits ?? {}; for (const k of ['capacity', 'volume', 'capacite', 'contenance']) { const v = t[k]?.value ?? t[k]; if (v) { const ml = volumeMl(String(v)); if (ml) return ml; } } return volumeMl(input.name); };

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
  if ((wantMl && gotMl && Math.abs(gotMl - wantMl) / wantMl > 0.12) || (wantG && gotG && Math.abs(gotG - wantG) / wantG > 0.12)) flags.push(FLAG.CAPACITY_DIFFERS); else if ((wantMl && !gotMl) || (wantG && !gotG && !wantMl)) flags.push(FLAG.CAPACITY_NOT_STATED);
  const noOverlap = brand ? (!brandHit && (!want.length || overlap === 0)) : (want.length ? overlap === 0 : true); /* true when there is nothing to compare (a bare barcode search): nothing ties the title to the search */ if (noOverlap && !modelHit) flags.push(FLAG.NO_TEXT_OVERLAP); // nothing in the title ties it to the search: kept visible, never in a price range
  if (PACK_RE.test(title)) flags.push(FLAG.PACK_OR_LOT); if ((ACCESSORY_RE.test(title) || STRAW_ONLY(title) || (accessoryByNoun(title, input.brand) && !ACC_NOUN.test(input.name ?? ''))) && !ACCESSORY_RE.test(input.name ?? '')) flags.push(FLAG.ACCESSORY_SUSPECTED); if (PROMO_RE.test(title) && !PROMO_RE.test(input.name ?? '')) flags.push(FLAG.PROMO_PRINTED);
  if (modelOk && !modelHit) flags.push(FLAG.MODEL_NOT_IN_TITLE);
  let matchType; let confidence; let reason;
  const downgraded = flags.includes(FLAG.CAPACITY_DIFFERS) || flags.includes(FLAG.ACCESSORY_SUSPECTED) || flags.includes(FLAG.PACK_OR_LOT) || flags.includes(FLAG.PROMO_PRINTED);
  if (!downgraded && modelHit && (brandHit || !brand)) { matchType = MATCH.EXACT_MATCH; confidence = 'MEDIUM'; reason = 'le modèle exact figure dans le titre'; }
  else if (!downgraded && ((brandHit && (want.length === 0 ? nameTokens(input.name).length > 0 : want.length >= 2 && overlap >= 0.75)) || (modelHit && !!brand) || (!brand && want.length >= 3 && overlap >= 0.9) || (!!brand && !brandHit && want.length >= 3 && overlap >= 0.99) || (l.queryVia?.includes('GTIN') && (brandHit || overlap >= 0.5)))) { matchType = MATCH.PROBABLE_MATCH; confidence = 'MEDIUM'; reason = modelHit ? 'modèle trouvé mais marque absente du titre' : l.queryVia?.includes('GTIN') ? 'trouvé par code-barres, titre non confirmé' : brandHit ? `marque et ${Math.round(overlap * 100)} % des mots distinctifs du nom dans le titre` : `tous les mots distinctifs du nom dans le titre, mais marque absente`; }
  else { matchType = MATCH.SIMILAR_PRODUCT; confidence = 'LOW'; reason = flags.includes(FLAG.NO_TEXT_OVERLAP) ? 'aucun mot du titre ne se rapporte à la recherche' : downgraded ? (flags.includes(FLAG.CAPACITY_DIFFERS) ? 'capacité différente' : flags.includes(FLAG.ACCESSORY_SUSPECTED) ? 'accessoire probable' : flags.includes(FLAG.PACK_OR_LOT) ? 'lot ou pack probable' : 'article promotionnel / personnalisé probable') : `ressemblance seulement (${Math.round(overlap * 100)} % des mots du nom)`; }
  return { matchType, confidence, reason, flags };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const round2 = (x) => Math.round(x * 100) / 100;
export const toEur = (amount, currency, ecb) => (currency === 'EUR' ? amount : ecb?.perEur?.[currency] ? amount / ecb.perEur[currency] : null);

/** Annotates every listing and computes the reference range from the INCLUDED ones only (nothing is deleted: excluded listings stay visible with their reasons). */
export function analyseListings(listings, input, { ecb = null } = {}) {
  const rows = listings.map((l, i) => { const c = classifyListing(l, input); const eur = l.price != null ? toEur(l.price, l.currency, ecb) : null; const f = [...c.flags]; if (l.price == null) f.push(FLAG.NO_PRICE); else if (eur == null) f.push(FLAG.FOREIGN_CURRENCY_NO_RATE);
    const li = linkInfo(l.url); return { id: `l${i + 1}`, title: l.title, seller: l.seller, marketplace: marketplaceOf(l.seller, l.url), price: l.price != null ? { amount: l.price, currency: l.currency, eur: eur != null ? round2(eur) : null } : null, url: l.url, linkKind: li.kind, linkHost: li.host,
      matchType: c.matchType, confidence: c.confidence, reason: c.reason, flags: f, observedAt: l.observedAt, source: 'google-shopping via dataforseo', query: l.query, queryVia: l.queryVia, productId: l.productId }; });
  // outliers: among listings that are not already packs / accessories / different capacity, against the median of those (needs 5 priced listings: otherwise no judgement)
  const base = rows.filter((r) => r.price?.eur != null && !r.flags.some((f) => [FLAG.PACK_OR_LOT, FLAG.ACCESSORY_SUSPECTED, FLAG.CAPACITY_DIFFERS, FLAG.PROMO_PRINTED, FLAG.NO_TEXT_OVERLAP].includes(f)));
  if (base.length >= 5) { const m = median(base.map((r) => r.price.eur)); for (const r of base) { if (r.price.eur > m * 2.5) r.flags.push(FLAG.PRICE_OUTLIER_HIGH); else if (r.price.eur < m * 0.4) r.flags.push(FLAG.PRICE_OUTLIER_LOW); } }
  for (const r of rows) r.excludedFromReference = r.price?.eur == null || r.flags.some((f) => [FLAG.PACK_OR_LOT, FLAG.ACCESSORY_SUSPECTED, FLAG.CAPACITY_DIFFERS, FLAG.PROMO_PRINTED, FLAG.NO_TEXT_OVERLAP, FLAG.PRICE_OUTLIER_HIGH, FLAG.PRICE_OUTLIER_LOW].includes(f));
  const incl = rows.filter((r) => !r.excludedFromReference); const cls = [MATCH.EXACT_MATCH, MATCH.PROBABLE_MATCH, MATCH.SIMILAR_PRODUCT].find((c) => incl.some((r) => r.matchType === c)) ?? null;
  const ref = cls ? incl.filter((r) => r.matchType === cls).map((r) => r.price.eur) : [];
  const count = (t) => rows.filter((r) => r.matchType === t).length; const flagCount = {}; for (const r of rows) for (const f of r.flags) flagCount[f] = (flagCount[f] ?? 0) + 1;
  return { listings: rows, summary: { total: rows.length, exact: count(MATCH.EXACT_MATCH), probable: count(MATCH.PROBABLE_MATCH), similar: count(MATCH.SIMILAR_PRODUCT), excluded: rows.filter((r) => r.excludedFromReference).length, flags: flagCount },
    reference: cls ? { matchClass: cls, count: ref.length, minEur: round2(Math.min(...ref)), medianEur: round2(median(ref)), maxEur: round2(Math.max(...ref)), note: cls === MATCH.SIMILAR_PRODUCT ? 'aucune correspondance exacte ni probable : la fourchette ne concerne que des produits SIMILAIRES, à titre de contexte' : null } : null,
    marketplaces: { 'amazon.be': rows.filter((r) => r.marketplace === 'amazon.be').length, 'bol.com': rows.filter((r) => r.marketplace === 'bol.com').length } };
}

/** Supplier price against the observed reference. Never a verdict. */
export function compareWithSupplier({ reference, supplier, ecb }) {
  const caveats = ['TVA : la source ne précise pas si le prix inclut la TVA (prix de détail grand public en général TTC) ; le prix fournisseur est hors TVA', 'Transport, droits d\'importation, TVA à l\'importation et frais de dédouanement NE SONT PAS inclus', 'Ce n\'est ni une marge, ni une décision d\'achat'];
  const out = { ecbDate: ecb?.date ?? null, supplierInput: supplier?.price != null ? { price: Number(supplier.price), currency: supplier.currency ?? null } : null, supplierEur: null, referenceMedianEur: reference?.medianEur ?? null, ratio: null, caveats };
  if (!out.supplierInput) { out.note = 'aucun prix fournisseur dans le dossier : pas de comparaison'; return out; }
  const eur = out.supplierInput.currency ? toEur(out.supplierInput.price, out.supplierInput.currency, ecb) : null;
  if (eur == null) { out.note = 'devise du fournisseur inconnue ou sans taux BCE : pas de conversion inventée'; return out; }
  out.supplierEur = round2(eur); if (reference?.medianEur) { out.ratio = round2(eur / reference.medianEur); out.note = `le prix fournisseur converti (taux BCE du ${ecb?.date ?? '?'}) représente ${Math.round(out.ratio * 100)} % de la médiane observée (${reference.matchClass === MATCH.SIMILAR_PRODUCT ? 'produits similaires' : reference.matchClass === MATCH.PROBABLE_MATCH ? 'correspondances probables' : 'correspondances exactes'})`; } else out.note = 'aucune fourchette de référence utilisable';
  return out;
}

/** Listing -> the evidence record stored in the case (provenance and date kept; flags and link kind in `specs`). */
export function toStoredEvidence(r, country) {
  return { seller: r.seller, sellerType: 'UNKNOWN', country, url: r.url, source: 'google-shopping', price: r.price ? { amount: r.price.amount, currency: r.price.currency, vatIncluded: null } : null, brand: null, model: null,
    specs: { title: r.title, marketplace: r.marketplace, linkKind: r.linkKind, linkHost: r.linkHost, flags: r.flags, excluded: r.excludedFromReference, eur: r.price?.eur ?? null, query: r.query, queryVia: r.queryVia, productId: r.productId },
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
