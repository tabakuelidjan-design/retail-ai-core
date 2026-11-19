// Integration on a disposable PostgreSQL (db/staging-replay/run-services.sh): the report child's two roles and the access-checker role,
// as real LOGIN roles (no superuser, no BYPASSRLS, no SET ROLE), with synthetic data. Skipped unless the three URLs are set.
// URLs are read from the environment only and never printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createScopedClient } from '../src/analytics-premium/server/pg-scoped-client.js';
import { createAccessClient } from '../src/analytics-premium/server/pg-access-client.js';
import { REPORT_READ_TABLES } from '../src/analytics-premium/server/report-db.js';
import { loadDataset } from '../src/metrics/load.js';
import { syncQualityFlags } from '../src/quality/flags.js';
import { createAccessChecker } from '../src/identity/sso-contract.js';

const READ = process.env.ANALYTICS_REPORT_READ_DATABASE_URL;
const WRITE = process.env.ANALYTICS_REPORT_WRITE_DATABASE_URL;
const ACCESS = process.env.ANALYTICS_ACCESS_DATABASE_URL;
const skip = READ && WRITE && ACCESS ? false : 'the three database URLs are not set (run db/staging-replay/run-services.sh)';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const U1 = '11111111-1111-4111-8111-111111111111'; // owner, no verified factor
const U2 = '22222222-2222-4222-8222-222222222222'; // member, verified factor
const U3 = '33333333-3333-4333-8333-333333333333'; // suspended in A
const U4 = '44444444-4444-4444-8444-444444444444'; // not a member at all

const pool = (url) => new pg.Pool({ connectionString: url, max: 2 });
const code = (err) => String(err?.code ?? err?.message ?? err);

test('report reader: the dataset of ONE merchant, the other merchant never appears', { skip, timeout: 30000 }, async () => {
  const p = pool(READ);
  try {
    const readA = createScopedClient({ pool: p, merchantId: A, readable: REPORT_READ_TABLES });
    const dataA = JSON.stringify(await loadDataset(readA, A, { since: new Date('2000-01-01T00:00:00Z') }));
    assert.match(dataA, /Produit A \(fictif\)/);
    assert.doesNotMatch(dataA, /Produit B|Boutique B|Collection B/);
    const readB = createScopedClient({ pool: p, merchantId: B, readable: REPORT_READ_TABLES });
    const dataB = JSON.stringify(await loadDataset(readB, B, { since: new Date('2000-01-01T00:00:00Z') }));
    assert.match(dataB, /Produit B \(fictif\)/);
    assert.doesNotMatch(dataB, /Produit A \(fictif\)/);
  } finally { await p.end(); }
});

test('report reader: no merchant is refused before any SQL, and the database refuses a raw read without context', { skip, timeout: 30000 }, async () => {
  const p = pool(READ);
  try {
    const noMerchant = createScopedClient({ pool: p, merchantId: '', readable: REPORT_READ_TABLES });
    await assert.rejects(() => noMerchant.select('products', { select: 'id' }), { code: 'MERCHANT_REQUIRED' });
    await assert.rejects(() => p.query('select count(*) from public.orders'), /MERCHANT_CONTEXT_REQUIRED/);
  } finally { await p.end(); }
});

test('report reader: SELECT only on its 13 tables; no other table, no write, no delete', { skip, timeout: 30000 }, async () => {
  const p = pool(READ);
  try {
    const reader = createScopedClient({ pool: p, merchantId: A, readable: REPORT_READ_TABLES });
    await assert.rejects(() => reader.select('merchant_members', { select: 'role' }), { code: 'TABLE_NOT_ALLOWED' });
    await assert.rejects(() => reader.select('data_quality_flags', { select: 'id' }), { code: 'TABLE_NOT_ALLOWED' });
    await assert.rejects(() => p.query('select role from public.merchant_members'), (e) => code(e).includes('42501') || /permission denied/.test(e.message));
    await assert.rejects(() => p.query("insert into public.products (merchant_id, title, source_system, source_id) values ($1, 'x', 's', 'y')", [A]), /permission denied/);
    const rows = await reader.select('orders', { select: 'id', merchant_id: `eq.${B}` });
    assert.deepEqual(rows, [], 'a filter on the other merchant returns nothing');
  } finally { await p.end(); }
});

