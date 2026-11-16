// WHY A RUN ENDED WITHOUT A RESULT (2026-11-15). Three different ends must stay distinguishable, in the interface, in the command and in the memory:
//   1. NONE: Creator answered "no convincing idea" and gave its reason (the trace step AD_SINGLE ends with the outcome NONE and carries none_reason). Code AD_NO_CONVINCING_IDEA, the reason is Creator's own words, nothing is generated after it.
//   2. A STAGE ERROR or REFUSAL: a step journaled ERROR or REJECTED (a refused direction, a render that gave no variant...). The code and the short message of that step.
//   3. PROPOSALS WITHHELD: Creator DID produce proposals and every one was withheld by the technical checks. Code NO_RESULT_PASSED_CHECKS, with how many and why.
// Before this file the first case was lost (run cr-08a0933b0836 showed "every proposal was withheld by the technical checks" for a NONE that was no proposal at all).
export const NONE_CODE = 'AD_NO_CONVINCING_IDEA';
export const NONE_REASON_MAX = 400;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** @returns {{code:string, message:string, kind:'NONE'|'STAGE_ERROR'|'WITHHELD', step?:string}|null} null when the run has a result or nothing explains it */
export function deriveStopReason({ r, shown = [], readJournaledError = () => null }) {
  if (shown.length) return null;
  const trace = r?.trace ?? [];
  const none = [...trace].reverse().find((x) => x.outcome === 'NONE' && x.detail?.none_reason);
  if (none) return { code: NONE_CODE, kind: 'NONE', step: none.step, message: clip(none.detail.none_reason, NONE_REASON_MAX) };
  const bad = [...trace].reverse().find((x) => /ERROR|REJECTED/.test(String(x.outcome)));
  if (bad) return { code: String(bad.detail?.code ?? bad.outcome).slice(0, 60), kind: 'STAGE_ERROR', step: bad.step, message: `${bad.step}: ${String(bad.detail?.message ?? '')}${bad.detail?.field ? ` (${bad.detail.field})` : ''}`.slice(0, 300) };
  const journaled = readJournaledError(); if (journaled?.code || journaled?.message) return { code: String(journaled.code ?? '').slice(0, 60), kind: 'STAGE_ERROR', message: String(journaled.message ?? '').slice(0, 300) };
  const proposals = r?.proposals ?? [];
  if (proposals.length) return { code: 'NO_RESULT_PASSED_CHECKS', kind: 'WITHHELD', message: `${proposals.length} proposition(s) émise(s) par Creator, toutes écartées par les contrôles techniques : ${proposals.map((p) => `${p.technical_quality?.state ?? 'NON_CONTRÔLÉE'}${(p.technical_quality?.defects ?? []).length ? ` (${p.technical_quality.defects.slice(0, 3).join(', ')})` : ''}`).join(' ; ')}`.slice(0, 300) };
  return null;
}
