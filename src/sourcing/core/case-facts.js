// CASE FACTS: the ONE authoritative way to read and change what a case says. Conversation / Terrain, Expert / Quick and Salon are three views and controllers over the SAME case (an append-only event log
// reduced into one aggregate); none of them keeps a copy of a fact. Before this module each mode read a different projection of that aggregate (Terrain: the ledger; Expert: the quote; Salon: the candidates of
// ONE offer), so the same case could show three values. Now:
//   READ   caseFacts(state)        -> the current fact of every type: value, unit, source type, source reference, provenance, review status, revision, supersedes / superseded_by, history
//   WRITE  FACT_CORRECT / FACT_REVERT / FACT_OBSERVE / FACT_ACCEPT (events, below) -> an explicit, attributed, append-only change that every mode sees at once
// A value becomes USER_PROVIDED only through an explicit event (a correction, or a value TYPED into a form and different from what the form was showing). Showing, prefilling, parsing, merging or storing a
// value in the interface never changes who said it. Nothing is overwritten: a change appends a ledger entry that supersedes the previous one; a revert appends another; the audit trail keeps the reason.
import { existingValue, sameValue } from './conflicts.js';
import { compile } from './conversation.js';
import { effectiveQuote } from './offers.js';
import { describeCandidate, describeFact, labelOf } from './candidate-view.js';

/** Where a fact comes from. A review ACTION (confirm / correct / revert) is NOT a source: it is review_status. */
export const SOURCE_TYPE = Object.freeze({ USER_PROVIDED: 'USER_PROVIDED', SUPPLIER_CLAIM: 'SUPPLIER_CLAIM', IMAGE_OBSERVED: 'IMAGE_OBSERVED', DOCUMENT_OBSERVED: 'DOCUMENT_OBSERVED', SYSTEM_DERIVED: 'SYSTEM_DERIVED', VERIFIED: 'VERIFIED', UNATTRIBUTED_LEGACY: 'UNATTRIBUTED_LEGACY' });
export const REVIEW_STATUS = Object.freeze({ NOT_REVIEWED: 'NOT_REVIEWED', CONFIRMED: 'CONFIRMED', CORRECTED: 'CORRECTED', REVERTED: 'REVERTED', REJECTED: 'REJECTED', CONFLICT: 'CONFLICT' });
export const OBSERVED = new Set([SOURCE_TYPE.IMAGE_OBSERVED, SOURCE_TYPE.DOCUMENT_OBSERVED, SOURCE_TYPE.SYSTEM_DERIVED]);
export const MODES = Object.freeze(['terrain', 'expert', 'salon', 'system']);

const num = (v) => String(v).trim();
const int = (v) => { const t = num(v); return /^\d+$/.test(t) && Number(t) > 0 ? { ok: true, value: t } : { ok: false, error: 'Tapez un nombre entier supérieur à zéro.' }; };
const dec = (v) => { const t = num(v); if (/,/.test(t)) return { ok: false, error: 'Utilisez un point pour les décimales (6.80), pas une virgule.' }; return /^\d+(\.\d+)?$/.test(t) && Number(t) > 0 ? { ok: true, value: t } : { ok: false, error: 'Tapez un nombre supérieur à zéro, par exemple 6.80.' }; };
const text = (v) => (num(v) ? { ok: true, value: num(v) } : { ok: false, error: 'Tapez une valeur.' });
const oneOf = (list) => (v) => { const u = num(v).toUpperCase(); return list.includes(u) ? { ok: true, value: u } : { ok: false, error: `Valeurs possibles : ${list.join(', ')}.` }; };

