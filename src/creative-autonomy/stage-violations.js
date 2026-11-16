// STAGE: EVERY rule that can refuse an answer before the image stage, checked on the COMPLETE answer, so that ONE authorised repair can name all the violations (attempt 6 would otherwise have
// repaired the first refusal and stopped on the next one). The validators keep their authority (each throws at its first refusal); this module reads the same answer through the same rules and collects.
// Order, as the pipeline applies it: 1 CONTRACT (stage-contract.js STAGE_SPEC, after the same deterministic near-miss normalisation, so a text that Nordla cuts back itself is not reported)
// 2 STAGE_RULES (universal and tenant rules) 3 BRAND guard (invented capabilities). Rules 2 and 3 need a contract-valid answer, so they are collected once rule 1 has nothing left to say.
import { collectSpecViolations, normalizeNearMisses, validateSpec } from '../creative-brain/contract.js';
import { parseJsonObject } from '../creative-brain/model-port.js';
import { BrainError } from '../creative-brain/validation.js';
import { collectStageGuard } from './brand-guard.js';
import { resolveBrandProfile } from './brand-profile.js';
import { resolveHeadline, STAGE_RULES, STAGE_SPEC } from './stage-contract.js';
import { assertHeadlineGuard } from './brand-guard.js';

const WHERE = 'stage';

/** Every violation of a STAGE answer, grouped by field: [{ field, issues: [{ rule, message }] }], in document order. [] when the answer is not readable JSON. */
export function collectStageViolations(answerText, { concept, facts, profile = resolveBrandProfile({}), packshotLitSide = null, art = null } = {}) {
  let answer; try { answer = normalizeNearMisses(STAGE_SPEC, parseJsonObject(answerText, WHERE), [], WHERE); } catch { return []; }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return [];
  // the same headline resolution as normalizeStage: a headline that an alternative replaces is not a violation, and a bad alternative is never reported
  answer = resolveHeadline(answer, { personalisation_offered: Boolean(facts?.personalisation_offered), profile, headlineCheck: (h) => assertHeadlineGuard(h, facts, profile) }).raw;
  let raw = collectSpecViolations(STAGE_SPEC, answer, WHERE);
  if (!raw.length) {
    const v = validateSpec(STAGE_SPEC, answer, WHERE);
    const ctx = { concept, personalisation_offered: Boolean(facts?.personalisation_offered), profile, packshot_lit_side: packshotLitSide };
    for (const rule of STAGE_RULES) {
      try { rule.check?.(v, ctx); } catch (e) { if (!(e instanceof BrainError)) throw e; raw.push({ field: e.field ?? WHERE, code: e.code, message: e.message, detail: { ...(e.detail ?? {}), rule: rule.id } }); }
    }
    raw = [...raw, ...collectStageGuard(v, facts, profile, { art })];
  }
  const byField = new Map();
  for (const v of raw) {
    const issue = { rule: v.detail?.problem ?? v.detail?.rule ?? v.code, message: String(v.message).slice(0, 240), ...(v.detail?.word ? { words: [v.detail.word] } : {}), ...(v.detail?.words ? { words: v.detail.words } : {}), ...(v.detail?.capabilities ? { capabilities: v.detail.capabilities } : {}) };
    if (!byField.has(v.field)) byField.set(v.field, []);
    const issues = byField.get(v.field);
    if (!issues.some((x) => x.rule === issue.rule && x.message === issue.message)) issues.push(issue);
  }
  return [...byField].map(([field, issues]) => ({ field, issues }));
}
