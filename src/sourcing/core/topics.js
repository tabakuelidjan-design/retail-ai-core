// Conversation First: the CURRENT TOPIC and the compact status chips. Pure and derived from the case on every call - nothing here is stored, so it replays identically on every device.
// The topic is what is being talked about NOW (the last statement). It is found from the facts the extractor already proposed (confidence HIGH), or, when there are none, from fixed keywords
// (confidence LOW). It is a CONVERSATION notion: it only reorders what is worth suggesting, it never adds a requirement, and it is not a Socle "Subject".
// Chip symbols: ✓ confirmed BY THE USER (never "verified"), ◐ partly confirmed, ◌ the supplier says it (not confirmed by the user), ! to check, ? unknown.
// Documents have their own states and never get a ✓: a claimed or received document is not an accepted proof.
import { upgradeCase } from './upgrade.js';
import { documentStatusOf, FACT_STATUS } from './provenance.js';
import { findCandidateConflict } from './conflicts.js';
import { effectiveQuote } from './offers.js';

export const TOPIC = Object.freeze({ IDENTITY: 'IDENTITY', PRICE: 'PRICE', MOQ: 'MOQ', COLOURS: 'COLOURS', LOGISTICS: 'LOGISTICS', PAYMENT: 'PAYMENT', LEADTIME: 'LEADTIME', CUSTOMISATION: 'CUSTOMISATION', DOCUMENTS: 'DOCUMENTS', COMPLIANCE: 'COMPLIANCE', OTHER: 'OTHER' });
const T = TOPIC;

/** The topic of a fact key. */
export function topicOfKey(key) {
  if (key.startsWith('identifier.')) return T.IDENTITY;
  if (key === 'quote.moq') return T.MOQ;
  if (['quote.unitPrice', 'quote.tiers', 'quote.currency', 'quote.samplePrice'].includes(key)) return T.PRICE;
  if (key.startsWith('variant.') || key === 'moq.mixedColours' || key === 'moq.perColour') return T.COLOURS;
  if (key.startsWith('carton.') || key.startsWith('product.') || key === 'quote.incoterm' || key === 'quote.port') return T.LOGISTICS;
  if (key.startsWith('payment.')) return T.PAYMENT;
  if (key === 'quote.leadTime') return T.LEADTIME;
  if (key.startsWith('docClaim.')) return T.DOCUMENTS;
  return T.OTHER;
}

// fixed keywords (English, French, Chinese): used ONLY when a statement produced no fact. Order = tie-break.
const KEYWORDS = [
  [T.CUSTOMISATION, /\blogo\b|custom|\boem\b|\bodm\b|personnalis|packag|emballage|定制|包装|贴牌|logo/i],
  [T.COMPLIANCE, /lithium|batter|\bcell\b|regulat|complian|certif|safety|锂|电池|认证|合规|安全/i],
  [T.COLOURS, /colou?rs?\b|\b(?:black|white|blue|pink|red|green|grey|gray|silver)\b|couleur|颜色|黑色|白色|蓝色|粉色|红色|绿色/i],
  [T.MOQ, /\bmoq\b|minimum order|min\.? order|起订|最小订/i],
  [T.PAYMENT, /deposit|balance|payment|\bt\/t\b|paypal|acompte|paiement|定金|预付|付款|尾款/i],
  [T.LEADTIME, /lead ?time|production time|delivery time|\bweeks?\b|délai|交期|工期|生产周期/i],
  [T.LOGISTICS, /carton|incoterm|\bfob\b|\bcif\b|\bexw\b|\bddp\b|shipping|freight|\bport\b|纸箱|装箱|港|运费/i],
  [T.PRICE, /price|\busd\b|\$|€|\brmb\b|\bcny\b|cost|prix|价格|单价|美元|人民币/i],
  [T.IDENTITY, /model|brand|manufacturer|factory|型号|品牌|工厂/i],
];

/** The topic of ONE statement of the conversation. */
export function topicOfItem(rawState, item) {
  const st = upgradeCase(rawState);
  const cands = st.candidates.filter((c) => c.itemId === item.id && c.state !== 'REJECTED');
  const counts = new Map(); const evidence = [];
  for (const c of cands) { const t = topicOfKey(c.key); if (t === T.OTHER) continue; counts.set(t, (counts.get(t) ?? 0) + 1); evidence.push(c.id); }
  if (counts.size) { const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]); return { id: ranked[0][0], confidence: 'HIGH', source: 'FACTS', evidence, also: ranked.slice(1).map(([t]) => t) }; }
  const text = String(item.original ?? ''); const hits = [];
  for (const [t, rx] of KEYWORDS) { const m = text.match(new RegExp(rx.source, `${rx.flags.replace('g', '')}g`)); if (m) hits.push([t, m.length]); }
  if (hits.length) { hits.sort((a, b) => b[1] - a[1]); return { id: hits[0][0], confidence: 'LOW', source: 'KEYWORDS', evidence: [`keyword:${hits[0][0]}`], also: hits.slice(1).map(([t]) => t) }; }
  return { id: T.OTHER, confidence: 'LOW', source: 'NONE', evidence: [], also: [] };
}

