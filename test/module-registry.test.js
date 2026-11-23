// The module registry: one entry per module, well formed, and in agreement with the gateway's module table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_REGISTRY, validateRegistry } from '../src/shared/module-registry.js';
import { MODULES } from '../src/shared/nordla-gateway.js';

test('the registry is well formed (unique keys and prefixes, paths under the Nordla address)', () => {
  assert.deepEqual(validateRegistry(), []);
});

test('every registry module matches the gateway module table (same key, same prefix), and no gateway module is missing', () => {
  for (const m of MODULE_REGISTRY) {
    assert.ok(MODULES[m.key], `gateway knows ${m.key}`);
    assert.equal(MODULES[m.key].prefix, m.prefix, `same prefix for ${m.key}`);
  }
  assert.deepEqual(MODULE_REGISTRY.map((m) => m.key).sort(), Object.keys(MODULES).sort());
});

test('a malformed entry is refused by the validator (a broken module never reaches the menu)', () => {
  const bad = [
    { key: 'a', prefix: '/a', title: 'A', embed: null, tabs: [] },
    { key: 'a', prefix: '/b', title: 'B', embed: null, tabs: [] },
    { key: 'Bad Key', prefix: 'nope', title: '', embed: '/x.js', tabs: ['x', 'x'] },
  ];
  const problems = validateRegistry(bad);
  assert.ok(problems.some((p) => p.includes('duplicate key a')));
  assert.ok(problems.some((p) => p.includes('prefix nope')));
  assert.ok(problems.some((p) => p.includes('title')));
  assert.ok(problems.some((p) => p.includes('duplicate tab')));
});

test('step 2: the gateway prefixes come from the registry; the cookie policy is per key; Finance keeps its cookies', async () => {
  const { MODULES: M } = await import('../src/shared/nordla-gateway.js');
  for (const m of MODULE_REGISTRY) assert.equal(M[m.key].prefix, m.prefix);
  assert.ok(M.finance.cookies instanceof RegExp, 'Finance keeps its cookie policy');
  assert.equal(M.analytics.cookies, null);
});
