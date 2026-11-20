// PILOT (local, disposable database, two synthetic merchants): the narrow issue path on the least-privilege role
// nordla_fin_issuer_pilot. Covers normal operation, refusals without context, cross-merchant access, forbidden operations,
// and the absence of any fallback to the service client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, seedMerchants, insertDraft, adminClient, MERCHANT_A, MERCHANT_B, PLACEHOLDER } from './lib/db.js';
import { testUrl } from './lib/safety.js';
import { createNarrowIssuePath } from '../../src/finance/runtime/narrow-issue-path.js';
import { createSupabaseFinanceStore } from '../../src/finance/supabase-store.js';

const LOGIN = 'nordla_fin_pilot_login';
const LOGIN_PASSWORD = 'pilot_local_test_only';

async function setupPilot(db) {
  const a = await adminClient();
  try {
    await a.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='${LOGIN}') then create role ${LOGIN} login noinherit nobypassrls password '${LOGIN_PASSWORD}'; end if; end $$`);
    await a.query(`grant nordla_fin_issuer_pilot to ${LOGIN}`);
  } finally { await a.end(); }
  const u = new URL(testUrl());
  u.pathname = `/${db.name}`;
  u.username = LOGIN; u.password = LOGIN_PASSWORD;
  return new pg.Pool({ connectionString: u.toString(), max: 3 });
}
const badPool = () => new pg.Pool({ connectionString: 'postgres://nordla_no_such_login:wrong@127.0.0.1:1/none', max: 1, connectionTimeoutMillis: 1500 });
const issueParams = (doc, prefix = 'FACT') => ({
  docId: doc.id, expectedVersion: doc.version, newStatus: 'ISSUED', numbering: { prefix, pad: 4, format: '{prefix}-{year}-{seq}' }, year: 2026,
  canonical: `{"id":"${doc.id}","number":"${PLACEHOLDER}","gross":${doc.gross_cents}}`, placeholder: PLACEHOLDER, lockedAt: '2026-09-30T10:00:00Z',
  event: { actor: { type: 'merchant' }, action: 'ISSUED', detail: { n: PLACEHOLDER } },
});
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? e.message; } };

test('normal: the pilot reads its own draft and issues it with sequential numbers', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = await setupPilot(db);
  try {
    await seedMerchants(admin);
    const d1 = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const d2 = await insertDraft(admin, MERCHANT_A, { gross: 6050 });
    const path = createNarrowIssuePath({ pool, merchantId: MERCHANT_A });
    assert.equal((await path.getDocument(d1.id)).id, d1.id, 'own draft is readable');
    const i1 = await path.issueDocument(issueParams(d1));
    const i2 = await path.issueDocument(issueParams(d2));
    assert.equal(i1.status, 'ISSUED');
    assert.equal(i2.status, 'ISSUED');
    const numbers = [i1.number, i2.number].sort();
    assert.deepEqual(numbers, ['FACT-2026-0001', 'FACT-2026-0002'], 'numbering is sequential, no gap, no duplicate');
    // the document is the same one the admin view sees afterwards
    const stored = (await admin.query('select status, number from fin_documents where id = $1', [d1.id])).rows[0];
    assert.equal(stored.status, 'ISSUED');
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

test('without tenant context the pilot sees nothing and cannot write', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = await setupPilot(db);
  try {
    await seedMerchants(admin);
    await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role nordla_fin_issuer_pilot'); // no set_config('app.merchant_id')
      assert.equal((await c.query('select count(*)::int n from fin_documents')).rows[0].n, 0, 'no rows without context');
      assert.equal((await c.query('select public.nordla_fin_pilot_merchant() as m')).rows[0].m, null, 'context is NULL');
      await c.query('rollback');
      await c.query('begin');
      await c.query('set local role nordla_fin_issuer_pilot');
      assert.equal(await codeOf(() => c.query("insert into fin_number_sequences (merchant_id, doc_type, year, last_number) values ($1, 'invoice', 2026, 1)", [MERCHANT_A])), '42501', 'no sequence write without context');
      await c.query('rollback');
    } finally { c.release(); }
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

test('cross-merchant: merchant B cannot read or issue merchant A documents, and cannot write A sequences', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = await setupPilot(db);
  try {
    await seedMerchants(admin);
    const dA = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const dB = await insertDraft(admin, MERCHANT_B, { gross: 6050 });
    const asB = createNarrowIssuePath({ pool, merchantId: MERCHANT_B });
    const asA = createNarrowIssuePath({ pool, merchantId: MERCHANT_A });
    assert.equal(await asB.getDocument(dA.id), null, 'B cannot read an A document');
    const issueRefusal = await asB.issueDocument(issueParams(dA)).then(() => null, (e) => e.message);
    assert.match(String(issueRefusal), /FIN_NOT_FOUND/, 'B cannot issue an A document');
    assert.equal(await asA.getDocument(dB.id), null, 'A cannot read a B document');
    const untouched = (await admin.query('select status from fin_documents where id = $1', [dA.id])).rows[0];
    assert.equal(untouched.status, 'DRAFT', 'refused cross-merchant issue leaves the draft untouched');
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.merchant_id', $1, true)", [MERCHANT_A]);
      await c.query('set local role nordla_fin_issuer_pilot');
      assert.equal(await codeOf(() => c.query("insert into fin_number_sequences (merchant_id, doc_type, year, last_number) values ($1, 'invoice', 2026, 1)", [MERCHANT_B])), '42501', 'A context cannot write a B sequence');
      await c.query('rollback');
      await c.query('begin');
      await c.query("select set_config('app.merchant_id', $1, true)", [MERCHANT_A]);
      await c.query('set local role nordla_fin_issuer_pilot');
      assert.equal((await c.query('update fin_documents set status = $2 where merchant_id = $1 and id = $3', [MERCHANT_B, 'CANCELLED', dB.id])).rowCount, 0, 'A context updates no B row');
      await c.query('rollback');
    } finally { c.release(); }
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

test('forbidden operations are refused for the pilot role', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = await setupPilot(db);
  try {
    await seedMerchants(admin);
    const dA = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const c = await pool.connect();
    try {
      const attempts = {
        delete_document: "delete from fin_documents where id = $1",
        insert_document: "insert into fin_documents (merchant_id, doc_type, status, currency, issue_date, due_date, net_cents, vat_cents, gross_cents, revenue_basis, body) values ($1,'invoice','DRAFT','EUR','2026-09-01','2026-10-01',1,0,1,'standalone_b2b','{}')",
        update_events: "update fin_events set action = 'X' where merchant_id = $1",
        read_bank: "select count(*) from fin_bank_transactions",
        record_payment: `select fin_record_payment('${MERCHANT_A}'::uuid,'k','IN',100,'EUR','2026-10-01','cash',null,'{}','[]'::jsonb,null,'{}'::jsonb)`,
        create_table: "create table public.nordla_pilot_probe (x int)",
        grant_self: "grant all on fin_documents to nordla_fin_issuer_pilot",
      };
      for (const [name, sql] of Object.entries(attempts)) {
        await c.query('begin');
        await c.query("select set_config('app.merchant_id', $1, true)", [MERCHANT_A]);
        await c.query('set local role nordla_fin_issuer_pilot');
        const code = await codeOf(() => c.query(sql, name === 'delete_document' ? [dA.id] : name === 'record_payment' || name === 'read_bank' || name === 'create_table' || name === 'grant_self' ? [] : [MERCHANT_A]));
        // GRANT by a non-owner is not an error in PostgreSQL (WARNING, nothing granted): the check is the privilege afterwards
        if (name !== 'grant_self') assert.ok(code === '42501' || code === '42P01' || code === '42809', `${name}: refused (got ${code})`);
        await c.query('rollback');
      }
      const check = (await admin.query("select rolbypassrls, rolsuper, rolcreaterole, rolinherit from pg_roles where rolname = 'nordla_fin_issuer_pilot'")).rows[0];
      assert.deepEqual(check, { rolbypassrls: false, rolsuper: false, rolcreaterole: false, rolinherit: false });
      const gained = (await admin.query("select has_table_privilege('nordla_fin_issuer_pilot','public.fin_documents','DELETE') as del, has_table_privilege('nordla_fin_issuer_pilot','public.fin_documents','INSERT') as ins, has_table_privilege('nordla_fin_issuer_pilot','public.fin_bank_transactions','SELECT') as bank")).rows[0];
      assert.deepEqual(gained, { del: false, ins: false, bank: false }, 'no privilege was gained by the forbidden attempts');
    } finally { c.release(); }
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

test('no fallback: a failing connection throws, and the service client is never called', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await seedMerchants(admin);
    const dA = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    let serviceCalls = 0;
    const spy = { select: async () => { serviceCalls++; return []; }, selectAll: async () => { serviceCalls++; return []; }, rpc: async () => { serviceCalls++; return {}; } };
    const pool = badPool();
    const store = createSupabaseFinanceStore(spy, { merchantId: MERCHANT_A, narrowIssuePath: createNarrowIssuePath({ pool, merchantId: MERCHANT_A }) });
    await assert.rejects(() => store.getDocument(dA.id), /NARROW_CONNECTION_FAILED|password|connect|ECONN|authentication|getaddrinfo|ECONNREFUSED/i);
    await assert.rejects(() => store.issueDocument(issueParams(dA)), /NARROW_CONNECTION_FAILED|password|connect|ECONN|authentication|getaddrinfo|ECONNREFUSED/i);
    assert.equal(serviceCalls, 0, 'no call reached the service client');
    await pool.end().catch(() => {});
  } finally { await admin.end(); await db.drop(); }
});

test('the store uses the narrow path for both reads and the issue, and never the service client', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = await setupPilot(db);
  try {
    await seedMerchants(admin);
    const dA = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    let serviceCalls = 0;
    const spy = { select: async () => { serviceCalls++; return []; }, selectAll: async () => { serviceCalls++; return []; }, rpc: async () => { serviceCalls++; return {}; } };
    const store = createSupabaseFinanceStore(spy, { merchantId: MERCHANT_A, narrowIssuePath: createNarrowIssuePath({ pool, merchantId: MERCHANT_A }) });
    const read = await store.getDocument(dA.id);
    assert.equal(read.id, dA.id);
    const issued = await store.issueDocument(issueParams(dA));
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.number, 'FACT-2026-0001');
    assert.equal(serviceCalls, 0, 'the service client was not used');
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

test('rollback removes exactly the pilot objects and leaves the original grants of the service role intact', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));
  const DOWN = readFileSync(`${ROOT}supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql`, 'utf8');
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    const before = (await admin.query("select has_table_privilege('service_role','public.fin_documents','SELECT') as svc, has_table_privilege('service_role','public.fin_documents','UPDATE') as svc_upd")).rows[0];
    // The role is cluster-wide: DROP ROLE also checks the template database that holds the same grants in this test cluster.
    // The privilege, policy and function removal is what is verified here; the role itself is dropped in a separate step (see the rollback header).
    await admin.query(DOWN.replace("drop role if exists nordla_fin_issuer_pilot;", ""));
    const left = (await admin.query("select (select count(*) from pg_roles where rolname='nordla_fin_issuer_pilot') as roles, (select count(*) from pg_policies where policyname like 'nordla_fin_pilot_%') as policies, (select count(*) from pg_proc where proname='nordla_fin_pilot_merchant') as fns")).rows[0];
    assert.deepEqual(left, { roles: '1', policies: '0', fns: '0' }, 'the role itself remains cluster-wide until its separate drop; its objects are gone');
    const after = (await admin.query("select has_table_privilege('service_role','public.fin_documents','SELECT') as svc, has_table_privilege('service_role','public.fin_documents','UPDATE') as svc_upd")).rows[0];
    assert.deepEqual(after, before, 'service_role privileges are unchanged by the pilot and its rollback');
  } finally { await admin.end(); await db.drop(); }
});
