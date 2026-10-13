// QUESTIONS TO ASK NOW. The conversation engine already knows every open question and scores it; in front of a supplier the owner needs the SMALLEST high-value set (2 to 5), in the order of what
// each answer changes in the decision. This module selects and ranks that set from the engine's own questions (nothing is invented) and says, for each one, why it is on the list.
// Chinese text always carries its review state. The phrasebook has no native-speaker review today: it is shown as TECHNICAL_ONLY / UNREVIEWED, never as certified.
import { planConversation } from '../conversation-engine.js';
import { TEMPLATES } from '../supplier.js';
import { REVIEW, reviewFor, NATIVE_REVIEW } from '../phrases.js';
import { describeCandidate } from '../candidate-view.js';

export const ASK_MIN = 2;
export const ASK_MAX = 5;
/** Decision impact by kind of question. Higher = earlier. The order follows what changes a purchase decision most. */
export const IMPACT = Object.freeze({ COMPLIANCE_BLOCKER: 100, IDENTITY: 98, CONFLICT_PRICE: 97, CONFLICT: 95, PRICE: 93, MOQ: 92, MATERIAL: 90, CERTIFICATION: 88, INCOTERM: 84, LEAD_TIME: 70, PAYMENT: 64, SAMPLE: 50, CARTON: 45, OTHER: 30 });
const ACTIVE = new Set(['OPEN', 'UNANSWERED']);
export const CHINESE_NOTE = 'The Chinese is a fixed phrasebook, checked technically but NOT reviewed by a native speaker. Model numbers, standards and document names are inserted exactly. Have anything important checked by a Chinese speaker.';

const WHY = {
  COMPLIANCE_BLOCKER: 'a document contradicts the product or a required document is missing: the order cannot go ahead', IDENTITY: 'nothing can be tied to a product without its exact model', CONFLICT_PRICE: 'the supplier gave two different prices or quantities', CONFLICT: 'two statements contradict each other',
  PRICE: 'no usable unit price: nothing can be calculated', MOQ: 'the minimum order is unknown', MATERIAL: 'the material decides compliance, printing and quality', CERTIFICATION: 'a certificate or test report is missing', INCOTERM: 'the Incoterm decides which costs the price already includes',
  LEAD_TIME: 'delivery time is needed before committing', PAYMENT: 'the payment terms decide how much cash is at risk before delivery', SAMPLE: 'a sample lets you check the product before a deposit', CARTON: 'carton data is needed to estimate freight', OTHER: 'useful for the decision',
};
const FR_WHY = {
  COMPLIANCE_BLOCKER: "un document contredit le produit ou un document obligatoire manque : la commande est bloquée", IDENTITY: "sans le modèle exact, rien ne peut être rattaché au produit", CONFLICT_PRICE: 'le fournisseur a donné deux prix ou deux quantités différents', CONFLICT: 'deux informations se contredisent',
  PRICE: "pas de prix unitaire utilisable : rien ne peut être calculé", MOQ: 'le minimum de commande est inconnu', MATERIAL: 'la matière décide de la conformité, de l’impression et de la qualité', CERTIFICATION: 'un certificat ou un rapport d’essai manque', INCOTERM: "l’Incoterm décide des coûts déjà inclus dans le prix",
  LEAD_TIME: 'le délai est nécessaire avant de s’engager', PAYMENT: 'les conditions de paiement décident de l’argent exposé avant livraison', SAMPLE: 'un échantillon permet de vérifier avant un acompte', CARTON: 'les données du carton servent à estimer le transport', OTHER: 'utile pour la décision',
};

// A fact the supplier ALREADY gave (extracted, not yet confirmed by the owner) is not asked again: the list proposes to VERIFY it instead. Nothing is confirmed here.
const VERIFIABLE = new Set(['identifier.model', 'identifier.manufacturer', 'quote.unitPrice', 'quote.tiers', 'quote.moq', 'quote.incoterm', 'quote.leadTime', 'spec.material']);
function verifyRow(q, state, i) {
  const c = state.candidates.filter((x) => x.state === 'PROPOSED' && (q.resolves ?? []).includes(x.key) && VERIFIABLE.has(x.key)).at(-1); if (!c) return null;
  const en = describeCandidate(c, 'en'); const fr = describeCandidate(c, 'fr'); const shown = c.needsCorrection && (c.value === null || c.value === undefined) ? `"${c.rawText}" (unclear)` : en.valueText; const shownFr = c.needsCorrection && (c.value === null || c.value === undefined) ? `« ${c.rawText} » (ambigu)` : fr.valueText;
  return { q: { id: q.id, source: 'VERIFY', audience: 'SUPPLIER', dimension: q.dimension, priority: q.priority, state: 'OPEN', text: { fr: `Vérifier avec le fournisseur : ${fr.label} ${shownFr}`, en: `Please confirm: ${en.label} ${shown}.` }, supplier: { en: `Please confirm: ${en.label} ${shown}.` }, resolves: q.resolves, need: { score: null }, verify: { candidateId: c.id, key: c.key, valueText: shownFr, needsCorrection: c.needsCorrection === true } }, i };
}
function classify(q, state) {
  if (q.source === 'CONFLICT') return /^quote\.(unitPrice|tiers|currency|moq)/.test(state.conflicts.find((x) => x.id === q.conflictId)?.key ?? '') ? 'CONFLICT_PRICE' : 'CONFLICT';
  if (q.id === 'model' || q.id === 'manufacturer') return 'IDENTITY';
  if (q.id.endsWith(':fix') || (q.id === 'docs-bundle' && q.priority === 'P1') || (q.dimension === 'DOCUMENTS' && q.priority === 'P1' && q.blocksOrder)) return q.id.endsWith(':fix') ? 'COMPLIANCE_BLOCKER' : 'CERTIFICATION';
  if (q.id === 'docs-bundle' || q.id.startsWith('doc:')) return 'CERTIFICATION';
  if (q.id === 'price') return (q.resolves ?? []).includes('quote.moq') && !(q.resolves ?? []).includes('quote.unitPrice') ? 'MOQ' : 'PRICE';
  if (q.id === 'incoterm') return 'INCOTERM'; if (q.id === 'lead_time') return 'LEAD_TIME'; if (q.id === 's:payment') return 'PAYMENT'; if (q.id === 'sample') return 'SAMPLE'; if (q.id === 'carton') return 'CARTON';
  if (q.id === 'field:material') return 'MATERIAL';
  return 'OTHER';
}

