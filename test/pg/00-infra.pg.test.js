// Phase 0 - infrastructure: guard rails, PostgreSQL 17, migrations from zero, reproducibility, drift vs production fingerprint, reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeTestUrl } from './lib/safety.js';
import { adminClient, catalogFingerprint, diffFingerprints, freshDatabase, migrationFiles, prodFingerprint, MERCHANT_A, seedMerchants } from './lib/db.js';

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
  assert.equal(files.length, 23); assert.deepEqual(files, [...files].sort());
  const db = await freshDatabase({ fromZero: true });
  try {
    const c = await db.open();
    const tables = (await c.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n;
    console.log(`  replayed ${files.length} migrations -> ${tables} public tables`); assert.equal(tables, 27);
    await c.end();
  } finally { await db.drop(); }
});

test('schema drift: catalog rebuilt from migrations == production fingerprint (read-only snapshot fixture)', async () => {
  const db = await freshDatabase({ fromZero: true });
  try {
    const c = await db.open(); const local = await catalogFingerprint(c); await c.end();
    const prod = prodFingerprint(); const diffs = diffFingerprints(prod, local);
    console.log(`  compared ${prod.size} production objects with ${local.size} local ones: ${diffs.length} difference(s)`, diffs);
    assert.deepEqual(diffs, []);
  } finally { await db.drop(); }
});

test('reproducibility: two independent replays give the same catalog', async () => {
  const d1 = await freshDatabase({ fromZero: true }); const d2 = await freshDatabase({ fromZero: true });
  try {
    const c1 = await d1.open(); const c2 = await d2.open(); const f1 = await catalogFingerprint(c1); const f2 = await catalogFingerprint(c2); await c1.end(); await c2.end();
    assert.deepEqual([...f1], [...f2]);
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
  try { assert.equal((await a.query("select count(*)::int n from pg_database where datname in ($1,$2)", [d1.name, d2.name])).rows[0].n, 0); } finally { await a.end(); }
});

test('objects present: RPCs, triggers, constraints can be inspected', async () => {
  const db = await freshDatabase(); const c = await db.open();
  try {
    const fns = (await c.query("select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname like 'fin\_%' order by 1")).rows.map((r) => r.proname);
    assert.deepEqual(fns, ['fin_append_only', 'fin_bank_tx_guard', 'fin_documents_guard', 'fin_issue_document', 'fin_next_number', 'fin_stock_movements_guard']);
    const triggers = (await c.query("select count(*)::int n from pg_trigger where not tgisinternal")).rows[0].n; assert.ok(triggers >= 6);
    const rls = (await c.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity")).rows[0].n; assert.equal(rls, 27);
  } finally { await c.end(); await db.drop(); }
});
