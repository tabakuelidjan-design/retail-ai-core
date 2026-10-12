import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  auditProductionParity, PRODUCTION_RULES, PRODUCTION_STAGES, renderProductionContractMatrix,
} from '../src/creative-production/index.js';

// PARITY OF THE PRODUCTION STAGES (`// PQ-N`): every rule of the specification is proved by a probe that breaks it and checks that the validator names it.

test('PQ-1 every production rule has a probe that holds, and the audit is ready', () => {
  const audit = auditProductionParity();
  assert.deepEqual(audit.failures, []); assert.ok(audit.ready);
  const probed = new Set(audit.rows.filter((r) => r.kind === 'PROBE').map((r) => r.path));
  for (const rule of PRODUCTION_RULES) assert.ok(probed.has(rule), `${rule} has a probe`);
  assert.ok(audit.rows.filter((r) => r.kind === 'PROBE').every((r) => r.stated === true));
  assert.deepEqual(audit.stages.map((s) => s.stage), PRODUCTION_STAGES.map((s) => s.stage));
  assert.ok(audit.stages.every((s) => s.model === false && s.derivation));
  for (const rule of ['SAMPLE_IS_VALID', 'SUBSTITUTE_LEXICON', 'SUBSTITUTE_RELATIVE_TO_THE_PRODUCT', 'SUBSTITUTE_DOES_NOT_OVERBLOCK', 'PRODUCT_IDENTITY_IS_EXPLICIT', 'NO_REPLACEMENT_FOR_A_MISSING_PRODUCT', 'LOCKED_COPY_IS_RECOVERABLE', 'LOCKED_COPY_TAMPERING_IS_SEEN', 'THE_BUDGET_IS_A_HARD_CEILING', 'RESERVE_BEFORE_THE_COST', 'THE_TOOL_IS_CHOSEN_IN_THE_PLAN', 'NO_TOOL_IS_AN_EXPLICIT_STATE', 'THE_PROVIDER_GATE_FAILS_CLOSED']) assert.ok(probed.has(rule), rule);
  assert.equal(PRODUCTION_RULES.length, 11);
});

test('PQ-2 the committed production matrix is the one the code produces', () => {
  const committed = readFileSync(new URL('../docs/architecture/creative-production-contract-matrix.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, renderProductionContractMatrix()); assert.ok(!/\b[0-9a-f]{64}\b/.test(committed));
  assert.ok(committed.includes('PARITY: every production rule is enforced'));
});
