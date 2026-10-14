import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditContractParity } from '../creative-brain/parity.js';
import { checkReadiness as checkBrainReadiness, codeHash, readAttestation } from '../creative-brain-benchmark/readiness.js';
import { auditCampaignParity } from '../creative-campaign/parity.js';
import { auditPlanningParity } from '../creative-planning/parity.js';
import { auditLayeredRuntimeParity, auditProductionParity } from '../creative-production/parity.js';
import { productionReadinessLevel } from '../creative-production/gate.js';
import { auditRefineParity } from '../creative-refine/parity.js';
import { auditIntegrationParity } from '../creative-integration/parity.js';
import { auditEndToEndParity } from '../creative-e2e/parity.js';

// THE CREATIVE READINESS GATE. A live Creative run is refused unless ONE explicit, offline verdict says CREATIVE_PIPELINE_READY. The pipeline is not the Creative Brain alone: it is the content planning in front of
// it, the Brain, the campaign planning on top of it, the layered production that specifies what would be sent to a provider, and the layered RUNTIME that executes a scene through the gates. The layered
// production is READY only at the level RUNTIME_EXECUTABLE (the specification holds, the stages are implemented, and the creative runtime can run a scene end to end through them): a capability that is only specified is not ready. For the exact code hash the verdict needs
//   1. contract / prompt parity of every stage that asks a model, and the mechanical probes of the production rules, in each component (computed here, now, from the real instructions, validators and builders);
//   2. the Creative Brain's own gate (its attestation and its parity), which stays as it was;
//   3. an attestation recorded for exactly this code that names the components it covers: the full suite, the mutation sweep of EACH component, the Node 20 and Node 24 clean clones and CI.
// The attestation is evidence recorded after those runs; the gate verifies that it belongs to the code it looks at and that it covers every active component. A component that is added to the pipeline joins
// ACTIVE_COMPONENTS and the gate refuses until the attestation covers it, so a new stage cannot become a blind spot.

export const CREATIVE_READY = 'CREATIVE_PIPELINE_READY';
export const NOT_READY = 'NOT_READY';
export const COMPONENT = Object.freeze({
  PLANNING: 'PLANNING', BRAIN: 'BRAIN', CAMPAIGN: 'CAMPAIGN', PRODUCTION: 'PRODUCTION', LAYERED_RUNTIME: 'LAYERED_RUNTIME', REFINE: 'REFINE', INTEGRATION: 'INTEGRATION', END_TO_END: 'END_TO_END',
});
export const ACTIVE_COMPONENTS = Object.freeze([COMPONENT.PLANNING, COMPONENT.BRAIN, COMPONENT.CAMPAIGN, COMPONENT.PRODUCTION, COMPONENT.LAYERED_RUNTIME, COMPONENT.REFINE, COMPONENT.INTEGRATION, COMPONENT.END_TO_END]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CREATIVE_ATTESTATION_PATH = path.join(ROOT, 'docs', 'architecture', 'creative-readiness.json');

/** The providers an end-to-end run needs before it can produce a real asset: a layer generator (plates and props) and the Brain's language model. */
export const REQUIRED_PROVIDERS = Object.freeze(['LAYER_GENERATOR', 'BRAIN_MODEL']);
export const HIGH_LEVEL = Object.freeze({ MODULES: 'CREATIVE_MODULES_READY', END_TO_END: 'CREATIVE_END_TO_END_READY', PROVIDER: 'CREATIVE_PROVIDER_READY', LIVE: 'CREATIVE_LIVE_VALIDATED', NONE: 'CREATIVE_NOT_READY' });

/**
 * The four LEVELS, each supported by its own evidence and none implied by another: the modules (each component proven), the end-to-end wiring (the entry point is wired and a provider-free fixture ran end to end),
 * the real providers (a connection RECORDED in the attestation for each required provider), the live validation (a recorded successful live run). `CREATIVE_PIPELINE_READY` means the first two; it never implies the last two.
 */
export function readinessLevels({ modulesReady, fullReady, endToEndParity, attestation }) {
  const e2e = fullReady && endToEndParity === true && attestation?.end_to_end?.provider_free_fixture === 'PASS';
  const providers = Array.isArray(attestation?.providers_connected) && REQUIRED_PROVIDERS.every((p) => attestation.providers_connected.includes(p));
  const live = providers && attestation?.live_validation?.status === 'success';
  const levels = { MODULES_READY: Boolean(modulesReady), END_TO_END_WIRED: Boolean(e2e), REAL_PROVIDER_CONNECTED: Boolean(providers), LIVE_VALIDATED: Boolean(live) };
  let top = HIGH_LEVEL.NONE;
  if (levels.MODULES_READY) top = HIGH_LEVEL.MODULES;
  if (levels.MODULES_READY && levels.END_TO_END_WIRED) top = HIGH_LEVEL.END_TO_END;
  if (levels.MODULES_READY && levels.END_TO_END_WIRED && levels.REAL_PROVIDER_CONNECTED) top = HIGH_LEVEL.PROVIDER;
  if (levels.MODULES_READY && levels.END_TO_END_WIRED && levels.REAL_PROVIDER_CONNECTED && levels.LIVE_VALIDATED) top = HIGH_LEVEL.LIVE;
  return { levels, high_level_status: top };
}

const green = (r) => r && Number.isInteger(r.tests) && r.tests > 0 && r.fail === 0 && r.pass > 0;
const completeSweep = (m) => Boolean(m) && m.total > 0 && m.killed + (m.survivors_documented ?? 0) === m.total;

/**
 * The explicit verdict. Pure given its inputs (the tests drive it with synthetic ones).
 * @param {object} input { parities: { PLANNING, BRAIN, CAMPAIGN, PRODUCTION, LAYERED_RUNTIME }, brainGate, attestation, hash, active?, levels? (the readiness levels of the layered production) }
 */
export function evaluateCreativeReadiness({
  parities, brainGate, attestation, hash, active = ACTIVE_COMPONENTS, levels = null,
}) {
  const reasons = [];
  if (active.includes(COMPONENT.LAYERED_RUNTIME) && levels?.runtime_executable !== true) reasons.push(`LAYERED_PRODUCTION_NOT_RUNTIME_EXECUTABLE: level ${levels?.level ?? 'unknown'}`);
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
    layered_production: levels ?? null,
    components: Object.fromEntries(active.map((c) => [c, { parity_ready: Boolean(parities?.[c]?.ready), attested: Boolean(attestation?.components?.includes?.(c)), mutation_complete: completeSweep(attestation?.mutation?.[c]) }])),
  };
}

