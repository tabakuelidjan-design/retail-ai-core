import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  auditRefineParity, REFINE_RULES, REFINE_STAGES, refineSample, renderRefineContractMatrix,
} from '../src/creative-refine/parity.js';
import { buildLayerDependencyMap } from '../src/creative-refine/index.js';

// PARITY OF THE REFINE (`// RP-N`): every rule of the repair planner is proved by a probe that breaks it and checks that the planner refuses it with the code of that rule.

test('RP-1 every refine rule has a probe that holds, and the audit is ready', () => {
  const audit = auditRefineParity();
  assert.deepEqual(audit.failures, []); assert.ok(audit.ready);
  const probed = new Set(audit.rows.filter((r) => r.kind === 'PROBE').map((r) => r.path));
  for (const rule of REFINE_RULES) assert.ok(probed.has(rule), `${rule} has a probe`);
  assert.ok(audit.rows.every((r) => r.stated === true));
  assert.deepEqual(audit.stages.map((s) => s.stage), REFINE_STAGES.map((s) => s.stage));
  assert.ok(audit.stages.every((s) => s.model === false && s.derivation));
  for (const rule of ['SAMPLE_IS_REPAIRABLE', 'THE_REAL_PRODUCT_IS_NEVER_REPAIRED', 'LOCKED_COPY_IS_NEVER_CHANGED', 'NO_SCOPE_REGENERATES_THE_CREATIVE', 'UPSTREAM_AND_PROTECTED_NODES_ARE_NEVER_INVALIDATED', 'AN_UPSTREAM_DEFECT_IS_A_REPLAN', 'THE_SCOPE_IS_DECLARED', 'THE_OWNER_OF_A_DEFECT_IS_NEVER_GUESSED', 'A_REPAIR_ESCALATES_INSTEAD_OF_LOOPING', 'A_FAILED_REPAIR_IS_NOT_REPEATED', 'THE_REPAIR_IS_COSTED_ON_THE_REPAIRED_WORK_ONLY', 'A_STALE_OR_INVALID_ARTIFACT_IS_REFUSED', 'A_MASKED_EDIT_IS_NEVER_FAKED', 'A_MASK_NEVER_TOUCHES_A_PROTECTED_REGION']) assert.ok(REFINE_RULES.includes(rule), rule);
  assert.equal(REFINE_RULES.length, 14);
});

test('RP-2 the committed refine matrix is the one the code produces, and the probe sample is a valid artifact', () => {
  const committed = readFileSync(new URL('../docs/architecture/creative-refine-contract-matrix.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, renderRefineContractMatrix()); assert.ok(!/\b[0-9a-f]{64}\b/.test(committed));
  assert.ok(committed.includes('PARITY: every refine rule is enforced'));
  assert.ok(buildLayerDependencyMap(refineSample()));
  assert.equal(buildLayerDependencyMap({ ...refineSample(), schema: 'other' }), null);
});
