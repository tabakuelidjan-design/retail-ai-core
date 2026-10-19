// MARKET RADAR refinement (pure, NO network, NO cost): after a search, at most TWO one-tap questions (a facet that really moves the price: the size, then the variant, or the model), built only from evidence,
// and the local re-analysis of the listings already obtained once the owner answers. Generic by construction: nothing here knows a brand or a product line.
// Rules: every option carries the evidence it comes from; nothing is preselected; "Je ne sais pas" and "Autre" (free text) are always possible; an unknown answer changes nothing and is never asked again; a facet is asked
// only when listing-derived groups differ by more than 10 % in price; an answer never triggers a provider call by itself (a new search is a separate, explicit, capped action).
import { ACCESSORY_WORDS, CATEGORY_WORDS, FLAG, TYPE_KEYS, TYPE_LABELS, analyseListings, capacityOf, classifyListing, clusterVolumes, compareWithSupplier, fmtMl, titleWords, typeOf, volumeMl, volumesIn } from './market-radar.js';

export const MAX_QUESTIONS = 2; const PRICE_GAP = 0.10;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const eur = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const NOISE = new Set(['the', 'and', 'for', 'with', 'pour', 'avec', 'voor', 'met', 'les', 'des', 'une', 'een', 'van', 'new', 'neuf', 'nieuw', 'ml', 'cl', 'oz', 'liter', 'litre', 'black', 'white']);
const OUTSIDE = [FLAG.PACK_OR_LOT, FLAG.ACCESSORY_SUSPECTED, FLAG.PROMO_PRINTED, FLAG.NO_TEXT_OVERLAP, FLAG.TYPE_DIFFERS];
const inScope = (l, input) => !classifyListing(l, input).flags.some((f) => OUTSIDE.includes(f)); // packs, accessories, printed promos and unrelated titles never decide a question

/** A stored evidence record (what the phone keeps in the case) back to the listing shape the analysis reads. */
export function listingFromEvidence(e) {
  return { title: e?.specs?.title ?? '', seller: e?.seller ?? null, price: e?.price?.amount ?? null, currency: e?.price?.currency ?? null, url: e?.url ?? null, observedAt: e?.observedAt ?? null, query: e?.specs?.query ?? null, queryVia: e?.specs?.queryVia ?? null, productId: e?.specs?.productId ?? null };
}

/** A size typed by the owner ("64 oz", "1,89 L", "710ml"): used only when all the volumes written agree. */
export function parseCapacityText(text) { const c = clusterVolumes(volumesIn(text)); return c.length === 1 && c[0] >= 50 && c[0] <= 5000 ? Math.round(c[0]) : null; }
const wordsOf = (text) => norm(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && w.length <= 20).slice(0, 3);

/** Owner answers, cleaned: a size (millilitres, or typed text), a model code, a variant (words). Anything else is dropped. null = nothing confirmed ("Je ne sais pas"). */
export function sanitizeConfirmed(raw) {
  if (!raw || typeof raw !== 'object') return null; const out = {};
  const ml = Number(raw.capacityMl); if (Number.isFinite(ml) && ml >= 50 && ml <= 5000) out.capacityMl = Math.round(ml); else if (typeof raw.capacityText === 'string') { const t = parseCapacityText(raw.capacityText); if (t) out.capacityMl = t; }
  if (TYPE_KEYS.includes(raw.productType)) out.productType = raw.productType;
  const m = String(raw.model ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().toUpperCase(); if (/^[A-Z0-9][A-Z0-9 ._-]{2,39}$/.test(m)) out.model = m;
  const v = raw.variant && typeof raw.variant === 'object' ? raw.variant : null;
  const tokens = v && Array.isArray(v.tokens) ? v.tokens.map((t) => String(t).toLowerCase()).filter((t) => /^[a-z0-9]{2,20}$/.test(t)).slice(0, 3) : typeof raw.variantText === 'string' && !/[<>{}\\\u0000-\u001f]/.test(raw.variantText) ? wordsOf(raw.variantText) : [];
  if (tokens.length) out.variant = { key: tokens.join(' '), label: String(v?.label ?? (raw.variantText ?? tokens.join(' '))).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40) || tokens.join(' '), tokens };
  return Object.keys(out).length ? out : null;
}

/** A VARIANT facet read from the titles actually observed (never from a list written in advance): words that exclude each other (no title carries two of them), each seen in >= 2 in-scope listings, whose groups
 *  differ by more than 10 % in median price. Colours and the like fail the price test and are therefore never asked. Returns { values:[{key,label,tokens,count,medianEur}] } or null. */
