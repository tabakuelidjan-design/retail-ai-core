// Supplier conversation sessions and the candidate-fact lifecycle (V1 domain). Text/manual capture only: no cloud AI, no transcription, no network.
// Flow: CONVERSATION_ITEM stores the ORIGINAL text and proposes candidates (deterministic extractor) -> the owner CONFIRMS, CORRECTS or REJECTS each one -> only a confirmed/corrected
// candidate reaches the case, compiled into the EXISTING events (QUOTE, IDENTIFIER, ...). Everything confirmed also lands in the ledger with its provenance. Reducers mutate the draft
// state they are given (core/case.js clones before calling them) and are fully deterministic.
import { extractFacts, detectLang } from './extract/index.js';
import { normalizeSpoken } from './extract/spoken.js';
import { decideTurn, segmentsOf, turnText } from './turns.js';
import { CANDIDATE_STATE, FACT_STATUS, SPEAKER, MODALITY, confirmedStatus, documentStatusOf, rawTextOf, revisionsOf, currentTextOf } from './provenance.js';
import { findCandidateConflict, existingValue, documentModelConflicts, supersedesExisting } from './conflicts.js';
import { effectiveQuote } from './offers.js';
import { classifyCandidates } from './understanding.js';

export const nextId = (prefix, list) => { let m = list.length; for (const e of list) { const n = Number(String(e.id).slice(prefix.length + 1)); if (String(e.id).startsWith(`${prefix}-`) && Number.isFinite(n) && n > m) m = n; } return `${prefix}-${m + 1}`; }; // max + 1: unique even after a candidate was replaced
const find = (list, id, what) => { const x = list.find((e) => e.id === id); if (!x) throw new Error(`unknown ${what}: ${id}`); return x; };
const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

export function start(s, ev, at) {
  const conv = { id: nextId('conv', s.conversations), supplierRef: ev.supplierRef ?? s.supplier?.name ?? null, startedAt: at, finishedAt: null, lang: ev.lang ?? 'auto', status: 'OPEN', items: [] };
  s.conversations.push(conv);
}

/** SPEECH: a spoken statement captured by a microphone. There is NO original text: the item keeps only capture metadata (session, turn, times) and ONE machine TRANSCRIPTION (who produced it, which version,
 *  review MACHINE). Facts proposed from it are MACHINE_DERIVED, capped at MEDIUM, never grouped. The speaker is UNKNOWN unless the owner says otherwise; no audio is stored. Provider-independent. */
function addSpeechItem(s, ev, at) {
  const conv = find(s.conversations, ev.convId, 'conversation'); if (conv.status !== 'OPEN') throw new Error('this conversation is finished: start a new one');
  const text = String(ev.text ?? '').trim(); if (!text) throw new Error('the transcription text is required');
  // a one-shot spoken statement (no streaming context): ONE segment, a turn that is already CLOSED
  closeOpenTurns(conv, at, 'NEW_ITEM');
  const speaker = [SPEAKER.SUPPLIER, SPEAKER.ME].includes(ev.speaker) && ev.speakerBy === 'OWNER_DECISION' ? ev.speaker : SPEAKER.UNKNOWN;
  const lang = ev.lang && ev.lang !== 'auto' ? ev.lang : detectLang(text); const cap = ev.capture ?? {};
  const item = newSpeechItem(conv, { at, speaker, lang, cap, firstSegmentAt: at }); const seg = { id: `${item.id}-s1`, text, startTime: null, duration: null, streamId: null, receivedAt: at, provider: ev.provider ?? null, version: ev.version ?? null, lang };
  item.segments.push(seg); item.turn = { status: 'CLOSED', openedAt: at, lastSegmentAt: at, closedAt: at, closedBy: 'SINGLE_SEGMENT' }; conv.items.push(item); reextract(s, conv, item, at);
}

function newSpeechItem(conv, { at, speaker, lang, cap, firstSegmentAt }) {
  return { id: `${conv.id}-i${conv.items.length + 1}`, at, speaker, speakerBy: speaker === SPEAKER.UNKNOWN ? 'UNKNOWN' : 'OWNER_DECISION', lang, modality: MODALITY.SPEECH, original: null,
    capture: { sessionId: cap.sessionId ?? null, turn: Number.isFinite(cap.turn) ? cap.turn : conv.items.length + 1, startedAt: cap.startedAt ?? firstSegmentAt, endedAt: cap.endedAt ?? at },
    turn: { status: 'OPEN', openedAt: at, lastSegmentAt: at, closedAt: null, closedBy: null }, segments: [], derived: [] };
}

