import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditContractParity } from '../creative-brain/parity.js';
import { checkReadiness as checkBrainReadiness, codeHash, readAttestation } from '../creative-brain-benchmark/readiness.js';
import { auditCampaignParity } from '../creative-campaign/parity.js';
import { auditPlanningParity } from '../creative-planning/parity.js';
import { auditProductionParity } from '../creative-production/parity.js';

// THE CREATIVE READINESS GATE. A live Creative run is refused unless ONE explicit, offline verdict says CREATIVE_PIPELINE_READY. The pipeline is not the Creative Brain alone: it is the content planning in front of
// it, the Brain, the campaign planning on top of it, and the layered production that specifies what would be sent to a provider. For the exact code hash the verdict needs
//   1. contract / prompt parity of every stage that asks a model, and the mechanical probes of the production rules, in each component (computed here, now, from the real instructions, validators and builders);
//   2. the Creative Brain's own gate (its attestation and its parity), which stays as it was;
//   3. an attestation recorded for exactly this code that names the components it covers: the full suite, the mutation sweep of EACH component, the Node 20 and Node 24 clean clones and CI.
// The attestation is evidence recorded after those runs; the gate verifies that it belongs to the code it looks at and that it covers every active component. A component that is added to the pipeline joins
// ACTIVE_COMPONENTS and the gate refuses until the attestation covers it, so a new stage cannot become a blind spot.

export const CREATIVE_READY = 'CREATIVE_PIPELINE_READY';
export const NOT_READY = 'NOT_READY';
export const COMPONENT = Object.freeze({
  PLANNING: 'PLANNING', BRAIN: 'BRAIN', CAMPAIGN: 'CAMPAIGN', PRODUCTION: 'PRODUCTION',
});
export const ACTIVE_COMPONENTS = Object.freeze([COMPONENT.PLANNING, COMPONENT.BRAIN, COMPONENT.CAMPAIGN, COMPONENT.PRODUCTION]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CREATIVE_ATTESTATION_PATH = path.join(ROOT, 'docs', 'architecture', 'creative-readiness.json');

const green = (r) => r && Number.isInteger(r.tests) && r.tests > 0 && r.fail === 0 && r.pass > 0;
const completeSweep = (m) => Boolean(m) && m.total > 0 && m.killed + (m.survivors_documented ?? 0) === m.total;

/**
 * The explicit verdict. Pure given its inputs (the tests drive it with synthetic ones).
 * @param {object} input { parities: { PLANNING, BRAIN, CAMPAIGN }, brainGate, attestation, hash, active? }
 */
export function evaluateCreativeReadiness({
  parities, brainGate, attestation, hash, active = ACTIVE_COMPONENTS,
}) {
  const reasons = [];
  for (const c of active) {
    const p = parities?.[c];
    if (!p?.ready) reasons.push(`${c}_PARITY_FAILS: ${(p?.failures ?? ['no audit']).slice(0, 5).join(' | ')}`);
  }
  if (!brainGate?.ready) reasons.push(`BRAIN_GATE_NOT_READY: ${(brainGate?.reasons ?? ['no verdict']).slice(0, 4).join(' | ')}`);
  if (!attestation) reasons.push('NO_ATTESTATION: the full suite, the mutation sweeps, the clean clones and CI have not been recorded for the whole pipeline');
  else {
    if (attestation.code_hash !== hash) reasons.push('ATTESTATION_IS_FOR_OTHER_CODE: the code changed since it was verified; verify again');
    for (const c of active) if (!Array.isArray(attestation.components) || !attestation.components.includes(c)) reasons.push(`ATTESTATION_DOES_NOT_COVER:${c}`);
    if (!green(attestation.full_suite)) reasons.push('FULL_SUITE_NOT_GREEN');
    for (const c of active) if (!completeSweep(attestation.mutation?.[c])) reasons.push(`MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:${c}`);
    if (!green(attestation.clean_clones?.node20)) reasons.push('NODE_20_CLEAN_CLONE_NOT_GREEN');
    if (!green(attestation.clean_clones?.node24)) reasons.push('NODE_24_CLEAN_CLONE_NOT_GREEN');
    if (attestation.ci?.status !== 'success') reasons.push('CI_NOT_SUCCESS_YET');
  }
  return {
    status: reasons.length ? NOT_READY : CREATIVE_READY,
    ready: reasons.length === 0,
    reasons,
    components: Object.fromEntries(active.map((c) => [c, { parity_ready: Boolean(parities?.[c]?.ready), attested: Boolean(attestation?.components?.includes?.(c)), mutation_complete: completeSweep(attestation?.mutation?.[c]) }])),
  };
}

/** The live gate, with the three real parity audits, the Brain's own gate, the real code hash and the recorded attestation. */
export function checkCreativeReadiness({ attestationFile = CREATIVE_ATTESTATION_PATH, root = ROOT, brainAttestationFile } = {}) {
  const brain = auditContractParity(); const planning = auditPlanningParity(); const campaign = auditCampaignParity(); const production = auditProductionParity();
  const brainGate = checkBrainReadiness({ root, ...(brainAttestationFile ? { attestationFile: brainAttestationFile } : {}) });
  const verdict = evaluateCreativeReadiness({
    parities: {
      [COMPONENT.BRAIN]: brain, [COMPONENT.PLANNING]: planning, [COMPONENT.CAMPAIGN]: campaign, [COMPONENT.PRODUCTION]: production,
    },
    brainGate, attestation: readAttestation(attestationFile), hash: codeHash(root),
  });
  return {
    ...verdict,
    parity: Object.fromEntries([[COMPONENT.PLANNING, planning], [COMPONENT.BRAIN, brain], [COMPONENT.CAMPAIGN, campaign], [COMPONENT.PRODUCTION, production]].map(([c, p]) => [c, { ready: p.ready, stages: p.stages.length, rows: p.rows.length, failures: p.failures.length }])),
    brain_gate: { status: brainGate.status, ready: brainGate.ready },
  };
}

export { codeHash };
