// Phase 1d - the permission matrix covers every Core route, and the read-only list agrees with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_RULES, READ_ONLY_POSTS, WRITER_ROLES, MODULE_OPEN_ROLES, FINANCE_INBOX_ROLES } from '../src/identity/permissions.js';

const KNOWN_CORE_ROUTES = [
  ['GET', '/api/core/status'], ['GET', '/api/core/modules'], ['GET', '/api/core/decisions'],
  ['GET', '/api/core/branding'], ['POST', '/api/core/branding/check'], ['POST', '/api/core/branding/approve'],
  ['GET', '/api/core/campaigns'], ['POST', '/api/core/campaigns'],
  ['GET', '/api/core/creation'], ['POST', '/api/core/creation'],
  ['GET', '/api/core/finance/inbox'], ['POST', '/api/core/finance/open'],
  ['POST', '/api/core/analytics/open'], ['POST', '/api/core/growth/open'],
  ['POST', '/api/core/ask'], ['POST', '/api/safety/check'],
  ['POST', '/api/core/decisions'], ['POST', '/api/core/unknown-route'],
];

test('every known Core route is declared in the permission matrix', () => {
  const declared = new Set(ROUTE_RULES.map((r) => `${r.method} ${r.path}`));
  const missing = KNOWN_CORE_ROUTES.map(([m, p]) => `${m} ${p}`).filter((k) => !declared.has(k));
  assert.deepEqual(missing, [], 'a route is not in ROUTE_RULES');
});

test('every read-only POST is declared as read-only, and no read-only POST is a writer', () => {
  for (const path of READ_ONLY_POSTS) {
    const rule = ROUTE_RULES.find((r) => r.method === 'POST' && r.path === path);
    assert.ok(rule, `${path} is not declared`);
    assert.equal(rule.access.startsWith('module-open:') || rule.access === 'read-only-post', true, `${path} is ${rule.access}`);
  }
});

test('the role sets are the ones the server applies', () => {
  assert.deepEqual([...WRITER_ROLES], ['OWNER', 'ADMIN', 'COLLABORATOR']);
  assert.deepEqual([...MODULE_OPEN_ROLES.finance], ['OWNER', 'ADMIN', 'ACCOUNTANT']);
  assert.deepEqual([...MODULE_OPEN_ROLES.analytics], ['OWNER', 'ADMIN', 'ACCOUNTANT']);
  assert.deepEqual([...FINANCE_INBOX_ROLES], ['OWNER', 'ADMIN', 'ACCOUNTANT']);
});
