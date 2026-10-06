// P5: the CONVERSATION ENGINE (pure, deterministic, offline, no provider). It turns the case + its assessment into "where are we in the talk with the supplier":
//   known (what was said and confirmed, with its provenance) / missing / contradictory / what matters / the best NEXT question / a progress message.
// It never asks the owner to drive an engine: everything is recomputed from the case every time, so nothing has to be "launched". It never turns a supplier statement into evidence, never invents
// Chinese (a text has a review state, or is UNAVAILABLE), and never asks the OWNER something unless it blocks the next action (no questionnaire).
// Questions are of two audiences: SUPPLIER (a French reading text for the owner + the supplier's language) and USER (a small answer card for the owner). The supplier language and phrasebook come
// from a market PROFILE (China today), and a translation/speech PROVIDER can be plugged in later through `opts.providers`; without one the supplier text is UNAVAILABLE rather than guessed.
import { upgradeCase } from './upgrade.js';
import { documentStatusOf, FACT_STATUS } from './provenance.js';
import { conflictText } from './conversation.js';
import { effectiveQuote } from './offers.js';
import { describeFact, labelOf } from './candidate-view.js';
import { REVIEW, DEFAULT_PROFILE, MARKET_PROFILES, SUGGESTED, frText, templateOf, docNameFr, conflictPhrases, reasonFr, shortFr } from './phrases.js';

export { REVIEW };
const kc = (key, ctx) => (ctx && ctx !== 'product' ? `${key}@${ctx}` : key);
const PRIORITY = { P1: 0, P2: 100, P3: 200 };
const DIM = { CONFLICT: 0, IDENTITY: 1, COMMERCIAL: 2, ROLE: 3, REGULATORY: 3.5, DOCUMENTS: 4, COST: 5, DECISION: 6 };
// the facts that answer a V0 question (ledger / candidate keys; a context follows @)
const RESOLVES = { model: ['identifier.model'], manufacturer: ['identifier.manufacturer'], price: ['quote.unitPrice', 'quote.tiers'], incoterm: ['quote.incoterm'], lead_time: ['quote.leadTime'], carton: ['carton.qty', 'carton.dimensions', 'carton.grossWeight'], sample: ['quote.samplePrice'] };
const DOC_CLAIM = { EU_DOC: 'CE', UN383: 'UN383', ROHS_EVIDENCE: 'ROHS', REACH_EVIDENCE: 'REACH', SDS: 'SDS', BATTERY_DOC: 'IEC62133', TEST_REPORT: 'TEST_REPORT' };
const DIM_OF = { model: 'IDENTITY', manufacturer: 'IDENTITY', eu_party: 'ROLE', brand: 'ROLE', price: 'COMMERCIAL', incoterm: 'COMMERCIAL', lead_time: 'COMMERCIAL', carton: 'COMMERCIAL', sample: 'COMMERCIAL', quality_inspection: 'COMMERCIAL', hs: 'REGULATORY' };
const ACTIVE = new Set(['OPEN', 'UNANSWERED']);

const supplierText = (profile, providers, fr, zhV0, texts = {}) => {
  // what the supplier reads. Order of preference: a fixed sentence of the phrasebook (V0 = technically checked, V1 = unreviewed), a provider translation (labelled MACHINE), otherwise nothing.
  if (zhV0 && profile.phrasebook === 'cn') return { text: zhV0.text, review: zhV0.review, lang: profile.supplierLang };
  const t = providers?.translation?.translate?.({ text: fr, from: 'fr', to: profile.supplierLang });
  if (t?.text) return { text: t.text, review: REVIEW.MACHINE, provider: t.provider ?? 'provider', lang: profile.supplierLang };
  void texts; return { text: null, review: REVIEW.UNAVAILABLE, lang: profile.supplierLang };
};