/** Closes every OPEN turn of a conversation (or only `only`). A closed turn is the clean unit shown in the thread; its segments stay as they were received. */
export function closeOpenTurns(conv, at, by, only = null) {
  for (const it of conv.items) if (it.turn?.status === 'OPEN' && (!only || it.id === only)) { it.turn.status = 'CLOSED'; it.turn.closedAt = at; it.turn.closedBy = by; }
}
export function closeTurn(s, ev, at) { const conv = find(s.conversations, ev.convId, 'conversation'); closeOpenTurns(conv, at, String(ev.by ?? 'EXPLICIT'), ev.itemId ?? null); }

/** One FINAL ASR segment. It CONTINUES the open turn of the same capture session or starts a new one (core/turns.js decides, from timing and punctuation). Segments are immutable. */
export function addSegment(s, ev, at) {
  const conv = find(s.conversations, ev.convId, 'conversation'); if (conv.status !== 'OPEN') throw new Error('this conversation is finished: start a new one');
  const text = String(ev.text ?? '').trim(); if (!text) throw new Error('the transcription text is required');
  const seg0 = ev.segment ?? {}; const cap = ev.capture ?? {}; const lang = ev.lang && ev.lang !== 'auto' ? ev.lang : detectLang(text);
  const openItem = [...conv.items].reverse().find((x) => x.modality === MODALITY.SPEECH && x.turn?.status === 'OPEN') ?? null;
  const segment = { id: '', text, startTime: Number.isFinite(seg0.startTime) ? seg0.startTime : null, duration: Number.isFinite(seg0.duration) ? seg0.duration : null, streamId: seg0.streamId ?? null, receivedAt: seg0.receivedAt ?? at, provider: ev.provider ?? null, version: ev.version ?? null, lang };
  const d = decideTurn({ open: openItem ? { segments: segmentsOf(openItem), sessionId: openItem.capture?.sessionId ?? null, speaker: openItem.speaker } : null, segment, sessionId: cap.sessionId ?? null, config: ev.turnConfig });
  let item = openItem;
  if (d.action === 'NEW') { if (openItem) closeOpenTurns(conv, at, d.reason, openItem.id); item = newSpeechItem(conv, { at: segment.receivedAt, speaker: SPEAKER.UNKNOWN, lang, cap, firstSegmentAt: segment.receivedAt }); conv.items.push(item); }
  segment.id = `${item.id}-s${item.segments.length + 1}`; item.segments.push(segment); item.turn.lastSegmentAt = segment.receivedAt; item.capture.endedAt = segment.receivedAt; item.lang = lang;
  reextract(s, conv, item, at);
}

/** Recomputes the transcription of a speech item from ALL its segments and re-proposes its facts. Facts the owner already decided are never touched; proposals that no longer appear are dropped;
 *  each proposal records the segment ids it comes from (exact when the per-segment text maps onto the whole, otherwise the turn's segments up to the one that completed it, flagged APPROX). */
