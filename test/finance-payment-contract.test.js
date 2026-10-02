// Fast (no Docker) half of the memory <-> PostgreSQL business contract: the in-memory store must produce EXACTLY the pinned results.
// The same scenarios and the same pinned results are checked against the real PostgreSQL 17 in test/pg/40-contract.pg.test.js, so the two engines cannot drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCENARIOS, memoryWorld } from './finance-contract-scenarios.js';

const EXPECTED = JSON.parse(readFileSync(new URL('./finance-contract-expected.json', import.meta.url), 'utf8'));

test('every scenario has a pinned result and every pinned result has a scenario', () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), Object.keys(EXPECTED).sort());
});

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`CONTRACT (memory store) ${name}`, async () => {
    const w = await memoryWorld();
    assert.deepEqual(JSON.parse(JSON.stringify(await scenario(w))), EXPECTED[name]);
  });
}
