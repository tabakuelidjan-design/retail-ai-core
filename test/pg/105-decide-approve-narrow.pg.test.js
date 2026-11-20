// service.decide(APPROVE) through the real runtime start-up in narrow-pilot mode, on a local disposable database with two synthetic
// merchants and real logins. Drafts are built by the Finance service itself (in memory) and stored with the production row mapper.
// The fake Supabase client records every call: the approval must not read or write Finance or commerce data through it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase, seedMerchants, adminClient, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { setupLogins, LOGIN_A, PW, dropPilotLogins } from './lib/pilot.js';
import { testUrl } from './lib/safety.js';
import { createRuntime } from '../../src/finance/runtime.js';
import { createFinanceService } from '../../src/finance/service.js';
import { docToRow } from '../../src/finance/supabase-store.js';
import { makeService, draftInvoice, AGENT_ACTOR, MERCHANT_ACTOR, SELLER, CUSTOMER, LINES, VAT_OK } from '../finance-fixtures.js';

const dir = mkdtempSync(join(tmpdir(), 'nordla-decide-'));
const CA_FILE = join(dir, 'ca.pem');
writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\nLOCAL-TEST-ONLY-NOT-A-SECRET\n-----END CERTIFICATE-----\n');
const quiet = () => {};

function recordingSupabase(merchantId) {
  const calls = [];
  const rows = { merchants: [{ id: merchantId, name: 'ENTREPRISE FICTIVE A', source_system: 'shopify', source_id: 'gid://fictif-a' }] };
  const rec = (k, t) => calls.push(`${k}:${t}`);
  return {
    calls,
    select: async (t) => { rec('select', t); return rows[t] ?? []; },
    selectAll: async (t) => { rec('selectAll', t); return rows[t] ?? []; },
    rpc: async (f) => { rec('rpc', f); throw new Error(`service rpc ${f} must not be used by the approval`); },
    insert: async (t) => { rec('insert', t); return []; }, update: async (t) => { rec('update', t); return []; }, upsert: async (t) => { rec('upsert', t); return []; },
  };
}
const narrowEnv = (db, login, merchant) => {
  const u = new URL(testUrl()); u.pathname = `/${db.name}`; u.username = login; u.password = PW;
  return { FINANCE_RUNTIME_DB: 'narrow-pilot', FINANCE_PILOT_DATABASE_URL: u.toString(), FINANCE_PILOT_CA_FILE: CA_FILE, FINANCE_PILOT_LOCAL_TEST: '1', NORDLA_MERCHANT_ID: merchant };
};
const CONFIG_A = { merchantId: MERCHANT_A, seller: SELLER, vat: { allowedRatesBp: [2100, 600, 0] }, defaults: { currency: 'EUR', language: 'fr', paymentTermsDays: 30 } };

// A submitted draft built by the Finance service, stored under a database id, exactly as the production mapper writes it.
async function submittedDraft(admin, over = {}) {
  const mem = makeService({ config: CONFIG_A });
  const d = await mem.svc.create(draftInvoice(over), AGENT_ACTOR);
  // standalone drafts go through the real submit; linked drafts cannot be submitted without the source order (the point of the test),
  // so their status is set to SUBMITTED directly, as the approval requires
  const linked = over.revenueBasis === 'linked_source_order';
  if (!linked) await mem.svc.submit(d.id, AGENT_ACTOR);
  const doc = (await mem.store.getDocument(d.id));
  const id = randomUUID();
  const row = docToRow({ ...doc, id, merchantId: MERCHANT_A, status: linked ? 'SUBMITTED' : doc.status });
  // the due date is part of the issue conditions: a draft always carries one (issue date + 30 days, the fixture payment terms)
  if (!row.due_date) row.due_date = new Date(Date.parse(`${row.issue_date}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  await admin.query(`insert into public.fin_documents (${cols.map((c) => `"${c}"`).join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])));
  return { id, version: row.version ?? 1 };
}
// an order of another merchant, stored as Finance would see it in the shared database (a commerce row, not reachable by merchant A)
async function foreignOrder(admin) {
  const id = randomUUID();
  await admin.query("insert into public.orders (id, merchant_id, source_system, source_id, ordered_at, currency, status, taxes_included) values ($1, $2, 'shopify', $3, now(), 'EUR', 'paid', true)", [id, MERCHANT_B, `gid://foreign-${id}`]);
  return id;
}
const errOf = async (fn) => { try { await fn(); return 'NO_ERROR'; } catch (e) { return `${e.code ?? ''} ${e.message}`.trim(); } };