function reextract(s, conv, item, at) {
  if (revisionsOf(item).length) return; // an item the owner corrected is read from HIS text (see reviseItem): the raw segments never bring their proposals back
  const segs = item.segments; const joined = turnText(segs); const lang = item.lang && item.lang !== 'auto' ? item.lang : detectLang(joined);
  let d = item.derived.find((x) => x.kind === 'TRANSCRIPTION');
  if (!d) { d = { id: `${item.id}-d1`, kind: 'TRANSCRIPTION', lang, text: '', provider: segs[0]?.provider ?? null, ...(segs[0]?.version ? { version: String(segs[0].version) } : {}), review: 'MACHINE', at }; item.derived.push(d); }
  d.text = joined; d.lang = lang; d.segmentIds = segs.map((x) => x.id); d.provider = segs[0]?.provider ?? d.provider; if (segs[0]?.version) d.version = String(segs[0].version);
  const english = lang === 'en'; const per = english ? segs.map((x) => normalizeSpoken(x.text)) : segs.map((x) => String(x.text).trim()); const exText = english ? normalizeSpoken(joined) : joined;
  if (exText !== joined) d.normalized = exText; else delete d.normalized;
  const exact = per.join(' ') === exText; const offsets = []; if (exact) { let pos = 0; for (const p of per) { offsets.push([pos, pos + p.length]); pos += p.length + 1; } }
  const r = extractFacts({ text: exText, lang }); const last = segs.at(-1);
  const idsFor = (span) => { if (!exact || !Array.isArray(span)) return null; const ids = segs.filter((_, i) => offsets[i][0] < span[1] && offsets[i][1] > span[0]).map((x) => x.id); return ids.length ? ids : null; };
  const kk = (c) => `${c.key}|${c.context ?? ''}|${JSON.stringify(c.value)}`;
  const mine = s.candidates.filter((c) => c.itemId === item.id && c.basis === 'TRANSCRIPTION'); const byKey = new Map(mine.map((c) => [kk(c), c])); const fresh = new Set(r.candidates.map(kk));
  for (const c of mine) if (c.state === CANDIDATE_STATE.PROPOSED && !fresh.has(kk(c))) s.candidates.splice(s.candidates.indexOf(c), 1);
  for (const c of r.candidates) {
    const ids = idsFor(c.span); const prov = ids ? { segmentIds: ids, segmentMapping: 'EXACT' } : { segmentIds: segs.map((x) => x.id), segmentMapping: 'APPROX', completedBySegment: last?.id ?? null };
    const have = byKey.get(kk(c)); if (have) { if (have.state === CANDIDATE_STATE.PROPOSED) Object.assign(have, prov); continue; }
    s.candidates.push({ ...c, id: nextId('cand', s.candidates), convId: conv.id, itemId: item.id, speaker: item.speaker, basis: 'TRANSCRIPTION', derivedId: d.id, ...prov, confidence: c.confidence === 'HIGH' ? 'MEDIUM' : c.confidence, flags: [...new Set([...(c.flags ?? []), 'MACHINE_DERIVED'])], state: CANDIDATE_STATE.PROPOSED, proposedAt: at });
  }
}

/** The OWNER establishes who spoke an item heard by the microphone. Until then its facts cannot be confirmed. Candidates of the item follow the decision. */
export function attribute(s, ev, at) {
  const conv = find(s.conversations, ev.convId, 'conversation'); const item = conv.items.find((x) => x.id === ev.itemId); if (!item) throw new Error(`unknown item: ${ev.itemId}`);
  if (![SPEAKER.SUPPLIER, SPEAKER.ME].includes(ev.speaker)) throw new Error('the speaker must be supplier or me');
  item.speaker = ev.speaker; item.speakerBy = 'OWNER_DECISION'; item.speakerAt = at; closeOpenTurns(conv, at, 'SPEAKER_ESTABLISHED', item.id);
  for (const c of s.candidates) if (c.itemId === item.id && c.speaker === SPEAKER.UNKNOWN) {
    c.speaker = ev.speaker;
    // a line of an IMPORTED chat that turns out to be the owner's own: it is evidence of what the owner said, never a proposal about what the supplier offers
    if (ev.speaker === SPEAKER.ME && c.offerId && c.state === CANDIDATE_STATE.PROPOSED) { c.state = CANDIDATE_STATE.REJECTED; c.decidedAt = at; c.decidedBy = 'system'; c.rejectedReason = 'a line written by the owner, not by the supplier'; }
  }
}

