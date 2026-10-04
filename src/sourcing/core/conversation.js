// Supplier conversation sessions and the candidate-fact lifecycle (V1 domain). Text/manual capture only: no cloud AI, no transcription, no network.
// Flow: CONVERSATION_ITEM stores the ORIGINAL text and proposes candidates (deterministic extractor) -> the owner CONFIRMS, CORRECTS or REJECTS each one -> only a confirmed/corrected
// candidate reaches the case, compiled into the EXISTING events (QUOTE, IDENTIFIER, ...). Everything confirmed also lands in the ledger with its provenance. Reducers mutate the draft
// state they are given (core/case.js clones before calling them) and are fully deterministic.
import { extractFacts, detectLang } from './extract/index.js';
import { CANDIDATE_STATE, FACT_STATUS, SPEAKER, confirmedStatus, documentStatusOf } from './provenance.js';
import { findCandidateConflict, existingValue, documentModelConflicts } from './conflicts.js';
import { effectiveQuote } from './offers.js';

const nextId = (prefix, list) => `${prefix}-${list.length + 1}`;
const find = (list, id, what) => { const x = list.find((e) => e.id === id); if (!x) throw new Error(`unknown ${what}: ${id}`); return x; };
const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

export function start(s, ev, at) {
  const conv = { id: nextId('conv', s.conversations), supplierRef: ev.supplierRef ?? s.supplier?.name ?? null, startedAt: at, finishedAt: null, lang: ev.lang ?? 'auto', status: 'OPEN', items: [] };
  s.conversations.push(conv);
}

export function addItem(s, ev, at) {
  const conv = find(s.conversations, ev.convId, 'conversation'); if (conv.status !== 'OPEN') throw new Error('this conversation is finished: start a new one');
  const speaker = ev.speaker === SPEAKER.ME ? SPEAKER.ME : SPEAKER.SUPPLIER; const text = String(ev.text ?? ''); if (!text.trim()) throw new Error('text is required');
  const lang = ev.lang && ev.lang !== 'auto' ? ev.lang : detectLang(text);
  const item = { id: `${conv.id}-i${conv.items.length + 1}`, at, speaker, lang, original: text, derived: [] }; conv.items.push(item);
  const r = extractFacts({ text, lang });
  for (const c of r.candidates) s.candidates.push({ ...c, id: nextId('cand', s.candidates), convId: conv.id, itemId: item.id, speaker, state: CANDIDATE_STATE.PROPOSED, proposedAt: at });
}

// ---- compile a confirmed candidate into EXISTING events -----------------------------------------------------------------------------------------------------------------------
function compile(s, c, value, level, source) {
  const k = c.key; const prev = s.quotes.at(-1) ?? null; const base = prev ? { ...prev } : {}; delete base.at; const quote = (patch, drop = []) => { const q = { ...base, ...patch }; for (const d of drop) delete q[d]; return [{ type: 'QUOTE', quote: q, summary: `from conversation (${c.id}): ${k}` }]; };
  switch (k) {
    case 'identifier.model': case 'identifier.brand': case 'identifier.manufacturer': return [{ type: 'IDENTIFIER', name: k.split('.')[1], value: String(value), level, source, summary: `from conversation (${c.id}): ${k}` }];
    case 'quote.unitPrice': return quote({ unitPrice: String(value) }, ['tiers']); // an explicit single price replaces the tiers
    case 'quote.currency': return quote({ currency: String(value) });
    case 'quote.incoterm': return quote({ incoterm: String(value) });
    case 'quote.port': return quote({ port: String(value) });
    case 'quote.moq': return c.context === 'product' ? quote({ moq: Number(String(value).replace(/,/g, '')) }) : [];
    case 'quote.leadTime': return quote({ leadTimeDays: String(typeof value === 'object' ? value.max : value) });
    case 'quote.tiers': return quote({ tiers: value, ...(base.qty === undefined && Array.isArray(value) && value.length === 1 ? { qty: Number(value[0].minQty) } : {}) });
    case 'payment.depositPct': return quote({ payment: { ...(base.payment ?? {}), depositPct: String(value) } });
    case 'payment.balancePct': return quote({ payment: { ...(base.payment ?? {}), balancePct: String(value) } });
    case 'payment.balanceDue': return quote({ payment: { ...(base.payment ?? {}), balanceDue: String(value) } });
    case 'carton.qty': case 'carton.dimensions': case 'carton.grossWeight': case 'carton.netWeight': return []; // kept in the ledger; the V0 carton text field is the owner's own
    default:
      if (k.startsWith('docClaim.')) return [{ type: 'DOC_CLAIM', claim: k.slice('docClaim.'.length), status: String(value), source, summary: `supplier statement (${c.id}): ${k} = ${value}` }];
      return [];
  }
}