/**
 * @param {object} state the case @param {object} a its assessment
 * @param {{ max?: number, min?: number, askState?: object, providers?: object }} opts `askState`: { [questionId]: { state, at } } the owner set in the field (ASKED / ANSWERED / SKIPPED)
 */
export function askNow(state, a, { max = ASK_MAX, min = ASK_MIN, askState = {}, providers = {} } = {}) {
  const plan = planConversation(state, a, { providers });
  const pending = new Set(state.candidates.filter((c) => c.state === 'PROPOSED').map((c) => c.key));
  const rows = plan.questions.filter((q) => q.audience === 'SUPPLIER' && q.source !== 'USER_FREE' && ACTIVE.has(q.state)).map((q, i) => ({ q, i }));
  // the material of the product is a basic question for any product (the engine asks it only for textiles): added here, only while it is genuinely unknown
  const materialKnown = state.ledger.some((e) => e.key === 'spec.material') || pending.has('spec.material');
  const extra = []; if (!materialKnown) { const t = TEMPLATES.materials; extra.push({ id: 'field:material', source: 'FIELD', audience: 'SUPPLIER', dimension: 'SPECIFICATION', priority: 'P2', state: 'OPEN', text: { fr: 'De quelle matière est fait le produit (matière principale, revêtement, peinture) ?', en: t.en }, supplier: { zh: { text: t.zh, review: reviewFor('materials', REVIEW.TECHNICAL_ONLY), lang: 'zh' }, en: t.en }, resolves: ['spec.material'], need: { score: null } }); }
  const verifying = plan.questions.filter((q) => q.audience === 'SUPPLIER' && q.state === 'ANSWER_PENDING').map((q, i) => verifyRow(q, state, i)).filter(Boolean).map((r) => r.q);
  const all = [...rows.map((r) => r.q), ...verifying, ...extra].map((q, i) => {
    const cls = q.source === 'VERIFY' ? classify({ ...q, source: 'ENGINE' }, state) : classify(q, state); const w = IMPACT[cls] ?? IMPACT.OTHER; const eng = q.need?.score ?? 0;
    return { q, cls, weight: cls === 'OTHER' ? Math.min(IMPACT.OTHER + eng / 10, 59) : w - (q.source === 'VERIFY' ? 0.5 : 0), engineScore: eng, i };
  }).sort((x, y) => y.weight - x.weight || y.engineScore - x.engineScore || x.i - y.i);
  const chosen = []; for (const r of all) { if (chosen.length >= max) break; if (chosen.length >= min && r.weight < 45) break; chosen.push(r); }
  const items = chosen.map((r, k) => {
    const zh = r.q.supplier?.zh ?? null; const st = askState[r.q.id]?.state ?? (r.q.state === 'UNANSWERED' ? 'ASKED_NO_ANSWER' : 'OPEN');
    return { rank: k + 1, id: r.q.id, kind: r.cls, weight: r.weight, source: r.q.source, ...(r.q.verify ? { verify: r.q.verify } : {}), why: WHY[r.cls] ?? WHY.OTHER, whyFr: FR_WHY[r.cls] ?? FR_WHY.OTHER, fr: r.q.text.fr ?? null, en: r.q.text.en ?? r.q.supplier?.en ?? null,
      zh: zh && zh.text ? { text: zh.text, review: zh.review, lang: zh.lang ?? 'zh', nativeReviewed: zh.review === REVIEW.NATIVE_REVIEWED } : null, zhNote: zh && zh.text ? null : 'No Chinese sentence available for this question: none is invented.',
      state: st, repeat: r.q.repeat === true, resolves: r.q.resolves ?? [], docs: r.q.items?.map((x) => ({ id: x.id, docType: x.docType })) ?? null };
  });
  const open = all.length; const hasNative = Object.keys(NATIVE_REVIEW).length > 0;
  return { type: 'AskNow', caseId: state.id, items, totalOpen: open, omitted: Math.max(0, open - items.length), empty: items.length === 0, chineseNote: hasNative ? 'Some Chinese sentences were reviewed by a native speaker; each carries its own review state.' : CHINESE_NOTE, nativeReviewAvailable: hasNative,
    message: items.length ? `${items.length} question${items.length > 1 ? 's' : ''} before leaving the stand${open > items.length ? ` (${open - items.length} lower-impact question${open - items.length > 1 ? 's' : ''} can wait)` : ''}.` : 'Nothing decision-relevant is open for this offer.' };
}