export function addItem(s, ev, at) {
  if (ev.modality === MODALITY.SPEECH) return addSpeechItem(s, ev, at);
  const conv = find(s.conversations, ev.convId, 'conversation'); if (conv.status !== 'OPEN') throw new Error('this conversation is finished: start a new one');
  closeOpenTurns(conv, at, 'TYPED_INPUT');
  // an item whose speaker nobody established (a pasted chat with unfamiliar names) stays UNKNOWN: its facts cannot be confirmed until the owner says who spoke (CONVERSATION_ATTRIBUTE)
  const speaker = ev.speaker === SPEAKER.ME ? SPEAKER.ME : ev.speaker === SPEAKER.UNKNOWN ? SPEAKER.UNKNOWN : SPEAKER.SUPPLIER; const text = String(ev.text ?? ''); if (!text.trim()) throw new Error('text is required');
  const lang = ev.lang && ev.lang !== 'auto' ? ev.lang : detectLang(text);
  const answers = ev.answersQuestion ? String(ev.answersQuestion) : null; // the owner typed this as the ANSWER to a question that was asked: the link is kept (question id -> item id), append-only
  const item = { id: `${conv.id}-i${conv.items.length + 1}`, at, speaker, lang, original: text, derived: [], ...(speaker === SPEAKER.UNKNOWN ? { speakerBy: 'UNKNOWN' } : {}), ...(ev.source ? { source: String(ev.source) } : {}), ...(answers ? { answersQuestion: answers } : {}) }; conv.items.push(item);
  if (answers) s.questionLog.push({ id: nextId('ql', s.questionLog), questionId: answers, kind: 'ANSWERED', at, itemId: item.id, convId: conv.id, ...(ev.questionText ? { questionText: String(ev.questionText).slice(0, 300) } : {}) });
  if (ev.extract === false) return; // the text is kept as the original (for example the owner's own lines of a pasted chat) and nothing is proposed from it
  const r = extractFacts({ text, lang });
  for (const c of r.candidates) s.candidates.push({ ...c, id: nextId('cand', s.candidates), convId: conv.id, itemId: item.id, speaker, basis: 'ORIGINAL', state: CANDIDATE_STATE.PROPOSED, proposedAt: at });
}

/** An explicit owner-requested re-reading of ORIGINAL supplier notes stored by an older extractor.
 * Only ADD new PROPOSED candidates for keys/contexts absent from the same item. Never alter
 * accepted, corrected, rejected or conflicting candidates, ledger, quote, originals or offers.
 * NOT a load-time migration: old case decisions and deliberate extraction skips stay untouched
 * until the owner chooses to re-read those notes. No machine-derived text is replayed.
 */
export function reanalyzeStoredNotes(s, ev, at) {
  const selected = ev.itemId ?? null;
  let found = false; let added = 0;
  for (const conv of s.conversations ?? []) {
    if (ev.convId && conv.id !== ev.convId) continue;
    for (const item of conv.items ?? []) {
      if (selected && item.id !== selected) continue;
      found = true;
      if (item.speaker !== SPEAKER.SUPPLIER || typeof item.original !== 'string' || !item.original.trim() || item.modality === MODALITY.SPEECH || revisionsOf(item).length) continue; // a corrected note is read from its correction, never from its raw words
      const existing = new Set(s.candidates.filter((c) => c.convId === conv.id && c.itemId === item.id && (!c.basis || c.basis === 'ORIGINAL'))
        .map((c) => `${c.key}|${c.context ?? 'product'}`));
      const ex = extractFacts({ text: item.original, lang: item.lang || 'auto' });
      for (const c of ex.candidates) {
        const k = `${c.key}|${c.context ?? 'product'}`;
        if (existing.has(k)) continue; // includes REJECTED: never resurrect an owner-rejected fact
        s.candidates.push({ ...c, id: nextId('cand', s.candidates), convId: conv.id, itemId: item.id,
          speaker: item.speaker, basis: 'ORIGINAL', state: CANDIDATE_STATE.PROPOSED,
          proposedAt: at, recovery: { kind: 'OWNER_INITIATED_REANALYSIS', at } });
        existing.add(k); added += 1;
      }
    }
  }
  if (selected && !found) throw new Error(`unknown conversation item: ${selected}`);
  return added;
}

/**
 * The OWNER corrects the text of one item (a typed note, a dictated sentence, a saved answer): ONE explicit, append-only REVISION next to the untouched raw words (typed original, or the machine transcription and its segments).
 * The revision keeps its date, its source and the item it refers to; the speaker of the item does not change (the corrected text is NOT presented as something the supplier pronounced).
 * The proposals that depend on the text are recomputed from the corrected text: a proposal still waiting is superseded when its words are gone; decided candidates (confirmed, corrected, rejected by the owner, in conflict) are NEVER touched; a rejected
 * proposal is never brought back; the same value is never proposed twice. A correction that disagrees with a confirmed fact changes nothing: it is recorded as an IMPACT the owner must decide (the usual conflict question when the new value is confirmed).
 */
