// MARKET RADAR controller (phone). Moved out of app.js WITHOUT any change of behaviour (same state keys on S, same server routes, same events, same consent flow) so that the app controller stays under its size guard.
// Search from the case, or from a PHOTO of the case; the owner's one-tap answers (size / type / variant / model, free text "Autre", "Je ne sais pas") are re-read on the server for free; a paid new search only on an explicit button.
import { detectBarcode, prepareForUpload } from './barcode-local.js';
import { buildSearchInput, outgoingFields } from '/core/market-search.js';
import { buildProductHypothesis } from '/core/product-hypothesis.js';

export function createMarketController({ S, cur, api, commit, render, getBlob }) {
  // ---- market radar: search from the case, or from a PHOTO of the case. A local barcode read sends no photo; a photo goes to Google Cloud Vision ONLY after an explicit consent card for THAT photo (server checks the consent is bound to its sha-256).
  let marketPending = null; // { i, up }: the downscaled photo held in memory while the owner decides; never stored in the case
  const marketStatusOnce = async () => { if (S.marketStatus) return S.marketStatus; try { S.marketStatus = await api('/api/market/status'); } catch { S.marketStatus = { enabled: false, photoIdentification: { enabled: false } }; } return S.marketStatus; };
  async function marketSearch({ identification = null, photo = null, confirmed = null }) { // paid search through the server (credentials stay there); one at a time; a failure never touches the case
    if (S.marketBusy) return; const c = cur(); const input = buildSearchInput(c, buildProductHypothesis(c)); const q = c.quotes?.at(-1); const sp = q && q.unitPrice !== undefined && q.unitPrice !== '' ? Number(String(q.unitPrice).replace(',', '.')) : NaN;
    S.marketBusy = true; S.flash = ''; render();
    try {
      const r = await api('/api/market/search', { method: 'POST', body: JSON.stringify({ input: { name: input.name, brand: input.brand, model: input.model, manufacturerRef: input.manufacturerRef, gtin: input.gtin, traits: input.traits, category: input.category }, identification, confirmed, supplier: Number.isFinite(sp) ? { price: sp, currency: q.currency ?? null } : null, country: 'BE' }) });
      commit({ type: 'MARKET_SEARCH', status: 'DONE', provider: r.provider, input, outgoing: outgoingFields(input), consent: true, evidence: r.stored, note: null, radar: { market: r.market, queries: r.queries, summary: r.summary, groups: r.groups, indicative: r.indicative, reference: r.reference, comparison: r.comparison, marketplaces: r.marketplaces, observedAt: r.observedAt, cached: r.cached, partial: r.partial, cost: r.cost, notes: r.notes, question: r.question ?? null, confirmation: confirmed ? { at: new Date().toISOString(), answered: 'owner-confirmed-new-search', value: confirmed, unknown: false, accumulated: confirmed, asked: 0, declined: [] } : null, identification: r.identification ? { ...r.identification, photo } : null } });
      S.flash = r.cached ? 'Résultat déjà obtenu récemment : aucune nouvelle recherche n’a été payée.' : '';
    } catch (e) { S.flash = e.body?.message ?? (e.status ? `La recherche a échoué (${e.status}). Rien n’a été modifié.` : 'Pas de connexion au serveur : la recherche n’a pas eu lieu et rien n’a été perdu. Réessayez avec du réseau.'); }
    finally { S.marketBusy = false; render(); }
  }
  // the owner's one-tap answer (size, variant or model), a free-text "Autre", or "Je ne sais pas": the listings ALREADY obtained are re-read on the server (pure computation: no provider call, no cost, no photo).
  // At most 2 questions in all; answers accumulate; a "Je ne sais pas" is remembered so the same facet is never asked again.
  async function marketAnswer(key, otherText = null) {
    if (S.marketBusy) return; const c = cur(); const last = (c.marketSearches ?? []).filter((x) => x.radar).at(-1); const q = last?.radar?.question; if (!last || !q) return;
    const prev = last.radar.confirmation ?? {}; const acc0 = prev.accumulated ?? {}; const declined0 = prev.declined ?? []; const asked0 = prev.asked ?? 0; let value;
    if (otherText !== null) { const t = String(otherText).trim(); if (!t) { S.flash = 'Écrivez la valeur dans « Autre », ou choisissez une option.'; return render(); } value = q.otherKind === 'capacity' ? { capacityText: t } : q.otherKind === 'model' ? { model: t } : { variantText: t }; }
    else value = key === 'unknown' ? null : q.options?.[Number(key)]?.value;
    if (value === undefined) return;
    const input = last.input ?? {}; const qt = c.quotes?.at(-1); const sp = qt && qt.unitPrice !== undefined && qt.unitPrice !== '' ? Number(String(qt.unitPrice).replace(',', '.')) : NaN;
    const acc = value ? { ...acc0, ...value } : acc0; const declined = value ? declined0 : [...declined0, q.id]; const asked = asked0 + 1;
    S.marketBusy = true; S.flash = ''; render();
    try {
      const r = await api('/api/market/refine', { method: 'POST', body: JSON.stringify({ evidence: last.evidence, input: { name: input.name, brand: input.brand, model: input.model, gtin: input.gtin, traits: input.traits }, identification: last.radar.identification ?? null, confirmed: Object.keys(acc).length ? acc : null, asked, declined, supplier: Number.isFinite(sp) ? { price: sp, currency: qt.currency ?? null } : null, country: 'BE' }) });
      const cf = r.input?.confirmed ?? null; const kept = q.otherKind === 'capacity' ? cf?.capacityMl : q.otherKind === 'model' ? cf?.model : cf?.variant;
      if (otherText !== null && !kept) { S.flash = q.otherKind === 'capacity' ? 'Taille non comprise : écrivez-la avec son unité (ex. 64 oz, 1,89 L, 710 ml).' : 'Valeur non comprise : réessayez avec quelques lettres ou chiffres.'; return; }
      commit({ type: 'MARKET_SEARCH', status: 'DONE', provider: r.provider, input: last.input, outgoing: [], consent: true, evidence: r.stored, note: null, radar: { ...last.radar, summary: r.summary, groups: r.groups, indicative: r.indicative, reference: r.reference, comparison: r.comparison, marketplaces: r.marketplaces, cost: r.cost, notes: r.notes, question: r.question ?? null, cached: false, refinedFromId: last.id, confirmation: { at: new Date().toISOString(), answered: q.id, value, unknown: value === null, accumulated: cf ?? {}, asked, declined } } });
    } catch (e) { S.flash = e.body?.message ?? (e.status ? `La précision n’a pas pu être appliquée (${e.status}). Rien n’a été modifié.` : 'Pas de connexion au serveur : la précision n’a pas été appliquée et rien n’a été perdu.'); }
    finally { S.marketBusy = false; render(); }
  }
  // an explicit, capped, PAID new search that carries the owner's answer (the button says so; the server applies its cost cap, daily cap and cache)
  function marketRerun() { const c = cur(); const last = (c.marketSearches ?? []).filter((x) => x.radar).at(-1); const cf = last?.radar?.confirmation; const conf = cf?.accumulated ?? (cf && !cf.unknown ? cf.value : null); if (!conf || !Object.keys(conf).length) return; return marketSearch({ identification: last.radar.identification ? { ...last.radar.identification, photo: undefined } : null, confirmed: conf }); }
  async function marketPhotoStart(i) {
    const c = cur(); const url = getBlob(`photo:${c.id}.${i}`); if (!url) { S.flash = 'Cette photo est introuvable sur ce téléphone.'; return render(); }
    S.flash = ''; marketPending = null; S.marketPhoto = { i, stage: 'scanning' }; render();
    const bc = await detectBarcode(url); // on the phone: no network, no photo sent
    if (bc) { const identification = { source: 'LOCAL_BARCODE', eans: [bc.gtin], engine: bc.engine, format: bc.format }; S.marketPhoto = { i, stage: 'searching', ident: identification }; render(); await marketSearch({ identification, photo: { index: i, sentToProvider: false } }); S.marketPhoto = { i, stage: 'done' }; return render(); }
    const st = await marketStatusOnce();
    if (!st.photoIdentification?.enabled) { S.marketPhoto = { i, stage: 'no-code', reason: st.photoIdentification?.reason ?? null }; return render(); }
    try { const up = await prepareForUpload(url); marketPending = { i, up }; S.marketPhoto = { i, stage: 'consent', sha256: up.sha256, bytes: up.bytes, width: up.width, height: up.height, estimate: st.photoIdentification.estimatedCostPerPhotoUsd }; }
    catch { S.marketPhoto = { i, stage: 'error', msg: 'Cette photo n’a pas pu être préparée. Rien n’a été envoyé.' }; }
    render();
  }
  async function marketPhotoSend() {
    const m = S.marketPhoto; if (!marketPending || m?.stage !== 'consent') return; const { i, up } = marketPending; S.marketPhoto = { ...m, stage: 'sending' }; render();
    try {
      const res = await api('/api/market/identify', { method: 'POST', body: JSON.stringify({ imageBase64: up.imageBase64, mime: up.mime, consent: { accepted: true, sha256: up.sha256 } }) }); marketPending = null; // the bytes are dropped as soon as the answer is in
      const ident = res.identification; const photo = { index: i, sentToProvider: true, consentAt: res.consent?.at ?? null, sha256: res.consent?.sha256 ?? up.sha256, provider: res.consent?.provider ?? 'google-cloud-vision' };
      if (ident.confidence === 'HIGH' || ident.confidence === 'MEDIUM') { S.marketPhoto = { i, stage: 'searching', ident, photo }; render(); await marketSearch({ identification: ident, photo }); S.marketPhoto = { i, stage: 'done' }; }
      else if (ident.confidence === 'LOW') S.marketPhoto = { i, stage: 'confirm', ident, photo };
      else S.marketPhoto = { i, stage: 'none' };
    } catch (e) { marketPending = null; S.marketPhoto = { i, stage: 'error', msg: e.body?.message ?? (e.status ? `L’analyse a échoué (${e.status}).` : 'Pas de connexion au serveur : la photo n’a pas été envoyée.') }; }
    render();
  }
  async function marketPhotoGo() { const m = S.marketPhoto; if (m?.stage !== 'confirm') return; S.marketPhoto = { i: m.i, stage: 'searching', ident: m.ident }; render(); await marketSearch({ identification: m.ident, photo: m.photo }); S.marketPhoto = { i: m.i, stage: 'done' }; render(); }
  // PERMANENT "Préciser": a size / model / variant typed by the owner (same server validations as "Autre"), applied to the listings already obtained: free, no question consumed, nothing sent, nothing paid.
  async function marketPrecise() {
    if (S.marketBusy) return; const c = cur(); const last = (c.marketSearches ?? []).filter((x) => x.radar).at(-1); if (!last) return;
    const val = (k) => String(document.querySelector(`[data-prec="${k}"]`)?.value ?? '').trim();
    const value = Object.fromEntries(Object.entries({ capacityText: val('capacity'), model: val('model'), variantText: val('variant') }).filter(([, v]) => v));
    if (!Object.keys(value).length) { S.flash = 'Écrivez au moins une valeur (taille, modèle ou variante).'; return render(); }
    const prev = last.radar.confirmation ?? {}; const asked0 = prev.asked ?? 0; const declined0 = prev.declined ?? []; const acc = { ...(prev.accumulated ?? {}) };
    if (value.capacityText) delete acc.capacityMl; if (value.variantText) delete acc.variant; Object.assign(acc, value); // a newly typed value replaces the earlier one for the same facet
    const input = last.input ?? {}; const qt = c.quotes?.at(-1); const sp = qt && qt.unitPrice !== undefined && qt.unitPrice !== '' ? Number(String(qt.unitPrice).replace(',', '.')) : NaN;
    S.marketBusy = true; S.flash = ''; render();
    try {
      const r = await api('/api/market/refine', { method: 'POST', body: JSON.stringify({ evidence: last.evidence, input: { name: input.name, brand: input.brand, model: input.model, gtin: input.gtin, traits: input.traits }, identification: last.radar.identification ?? null, confirmed: acc, asked: asked0, declined: declined0, supplier: Number.isFinite(sp) ? { price: sp, currency: qt.currency ?? null } : null, country: 'BE' }) });
      const cf = r.input?.confirmed ?? {}; const missing = [];
      if (value.capacityText && !cf.capacityMl) missing.push('taille (avec son unité : 64 oz, 1,89 L, 710 ml)'); if (value.model && !cf.model) missing.push('modèle'); if (value.variantText && !cf.variant) missing.push('variante');
      if (missing.length) { S.flash = `Non compris : ${missing.join(', ')}. Rien n’a été modifié.`; return; }
      commit({ type: 'MARKET_SEARCH', status: 'DONE', provider: r.provider, input: last.input, outgoing: [], consent: true, evidence: r.stored, note: null, radar: { ...last.radar, summary: r.summary, groups: r.groups, indicative: r.indicative, reference: r.reference, comparison: r.comparison, marketplaces: r.marketplaces, cost: r.cost, notes: r.notes, question: r.question ?? null, cached: false, refinedFromId: last.id, confirmation: { at: new Date().toISOString(), answered: 'precise', value, unknown: false, accumulated: cf, asked: asked0, declined: declined0 } } });
    } catch (e) { S.flash = e.body?.message ?? (e.status ? `La précision n’a pas pu être appliquée (${e.status}). Rien n’a été modifié.` : 'Pas de connexion au serveur : la précision n’a pas été appliquée et rien n’a été perdu.'); }
    finally { S.marketBusy = false; render(); }
  }
  const ACTS = {
    'market-precise': () => marketPrecise(),
    'market-run': () => marketSearch({}), 'market-answer': (key) => marketAnswer(key), 'market-other': () => marketAnswer(null, document.querySelector('[data-other-input]')?.value ?? ''), 'market-rerun': () => marketRerun(),
    'market-photo': (key) => marketPhotoStart(Number(key)), 'market-photo-send': () => marketPhotoSend(), 'market-photo-go': () => marketPhotoGo(),
    'market-photo-cancel': () => { marketPending = null; S.marketPhoto = null; S.flash = ''; render(); },
  };
  /** @returns {boolean} true when `act` is a market radar action (handled here) */
  return { handle(act, key) { const h = ACTS[act]; if (!h) return false; h(key); return true; } };
}
