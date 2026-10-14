import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ACTIVE_COMPONENTS, checkCreativeReadiness, COMPONENT, CREATIVE_READY, evaluateCreativeReadiness, NOT_READY,
} from '../src/creative-readiness/index.js';
import { auditContractParity } from '../src/creative-brain/parity.js';
import { auditPlanningParity } from '../src/creative-planning/parity.js';
import { auditCampaignParity } from '../src/creative-campaign/parity.js';
import { auditLayeredRuntimeParity, auditProductionParity } from '../src/creative-production/parity.js';
import { auditRefineParity } from '../src/creative-refine/parity.js';
import { auditIntegrationParity } from '../src/creative-integration/parity.js';
import { auditEndToEndParity } from '../src/creative-e2e/parity.js';
import { productionReadinessLevel } from '../src/creative-production/index.js';
import { describeLayeredRuntime } from '../src/creative-runtime/index.js';

// THE CREATIVE READINESS GATE (`// CR-N` markers): one verdict for the whole pipeline (planning, Brain, campaign), for the exact code hash. Offline, fakes only.

const sweep = { total: 10, killed: 9, survivors_documented: 1 };
const good = (hash) => ({
  code_hash: hash,
  components: [...ACTIVE_COMPONENTS],
  full_suite: { tests: 100, pass: 100, fail: 0 },
  mutation: Object.fromEntries(ACTIVE_COMPONENTS.map((c) => [c, sweep])),
  clean_clones: { node20: { tests: 100, pass: 100, fail: 0 }, node24: { tests: 100, pass: 100, fail: 0 } },
  ci: { status: 'success' },
});
const parities = {
  PLANNING: auditPlanningParity(), BRAIN: auditContractParity(), CAMPAIGN: auditCampaignParity(), PRODUCTION: auditProductionParity(), LAYERED_RUNTIME: auditLayeredRuntimeParity(), REFINE: auditRefineParity(), INTEGRATION: auditIntegrationParity(), END_TO_END: auditEndToEndParity(),
};
const levels = productionReadinessLevel({ parityOk: true });
const gate = { ready: true, status: 'CREATIVE_BRAIN_CONTRACT_PARITY_READY', reasons: [] };
const verdict = (over = {}) => evaluateCreativeReadiness({
  parities, brainGate: gate, attestation: good('h'), hash: 'h', levels, ...over,
});

test('CR-1 the pipeline is READY only when every component parity, the Brain gate and the whole attestation hold for this exact code', () => {
  assert.ok(Object.values(parities).every((p) => p.ready), 'the six real audits pass');
  const ok = verdict();
  assert.deepEqual({ status: ok.status, ready: ok.ready, reasons: ok.reasons }, { status: CREATIVE_READY, ready: true, reasons: [] });
  assert.equal(CREATIVE_READY, 'CREATIVE_PIPELINE_READY'); assert.deepEqual(ACTIVE_COMPONENTS, ['PLANNING', 'BRAIN', 'CAMPAIGN', 'PRODUCTION', 'LAYERED_RUNTIME', 'REFINE', 'INTEGRATION', 'END_TO_END']);
  assert.deepEqual(Object.keys(ok.components), ['PLANNING', 'BRAIN', 'CAMPAIGN', 'PRODUCTION', 'LAYERED_RUNTIME', 'REFINE', 'INTEGRATION', 'END_TO_END']); assert.equal(ok.layered_production.level, 'RUNTIME_EXECUTABLE'); assert.ok(Object.values(ok.components).every((c) => c.parity_ready && c.attested && c.mutation_complete));
});