/** The actionable fact types. `projection` = the case field the engines read for it (kept in step by the same event); no projection = the ledger is the only place it lives. */
export const FACT_TYPES = Object.freeze({
  PRICE: { key: 'quote.unitPrice', label: 'Prix unitaire', unit: 'currency', projection: 'quote', parse: dec },
  CURRENCY: { key: 'quote.currency', label: 'Devise', parse: oneOf(['USD', 'CNY', 'EUR']), projection: 'quote' },
  MOQ: { key: 'quote.moq', label: 'Minimum de commande (MOQ)', unit: 'pcs', parse: int, projection: 'quote' },
  MODEL: { key: 'identifier.model', label: 'Modèle', parse: text, projection: 'identity' },
  LEAD_TIME: { key: 'quote.leadTime', label: 'Délai de production', unit: 'days', parse: (v) => { const r = int(v); return r.ok ? { ok: true, value: { min: r.value, max: r.value, unit: 'days' } } : r; }, projection: 'quote' },
  INCOTERM: { key: 'quote.incoterm', label: 'Incoterm', parse: oneOf(['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP']), projection: 'quote' },
  PORT: { key: 'quote.port', label: 'Port ou lieu', parse: text, projection: 'quote' },
  MATERIAL: { key: 'spec.material', label: 'Matière', parse: text },
  PACKAGING: { key: 'offer.packaging', label: 'Emballage', parse: text },
  POWER: { key: 'spec.power', contexts: ['power'], label: 'Puissance', unit: 'W', parse: (v) => { const r = dec(v); return r.ok ? { ok: true, value: { amount: Number(r.value), unit: 'W' } } : r; } },
  CAPACITY: { key: 'spec.capacity', contexts: ['mah', 'wh', 'volume', 'unit_unknown'], label: 'Capacité', unit: 'mAh', parse: (v) => { const m = /^(\d+(?:\.\d+)?)\s*(mAh|Wh|ml)$/i.exec(num(v)); return m ? { ok: true, value: { amount: Number(m[1]), unit: m[2].toLowerCase() === 'mah' ? 'mAh' : m[2].toLowerCase() === 'wh' ? 'Wh' : 'ml' } } : { ok: false, error: 'Tapez la capacité avec son unité (par exemple 20000 mAh).' }; } },
  OUTPUT_COUNT: { key: 'spec.outputCount', label: 'Nombre de sorties', parse: int },
  COLOURS: { key: 'variant.colours', label: 'Couleurs', parse: (v) => { const l = [...new Set(num(v).toLowerCase().split(/[,/;&]|\s+(?:and|et|en|ou|or)\s+|\s+/).map((x) => x.trim()).filter(Boolean))]; return l.length ? { ok: true, value: l } : { ok: false, error: 'Tapez les couleurs.' }; } },
  STOCK_STATUS: { key: 'offer.stockStatus', label: 'Stock', parse: oneOf(['IN_STOCK', 'OUT_OF_STOCK']) },
});
export const FACT_KEYS = Object.freeze(Object.fromEntries(Object.entries(FACT_TYPES).map(([t, d]) => [d.key, t])));
export const typeOfKey = (key) => FACT_KEYS[key] ?? null;

const norm = (key, v) => (key === 'quote.leadTime' && v && typeof v === 'object' ? v.max : v);
const eq = (key, a, b) => (a === null || a === undefined || b === null || b === undefined ? false : sameValue(norm(key, a), norm(key, b)));
export const sameFactValue = (key, a, b) => eq(key, a, b) || JSON.stringify(a) === JSON.stringify(b);
const nextId = (prefix, list) => { let m = list.length; for (const e of list) { const n = Number(String(e.id).slice(prefix.length + 1)); if (String(e.id).startsWith(`${prefix}-`) && Number.isFinite(n) && n > m) m = n; } return `${prefix}-${m + 1}`; };

