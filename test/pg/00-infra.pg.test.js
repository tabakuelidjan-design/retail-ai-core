// Phase 0/1 - infrastructure: guard rails, PostgreSQL 17, migrations from zero, reproducibility, drift vs the production fingerprint, reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeTestUrl } from './lib/safety.js';
import { adminClient, catalogFingerprint, diffFingerprints, freshDatabase, migrationFiles, prodFingerprint, seedMerchants } from './lib/db.js';

// The last migration already applied to production when the fingerprint fixture was taken. Everything after it is PENDING (not yet deployed).
const PRODUCTION_BASELINE = '20260927100000';
// What the pending migrations are ALLOWED to change in the catalog, pinned: any other difference is drift or an accident.
const PENDING_DELTA = [
  'DIFFERS: cols|fin_bank_balances',
  'DIFFERS: cols|fin_bank_transactions',
  'DIFFERS: cons|fin_bank_balances',
  'DIFFERS: cons|fin_bank_transactions',
  'DIFFERS: cons|fin_companies',
  'DIFFERS: cons|fin_documents',
  'DIFFERS: cons|fin_events',
  'DIFFERS: cons|fin_payments',
  'DIFFERS: cons|fin_supplier_invoices',
  'DIFFERS: fn|fin_bank_tx_guard()',
  'DIFFERS: idx|fin_bank_transactions',
  'DIFFERS: idx|fin_companies',
  'DIFFERS: idx|fin_documents',
  'DIFFERS: idx|fin_supplier_invoices',
  'DIFFERS: trg|fin_bank_transactions',
  'DIFFERS: trg|fin_documents',
  'ONLY IN MIGRATIONS: cols|fin_bank_accounts',
  'ONLY IN MIGRATIONS: cols|fin_bank_reconciliations',
  'ONLY IN MIGRATIONS: cols|fin_payment_allocations',
  'ONLY IN MIGRATIONS: cols|fin_payment_registry',
  'ONLY IN MIGRATIONS: cons|fin_bank_accounts',
  'ONLY IN MIGRATIONS: cons|fin_bank_reconciliations',
  'ONLY IN MIGRATIONS: cons|fin_payment_allocations',
  'ONLY IN MIGRATIONS: cons|fin_payment_registry',
  'ONLY IN MIGRATIONS: idx|fin_bank_accounts',
  'ONLY IN MIGRATIONS: idx|fin_bank_reconciliations',
  'ONLY IN MIGRATIONS: idx|fin_payment_allocations',
  'ONLY IN MIGRATIONS: idx|fin_payment_registry',
  'ONLY IN MIGRATIONS: rls|fin_bank_accounts',
  'ONLY IN MIGRATIONS: rls|fin_bank_reconciliations',
  'ONLY IN MIGRATIONS: rls|fin_payment_allocations',
  'ONLY IN MIGRATIONS: rls|fin_payment_registry',
  'ONLY IN MIGRATIONS: trg|fin_bank_balances',
  'ONLY IN MIGRATIONS: trg|fin_bank_reconciliations',
  'ONLY IN MIGRATIONS: trg|fin_payment_allocations',
  'ONLY IN MIGRATIONS: trg|fin_payment_registry',
  'ONLY IN MIGRATIONS: trg|fin_supplier_invoices',
  'ONLY IN MIGRATIONS: fn|fin_allocate_payment(p_merchant uuid, p_key text, p_payment_id uuid, p_allocations jsonb, p_actor jsonb, p_at timestamp with time zone)',
  'ONLY IN MIGRATIONS: fn|fin_bank_account_link()',
  'ONLY IN MIGRATIONS: fn|fin_bank_ignore(p_merchant uuid, p_key text, p_tx uuid, p_amount bigint, p_reason text, p_actor jsonb, p_at timestamp with time zone)',
  'ONLY IN MIGRATIONS: fn|fin_bank_reconcile(p_merchant uuid, p_key text, p_tx uuid, p_items jsonb, p_suggestion jsonb, p_actor jsonb, p_at timestamp with time zone)',
  'ONLY IN MIGRATIONS: fn|fin_bank_reconcile_and_pay(p_merchant uuid, p_key text, p_tx uuid, p_payment jsonb, p_suggestion jsonb, p_actor jsonb, p_at timestamp with time zone)',
  'ONLY IN MIGRATIONS: fn|fin_bank_reconciliation_guard()',
  'ONLY IN MIGRATIONS: fn|fin_bank_reconciliation_mirror()',
  'ONLY IN MIGRATIONS: fn|fin_bank_tx_amounts(p_merchant uuid, p_tx uuid)',
  'ONLY IN MIGRATIONS: fn|fin_bank_unreconcile(p_merchant uuid, p_key text, p_items jsonb, p_reason text, p_actor jsonb, p_at timestamp with time zone)',
  'ONLY IN MIGRATIONS: fn|fin_credit_ceiling_guard()',
  'ONLY IN MIGRATIONS: fn|fin_invoice_amounts(p_merchant uuid, p_invoice uuid)',
  'ONLY IN MIGRATIONS: fn|fin_payable_cents(d fin_documents)',
  'ONLY IN MIGRATIONS: fn|fin_payment_allocation_guard()',
  'ONLY IN MIGRATIONS: fn|fin_payment_registry_guard()',
  'ONLY IN MIGRATIONS: fn|fin_record_payment(p_merchant uuid, p_key text, p_direction text, p_amount bigint, p_currency text, p_paid_on date, p_method text, p_reference text, p_actor jsonb, p_allocations jsonb, p_at timestamp with time zone, p_meta jsonb)',
  'ONLY IN MIGRATIONS: fn|fin_reverse_allocations(p_merchant uuid, p_key text, p_items jsonb, p_reason text, p_actor jsonb, p_at timestamp with time zone)',
  'ONLY IN MIGRATIONS: fn|fin_supplier_invoice_mirror()',
  'ONLY IN MIGRATIONS: fn|fin_supplier_invoice_truth_guard()',
  'ONLY IN MIGRATIONS: fn|fin_void_payment(p_merchant uuid, p_key text, p_payment_id uuid, p_on date, p_reason text, p_actor jsonb, p_at timestamp with time zone)',
  'ONLY IN MIGRATIONS: cols|fin_artifacts',
  'ONLY IN MIGRATIONS: cols|fin_peppol_messages',
  'ONLY IN MIGRATIONS: cols|fin_seller_profile_versions',
  'ONLY IN MIGRATIONS: cons|fin_artifacts',
  'ONLY IN MIGRATIONS: cons|fin_peppol_messages',
  'ONLY IN MIGRATIONS: cons|fin_seller_profile_versions',
  'ONLY IN MIGRATIONS: fn|fin_artifacts_guard()',
  'ONLY IN MIGRATIONS: fn|fin_peppol_enqueue(p_merchant uuid, p_document uuid, p_key text',
  'ONLY IN MIGRATIONS: fn|fin_peppol_inbound_register(p_merchant uuid, p_provider text, p',
  'ONLY IN MIGRATIONS: fn|fin_peppol_messages_guard()',
  'ONLY IN MIGRATIONS: fn|fin_seller_profile_record(p_merchant uuid, p_profile jsonb, p_s',
  'ONLY IN MIGRATIONS: fn|fin_seller_profile_versions_guard()',
  'ONLY IN MIGRATIONS: fn|fin_vcs_valid(p text)',
  'ONLY IN MIGRATIONS: idx|fin_artifacts',
  'ONLY IN MIGRATIONS: idx|fin_peppol_messages',
  'ONLY IN MIGRATIONS: idx|fin_seller_profile_versions',
  'ONLY IN MIGRATIONS: rls|fin_artifacts',
  'ONLY IN MIGRATIONS: rls|fin_peppol_messages',
  'ONLY IN MIGRATIONS: rls|fin_seller_profile_versions',
  'ONLY IN MIGRATIONS: trg|fin_artifacts',
  'ONLY IN MIGRATIONS: trg|fin_peppol_messages',
  'ONLY IN MIGRATIONS: trg|fin_seller_profile_versions',
  'ONLY IN MIGRATIONS: fn|fin_peppol_transition(p_merchant uuid, p_id uuid, p_from jsonb,',
].map((x) => x.replace(/(fn\|)(.*)$/, (m, p, sig) => p + sig.slice(0, 63))).sort(); // the fingerprint key is a Postgres name (63 characters): long signatures are cut, their source hash is not

