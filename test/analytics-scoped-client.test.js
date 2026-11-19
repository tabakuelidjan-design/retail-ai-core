// Unit tests (no database) for the scoped report client and the access client: parameter refusals, merchant scope, one connection per call,
// release on every path. The real roles are tested in analytics-services-integration.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedClient } from '../src/analytics-premium/server/pg-scoped-client.js';
import { createAccessClient } from '../src/analytics-premium/server/pg-access-client.js';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const U1 = '11111111-1111-4111-8111-111111111111';

function fakePool(rowsFor = () => []) {
  const log = [];
  const pool = {
    connects: 0, releases: 0,
    async connect() {
      pool.connects += 1;
      return {
        async query(text, params = []) {
          log.push({ text: String(text).trim(), params });
          if (/^select set_config/i.test(String(text).trim())) return { rows: [] };
          if (/^(begin|commit|rollback)$/i.test(String(text).trim())) return { rows: [] };
          return { rows: rowsFor(String(text), params) };
        },
        release() { pool.releases += 1; },
      };
    },
  };
  return { pool, log };
}

test('scoped client: refuses unlisted tables, unsafe identifiers, unknown operators and a missing merchant, before any SQL', async () => {
  const { pool, log } = fakePool();
  const reader = createScopedClient({ pool, merchantId: A, readable: ['orders'] });
  await assert.rejects(() => reader.select('merchant_members', { select: 'role' }), { code: 'TABLE_NOT_ALLOWED' });
  await assert.rejects(() => reader.select('orders', { select: 'id; drop table orders' }), { code: 'FILTER_REFUSED' });
  await assert.rejects(() => reader.select('orders', { id: 'like.%x%' }), { code: 'FILTER_REFUSED' });
  await assert.rejects(() => reader.select('orders', { 'id; --': 'eq.1' }), { code: 'FILTER_REFUSED' });
  await assert.rejects(() => reader.select('orders', { order: 'id; drop table x.asc' }), { code: 'FILTER_REFUSED' });
  await assert.rejects(() => reader.select('orders', { limit: '99999' }), { code: 'FILTER_REFUSED' });
  const none = createScopedClient({ pool, merchantId: '', readable: ['orders'] });
  await assert.rejects(() => none.select('orders', { select: 'id' }), { code: 'MERCHANT_REQUIRED' });
  assert.equal(pool.connects, 0, 'no connection was taken for any refused call');
  assert.equal(log.length, 0);
});

test('scoped client: values are bound parameters, filters are translated, each call uses one connection and releases it', async () => {
  const { pool, log } = fakePool(() => [{ id: 1 }]);
  const reader = createScopedClient({ pool, merchantId: A, readable: ['orders'] });
  const rows = await reader.select('orders', { select: 'id,status', merchant_id: `eq.${A}`, status: 'in.(PAID,REFUNDED)', order: 'ordered_at.desc', limit: '5' });
  assert.deepEqual(rows, [{ id: 1 }]);
  const q = log.find((s) => /from public\.orders/.test(s.text));
  assert.match(q.text, /select "id", "status" from public\.orders where "merchant_id" = \$1 and "status" = any\(\$2\) order by "ordered_at" desc limit 5/);
  assert.deepEqual(q.params, [A, ['PAID', 'REFUNDED']]);
  assert.equal(pool.connects, 1);
  assert.equal(pool.releases, 1);
});

test('scoped client: a failing statement still releases the connection', async () => {
  const pool = {
    connects: 0, releases: 0,
    async connect() {
      pool.connects += 1;
      return {
        async query(text) {
          if (/^select set_config/i.test(String(text).trim())) return { rows: [] };
          if (/^select /i.test(String(text).trim())) throw new Error('boom');
          return { rows: [] };
        },
        release() { pool.releases += 1; },
      };
    },
  };
  const reader = createScopedClient({ pool, merchantId: A, readable: ['orders'] });
  await assert.rejects(() => reader.select('orders', { select: 'id' }), /boom/);
  assert.equal(pool.releases, 1);
});

test('scoped client: writes only to the writable tables, with the same columns in every row of an insert', async () => {
  const { pool } = fakePool((text) => (/returning/.test(text) ? [{ id: 9 }] : []));
  const writer = createScopedClient({ pool, merchantId: A, readable: ['data_quality_flags'], writable: ['data_quality_flags'] });
  await assert.rejects(() => writer.insert('orders', [{ id: 1 }]), { code: 'TABLE_NOT_ALLOWED' });
  await assert.rejects(() => writer.insert('data_quality_flags', [{ a: 1 }, { b: 2 }]), { code: 'FILTER_REFUSED' });
  await assert.rejects(() => writer.update('data_quality_flags', {}, { status: 'resolved' }), { code: 'FILTER_REFUSED' }, 'an update needs a filter');
  assert.deepEqual(await writer.insert('data_quality_flags', [{ rule_code: 'R', severity: 'info' }]), [{ id: 9 }]);
});

test('access client: only the two tables and the MFA function, only the listed columns, and the person and merchant are required', async () => {
  const { pool } = fakePool(() => []);
  const client = createAccessClient({ pool });
  await assert.rejects(() => client.select('merchants', { select: 'name', merchant_id: `eq.${A}` }), { code: 'TABLE_NOT_ALLOWED' });
  await assert.rejects(() => client.select('merchant_members', { select: 'email', merchant_id: `eq.${A}`, user_id: `eq.${U1}` }), { code: 'COLUMN_NOT_ALLOWED' });
  await assert.rejects(() => client.select('merchant_members', { select: 'role', merchant_id: `eq.${A}` }), { code: 'FILTER_REFUSED' });
  await assert.rejects(() => client.select('module_entitlements', { select: 'status', merchant_id: 'eq.not-a-uuid', module_code: 'eq.analytics' }), { code: 'MERCHANT_REQUIRED' });
  await assert.rejects(() => client.rpc('fin_next_number', { p_merchant: A }), { code: 'RPC_NOT_ALLOWED' });
  await assert.rejects(() => client.rpc('security_mfa_status', { p_merchant: A, p_user: 'nope' }), { code: 'USER_REQUIRED' });
});
