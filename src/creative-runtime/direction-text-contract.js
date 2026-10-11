import { DIRECTION_TEXT_MAX_CHARS } from '../creative-intelligence/creative-direction.js';
import { COMPONENT, DECISION } from './ledger.js';

// The text contract of a Creative Direction, enforced BEFORE a Director's answer is accepted (both Directors, the initial and the revision one): the three descriptive fields are each one line of plain
// text of 1..DIRECTION_TEXT_MAX_CHARS characters, exactly what the canonical Creative Direction contract demands later. An answer that breaks it is REFUSED with a precise code
// (`VISUAL_INTENT_TOO_LONG`...) and its measurements are recorded in the ledger; it is never truncated, trimmed or summarized, because shortening a creative idea changes it, and there is no approved
// canonical summarization step. The structured-output mode of the text lane cannot be relied on to enforce a length (only JSON validity is documented), so the contract is stated in the instruction
// and verified here.

export const DIRECTION_TEXT_FIELDS = Object.freeze(['concept', 'copy_intent', 'visual_intent']);
export { DIRECTION_TEXT_MAX_CHARS };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** The sentence of the Director instruction that states the contract (generic: no subject, no brand). */
export const DIRECTION_TEXT_RULE = `concept, copy_intent and visual_intent are each ONE line of plain text of at most ${DIRECTION_TEXT_MAX_CHARS} characters, without line breaks: a longer value is refused, so write the whole idea within ${DIRECTION_TEXT_MAX_CHARS} characters.`;

/** @returns {{ field, problem, length, limit }[]} every violation of the text contract in a raw answer (empty when it complies). Pure. */
export function directionTextProblems(raw) {
  const problems = [];
  for (const field of DIRECTION_TEXT_FIELDS) {
    const value = raw?.[field];
    if (typeof value !== 'string') { problems.push({ field, problem: 'MISSING', length: null, limit: DIRECTION_TEXT_MAX_CHARS }); continue; }
    const normalized = value.normalize('NFC');
    const length = normalized.length;
    if (!normalized.trim()) problems.push({ field, problem: 'EMPTY', length, limit: DIRECTION_TEXT_MAX_CHARS });
    else if (length > DIRECTION_TEXT_MAX_CHARS) problems.push({ field, problem: 'TOO_LONG', length, limit: DIRECTION_TEXT_MAX_CHARS });
    else if (CONTROL.test(normalized) || normalized.includes('\n')) problems.push({ field, problem: 'NOT_SINGLE_LINE', length, limit: DIRECTION_TEXT_MAX_CHARS });
  }
  return problems;
}

/**
 * Refuses a raw Director answer that breaks the text contract: the violations (field, problem, measured length, limit; never the text) go to the ledger, then an error with the code of the first one
 * (for example `VISUAL_INTENT_TOO_LONG`) is thrown. Nothing is shortened.
 */
export function assertDirectionTextContract({ raw, ledger, component }) {
  const problems = directionTextProblems(raw);
  if (!problems.length) return;
  ledger.record({
    decision: DECISION.DIRECTION_REFUSED, decided_by: component ?? COMPONENT.CREATIVE_DIRECTOR, rule: 'DIRECTION_TEXT_CONTRACT',
    basis: [], outcome: { refused: problems.map((p) => ({ field: p.field, problem: p.problem, length: p.length, limit: p.limit })) },
  });
  const first = problems[0];
  throw Object.assign(new Error(`direction.${first.field} breaks the text contract`), { code: `${first.field.toUpperCase()}_${first.problem}` });
}