/** The live gate, with the three real parity audits, the Brain's own gate, the real code hash and the recorded attestation. */
export function checkCreativeReadiness({ attestationFile = CREATIVE_ATTESTATION_PATH, root = ROOT, brainAttestationFile } = {}) {
  const brain = auditContractParity(); const planning = auditPlanningParity(); const campaign = auditCampaignParity(); const production = auditProductionParity(); const layered = auditLayeredRuntimeParity(); const refine = auditRefineParity(); const integration = auditIntegrationParity(); const endToEnd = auditEndToEndParity();
  const brainGate = checkBrainReadiness({ root, ...(brainAttestationFile ? { attestationFile: brainAttestationFile } : {}) });
  const attestation = readAttestation(attestationFile);
  const parities = {
      [COMPONENT.BRAIN]: brain, [COMPONENT.PLANNING]: planning, [COMPONENT.CAMPAIGN]: campaign, [COMPONENT.PRODUCTION]: production, [COMPONENT.LAYERED_RUNTIME]: layered, [COMPONENT.REFINE]: refine, [COMPONENT.INTEGRATION]: integration, [COMPONENT.END_TO_END]: endToEnd,
  };
  const hash = codeHash(root); const levelsOfProduction = productionReadinessLevel({ parityOk: production.ready && layered.ready });
  const verdict = evaluateCreativeReadiness({ parities, brainGate, attestation, hash, levels: levelsOfProduction });
  const modules = evaluateCreativeReadiness({ parities, brainGate, attestation, hash, levels: levelsOfProduction, active: ACTIVE_COMPONENTS.filter((c) => c !== COMPONENT.END_TO_END) });
  const tiers = readinessLevels({ modulesReady: modules.ready, fullReady: verdict.ready, endToEndParity: endToEnd.ready, attestation });
  return {
    ...verdict,
    ...tiers,
    parity: Object.fromEntries([[COMPONENT.PLANNING, planning], [COMPONENT.BRAIN, brain], [COMPONENT.CAMPAIGN, campaign], [COMPONENT.PRODUCTION, production], [COMPONENT.LAYERED_RUNTIME, layered], [COMPONENT.REFINE, refine], [COMPONENT.INTEGRATION, integration], [COMPONENT.END_TO_END, endToEnd]].map(([c, p]) => [c, { ready: p.ready, stages: p.stages.length, rows: p.rows.length, failures: p.failures.length }])),
    brain_gate: { status: brainGate.status, ready: brainGate.ready },
  };
}

export { codeHash };