export function reviseItem(s, ev, at) {
  const conv = find(s.conversations, ev.convId, 'conversation'); const item = conv.items.find((x) => x.id === ev.itemId); if (!item) throw new Error(`unknown item: ${ev.itemId}`);
  const text = String(ev.text ?? '').replace(/\r\n/g, '\n').trim(); if (!text) throw new Error('the corrected text is required (a sentence cannot be corrected into nothing)');
  const before = currentTextOf(item); if (text === before) return; // nothing changed: no empty revision
  closeOpenTurns(conv, at, 'OWNER_CORRECTION', item.id); // a sentence being corrected is final: a late segment starts a new item and never changes this one
  item.revisions ??= []; const id = `${item.id}-r${item.revisions.length + 1}`;
  const speech = item.modality === MODALITY.SPEECH; const lang = (speech ? (item.lang && item.lang !== 'auto' ? item.lang : null) : item.lang) || detectLang(text);
  const exText = speech && lang === 'en' ? normalizeSpoken(text) : text; const r = extractFacts({ text: exText, lang });
  const kk = (c) => `${c.key}|${c.context ?? ''}|${JSON.stringify(c.value)}`; const fresh = new Set(r.candidates.map(kk));
  const mine = s.candidates.filter((c) => c.itemId === item.id); const superseded = []; const impacts = [];
  for (const c of mine) {
    if (fresh.has(kk(c))) continue;
    if (c.state === CANDIDATE_STATE.PROPOSED) { c.state = CANDIDATE_STATE.REJECTED; c.decidedAt = at; c.decidedBy = 'system'; c.rejectedReason = `the text was corrected by the owner (${id})`; c.supersededByRevision = id; superseded.push(c.id); }
    else if (c.state === CANDIDATE_STATE.CONFIRMED || c.state === CANDIDATE_STATE.CORRECTED) impacts.push({ kind: 'CONFIRMED_FROM_OLD_TEXT', candidateId: c.id, key: c.key, context: c.context ?? 'product', confirmed: c.state === CANDIDATE_STATE.CORRECTED ? c.correctedValue : c.value });
  }
  const added = [];
  for (const c of r.candidates) {
    const same = mine.find((x) => kk(x) === kk(c)); // the same value from the same item: never proposed twice; a value the OWNER rejected stays rejected
    if (same && !(same.state === CANDIDATE_STATE.REJECTED && same.decidedBy === 'system')) continue;
    const nc = { ...c, id: nextId('cand', s.candidates), convId: conv.id, itemId: item.id, speaker: item.speaker, basis: 'REVISION', revisionId: id, state: CANDIDATE_STATE.PROPOSED, proposedAt: at, flags: [...new Set([...(c.flags ?? []), 'OWNER_CORRECTED_TEXT'])] };
    const clash = findCandidateConflict(s, nc, nc.value); if (clash) impacts.push({ kind: 'DIFFERS_FROM_CONFIRMED', candidateId: nc.id, key: nc.key, context: nc.context ?? 'product', confirmed: clash.existing, proposed: nc.value });
    s.candidates.push(nc); added.push(nc.id);
  }
  item.revisions.push({ id, at, kind: 'OWNER_CORRECTION', by: 'owner', source: String(ev.source ?? 'owner-edit'), ref: item.id, convId: conv.id, of: item.revisions.at(-1)?.id ?? 'RAW', previousText: before, text, rawText: rawTextOf(item), ...(ev.reason ? { reason: String(ev.reason).slice(0, 300) } : {}), proposed: added, superseded, impacts });
}

/** A transcription (audio -> text) or a translation of a supplier item: DERIVED data kept next to the original, with who produced it and its review state. The original text/audio reference
 *  is never touched and nothing is proposed from a derivation by itself (facts come from the original or from the owner). This is the seam for the future interpreter. */