test('report writer: flags are created once, kept, then resolved, for the merchant in context only', { skip, timeout: 30000 }, async () => {
  const p = pool(WRITE);
  try {
    const writer = createScopedClient({ pool: p, merchantId: A, readable: ['data_quality_flags'], writable: ['data_quality_flags'] });
    const flag = { rule_code: 'TEST_RULE', entity_type: 'order', entity_id: '55555555-5555-4555-8555-555555555555', severity: 'warning', details: { n: 1 } };
    const first = await syncQualityFlags({ supabase: writer }, { merchantId: A, detected: [flag], now: new Date() });
    assert.equal(first.created, 1);
    const second = await syncQualityFlags({ supabase: writer }, { merchantId: A, detected: [flag], now: new Date() });
    assert.equal(second.created, 0, 'the same open condition is not duplicated');
    assert.equal(second.alreadyOpen, 1);
    const third = await syncQualityFlags({ supabase: writer }, { merchantId: A, detected: [], now: new Date(), evaluatedRules: ['TEST_RULE'] });
    assert.equal(third.resolved, 1, 'a condition that no longer holds is resolved, not deleted');
    const rows = await writer.select('data_quality_flags', { select: 'status', merchant_id: `eq.${A}`, rule_code: 'eq.TEST_RULE' });
    assert.deepEqual(rows.map((r) => r.status), ['resolved']);
  } finally { await p.end(); }
});

test('report writer: refused on other tables, on delete, and on a row for another merchant', { skip, timeout: 30000 }, async () => {
  const p = pool(WRITE);
  try {
    const writer = createScopedClient({ pool: p, merchantId: A, readable: ['data_quality_flags'], writable: ['data_quality_flags'] });
    await assert.rejects(() => writer.select('orders', { select: 'id' }), { code: 'TABLE_NOT_ALLOWED' });
    await assert.rejects(() => p.query('select id from public.orders'), /permission denied/);
    await assert.rejects(() => p.query('delete from public.data_quality_flags'), /permission denied/);
    await assert.rejects(() => writer.insert('data_quality_flags', [{ merchant_id: B, entity_type: 'order', entity_id: '66666666-6666-4666-8666-666666666666', rule_code: 'X', severity: 'info', status: 'open' }]),
      (e) => /row-level security|42501/.test(`${e.message} ${code(e)}`));
  } finally { await p.end(); }
});

test('access: the person sees only their own membership in the merchant in context; the rest is refused', { skip, timeout: 30000 }, async () => {
  const p = pool(ACCESS);
  try {
    const client = createAccessClient({ pool: p });
    const mine = await client.select('merchant_members', { select: 'role,status,removed_at', merchant_id: `eq.${A}`, user_id: `eq.${U1}`, limit: '1' });
    assert.deepEqual(mine, [{ role: 'OWNER', status: 'ACTIVE', removed_at: null }]);
    assert.deepEqual(await client.select('merchant_members', { select: 'role,status,removed_at', merchant_id: `eq.${A}`, user_id: `eq.${U4}`, limit: '1' }), []);
    await assert.rejects(() => client.select('merchant_members', { select: 'role,email', merchant_id: `eq.${A}`, user_id: `eq.${U1}` }), { code: 'COLUMN_NOT_ALLOWED' });
    await assert.rejects(() => client.select('merchants', { select: 'name', merchant_id: `eq.${A}` }), { code: 'TABLE_NOT_ALLOWED' });
    // raw: with A and U1 in context, another person's membership is invisible
    const c = await p.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.merchant_id', $1, true), set_config('app.user_id', $2, true)", [A, U1]);
      assert.equal((await c.query('select count(*)::int as n from public.merchant_members where user_id = $1', [U2])).rows[0].n, 0);
      await c.query('rollback');
    } finally { c.release(); }
    await assert.rejects(() => p.query("insert into public.merchant_members (merchant_id, user_id, role, status, created_at, updated_at) values ($1, $2, 'OWNER', 'ACTIVE', now(), now())", [A, U4]), /permission denied/);
    await assert.rejects(() => p.query('select count(*) from public.merchant_members'), /CHECKER_CONTEXT_REQUIRED/);
  } finally { await p.end(); }
});