export function detectVariantFacet(listings, input) {
  const bt = new Set(norm(input?.brand).split(/[^a-z0-9]+/).filter(Boolean)); const nameW = titleWords(input?.name ?? '');
  const pool = (listings ?? []).filter((l) => Number(l.price) > 0 && l.title && inScope(l, input)); if (pool.length < 6) return null;
  const words = pool.map((l) => titleWords(l.title)); const seq = pool.map((l) => norm(l.title).split(/[^a-z0-9]+/).filter(Boolean)); const idx = new Map();
  words.forEach((ws, i) => { for (const w of ws) { if (w.length < 3 || /^\d/.test(w) || bt.has(w) || nameW.has(w) || NOISE.has(w) || CATEGORY_WORDS.has(w) || ACCESSORY_WORDS.has(w)) continue; (idx.get(w) ?? idx.set(w, []).get(w)).push(i); } });
  const cands = [...idx.entries()].filter(([, a]) => a.length >= 3 && a.length <= pool.length * 0.7) /* a variant seen in fewer than 3 listings could never give a price (minimum 3 per group): it is not worth a question */.sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1));
  const disjoint = (a, b) => !a.some((i) => b.includes(i)); let best = null;
  for (const [seedW, seedA] of cands.slice(0, 10)) {
    const members = [[seedW, seedA]]; for (const [w, a] of cands) { if (w !== seedW && members.every(([, ma]) => disjoint(ma, a))) members.push([w, a]); }
    if (members.length < 2) continue;
    // alternatives of the SAME slot share a neighbouring word ("wide mouth" / "standard mouth"): without one the words are just different parts of different names (e.g. "mouth" vs "flex") and no facet is asked
    const neigh = (w, ids) => { const m = new Map(); for (const i of ids) { const sq = seq[i]; const at = sq.indexOf(w); if (at < 0) continue; for (const [j, side] of [[at - 1, 'before'], [at + 1, 'after']]) { const n = sq[j]; if (n && n.length >= 3 && !/^\d/.test(n) && !bt.has(n) && !NOISE.has(n) && n !== w) m.set(`${side}:${n}`, (m.get(`${side}:${n}`) ?? 0) + 1); } } return m; };
    const need = (ids) => Math.max(2, Math.ceil(ids.length * 0.6)); const maps = members.map(([w, ids]) => neigh(w, ids)); let shared = null; let sub = null;
    for (const k of maps[0].keys()) { const keep = members.filter(([, ids], i) => (maps[i].get(k) ?? 0) >= need(ids)); if (keep.length >= 2) { shared = k; sub = keep; break; } }
    if (!shared) continue; const [side, nword] = shared.split(':');
    const vals = sub.map(([w, ids]) => ({ key: w, label: side === 'after' ? `${w[0].toUpperCase()}${w.slice(1)} ${nword}` : `${nword[0].toUpperCase()}${nword.slice(1)} ${w}`, tokens: [w], count: ids.length, medianEur: median(ids.map((i) => Number(pool[i].price))) })).sort((x, y) => y.count - x.count);
    const meds = vals.map((v) => v.medianEur); const gap = Math.max(...meds) / Math.min(...meds) - 1; if (!(gap > PRICE_GAP)) continue;
    const score = vals.reduce((n, v) => n + v.count, 0); if (!best || score > best.score) best = { score, values: vals };
  }
  return best ? { values: best.values } : null;
}

/** Analysis in two passes so that a facet found among the comparable listings can then group and label them (the facet is searched on what is left after the owner's confirmed size / model, not on accessories or other sizes). */
export function analyseWithFacets(listings, input, { ecb = null } = {}) {
  const conf = input.confirmed ?? null; const first = analyseListings(listings, conf?.variant ? { ...input, confirmed: { ...conf, variant: undefined } } : input, { ecb });
  const pool = first.listings.filter((r) => !r.excludedFromReference).map((r) => listings[Number(r.id.slice(1)) - 1]);
  const facet = detectVariantFacet(pool, input); const analysis = analyseListings(listings, facet ? { ...input, variantFacet: facet } : input, { ecb });
  return { analysis, facet };
}

/** At most MAX_QUESTIONS in all, one at a time: size, then variant, then model. Each is asked only when the evidence offers a real choice that moves the price. Returns null when nothing is uncertain, when the limit is reached,
 *  or when the facet was already confirmed / declined ("Je ne sais pas"). */
