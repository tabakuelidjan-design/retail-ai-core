// Parle à Nordla - minimal conversation context (stage F). Pure: a state object goes in, a new one comes out; this module stores nothing, reads no case and has no global memory.
// The caller (one signed-in person, one session) owns the state and passes it back with the next question. It holds IDS and intents only - never a figure, a document or a case:
// every answer recomputes from the case itself, so a follow-up can never reuse a stale number. The active case is always the one the caller names; a different case or merchant resets everything.
import { FIELD_INTENT as I, normalize } from './field-intents.js';

export const CONTEXT_VERSION = 1;
const MAX_TURNS = 10;

/**
 * @param {object|null} prev the state returned by the previous turn (or null)
 * @param {{ merchantId: string, caseId: string, caseVersion: string|null, intent: string, sources: object[], now: Date }} turn
 * @returns {{ conversation: object, notice: string|null }}
 */
export function stepConversation(prev, { merchantId, caseId, caseVersion, intent, sources = [], now = new Date() }) {
  const sameScope = prev && prev.v === CONTEXT_VERSION && prev.merchantId === merchantId && prev.caseId === caseId;
  let notice = null;
  if (prev && !sameScope) notice = prev.merchantId !== merchantId ? null : `Dossier actif : ${caseId}. Le contexte du dossier précédent (${prev.caseId}) n’est pas réutilisé.`;
  else if (sameScope && prev.caseVersion !== caseVersion) notice = `Le dossier a changé depuis ma dernière réponse (version ${prev.caseVersion ?? 'inconnue'} → ${caseVersion ?? 'inconnue'}) : tout est recalculé, aucun ancien chiffre n’est repris.`;
  const turns = sameScope ? prev.turns : [];
  return {
    notice,
    conversation: {
      v: CONTEXT_VERSION, merchantId, caseId, caseVersion,
      turns: [...turns, { intent, at: now.toISOString(), sources: sources.map((s) => ({ kind: s.kind, ref: s.ref, version: s.version ?? null })) }].slice(-MAX_TURNS),
    },
  };
}

/**
 * Elliptical sentences that only mean something after another one ("et ensuite ?", "pourquoi ?"). Returns an intent, or null when there is no safe reading
 * (no state, another case, another merchant): then the caller asks instead of guessing.
 */
export function followUpIntent(text, conversation, { merchantId, caseId }) {
  if (!conversation || conversation.v !== CONTEXT_VERSION || conversation.merchantId !== merchantId || conversation.caseId !== caseId) return null;
  const last = conversation.turns.at(-1)?.intent; if (!last) return null;
  const t = normalize(text).replace(/\?+$/, '').trim();
  if (/^(et )?(ensuite|apres|alors|puis)$/.test(t)) return I.NEXT_STEP;
  if (/^(et )?pourquoi$/.test(t)) return [I.CAN_ORDER, I.RISKS, I.MISSING, I.DOCUMENTS, I.NEXT_STEP].includes(last) ? I.RISKS : I.EXPLAIN_RECOMMENDATION;
  if (/^(et )?(le|la|les) (reste|autres?)$/.test(t) || /^(et )?(quoi )?d autre$/.test(t)) return last === I.MISSING || last === I.DOCUMENTS ? I.RISKS : I.MISSING;
  return null;
}
