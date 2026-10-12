import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ACTIVE_COMPONENTS, checkCreativeReadiness, COMPONENT, CREATIVE_READY, evaluateCreativeReadiness, NOT_READY,
} from '../src/creative-readiness/index.js';
import { auditContractParity } from '../src/creative-brain/parity.js';
import { auditPlanningParity } from '../src/creative-planning/parity.js';
import { auditCampaignParity } from '../src/creative-campaign/parity.js';

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
const parities = { PLANNING: auditPlanningParity(), BRAIN: auditContractParity(), CAMPAIGN: auditCampaignParity() };
const gate = { ready: true, status: 'CREATIVE_BRAIN_CONTRACT_PARITY_READY', reasons: [] };
const verdict = (over = {}) => evaluateCreativeReadiness({
  parities, brainGate: gate, attestation: good('h'), hash: 'h', ...over,
});

test('CR-1 the pipeline is READY only when every component parity, the Brain gate and the whole attestation hold for this exact code', () => {
  assert.ok(Object.values(parities).every((p) => p.ready), 'the three real audits pass');
  const ok = verdict();
  assert.deepEqual({ status: ok.status, ready: ok.ready, reasons: ok.reasons }, { status: CREATIVE_READY, ready: true, reasons: [] });
  assert.equal(CREATIVE_READY, 'CREATIVE_PIPELINE_READY'); assert.deepEqual(ACTIVE_COMPONENTS, ['PLANNING', 'BRAIN', 'CAMPAIGN']);
  assert.deepEqual(Object.keys(ok.components), ['PLANNING', 'BRAIN', 'CAMPAIGN']); assert.ok(Object.values(ok.components).every((c) => c.parity_ready && c.attested && c.mutation_complete));
});

test('CR-2 every missing or failing piece of evidence names itself, component by component, and refuses', () => {
  const broken = { ready: false, failures: ['STAGE: a rule is missing'] };
  const mutation = (c, m) => ({ ...good('h').mutation, [c]: m });
  const cases = [
    ['planning parity', { parities: { ...parities, PLANNING: broken } }, /PLANNING_PARITY_FAILS: STAGE/],
    ['brain parity', { parities: { ...parities, BRAIN: broken } }, /BRAIN_PARITY_FAILS: STAGE/],
    ['campaign parity', { parities: { ...parities, CAMPAIGN: broken } }, /CAMPAIGN_PARITY_FAILS: STAGE/],
    ['campaign audit missing', { parities: { PLANNING: parities.PLANNING, BRAIN: parities.BRAIN } }, /CAMPAIGN_PARITY_FAILS: no audit/],
    ['brain gate', { brainGate: { ready: false, reasons: ['ATTESTATION_IS_FOR_OTHER_CODE'] } }, /BRAIN_GATE_NOT_READY: ATTESTATION_IS_FOR_OTHER_CODE/],
    ['no attestation', { attestation: null }, /NO_ATTESTATION/],
    ['other code', { attestation: good('other') }, /ATTESTATION_IS_FOR_OTHER_CODE/],
    ['planning not covered', { attestation: { ...good('h'), components: ['BRAIN', 'CAMPAIGN'] } }, /ATTESTATION_DOES_NOT_COVER:PLANNING/],
    ['campaign not covered', { attestation: { ...good('h'), components: ['PLANNING', 'BRAIN'] } }, /ATTESTATION_DOES_NOT_COVER:CAMPAIGN/],
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

test('CR-3 a component added to the pipeline cannot be a blind spot: the gate refuses until its parity and its attestation exist', () => {
  const v = verdict({ active: [...ACTIVE_COMPONENTS, 'LAYERED_SCENE'] });
  assert.equal(v.ready, false);
  assert.ok(v.reasons.some((r) => /LAYERED_SCENE_PARITY_FAILS: no audit/.test(r)));
  assert.ok(v.reasons.some((r) => /ATTESTATION_DOES_NOT_COVER:LAYERED_SCENE/.test(r)));
  assert.ok(v.reasons.some((r) => /MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED:LAYERED_SCENE/.test(r)));
});

test('CR-4 the real gate audits all three components and keeps the Brain gate', () => {
  const real = checkCreativeReadiness({ attestationFile: new URL('./does-not-exist.json', import.meta.url).pathname });
  assert.deepEqual(Object.keys(real.parity), ['PLANNING', 'BRAIN', 'CAMPAIGN']);
  assert.ok(Object.values(real.parity).every((p) => p.ready && p.failures === 0 && p.rows > 0));
  assert.equal(real.ready, false); assert.ok(real.reasons.some((r) => /NO_ATTESTATION/.test(r)));
  assert.ok('brain_gate' in real && typeof real.brain_gate.ready === 'boolean', 'the Brain gate is still evaluated');
  assert.deepEqual(Object.keys(COMPONENT).sort(), ['BRAIN', 'CAMPAIGN', 'PLANNING']);
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