/** ledger entries of one fact, oldest first, with the voided ones marked (a void never deletes anything) */
export function ledgerOf(state, key, contexts = ['product']) {
  const voided = new Set((state.factAudit ?? []).filter((a) => a.kind === 'REVERT').map((a) => a.ledgerId));
  return (state.ledger ?? []).filter((e) => e.key === key && [].concat(contexts).includes(e.context)).map((e) => ({ ...e, voided: voided.has(e.id) }));
}
const sourceTypeOf = (e) => (e.sourceType ?? ({ SUPPLIER_CLAIM: SOURCE_TYPE.SUPPLIER_CLAIM, USER_PROVIDED: SOURCE_TYPE.USER_PROVIDED, VERIFIED: SOURCE_TYPE.VERIFIED, IMAGE_OBSERVED: SOURCE_TYPE.IMAGE_OBSERVED, DOCUMENT_OBSERVED: SOURCE_TYPE.DOCUMENT_OBSERVED, SYSTEM_DERIVED: SOURCE_TYPE.SYSTEM_DERIVED, DOCUMENT_RECEIVED: SOURCE_TYPE.DOCUMENT_OBSERVED, DOCUMENT_MATCHED: SOURCE_TYPE.DOCUMENT_OBSERVED }[e.status] ?? SOURCE_TYPE.SUPPLIER_CLAIM));
const reviewOf = (e) => (e.revertOf ? REVIEW_STATUS.REVERTED : e.corrected ? REVIEW_STATUS.CORRECTED : e.userConfirmed ? REVIEW_STATUS.CONFIRMED : REVIEW_STATUS.NOT_REVIEWED);
const entryView = (state, e, n, prev) => ({
  ledger_id: e.id, value: e.value, source_type: sourceTypeOf(e), review_status: reviewOf(e), created_at: e.confirmedAt ?? e.at ?? null, revision: n, supersedes: prev?.id ?? null, voided: e.voided === true,
  source_reference: { candidateId: e.source?.candidateId ?? null, convId: e.source?.convId ?? null, itemId: e.source?.itemId ?? null, offerId: e.offerId ?? null, rawText: e.rawText ?? null, span: e.span ?? null, mode: e.mode ?? e.source?.mode ?? null, origin: e.source?.origin ?? null, ref: e.ref ?? e.source?.ref ?? null },
  provenance: { basis: e.basis ?? null, via: e.via ?? null, kind: e.source?.kind ?? null, corrected: e.corrected === true, original: e.original ?? null, previousValue: e.previousValue ?? null, reason: e.reason ?? null, revertOf: e.revertOf ?? null },
});

/**
 * THE read model. One record per fact type that has a value. `value` is what the engines use (the case projection, or the ledger for facts that have no projection); the provenance is the ledger entry that
 * explains that value. A projection value that no ledger entry explains is shown as UNATTRIBUTED_LEGACY: it is never guessed to be anyone's word.
 */
export function caseFacts(state, { types = Object.keys(FACT_TYPES) } = {}) {
  const out = [];
  for (const type of types) {
    const def = FACT_TYPES[type]; const key = def.key; const led = ledgerOf(state, key, def.contexts); const valid = led.filter((e) => !e.voided);
    const proj = def.projection ? existingValue(state, key, 'product') : null; const hasProj = proj !== null && proj !== undefined && proj !== '';
    let cur = null;
    if (def.projection) { if (hasProj) cur = [...valid].reverse().find((e) => eq(key, e.value, proj)) ?? null; } else cur = valid.at(-1) ?? null;
    if (!hasProj && !cur) continue;
    const raw = def.projection ? (key === 'quote.moq' && typeof proj === 'string' ? Number(proj) : proj) : cur.value; const value = key === 'quote.leadTime' && raw !== null && typeof raw !== 'object' ? { min: String(raw), max: String(raw), unit: 'days' } : raw; // a lead time is always {min, max, unit} (the quote keeps only the days)
    const idx = cur ? led.findIndex((e) => e.id === cur.id) : -1; const prev = idx > 0 ? led.slice(0, idx).filter((e) => !e.voided).at(-1) ?? null : null; const rev = cur ? valid.findIndex((e) => e.id === cur.id) + 1 : 0;
    const base = cur ? entryView(state, cur, rev, prev) : { ledger_id: null, value, source_type: SOURCE_TYPE.UNATTRIBUTED_LEGACY, review_status: REVIEW_STATUS.NOT_REVIEWED, created_at: null, revision: 0, supersedes: null, voided: false, source_reference: {}, provenance: { basis: null, via: null, kind: 'legacy-projection', corrected: false, original: null, previousValue: null, reason: 'no ledger entry explains this value', revertOf: null } };
    const q = state.quotes?.at(-1);
    out.push({ fact_type: type, key, context: cur?.context ?? 'product', label: def.label, ...base, value, unit: def.unit === 'currency' ? (q?.currency ?? null) : def.unit ?? null, currency: def.unit === 'currency' ? (q?.currency ?? null) : null, superseded_by: null, editable: true, history: led.map((e, i) => entryView(state, e, i + 1, led[i - 1] ?? null)) });
  }
  return out;
}
/** What the Expert / Quick forms show: the quote as the case holds it, with every fact the owner can edit read from CaseFacts (never from a copy kept by the form). */
export function expertQuote(state) {
  const base = effectiveQuote(state.quotes?.at(-1) ?? {}); const v = factValues(state); const days = v.LEAD_TIME && typeof v.LEAD_TIME === 'object' ? v.LEAD_TIME.max : v.LEAD_TIME;
  return { ...base, ...(v.PRICE !== undefined ? { unitPrice: v.PRICE } : {}), ...(v.CURRENCY !== undefined ? { currency: v.CURRENCY } : {}), ...(v.MOQ !== undefined ? { moq: v.MOQ } : {}), ...(v.INCOTERM !== undefined ? { incoterm: v.INCOTERM } : {}), ...(v.PORT !== undefined ? { port: v.PORT } : {}), ...(days !== undefined ? { leadTimeDays: days } : {}) };
}
export const factOf = (state, type) => caseFacts(state, { types: [type] })[0] ?? null;
/** the value of every fact type as a plain map (what a form shows) */
export const factValues = (state) => Object.fromEntries(caseFacts(state).map((f) => [f.fact_type, f.value]));

