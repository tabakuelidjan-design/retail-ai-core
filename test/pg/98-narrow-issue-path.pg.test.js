// PILOT v2 (local, disposable database, two synthetic merchants, REAL distinct LOGIN roles).
// Functional path on the least-privilege role nordla_fin_issuer_pilot, identity taken from session_user.
// Identity refusals and privileged logins are in 99-narrow-identity.pg.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { freshDatabase, seedMerchants, insertDraft, adminClient, MERCHANT_A, MERCHANT_B, PLACEHOLDER } from './lib/db.js';
import { testUrl } from './lib/safety.js';
import { createNarrowIssuePath } from '../../src/finance/runtime/narrow-issue-path.js';
import { createSupabaseFinanceStore } from '../../src/finance/supabase-store.js';
import { LOGIN_A, LOGIN_B, setupLogins, poolFor } from './lib/pilot.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const issueParams = (doc, prefix = 'FACT') => ({
  docId: doc.id, expectedVersion: doc.version, newStatus: 'ISSUED', numbering: { prefix, pad: 4, format: '{prefix}-{year}-{seq}' }, year: 2026,
  canonical: `{"id":"${doc.id}","number":"${PLACEHOLDER}","gross":${doc.gross_cents}}`, placeholder: PLACEHOLDER, lockedAt: '2026-09-30T10:00:00Z',
  event: { actor: { type: 'merchant' }, action: 'ISSUED', detail: { n: PLACEHOLDER } },
});
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? e.message; } };
const msgOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

test('normal: each login issues its own invoices with sequential numbers, and cannot touch the other merchant', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    const dA1 = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const dA2 = await insertDraft(admin, MERCHANT_A, { gross: 6050 });
    const dB = await insertDraft(admin, MERCHANT_B, { gross: 3000 });
    const poolA = poolFor(db, LOGIN_A); const poolB = poolFor(db, LOGIN_B);
    try {
      const asA = createNarrowIssuePath({ pool: poolA, merchantId: MERCHANT_A });
      const asB = createNarrowIssuePath({ pool: poolB, merchantId: MERCHANT_B });
      assert.equal((await asA.getDocument(dA1.id)).id, dA1.id, 'A reads its own draft');
      assert.equal(await asA.getDocument(dB.id), null, 'A cannot read B');
      assert.equal(await asB.getDocument(dA1.id), null, 'B cannot read A');
      assert.match(String(await msgOf(() => asB.issueDocument(issueParams(dA1)))), /FIN_NOT_FOUND/, 'B cannot issue an A document');
      const i1 = await asA.issueDocument(issueParams(dA1));
      const i2 = await asA.issueDocument(issueParams(dA2));
      assert.deepEqual([i1.number, i2.number].sort(), ['FACT-2026-0001', 'FACT-2026-0002']);
      const iB = await asB.issueDocument(issueParams(dB, 'FB'));
      assert.equal(iB.number, 'FB-2026-0001', 'B has its own sequence');
    } finally { await poolA.end(); await poolB.end(); }
  } finally { await admin.end(); await db.drop(); }
});

test('no context, pooled connection reuse: no privilege without the pilot role; absent context gives the bound merchant only; a foreign context is refused', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    await insertDraft(admin, MERCHANT_B, { gross: 6050 });
    const pool = poolFor(db, LOGIN_A, { max: 1 }); // one physical connection reused by every call
    try {
      const c = await pool.connect();
      try {
        assert.equal(await codeOf(() => c.query('select count(*) from fin_documents')), '42501', 'login without the pilot role has no table privilege');
        await c.query('set role nordla_fin_issuer_pilot');
        assert.equal((await c.query('select count(*)::int n from fin_documents')).rows[0].n, 1, 'absent context: only the bound merchant (A)');
        await c.query('reset role');
        await c.query("set app.merchant_id = '" + MERCHANT_B + "'"); // a foreign context left on the pooled connection
        await c.query('set role nordla_fin_issuer_pilot');
        assert.match(String(await msgOf(() => c.query('select count(*) from fin_documents'))), /FIN_PILOT_CONTEXT_FORBIDDEN/, 'a foreign context is refused, not widened');
        await c.query('reset role');
        await c.query('reset app.merchant_id');
      } finally { c.release(); }
      const asA = createNarrowIssuePath({ pool, merchantId: MERCHANT_A });
      const dA = (await admin.query('select id from fin_documents where merchant_id = $1', [MERCHANT_A])).rows[0];
      assert.equal((await asA.getDocument(dA.id)).merchant_id, MERCHANT_A, 'after the foreign setting is cleared, the adapter works for A');
    } finally { await pool.end(); }
  } finally { await admin.end(); await db.drop(); }
});