function apply(s, c, value, { corrected, at, reduce, conflictId = null, ownerDecided = false }) {
  const status = confirmedStatus({ speaker: c.speaker, corrected });
  const level = corrected || c.speaker === SPEAKER.ME || ownerDecided ? 'USER_STATED' : 'SUPPLIER_CLAIMED';
  const source = { kind: 'conversation', convId: c.convId, itemId: c.itemId, candidateId: c.id };
  const same = !c.key.startsWith('docClaim.') && !isEmpty(existingValue(s, c.key, c.context)) && !findCandidateConflict(s, c, value); // the case already holds this value: corroboration only (a changed supplier STATEMENT about a document is always recorded)
  if (!same) for (const e of compile(s, c, value, level, source)) reduce(e);
  s.ledger.push({ id: nextId('led', s.ledger), key: c.key, value, context: c.context, status, source: { convId: c.convId, itemId: c.itemId, candidateId: c.id }, lang: c.lang, rawText: c.rawText, span: c.span, confirmedAt: at, userConfirmed: true, corrected: !!corrected, ...(corrected ? { original: { value: c.value, rawText: c.rawText } } : {}), ...(conflictId ? { resolvedConflict: conflictId } : {}) });
  c.state = corrected ? CANDIDATE_STATE.CORRECTED : CANDIDATE_STATE.CONFIRMED; c.decidedAt = at; c.decidedBy = 'user'; if (corrected) { c.original = { value: c.value, rawText: c.rawText }; c.correctedValue = value; }
}

const label = (key, ctx) => (key.startsWith('docClaim.') ? `document statement (${key.slice(9) === 'UN383' ? 'UN 38.3' : key.slice(9)})` : null) ?? ({ 'quote.moq': `minimum order${ctx && ctx !== 'product' ? ` (${ctx.replace(/_/g, ' ')})` : ''}`, 'quote.unitPrice': 'unit price', 'quote.currency': 'currency', 'quote.incoterm': 'Incoterm', 'quote.port': 'port', 'quote.leadTime': 'lead time', 'quote.tiers': 'price tiers', 'identifier.model': 'model', 'identifier.brand': 'brand', 'identifier.manufacturer': 'manufacturer', 'payment.depositPct': 'deposit %', 'payment.balancePct': 'balance %' }[key] ?? key);
const show = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

function raiseConflict(s, c, value, found, at) {
  const entries = [{ value: typeof found.existing === 'number' ? String(found.existing) : found.existing, from: 'CASE' }, { value, from: 'SUPPLIER', candidateId: c.id }];
  const q = found.type === 'MODEL_MISMATCH' ? `The model you have is ${show(found.existing)} but the supplier now says ${show(value)}. Which exact model is this offer for?`
    : `Earlier: ${label(c.key, c.context)} ${show(found.existing)}. Now: ${show(value)}. Which one is right? Is one of them for a different case (for example with your logo)?`;
  s.conflicts.push({ id: nextId('conf', s.conflicts), type: found.type, key: c.key, context: c.context, candidateId: c.id, entries, state: 'OPEN', raisedAt: at, question: { en: q, zh: null, zhNote: 'No Chinese version available for this question yet.' } });
  c.state = CANDIDATE_STATE.CONFLICT;
}

export function confirm(s, ev, at, reduce, { corrected = false, value = undefined } = {}) {
  const c = find(s.candidates, ev.id, 'candidate');
  if (c.state === CANDIDATE_STATE.CONFIRMED || c.state === CANDIDATE_STATE.CORRECTED) return; // idempotent
  if (c.state === CANDIDATE_STATE.REJECTED) throw new Error('this candidate was already rejected');
  if (c.state === CANDIDATE_STATE.CONFLICT) throw new Error('this candidate is in conflict: resolve the conflict first');
  if (corrected && isEmpty(value)) throw new Error('a correction needs a value');
  if (!corrected && c.needsCorrection) throw new Error('this candidate needs a correction before it can be used');
  const v = corrected ? value : c.value;
  const found = findCandidateConflict(s, c, v); if (found) { raiseConflict(s, c, v, found, at); if (corrected) c.correctedValue = v; return; }
  apply(s, c, v, { corrected, at, reduce });
}
export const correct = (s, ev, at, reduce) => confirm(s, ev, at, reduce, { corrected: true, value: ev.value });

export function reject(s, ev, at) {
  const c = find(s.candidates, ev.id, 'candidate');
  if (c.state === CANDIDATE_STATE.CONFIRMED || c.state === CANDIDATE_STATE.CORRECTED) throw new Error('this candidate is already confirmed: it cannot be silently rejected');
  c.state = CANDIDATE_STATE.REJECTED; c.decidedAt = at; c.decidedBy = 'user';
}

export function resolve(s, ev, at, reduce) {
  const cf = find(s.conflicts, ev.id, 'conflict'); if (cf.state !== 'OPEN') throw new Error('this conflict is already resolved');
  if (!['NEW', 'OLD'].includes(ev.choice)) throw new Error('choose NEW or OLD');
  const c = find(s.candidates, cf.candidateId, 'candidate'); const corrected = c.correctedValue !== undefined; const v = corrected ? c.correctedValue : c.value;
  if (ev.choice === 'NEW') { c.state = CANDIDATE_STATE.PROPOSED; apply(s, c, v, { corrected, at, reduce, conflictId: cf.id, ownerDecided: true }); }
  else { c.state = CANDIDATE_STATE.REJECTED; c.decidedAt = at; c.decidedBy = 'user'; c.rejectedReason = 'the existing value was kept'; }
  cf.state = 'RESOLVED'; cf.resolution = ev.choice; cf.resolvedAt = at;
}

