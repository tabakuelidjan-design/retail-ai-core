// Phase 3 pilot - the Analytics read path, unit level: one transaction per read on one pooled connection, context set with
// set_config(..., true), read only, no context refused, rollback on error, connection ALWAYS released, no fallback key.
// Fake pool/client here; the real role and the real database are tested in analytics-pg-integration.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantReader, inMerchantTransaction, TenantReadError } from '../src/analytics-premium/server/pg-tenant-reader.js';
import { PG_ROUTED_TABLES, createPgSelect, routedSupabase } from '../src/analytics-premium/server/pg-table-select.js';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** A fake client: records every statement, returns queued rows, can fail on a given SELECT. */
function fakeClient({ rows = [], failOn = null } = {}) {
  const log = [];
  return {
    log,
    query: async (text, params = []) => {
      log.push({ text: String(text).trim(), params });
      if (failOn && String(text).includes(failOn)) throw new Error('boom');
      if (/^select set_config/i.test(String(text).trim())) return { rows: [] };
      return { rows: typeof rows === 'function' ? rows(text, params) : rows };
    },
    release() { this.released = (this.released ?? 0) + 1; },
  };
}

/** A fake pool that hands out the same client (as a pool with one connection would) and counts connects. */
function fakePool(client) {
  const pool = { connects: 0, connect: async () => { pool.connects += 1; return client; } };
  return pool;
}

test('every read runs in its own transaction on one connection: begin, set the merchant (transaction-local), query, commit, release', async () => {
  const c = fakeClient({ rows: [{ id: A, name: 'Pilote A (fictif)', vertical: 'general_retail' }] });
  const r = await createTenantReader({ pool: fakePool(c) }).merchantById(A);
  assert.deepEqual(r, { id: A, name: 'Pilote A (fictif)', vertical: 'general_retail' });
  assert.deepEqual(c.log.map((s) => s.text.split(' ')[0]), ['begin', 'select', 'select', 'commit']);
  assert.match(c.log[1].text, /^select set_config\('app\.merchant_id', \$1, true\)$/, 'the third argument true makes the setting transaction-local');
  assert.deepEqual(c.log[1].params, [A]);
  assert.equal(c.released, 1, 'the connection is released after a successful read');
});

test('a missing or non-UUID merchant is refused before any connection is taken or any SQL runs', async () => {
  const c = fakeClient();
  const pool = fakePool(c);
  await assert.rejects(() => createTenantReader({ pool }).connectorsOf(''), { code: 'MERCHANT_REQUIRED' });
  await assert.rejects(() => createTenantReader({ pool }).latestSyncRows("'; drop table sync_runs; --"), { code: 'MERCHANT_REQUIRED' });
  assert.equal(pool.connects, 0);
  assert.equal(c.log.length, 0);
});

test('a failing query rolls back, re-throws, and still releases the connection', async () => {
  const c = fakeClient({ failOn: 'sync_runs' });
  await assert.rejects(() => createTenantReader({ pool: fakePool(c) }).latestSyncRows(A), /boom/);
  assert.equal(c.log.at(-1).text, 'rollback', 'the transaction is rolled back');
  assert.equal(c.log.some((s) => s.text === 'commit'), false, 'nothing is committed after a failure');
  assert.equal(c.released, 1, 'released even on error');
});

test('a failing BEGIN still releases the connection', async () => {
  const c = fakeClient();
  c.query = async () => { throw new Error('connection lost'); };
  await assert.rejects(() => inMerchantTransaction(fakePool(c), A, async () => 1), /connection lost/);
  assert.equal(c.released, 1);
});

test('the reader runs SELECT only: any other statement is refused and never reaches the connection', async () => {
  const c = fakeClient();
  await assert.rejects(() => inMerchantTransaction(fakePool(c), A, async (tx) => tx.query('insert into analytics_pilot.sync_runs (merchant_id, mode, status) values ($1, $2, $3)', [A, 'x', 'SUCCESS'])), { code: 'READ_ONLY' });
  assert.equal(c.log.some((s) => /insert/i.test(s.text)), false);
});

test('two merchants on the same connection: each transaction sets its own merchant, nothing carries over', async () => {
  const c = fakeClient({ rows: (text) => (/merchant_connectors/.test(text) ? [{ id: 'x', merchant_id: B, kind: 'shopify' }] : []) });
  const reader = createTenantReader({ pool: fakePool(c) });
  await reader.connectorsOf(B);
  await reader.latestSyncRows(A);
  const sets = c.log.filter((s) => s.text.startsWith('select set_config'));
  assert.deepEqual(sets.map((s) => s.params[0]), [B, A]);
  assert.equal(c.log.filter((s) => s.text === 'begin').length, 2);
  assert.equal(c.log.filter((s) => s.text === 'commit').length, 2);
  assert.equal(c.released, 2);
});

test('the schema name is a fixed identifier only; anything else is refused before any SQL', () => {
  assert.throws(() => createTenantReader({ pool: fakePool(fakeClient()), schema: 'public; drop table x' }), TypeError);
  assert.doesNotThrow(() => createTenantReader({ pool: fakePool(fakeClient()), schema: 'analytics_pilot' }));
});

test('the reads name the three tables of the inventory, and no other', async () => {
  const c = fakeClient();
  const reader = createTenantReader({ pool: fakePool(c) });
  await reader.merchantById(A); await reader.connectorsOf(A); await reader.latestSyncRows(A);
  const tables = new Set(c.log.flatMap((s) => [...s.text.matchAll(/from (\w+)\.(\w+)/g)].map((m) => m[2])));
  assert.deepEqual([...tables].sort(), ['merchant_connectors', 'merchants', 'sync_runs']);
});

test('the error of a refused read is a TenantReadError with a stable code', async () => {
  try { await createTenantReader({ pool: fakePool(fakeClient()) }).merchantById('nope'); assert.fail('should refuse'); }
  catch (e) { assert.ok(e instanceof TenantReadError); assert.equal(e.code, 'MERCHANT_REQUIRED'); }
});

test('routing: with the pilot on, the three tables never reach the Supabase client, and an error does not fall back to it', async () => {
  const calls = [];
  const supabase = { select: async (table) => { calls.push(table); return [{ from: 'supabase' }]; }, insert: async () => 'untouched' };
  const failing = createPgSelect({ merchantById: async () => { throw new Error('pool down'); }, connectorsOf: async () => [], latestSyncRows: async () => [] });
  const routed = routedSupabase(supabase, failing);
  await assert.rejects(() => routed.select('merchants', { id: `eq.${A}` }), /pool down/);
  assert.deepEqual(calls, [], 'no fallback to the service key for a routed table');
  assert.equal(routed.insert, supabase.insert, 'other methods stay on the original client');
  assert.deepEqual([...PG_ROUTED_TABLES].sort(), ['merchant_connectors', 'merchants', 'sync_runs']);
});

test('routing: other tables still use the Supabase client', async () => {
  const calls = [];
  const supabase = { select: async (table) => { calls.push(table); return []; } };
  const routed = routedSupabase(supabase, createPgSelect({ merchantById: async () => null, connectorsOf: async () => [], latestSyncRows: async () => [] }));
  await routed.select('merchant_members', { user_id: 'eq.x' });
  assert.deepEqual(calls, ['merchant_members']);
});