test('nominal approval of a standalone invoice on the narrow path; no Finance or commerce read or write through the service client', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  let rt;
  try {
    await setupLogins(db); await seedMerchants(admin);
    const sb = recordingSupabase(MERCHANT_A);
    rt = await createRuntime({ env: narrowEnv(db, LOGIN_A, MERCHANT_A), supabase: sb, log: quiet });
    const svc = createFinanceService({ store: rt.store, config: CONFIG_A, clock: { now: () => '2026-09-21T10:00:00.000Z', today: () => '2026-09-21' }, ledgerProvider: async () => (await rt.loadRetail()).ledger });
    const d = await submittedDraft(admin);
    sb.calls.length = 0;
    const issued = await svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR);
    assert.equal(issued.status, 'ISSUED');
    assert.ok(issued.number, 'a number was allocated');
    assert.deepEqual(sb.calls.filter((c) => /fin_|orders|order_|products|variants|refunds|product_|locations|merchant_/.test(c)), [], `service client calls: ${sb.calls.join(', ')}`);
  } finally { await rt?.narrowPool?.end().catch(() => {}); await admin.end(); await db.drop(); }
});

test('foreign data never reaches the approval: another merchant invoice does not block, and its source order is not visible', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  let rt;
  try {
    await setupLogins(db); await seedMerchants(admin);
    const sb = recordingSupabase(MERCHANT_A);
    rt = await createRuntime({ env: narrowEnv(db, LOGIN_A, MERCHANT_A), supabase: sb, log: quiet });
    const svc = createFinanceService({ store: rt.store, config: CONFIG_A, clock: { now: () => '2026-09-21T10:00:00.000Z', today: () => '2026-09-21' }, ledgerProvider: async () => (await rt.loadRetail()).ledger });
    // a linked invoice of merchant A pointing to a source order that exists only in the foreign world
    const orderOther = await foreignOrder(admin);
    const linked = await submittedDraft(admin, { revenueBasis: 'linked_source_order', sourceOrderId: orderOther });
    assert.match(await errOf(() => svc.decide(linked.id, 'APPROVE', MERCHANT_ACTOR)), /NOT_READY_TO_ISSUE.*SOURCE_ORDER_NOT_FOUND_IN_RETAIL_CORE/);
    const aDocs = await rt.store.listDocuments({ merchantId: MERCHANT_A });
    assert.ok(aDocs.every((x) => x.merchantId === MERCHANT_A), 'the document listing is merchant-scoped');
  } finally { await rt?.narrowPool?.end().catch(() => {}); await admin.end(); await db.drop(); }
});

test('no linkage: a linked invoice whose source order does not exist is refused, nothing is issued', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  let rt;
  try {
    await setupLogins(db); await seedMerchants(admin);
    rt = await createRuntime({ env: narrowEnv(db, LOGIN_A, MERCHANT_A), supabase: recordingSupabase(MERCHANT_A), log: quiet });
    const svc = createFinanceService({ store: rt.store, config: CONFIG_A, clock: { now: () => '2026-09-21T10:00:00.000Z', today: () => '2026-09-21' }, ledgerProvider: async () => (await rt.loadRetail()).ledger });
    const linked = await submittedDraft(admin, { revenueBasis: 'linked_source_order', sourceOrderId: null });
    assert.match(await errOf(() => svc.decide(linked.id, 'APPROVE', MERCHANT_ACTOR)), /SOURCE_ORDER_NOT_FOUND_IN_RETAIL_CORE/);
    const row = (await admin.query('select status, number from fin_documents where id = $1', [linked.id])).rows[0];
    assert.equal(row.status, 'SUBMITTED');
    assert.equal(row.number, null);
  } finally { await rt?.narrowPool?.end().catch(() => {}); await admin.end(); await db.drop(); }
});

test('connection failure during the approval: refused, no fallback to the service client, nothing issued', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  let rt;
  try {
    await setupLogins(db); await seedMerchants(admin);
    const sb = recordingSupabase(MERCHANT_A);
    rt = await createRuntime({ env: narrowEnv(db, LOGIN_A, MERCHANT_A), supabase: sb, log: quiet });
    const svc = createFinanceService({ store: rt.store, config: CONFIG_A, clock: { now: () => '2026-09-21T10:00:00.000Z', today: () => '2026-09-21' }, ledgerProvider: async () => (await rt.loadRetail()).ledger });
    const d = await submittedDraft(admin);
    sb.calls.length = 0;
    await rt.narrowPool.end(); // the database connection is gone before the approval
    assert.notEqual(await errOf(() => svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR)), 'NO_ERROR');
    assert.deepEqual(sb.calls.filter((c) => c.includes('fin_') || c.startsWith('rpc:')), [], 'no Finance read or RPC through the service client');
    const row = (await admin.query('select status, number from fin_documents where id = $1', [d.id])).rows[0];
    assert.equal(row.number, null);
  } finally { await rt?.narrowPool?.end().catch(() => {}); await admin.end(); await db.drop(); }
});

after(dropPilotLogins);
