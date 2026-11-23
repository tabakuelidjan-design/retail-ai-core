// Growth behind the Core gateway: requests without the gateway secret are refused (direct access), with it they reach the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { proxySecretGuard } from '../src/growth/server/proxy-guard.js';

const SECRET = 'x'.repeat(32);
const fakeRes = () => ({ status: 0, body: '', writeHead(s) { this.status = s; }, end(b = '') { this.body += b; } });

test('a request relayed by the Core (with the secret) reaches the module', () => {
  let reached = false;
  const g = proxySecretGuard((req, res) => { reached = true; res.end('ok'); }, SECRET);
  const res = fakeRes();
  g({ headers: { 'x-nordla-proxy-secret': SECRET } }, res);
  assert.equal(reached, true);
});

test('a direct call to the module address (no secret) is refused', () => {
  let reached = false;
  const g = proxySecretGuard(() => { reached = true; }, SECRET);
  const res = fakeRes();
  g({ headers: {} }, res);
  assert.equal(reached, false);
  assert.equal(res.status, 403);
  assert.match(res.body, /PROXY_SECRET_REQUIRED/);
});

test('a wrong secret is refused', () => {
  let reached = false;
  const g = proxySecretGuard(() => { reached = true; }, SECRET);
  const res = fakeRes();
  g({ headers: { 'x-nordla-proxy-secret': 'y'.repeat(32) } }, res);
  assert.equal(reached, false);
});

test('no secret configured: the guard is off (local development unchanged)', () => {
  let reached = false;
  const g = proxySecretGuard(() => { reached = true; }, '');
  g({ headers: {} }, fakeRes());
  assert.equal(reached, true);
});

test('the Nordla host from the gateway secret-checked request becomes the forwarded host', () => {
  let seen = null;
  const g = proxySecretGuard((req, res) => { seen = req.headers['x-forwarded-host']; res.end(); }, SECRET);
  g({ headers: { 'x-nordla-proxy-secret': SECRET, 'x-nordla-public-host': 'staging.nordla.app', 'x-forwarded-host': 'growth-staging-staging.up.railway.app' } }, fakeRes());
  assert.equal(seen, 'staging.nordla.app');
});

test('without the secret the public-host header is ignored (no trust in headers from outside)', () => {
  let seen = null;
  const g = proxySecretGuard((req, res) => { seen = req.headers['x-forwarded-host']; res.end(); }, SECRET);
  g({ headers: { 'x-nordla-public-host': 'staging.nordla.app', 'x-forwarded-host': 'evil.example.test' } }, fakeRes());
  assert.equal(seen, null, 'the module handler is never reached');
});