export function derive(s, ev, at) {
  const conv = find(s.conversations, ev.convId, 'conversation'); const item = conv.items.find((x) => x.id === ev.itemId); if (!item) throw new Error(`unknown item: ${ev.itemId}`);
  if (!['TRANSCRIPTION', 'TRANSLATION', 'OCR'].includes(ev.kind)) throw new Error('derivation kind must be TRANSCRIPTION, TRANSLATION or OCR'); if (!String(ev.text ?? '').trim()) throw new Error('derived text is required');
  const d = { id: `${item.id}-d${item.derived.length + 1}`, kind: ev.kind, lang: ev.lang ?? null, text: String(ev.text), provider: ev.provider ?? null, ...(ev.version ? { version: String(ev.version) } : {}), review: ev.review ?? 'MACHINE', at }; item.derived.push(d);
  // OPTIONAL: propose facts from the derived text. They are tagged with their basis, capped at MEDIUM confidence and flagged MACHINE_DERIVED: they can never join a grouped confirmation and are confirmed one by one.
  if (ev.extract === true && ['TRANSCRIPTION', 'TRANSLATION'].includes(ev.kind)) {
    const exText = ev.kind === 'TRANSCRIPTION' && (d.lang ?? 'en') === 'en' ? normalizeSpoken(d.text) : d.text; if (exText !== d.text) d.normalized = exText; // numbers said as words are read as digits for extraction only; the stored transcription is untouched
    const r = extractFacts({ text: exText, lang: d.lang && d.lang !== 'auto' ? d.lang : detectLang(d.text) });
    for (const c of r.candidates) s.candidates.push({ ...c, id: nextId('cand', s.candidates), convId: conv.id, itemId: item.id, speaker: item.speaker, basis: ev.kind, derivedId: d.id, confidence: c.confidence === 'HIGH' ? 'MEDIUM' : c.confidence, flags: [...new Set([...(c.flags ?? []), 'MACHINE_DERIVED'])], state: CANDIDATE_STATE.PROPOSED, proposedAt: at });
  }
}

