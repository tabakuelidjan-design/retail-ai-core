// China Sourcing is a Node 24 product: older runtimes fail early with a clear message instead of hanging in a test or a browser helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSourcingRuntime, REQUIRED_NODE_MAJOR, SourcingRuntimeError } from '../src/sourcing/runtime.js';

test('Node 24 and later are accepted; Node 20, 22 and garbage are refused with a clear, coded error', () => {
  assert.equal(REQUIRED_NODE_MAJOR, 24);
  assert.equal(assertSourcingRuntime('24.0.0'), 24); assert.equal(assertSourcingRuntime('24.19.0'), 24); assert.equal(assertSourcingRuntime('25.1.0'), 25);
  for (const v of ['20.20.2', '22.11.0', '23.9.0', '', 'x', 'v-nope']) assert.throws(() => assertSourcingRuntime(v), (e) => e instanceof SourcingRuntimeError && e.code === 'SOURCING_NODE_UNSUPPORTED' && /requires Node 24/.test(e.message));
});

test('the machine running the tests satisfies the requirement, and the server start checks it', async () => {
  assert.ok(assertSourcingRuntime() >= 24);
  const { readFile } = await import('node:fs/promises'); const src = await readFile(new URL('../src/sourcing/server/index.js', import.meta.url), 'utf8');
  assert.match(src, /assertSourcingRuntime\(\);/);
});