/** The pending/waiting/asked state of a question, from the case alone. */
function stateOf({ id, resolves, pendingKeys, log, items }) {
  if (resolves?.some((k) => pendingKeys.has(k))) return 'ANSWER_PENDING';
  const last = [...log].reverse().find((e) => e.questionId === id); if (!last) return 'OPEN';
  const later = items.some((it) => it.speaker === 'supplier' && it.at > last.at);
  if (last.kind === 'SHOWN') return later ? 'UNANSWERED' : 'ASKED';
  if (last.kind === 'SKIPPED') return later ? 'OPEN' : 'SKIPPED';
  return 'OPEN';
}

export function planConversation(rawState, A, opts = {}) {
  const st = upgradeCase(rawState); const profile = opts.profile ?? MARKET_PROFILES[st.context?.originMarket ?? 'CN'] ?? DEFAULT_PROFILE; const providers = opts.providers ?? {};
  const items = st.conversations.flatMap((c) => c.items.map((it) => ({ ...it, convId: c.id }))); const log = st.questionLog ?? [];
  const confirmed = st.candidates.filter((c) => c.state === 'CONFIRMED' || c.state === 'CORRECTED'); const confirmedKeys = new Set(confirmed.map((c) => kc(c.key, c.context)));
  const proposed = st.candidates.filter((c) => c.state === 'PROPOSED'); const pendingKeys = new Set(proposed.map((c) => kc(c.key, c.context)));
  const model = st.identity?.identifiers?.model ?? null; const quote = st.quotes.at(-1) ? effectiveQuote(st.quotes.at(-1)) : null;
  const qs = []; const add = (q) => { qs.push({ resolves: [], reason: { fr: '', en: '' }, repeat: false, ...q }); };

  // ---- 1. V0 questions (generated from what is missing), bundled documents -------------------------------------------------------------------------------------------------------
  const docItems = []; const docFixes = [];
  for (const v of A.questions) {
    const tpl = templateOf(v.id); const params = { model: model ?? '(modèle pas encore connu)', qty: parseQty(v), docType: v.docType, refs: parseRefs(v) };
    const fr = frText(v.id, params) ?? v.en;
    if (v.id.startsWith('doc:') && !v.id.endsWith(':fix')) { docItems.push({ id: v.id, docType: v.docType, priority: v.priority, fr, en: v.en, zh: v.zh, why: v.why }); continue; }
    if (v.id === 'brand') continue; // the OWNER decides whether to sell under their own brand: an owner card below, not a supplier question
    const zh = supplierText(profile, providers, fr, { text: v.zh, review: REVIEW.TECHNICAL_ONLY });
    const resolves = RESOLVES[v.id] ?? [];
    const q = { id: v.id, source: tpl === 'doc_fix' ? 'ENGINE' : 'ENGINE', audience: 'SUPPLIER', dimension: tpl === 'doc_fix' ? 'DOCUMENTS' : (DIM_OF[v.id] ?? 'REGULATORY'), priority: v.priority, blocksOrder: (v.blocks ?? []).includes('IMPORT') || (v.blocks ?? []).includes('PRICE'), text: { fr, en: v.en }, supplier: { zh, en: v.en }, resolves, reason: { fr: reasonFr(v.id), en: v.why } };
    if (tpl === 'doc_fix') docFixes.push(q); else add(q);
  }
  for (const q of docFixes) add(q);
  if (docItems.length) {
    const waiting = []; const open = [];
    for (const it of docItems) { const claim = DOC_CLAIM[it.docType]; const status = claim ? documentStatusOf(st, claim).status : 'NONE'; const pending = claim && pendingKeys.has(`docClaim.${claim}`); (['CLAIMED', 'PROMISED'].includes(status) ? waiting : open).push({ ...it, claim, docStatus: status, pending: !!pending }); }
    const shown = open.length ? open : waiting; const head = `Pouvez-vous m'envoyer ces documents pour le modèle ${model ?? '(modèle à préciser)'} :`;
    const fr = `${head}\n${shown.map((i) => `- ${i.fr.replace(/^Pouvez-vous m'envoyer /, '').replace(/ \?$/, '')}`).join('\n')}`;
    const zhText = shown.map((i) => i.zh).join('\n');
    const zh = profile.phrasebook === 'cn' ? { text: zhText, review: REVIEW.TECHNICAL_ONLY, lang: profile.supplierLang } : supplierText(profile, providers, fr, null);
    const claimKeys = [...open, ...waiting].map((i) => i.claim && `docClaim.${i.claim}`).filter(Boolean);
    add({ id: 'docs-bundle', source: 'ENGINE', audience: 'SUPPLIER', dimension: 'DOCUMENTS', priority: docItems.some((i) => i.priority === 'P1') ? 'P1' : 'P2', blocksOrder: true, text: { fr, en: `Please send these documents for model ${model ?? '(to be specified)'}:\n${shown.map((i) => `- ${i.en.replace(/^Please send /, '').replace(/\.$/, '')}`).join('\n')}` }, supplier: { zh, en: shown.map((i) => i.en).join('\n') },
      items: shown.map((i) => ({ id: i.id, docType: i.docType, fr: i.fr, en: i.en, zh: i.zh })), waiting: waiting.map((i) => ({ id: i.id, docType: i.docType, claim: i.claim, status: i.docStatus })), resolves: claimKeys, forcedState: open.length ? null : 'WAITING',
      reason: { fr: "Sans ces documents, aucune commande n'est possible.", en: 'Without these documents no order is possible.' } });
  }

  // ---- 2. suggested commercial questions (only when useful: a price exists, the owner sells under own brand for logo/packaging...) ----------------------------------------------------
  const priceKnown = !!(quote?.unitPrice) && !A.questions.some((v) => v.id === 'price'); const has = (k) => confirmedKeys.has(k);
  const suggest = (id, when) => { const t = SUGGESTED[id]; if (!when || t.resolves.some((k) => has(k))) return; add({ id: `s:${id}`, source: 'SUGGESTED', audience: 'SUPPLIER', dimension: t.dimension, priority: t.priority, blocksOrder: false, text: { fr: t.fr, en: t.en }, supplier: { zh: profile.phrasebook === 'cn' ? { text: t.zh, review: REVIEW.UNREVIEWED, lang: profile.supplierLang } : supplierText(profile, providers, t.fr, null), en: t.en }, resolves: t.resolves, reason: { fr: 'Utile pour comparer ou négocier cette offre.', en: 'Useful to compare or negotiate this offer.' } }); };
  suggest('price_tiers', priceKnown && !quote?.tiers?.length && !!quote?.moq);
  suggest('payment', priceKnown && !quote?.payment?.depositPct);
  suggest('colours', priceKnown);
  suggest('mixed_colours', priceKnown && confirmed.some((c) => c.key === 'variant.colours' && Array.isArray(c.correctedValue ?? c.value) && (c.correctedValue ?? c.value).length > 1));
  suggest('logo', priceKnown && st.placing?.underOwnNameOrBrand === true);
  suggest('packaging', priceKnown && st.placing?.underOwnNameOrBrand === true);

  // ---- 3. contradictions ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  const contradictions = [];
  for (const c of st.conflicts.filter((x) => x.state === 'OPEN')) {
    const ph = conflictPhrases(c); const qid = `conflict:${c.id}`; contradictions.push({ id: c.id, key: c.key, text: { fr: ph.fr, en: ph.en }, questionId: qid, conflictId: c.id, entries: c.entries });
    add({ id: qid, source: 'CONFLICT', audience: 'SUPPLIER', dimension: 'CONFLICT', priority: 'P1', blocksOrder: true, text: { fr: ph.fr, en: ph.en }, supplier: { zh: { text: ph.zh, review: ph.review, lang: profile.supplierLang }, en: ph.en }, resolves: [], conflictId: c.id, reason: { fr: 'Deux informations se contredisent : il faut trancher avant de continuer.', en: 'Two statements contradict each other.' } });
  }

  // ---- 4. the owner's own free questions (never pushed as "next") ------------------------------------------------------------------------------------------------------------------
  for (const u of st.userQuestions) {
    const zh = u.lang === 'zh' ? { text: u.text, review: REVIEW.NATIVE_REVIEWED, lang: 'zh', author: 'USER' } : supplierText(profile, providers, u.text, null);
    add({ id: u.id, source: 'USER_FREE', audience: 'SUPPLIER', dimension: 'COMMERCIAL', priority: 'P2', blocksOrder: false, text: { fr: u.text, en: u.lang === 'en' ? u.text : null }, supplier: { zh, en: u.lang === 'en' ? u.text : null }, resolves: [], forcedState: u.state === 'ANSWERED' ? 'ANSWERED' : u.state === 'ASKED' ? 'ASKED' : null, reason: { fr: 'Votre question.', en: 'Your question.' } });
  }

  // ---- 5. owner cards: contextual, one at a time, only when they block the next action -----------------------------------------------------------------------------------------------
  const basicsOpen = A.questions.some((v) => ['model', 'manufacturer', 'price', 'incoterm'].includes(v.id)); const commercialBasicsKnown = !A.questions.some((v) => v.id === 'price' || v.id === 'incoterm');
  if (!basicsOpen && A.questions.some((v) => v.id === 'brand')) add(userCard('u:brand', 'ROLE', 'P1', { fr: 'Allez-vous vendre ce produit sous votre propre nom ou marque ?', en: 'Will you sell this product under your own name or brand?' }, { kind: 'YESNO', place: 'underOwnNameOrBrand' }, { fr: 'Cela décide qui porte les obligations du fabricant.', en: 'It decides who carries the manufacturer duties.' }));
  if (commercialBasicsKnown && (quote?.unitPrice ?? false)) {
    const cu = new Set(A.landed.criticalUnknown ?? []);
    if (cu.has('costs.freight')) add(userCard('u:freight', 'COST', 'P1', { fr: 'Quel est le coût total du transport (EUR), même approximatif ?', en: 'What is the total freight cost (EUR), even roughly?' }, { kind: 'NUMBER', field: 'freight', unit: 'EUR' }, { fr: 'Sans transport, le coût réel ne peut pas être calculé.', en: 'Without freight the landed cost cannot be calculated.' }));
    if (cu.has('costs.customsDuty')) add(userCard('u:duty', 'COST', 'P1', { fr: 'Quel est le taux de droit de douane (%), si votre transitaire le connaît ?', en: 'What is the customs duty rate (%), if your broker knows it?' }, { kind: 'NUMBER', field: 'duty', unit: '%' }, { fr: 'Le droit de douane fait partie du coût réel.', en: 'Duty is part of the landed cost.' }));
    if ([...cu].some((k) => /^fx\./.test(k))) add(userCard('u:fx', 'COST', 'P1', { fr: 'Quel taux de change utiliser (EUR pour 1 unité de la devise du fournisseur) ?', en: 'Which exchange rate to use (EUR for 1 unit of the supplier currency)?' }, { kind: 'NUMBER', field: 'fx', unit: 'EUR' }, { fr: 'Nécessaire pour convertir le prix du fournisseur en euros.', en: 'Needed to convert the supplier price into euros.' }));
    if (A.landed.status !== 'INFORMATION_INSUFFICIENT' && A.maxPurchasePrice?.reason === 'SELLING_PRICE_NOT_ENTERED') add(userCard('u:sellingPrice', 'DECISION', 'P1', { fr: 'À quel prix comptez-vous vendre ce produit (TTC) ?', en: 'At what price do you plan to sell this product (incl. VAT)?' }, { kind: 'NUMBER', field: 'sellingPrice', unit: 'EUR' }, { fr: 'Pour calculer votre marge et le prix maximum à payer.', en: 'To compute your margin and the maximum price to pay.' }));
    else if (A.landed.status !== 'INFORMATION_INSUFFICIENT' && st.sale?.sellingPriceGross && (st.sale.targetContributionPct === undefined || st.sale.targetContributionPct === null || st.sale.targetContributionPct === '')) add(userCard('u:margin', 'DECISION', 'P1', { fr: 'Quelle marge minimale voulez-vous (% du prix hors TVA) ?', en: 'What minimum margin do you want (% of the price without VAT)?' }, { kind: 'NUMBER', field: 'margin', unit: '%' }, { fr: 'Sans marge visée, le prix maximum ne peut pas être calculé.', en: 'Without a target margin the maximum price cannot be calculated.' }));
  }
  if (commercialBasicsKnown && !basicsOpen) {
    const TR = { 'battery.present': ['Ce produit contient-il bien une batterie ?', 'Does this product contain a battery?'], 'radio.present': ['A-t-il bien le Bluetooth, le Wi-Fi ou une autre radio ?', 'Does it have Bluetooth, Wi-Fi or another radio?'], 'electrical.present': ['Est-ce bien un produit électrique ou électronique ?', 'Is it an electrical or electronic product?'] };
    let n = 0; for (const t of A.identity?.confidence?.assumedFromProfileOnly ?? []) { if (!TR[t] || n >= 2) continue; n += 1; add(userCard(`u:trait:${t}`, 'REGULATORY', 'P2', { fr: `${TR[t][0]} (déduit de la catégorie)`, en: `${TR[t][1]} (deduced from the category)` }, { kind: 'YESNO', trait: t }, { fr: 'Confirme ce qui était seulement supposé à partir de la catégorie.', en: 'Confirms what was only assumed from the category.' })); }
  }

  // ---- states, ordering, next ----------------------------------------------------------------------------------------------------------------------------------------------------------
  const out = qs.map((q, i) => { const base = q.forcedState ?? stateOf({ id: q.id, resolves: q.resolves, pendingKeys, log, items }); const state = base; return { ...q, state, repeat: state === 'UNANSWERED', short: { fr: shortFr(q.id) }, _i: i }; });
  const order = (q) => PRIORITY[q.priority] + (DIM[q.dimension] ?? 9) * 10 + (q.audience === 'USER' ? 5 : 0) + (q.repeat ? 50 : 0) + q._i / 1000;
  const candidates = out.filter((q) => ACTIVE.has(q.state) && q.source !== 'USER_FREE').sort((a, b) => order(a) - order(b));
  const questions = out.map(({ _i, forcedState, ...q }) => q).sort((a, b) => order({ ...a, _i: 0 }) - order({ ...b, _i: 0 }));
  const next = candidates[0] ? questions.find((q) => q.id === candidates[0].id) : null; const upcoming = candidates.slice(1, 4).map((c) => questions.find((q) => q.id === c.id));

  // ---- known / resolved --------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const latest = new Map(); for (const e of st.ledger) latest.set(kc(e.key, e.context), e);
  const known = [...latest.values()].map((e) => ({ ...describeFact(e, 'fr'), context: e.context, status: e.status, source: 'LEDGER', value: e.value }));
  const have = new Set(known.map((k) => k.key)); const caseFact = (key, value, context) => { if (value !== null && value !== undefined && value !== '' && !have.has(key)) known.push({ ...describeFact({ key, value, context: 'product' }, 'fr'), context: 'product', status: FACT_STATUS.USER_PROVIDED, source: 'CASE', value }); };
  caseFact('identifier.model', model); caseFact('identifier.brand', st.identity?.identifiers?.brand); caseFact('identifier.manufacturer', st.identity?.identifiers?.manufacturer); caseFact('quote.incoterm', quote?.incoterm); caseFact('quote.moq', quote?.moq); caseFact('quote.unitPrice', quote?.unitPrice); caseFact('quote.currency', quote?.currency);
  const present = new Set(questions.map((q) => q.id)); const resolved = [];
  for (const [id, keys] of Object.entries(RESOLVES)) if (!present.has(id)) { const by = keys.filter((k) => confirmedKeys.has(k)); if (by.length) resolved.push({ id, by }); }

  // ---- progress message ------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const unresolved = new Set(['OPEN', 'ASKED', 'UNANSWERED', 'SKIPPED', 'WAITING']); const missing = questions.filter((q) => q.priority === 'P1' && q.source !== 'CONFLICT' && unresolved.has(q.state));
  const missingUser = missing.filter((q) => q.audience === 'USER').length; const missingSupplier = missing.length - missingUser;
  const conflicts = contradictions.length; const pendingN = proposed.length; const verdict = A.decision.verdict;
  const residual = residualOf(st, A, conflicts); const started = !!(st.identity?.workingName || A.identity?.category || st.quotes.length || st.conversations.length);
  const stage = !started ? 'START' : verdict !== 'INSUFFICIENT_INFORMATION' ? 'EVALUABLE' : missing.length + conflicts <= 3 ? 'ALMOST' : 'GATHERING';
  const message = progressMessage({ stage, n: missing.length, s: missingSupplier, u: missingUser, conflicts, pendingN, residual });
  const timeline = [
    ...items.map((it) => ({ kind: it.speaker === 'supplier' ? 'SUPPLIER' : 'ME', at: it.at, id: it.id, original: it.original, lang: it.lang, convId: it.convId })),
    ...log.filter((e) => e.kind === 'SHOWN').map((e) => ({ kind: 'ASKED', at: e.at, id: e.id, questionId: e.questionId, texts: e.texts })),
    ...st.confirmBatches.map((b) => ({ kind: 'UNDERSTOOD', at: b.at, id: b.id, ids: b.ids, via: b.via })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { profile, userLang: opts.userLang ?? 'fr', questions, next, upcoming, known, resolved, contradictions, timeline, pending: { candidates: pendingN },
    summary: { stage, missingImportant: missing.length, missingSupplier, missingUser, conflicts, pending: pendingN, known: known.length, residual, message } };
}

function userCard(id, dimension, priority, text, answer, reason) { return { id, source: 'ENGINE', audience: 'USER', dimension, priority, blocksOrder: priority === 'P1', text, answer, resolves: [], reason }; }
const parseQty = (v) => /for (\d+) units/.exec(v.en)?.[1] ?? '';
const parseRefs = (v) => /, citing (.+?)\.?$/.exec(v.en)?.[1] ?? '';

function residualOf(st, A, conflicts) {
  const r = []; const d = A.decision; const L = A.landed;
  if (conflicts) r.push({ code: 'CONFLICT', fr: conflicts > 1 ? `${conflicts} contradictions à clarifier` : 'une contradiction à clarifier', en: 'a contradiction to clarify' });
  if (A.rules.summary.unresolved > 0 || (d.rulebookReview?.unreviewedApplicable ?? []).length || d.hardBlockers.some((b) => b.code === 'LEGAL_REQUIREMENT_UNRESOLVED')) r.push({ code: 'REGULATORY', fr: 'un risque réglementaire', en: 'a regulatory risk' });
  if ((d.gaps?.missingDocs ?? []).length) r.push({ code: 'DOCUMENTS', fr: 'des documents à obtenir', en: 'documents to obtain' });
  const freight = (L.lines ?? []).find((l) => l.key === 'freight');
  if (L.status !== 'INFORMATION_INSUFFICIENT' && (!freight || freight.status !== 'KNOWN')) r.push({ code: 'TRANSPORT', fr: 'le transport à déterminer', en: 'the transport to be determined' });
  if (A.customs?.status === 'CLASSIFICATION_REQUIRES_CONFIRMATION') r.push({ code: 'CUSTOMS', fr: 'la classification douanière à confirmer', en: 'the customs classification to confirm' });
  return r;
}
const joinFr = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} et ${xs.at(-1)}`);
function progressMessage({ stage, n, s, u, conflicts, pendingN, residual }) {
  const pend = pendingN ? { fr: ` ${pendingN} fait${pendingN > 1 ? 's' : ''} à confirmer.`, en: ` ${pendingN} fact${pendingN > 1 ? 's' : ''} to confirm.` } : { fr: '', en: '' };
  if (stage === 'START') return { fr: "Dites-moi ce qu'est le produit pour commencer.", en: 'Tell me what the product is to begin.' };
  if (conflicts) return { fr: `Il y a ${conflicts > 1 ? `${conflicts} contradictions` : 'une contradiction'} à clarifier avant de continuer.${pend.fr}`, en: `There ${conflicts > 1 ? `are ${conflicts} contradictions` : 'is a contradiction'} to clarify before going on.${pend.en}` };
  if (stage === 'EVALUABLE') { const rest = residual.filter((x) => x.code !== 'CONFLICT'); return { fr: `Analyse suffisamment complète pour une première évaluation.${rest.length ? ` Il reste ${joinFr(rest.map((x) => x.fr))}.` : ''}${pend.fr}`, en: `Analysis complete enough for a first evaluation.${rest.length ? ` Remaining: ${rest.map((x) => x.en).join(', ')}.` : ''}${pend.en}` }; }
  if (stage === 'ALMOST') return { fr: `Il me manque ${n} information${n > 1 ? 's' : ''} avant de pouvoir évaluer cet achat.${pend.fr}`, en: `I am missing ${n} piece${n > 1 ? 's' : ''} of information before I can evaluate this purchase.${pend.en}` };
  if (u > 0) return { fr: `Il me manque encore ${s ? `${s} information${s > 1 ? 's' : ''} importante${s > 1 ? 's' : ''} du fournisseur et ` : ''}${u} chose${u > 1 ? 's' : ''} à saisir de votre côté.${pend.fr}`, en: `I am still missing ${s ? `${s} important piece${s > 1 ? 's' : ''} of information from the supplier and ` : ''}${u} thing${u > 1 ? 's' : ''} for you to enter.${pend.en}` };
  return { fr: `Il me manque encore ${n} information${n > 1 ? 's' : ''} importante${n > 1 ? 's' : ''}.${pend.fr}`, en: `I am still missing ${n} important piece${n > 1 ? 's' : ''} of information.${pend.en}` };
}

// ---- owner answers -> the EXISTING events ----------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** Validates an owner answer (numbers: digits and a dot, above zero; percentages 0-100). */
export function validateAnswer(question, value) {
  const a = question.answer; if (!a) return { ok: false, error: 'This question has no answer card.' };
  if (a.kind === 'YESNO') return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'Choisissez Oui ou Non.' };
  const t = String(value ?? '').trim(); if (/,/.test(t)) return { ok: false, error: 'Utilisez un point pour les décimales (6.80), pas une virgule.' };
  if (!/^\d+(\.\d+)?$/.test(t) || Number(t) <= 0) return { ok: false, error: 'Tapez un nombre supérieur à zéro, par exemple 6.80.' };
  if (a.unit === '%' && Number(t) > 100) return { ok: false, error: 'Un pourcentage ne dépasse pas 100.' };
  return { ok: true, value: t };
}
/** The existing event(s) an owner answer compiles into. Nothing is assumed: the VAT treatment is never touched here. */
export function answerEvents(state, question, value, now = new Date()) {
  const v = validateAnswer(question, value); if (!v.ok) throw new Error(v.error); const a = question.answer; const c = state.costs ?? {};
  if (a.kind === 'YESNO') return a.place ? [{ type: 'PLACING', placing: { [a.place]: v.value } }] : [{ type: 'TRAIT', trait: a.trait, value: v.value, summary: 'confirmed by the owner' }];
  switch (a.field) {
    case 'freight': return [{ type: 'COSTS', costs: { fx: c.fx, costs: { ...(c.costs ?? {}), freight: { total: v.value, status: 'ESTIMATED' } }, importVat: c.importVat } }];
    case 'fx': return [{ type: 'COSTS', costs: { fx: { rate: v.value, date: now.toISOString().slice(0, 10), source: 'USER_ENTERED' }, costs: c.costs, importVat: c.importVat } }];
    case 'duty': return [{ type: 'CUSTOMS', customs: { duty: { ratePct: v.value, kind: 'USER_ENTERED', source: 'entered by the owner', origin: 'CN' } } }];
    case 'sellingPrice': return [{ type: 'SALE', sale: { sellingPriceGross: v.value, vatRatePct: state.sale?.vatRatePct ?? '21', targetContributionPct: state.sale?.targetContributionPct, priceBasis: 'TARGET' } }];
    case 'margin': return [{ type: 'SALE', sale: { sellingPriceGross: state.sale?.sellingPriceGross, vatRatePct: state.sale?.vatRatePct ?? '21', targetContributionPct: v.value, priceBasis: state.sale?.priceBasis ?? 'TARGET' } }];
    default: throw new Error(`unknown answer field: ${a.field}`);
  }
}
export { labelOf, conflictText, docNameFr };
