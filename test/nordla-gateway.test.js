// The common Nordla gateway (src/shared/nordla-gateway.js) and the module servers' proxy-secret rule. Real http servers, fake services, no data.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway, routeFor, filterCookies, rewriteLocation, rewriteSetCookie } from '../src/shared/nordla-gateway.js';
import { proxySecretOk, requiredProxySecret } from '../src/shared/proxy-secret.js';
import { mkdtempSync } from 'node:fs';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { createGrowthApp } from '../src/growth/server/app.js';

const SECRET = 'x'.repeat(32);
const TOKEN = 'analytics-token-test-value-123456';
const PDF = Buffer.from('%PDF-1.4 synthetic\n' + 'a'.repeat(4096));

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}
function request(base, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const req = http.request(u, { method, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c), text: Buffer.concat(c).toString('utf8') })); });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

/** A fake module service: records what it received, and answers a few paths the gateway must handle. */
async function fakeService(name) {
  const seen = [];
  const svc = await listen(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const p = url.pathname;
    if (p === '/echo') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ service: name })); }
    if (p === '/after') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('after'); }
    if (p === '/redir') { res.writeHead(302, { location: `http://127.0.0.1:${svc.server.address().port}/after?k=1` }); return res.end(); }
    if (p === '/redir-rel') { res.writeHead(302, { location: '/after' }); return res.end(); }
    if (p === '/login') { const sessionCookie = name === 'analytics' ? 'an_sid=abc' : 'fin_sid=abc'; res.writeHead(302, { location: '/after', 'set-cookie': [`${sessionCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, 'other=1; Path=/'] }); return res.end(); }
    if (p === '/growth-login') { res.writeHead(302, { location: '/', 'set-cookie': ['__Host-nordla_growth_sid=g1; HttpOnly; Secure; SameSite=Lax; Path=/', 'fin_sid=x; Path=/'] }); return res.end(); }
    if (p === '/basic') { res.writeHead(401, { 'www-authenticate': 'Basic realm="x"', 'content-type': 'application/json' }); return res.end('{}'); }
    if (p === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="facture.pdf"', 'content-length': String(PDF.length) }); return res.end(PDF); }
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' }); res.end('<html>' + name + '</html>');
  });
  return { ...svc, seen };
}

async function gatewayFixture({ growthEnabled = false, sessionOk = true } = {}) {
  const fin = await fakeService('finance');
  const ana = await fakeService('analytics');
  const gro = await fakeService('growth');
  const services = {
    finance: { upstream: fin.origin, enabled: true, secret: SECRET },
    analytics: { upstream: ana.origin, enabled: true, secret: SECRET, token: TOKEN },
    growth: { upstream: gro.origin, enabled: growthEnabled, secret: SECRET },
  };
  let publicOrigin = '';
  const authorize = async (req) => ((sessionOk && /(?:^|;\s*)nordla_core_session=1(?:;|$)/.test(req.headers.cookie ?? '')) ? { ok: true } : { ok: false, status: 401, code: 'SESSION_REQUIRED' });
  const gw = createGateway({ publicOrigin: 'https://nordla.test', services, authorize });
  const core = await listen(async (req, res) => { const url = new URL(req.url, 'https://nordla.test'); if (await gw(req, res, url)) return; res.writeHead(404); res.end('core'); });
  publicOrigin = 'https://nordla.test';
  // requests go to the local core server, but the Origin header and the Host seen by the gateway are the public ones
  const call = (opts) => request(core.origin, { ...opts, headers: { ...(opts?.headers ?? {}) } });
  const session = { cookie: 'nordla_core_session=1' };
  return {
    core, fin, ana, gro, call, session,
    close: async () => { await core.close(); await fin.close(); await ana.close(); await gro.close(); },
  };
}

test('routes: a module prefix is matched on a path boundary only; its root maps to /', () => {
  assert.deepEqual(routeFor('/finance/x/y'), { key: 'finance', prefix: '/finance', upstreamPath: '/x/y' });
  assert.deepEqual(routeFor('/finance'), { key: 'finance', prefix: '/finance', upstreamPath: '/' });
  assert.equal(routeFor('/financeX'), null, 'a longer word is not the module');
  assert.equal(routeFor('/sourcing'), null, 'Core paths are not gateway paths');
  assert.equal(routeFor('/analyses/api/ask')?.key, 'analytics');
  assert.equal(routeFor('/growth/')?.key, 'growth');
});

test('cookies: a module receives only its own session cookies; Core cookies never leave Core', () => {
  assert.equal(filterCookies('nordla_core_session=1; fin_sid=abc; other=2'), 'fin_sid=abc');
  assert.equal(filterCookies('fin_demo_sid=xyz'), 'fin_demo_sid=xyz');
  assert.equal(filterCookies('nordla_core_session=1'), undefined);
  assert.equal(filterCookies('fin_sid=abc', null), undefined, 'a module with no cookies gets none');
});

test('redirects and cookies are rewritten under the module prefix', () => {
  assert.equal(rewriteLocation('/', 'http://f.internal', '/finance'), '/finance/');
  assert.equal(rewriteLocation('http://f.internal/#/todo', 'http://f.internal', '/finance'), '/finance/#/todo');
  assert.equal(rewriteLocation('https://elsewhere.example/', 'http://f.internal', '/finance'), 'https://elsewhere.example/');
  assert.equal(rewriteSetCookie('fin_sid=abc; HttpOnly; Path=/; Max-Age=28800', '/finance'), 'fin_sid=abc; HttpOnly; Path=/finance; Max-Age=28800');
  assert.equal(rewriteLocation('/x', 'http://a.internal', '/analyses'), '/analyses/x');
});

test('proxy secret: missing or wrong refuses; the expected one passes; a hosted module must have one', () => {
  assert.equal(proxySecretOk({ headers: {} }, null), true, 'local: no gateway, no check');
  assert.equal(proxySecretOk({ headers: {} }, SECRET), false);
  assert.equal(proxySecretOk({ headers: { 'x-nordla-proxy-secret': 'nope' } }, SECRET), false);
  assert.equal(proxySecretOk({ headers: { 'x-nordla-proxy-secret': SECRET } }, SECRET), true);
  assert.throws(() => requiredProxySecret({}), /NORDLA_PROXY_SECRET/);
  assert.throws(() => requiredProxySecret({ NORDLA_PROXY_SECRET: 'short' }), /at least 24/);
  assert.equal(requiredProxySecret({ NORDLA_PROXY_SECRET: SECRET }), SECRET);
});

test('a closed module (Growth) is refused before anything is sent upstream, even with a Core session', async () => {
  const f = await gatewayFixture({ growthEnabled: false });
  try {
    const r = await f.call({ path: '/growth/api/growth/overview', headers: f.session });
    assert.equal(r.status, 403); assert.equal(JSON.parse(r.text).error, 'MODULE_CLOSED');
    assert.equal(f.gro.seen.length, 0, 'nothing reached Growth');
  } finally { await f.close(); }
});

test('no Core session: 401 and nothing reaches the module (no anonymous access)', async () => {
  const f = await gatewayFixture();
  try {
    for (const p of ['/finance/echo', '/analyses/echo']) {
      const r = await f.call({ path: p });
      assert.equal(r.status, 401); assert.equal(JSON.parse(r.text).error, 'SESSION_REQUIRED');
    }
    assert.equal(f.fin.seen.length + f.ana.seen.length, 0);
  } finally { await f.close(); }
});

test('forwarding: the module gets its prefix-free path, the proxy secret, its own cookie only, and no browser authorization', async () => {
  const f = await gatewayFixture();
  try {
    const r = await f.call({ path: '/finance/echo?x=1', headers: { ...f.session, cookie: 'nordla_core_session=1; fin_sid=abc', 'x-nordla-proxy-secret': 'forged', authorization: 'Basic Zm9yZ2Vk' } });
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).service, 'finance');
    const got = f.fin.seen[0];
    assert.equal(got.url, '/echo?x=1');
    assert.equal(got.headers['x-nordla-proxy-secret'], SECRET, 'the gateway sets the secret, a forged one is dropped');
    assert.equal(got.headers.cookie, 'fin_sid=abc', 'Core cookie not forwarded');
    assert.equal(got.headers.authorization, undefined);
    assert.equal(new URL(f.fin.origin).host, got.headers.host);
  } finally { await f.close(); }
});

test('analytics forwards only its SSO cookie while the gateway keeps the access token server-side', async () => {
  const f = await gatewayFixture();
  try {
    const r = await f.call({ path: '/analyses/echo', headers: { ...f.session, cookie: 'nordla_core_session=1; an_sid=xyz; fin_sid=abc; other=2' } });
    assert.equal(r.status, 200);
    const got = f.ana.seen[0];
    assert.equal(got.headers.authorization, `Basic ${Buffer.from(`nordla:${TOKEN}`).toString('base64')}`);
    assert.equal(got.headers.cookie, 'an_sid=xyz', 'only the Analytics SSO cookie reaches Analytics');
    assert.equal(r.text.includes(TOKEN), false);
    for (const v of Object.values(r.headers)) assert.equal(String(v).includes(TOKEN), false, 'token not in any response header');
  } finally { await f.close(); }
});

test('Analytics sets only its own SSO cookie under /analyses; Basic prompts never reach the browser', async () => {
  const f = await gatewayFixture();
  try {
    const basic = await f.call({ path: '/analyses/basic', headers: f.session });
    assert.equal(basic.status, 401); assert.equal(basic.headers['www-authenticate'], undefined);
    const login = await f.call({ path: '/analyses/login', headers: f.session });
    const cookies = [].concat(login.headers['set-cookie']);
    assert.deepEqual(cookies, ['an_sid=abc; HttpOnly; SameSite=Strict; Path=/analyses; Max-Age=28800']);
  } finally { await f.close(); }
});

test('finance: redirects stay under /finance and its session cookie is scoped to /finance', async () => {
  const f = await gatewayFixture();
  try {
    const rel = await f.call({ path: '/finance/redir-rel', headers: f.session });
    assert.equal(rel.headers.location, '/finance/after');
    const abs = await f.call({ path: '/finance/redir', headers: f.session });
    assert.equal(abs.headers.location, '/finance/after?k=1', 'an upstream absolute address becomes a Nordla path');
    const login = await f.call({ path: '/finance/login', headers: f.session });
    const cookies = [].concat(login.headers['set-cookie']);
    assert.ok(cookies.some((c) => c.startsWith('fin_sid=abc') && c.includes('Path=/finance')), 'session cookie scoped to /finance');
    assert.ok(cookies.every((c) => !/Path=\/(?!finance)/.test(c)), 'no cookie left at Path=/');
  } finally { await f.close(); }
});

test('Finance keeps its own frame policy at the gateway: it is mounted in the Core page, never framed', async () => {
  const f = await gatewayFixture();
  try {
    const r = await f.call({ path: '/finance/', headers: f.session });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    const analytics = await f.call({ path: '/analyses/', headers: f.session });
    assert.equal(analytics.headers['x-frame-options'], 'DENY', 'other modules keep their own frame policy');
    assert.match(analytics.headers['content-security-policy'], /frame-ancestors 'none'/);
  } finally { await f.close(); }
});

test('a module root without a slash goes to its slash address', async () => {
  const f = await gatewayFixture();
  try {
    const r = await f.call({ path: '/analyses?period=x', headers: f.session });
    assert.equal(r.status, 301); assert.equal(r.headers.location, '/analyses/?period=x');
  } finally { await f.close(); }
});

test('mutations: same-origin Origin is passed as the upstream origin; a foreign Origin is refused and never forwarded', async () => {
  const f = await gatewayFixture();
  try {
    const ok = await f.call({ method: 'POST', path: '/finance/echo', headers: { ...f.session, origin: 'https://nordla.test', 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.equal(ok.status, 200);
    assert.equal(f.fin.seen[0].headers.origin, f.fin.origin);
    assert.equal(f.fin.seen[0].body, '{"a":1}', 'the body is forwarded unchanged');
    const bad = await f.call({ method: 'POST', path: '/finance/echo', headers: { ...f.session, origin: 'https://evil.example' }, body: '{}' });
    assert.equal(bad.status, 403); assert.equal(JSON.parse(bad.text).error, 'ORIGIN_NOT_ALLOWED');
    assert.equal(f.fin.seen.length, 1, 'the refused call never reached Finance');
  } finally { await f.close(); }
});

test('downloads: a PDF comes back byte for byte with its file name', async () => {
  const f = await gatewayFixture();
  try {
    const r = await f.call({ path: '/finance/pdf', headers: f.session });
    assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'application/pdf');
    assert.match(r.headers['content-disposition'], /facture\.pdf/);
    assert.ok(r.body.equals(PDF));
  } finally { await f.close(); }
});

test('Core paths are not touched by the gateway; an unreachable module answers 502 JSON', async () => {
  const f = await gatewayFixture();
  try {
    const core = await f.call({ path: '/sourcing', headers: f.session });
    assert.equal(core.status, 404); assert.equal(core.text, 'core');
    await f.fin.close();
    const down = await f.call({ path: '/finance/echo', headers: f.session });
    assert.equal(down.status, 502); assert.equal(JSON.parse(down.text).error, 'UPSTREAM_UNAVAILABLE');
  } finally { await f.close().catch(() => {}); }
});

test('growth: its own __Host- session cookie reaches the browser unchanged (Path=/), and no other module cookie does', async () => {
  const f = await gatewayFixture({ growthEnabled: true });
  try {
    const r = await f.call({ path: '/growth/growth-login', headers: f.session });
    const sc = [].concat(r.headers['set-cookie'] ?? []);
    assert.equal(sc.length, 1, 'exactly one cookie: the Growth session');
    assert.ok(sc[0].startsWith('__Host-nordla_growth_sid=g1;'));
    assert.ok(sc[0].endsWith('Path=/') || sc[0].includes('Path=/;'), 'Path stays / for the __Host- prefix');
  } finally { await f.close(); }
});

test('growth: only its own cookies are sent to Growth', async () => {
  const f = await gatewayFixture({ growthEnabled: true });
  try {
    await f.call({ path: '/growth/echo', headers: { ...f.session, cookie: 'nordla_core_session=1; __Host-nordla_growth_sid=g1; an_sid=s1; fin_sid=abc' } });
    const got = f.gro.seen[0];
    assert.equal(got.headers.cookie, '__Host-nordla_growth_sid=g1');
  } finally { await f.close(); }
});

test('growth: the Nordla host is passed in x-nordla-public-host (the module checks Host against it after the proxy secret)', async () => {
  const f = await gatewayFixture({ growthEnabled: true });
  try {
    await f.call({ path: '/growth/echo', headers: f.session });
    assert.equal(f.gro.seen[0].headers['x-nordla-public-host'], 'nordla.test');
    assert.equal(f.gro.seen[0].headers['x-forwarded-host'], 'nordla.test');
  } finally { await f.close(); }
});
