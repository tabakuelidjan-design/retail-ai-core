import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrowthGate } from '../src/growth/server/hosted-main.js';
import { createHostedGrowth } from '../src/growth/server/hosted.js';
import { createMfaRule } from '../src/settings-security/mfa-rule.js';

test('Growth checks MFA on an existing session and refuses data before any read on policy failure', async () => {
  let required = false; let compliant = false; let unavailable = false; let reads = 0; let logins = 0;
  const merchantId = '11111111-1111-4111-8111-111111111111';
  const access = { ok: true, merchantId, userId: 'synthetic-person', role: 'OWNER', module: 'growth' };
  const identity = { context: { module: 'growth' }, authenticateAndOpenSession: async () => { logins++; return { ok: false }; }, resolveAccessSession: async () => access };
  const security = { module: 'growth', guardRead: () => ({ ok: true }), guardMutation: async () => ({ ok: true, access }), cookies: { read: () => ({ session: 'synthetic-session' }) } };
  const mfaRule = createMfaRule({ ttlMs: 0, supabase: { rpc: async () => {
    if (unavailable) throw new Error('synthetic outage');
    return { required, compliant, privileged: ['OWNER','ADMIN'].includes(access.role) };
  } } });
  const gate = buildGrowthGate({}, { merchantId }, { identity, security, mfaRule });
  const handler = createHostedGrowth({ gate, merchantId, historyScope: 'synthetic', ssoOnly: true,
    app: (_req, res) => { reads++; res.writeHead(200); res.end('{}'); }, store: { list: async () => [], put: async () => ({ ok: true }) },
  });
  const call = async (url = '/api/growth/dropoff') => {
    const result = {}; await handler({ method: 'GET', url, headers: {} }, { writeHead(s) { result.status = s; }, end(body) { result.body = JSON.parse(body); } }); return result;
  };
  assert.equal((await call()).status, 200);
  required = true; assert.equal((await call()).status, 403);
  assert.equal(reads, 1);
  compliant = true; assert.equal((await call()).status, 200);
  unavailable = true; assert.equal((await call()).status, 503);
  assert.equal(reads, 2);
  assert.equal((await call('/api/auth/login')).status, 403, 'Growth cannot bypass Core MFA through its old password form');
  assert.equal(logins, 0);
  assert.equal((await call('/api/auth/session')).body.authenticated, true, 'the session status stays reachable');
});