/**
 * THE status of every fact in every mode: CONFIRMED (a fact of the case, with its source), PROPOSED ("à confirmer": the supplier said it, nobody confirmed it), AMBIGUOUS (proposed but the value or its unit is unclear: a person must correct it)
 * or MISSING. Pure; nothing here confirms anything. Terrain, Expert and Salon show THIS list, so a value extracted from the supplier's words is visible everywhere as soon as it is proposed.
 */
export const FACT_STATE = Object.freeze({ CONFIRMED: 'CONFIRMED', PROPOSED: 'PROPOSED', AMBIGUOUS: 'AMBIGUOUS', MISSING: 'MISSING' });
export function factStatusBoard(state, { locale = 'fr', types = Object.keys(FACT_TYPES) } = {}) {
  const facts = new Map(caseFacts(state).map((f) => [f.fact_type, f]));
  return types.map((type) => {
    const def = FACT_TYPES[type]; const f = facts.get(type); const ctxs = def.contexts ?? ['product'];
    const pend = (state.candidates ?? []).filter((c) => c.state === 'PROPOSED' && c.key === def.key && ctxs.includes(c.context)).at(-1) ?? null;
    const view = pend ? describeCandidate(pend, locale) : null; const ambiguous = pend ? pend.needsCorrection === true : false;
    const differs = f && pend ? !sameFactValue(def.key, pend.correctedValue ?? pend.value, f.value) : false;
    const state_ = f ? FACT_STATE.CONFIRMED : pend ? (ambiguous ? FACT_STATE.AMBIGUOUS : FACT_STATE.PROPOSED) : FACT_STATE.MISSING;
    return { fact_type: type, key: def.key, label: view?.label ?? labelOf(def.key, 'product', locale), state: state_,
      value: f ? f.value : null, valueText: f ? describeFact({ key: def.key, value: f.value, context: f.context ?? 'product' }, locale).valueText : view ? view.valueText : null, source_type: f ? f.source_type : pend ? SOURCE_TYPE.SUPPLIER_CLAIM : null,
      candidateId: pend?.id ?? null, proposedValueText: view ? view.valueText : null, proposedDiffers: differs, rawText: pend?.rawText ?? f?.source_reference?.rawText ?? null, warnings: view?.warnings ?? [], canConfirm: pend ? view.canConfirm : false, canCorrect: pend ? view.canCorrect : true };
  });
}

/** Facts read from a photo or a document that nobody accepted yet. They are NOT facts of the case until the owner accepts them, and they are never presented as something the supplier said. */
export const observationsOf = (state) => (state.factObservations ?? []).map((o) => ({ ...o }));

