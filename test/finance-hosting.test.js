import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { HostingConfigError, clientIpOf, isHosted, parseAllowedHosts, resolveHosting } from '../src/finance/server/hosting.js';
import { TOKEN, startApp } from './finance-dashboard-helpers.js';

// Railway staging compatibility. SYNTHETIC values only: an invented hostname and an invented token.

const HOSTED = { FINANCE_HOSTED: 'true', PORT: '8080', FINANCE_ALLOWED_HOSTS: 'finance-staging.up.railway.app', FINANCE_DASHBOARD_TOKEN: 'x'.repeat(32) };

test('local mode is unchanged: loopback, FINANCE_PORT or 4310, no Secure cookie, no allowlist override', () => {
  assert.equal(isHosted({}), false);
  assert.equal(isHosted({ PORT: '8080' }), false, 'a PORT variable alone never switches hosted mode on');
  const c = resolveHosting({});
  assert.deepEqual(c, { hosted: false, host: '127.0.0.1', port: 4310, allowedHosts: null, secureCookie: false, trustProxyHops: 0, tokenRequired: false });
  assert.equal(resolveHosting({ FINANCE_PORT: '4999' }).port, 4999);
});

test('hosted mode binds 0.0.0.0 on the platform PORT and never a hardcoded port', () => {
  const c = resolveHosting(HOSTED);
  assert.equal(c.hosted, true);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 8080);
  assert.equal(resolveHosting({ ...HOSTED, PORT: '3456' }).port, 3456);
  assert.equal(resolveHosting({ RAILWAY_ENVIRONMENT: 'staging', PORT: '1', FINANCE_ALLOWED_HOSTS: 'a.b', FINANCE_DASHBOARD_TOKEN: 'y'.repeat(30) }).hosted, true, 'Railway markers switch hosted mode on');
  for (const bad of [undefined, '', 'abc', '0', '70000', '80.5']) assert.throws(() => resolveHosting({ ...HOSTED, PORT: bad }), /PORT/, `PORT=${bad}`);
});

test('allowed hosts: parsed as a comma-separated list, lower-cased, deduplicated, strict', () => {
  assert.deepEqual(parseAllowedHosts(' A.up.railway.app , b.example.com,,a.up.railway.app '), ['a.up.railway.app', 'b.example.com']);
  assert.deepEqual(parseAllowedHosts(''), []);
  assert.deepEqual(parseAllowedHosts(undefined), []);
  for (const bad of ['https://a.com', 'a.com/path', '*.railway.app', 'a b.com', '-a.com']) assert.throws(() => parseAllowedHosts(bad), HostingConfigError, bad);
  assert.throws(() => resolveHosting({ ...HOSTED, FINANCE_ALLOWED_HOSTS: '' }), /FINANCE_ALLOWED_HOSTS/, 'hosted without an allowlist refuses to start (Host validation is never disabled)');
  assert.deepEqual(resolveHosting({ ...HOSTED, FINANCE_ALLOWED_HOSTS: 'One.example.com,two.example.com' }).allowedHosts, ['one.example.com', 'two.example.com']);
});

test('hosted mode: the token is mandatory and short tokens are refused', () => {
  const { FINANCE_DASHBOARD_TOKEN, ...noToken } = HOSTED;
  assert.throws(() => resolveHosting(noToken), /FINANCE_DASHBOARD_TOKEN/);
  assert.throws(() => resolveHosting({ ...HOSTED, FINANCE_DASHBOARD_TOKEN: 'short' }), /FINANCE_DASHBOARD_TOKEN/);
  assert.equal(resolveHosting(HOSTED).tokenRequired, true);
});

test('missing Railway token fails startup safely: clear message, exit code 1, no .env written, no network call', () => {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FINANCE_HOSTED: 'true', PORT: '8080', FINANCE_ALLOWED_HOSTS: 'finance-staging.up.railway.app' };
  const r = spawnSync(process.execPath, ['src/finance/server/index.js'], { env, encoding: 'utf8', timeout: 15000, cwd: new URL('..', import.meta.url) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FINANCE_DASHBOARD_TOKEN/);
  assert.match(r.stderr, /No \.env file is generated/);
  assert.doesNotMatch(r.stdout + r.stderr, /listening/i);
});

