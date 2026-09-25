import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { HostingConfigError, basicPassword, clientIpOf, createGuard, isHosted, parseAllowedHosts, resolveHosting } from '../src/analytics-premium/server/hosting.js';
import { runReportOnce, startReportRefresh, startSyncAwareRefresh } from '../src/analytics-premium/server/report-refresh.js';

// Railway staging for Analytics. SYNTHETIC values only.
const TOKEN = 't'.repeat(32);
const HOST = 'analytics-staging.up.railway.app';
const HOSTED = { ANALYTICS_HOSTED: 'true', PORT: '8080', ANALYTICS_ALLOWED_HOSTS: HOST, ANALYTICS_ACCESS_TOKEN: TOKEN };
const basic = (pw, user = 'x') => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;

test('local mode is unchanged: loopback, ANALYTICS_PREMIUM_PORT or 4411, no barrier', () => {
  assert.equal(isHosted({}), false);
  assert.equal(isHosted({ PORT: '8080' }), false);
  assert.deepEqual(resolveHosting({}), { hosted: false, host: '127.0.0.1', port: 4411, allowedHosts: null, token: null, trustProxyHops: 0, refreshHours: 0, checkMinutes: 5 });
  assert.equal(resolveHosting({ ANALYTICS_PREMIUM_PORT: '4500' }).port, 4500);
});

test('hosted mode: 0.0.0.0 on the platform PORT, allowlist and access token mandatory', () => {
  const c = resolveHosting(HOSTED);
  assert.equal(c.host, '0.0.0.0'); assert.equal(c.port, 8080); assert.deepEqual(c.allowedHosts, [HOST]); assert.equal(c.trustProxyHops, 1); assert.equal(c.refreshHours, 6);
  assert.equal(resolveHosting({ ...HOSTED, PORT: '3456' }).port, 3456);
  assert.equal(resolveHosting({ ...HOSTED, ANALYTICS_HOSTED: undefined, RAILWAY_ENVIRONMENT: 'production' }).hosted, true);
  for (const bad of [undefined, '', 'x', '0', '99999']) assert.throws(() => resolveHosting({ ...HOSTED, PORT: bad }), /PORT/);
  assert.throws(() => resolveHosting({ ...HOSTED, ANALYTICS_ALLOWED_HOSTS: '' }), /ANALYTICS_ALLOWED_HOSTS/);
  assert.throws(() => resolveHosting({ ...HOSTED, ANALYTICS_ACCESS_TOKEN: undefined }), /ANALYTICS_ACCESS_TOKEN/);
  assert.throws(() => resolveHosting({ ...HOSTED, ANALYTICS_ACCESS_TOKEN: 'short' }), /ANALYTICS_ACCESS_TOKEN/);
  assert.throws(() => resolveHosting({ ...HOSTED, ANALYTICS_REPORT_REFRESH_HOURS: '-1' }), /REFRESH/);
  assert.equal(resolveHosting({ ...HOSTED, ANALYTICS_REPORT_REFRESH_HOURS: '0' }).refreshHours, 0);
});

test('allowed hosts parsing is strict; proxy IP is taken from the right', () => {
  assert.deepEqual(parseAllowedHosts(' A.b.app , c.d ,,a.b.app'), ['a.b.app', 'c.d']);
  for (const bad of ['https://a.b', 'a.b/x', '*.b', 'a b']) assert.throws(() => parseAllowedHosts(bad), HostingConfigError);
  const req = (xff) => ({ socket: { remoteAddress: '10.0.0.9' }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIpOf(req('1.2.3.4, 203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIpOf(req('203.0.113.7'), 0), '10.0.0.9');
  assert.equal(clientIpOf(req('junk'), 1), '10.0.0.9');
  assert.equal(basicPassword(basic('pw:with:colons')), 'pw:with:colons');
  assert.equal(basicPassword('Bearer abc'), '');
  assert.equal(basicPassword(undefined), '');
});

test('missing token in hosted mode fails startup with a clear error and serves nothing', () => {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ANALYTICS_HOSTED: 'true', PORT: '8080', ANALYTICS_ALLOWED_HOSTS: HOST };
  const r = spawnSync(process.execPath, ['src/analytics-premium/server/serve.js'], { env, encoding: 'utf8', timeout: 15000, cwd: new URL('..', import.meta.url) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ANALYTICS_ACCESS_TOKEN/);
  assert.doesNotMatch(r.stdout + r.stderr, /listening/i);
});

const get = (port, p, { host = HOST, auth, xff } = {}) => new Promise((resolve, reject) => {
  const headers = { Host: host, ...(auth ? { Authorization: auth } : {}), ...(xff ? { 'X-Forwarded-For': xff } : {}) };
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') })); }).on('error', reject);
});

async function guarded() {
  const dir = await mkdtemp(path.join(tmpdir(), 'analytics-'));
  await writeFile(path.join(dir, 'report-2026-09-25.json'), JSON.stringify({ synthetic: true }));
  const guard = createGuard({ allowedHosts: [HOST], token: TOKEN, trustProxyHops: 1 });
  const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir, guard }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('hosted: nothing (page, static file, api) is served without the token', async () => {
  const s = await guarded();
  try {
    for (const p of ['/', '/app.js', '/api/brief', '/api/customers', '/api/products', '/nordla-tokens.css']) {
      const r = await get(s.port, p);
      assert.equal(r.status, 401, p);
      assert.match(r.headers['www-authenticate'], /^Basic realm=/);
      assert.equal(JSON.parse(r.text).error.code, 'ACCESS_TOKEN_REQUIRED');
    }
    assert.equal((await get(s.port, '/api/brief', { auth: basic('wrong-token') })).status, 401);
    assert.equal((await get(s.port, '/api/brief', { auth: 'Bearer ' + TOKEN })).status, 401);
  } finally { await s.close(); }
});

test('hosted: right token passes on the allowed host only; HSTS and noindex are sent', async () => {
  const s = await guarded();
  try {
    const page = await get(s.port, '/', { auth: basic(TOKEN) });
    assert.equal(page.status, 200);
    assert.match(page.headers['strict-transport-security'], /max-age=/);
    assert.match(page.headers['x-robots-tag'], /noindex/);
    assert.notEqual((await get(s.port, '/api/brief', { auth: basic(TOKEN, 'anyone') })).status, 401, 'any user name works, the password is the token');
    assert.equal((await get(s.port, '/', { auth: basic(TOKEN), host: 'evil.example.com' })).status, 403, 'a foreign host is refused even with the token');
    assert.equal((await get(s.port, '/', { auth: basic(TOKEN), host: HOST.toUpperCase() })).status, 200);
  } finally { await s.close(); }
});

test('hosted: repeated wrong tokens lock that client out, not another one behind the proxy', async () => {
  const s = await guarded();
  try {
    const bad = (ip) => get(s.port, '/', { auth: basic('nope-nope-nope'), xff: `9.9.9.9, ${ip}` });
    for (let i = 0; i < 5; i += 1) assert.equal((await bad('203.0.113.10')).status, 401);
    assert.equal((await get(s.port, '/', { auth: basic(TOKEN), xff: '9.9.9.9, 203.0.113.10' })).status, 429);
    assert.equal((await get(s.port, '/', { auth: basic(TOKEN), xff: '9.9.9.9, 203.0.113.11' })).status, 200);
  } finally { await s.close(); }
});

test('local app (no guard) still serves without a token', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'analytics-'));
  const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await get(server.address().port, '/', { host: 'localhost' })).status, 200);
    assert.equal((await get(server.address().port, '/api/brief', { host: 'localhost' })).status, 404, 'no report yet -> honest NO_REPORT_AVAILABLE');
  } finally { await new Promise((r) => server.close(r)); }
});