test('access: entitlements of the merchant in context, the MFA status of exactly the pair, and no other function', { skip, timeout: 30000 }, async () => {
  const p = pool(ACCESS);
  try {
    const client = createAccessClient({ pool: p });
    assert.deepEqual(await client.select('module_entitlements', { select: 'merchant_id,module_code,status', merchant_id: `eq.${A}`, module_code: 'eq.analytics' }),
      [{ merchant_id: A, module_code: 'analytics', status: 'ACTIVE' }]);
    assert.deepEqual(await client.rpc('security_mfa_status', { p_merchant: A, p_user: U1 }), { required: true, privileged: true, compliant: false });
    assert.deepEqual(await client.rpc('security_mfa_status', { p_merchant: A, p_user: U2 }), { required: true, privileged: false, compliant: true });
    await assert.rejects(() => client.rpc('fin_next_number', { p_merchant: A }), { code: 'RPC_NOT_ALLOWED' });
    const c = await p.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.merchant_id', $1, true), set_config('app.user_id', $2, true)", [A, U1]);
      await assert.rejects(() => c.query('select analytics_checker.mfa_status($1::uuid, $2::uuid)', [A, U2]), /CHECKER_PAIR_OUT_OF_CONTEXT/);
      await c.query('rollback');
    } finally { c.release(); }
  } finally { await p.end(); }
});

test('access checker: the SSO contract decisions, unchanged, on the least-privilege client', { skip, timeout: 30000 }, async () => {
  const p = pool(ACCESS);
  try {
    const checkAccess = createAccessChecker({ supabase: createAccessClient({ pool: p }), merchantId: A });
    assert.deepEqual(await checkAccess({ merchantId: B, userId: U1, role: 'OWNER', module: 'analytics' }), { ok: false, code: 'SSO_WRONG_MERCHANT' });
    assert.deepEqual(await checkAccess({ merchantId: A, userId: U4, role: 'VIEWER', module: 'analytics' }), { ok: false, code: 'NOT_MEMBER' });
    assert.deepEqual(await checkAccess({ merchantId: A, userId: U3, role: 'VIEWER', module: 'analytics' }), { ok: false, code: 'MEMBER_SUSPENDED' });
    assert.deepEqual(await checkAccess({ merchantId: A, userId: U2, role: 'OWNER', module: 'analytics' }), { ok: false, code: 'ROLE_CHANGED' });
    assert.deepEqual(await checkAccess({ merchantId: A, userId: U1, role: 'OWNER', module: 'analytics' }), { ok: false, code: 'MFA_REQUIRED_FOR_ROLE' });
  } finally { await p.end(); }
});

test('report child end to end: the report and the quality flags are built from the synthetic data with the two report roles only', { skip, timeout: 180000 }, async () => {
  const { runReport } = await import('../src/report/index.js');
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const outDir = mkdtempSync(path.join(tmpdir(), 'nordla-child-'));
  // exactly what the child receives (report-env.js), and no service key anywhere
  const env = {
    PATH: process.env.PATH ?? '', TZ: 'Europe/Brussels', NORDLA_REPORT_CHILD: '1', ANALYTICS_DB_SSL: 'disable', NORDLA_MERCHANT_ID: A, MERCHANT_TIMEZONE: 'Europe/Brussels',
    ANALYTICS_REPORT_READ_DATABASE_URL: READ, ANALYTICS_REPORT_WRITE_DATABASE_URL: WRITE,
  };
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in env, false);
  const quiet = () => {};
  const built = await runReport({ mode: 'report', env, outDir, log: quiet });
  assert.equal(built.merchantId, A);
  assert.ok(built.written.length > 0, 'the report files were written');
  assert.ok(built.written.every((f) => existsSync(path.join(outDir, f))), 'every written file exists in the output folder');
  const flagged = await runReport({ mode: 'flags', env, outDir, log: quiet, now: new Date() });
  assert.equal(flagged.merchantId, A);
  // without the URLs the child must refuse rather than fall back to any key
  await assert.rejects(() => runReport({ mode: 'report', env: { NORDLA_REPORT_CHILD: '1', NORDLA_MERCHANT_ID: A, TZ: 'Europe/Brussels' }, outDir, log: quiet }), { code: 'REPORT_DB_MISSING' });
});
