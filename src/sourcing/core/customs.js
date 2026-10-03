// Customs / import intelligence. Nordla does NOT classify goods and does NOT invent duty: it lists CANDIDATE headings (hints), takes a duty rate only from the
// user or from an official lookup that says what it is, and says "CUSTOMS CLASSIFICATION REQUIRES CONFIRMATION" until a binding decision exists. The cheapest tariff
// is never selected silently. A TARIC lookup must model origin, measure validity and additional codes; here its result is only carried and labelled.
import { CATEGORIES } from './taxonomy.js';
import { FACT_CLASS } from './levels.js';

export function hsCandidates(identity) {
  const cat = identity.evidence?.category?.at(-1)?.value; const profile = cat ? CATEGORIES[cat] : null;
  const list = (profile?.hs ?? []).map((h) => ({ ...h, basis: 'CATEGORY_HINT', factClass: FACT_CLASS.ESTIMATE }));
  const user = (identity.hsCandidates ?? []).map((h) => ({ code: h.code, desc: h.desc ?? 'entered by the user', confidence: h.confidence ?? 'USER', basis: h.basis ?? 'USER_ENTERED', factClass: FACT_CLASS.ESTIMATE }));
  return [...user, ...list.filter((h) => !user.some((u) => u.code === h.code))];
}

/**
 * @param {{ candidates: object[], chosenCode?: string|null, duty?: { ratePct?: number|string|null, source?: string, kind?: 'TAXUD_LOOKUP'|'USER_ENTERED'|'BTI', checkedAt?: string, measures?: object[], origin?: string, validFrom?: string }|null,
 *           bti?: { number: string, validUntil?: string }|null, now?: Date }} args
 */
export function customsAssessment({ candidates, chosenCode = null, duty = null, bti = null, now = new Date() }) {
  const today = now.toISOString().slice(0, 10);
  const btiValid = bti && (!bti.validUntil || bti.validUntil >= today);
  const status = btiValid ? 'CLASSIFICATION_BINDING_BTI' : chosenCode ? 'CLASSIFICATION_CHOSEN_UNCONFIRMED' : 'CLASSIFICATION_REQUIRES_CONFIRMATION';
  const measures = duty?.measures ?? []; const tradeDefence = measures.filter((m) => /anti-?dumping|countervailing|safeguard|prohibition|restriction|quota|surveillance/i.test(String(m.type ?? m.description ?? '')));
  return {
    status, requiresConfirmation: !btiValid, candidates, chosenCode: chosenCode ?? null,
    duty: duty && duty.ratePct !== undefined && duty.ratePct !== null ? { ratePct: Number(duty.ratePct), source: duty.source ?? null, kind: duty.kind ?? 'USER_ENTERED', checkedAt: duty.checkedAt ?? null, origin: duty.origin ?? null, factClass: duty.kind === 'TAXUD_LOOKUP' ? FACT_CLASS.VERIFIED_FACT : FACT_CLASS.ESTIMATE } : { ratePct: null, factClass: FACT_CLASS.UNKNOWN },
    tradeMeasures: tradeDefence, tradeMeasureWarning: tradeDefence.length > 0,
    notes: [
      ...(btiValid ? [] : ['CUSTOMS CLASSIFICATION REQUIRES CONFIRMATION: only a Binding Tariff Information (BTI) or the customs authority settles the code; the candidates are hints']),
      ...(duty && duty.kind !== 'TAXUD_LOOKUP' && duty.ratePct !== undefined && duty.ratePct !== null ? ['the duty rate was entered by the user, not read from the tariff by Nordla: verify it for the exact code, origin and date'] : []),
      ...(candidates.length > 1 ? [`${candidates.length} candidate headings: the duty can differ between them - the cheapest is NOT assumed`] : []),
    ],
  };
}