test('CR-2 every missing or failing piece of evidence names itself, component by component, and refuses', () => {
  const broken = { ready: false, failures: ['STAGE: a rule is missing'] };
  const mutation = (c, m) => ({ ...good('h').mutation, [c]: m });
  const cases = [
    ['planning parity', { parities: { ...parities, PLANNING: broken } }, /PLANNING_PARITY_FAILS: STAGE/],
    ['brain parity', { parities: { ...parities, BRAIN: broken } }, /BRAIN_PARITY_FAILS: STAGE/],
    ['campaign parity', { parities: { ...parities, CAMPAIGN: broken } }, /CAMPAIGN_PARITY_FAILS: STAGE/],
    ['production parity', { parities: { ...parities, PRODUCTION: broken } }, /PRODUCTION_PARITY_FAILS: STAGE/],
    ['layered runtime parity', { parities: { ...parities, LAYERED_RUNTIME: broken } }, /LAYERED_RUNTIME_PARITY_FAILS: STAGE/],
    ['refine parity', { parities: { ...parities, REFINE: broken } }, /REFINE_PARITY_FAILS: STAGE/],
    ['refine audit missing', { parities: { PLANNING: parities.PLANNING, BRAIN: parities.BRAIN, CAMPAIGN: parities.CAMPAIGN, PRODUCTION: parities.PRODUCTION, LAYERED_RUNTIME: parities.LAYERED_RUNTIME } }, /REFINE_PARITY_FAILS: no audit/],
    ['integration parity', { parities: { ...parities, INTEGRATION: broken } }, /INTEGRATION_PARITY_FAILS: STAGE/],
    ['end to end parity', { parities: { ...parities, END_TO_END: broken } }, /END_TO_END_PARITY_FAILS: STAGE/],
    ['end to end not covered', { attestation: { ...good('h'), components: ['PLANNING', 'BRAIN', 'CAMPAIGN', 'PRODUCTION', 'LAYERED_RUNTIME', 'REFINE', 'INTEGRATION'] } }, /ATTESTATION_DOES_NOT_COVER:END_TO_END/],
    ['end to end sweep absent', { attestation: { ...good('h'), mutation: mutation('END_TO_END', undefined) } }, /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:END_TO_END/],
    ['integration not covered', { attestation: { ...good('h'), components: ['PLANNING', 'BRAIN', 'CAMPAIGN', 'PRODUCTION', 'LAYERED_RUNTIME', 'REFINE'] } }, /ATTESTATION_DOES_NOT_COVER:INTEGRATION/],
    ['integration sweep absent', { attestation: { ...good('h'), mutation: mutation('INTEGRATION', undefined) } }, /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:INTEGRATION/],
    ['refine not covered', { attestation: { ...good('h'), components: ['PLANNING', 'BRAIN', 'CAMPAIGN', 'PRODUCTION', 'LAYERED_RUNTIME'] } }, /ATTESTATION_DOES_NOT_COVER:REFINE/],
    ['refine sweep absent', { attestation: { ...good('h'), mutation: mutation('REFINE', undefined) } }, /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:REFINE/],
    ['layered runtime audit missing', { parities: { PLANNING: parities.PLANNING, BRAIN: parities.BRAIN, CAMPAIGN: parities.CAMPAIGN, PRODUCTION: parities.PRODUCTION, REFINE: parities.REFINE } }, /LAYERED_RUNTIME_PARITY_FAILS: no audit/],
    ['layered runtime not covered', { attestation: { ...good('h'), components: ['PLANNING', 'BRAIN', 'CAMPAIGN', 'PRODUCTION'] } }, /ATTESTATION_DOES_NOT_COVER:LAYERED_RUNTIME/],
    ['layered runtime sweep absent', { attestation: { ...good('h'), mutation: mutation('LAYERED_RUNTIME', undefined) } }, /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:LAYERED_RUNTIME/],
    ['campaign audit missing', { parities: { PLANNING: parities.PLANNING, BRAIN: parities.BRAIN, PRODUCTION: parities.PRODUCTION, LAYERED_RUNTIME: parities.LAYERED_RUNTIME, REFINE: parities.REFINE } }, /CAMPAIGN_PARITY_FAILS: no audit/],
    ['production audit missing', { parities: { PLANNING: parities.PLANNING, BRAIN: parities.BRAIN, CAMPAIGN: parities.CAMPAIGN, LAYERED_RUNTIME: parities.LAYERED_RUNTIME, REFINE: parities.REFINE } }, /PRODUCTION_PARITY_FAILS: no audit/],
    ['brain gate', { brainGate: { ready: false, reasons: ['ATTESTATION_IS_FOR_OTHER_CODE'] } }, /BRAIN_GATE_NOT_READY: ATTESTATION_IS_FOR_OTHER_CODE/],
    ['no attestation', { attestation: null }, /NO_ATTESTATION/],
    ['other code', { attestation: good('other') }, /ATTESTATION_IS_FOR_OTHER_CODE/],
    ['planning not covered', { attestation: { ...good('h'), components: ['BRAIN', 'CAMPAIGN'] } }, /ATTESTATION_DOES_NOT_COVER:PLANNING/],
    ['campaign not covered', { attestation: { ...good('h'), components: ['PLANNING', 'BRAIN', 'PRODUCTION'] } }, /ATTESTATION_DOES_NOT_COVER:CAMPAIGN/],
    ['production not covered', { attestation: { ...good('h'), components: ['PLANNING', 'BRAIN', 'CAMPAIGN'] } }, /ATTESTATION_DOES_NOT_COVER:PRODUCTION/],
    ['production sweep absent', { attestation: { ...good('h'), mutation: mutation('PRODUCTION', undefined) } }, /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:PRODUCTION/],
    ['no components at all', { attestation: { ...good('h'), components: undefined } }, /ATTESTATION_DOES_NOT_COVER:BRAIN/],
    ['suite red', { attestation: { ...good('h'), full_suite: { tests: 5, pass: 4, fail: 1 } } }, /FULL_SUITE_NOT_GREEN/],
    ['planning sweep incomplete', { attestation: { ...good('h'), mutation: mutation('PLANNING', { total: 10, killed: 8 }) } }, /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:PLANNING/],
    ['campaign sweep absent', { attestation: { ...good('h'), mutation: mutation('CAMPAIGN', undefined) } }, /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:CAMPAIGN/],
    ['brain sweep empty', { attestation: { ...good('h'), mutation: mutation('BRAIN', { total: 0, killed: 0 }) } }, /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:BRAIN/],
    ['node 20 red', { attestation: { ...good('h'), clean_clones: { ...good('h').clean_clones, node20: { tests: 5, pass: 4, fail: 1 } } } }, /NODE_20/],
    ['node 24 absent', { attestation: { ...good('h'), clean_clones: { node20: good('h').clean_clones.node20 } } }, /NODE_24/],
    ['ci pending', { attestation: { ...good('h'), ci: { status: 'pending' } } }, /CI_NOT_SUCCESS/],
  ];
  for (const [name, over, reason] of cases) {
    const v = verdict(over);
    assert.equal(v.status, NOT_READY, name); assert.equal(v.ready, false, name); assert.ok(v.reasons.some((r) => reason.test(r)), `${name}: ${v.reasons}`);
  }
});

