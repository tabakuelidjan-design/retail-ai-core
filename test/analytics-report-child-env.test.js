// The report child gets an EXPLICIT environment: no inherited Shopify, Finance, dashboard, access or SSO secret, and NO Supabase service key.
// It reads and writes Postgres through its two least-privilege URLs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportChildEnv, REPORT_CHILD_ENV_NAMES } from '../src/analytics-premium/server/report-env.js';
import { runReportOnce } from '../src/analytics-premium/server/report-refresh.js';

const SERVER_ENV = {
  PATH: '/bin', NODE_ENV: 'production', TZ: 'Europe/Brussels',
  NORDLA_MERCHANT_ID: '67646dbb-5e2e-4cd7-aad6-0ab289b068cb', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k-service',
  MERCHANT_TIMEZONE: 'Europe/Brussels',
  ANALYTICS_REPORT_READ_DATABASE_URL: 'postgresql://analytics_report_reader_login:x@db.example:5432/postgres',
  ANALYTICS_REPORT_WRITE_DATABASE_URL: 'postgresql://analytics_report_writer_login:y@db.example:5432/postgres',
  // what the server holds and the child must NOT receive:
  ANALYTICS_ACCESS_TOKEN: 'tok-analytics', ANALYTICS_SSO_KEY: 'sso-analytics', ANALYTICS_ACCESS_DATABASE_URL: 'postgresql://checker:z@db.example/postgres',
  SHOPIFY_ACCESS_TOKEN: 'shp', FINANCE_DASHBOARD_TOKEN: 'fin-dash', FINANCE_SSO_KEY: 'fin-sso', GROWTH_SSO_SECRET: 'growth', RAILWAY_TOKEN: 'rw', OPENAI_API_KEY: 'llm',
};

test('the child receives only the allowlisted names: the two report URLs, the merchant, the timezone and the child marker', () => {
  const env = reportChildEnv(SERVER_ENV);
  assert.deepEqual(Object.keys(env).sort(), [
    'ANALYTICS_REPORT_READ_DATABASE_URL', 'ANALYTICS_REPORT_WRITE_DATABASE_URL', 'MERCHANT_TIMEZONE', 'NODE_ENV', 'NORDLA_MERCHANT_ID',
    'NORDLA_REPORT_CHILD', 'PATH', 'TZ',
  ]);
  assert.equal(env.NORDLA_REPORT_CHILD, '1');
});

test('no Supabase key or URL, no server secret, reaches the child', () => {
  const env = reportChildEnv(SERVER_ENV);
  for (const forbidden of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'ANALYTICS_ACCESS_TOKEN', 'ANALYTICS_SSO_KEY', 'ANALYTICS_ACCESS_DATABASE_URL',
    'SHOPIFY_ACCESS_TOKEN', 'FINANCE_DASHBOARD_TOKEN', 'FINANCE_SSO_KEY', 'GROWTH_SSO_SECRET', 'RAILWAY_TOKEN', 'OPENAI_API_KEY']) {
    assert.equal(forbidden in env, false, `${forbidden} must not reach the child`);
  }
});

test('empty or absent names are not passed at all (the marker is always set)', () => {
  assert.deepEqual(reportChildEnv({ PATH: '/bin', TZ: '' }), { NORDLA_REPORT_CHILD: '1', PATH: '/bin' });
});

test('the allowlist names no service key and no server secret', () => {
  assert.equal(REPORT_CHILD_ENV_NAMES.includes('SUPABASE_SERVICE_ROLE_KEY'), false);
  assert.equal(REPORT_CHILD_ENV_NAMES.some((n) => /SHOPIFY|DASHBOARD|ACCESS_TOKEN|SSO|SERVICE_ROLE/.test(n)), false);
});

test('runReportOnce spawns the same command, with the explicit environment only', async () => {
  let seen = null;
  const fakeSpawn = (cmd, args, opts) => {
    seen = { cmd, args, env: opts.env };
    const child = { stdout: { on() {} }, stderr: { on() {} }, on(ev, fn) { if (ev === 'close') setTimeout(() => fn(0), 0); } };
    return child;
  };
  await runReportOnce({ spawnFn: fakeSpawn, env: SERVER_ENV, log: () => {} });
  assert.deepEqual(seen.args, ['src/report/index.js', 'report'], 'the same command as before');
  assert.equal('ANALYTICS_ACCESS_TOKEN' in seen.env, false);
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in seen.env, false);
  assert.equal(seen.env.NORDLA_MERCHANT_ID, '67646dbb-5e2e-4cd7-aad6-0ab289b068cb');
});