test('report refresh: runs the Core report command at startup, repeats on the interval, and a failure never throws', async () => {
  const calls = [];
  const fake = (code, stderr = '') => (cmd, args, opts) => { const c = new EventEmitter(); c.stderr = new EventEmitter(); calls.push({ args, cwd: opts.cwd }); setImmediate(() => { if (stderr) c.stderr.emit('data', stderr); c.emit('close', code); }); return c; };
  const logs = [];
  assert.equal(await runReportOnce({ spawnFn: fake(0), log: (m) => logs.push(m) }), true);
  assert.deepEqual(calls[0].args, ['src/report/index.js', 'report']);
  assert.equal(await runReportOnce({ spawnFn: fake(1, 'line1\nboom happened'), log: (m) => logs.push(m) }), false);
  assert.match(logs.at(-1), /failed \(exit 1\): boom happened/);
  let tick; let runs = 0;
  const handle = startReportRefresh({ hours: 6, run: async () => { runs += 1; }, setIntervalFn: (fn, ms) => { tick = { fn, ms }; return { unref() {} }; } });
  await handle.first;
  assert.equal(runs, 1); assert.equal(tick.ms, 6 * 3600_000);
  tick.fn(); assert.equal(runs, 2);
  startReportRefresh({ hours: 0, run: async () => {}, setIntervalFn: () => { throw new Error('no timer expected'); } });
});

test('report refresh is sync-aware: regenerates only when a newer successful sync exists, retries after a failure, never on an unchanged sync', async () => {
  let sync = '2026-09-26T10:00:00Z'; let runs = 0; let okNext = true; let clock = 0;
  const handle = startSyncAwareRefresh({ getSyncFinishedAt: async () => sync, run: async () => { runs += 1; return okNext; }, checkMinutes: 5, fallbackHours: 6, setIntervalFn: () => ({ unref() {} }), now: () => clock });
  await handle.first;
  assert.equal(runs, 1, 'first report at startup');
  assert.equal(await handle.tick(), false); assert.equal(runs, 1, 'same sync: nothing to regenerate');
  sync = '2026-09-26T10:15:00Z'; clock += 15 * 60_000;
  okNext = false; assert.equal(await handle.tick(), false); assert.equal(runs, 2, 'a newer sync triggers a run');
  okNext = true; assert.equal(await handle.tick(), true); assert.equal(runs, 3, 'the failed run is retried on the next check (the previous report stays in place)');
  assert.equal(await handle.tick(), false); assert.equal(runs, 3, 'built from the newest sync now');
  clock += 7 * 3600_000; assert.equal(await handle.tick(), true); assert.equal(runs, 4, 'safety net: regenerate after fallbackHours even with no newer sync');
});

test('report refresh falls back to the interval when the sync status cannot be read', async () => {
  let runs = 0; let clock = 0;
  const handle = startSyncAwareRefresh({ getSyncFinishedAt: async () => { throw new Error('db down'); }, run: async () => { runs += 1; return true; }, checkMinutes: 5, fallbackHours: 1, setIntervalFn: () => ({ unref() {} }), now: () => clock });
  await handle.first; assert.equal(runs, 1);
  clock += 30 * 60_000; await handle.tick(); assert.equal(runs, 1);
  clock += 31 * 60_000; await handle.tick(); assert.equal(runs, 2);
});