/** What is being talked about NOW: the topic of the last statement (the supplier's or the owner's), and since which statement it has been running. */
export function currentTopic(rawState) {
  const st = upgradeCase(rawState);
  const items = st.conversations.flatMap((c) => c.items).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (!items.length) return { id: T.OTHER, confidence: 'LOW', source: 'NONE', itemId: null, sinceItem: null, evidence: [], also: [] };
  const last = items.at(-1); const t = topicOfItem(st, last); let since = last.id;
  for (let i = items.length - 2; i >= 0; i -= 1) { if (topicOfItem(st, items[i]).id !== t.id) break; since = items[i].id; }
  return { ...t, itemId: last.id, sinceItem: since };
}

// ---- compact status chips ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const CHIP_TOPICS = [T.IDENTITY, T.PRICE, T.MOQ, T.COLOURS, T.LEADTIME, T.PAYMENT, T.DOCUMENTS];
const LABEL = { IDENTITY: 'Modèle', PRICE: 'Prix', MOQ: 'MOQ', COLOURS: 'Couleurs', LEADTIME: 'Délai', PAYMENT: 'Paiement', DOCUMENTS: 'Documents' };
// the keys that make a topic "complete" (all of them), and the ones of which ANY counts as "something confirmed"
const FULL = { IDENTITY: [['identifier.model']], PRICE: [['quote.unitPrice', 'quote.tiers']], MOQ: [['quote.moq']], COLOURS: [['variant.colours'], ['moq.mixedColours']], LEADTIME: [['quote.leadTime']], PAYMENT: [['payment.depositPct']] };
const MEANING = {
  '✓': 'confirmé par vous', '◐': 'en partie confirmé par vous', '◌': 'le fournisseur l\'affirme, pas encore confirmé par vous', '!': 'à vérifier', '?': 'inconnu',
};
const DOC_MEANING = { NONE: 'inconnu', CLAIMED: 'annoncé par le fournisseur, pas reçu', PROMISED: 'promis par le fournisseur, pas reçu', RECEIVED: 'reçu, pas encore accepté comme preuve', MISMATCH: 'reçu mais d\'un autre modèle : à vérifier' };

function haveKeys(st) {
  const have = new Set();
  for (const c of st.candidates) if (c.state === 'CONFIRMED' || c.state === 'CORRECTED') have.add(c.key);
  for (const e of st.ledger ?? []) if (e.status !== FACT_STATUS.UNKNOWN) have.add(e.key);
  const q = st.quotes.at(-1) ? effectiveQuote(st.quotes.at(-1)) : null;
  if (st.identity?.identifiers?.model) have.add('identifier.model');
  if (q?.moq) have.add('quote.moq'); if (q?.unitPrice) have.add('quote.unitPrice'); if (q?.tiers?.length) have.add('quote.tiers'); if (q?.leadTime) have.add('quote.leadTime'); if (q?.payment?.depositPct) have.add('payment.depositPct');
  return have;
}

/** The compact state of each topic the screen shows. Returns [{ topic, label, symbol, kind, meaning }] in a fixed order. */
export function topicChips(rawState, A) {
  const st = upgradeCase(rawState); void A; const have = haveKeys(st);
  const proposed = st.candidates.filter((c) => c.state === 'PROPOSED');
  const flagged = (c) => c.needsCorrection || (c.flags ?? []).some((f) => ['AMBIGUOUS_NUMBER', 'DUPLICATE_THRESHOLD'].includes(f)) || c.confidence === 'LOW' || !!findCandidateConflict(st, c, c.correctedValue ?? c.value);
  const openConflictKeys = new Set(st.conflicts.filter((x) => x.state === 'OPEN').map((x) => x.key));
  return CHIP_TOPICS.map((topic) => {
    const label = { fr: LABEL[topic] };
    if (topic === T.DOCUMENTS) {
      const claims = [...new Set([...st.candidates.filter((c) => c.key.startsWith('docClaim.')).map((c) => c.key.slice(9)), ...(st.documentLedger ?? []).map((d) => d.claim)])];
      const states = claims.map((cl) => documentStatusOf(st, cl)); const pend = proposed.some((c) => c.key.startsWith('docClaim.'));
      let doc = 'NONE';
      if (states.some((x) => x.status === 'MISMATCH')) doc = 'MISMATCH';
      else if (states.some((x) => [FACT_STATUS.DOCUMENT_RECEIVED, FACT_STATUS.DOCUMENT_MATCHED].includes(x.status))) doc = 'RECEIVED';
      else if (states.some((x) => x.status === 'PROMISED')) doc = 'PROMISED';
      else if (states.length || pend) doc = 'CLAIMED';
      const symbol = doc === 'NONE' ? '?' : doc === 'MISMATCH' ? '!' : doc === 'RECEIVED' ? '◐' : '◌';
      return { topic, label, symbol, kind: 'DOCUMENT', doc, meaning: { fr: DOC_MEANING[doc] } };
    }
    const keysOfTopic = (k) => topicOfKey(k) === topic;
    const attention = proposed.some((c) => keysOfTopic(c.key) && flagged(c)) || [...openConflictKeys].some(keysOfTopic);
    const groups = FULL[topic] ?? []; const done = groups.filter((g) => g.some((k) => have.has(k))).length; const anyHave = [...have].some(keysOfTopic);
    const anyProposed = proposed.some((c) => keysOfTopic(c.key));
    const symbol = attention ? '!' : done === groups.length && groups.length ? '✓' : (done > 0 || anyHave) ? '◐' : anyProposed ? '◌' : '?';
    return { topic, label, symbol, kind: 'FACT', meaning: { fr: MEANING[symbol] } };
  });
}
