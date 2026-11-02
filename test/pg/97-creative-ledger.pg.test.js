// Creative ledger on a REAL PostgreSQL 17 with many simultaneous connections: policy acceptance / revocation, atomic spending reservations,
// idempotency, tenant isolation and the append-only media-transmission trail. The production store (createSupabaseCreativeLedger) runs unchanged
// over the bench's PostgREST stand-in. Run: node --test test/pg/97-creative-ledger.pg.test.js  (needs the bench database, see README).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDatabase } from './lib/db.js';
import { createPgRestClient } from './lib/pgrest.js';
import { createSupabaseCreativeLedger } from '../../src/creative-autonomy/creative-ledger.js';

const A = randomUUID(); const B = randomUUID(); const OWNER_A = randomUUID(); const OWNER_B = randomUUID(); const STRANGER = randomUUID();
const NOW = new Date('2026-11-02T10:00:00Z');
const policyFor = (merchant, over = {}) => ({
  kind: 'TENANT_MEDIA_PROCESSING_POLICY', policy_id: 'policy://creative-media', version: 1, tenant: { merchant_id: merchant },
  accepted_by: { role: 'TENANT_OWNER', at: NOW.toISOString() }, valid_from: '2026-11-01T00:00:00Z', valid_until: null, revoked: false,
  sources: { allowed_origins: ['SHOPIFY_CATALOG_VERIFIED_METADATA'], tenant_attests_catalog_product_images_show_no_people: true },
  processing: [{ provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', scope: 'EU', cross_border_possible: false, purpose: 'NORDLA_CREATIVE_CRITIQUE', operations: ['VISION_CRITIQUE'] }],
  retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
  spend: { currency: 'EUR', per_run_max: 0.5, monthly_max: 2 }, audit: { journal_required: true }, ...over,
});

let db; let admin; const clients = [];
const ledgerOn = async () => { const c = await createPgRestClient(db.name); clients.push(c); return createSupabaseCreativeLedger({ supabase: c }); };

test.before(async () => {
  db = await freshDatabase();
  admin = await db.open();
  await admin.query(`insert into merchants (id, name, source_system, source_id) values ($1,'A','shopify','gid://creative-A'), ($2,'B','shopify','gid://creative-B')`, [A, B]);
  await admin.query('insert into auth.users (id, email) values ($1, null), ($2, null), ($3, null)', [OWNER_A, OWNER_B, STRANGER]);
  for (const [m, u] of [[A, OWNER_A], [B, OWNER_B]]) {
    const r = (await admin.query('select identity_member_bootstrap_owner($1,$2,$3,$4,$5) r', [m, u, NOW, randomUUID(), 'creative'])).rows[0].r;
    assert.equal(r.ok, true, JSON.stringify(r));
  }
});
test.after(async () => { for (const c of clients) await c.close(); await admin?.end(); await db?.drop(); });

test('policy: only an OWNER/ADMIN of THAT tenant accepts; same content is idempotent; a change is a new version that supersedes the old one', async () => {
  const L = await ledgerOn();
  assert.deepEqual(await L.acceptPolicy({ merchantId: A, actorId: STRANGER, policy: policyFor(A), now: NOW }), { status: 'REFUSED', reason: 'ACTOR_NOT_TENANT_ADMIN' });
  assert.deepEqual(await L.acceptPolicy({ merchantId: A, actorId: OWNER_B, policy: policyFor(A), now: NOW }), { status: 'REFUSED', reason: 'ACTOR_NOT_TENANT_ADMIN' });
  assert.equal((await L.acceptPolicy({ merchantId: A, actorId: OWNER_A, policy: policyFor(B), now: NOW })).reason, 'TENANT_MISMATCH');
  const v1 = await L.acceptPolicy({ merchantId: A, actorId: OWNER_A, policy: policyFor(A), now: NOW });
  assert.equal(v1.status, 'ACCEPTED'); assert.equal(v1.version, 1);
  assert.equal((await L.acceptPolicy({ merchantId: A, actorId: OWNER_A, policy: policyFor(A), now: NOW })).status, 'ALREADY_ACCEPTED');
  const cur = await L.currentPolicy({ merchantId: A, policyId: 'policy://creative-media' });
  assert.equal(cur.version, 1); assert.equal(cur.accepted_by, OWNER_A); assert.equal(cur.accepted_role, 'OWNER'); assert.equal(Number(cur.per_run_max_eur), 0.5);
  assert.equal(await L.currentPolicy({ merchantId: B, policyId: 'policy://creative-media' }), null, 'tenant B has accepted nothing');
});

test('audit rows cannot be casually overwritten: accepted content, reservations and transmission events are immutable / append-only', async () => {
  await assert.rejects(() => admin.query(`update creative_media_policies set content = '{}'::jsonb where merchant_id = $1`, [A]), /immutable/);
  await assert.rejects(() => admin.query('delete from creative_media_policies where merchant_id = $1', [A]), /never deleted/);
  await assert.rejects(() => admin.query('truncate creative_media_transmissions'), /append-only/);
  // the service role cannot write the tables directly, only through the functions
  const TABLES = ['creative_media_policies', 'creative_spend_reservations', 'creative_media_transmissions'];
  for (const t of TABLES) {
    const grants = (await admin.query(`select grantee, privilege_type from information_schema.role_table_grants where table_name = $1 and grantee in ('service_role','anon','authenticated') order by 1, 2`, [t])).rows;
    assert.deepEqual(grants, [{ grantee: 'service_role', privilege_type: 'SELECT' }], `${t}: only SELECT for service_role, nothing for anon / authenticated`);
    assert.equal((await admin.query('select relrowsecurity from pg_class where oid = $1::regclass', [t])).rows[0].relrowsecurity, true, `${t}: RLS enabled`);
  }
  // no browser-facing role can call any ledger function; the lock helpers are callable by nobody but the owner
  const exec = (await admin.query(`select p.proname, r.rolname from pg_proc p cross join (values ('anon'),('authenticated'),('service_role')) v(rolname) join pg_roles r on r.rolname = v.rolname
    where p.proname like 'creative\\_%' and p.pronamespace = 'public'::regnamespace and has_function_privilege(r.oid, p.oid, 'EXECUTE')`)).rows;
  assert.deepEqual(exec.filter((x) => x.rolname !== 'service_role'), [], 'anon / authenticated execute nothing');
  assert.ok(!exec.some((x) => /_lock$/.test(x.proname)), 'the lock helpers are not callable through the API');
});

test('CONCURRENCY: 40 simultaneous runs on 20 connections against a 2.00 EUR month and 0.50 EUR runs: exactly 4 reservations succeed, never more', async () => {
  const ledgers = await Promise.all(Array.from({ length: 20 }, () => ledgerOn()));
  const out = await Promise.all(Array.from({ length: 40 }, (_, i) => ledgers[i % 20].reserve({ merchantId: A, runId: `conc-${i}`, policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.5, now: NOW })));
  const ok = out.filter((o) => o.status === 'RESERVED');
  assert.equal(ok.length, 4, JSON.stringify(out.map((o) => o.status)));
  assert.ok(out.filter((o) => o.status === 'REFUSED').every((o) => o.reason === 'MONTHLY_LIMIT'));
  const sum = Number((await admin.query(`select coalesce(sum(ceiling_eur),0) s from creative_spend_reservations where merchant_id = $1 and status = 'RESERVED'`, [A])).rows[0].s);
  assert.equal(sum, 2);
});

test('idempotency: the same run retried concurrently is ONE reservation; another ceiling under the same run id is refused', async () => {
  const L = await ledgerOn();
  // free the month first: release the four reservations (no media was attempted under them)
  for (let i = 0; i < 40; i += 1) await L.release({ merchantId: A, runId: `conc-${i}`, reason: 'TEST_RESET', now: NOW });
  const ledgers = await Promise.all(Array.from({ length: 10 }, () => ledgerOn()));
  const same = await Promise.all(ledgers.map((l) => l.reserve({ merchantId: A, runId: 'retry-1', policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.5, now: NOW })));
  assert.equal(same.filter((o) => o.status === 'RESERVED').length, 1); assert.equal(same.filter((o) => o.status === 'ALREADY_RESERVED').length, 9);
  assert.equal((await L.reserve({ merchantId: A, runId: 'retry-1', policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.4, now: NOW })).reason, 'RUN_ID_ALREADY_USED_WITH_OTHER_TERMS');
  assert.equal((await L.reserve({ merchantId: A, runId: 'too-big', policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.6, now: NOW })).reason, 'PER_RUN_LIMIT');
});

test('tenant isolation: tenant B cannot use A\'s policy, and A\'s month does not consume B\'s', async () => {
  const L = await ledgerOn();
  assert.equal((await L.reserve({ merchantId: B, runId: 'b-1', policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.5, now: NOW })).reason, 'POLICY_NOT_IN_FORCE');
  assert.equal((await L.acceptPolicy({ merchantId: B, actorId: OWNER_B, policy: policyFor(B), now: NOW })).status, 'ACCEPTED');
  assert.equal((await L.reserve({ merchantId: B, runId: 'retry-1', policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.5, now: NOW })).status, 'RESERVED', 'the same run id in another tenant is another run');
});

test('transmission lifecycle: ATTEMPTED only after AUTHORIZED for the same source and policy; outcomes only after an attempt; retries are no-ops; release refused once media was attempted', async () => {
  const L = await ledgerOn();
  const base = { merchantId: A, runId: 'retry-1', operation: 'VISION_CRITIQUE', policyId: 'policy://creative-media', policyVersion: 1, authorizationId: 'policy://creative-media@v1#VISION_CRITIQUE#aaaa',
    sourceSha256: 'a'.repeat(64), providerId: 'alibaba-cloud-model-studio', region: 'eu-central-1', now: NOW };
  assert.equal((await L.record({ ...base, attemptRef: 'op-1', event: 'ATTEMPTED' })).reason, 'NOT_AUTHORIZED_FOR_THIS_SOURCE');
  assert.equal((await L.record({ ...base, attemptRef: 'run', event: 'AUTHORIZED' })).status, 'RECORDED');
  assert.equal((await L.record({ ...base, attemptRef: 'op-1', event: 'SENT', requestId: 'req-1' })).reason, 'NO_ATTEMPT');
  assert.equal((await L.record({ ...base, sourceSha256: 'b'.repeat(64), attemptRef: 'op-1', event: 'ATTEMPTED' })).reason, 'NOT_AUTHORIZED_FOR_THIS_SOURCE', 'a mismatched source SHA cannot be attempted');
  assert.equal((await L.record({ ...base, attemptRef: 'op-1', event: 'ATTEMPTED' })).status, 'RECORDED');
  const twice = await Promise.all([1, 2, 3].map(() => L.record({ ...base, attemptRef: 'op-1', event: 'SUCCEEDED', requestId: 'req-1' })));
  assert.deepEqual(twice.map((t) => t.status).sort(), ['DUPLICATE', 'DUPLICATE', 'RECORDED']);
  assert.equal((await L.release({ merchantId: A, runId: 'retry-1', reason: 'CANCELLED', now: NOW })).reason, 'MEDIA_WAS_ATTEMPTED_SETTLE_INSTEAD');
  assert.equal((await L.settle({ merchantId: A, runId: 'retry-1', settledEur: 0.01, basis: 'APPLICATION_LEDGER', now: NOW })).status, 'SETTLED');
  assert.equal((await L.settle({ merchantId: A, runId: 'retry-1', settledEur: 0.01, basis: 'APPLICATION_LEDGER', now: NOW })).status, 'ALREADY_SETTLED');
  assert.equal((await L.record({ ...base, attemptRef: 'op-2', event: 'ATTEMPTED' })).reason, 'RESERVATION_NOT_LIVE', 'no new attempt after settlement');
  const rows = (await admin.query('select event, provider_request_id from creative_media_transmissions where merchant_id = $1 and run_id = $2 order by id', [A, 'retry-1'])).rows;
  assert.deepEqual(rows.map((r) => r.event), ['AUTHORIZED', 'ATTEMPTED', 'SUCCEEDED']);
});

test('reconciliation: a stale run without attempt is released; a stale run with an attempt stays counted as RECONCILE_REQUIRED', async () => {
  const L = await ledgerOn();
  const old = new Date('2026-11-02T09:00:00Z');
  await L.reserve({ merchantId: A, runId: 'stale-none', policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.5, now: old });
  await L.reserve({ merchantId: A, runId: 'stale-sent', policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.5, now: old });
  const ev = { merchantId: A, runId: 'stale-sent', operation: 'VISION_CRITIQUE', policyId: 'policy://creative-media', policyVersion: 1, authorizationId: 'x', sourceSha256: 'c'.repeat(64), providerId: 'p', region: 'r', now: old };
  await L.record({ ...ev, attemptRef: 'run', event: 'AUTHORIZED' }); await L.record({ ...ev, attemptRef: 'op-9', event: 'ATTEMPTED' });
  const r = await L.reconcileStale({ merchantId: A, olderThan: new Date('2026-11-02T09:30:00Z'), now: NOW });
  assert.deepEqual(r, { released: 1, reconcile_required: 1 });
  const st = Object.fromEntries((await admin.query(`select run_id, status from creative_spend_reservations where merchant_id = $1 and run_id like 'stale-%'`, [A])).rows.map((x) => [x.run_id, x.status]));
  assert.deepEqual(st, { 'stale-none': 'RELEASED', 'stale-sent': 'RECONCILE_REQUIRED' });
});

test('revocation blocks new reservations at once; a changed policy needs a new acceptance and the old version can no longer reserve', async () => {
  const L = await ledgerOn();
  assert.equal((await L.revokePolicy({ merchantId: A, actorId: STRANGER, policyId: 'policy://creative-media', now: NOW })).reason, 'ACTOR_NOT_TENANT_ADMIN');
  const changed = await L.acceptPolicy({ merchantId: B, actorId: OWNER_B, policy: policyFor(B, { spend: { currency: 'EUR', per_run_max: 0.5, monthly_max: 3 } }), now: NOW });
  assert.equal(changed.version, 2);
  assert.equal((await L.reserve({ merchantId: B, runId: 'b-old', policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.5, now: NOW })).reason, 'POLICY_NOT_IN_FORCE');
  assert.equal((await L.revokePolicy({ merchantId: A, actorId: OWNER_A, policyId: 'policy://creative-media', now: NOW })).status, 'REVOKED');
  assert.equal(await L.currentPolicy({ merchantId: A, policyId: 'policy://creative-media' }), null);
  assert.equal((await L.reserve({ merchantId: A, runId: 'after-revoke', policyId: 'policy://creative-media', policyVersion: 1, ceilingEur: 0.1, now: NOW })).reason, 'POLICY_NOT_IN_FORCE');
});