/** Every place where two readings of the same case disagree, or an old review no longer matches the case. Pure. */
export function auditCase(state) {
  const findings = []; const facts = new Map(caseFacts(state).map((f) => [f.key, f]));
  for (const f of facts.values()) if (f.source_type === SOURCE_TYPE.UNATTRIBUTED_LEGACY) findings.push({ kind: 'UNATTRIBUTED_VALUE', fact_type: f.fact_type, key: f.key, value: f.value, note: 'the case holds this value but no ledger entry says who gave it' });
  const price = facts.get('quote.unitPrice');
  for (const c of state.candidates ?? []) {
    if (c.state !== 'CORRECTED' || c.correctedValue === undefined) continue; const f = facts.get(c.key); const voided = (state.factAudit ?? []).some((a) => a.kind === 'REVERT' && a.candidateId === c.id);
    if (voided) continue; const type = typeOfKey(c.key);
    if (f && !eq(c.key, c.correctedValue, f.value)) findings.push({ kind: 'STALE_CORRECTION', fact_type: type, key: c.key, candidateId: c.id, offerId: c.offerId ?? null, correctedValue: c.correctedValue, originalValue: c.original?.value ?? c.value, currentValue: f.value, ledgerId: (state.ledger ?? []).find((e) => e.source?.candidateId === c.id && e.corrected)?.id ?? null, note: 'an earlier review of an older offer holds a different value than the case does today' });
    if (c.key === 'quote.moq' && price && eq('quote.unitPrice', c.correctedValue, price.value)) findings.push({ kind: 'CORRECTION_EQUALS_PRICE', fact_type: 'MOQ', key: c.key, candidateId: c.id, offerId: c.offerId ?? null, correctedValue: c.correctedValue, originalValue: c.original?.value ?? c.value, ledgerId: (state.ledger ?? []).find((e) => e.source?.candidateId === c.id && e.corrected)?.id ?? null, note: 'the corrected MOQ is equal to the unit price: it may have been typed in the wrong place (a hint, not a proof)' });
  }
  return findings;
}

// ---------- events (called by core/case.js) ------------------------------------------------------------------------------------------------------------------------------------------------------
const mode = (ev) => (MODES.includes(ev.mode) ? ev.mode : 'system');
function pushLedger(s, e) { s.ledger.push({ id: nextId('led', s.ledger), context: 'product', ...e }); return s.ledger.at(-1); }
const synthetic = (key, ev, context = 'product') => ({ id: ev.candidateId ?? null, key, context, offerId: ev.offerId ?? null });
/** the ledger context of a value: a power is 'power'; a capacity is read by its unit (mAh / Wh / volume); everything else is the product itself */
const contextFor = (type, value) => (type === 'POWER' ? 'power' : type === 'CAPACITY' ? ({ mAh: 'mah', Wh: 'wh', ml: 'volume' }[value?.unit] ?? 'mah') : 'product');

/** FACT_CORRECT {factType, value, mode, reason?}: the owner changes a fact. Explicit, attributed, append-only; the case projection the engines read changes with it. */
function correct(s, ev, at, sub) {
  const type = ev.factType ?? typeOfKey(ev.key); const def = FACT_TYPES[type]; if (!def) throw new Error(`unknown fact type: ${ev.factType ?? ev.key}`);
  const r = def.parse(ev.value ?? ''); if (!r.ok) throw new Error(r.error);
  const cur = factOf(s, type); if (cur && eq(def.key, cur.value, r.value) && cur.source_type === SOURCE_TYPE.USER_PROVIDED) return; // the same value, already the owner's: nothing to record
  const m = mode(ev); const prevEntry = cur?.ledger_id ? s.ledger.find((e) => e.id === cur.ledger_id) : null;
  const ctx = contextFor(type, r.value); const entry = pushLedger(s, { context: ctx, key: def.key, value: r.value, status: SOURCE_TYPE.USER_PROVIDED, source: { kind: 'user_correction', mode: m, previousLedgerId: prevEntry?.id ?? null }, confirmedAt: at, userConfirmed: true, basis: 'USER_CORRECTION', corrected: cur !== null, ...(cur ? { original: { value: cur.value }, previousValue: cur.value, supersedes: true } : {}), mode: m, ...(ev.reason ? { reason: String(ev.reason) } : {}) });
  for (const e of compile(s, synthetic(def.key, ev, ctx), r.value, 'USER_STATED', { kind: 'user_correction', mode: m, ledgerId: entry.id })) sub({ ...e, summary: `${m}: ${def.label} corrigé`, ref: { ledgerId: entry.id, key: def.key } });
}

