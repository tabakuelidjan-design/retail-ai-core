// Growth listening: local = loopback only; hosted = every interface on PORT, with the host check and the proxy secret required.
// Real servers and real requests; no secret value is printed or compared outside the test itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolveGrowthListen, listenGrowth, GrowthHostingError, parseAllowedHosts } from '../src/growth/server/hosting.js';
import { createGrowthApp } from '../src/growth/server/app.js';

const SECRET = randomBytes(24).toString('hex');
const HOSTED = { RAILWAY_ENVIRONMENT: 'staging', GROWTH_ALLOWED_HOSTS: 'growth.nordla-test.example', NORDLA_PROXY_SECRET: SECRET };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const req = (port, path, headers = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(t), text: t })); }); r.on('error', reject); r.end(); });

test('local (no hosted marker): the plan is loopback only, on GROWTH_PORT, with no host requirement', () => {
  const plan = resolveGrowthListen({ GROWTH_PORT: '4413' });
  assert.equal(plan.hosted, false); assert.equal(plan.host, '127.0.0.1'); assert.equal(plan.port, 4413);
  assert.deepEqual(plan.allowedHosts, ['127.0.0.1', 'localhost']);
});

test('hosted (Railway marker): every interface on the platform PORT, with the required host names and secret', () => {
  const plan = resolveGrowthListen({ ...HOSTED, PORT: '8080' });
  assert.equal(plan.hosted, true); assert.equal(plan.host, '0.0.0.0'); assert.equal(plan.port, 8080);
  assert.deepEqual(plan.allowedHosts, ['growth.nordla-test.example']); assert.equal(plan.proxySecret, SECRET);
});

test('hosted refuses to start without PORT, without host names, or without the proxy secret (naming the variable, not the value)', () => {
  assert.throws(() => resolveGrowthListen({ ...HOSTED }), (e) => e instanceof GrowthHostingError && /PORT/.test(e.message));
  assert.throws(() => resolveGrowthListen({ ...HOSTED, PORT: '8080', GROWTH_ALLOWED_HOSTS: '' }), (e) => e instanceof GrowthHostingError && /GROWTH_ALLOWED_HOSTS/.test(e.message));
  assert.throws(() => resolveGrowthListen({ ...HOSTED, PORT: '8080', NORDLA_PROXY_SECRET: 'short' }), (e) => e instanceof GrowthHostingError && /NORDLA_PROXY_SECRET/.test(e.message) && !e.message.includes('short'));
});

test('host names: exact and plain only; a scheme, a path, a wildcard or a space is refused', () => {
  assert.deepEqual(parseAllowedHosts(' Growth.Example.com , other.example '), ['growth.example.com', 'other.example']);
  for (const bad of ['https://growth.example.com', 'growth.example.com/x', '*.example.com', 'bad host']) assert.throws(() => parseAllowedHosts(bad), GrowthHostingError, bad);
});

test('local listener: bound to 127.0.0.1 only; a request with a foreign Host is refused before the app', async () => {
  const port = await freePort();
  const { server, plan } = await listenGrowth({ env: { GROWTH_PORT: String(port) }, createHandler: (p) => createGrowthApp({ proxySecret: p.proxySecret }) });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal((await req(port, '/', { Host: 'evil.example' })).status, 403);
    assert.equal(plan.hosted, false);
  } finally { await new Promise((r) => server.close(r)); }
});

test('hosted listener: bound to every interface; an unlisted Host is refused; a listed Host without the proxy secret is refused by the app', async () => {
  const port = await freePort();
  const env = { ...HOSTED, PORT: String(port) };
  const { server } = await listenGrowth({ env, createHandler: (p) => createGrowthApp({ proxySecret: p.proxySecret }) });
  try {
    assert.equal(server.address().address, '0.0.0.0');
    const foreign = await req(port, '/api/growth/overview', { Host: 'attacker.example' });
    assert.equal(foreign.status, 403); assert.equal((await foreign.json()).error.code, 'HOST_NOT_ALLOWED');
    const noSecret = await req(port, '/api/growth/overview', { Host: 'growth.nordla-test.example' });
    assert.equal(noSecret.status, 403); assert.equal((await noSecret.json()).error.code, 'PROXY_SECRET_REQUIRED');
    const withSecret = await req(port, '/api/growth/overview', { Host: 'growth.nordla-test.example', 'x-nordla-proxy-secret': SECRET });
    assert.equal(withSecret.status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});