test('SET ROLE and RESET ROLE do not widen the login', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = poolFor(db, LOGIN_A);
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const c = await pool.connect();
    try {
      assert.equal(await codeOf(() => c.query('set role service_role')), '42501', 'A cannot take service_role');
      assert.equal(await codeOf(() => c.query('set role postgres')), '42501', 'A cannot take postgres');
      await c.query('set role nordla_fin_issuer_pilot');
      assert.equal(await codeOf(() => c.query('set role service_role')), '42501', 'from the pilot role, A still cannot take service_role');
      await c.query('reset role');
      assert.equal(await codeOf(() => c.query('select count(*) from fin_documents')), '42501', 'after reset: no privilege again');
      const who = (await c.query('select session_user::text as su')).rows[0];
      assert.equal(who.su, LOGIN_A, 'session identity unchanged');
    } finally { c.release(); }
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

test('an extra permissive policy does not bypass the restrictive guard', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = poolFor(db, LOGIN_A);
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    await insertDraft(admin, MERCHANT_B, { gross: 6050 });
    await admin.query("create policy zz_open_for_pilot on public.fin_documents as permissive for select to nordla_fin_issuer_pilot using (true)");
    const c = await pool.connect();
    try {
      await c.query('set role nordla_fin_issuer_pilot');
      assert.equal((await c.query('select count(*)::int n from fin_documents')).rows[0].n, 1, 'still only the bound merchant (A), not B');
      await c.query('reset role');
    } finally { c.release(); }
    await admin.query('drop policy zz_open_for_pilot on public.fin_documents');
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

test('forbidden operations are refused for the pilot, through a real login', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = poolFor(db, LOGIN_A);
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    const dA = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const c = await pool.connect();
    try {
      const attempts = {
        delete_document: ['delete from fin_documents where id = $1', [dA.id]],
        insert_document: ["insert into fin_documents (merchant_id, doc_type, status, currency, issue_date, due_date, net_cents, vat_cents, gross_cents, revenue_basis, body) values ($1,'invoice','DRAFT','EUR','2026-09-01','2026-10-01',1,0,1,'standalone_b2b','{}')", [MERCHANT_A]],
        update_events: ["update fin_events set action = 'X' where merchant_id = $1", [MERCHANT_A]],
        read_bank: ['select count(*) from fin_bank_transactions', []],
        record_payment: [`select fin_record_payment('${MERCHANT_A}'::uuid,'k','IN',100,'EUR','2026-10-01','cash',null,'{}','[]'::jsonb,null,'{}'::jsonb)`, []],
        create_table: ['create table public.nordla_pilot_probe (x int)', []],
        grant_self: ['grant all on fin_documents to nordla_fin_issuer_pilot', []],
      };
      for (const [name, [sql, params]] of Object.entries(attempts)) {
        await c.query('begin');
        await c.query('set role nordla_fin_issuer_pilot');
        const code = await codeOf(() => c.query(sql, params));
        // GRANT by a non-owner is not an error in PostgreSQL (WARNING, nothing granted): checked by privilege below
        if (name !== 'grant_self') assert.ok(code === '42501' || code === '42P01', `${name}: refused (got ${code})`);
        await c.query('rollback');
      }
      const gained = (await admin.query("select has_table_privilege('nordla_fin_issuer_pilot','public.fin_documents','DELETE') as del, has_table_privilege('nordla_fin_issuer_pilot','public.fin_documents','INSERT') as ins, has_table_privilege('nordla_fin_issuer_pilot','public.fin_bank_transactions','SELECT') as bank")).rows[0];
      assert.deepEqual(gained, { del: false, ins: false, bank: false }, 'no privilege was gained');
    } finally { c.release(); }
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

test('no fallback: a failing connection throws, and the service client is never called', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    const dA = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    let serviceCalls = 0;
    const spy = { select: async () => { serviceCalls++; return []; }, selectAll: async () => { serviceCalls++; return []; }, rpc: async () => { serviceCalls++; return {}; } };
    const bad = new pg.Pool({ connectionString: 'postgres://nordla_no_such_login:wrong@127.0.0.1:1/none', max: 1, connectionTimeoutMillis: 1500 });
    const store = createSupabaseFinanceStore(spy, { merchantId: MERCHANT_A, narrowIssuePath: createNarrowIssuePath({ pool: bad, merchantId: MERCHANT_A }) });
    await assert.rejects(() => store.getDocument(dA.id));
    await assert.rejects(() => store.issueDocument(issueParams(dA)));
    assert.equal(serviceCalls, 0, 'no call reached the service client');
    await bad.end().catch(() => {});
  } finally { await admin.end(); await db.drop(); }
});

test('the store uses the narrow path for the read and the issue, never the service client', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = poolFor(db, LOGIN_A);
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    const dA = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    let serviceCalls = 0;
    const spy = { select: async () => { serviceCalls++; return []; }, selectAll: async () => { serviceCalls++; return []; }, rpc: async () => { serviceCalls++; return {}; } };
    const store = createSupabaseFinanceStore(spy, { merchantId: MERCHANT_A, narrowIssuePath: createNarrowIssuePath({ pool, merchantId: MERCHANT_A }) });
    assert.equal((await store.getDocument(dA.id)).id, dA.id);
    const issued = await store.issueDocument(issueParams(dA));
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.number, 'FACT-2026-0001');
    assert.equal(serviceCalls, 0, 'the service client was not used');
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

test('rollback removes the pilot objects (policies, functions, binding table, grants); service_role privileges unchanged', async () => {
  const DOWN = readFileSync(`${ROOT}supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql`, 'utf8');
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    const q = "select has_table_privilege('service_role','public.fin_documents','SELECT') as svc, has_table_privilege('service_role','public.fin_documents','UPDATE') as svc_upd";
    const before = (await admin.query(q)).rows[0];
    // DROP ROLE is cluster-wide (the template database holds the same grants): verified separately, see the rollback header
    await admin.query(DOWN.replace('drop role if exists nordla_fin_issuer_pilot;', ''));
    const left = (await admin.query("select (select count(*) from pg_policies where policyname like 'nordla_fin_pilot_%') as policies, (select count(*) from pg_proc where proname in ('fin_pilot_assert','fin_pilot_bound_merchant')) as fns, (select count(*) from pg_namespace where nspname='nordla_runtime') as schemas")).rows[0];
    assert.deepEqual(left, { policies: '0', fns: '0', schemas: '0' });
    assert.deepEqual((await admin.query(q)).rows[0], before, 'service_role privileges unchanged');
  } finally { await admin.end(); await db.drop(); }
});