/** FACT_REVERT {ledgerId, reason, mode}: an owner correction is cancelled. The correction stays in the ledger (voided, with the reason); if it was the current value, the previous value comes back as a NEW entry. */
function revert(s, ev, at, sub) {
  const entry = s.ledger.find((e) => e.id === ev.ledgerId); if (!entry) throw new Error(`unknown ledger entry: ${ev.ledgerId}`);
  if (!(entry.status === SOURCE_TYPE.USER_PROVIDED && (entry.corrected || entry.formEdit))) throw new Error('only an owner correction can be reverted');
  if ((s.factAudit ?? []).some((a) => a.kind === 'REVERT' && a.ledgerId === entry.id)) return; // already reverted
  const type = typeOfKey(entry.key); const def = FACT_TYPES[type]; const m = mode(ev);
  const before = def ? factOf(s, type) : null; const wasCurrent = before?.ledger_id === entry.id;
  const audit = { id: nextId('fa', s.factAudit), at, kind: 'REVERT', ledgerId: entry.id, key: entry.key, mode: m, reason: String(ev.reason ?? 'correction cancelled by the owner'), candidateId: entry.source?.candidateId ?? null, value: entry.value, previousValue: entry.previousValue ?? entry.original?.value ?? null };
  s.factAudit.push(audit);
  if (entry.source?.candidateId) { const c = s.candidates.find((x) => x.id === entry.source.candidateId); if (c) c.correctionReverted = { at, auditId: audit.id, ledgerId: entry.id, reason: audit.reason }; }
  if (!wasCurrent || !def) return;
  const prev = ledgerOf(s, entry.key, def.contexts).filter((e) => !e.voided && e.id !== entry.id && s.ledger.indexOf(s.ledger.find((x) => x.id === e.id)) < s.ledger.indexOf(entry)).at(-1);
  if (!prev) throw new Error('there is no earlier value to go back to: correct the fact with the right value instead');
  const restored = pushLedger(s, { context: prev.context, key: def.key, value: prev.value, status: prev.status, ...(prev.sourceType ? { sourceType: prev.sourceType } : {}), source: { ...(prev.source ?? {}), kind: 'revert', mode: m, ofLedgerId: entry.id, restoresLedgerId: prev.id }, confirmedAt: at, userConfirmed: true, basis: prev.basis ?? 'ORIGINAL', corrected: false, revertOf: entry.id, mode: m, rawText: prev.rawText, span: prev.span, ...(prev.offerId ? { offerId: prev.offerId } : {}), reason: audit.reason });
  for (const e of compile(s, synthetic(def.key, { candidateId: prev.source?.candidateId, offerId: prev.offerId }, prev.context), prev.value, prev.status === SOURCE_TYPE.USER_PROVIDED ? 'USER_STATED' : 'SUPPLIER_CLAIMED', { kind: 'revert', mode: m, ledgerId: restored.id })) sub({ ...e, summary: `${m}: retour à la valeur précédente`, ref: { ledgerId: restored.id, key: def.key } });
}

