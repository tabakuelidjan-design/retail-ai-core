// Conversation First: the CONTEXTUAL engine, a thin layer on top of P5 (planConversation, unchanged). P5 knows what is missing in the case; this layer knows what is being talked about NOW
// (core/topics.js) and brings forward at most ONE suggestion for the SUPPLIER that fits the current subject. Rules:
//  - the topic only REORDERS: every suggestion is a P5 question, or a suggested commercial question that P5 itself defines (phrases.js) and whose precondition is visible in the conversation;
//  - a statement that answers a suggestion (even before the user confirms it) makes it disappear: P5 reports it ANSWER_PENDING / resolved, and this layer never re-proposes it;
//  - owner cards (transport, duty, exchange rate, selling price, margin...) are NEVER conversation suggestions: they are listed apart for a sheet, on demand;
//  - a contradiction or a critical blocker is an ALERT, not a suggestion;
//  - nothing is stored: everything is recomputed from the case. A topic is a conversation notion, not a Socle "Subject", and a suggestion is a question to ask, not a "Lever".
import { upgradeCase } from './upgrade.js';
import { planConversation, stateOf, suggestedQuestion } from './conversation-engine.js';
import { currentTopic, topicChips, TOPIC } from './topics.js';
import { labelOf } from './candidate-view.js';
import { SUGGESTED, MARKET_PROFILES, DEFAULT_PROFILE } from './phrases.js';
import { classifyCandidates } from './understanding.js';
import { existingValue } from './conflicts.js';

const T = TOPIC;
const ACTIVE = new Set(['OPEN', 'UNANSWERED']);
// what is worth asking next to each subject (in this order). 's:' ids are the suggested commercial questions defined in phrases.js.
const ADJACENT = {
  [T.COLOURS]: ['s:mixed_colours', 's:colours'], [T.PRICE]: ['s:price_tiers', 'price'], [T.MOQ]: ['s:price_tiers'], [T.PAYMENT]: ['s:payment'], [T.LEADTIME]: ['lead_time'],
  [T.LOGISTICS]: ['carton', 'incoterm'], [T.IDENTITY]: ['model', 'manufacturer'], [T.DOCUMENTS]: ['docs-bundle'], [T.COMPLIANCE]: ['docs-bundle'], [T.CUSTOMISATION]: ['s:logo', 's:packaging'],
};
const kc = (key, ctx) => (ctx && ctx !== 'product' ? `${key}@${ctx}` : key);
const valueOf = (c) => c.correctedValue ?? c.value;
const showV = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

