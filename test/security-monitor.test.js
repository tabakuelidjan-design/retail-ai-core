import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecurityMonitor } from '../src/security/monitor.js';

test('security signals are bounded, contain no request data, and never interrupt a refusal', () => {
  let at = 0; const entries = [];
  const report = createSecurityMonitor({ module: 'finance', now: () => at, write: (entry) => entries.push(entry) });
  for (let i = 0; i < 1000; i++) report('ATTACHMENT_TENANT_MISMATCH', { password: 'synthetic-private', path: 'merchant-b/private.pdf' });
  report('UNTRUSTED_SECRET');
  assert.deepEqual(entries, [{ event: 'security_denied', module: 'finance', code: 'ATTACHMENT_TENANT_MISMATCH' }]);
  at = 60000; report('ATTACHMENT_TENANT_MISMATCH');
  assert.equal(entries.length, 2);
  const broken = createSecurityMonitor({ module: 'security', write: () => { throw new Error('log failure'); } });
  assert.doesNotThrow(() => broken('MFA_POLICY_UNAVAILABLE'));
});
