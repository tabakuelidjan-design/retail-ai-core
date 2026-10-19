// MARKET RADAR refinement (pure, NO network, NO cost): after a search, at most ONE one-tap question (the size or the model) when it is truly uncertain, and the local re-analysis of the listings already
// obtained once the owner answers. Rules: every option carries the evidence it comes from; nothing is preselected; "I don't know" is always possible (the UI adds it) and changes nothing; an answer never
// triggers a provider call by itself (a new search is a separate, explicit, capped action).
import { analyseListings, capacityOf, clusterVolumes, compareWithSupplier, volumeMl } from './market-radar.js';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fmtMl = (ml) => (ml >= 1000 ? `${(ml / 1000).toFixed(2).replace(/0$/, '').replace(/\.$/, '').replace('.', ',')} L` : `${Math.round(ml)} ml`);

/** A stored evidence record (what the phone keeps in the case) back to the listing shape the analysis reads. */
export function listingFromEvidence(e) {
  return { title: e?.specs?.title ?? '', seller: e?.seller ?? null, price: e?.price?.amount ?? null, currency: e?.price?.currency ?? null, url: e?.url ?? null, observedAt: e?.observedAt ?? null, query: e?.specs?.query ?? null, queryVia: e?.specs?.queryVia ?? null, productId: e?.specs?.productId ?? null };
}

/** Owner answers, cleaned: a size in millilitres (50..5000) and/or a model code. Anything else is dropped. null = "I don't know" (nothing confirmed). */
export function sanitizeConfirmed(raw) {
  if (!raw || typeof raw !== 'object') return null; const out = {};
  const ml = Number(raw.capacityMl); if (Number.isFinite(ml) && ml >= 50 && ml <= 5000) out.capacityMl = Math.round(ml);
  const m = String(raw.model ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().toUpperCase(); if (/^[A-Z0-9][A-Z0-9 ._-]{2,39}$/.test(m)) out.model = m;
  return Object.keys(out).length ? out : null;
}

/** At most ONE question. Capacity first (it moves the price most), then model. Returns null when nothing is uncertain, when the owner already answered, or when the evidence offers no real choice. */
export function proposeQuestion({ input, listings = [], answered = false } = {}) {
  if (answered || input?.confirmed) return null;
  if (!capacityOf(input)) { // the size is unknown: ask only when the evidence shows at least two different sizes
    const seen = new Map(); const add = (ml, why) => { const k = [...seen.keys()].find((x) => Math.abs(x - ml) / x <= 0.03) ?? ml; const e = seen.get(k) ?? { ml: k, why: [], listings: 0 }; if (why === 'listing') e.listings += 1; else if (!e.why.includes(why)) e.why.push(why); seen.set(k, e); };
    for (const c of input?.capacityCandidates ?? []) add(c.ml, 'lu sur l’étiquette');
    for (const l of listings) { const ml = volumeMl(l.title); if (ml) add(ml, 'listing'); }
    const opts = [...seen.values()].filter((e) => e.why.length || e.listings >= 2).sort((a, b) => (b.why.length - a.why.length) || (b.listings - a.listings));
    const clusters = clusterVolumes(opts.map((o) => o.ml)); // two entries that are the same size are one option
    if (clusters.length >= 2) return { id: 'capacity', prompt: 'Quelle est la taille de votre produit ?', unknownLabel: 'Je ne sais pas',
      options: opts.map((o) => ({ value: { capacityMl: Math.round(o.ml) }, label: fmtMl(o.ml), evidence: [...o.why, ...(o.listings ? [`vu dans ${o.listings} annonce(s)`] : [])].join(' · ') })) };
  }
  if (!input?.model && (input?.modelCandidates ?? []).length >= 2) return { id: 'model', prompt: 'Quel est le modèle de votre produit ?', unknownLabel: 'Je ne sais pas',
    options: input.modelCandidates.map((m) => ({ value: { model: m }, label: m, evidence: 'lu sur l’étiquette' })) };
  return null;
}

/** Re-analyses the listings already obtained with the owner's answer. Pure: no network, no cost. "Unknown" (null) keeps the ordinary, non-strict classification. */
export function refine({ listings, input, confirmed, ecb = null, supplier = null }) {
  const c = sanitizeConfirmed(confirmed); const inp = { ...input, ...(c ? { confirmed: c, ...(c.model ? { model: c.model } : {}) } : {}) };
  const a = analyseListings(listings, inp, { ecb }); const comparison = compareWithSupplier({ reference: a.reference, supplier, ecb });
  return { analysis: a, comparison, confirmed: c, input: inp };
}
export const _test = { fmtMl, norm };
