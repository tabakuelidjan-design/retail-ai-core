// Phase 3 pilot - INTEGRATION against a real PostgreSQL (disposable container, db/pilot/run-node-integration.sh).
// Runs only when ANALYTICS_DATABASE_URL points at the pilot database as the LOGIN role analytics_reader (not a superuser, no BYPASSRLS).
// The URL is read from the environment only and is never printed. Without it, every test is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTenantReader, inMerchantTransaction } from '../src/analytics-premium/server/pg-tenant-reader.js';
import { createPgSelect } from '../src/analytics-premium/server/pg-table-select.js';

const URL_ = process.env.ANALYTICS_DATABASE_URL;
const skip = URL_ ? false : 'ANALYTICS_DATABASE_URL not set (run db/pilot/run-node-integration.sh)';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a'; // fictitious merchant: one SUCCESS sync, no connector
const B = 'bbbbbbbb-0000-4000-8000-00000000000b'; // fictitious merchant: one shopify connector, one FAILED sync

/** A pool of `max` connections that counts every connection it hands out. */
function countingPool(max = 1) {
  const pool = new pg.Pool({ connectionString: URL_, max, connectionTimeoutMillis: 5000 });
  let taken = 0;
  const connect = pool.connect.bind(pool);
  pool.connect = async () => { taken += 1; return connect(); };
  return { pool, taken: () => taken };
}

test('the connection is the real LOGIN role: not a superuser, no BYPASSRLS, no SET ROLE', { skip, timeout: 15000 }, async () => {
  const { pool } = countingPool();
  const c = await pool.connect();
  try {
    const r = (await c.query('select current_user as u, session_user as s, rolsuper, rolbypassrls from pg_roles where rolname = current_user')).rows[0];
    assert.equal(r.u, 'analytics_reader');
    assert.equal(r.s, 'analytics_reader', 'no SET ROLE: the session user is the login role');
    assert.equal(r.rolsuper, false);
    assert.equal(r.rolbypassrls, false);
  } finally { c.release(); await pool.end(); }
});

test('without a merchant in context, the policies show no rows at all', { skip, timeout: 15000 }, async () => {
  const { pool } = countingPool();
  const c = await pool.connect();
  try {
    await c.query('begin');
    const counts = (await c.query(`select (select count(*) from analytics_pilot.merchants) as m,
      (select count(*) from analytics_pilot.merchant_connectors) as c, (select count(*) from analytics_pilot.sync_runs) as s`)).rows[0];
    await c.query('commit');
    assert.deepEqual({ m: Number(counts.m), c: Number(counts.c), s: Number(counts.s) }, { m: 0, c: 0, s: 0 });
  } finally { c.release(); await pool.end(); }
});

test('a missing or invalid merchant id is refused before any connection is taken', { skip, timeout: 15000 }, async () => {
  const { pool, taken } = countingPool();
  try {
    const reader = createTenantReader({ pool });
    for (const bad of ['', 'nope', "'; drop table analytics_pilot.sync_runs; --", undefined]) {
      await assert.rejects(() => reader.latestSyncRows(bad), { code: 'MERCHANT_REQUIRED' });
    }
    assert.equal(taken(), 0, 'no connection was taken for an invalid id');
  } finally { await pool.end(); }
});

test('two merchants: each read sees only its own rows', { skip, timeout: 15000 }, async () => {
  const { pool } = countingPool();
  try {
    const reader = createTenantReader({ pool });
    assert.equal((await reader.merchantById(A)).name, 'Pilote A (fictif)');
    assert.deepEqual(await reader.connectorsOf(A), []);
    const bConnectors = await reader.connectorsOf(B);
    assert.equal(bConnectors.length, 1);
    assert.equal(bConnectors[0].kind, 'shopify');
    const aSync = await reader.latestSyncRows(A);
    assert.deepEqual(aSync.map((r) => r.status), ['SUCCESS']);
    const bSync = await reader.latestSyncRows(B);
    assert.deepEqual(bSync.map((r) => r.status), ['FAILED']);
  } finally { await pool.end(); }
});

test('the reader cannot write: refused by the application layer and by the database itself', { skip, timeout: 15000 }, async () => {
  const { pool } = countingPool();
  try {
    await assert.rejects(() => inMerchantTransaction(pool, A, (tx) => tx.query('insert into analytics_pilot.sync_runs (merchant_id, mode, status) values ($1, $2, $3)', [A, 'x', 'SUCCESS'])), { code: 'READ_ONLY' });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await assert.rejects(() => c.query('insert into analytics_pilot.sync_runs (merchant_id, mode, status) values ($1, $2, $3)', [A, 'x', 'SUCCESS']), { code: '42501' });
      await c.query('rollback');
    } finally { c.release(); }
  } finally { await pool.end(); }
});

test('a failing read rolls back and leaves no merchant behind; the connection is released and reusable', { skip, timeout: 15000 }, async () => {
  const { pool } = countingPool(1); // ONE connection: if it were not released, the next read would hang and time out
  try {
    await assert.rejects(() => inMerchantTransaction(pool, A, async (tx) => { await tx.query('select 1'); throw new Error('boom'); }), /boom/);
    const c = await pool.connect();
    try {
      const v = (await c.query("select current_setting('app.merchant_id', true) as v")).rows[0].v;
      assert.ok(!v, 'the merchant setting does not survive the rollback');
    } finally { c.release(); }
    assert.equal((await createTenantReader({ pool }).latestSyncRows(A)).length, 1);
  } finally { await pool.end(); }
});

test('connection reuse: consecutive reads on the same connection each carry their own merchant', { skip, timeout: 15000 }, async () => {
  const { pool, taken } = countingPool(1);
  try {
    const reader = createTenantReader({ pool });
    assert.equal((await reader.connectorsOf(B)).length, 1);
    assert.equal((await reader.latestSyncRows(A)).length, 1);
    assert.equal((await reader.latestSyncRows(B))[0].status, 'FAILED');
    assert.equal(taken(), 3, 'three transactions');
    assert.equal(pool.totalCount, 1, 'all three ran on one pooled connection');
  } finally { await pool.end(); }
});

test('the routed select (the Analytics callers) returns the same rows, and refuses what is not routed', { skip, timeout: 15000 }, async () => {
  const { pool } = countingPool();
  try {
    const select = createPgSelect(createTenantReader({ pool }));
    assert.equal((await select('merchants', { select: 'id,name,vertical', id: `eq.${A}`, limit: '1' })).length, 1);
    assert.equal((await select('merchant_connectors', { select: '*', merchant_id: `eq.${B}`, order: 'created_at.asc' })).length, 1);
    assert.equal((await select('sync_runs', { select: 'x', merchant_id: `eq.${B}`, order: 'started_at.desc', limit: '50' }))[0].status, 'FAILED');
    await assert.rejects(() => select('sync_runs', { merchant_id: `eq.${B}` }), { code: 'FILTER_REFUSED' });
    await assert.rejects(() => select('merchants', { id: 'eq.not-a-uuid' }), { code: 'FILTER_REFUSED' });
    await assert.rejects(() => select('users', {}), { code: 'TABLE_NOT_ROUTED' });
  } finally { await pool.end(); }
});
