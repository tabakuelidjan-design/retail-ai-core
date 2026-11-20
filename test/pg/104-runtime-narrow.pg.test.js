// Start-up path (createRuntime, the function the Finance server and the CLI call) in narrow-pilot mode on a local disposable
// database. Supabase REST is replaced by a recording fake (the service key is not available here): every call is logged, so
// the test proves which calls reached the service client and which did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase, seedMerchants, insertDraft, MERCHANT_A, MERCHANT_B, PLACEHOLDER } from './lib/db.js';
import { setupLogins, LOGIN_A, PW } from './lib/pilot.js';
import { testUrl } from './lib/safety.js';
import { createRuntime } from '../../src/finance/runtime.js';

const dir = mkdtempSync(join(tmpdir(), 'nordla-rt-'));
const CA_FILE = join(dir, 'ca.pem');
writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\nLOCAL-TEST-ONLY-NOT-A-SECRET\n-----END CERTIFICATE-----\n');

function fakeSupabase(merchantId) {
  const calls = [];
  const rows = { merchants: [{ id: merchantId, name: 'ENTREPRISE FICTIVE', source_system: 'shopify', source_id: 'gid://fictif' }] };
  const rec = (kind, t) => calls.push(`${kind}:${t}`);
  return {
    calls,
    select: async (t) => { rec('select', t); return rows[t] ?? []; },
    selectAll: async (t) => { rec('selectAll', t); return rows[t] ?? []; },
    rpc: async (fn) => { rec('rpc', fn); throw new Error(`service rpc ${fn} must not be used in narrow mode`); },
    insert: async (t) => { rec('insert', t); return []; },
    update: async (t) => { rec('update', t); return []; },
    upsert: async (t) => { rec('upsert', t); return []; },
  };
}
const narrowEnv = (db, login, merchant) => {
  const u = new URL(testUrl()); u.pathname = `/${db.name}`; u.username = login; u.password = PW;
  return { FINANCE_RUNTIME_DB: 'narrow-pilot', FINANCE_PILOT_DATABASE_URL: u.toString(), FINANCE_PILOT_CA_FILE: CA_FILE, FINANCE_PILOT_LOCAL_TEST: '1', NORDLA_MERCHANT_ID: merchant };
};
const issueParams = (doc) => ({
  docId: doc.id, expectedVersion: doc.version, newStatus: 'ISSUED', numbering: { prefix: 'FACT', pad: 4, format: '{prefix}-{year}-{seq}' }, year: 2026,
  canonical: `{"id":"${doc.id}","number":"${PLACEHOLDER}","gross":${doc.gross_cents}}`, placeholder: PLACEHOLDER, lockedAt: '2026-09-30T10:00:00Z',
  event: { actor: { type: 'merchant' }, action: 'ISSUED', detail: { n: PLACEHOLDER } },
});
const quiet = () => {};

test('narrow-pilot start-up: read and issue go through the narrow role; the service client is never asked for the document or the RPC', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    const dA = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const sb = fakeSupabase(MERCHANT_A);
    const rt = await createRuntime({ env: narrowEnv(db, LOGIN_A, MERCHANT_A), supabase: sb, log: quiet });
    try {
      assert.equal(rt.dbMode, 'narrow-pilot');
      assert.equal((await rt.store.getDocument(dA.id)).id, dA.id, 'read through the narrow role');
      const issued = await rt.store.issueDocument(issueParams(dA));
      assert.equal(issued.status, 'ISSUED');
      assert.equal(issued.number, 'FACT-2026-0001');
      assert.ok(!sb.calls.some((c) => c === 'select:fin_documents' || c.startsWith('rpc:fin_issue')), `no document access through the service client: ${sb.calls.join(', ')}`);
    } finally { await rt.narrowPool.end(); }
  } finally { await admin.end(); await db.drop(); }
});

test('narrow-pilot start-up refuses a merchant the login is not bound to (no runtime is returned)', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    await assert.rejects(() => createRuntime({ env: narrowEnv(db, LOGIN_A, MERCHANT_B), supabase: fakeSupabase(MERCHANT_B), log: quiet }), (e) => /PILOT_IDENTITY_REFUSED|FIN_PILOT_MERCHANT_MISMATCH|PILOT_/.test(String(e.code ?? e.message)));
  } finally { await admin.end(); await db.drop(); }
});

test('connection failure after start-up: the operation is refused, nothing is read or issued through the service client', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    const dA = await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const sb = fakeSupabase(MERCHANT_A);
    const rt = await createRuntime({ env: narrowEnv(db, LOGIN_A, MERCHANT_A), supabase: sb, log: quiet });
    await rt.narrowPool.end(); // the database connection is gone
    await assert.rejects(() => rt.store.getDocument(dA.id));
    await assert.rejects(() => rt.store.issueDocument(issueParams(dA)));
    assert.ok(!sb.calls.some((c) => c.includes('fin_documents') || c.startsWith('rpc:')), `no fallback: ${sb.calls.join(', ')}`);
    const state = (await admin.query('select status from fin_documents where id = $1', [dA.id])).rows[0];
    assert.equal(state.status, 'DRAFT', 'nothing was issued');
  } finally { await admin.end(); await db.drop(); }
});

test('service mode (default) keeps the existing store: document reads go through the service client', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await seedMerchants(admin);
    const sb = fakeSupabase(MERCHANT_A);
    const rt = await createRuntime({ env: { NORDLA_MERCHANT_ID: MERCHANT_A }, supabase: sb, log: quiet });
    assert.equal(rt.dbMode, 'service');
    assert.equal(rt.narrowPool, null);
    await rt.store.getDocument('00000000-0000-4000-8000-000000000000');
    assert.ok(sb.calls.includes('select:fin_documents'), 'service mode reads through the service client');
  } finally { await admin.end(); await db.drop(); }
});