test('proxy: the client IP is the trusted-proxy entry counted from the right; forged left entries are ignored', () => {
  const req = (xff, ip = '10.0.0.9') => ({ socket: { remoteAddress: ip }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  assert.equal(clientIpOf(req('203.0.113.7'), 0), '10.0.0.9', 'no trusted proxy: the header is ignored');
  assert.equal(clientIpOf(req('203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIpOf(req('1.2.3.4, 203.0.113.7'), 1), '203.0.113.7', 'a client-forged leftmost entry is never used');
  assert.equal(clientIpOf(req('198.51.100.1, 203.0.113.7'), 2), '198.51.100.1');
  assert.equal(clientIpOf(req(undefined), 1), '10.0.0.9', 'no header: falls back to the socket');
  assert.equal(clientIpOf(req('not-an-ip'), 1), '10.0.0.9', 'garbage falls back to the socket');
  assert.equal(clientIpOf(req('2001:db8::1'), 1), '2001:db8::1');
  assert.equal(resolveHosting(HOSTED).trustProxyHops, 1);
  assert.equal(resolveHosting({ ...HOSTED, FINANCE_TRUST_PROXY_HOPS: '0' }).trustProxyHops, 0);
  assert.throws(() => resolveHosting({ ...HOSTED, FINANCE_TRUST_PROXY_HOPS: '9' }), /FINANCE_TRUST_PROXY_HOPS/);
});

/** Raw request so the Host header can be chosen (fetch forbids overriding it). */
const raw = (port, { method = 'GET', path = '/', host, headers = {}, body }) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...headers } }, (res) => {
    const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});
const listenOf = (a) => Number(new URL(a.base).port);

test('hosted app: only allowlisted hosts are served, and localhost is no longer accepted', async () => {
  const a = await startApp({ deps: { allowedHosts: ['finance-staging.up.railway.app'], secureCookie: true, trustProxyHops: 1 } });
  try {
    const port = listenOf(a);
    assert.equal((await raw(port, { path: '/', host: 'finance-staging.up.railway.app' })).status, 200);
    assert.equal((await raw(port, { path: '/', host: 'Finance-Staging.UP.railway.app' })).status, 200, 'hostnames are case-insensitive');
    assert.equal((await raw(port, { path: '/', host: 'evil.example.com' })).status, 403);
    assert.equal((await raw(port, { path: '/', host: '127.0.0.1:' + port })).status, 403);
    assert.equal((await raw(port, { path: '/api/session', host: 'other.up.railway.app' })).status, 403);
  } finally { await a.close(); }
});

test('hosted app: the session cookie is Secure + HttpOnly + SameSite=Strict, HSTS is sent, CSRF and origin checks still apply', async () => {
  const a = await startApp({ deps: { allowedHosts: ['finance-staging.up.railway.app'], secureCookie: true, trustProxyHops: 1 } });
  try {
    const port = listenOf(a);
    const host = 'finance-staging.up.railway.app';
    const login = await raw(port, { method: 'POST', path: '/api/login', host, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(login.status, 200);
    const cookie = [].concat(login.headers['set-cookie'])[0];
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Strict/);
    assert.match(login.headers['strict-transport-security'], /max-age=/);
    const csrf = JSON.parse(login.text).csrf;
    const session = cookie.split(';')[0];
    const post = (extra) => raw(port, { method: 'POST', path: '/api/logout', host, headers: { 'Content-Type': 'application/json', Cookie: session, ...extra }, body: '{}' });
    assert.equal((await post({ 'X-CSRF-Token': 'wrong' })).status, 403, 'CSRF token still required');
    assert.equal((await post({ 'X-CSRF-Token': csrf, Origin: 'https://evil.example.com' })).status, 403, 'origin validation still applies');
    const out = await post({ 'X-CSRF-Token': csrf, Origin: `https://${host}` });
    assert.equal(out.status, 200);
    assert.match([].concat(out.headers['set-cookie'])[0], /Max-Age=0.*; Secure/, 'the logout cookie is Secure too');
  } finally { await a.close(); }
});

test('hosted app: the login limiter keys on the proxy-reported client, not on the proxy', async () => {
  const a = await startApp({ deps: { allowedHosts: ['finance-staging.up.railway.app'], secureCookie: true, trustProxyHops: 1 } });
  try {
    const port = listenOf(a); const host = 'finance-staging.up.railway.app';
    const attempt = (ip, token) => raw(port, { method: 'POST', path: '/api/login', host, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `9.9.9.9, ${ip}` }, body: JSON.stringify({ token }) });
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt('203.0.113.10', 'wrong-wrong-wrong-wrong-wrong')).status, 401);
    assert.equal((await attempt('203.0.113.10', TOKEN)).status, 429, 'that client is locked out');
    assert.equal((await attempt('203.0.113.11', TOKEN)).status, 200, 'another client behind the same proxy is not');
  } finally { await a.close(); }
});

test('local app: localhost over plain HTTP still works and the cookie has no Secure flag', async () => {
  const a = await startApp();
  try {
    const login = await raw(listenOf(a), { method: 'POST', path: '/api/login', host: `127.0.0.1:${listenOf(a)}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(login.status, 200);
    const cookie = [].concat(login.headers['set-cookie'])[0];
    assert.doesNotMatch(cookie, /Secure/);
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal(login.headers['strict-transport-security'], undefined);
    assert.equal((await raw(listenOf(a), { path: '/', host: 'evil.example.com' })).status, 403);
  } finally { await a.close(); }
});