test('CR-2b a specified but not executable layered production is not READY: the level of the production is part of the verdict', () => {
  const cases = [
    ['no level at all', null, /level unknown/],
    ['contract only', productionReadinessLevel({ parityOk: true, runtime: { stages: {}, wired: false, entry: null } }), /level CONTRACT_READY/],
    ['implemented, not wired', productionReadinessLevel({ parityOk: true, runtime: { ...describeLayeredRuntime(), wired: false } }), /level IMPLEMENTATION_READY/],
    ['parity failing', productionReadinessLevel({ parityOk: false }), /level NOT_READY/],
  ];
  for (const [name, level, reason] of cases) {
    const v = verdict({ levels: level });
    assert.equal(v.ready, false, name); assert.ok(v.reasons.some((r) => /^LAYERED_PRODUCTION_NOT_RUNTIME_EXECUTABLE/.test(r) && reason.test(r)), `${name}: ${v.reasons}`);
  }
  // a pipeline that does not list the layered runtime does not ask for it
  assert.equal(verdict({ active: ['PLANNING', 'BRAIN', 'CAMPAIGN', 'PRODUCTION'], levels: null }).ready, true);
});

test('CR-3 a component added to the pipeline cannot be a blind spot: the gate refuses until its parity and its attestation exist', () => {
  const v = verdict({ active: [...ACTIVE_COMPONENTS, 'LAYERED_SCENE'] });
  assert.equal(v.ready, false);
  assert.ok(v.reasons.some((r) => /LAYERED_SCENE_PARITY_FAILS: no audit/.test(r)));
  assert.ok(v.reasons.some((r) => /ATTESTATION_DOES_NOT_COVER:LAYERED_SCENE/.test(r)));
  assert.ok(v.reasons.some((r) => /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:LAYERED_SCENE/.test(r)));
});

test('CR-4 the real gate audits every component and keeps the Brain gate', () => {
  const real = checkCreativeReadiness({ attestationFile: new URL('./does-not-exist.json', import.meta.url).pathname });
  assert.deepEqual(Object.keys(real.parity), ['PLANNING', 'BRAIN', 'CAMPAIGN', 'PRODUCTION', 'LAYERED_RUNTIME', 'REFINE', 'INTEGRATION', 'END_TO_END']);
  assert.ok(Object.values(real.parity).every((p) => p.ready && p.failures === 0 && p.rows > 0));
  assert.equal(real.ready, false); assert.ok(real.reasons.some((r) => /NO_ATTESTATION/.test(r)));
  assert.ok('brain_gate' in real && typeof real.brain_gate.ready === 'boolean', 'the Brain gate is still evaluated');
  assert.deepEqual(Object.keys(COMPONENT).sort(), ['BRAIN', 'CAMPAIGN', 'END_TO_END', 'INTEGRATION', 'LAYERED_RUNTIME', 'PLANNING', 'PRODUCTION', 'REFINE']);
  assert.equal(real.layered_production.level, 'RUNTIME_EXECUTABLE'); assert.equal(real.layered_production.runtime_executable, true);
});

test('CR-5 the live benchmark is wired to the combined gate; the Brain gate stays available and unchanged', () => {
  const script = readFileSync(new URL('../scripts/run-creative-brain-benchmark.mjs', import.meta.url), 'utf8');
  assert.ok(script.includes("checkCreativeReadiness } from '../src/creative-readiness/index.js'") && script.includes('readiness: () => checkCreativeReadiness()'));
  const runner = readFileSync(new URL('../src/creative-brain-benchmark/runner.js', import.meta.url), 'utf8');
  assert.ok(runner.includes('CREATIVE_PIPELINE_READY'));
  const brain = readFileSync(new URL('../src/creative-brain-benchmark/readiness.js', import.meta.url), 'utf8');
  assert.ok(brain.includes("export const READY = 'CREATIVE_BRAIN_CONTRACT_PARITY_READY'") && brain.includes('export function checkReadiness'));
});

test('CR-6 the committed attestation, when it exists, names every active component', () => {
  let attestation = null;
  try { attestation = JSON.parse(readFileSync(new URL('../docs/architecture/creative-readiness.json', import.meta.url), 'utf8')); } catch { /* not recorded yet */ }
  if (!attestation) return;
  for (const c of ACTIVE_COMPONENTS) { assert.ok(attestation.components.includes(c), c); assert.ok(attestation.mutation[c].total > 0, c); }
});