/** FACT_OBSERVE {factType|key, value, sourceType, ref, mode}: a value READ from a product photo / a document / derived by the system. It is recorded as an observation and is NOT a fact of the case until accepted. */
function observe(s, ev, at) {
  const type = ev.factType ?? typeOfKey(ev.key); const def = FACT_TYPES[type]; if (!def) throw new Error(`unknown fact type: ${ev.factType ?? ev.key}`);
  if (!OBSERVED.has(ev.sourceType)) throw new Error('an observation comes from IMAGE_OBSERVED, DOCUMENT_OBSERVED or SYSTEM_DERIVED');
  const r = def.parse(typeof ev.value === 'string' ? ev.value : (ev.value?.amount !== undefined ? `${ev.value.amount} ${ev.value.unit ?? ''}`.trim() : String(ev.value ?? ''))); if (!r.ok) throw new Error(r.error);
  s.factObservations.push({ id: nextId('obs', s.factObservations), at, factType: type, key: def.key, value: r.value, rawText: ev.rawText ?? null, sourceType: ev.sourceType, ref: ev.ref ?? null, confidence: ev.confidence ?? null, observer: ev.observer ?? null, state: 'PROPOSED', mode: mode(ev) });
}
/** FACT_ACCEPT {observationId, mode}: the owner accepts an observation. It enters the ledger with ITS source type (never SUPPLIER_CLAIM) and the engines see it. */
function accept(s, ev, at, sub) {
  const o = s.factObservations.find((x) => x.id === ev.observationId); if (!o) throw new Error(`unknown observation: ${ev.observationId}`); if (o.state !== 'PROPOSED') return;
  const def = FACT_TYPES[o.factType]; const m = mode(ev); o.state = 'ACCEPTED'; o.decidedAt = at; o.decidedBy = m;
  const cur = factOf(s, o.factType); const entry = pushLedger(s, { context: contextFor(o.factType, o.value), key: def.key, value: o.value, status: o.sourceType, sourceType: o.sourceType, source: { kind: 'observation', mode: m, observationId: o.id, ref: o.ref }, confirmedAt: at, userConfirmed: true, basis: o.sourceType, corrected: false, mode: m, rawText: o.rawText, ...(cur && !eq(def.key, cur.value, o.value) ? { supersedes: true, previousValue: cur.value } : {}) });
  for (const e of compile(s, synthetic(def.key, {}, contextFor(o.factType, o.value)), o.value, 'USER_STATED', { kind: 'observation', mode: m, ledgerId: entry.id })) sub({ ...e, summary: `${o.sourceType} accepté`, ref: { ledgerId: entry.id, key: def.key } });
}
export function applyFactEvent(s, ev, at, sub) {
  s.factAudit ??= []; s.factObservations ??= [];
  switch (ev.type) { case 'FACT_CORRECT': return correct(s, ev, at, sub); case 'FACT_REVERT': return revert(s, ev, at, sub); case 'FACT_OBSERVE': return observe(s, ev, at); case 'FACT_ACCEPT': return accept(s, ev, at, sub); default: throw new Error(`unknown fact event: ${ev.type}`); }
}

// ---------- values TYPED into a form (Expert / Quick / Money / product): only what CHANGED is a user edit --------------------------------------------------------------------------------
const FORM_QUOTE = { unitPrice: 'quote.unitPrice', currency: 'quote.currency', moq: 'quote.moq', incoterm: 'quote.incoterm', port: 'quote.port', leadTimeDays: 'quote.leadTime' };
const clean = (v) => (v === undefined || v === null || v === '' ? null : v);
/** Called by the QUOTE reducer BEFORE the new quote is pushed, for a quote typed in a form (event.origin). A field equal to what the case already held is NOT an edit (a prefilled form that is saved again changes nothing about who said what). */
export function ledgerFormQuote(s, prev, nq, at, origin) {
  for (const [field, key] of Object.entries(FORM_QUOTE)) {
    const now = clean(nq[field]); const was = clean(prev?.[field]); if (now === null || (was !== null && sameValue(was, now))) continue;
    const value = key === 'quote.leadTime' ? { min: String(now), max: String(now), unit: 'days' } : key === 'quote.moq' ? String(now) : String(now);
    const before = factOf(s, typeOfKey(key)); pushLedger(s, { key, value, status: SOURCE_TYPE.USER_PROVIDED, source: { kind: 'form', origin, mode: origin }, confirmedAt: at, userConfirmed: true, basis: 'FORM', corrected: before !== null, formEdit: true, ...(before ? { original: { value: before.value }, previousValue: before.value, supersedes: true } : {}), mode: origin });
  }
}
export function ledgerFormIdentifier(s, name, value, at, origin) {
  const key = `identifier.${name}`; const type = typeOfKey(key); if (!type) return; const before = factOf(s, type); if (before && sameValue(before.value, value)) return;
  pushLedger(s, { key, value: String(value), status: SOURCE_TYPE.USER_PROVIDED, source: { kind: 'form', origin, mode: origin }, confirmedAt: at, userConfirmed: true, basis: 'FORM', corrected: before !== null, formEdit: true, ...(before ? { original: { value: before.value }, previousValue: before.value, supersedes: true } : {}), mode: origin });
}