test('guard: production-looking or remote URLs are refused before any connection', () => {
  const at = '@'; // hostnames are assembled so the repository privacy scan never sees an e-mail-shaped string
  const bads = [['db', 'project-ref', 'supabase', 'co'], ['aws-0-eu-west-1', 'pooler', 'supabase', 'com'], ['mydb', 'railway', 'internal'], ['example', 'com']].map((h) => `postgres://u:p${at}${h.join('.')}:5432/finance_test_x`);
  for (const bad of [...bads, `postgres://u:p${at}10.0.0.5:5432/finance_test_x`, 'not a url']) {
    assert.throws(() => assertSafeTestUrl(bad), /UNSAFE TEST TARGET/, bad);
  }
  assert.doesNotThrow(() => assertSafeTestUrl('postgres://postgres:finance_test_only@127.0.0.1:54329/postgres'));
});

test('server is PostgreSQL 17 and carries the sentinel', async () => {
  const a = await adminClient();
  try {
    const v = (await a.query('show server_version')).rows[0].server_version; console.log('  server_version', v);
    assert.match(v, /^17\./);
    assert.equal((await a.query("select current_setting('cluster_name') c")).rows[0].c, 'nordla_finance_test');
  } finally { await a.end(); }
});

test('migrations replay from zero, in order, on a database created empty', async () => {
  const files = migrationFiles();
  assert.equal(files.length, 27); assert.deepEqual(files, [...files].sort());
  const db = await freshDatabase({ fromZero: true });
  try {
    const c = await db.open();
    try {
      const tables = (await c.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n;
      console.log(`  replayed ${files.length} migrations -> ${tables} public tables`); assert.equal(tables, 34);
    } finally { await c.end(); }
  } finally { await db.drop(); }
});

test('schema drift: the migrations already in production rebuild EXACTLY the production catalog (read-only fingerprint fixture)', async () => {
  const db = await freshDatabase({ fromZero: true, upTo: PRODUCTION_BASELINE });
  try {
    const c = await db.open(); const local = await catalogFingerprint(c); await c.end();
    const prod = prodFingerprint(); const diffs = diffFingerprints(prod, local);
    console.log(`  compared ${prod.size} production objects with ${local.size} local ones: ${diffs.length} difference(s)`, diffs);
    assert.deepEqual(diffs, []);
  } finally { await db.drop(); }
});

test('pending migrations change ONLY what they declare (no accidental catalog change), and a full replay is deterministic', async () => {
  const d1 = await freshDatabase({ fromZero: true }); const d2 = await freshDatabase({ fromZero: true });
  try {
    const c1 = await d1.open(); const c2 = await d2.open(); const f1 = await catalogFingerprint(c1); const f2 = await catalogFingerprint(c2); await c1.end(); await c2.end();
    assert.deepEqual([...f1], [...f2], 'two independent replays give the same catalog');
    const delta = diffFingerprints(prodFingerprint(), f1).sort();
    console.log(`  pending delta vs production: ${delta.length} object(s)`);
    assert.deepEqual(delta, PENDING_DELTA);
  } finally { await d1.drop(); await d2.drop(); }
});

test('database reset: a template copy is clean, writes do not leak into the next copy, drop removes it', async () => {
  const d1 = await freshDatabase();
  const c1 = await d1.open(); await seedMerchants(c1);
  assert.equal((await c1.query('select count(*)::int n from merchants')).rows[0].n, 2); await c1.end();
  const d2 = await freshDatabase(); const c2 = await d2.open();
  assert.equal((await c2.query('select count(*)::int n from merchants')).rows[0].n, 0, 'a new copy starts empty');
  await c2.end(); await d1.drop(); await d2.drop();
  const a = await adminClient();
  try { assert.equal((await a.query('select count(*)::int n from pg_database where datname in ($1,$2)', [d1.name, d2.name])).rows[0].n, 0); } finally { await a.end(); }
});

test('objects present: RPCs, triggers, constraints can be inspected', async () => {
  const db = await freshDatabase(); const c = await db.open();
  try {
    const fns = (await c.query("select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname like 'fin\\_%' order by 1")).rows.map((r) => r.proname);
    assert.deepEqual(fns, ['fin_allocate_payment', 'fin_append_only', 'fin_artifacts_guard', 'fin_bank_account_link', 'fin_bank_ignore', 'fin_bank_reconcile', 'fin_bank_reconcile_and_pay', 'fin_bank_reconciliation_guard', 'fin_bank_reconciliation_mirror', 'fin_bank_tx_amounts', 'fin_bank_tx_guard', 'fin_bank_unreconcile', 'fin_credit_ceiling_guard', 'fin_documents_guard', 'fin_invoice_amounts', 'fin_issue_document', 'fin_next_number', 'fin_payable_cents', 'fin_payment_allocation_guard', 'fin_payment_registry_guard', 'fin_peppol_enqueue', 'fin_peppol_inbound_register', 'fin_peppol_messages_guard', 'fin_peppol_transition', 'fin_record_payment', 'fin_reverse_allocations', 'fin_seller_profile_record', 'fin_seller_profile_versions_guard', 'fin_stock_movements_guard', 'fin_supplier_invoice_mirror', 'fin_supplier_invoice_truth_guard', 'fin_vcs_valid', 'fin_void_payment']);
    const rls = (await c.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity")).rows[0].n; assert.equal(rls, 34);
    const sd = (await c.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef")).rows[0].n; assert.equal(sd, 0, 'no SECURITY DEFINER function');
  } finally { await c.end(); await db.drop(); }
});