export function planContext(rawState, A, opts = {}) {
  const st = upgradeCase(rawState); const plan = planConversation(st, A, opts); const topic = currentTopic(st);
  const profile = opts.profile ?? MARKET_PROFILES[st.context?.originMarket ?? 'CN'] ?? DEFAULT_PROFILE; const providers = opts.providers ?? {};
  const items = st.conversations.flatMap((c) => c.items.map((it) => ({ ...it, convId: c.id }))); const log = st.questionLog ?? [];
  const live = st.candidates.filter((c) => c.state !== 'REJECTED'); const pendingKeys = new Set(st.candidates.filter((c) => c.state === 'PROPOSED').map((c) => kc(c.key, c.context)));
  const mentioned = (...keys) => live.some((c) => keys.includes(c.key)); // confirmed OR proposed: the conversation already contains it
  const listLen = (key) => Math.max(0, ...live.filter((c) => c.key === key).map((c) => { const v = valueOf(c); return Array.isArray(v) ? v.length : 0; }));
  const priceMentioned = mentioned('quote.unitPrice', 'quote.tiers'); const tiersMax = Math.max(0, ...live.filter((c) => c.key === 'quote.tiers').map((c) => (Array.isArray(valueOf(c)) ? valueOf(c).length : 0)));
  // the precondition of a suggested question that P5 does not offer yet (it waits for a CONFIRMED fact; the conversation can bring it forward on a stated one)
  const WHEN = {
    's:mixed_colours': () => listLen('variant.colours') > 1 && !mentioned('moq.mixedColours', 'moq.perColour'),
    's:price_tiers': () => priceMentioned && tiersMax < 2,
  };
  const byId = new Map(plan.questions.map((q) => [q.id, q]));
  const fetchQ = (id) => {
    const q = byId.get(id); if (q) return { ...q, origin: 'ADJACENT' };
    const sid = id.startsWith('s:') ? id.slice(2) : null; if (!sid || !SUGGESTED[sid] || !WHEN[id]?.()) return null;
    // a single stated tier does NOT answer "what are the other tiers?" (P5's key list says quote.tiers resolves it; here it takes two)
    const sq = suggestedQuestion(sid, profile, providers); const pk = id === 's:price_tiers' && tiersMax < 2 ? new Set([...pendingKeys].filter((k) => k !== 'quote.tiers')) : pendingKeys;
    const state = stateOf({ id: sq.id, resolves: sq.resolves, pendingKeys: pk, log, items });
    return { ...sq, state, repeat: state === 'UNANSWERED', short: { fr: SUGGESTED[sid].fr }, reason: sq.reason, origin: 'ADJACENT' };
  };
  const eligible = (q) => q && q.audience === 'SUPPLIER' && ACTIVE.has(q.state) && q.source !== 'CONFLICT' && q.source !== 'USER_FREE';

  const adjacent = topic.id === T.OTHER ? [] : (ADJACENT[topic.id] ?? []).map(fetchQ).filter(eligible);
  const taken = new Set(adjacent.map((q) => q.id));
  const synth = Object.keys(WHEN).filter((id) => !byId.has(id) && !taken.has(id)).map((id) => fetchQ(id)).filter(eligible).map((q) => ({ ...q, origin: 'GLOBAL' }));
  const global = [...plan.questions.filter((q) => eligible(q) && !taken.has(q.id)).map((q) => ({ ...q, origin: 'GLOBAL' })), ...synth];
  const ranked = [...adjacent, ...global];

  // alerts: only what has immediate value (a contradiction, a critical blocker)
  const alerts = classifyCandidates(st).attention.filter((a) => a.reason === 'CONFLICT').map((a) => ({ kind: 'CONFLICT', id: a.candidate.id, key: a.candidate.key, candidateId: a.candidate.id, text: { fr: `${labelOf(a.candidate.key, a.candidate.context, 'fr')} : avant ${showV(existingValue(st, a.candidate.key, a.candidate.context))}, maintenant ${showV(valueOf(a.candidate))}.` } }));
  alerts.push(...plan.contradictions.map((x) => { const [o, n] = x.entries.map((e) => showV(e.value)); return { kind: 'CONFLICT', id: x.id, key: x.key, questionId: x.questionId, text: { fr: `${labelOf(x.key, 'product', 'fr')} : avant ${o}, maintenant ${n}.` } }; }));
  for (const b of A.decision.hardBlockers ?? []) {
    if (b.code === 'SAFETY_ALERT_EXACT_MATCH') alerts.push({ kind: 'SAFETY', id: b.code, text: { fr: 'Alerte Safety Gate sur ce produit.' } });
    if (b.code === 'DOCUMENT_CONTRADICTS_CASE') alerts.push({ kind: 'DOCUMENT', id: b.code, text: { fr: 'Un document contredit le dossier.' } });
  }

  // compact, factual messages (never a verdict)
  const chips = topicChips(st, A); const messages = [];
  if (chips.find((c) => c.topic === T.DOCUMENTS && ['CLAIMED', 'PROMISED'].includes(c.doc))) messages.push({ code: 'DOCS_ANNOUNCED', fr: 'Documents annoncés, mais pas encore reçus.' });
  if (st.quotes.length && A.landed.status === 'INFORMATION_INSUFFICIENT') messages.push({ code: 'COST_INCOMPLETE', fr: 'Coût rendu incomplet.' });
  const n = plan.summary.missingImportant; if (plan.summary.stage !== 'EVALUABLE' && plan.summary.stage !== 'START' && n > 0 && n <= 5) messages.push({ code: 'MISSING', fr: `Il reste ${n} point${n > 1 ? 's' : ''} important${n > 1 ? 's' : ''} avant d'évaluer l'achat.` });

  return { topic, suggestion: ranked[0] ?? null, others: ranked.slice(1, 8), all: ranked, ownerCards: plan.questions.filter((q) => q.audience === 'USER' && ACTIVE.has(q.state)), alerts, messages: messages.slice(0, 3), chips, pending: plan.summary.pending, plan };
}
