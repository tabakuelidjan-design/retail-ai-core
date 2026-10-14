// The early field workflow (Discover -> Talk -> Capture -> Complete -> Analyze -> Decide -> Negotiate) as an HONEST view over the existing engines. Pure: it only SUMMARISES the case
// and its assessment; it never decides anything itself, never hides a blocker, and lists every engine that is not built yet as NOT AVAILABLE YET.
import { documentStatusOf } from './provenance.js';
import { documentModelConflicts } from './conflicts.js';
import { conflictText, documentConflictText } from './conversation.js';

export const STEP_IDS = Object.freeze(['discover', 'talk', 'capture', 'complete', 'analyze', 'decide', 'negotiate']);
export const UNAVAILABLE_ENGINES = Object.freeze([
  { id: 'market', label: 'European market demand and competitor prices', note: 'Not built yet. When it arrives, EU import statistics will be shown as trade activity, never as consumer demand or sales.' },
  { id: 'supplierIntel', label: 'Supplier checks (company registration, certificate registries)', note: 'Not built yet. Unknown will never mean bad.' },
  { id: 'customsLookup', label: 'Official customs duty lookup', note: 'Not available: the duty stays what you enter, marked as yours.' },
  { id: 'purchasePlan', label: 'Whole-trip budget and cash plan', note: 'Not built yet.' },
  { id: 'businessDecision', label: 'Business decision (buy / negotiate / wait / pass)', note: 'Needs your business profile, the money plan and market evidence.' },
]);
const words = (x) => String(x ?? '').replace(/_/g, ' ');

/** @param {object} state the case @param {object} A the output of assess(state) */
export function fieldProgress(state, A) {
  const p1 = (A.questions ?? []).filter((q) => q.priority === 'P1'); const name = state.identity?.workingName || ''; const cat = A.identity?.category ?? null; const conf = A.identity?.confidence?.level ?? 'LOW';
  const cands = state.candidates ?? []; const convs = state.conversations ?? []; const pending = cands.filter((c) => c.state === 'PROPOSED').length; const confirmed = cands.filter((c) => c.state === 'CONFIRMED' || c.state === 'CORRECTED').length;
  const openConflicts = (state.conflicts ?? []).filter((x) => x.state === 'OPEN'); const docConflicts = documentModelConflicts(state);
  const claimKeys = [...new Set((state.documentLedger ?? []).filter((d) => ['CLAIMED', 'PROMISED'].includes(d.status)).map((d) => d.claim))];
  const claimsNotReceived = claimKeys.filter((k) => ['CLAIMED', 'PROMISED'].includes(documentStatusOf(state, k).status));
  const items = [
    ...openConflicts.map((x) => ({ kind: 'CONFLICT', text: conflictText(x), id: x.id })),
    ...docConflicts.map((d) => ({ kind: 'DOCUMENT_MODEL', text: documentConflictText(d), id: d.docId })),
    ...claimsNotReceived.map((k) => ({ kind: 'DOCUMENT_CLAIM', text: `${k === 'UN383' ? 'UN 38.3' : k}: the supplier says so, but no document was received yet` })),
    ...p1.slice(0, 6).map((q) => ({ kind: 'QUESTION', text: q.en, id: q.id, topic: q.topic })),
  ];
  const mp = A.maxPurchasePrice; const hasMax = mp?.maxUnitPriceMinor !== null && mp?.maxUnitPriceMinor !== undefined; const verdict = A.decision.verdict;
  const hasAnyCommercial = (state.quotes ?? []).length > 0;

  const steps = [
    { id: 'discover', label: 'Discover', status: conf !== 'LOW' ? 'DONE' : name || cat ? 'IN_PROGRESS' : 'TODO', summary: name || cat ? `${name || 'Unnamed product'}${cat ? ' - category set' : ''}. Identification: ${conf.toLowerCase()}.` : 'Start with a photo or the name of the product.' },
    { id: 'talk', label: 'Talk', status: p1.length === 0 ? 'DONE' : (state.userQuestions ?? []).length || convs.length ? 'IN_PROGRESS' : 'TODO', open: p1.length, summary: p1.length ? `${p1.length} important question${p1.length > 1 ? 's' : ''} still open` : 'No important question left to ask.' },
    { id: 'capture', label: 'Capture', status: !convs.length ? 'TODO' : convs.some((c) => c.status === 'OPEN') || pending > 0 ? 'IN_PROGRESS' : 'DONE', pending, confirmed, summary: !convs.length ? 'Nothing captured yet: type or paste what the supplier says.' : `${pending} to review, ${confirmed} confirmed` },
    { id: 'complete', label: 'Complete', status: items.length ? 'IN_PROGRESS' : 'DONE', conflicts: openConflicts.length + docConflicts.length, claimsNotReceived, items, summary: items.length ? `${items.length} thing${items.length > 1 ? 's' : ''} still missing or to clarify` : 'Nothing missing that the engines know of.' },
    { id: 'analyze', label: 'Analyze', status: !hasAnyCommercial ? 'TODO' : A.landed.status === 'INFORMATION_INSUFFICIENT' ? 'IN_PROGRESS' : 'DONE', summary: !hasAnyCommercial ? 'Needs at least the supplier price.' : A.landed.status === 'INFORMATION_INSUFFICIENT' ? `Cannot calculate the cost yet: ${(A.landed.criticalUnknown ?? []).map((u) => words(String(u).replace(/^costs\./, ''))).join(', ')}` : 'Landed cost and margin calculated from what is known.' },
    { id: 'decide', label: 'Decide', status: verdict === 'INSUFFICIENT_INFORMATION' ? 'IN_PROGRESS' : 'DONE', verdict, hardBlockers: A.decision.hardBlockers.map((b) => b.code), summary: `Compliance and economics verdict: ${words(verdict)}. Business decision: not available yet.` },
    { id: 'negotiate', label: 'Negotiate', status: hasMax ? 'IN_PROGRESS' : 'NOT_AVAILABLE', summary: hasMax ? `Walk-away price ${mp.display}${A.negotiation?.targetUnitPrice?.display ? `, target ${A.negotiation.targetUnitPrice.display}` : ''}.` : `Not available yet: ${words(mp?.reason ?? 'needs a supplier price and a selling price')}.` },
  ];
  const nextStep = openConflicts.length || docConflicts.length ? { step: 'complete', text: `Clear the contradiction first: ${openConflicts[0] ? conflictText(openConflicts[0]) : documentConflictText(docConflicts[0])}` }
    : pending > 0 ? { step: 'capture', text: `Review the ${pending} fact${pending > 1 ? 's' : ''} found in the conversation: confirm, correct or reject each one.` }
    : conf === 'LOW' && !name && !cat ? { step: 'discover', text: 'Tell Nordla what the product is (photo or name).' }
    : p1.length ? { step: 'talk', text: `Ask the supplier: ${p1[0].topic ?? p1[0].en}` }
    : A.landed.status === 'INFORMATION_INSUFFICIENT' && hasAnyCommercial ? { step: 'analyze', text: 'Add the missing cost or price shown under Analyze.' }
    : { step: 'decide', text: 'Read the verdict and what could change it.' };
  return { steps, nextStep, unavailable: UNAVAILABLE_ENGINES.map((u) => ({ ...u, status: 'NOT_AVAILABLE_YET' })), businessDecision: { status: 'NOT_AVAILABLE_YET', label: 'Business decision - NOT AVAILABLE YET', reason: 'It needs your business profile, the money plan and market evidence, which are not built yet.' } };
}
