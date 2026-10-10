import { createHash } from 'node:crypto';

import { finalizeVerdict } from './critique.js';
import { buildRevisionRequest } from './revision.js';

// The bounded autonomous revision loop: candidate -> critique -> semantic revision request -> a NEW candidate produced by the Creative Director and the production runtime ->
// critique again. The loop decides nothing creative: it asks the critic for words, turns them into semantic intents, and hands those to the producer. It is bounded by construction
// (at most MAX_CANDIDATES candidates, the cap cannot be raised by a caller), every iteration is recorded, deterministic gates keep the last word on eligibility, a revision cycle
// needs an explicit human authorization, and it can never produce an approval: the owner's decision is outside Nordla.

export const MAX_CANDIDATES = 3; // Candidate 1 -> Critique 1 -> Candidate 2 -> Critique 2 -> Candidate 3 (and its critique), never more

export const LOOP_STOP = Object.freeze({
  CREATIVE_PASS: 'CREATIVE_PASS_AWAITING_OWNER',
  NO_REVISION_ASKED: 'NO_REVISION_ASKED',
  REVISION_NOT_AUTHORIZED: 'REVISION_NOT_AUTHORIZED',
  MAX_CANDIDATES_REACHED: 'MAX_CANDIDATES_REACHED',
  PRODUCTION_FAILED: 'PRODUCTION_FAILED',
  NOT_MEASURABLE: 'CRITIC_COULD_NOT_JUDGE',
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gateOutcome = (value) => (value === 'PASS' || value === 'FAIL' || value === 'REVIEW_REQUIRED' || value === 'NOT_MEASURABLE' ? value : null);

/**
 * @param {object} input
 *  critic             createCreativeCritic(...)
 *  brief              the critic's brief (public facts, brand principles, deterministic facts verified elsewhere)
 *  initial            the existing candidate: { ref, png_bytes, deterministic: { preflight, fidelity, guardian }, provenance? }
 *  produce            async ({ revision_request, iteration, previous }) -> the same shape as `initial`, or { failed: { code } }. Called only for iterations 2..max.
 *  authorizeRevision  async ({ iteration, revision_request, critique }) -> true only with an explicit human confirmation; absent or false => the loop stops after the critique
 *  maxCandidates      1..MAX_CANDIDATES
 */
export async function runCreativeLoop({
  critic, brief, initial, produce = null, authorizeRevision = null, maxCandidates = MAX_CANDIDATES,
}) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_CANDIDATES) throw new RangeError(`maxCandidates must be between 1 and ${MAX_CANDIDATES}`);
  if (!initial?.png_bytes?.length || typeof initial.ref !== 'string') throw new TypeError('an initial candidate (ref + png_bytes) is required');
  const iterations = [];
  let candidate = initial;
  let stop = null;
  for (let n = 1; n <= maxCandidates; n += 1) {
    const { critique, provenance } = await critic.critique({ candidate: { ref: candidate.ref, png_bytes: candidate.png_bytes }, brief });
    const deterministic = {
      preflight: gateOutcome(candidate.deterministic?.preflight), fidelity: gateOutcome(candidate.deterministic?.fidelity), guardian: gateOutcome(candidate.deterministic?.guardian),
    };
    const verdict = finalizeVerdict({ critique, deterministic });
    const revision = n < maxCandidates ? buildRevisionRequest({ critique, iteration: n }) : null;
    iterations.push(Object.freeze({
      iteration: n, candidate_ref: candidate.ref, candidate_sha256: sha256(candidate.png_bytes), candidate_provenance: candidate.provenance ?? null, deterministic, critique, critic_provenance: provenance, verdict, revision_request: revision,
    }));
    if (verdict.creative_status === 'CREATIVE_PASS') { stop = LOOP_STOP.CREATIVE_PASS; break; }
    if (verdict.creative_status === 'NOT_MEASURABLE') { stop = LOOP_STOP.NOT_MEASURABLE; break; }
    if (n === maxCandidates) { stop = LOOP_STOP.MAX_CANDIDATES_REACHED; break; }
    if (!revision) { stop = LOOP_STOP.NO_REVISION_ASKED; break; }
    // a revision cycle is a billable creative production: it needs an explicit, per-cycle human confirmation
    const allowed = typeof authorizeRevision === 'function' && typeof produce === 'function' && (await authorizeRevision({ iteration: n, revision_request: revision, critique })) === true;
    if (!allowed) { stop = LOOP_STOP.REVISION_NOT_AUTHORIZED; break; }
    const next = await produce({ revision_request: revision, iteration: n + 1, previous: candidate });
    if (!next || next.failed || !next.png_bytes?.length) { stop = LOOP_STOP.PRODUCTION_FAILED; iterations.push(Object.freeze({ iteration: n + 1, production_failure: next?.failed ?? { code: 'NO_CANDIDATE' } })); break; }
    candidate = next;
  }
  const last = [...iterations].reverse().find((i) => i.verdict);
  return Object.freeze({
    iterations: Object.freeze(iterations),
    candidates_produced: iterations.filter((i) => i.verdict).length,
    stop_reason: stop,
    latest_creative_status: last?.verdict.creative_status ?? 'NOT_MEASURABLE',
    // Nordla never approves: only the owner can set OWNER_APPROVED / SHIPPABLE, outside this system
    production_status: last?.verdict.production_status ?? 'BLOCKED_BY_A_DETERMINISTIC_GATE',
    owner_approval: 'PENDING',
  });
}