export function proposeQuestion({ input, listings = [], facet = undefined, asked = 0, declined = [], answered = false } = {}) {
  if (answered || asked >= MAX_QUESTIONS) return null; const conf = input?.confirmed ?? {}; const no = (id) => declined.includes(id);
  if (!capacityOf(input) && !no('capacity')) { // the size is unknown: ask only when the evidence shows at least two different sizes that differ in price
    const seen = new Map(); const add = (ml, why, price) => { const k = [...seen.keys()].find((x) => Math.abs(x - ml) / x <= 0.03) ?? ml; const e = seen.get(k) ?? { ml: k, why: [], listings: 0, prices: [] }; if (why === 'listing') { e.listings += 1; if (price > 0) e.prices.push(price); } else if (!e.why.includes(why)) e.why.push(why); seen.set(k, e); };
    for (const c of input?.capacityCandidates ?? []) add(c.ml, 'lu sur l’étiquette');
    for (const l of listings) { const ml = volumeMl(l.title); if (ml && inScope(l, input)) add(ml, 'listing', Number(l.price)); }
    const opts = [...seen.values()].filter((e) => e.why.length || e.listings >= 2).sort((a, b) => (b.why.length - a.why.length) || (b.listings - a.listings));
    const fromLabel = opts.some((o) => o.why.length); const meds = opts.map((o) => median(o.prices)).filter((x) => x != null); const gap = meds.length >= 2 ? Math.max(...meds) / Math.min(...meds) - 1 : 0;
    if (clusterVolumes(opts.map((o) => o.ml)).length >= 2 && (fromLabel || gap > PRICE_GAP)) return { id: 'capacity', prompt: 'Quelle est la taille de votre produit ?', unknownLabel: 'Je ne sais pas', allowOther: true, otherKind: 'capacity', otherPlaceholder: 'ex. 64 oz ou 1,89 L',
      options: opts.map((o) => ({ value: { capacityMl: Math.round(o.ml) }, label: fmtMl(o.ml), evidence: [...o.why, ...(o.listings ? [`vu dans ${o.listings} annonce(s)`] : []), ...(o.prices.length ? [`prix médian ${eur(median(o.prices))}`] : [])].join(' · ') })) };
  }
  const ptype = input?.productType ?? typeOf(input?.name, input?.brand); // the KIND of product: asked only when the case does not say it and the listings show two kinds that differ in price
  if (!ptype && !conf.productType && !no('type')) {
    const byType = new Map(); for (const l of listings) { const t = typeOf(l.title, input?.brand); if (t && Number(l.price) > 0 && inScope(l, input)) (byType.get(t) ?? byType.set(t, []).get(t)).push(Number(l.price)); }
    const kinds = [...byType.entries()].filter(([, ps]) => ps.length >= 2).sort((a, b) => b[1].length - a[1].length); const meds = kinds.map(([, ps]) => median(ps));
    if (kinds.length >= 2 && Math.max(...meds) / Math.min(...meds) - 1 > PRICE_GAP) return { id: 'type', prompt: 'De quel type de produit s’agit-il ?', unknownLabel: 'Je ne sais pas', allowOther: false,
      options: kinds.map(([k, ps]) => ({ value: { productType: k }, label: TYPE_LABELS[k], evidence: `vu dans ${ps.length} annonce(s) · prix médian ${eur(median(ps))}` })) };
  }
  const f = facet === undefined ? detectVariantFacet(listings, input) : facet;
  if (f && !conf.variant && !no('variant')) return { id: 'variant', prompt: 'Quelle variante est votre produit ?', unknownLabel: 'Je ne sais pas', allowOther: true, otherKind: 'variant', otherPlaceholder: 'ex. le mot qui la distingue',
    options: f.values.map((v) => ({ value: { variant: { key: v.key, label: v.label, tokens: v.tokens } }, label: v.label, evidence: `vu dans ${v.count} annonce(s) · prix médian ${eur(v.medianEur)}` })) };
  if (!input?.model && !conf.model && !no('model') && (input?.modelCandidates ?? []).length >= 2) return { id: 'model', prompt: 'Quel est le modèle de votre produit ?', unknownLabel: 'Je ne sais pas', allowOther: true, otherKind: 'model', otherPlaceholder: 'ex. la référence imprimée',
    options: input.modelCandidates.map((m) => ({ value: { model: m }, label: m, evidence: 'lu sur l’étiquette' })) };
  return null;
}

/** Re-analyses the listings already obtained with the owner's answers (accumulated). Pure: no network, no cost. "Unknown" (null) keeps the ordinary, non-strict classification. */
export function refine({ listings, input, confirmed, ecb = null, supplier = null, asked = 0, declined = [] }) {
  const c = sanitizeConfirmed(confirmed); const inp = { ...input, ...(c ? { confirmed: c, ...(c.model ? { model: c.model } : {}), ...(c.productType ? { productType: c.productType } : {}) } : {}) };
  const { analysis, facet } = analyseWithFacets(listings, inp, { ecb }); const comparison = compareWithSupplier({ reference: analysis.reference, supplier, ecb });
  return { analysis, comparison, confirmed: c, input: inp, facet, question: proposeQuestion({ input: inp, listings, facet, asked, declined }) };
}
export const _test = { fmtMl, norm };