// ---- compile a confirmed candidate into EXISTING events -----------------------------------------------------------------------------------------------------------------------
export function compile(s, c, value, level, source) {
  const k = c.key; const prev = s.quotes.at(-1) ?? null; const base = prev ? { ...prev } : (s.context?.plannedQty ? { qty: s.context.plannedQty } : {}); delete base.at; const quote = (patch, drop = []) => { const q = { ...base, ...patch }; for (const d of drop) delete q[d]; return [{ type: 'QUOTE', quote: q, summary: `from conversation (${c.id}): ${k}`, ref: { candidateId: c.id, offerId: c.offerId ?? null, key: k } }]; };
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

function apply(s, c, value, { corrected, at, reduce, conflictId = null, ownerDecided = false, meta = null }) {
  if (c.speaker === SPEAKER.UNKNOWN) throw new Error('this was heard by the microphone and nobody has said who spoke: say who spoke first (the supplier or you)');
  const status = confirmedStatus({ speaker: c.speaker, corrected });
  const level = corrected || c.speaker === SPEAKER.ME || ownerDecided ? 'USER_STATED' : 'SUPPLIER_CLAIMED';
  const source = { kind: 'conversation', convId: c.convId, itemId: c.itemId, candidateId: c.id };
  const superseding = supersedesExisting(s, c, value); const previousValue = superseding ? existingValue(s, c.key, c.context) : undefined; // an UPDATED offer: a negotiable term legitimately changes; the earlier value stays in the ledger
  const same = !c.key.startsWith('docClaim.') && !superseding && !isEmpty(existingValue(s, c.key, c.context)) && !findCandidateConflict(s, c, value); // the case already holds this value: corroboration only (a changed supplier STATEMENT about a document is always recorded)
  if (!same) for (const e of compile(s, c, value, level, source)) reduce(e);
  s.ledger.push({ id: nextId('led', s.ledger), key: c.key, value, context: c.context, status, source: { convId: c.convId, itemId: c.itemId, candidateId: c.id }, lang: c.lang, rawText: c.rawText, span: c.span, confirmedAt: at, userConfirmed: true, basis: c.basis ?? 'ORIGINAL', ...(c.revisionId ? { revisionId: c.revisionId } : {}), corrected: !!corrected, ...(corrected ? { original: { value: c.value, rawText: c.rawText } } : {}), ...(conflictId ? { resolvedConflict: conflictId } : {}), ...(meta ? { via: meta.via, batchId: meta.batchId } : {}), ...(c.offerId ? { offerId: c.offerId } : {}), ...(superseding ? { supersedes: true, previousValue } : {}) });
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

export function confirm(s, ev, at, reduce, { corrected = false, value = undefined, meta = null } = {}) {
  const c = find(s.candidates, ev.id, 'candidate');
  if (c.state === CANDIDATE_STATE.CONFIRMED || c.state === CANDIDATE_STATE.CORRECTED) return; // idempotent
  if (c.state === CANDIDATE_STATE.REJECTED) throw new Error('this candidate was already rejected');
  if (c.state === CANDIDATE_STATE.CONFLICT) throw new Error('this candidate is in conflict: resolve the conflict first');
  if (corrected && isEmpty(value)) throw new Error('a correction needs a value');
  if (!corrected && c.needsCorrection) throw new Error('this candidate needs a correction before it can be used');
  const v = corrected ? value : c.value;
  const found = findCandidateConflict(s, c, v); if (found) { raiseConflict(s, c, v, found, at); if (corrected) c.correctedValue = v; return; }
  apply(s, c, v, { corrected, at, reduce, meta });
}
export const correct = (s, ev, at, reduce) => confirm(s, ev, at, reduce, { corrected: true, value: ev.value });

/** One deliberate tap for a CLEAN group (via GROUP) or for the supplier's document statements (via CLAIMS). Eligibility is recomputed here, so a stale or forged list can never confirm
 *  an ambiguous, calculated, conflicting or low-confidence fact. What the owner was shown is recorded; each fact is still confirmed one by one, so provenance is identical. */
export function confirmBatch(s, ev, at, reduce) {
  const via = ev.via === 'CLAIMS' ? 'CLAIMS' : 'GROUP'; const ids = [...new Set(ev.ids ?? [])];
  const todo = []; for (const id of ids) { const c = find(s.candidates, id, 'candidate'); if (c.state === CANDIDATE_STATE.CONFIRMED || c.state === CANDIDATE_STATE.CORRECTED) continue; todo.push(c); }
  if (!todo.length) return;
  const cls = classifyCandidates(s); const ok = new Set((via === 'CLAIMS' ? cls.claims : cls.group).map((c) => c.id));
  for (const c of todo) if (!ok.has(c.id)) throw new Error(`candidate ${c.id} is not eligible for a ${via === 'CLAIMS' ? 'document-statement' : 'grouped'} confirmation: review it individually`);
  if (ev.shown) { const seen = new Set(ev.shown.map((x) => x.id)); if (todo.some((c) => !seen.has(c.id))) throw new Error('the confirmation does not match what was shown'); }
  const batchId = nextId('batch', s.confirmBatches);
  const shown = ev.shown ?? todo.map((c) => ({ id: c.id, key: c.key, value: c.value }));
  for (const c of todo) confirm(s, { id: c.id }, at, reduce, { meta: { via, batchId } });
  s.confirmBatches.push({ id: batchId, at, via, ids: todo.map((c) => c.id), shown });
}

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

export function finish(s, ev, at) { const conv = find(s.conversations, ev.convId, 'conversation'); closeOpenTurns(conv, at, 'CONVERSATION_FINISHED'); conv.status = 'FINISHED'; conv.finishedAt = at; }

// ---- free user questions -------------------------------------------------------------------------------------------------------------------------------------------------------
export function addQuestion(s, ev, at) {
  const text = String(ev.text ?? '').trim(); if (!text) throw new Error('question text is required');
  const lang = ev.lang && ev.lang !== 'auto' ? ev.lang : detectLang(text);
  s.userQuestions.push({ id: nextId('uq', s.userQuestions), at, origin: 'USER', text, lang, translation: null, state: 'OPEN', answeredBy: [] });
}
/** The engine's questions are recomputed from the case, so what was SHOWN to the supplier (and exactly in which words) or put aside is remembered here, append-only. */
export function questionShown(s, ev, at) {
  const id = String(ev.questionId ?? ''); if (!id) throw new Error('questionId is required');
  for (const c of s.conversations) if (c.status === 'OPEN') closeOpenTurns(c, at, 'QUESTION_SHOWN');
  s.questionLog.push({ id: nextId('ql', s.questionLog), questionId: id, kind: 'SHOWN', at, via: ev.via ?? 'SHOWN_TO_SUPPLIER', texts: ev.texts ?? null });
}
export function questionSkip(s, ev, at) { const id = String(ev.questionId ?? ''); if (!id) throw new Error('questionId is required'); s.questionLog.push({ id: nextId('ql', s.questionLog), questionId: id, kind: 'SKIPPED', at }); }
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