export function finish(s, ev, at) { const conv = find(s.conversations, ev.convId, 'conversation'); conv.status = 'FINISHED'; conv.finishedAt = at; }

// ---- free user questions -------------------------------------------------------------------------------------------------------------------------------------------------------
export function addQuestion(s, ev, at) {
  const text = String(ev.text ?? '').trim(); if (!text) throw new Error('question text is required');
  const lang = ev.lang && ev.lang !== 'auto' ? ev.lang : detectLang(text);
  s.userQuestions.push({ id: nextId('uq', s.userQuestions), at, origin: 'USER', text, lang, translation: null, state: 'OPEN', answeredBy: [] });
}
export function questionState(s, ev) { const q = find(s.userQuestions, ev.id, 'question'); if (!['OPEN', 'ASKED', 'ANSWERED'].includes(ev.state)) throw new Error('unknown question state'); q.state = ev.state; }

/** How a free question can be shown to a supplier TODAY: the owner's original, an English version only if the owner wrote English, Chinese only if the owner wrote it or a reviewed translation exists. No translator exists yet. */
export function userQuestionView(q) {
  const zh = q.lang === 'zh' ? q.text : q.translation?.zh ?? null; const en = q.lang === 'en' ? q.text : q.translation?.en ?? null;
  return { id: q.id, original: q.text, lang: q.lang, en, zh, zhOrigin: q.lang === 'zh' ? 'USER' : q.translation?.zh ? (q.translation.zhOrigin ?? 'PROVIDER') : 'NONE',
    zhNote: zh ? null : 'No Chinese translation is available for your own questions yet: show the English, or use your own translation app.', enNote: en ? null : 'Not available in English.' };
}

// ---- finish-conversation summary ---------------------------------------------------------------------------------------------------------------------------------------------
export const conflictText = (x) => (x.type === 'MODEL_MISMATCH' ? `Model: the case says ${show(x.entries[0].value)}, the supplier says ${show(x.entries[1].value)}` : `${label(x.key, x.context)}: ${show(x.entries[0].value)} earlier, ${show(x.entries[1].value)} now`);
export const documentConflictText = (d) => `Document ${d.fileName ?? d.docId} names ${d.docModels.join(' / ')}, the case says ${d.caseModel}${d.result === 'FORMAT_VARIANT' ? ' (same characters, different format: please confirm)' : ''}`;
const friendly = (e) => `${label(e.key, e.context)}: ${show(e.value)}`;
/** WHAT WE LEARNED / STILL MISSING / CONTRADICTIONS for one conversation. `assessment` is the output of assess() (its questions say what is still missing). */
export function summarizeConversation(s, convId, assessment) {
  const cands = s.candidates.filter((c) => c.convId === convId); const n = (st) => cands.filter((c) => c.state === st).length;
  const confirmedIds = new Set(cands.filter((c) => [CANDIDATE_STATE.CONFIRMED, CANDIDATE_STATE.CORRECTED].includes(c.state)).map((c) => c.id));
  const learned = s.ledger.filter((e) => confirmedIds.has(e.source?.candidateId)).map((e) => ({ key: e.key, text: friendly(e), status: e.status }));
  const openConflicts = s.conflicts.filter((x) => x.state === 'OPEN' && cands.some((c) => c.id === x.candidateId));
  const p1 = (assessment?.questions ?? []).filter((q) => q.priority === 'P1');
  const docClaims = s.documentLedger.filter((d) => ['CLAIMED', 'PROMISED'].includes(d.status) && cands.some((c) => c.id === d.source?.candidateId))
    .map((d) => ({ claim: d.claim, status: d.status, stillNotReceived: ['CLAIMED', 'PROMISED'].includes(documentStatusOf(s, d.claim).status) })).filter((d) => d.stillNotReceived);
  const contradictions = [...openConflicts.map((x) => ({ kind: x.type, text: conflictText(x) })), ...documentModelConflicts(s).map((d) => ({ kind: 'DOCUMENT_MODEL', text: documentConflictText(d) }))];
  return { convId, factsFound: cands.length, confirmed: confirmedIds.size, rejected: n(CANDIDATE_STATE.REJECTED), conflicts: openConflicts.length, stillToReview: n(CANDIDATE_STATE.PROPOSED), needCorrection: cands.filter((c) => c.state === CANDIDATE_STATE.PROPOSED && c.needsCorrection).length,
    learned, missingImportant: p1.length, missing: p1.slice(0, 6).map((q) => ({ id: q.id, topic: q.topic, en: q.en })), documentClaimsNotReceived: docClaims, contradictions };
}
export { FACT_STATUS };
