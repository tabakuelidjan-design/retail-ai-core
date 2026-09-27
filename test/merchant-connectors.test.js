// merchant_connectors foundation (ADR 0003 step 3): repository rules, secret-free config, Shopify backfill rule, and the M1 SQL
// contract. Synthetic data only. The in-memory store below enforces the same rules as the SQL (UNIQUE(kind, external_id) with
// NULLs distinct, FK ON DELETE RESTRICT); the real SQL behaviour is verified on the staging database before any rollout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import {
  createConnectorRepository, validateConnectorConfig, findSecretPaths, planShopifyConnectorBackfill,
  ConnectorError, CONNECTOR_ERROR_CODES as C, KNOWN_CONNECTOR_KINDS, PERSISTED_CONNECTOR_STATUSES, CONNECTOR_STATES, KINDS_REQUIRING_EXTERNAL_ID,
} from '../src/tenant/connectors.js';

const M1 = { id: '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b', name: 'Synthetic Merchant A', vertical: 'general_retail', source_system: 'shopify', source_id: 'gid://shopify/Shop/SYN-A', source_domain: 'syn-a.myshopify.example' };
const M2 = { id: '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0', name: 'Synthetic Merchant B', vertical: 'bookstore', source_system: 'shopify', source_id: 'gid://shopify/Shop/SYN-B', source_domain: 'syn-b.myshopify.example' };
const M3 = { id: '5c4b3a29-1807-46f5-a4b3-c2d1e0f9a8b7', name: 'Synthetic Merchant C (no e-commerce)', vertical: 'services', source_system: 'manual', source_id: 'nordla:SYN-C', source_domain: null };
const SHOP_A = 'gid://shopify/Shop/SYN-A'; const SHOP_A2 = 'gid://shopify/Shop/SYN-A2';
const MIGRATION = readFileSync(new URL('../supabase/migrations/20260927100000_merchant_connectors.sql', import.meta.url), 'utf8');
const SQL = MIGRATION.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n'); // code only, comments stripped

/** In-memory Supabase with the M1 rules, recording every call. */
function strictDb(...merchants) {
  const db = createFakeSupabase(); db._tables.set('merchants', merchants.map((m) => ({ ...m }))); db._tables.set('merchant_connectors', []);
  const calls = [];
  const conflict = (code) => new Error(`Supabase REST POST -> HTTP 409: {"code":"${code}"}`);
  const api = {
    _tables: db._tables,
    async select(t, p) { calls.push({ m: 'select', t }); return db.select(t, p); },
    async insert(t, rows) {
      calls.push({ m: 'insert', t });
      if (t === 'merchant_connectors') for (const r of rows) {
        if (!db._tables.get('merchants').some((m) => m.id === r.merchant_id)) throw conflict('23503');
        if (r.external_id != null && db._tables.get(t).some((c) => c.kind === r.kind && c.external_id === r.external_id)) throw conflict('23505');
      }
      const now = new Date().toISOString();
      return db.insert(t, rows.map((r) => (t === 'merchant_connectors' ? { status: 'NOT_CONFIGURED', config: {}, created_at: now, updated_at: now, ...r } : r)));
    },
    async update(t, f, patch) { calls.push({ m: 'update', t, keys: Object.keys(patch) }); return db.update(t, f, patch); },
    async delete(t, f) {
      calls.push({ m: 'delete', t });
      if (t === 'merchants') { const ids = (await db.select(t, f)).map((m) => m.id); if (db._tables.get('merchant_connectors').some((c) => ids.includes(c.merchant_id))) throw conflict('23503'); }
      return db.delete(t, f);
    },
  };
  return { supabase: api, calls, table: (n) => db._tables.get(n), repo: createConnectorRepository({ supabase: api }) };
}
const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof ConnectorError && e.code === code);

// ---------- repository ----------
test('create a Shopify connector for a merchant', async () => {
  const { repo, table } = strictDb(M1);
  const r = await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, externalDomain: M1.source_domain, status: 'CONFIGURED', config: { apiVersion: '2024-10' } });
  assert.equal(r.created, true);
  assert.deepEqual({ ...r.connector, id: 'x', createdAt: 'x', updatedAt: 'x' }, { id: 'x', merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, externalDomain: M1.source_domain, status: 'CONFIGURED', config: { apiVersion: '2024-10' }, createdAt: 'x', updatedAt: 'x' });
  assert.equal(table('merchant_connectors').length, 1);
});

test('list a merchant\'s connectors, get one by kind, resolve (kind, external_id) -> merchant', async () => {
  const { repo } = strictDb(M1, M2);
  await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' });
  await repo.link({ merchantId: M1.id, kind: 'bank', status: 'NOT_CONFIGURED' });
  await repo.link({ merchantId: M2.id, kind: 'shopify', externalId: M2.source_id, status: 'CONFIGURED' });
  assert.deepEqual((await repo.listForMerchant(M1.id)).map((c) => c.kind).sort(), ['bank', 'shopify']);
  assert.equal((await repo.getForMerchant(M1.id, 'shopify')).externalId, SHOP_A);
  assert.equal(await repo.getForMerchant(M1.id, 'peppol'), null);
  assert.equal((await repo.findMerchantByExternal('shopify', SHOP_A)).merchantId, M1.id);
  assert.equal((await repo.findMerchantByExternal('shopify', M2.source_id)).merchantId, M2.id);
  assert.equal(await repo.findMerchantByExternal('shopify', 'gid://shopify/Shop/NOBODY'), null);
});

test('the same Shopify shop can never be linked to two merchants', async () => {
  const { repo, table } = strictDb(M1, M2);
  await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' });
  await rejectsWith(repo.link({ merchantId: M2.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' }), C.CONNECTOR_EXTERNAL_TAKEN);
  assert.equal(table('merchant_connectors').length, 1);
  assert.equal((await repo.findMerchantByExternal('shopify', SHOP_A)).merchantId, M1.id, 'still owned by the first merchant');
});

test('a unique violation raised by the database (concurrent link) is mapped to the same rules', async () => {
  const { supabase, repo, table } = strictDb(M1, M2);
  await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' });
  // simulate the race: the pre-check sees nothing, the insert hits the constraint
  const blind = { ...supabase, select: async (t, p) => (t === 'merchant_connectors' && !blind.armed ? (blind.armed = true, []) : supabase.select(t, p)) };
  await rejectsWith(createConnectorRepository({ supabase: blind }).link({ merchantId: M2.id, kind: 'shopify', externalId: SHOP_A }), C.CONNECTOR_EXTERNAL_TAKEN);
  assert.equal(table('merchant_connectors').length, 1);
});

test('linking the same shop again to the same merchant is idempotent (no duplicate)', async () => {
  const { repo, table } = strictDb(M1);
  const a = await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' });
  const b = await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' });
  assert.equal(b.created, false); assert.equal(b.connector.id, a.connector.id);
  assert.equal(table('merchant_connectors').length, 1);
});

test('different connectors for the same merchant are allowed (shopify + bank + csv + peppol, several csv)', async () => {
  const { repo } = strictDb(M1);
  await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' });
  await repo.link({ merchantId: M1.id, kind: 'bank' });
  await repo.link({ merchantId: M1.id, kind: 'csv', config: { label: 'Export caisse' } });
  await repo.link({ merchantId: M1.id, kind: 'csv', config: { label: 'Export banque 2' } });
  await repo.link({ merchantId: M1.id, kind: 'peppol', externalId: '0208:0000000097' });
  assert.equal((await repo.listForMerchant(M1.id)).length, 5);
});

test('two different Shopify shops for one merchant: both stored and resolvable; getForMerchant refuses to pick one', async () => {
  const { repo } = strictDb(M1);
  await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' });
  await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A2, status: 'CONFIGURED' });
  assert.equal((await repo.listForMerchant(M1.id)).filter((c) => c.kind === 'shopify').length, 2);
  assert.equal((await repo.findMerchantByExternal('shopify', SHOP_A2)).merchantId, M1.id);
  const err = await repo.getForMerchant(M1.id, 'shopify').catch((e) => e);
  assert.equal(err.code, C.CONNECTOR_AMBIGUOUS); assert.equal(err.detail.count, 2);
});

test('kinds: open set (known list + any well-formed new kind); Shopify-like kinds require external_id', async () => {
  const { repo } = strictDb(M1);
  assert.deepEqual([...KNOWN_CONNECTOR_KINDS], ['shopify', 'woocommerce', 'prestashop', 'odoo', 'peppol', 'bank', 'csv']);
  assert.equal((await repo.link({ merchantId: M1.id, kind: 'future_crm' })).created, true, 'no code change needed for a new kind');
  for (const k of KINDS_REQUIRING_EXTERNAL_ID) await rejectsWith(repo.link({ merchantId: M1.id, kind: k }), C.CONNECTOR_EXTERNAL_ID_REQUIRED);
  for (const bad of ['Shopify', 'shop-ify', 's', '', '1abc', 'x'.repeat(41)]) await rejectsWith(repo.link({ merchantId: M1.id, kind: bad, externalId: 'z' }), C.CONNECTOR_KIND_INVALID);
  for (const bad of ['', '  ', ' padded ']) await rejectsWith(repo.link({ merchantId: M1.id, kind: 'shopify', externalId: bad }), C.CONNECTOR_EXTERNAL_ID_INVALID);
});

test('statuses: only CONFIGURED / NOT_CONFIGURED / MISCONFIGURED are stored; UNAVAILABLE is refused', async () => {
  const { repo } = strictDb(M1);
  assert.deepEqual([...PERSISTED_CONNECTOR_STATUSES], ['CONFIGURED', 'NOT_CONFIGURED', 'MISCONFIGURED']);
  assert.deepEqual([...CONNECTOR_STATES], ['CONFIGURED', 'NOT_CONFIGURED', 'MISCONFIGURED', 'UNAVAILABLE']);
  await rejectsWith(repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'UNAVAILABLE' }), C.CONNECTOR_STATUS_NOT_PERSISTABLE);
  await rejectsWith(repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'OK' }), C.CONNECTOR_STATUS_INVALID);
  const { connector } = await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A });
  assert.equal(connector.status, 'NOT_CONFIGURED', 'default is NOT_CONFIGURED');
  await rejectsWith(repo.update({ merchantId: M1.id, connectorId: connector.id, status: 'UNAVAILABLE' }), C.CONNECTOR_STATUS_NOT_PERSISTABLE);
});

test('update: status and non-secret config only, never identity fields, never another merchant\'s connector', async () => {
  const { repo, calls } = strictDb(M1, M2);
  const { connector } = await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' });
  const u = await repo.update({ merchantId: M1.id, connectorId: connector.id, status: 'MISCONFIGURED', config: { apiVersion: '2025-01' } });
  assert.deepEqual([u.status, u.config, u.externalId, u.merchantId], ['MISCONFIGURED', { apiVersion: '2025-01' }, SHOP_A, M1.id]);
  assert.ok(calls.filter((c) => c.m === 'update').every((c) => c.keys.every((k) => ['status', 'config', 'external_domain'].includes(k))));
  await rejectsWith(repo.update({ merchantId: M2.id, connectorId: connector.id, status: 'CONFIGURED' }), C.CONNECTOR_NOT_FOUND);
  assert.equal((await repo.getForMerchant(M1.id, 'shopify')).status, 'MISCONFIGURED', 'untouched by the other merchant');
});

test('link refuses an unknown or malformed merchant', async () => {
  const { repo } = strictDb(M1);
  await rejectsWith(repo.link({ merchantId: '11111111-2222-4333-8444-555555555555', kind: 'bank' }), C.MERCHANT_NOT_FOUND);
  await rejectsWith(repo.link({ merchantId: 'not-a-uuid', kind: 'bank' }), C.MERCHANT_ID_INVALID);
});

// ---------- config: never a secret ----------
test('config without secrets is accepted (and copied, not referenced)', () => {
  const cfg = { apiVersion: '2024-10', locationId: 'gid://shopify/Location/1', syncWindowDays: 60, features: { stock: false } };
  const out = validateConnectorConfig(cfg);
  assert.deepEqual(out, cfg); assert.notEqual(out, cfg);
});

test('config with a secret is refused - by key name at any depth, or by a credential-looking value; paths only, never values', async () => {
  for (const key of ['token', 'secret', 'password', 'api_key', 'apiKey', 'authorization', 'access_token', 'client_secret', 'Client-Secret', 'refreshToken', 'private_key', 'credentials', 'bearer', 'session_cookie']) {
    assert.throws(() => validateConnectorConfig({ [key]: 'x' }), (e) => e.code === C.CONNECTOR_CONFIG_SECRET && e.detail.paths.includes(key), key);
  }
  assert.deepEqual(findSecretPaths({ oauth: { nested: { clientSecret: 'x' } }, list: [{ apiKey: 'y' }] }), ['oauth.nested.clientSecret', 'list[0].apiKey']);
  // Credential-shaped samples are assembled at run time so no committed file contains one (test/finance-privacy.test.js guard).
  const credentialShaped = [`shp${'at'}_${'0'.repeat(20)}`, `sk_${'live'}_${'0'.repeat(8)}`, 'Bearer abc.def', `eyJ${'a'.repeat(24)}.${'b'.repeat(12)}.${'c'.repeat(8)}`, `-----${'BEGIN'} RSA PRIVATE KEY-----`];
  for (const value of credentialShaped) {
    assert.throws(() => validateConnectorConfig({ note: value }), (e) => e.code === C.CONNECTOR_CONFIG_SECRET && !JSON.stringify(e.detail).includes(value), value.slice(0, 8));
  }
  const { repo, table } = strictDb(M1);
  await rejectsWith(repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, config: { access_token: 'synthetic-not-a-token' } }), C.CONNECTOR_CONFIG_SECRET);
  assert.equal(table('merchant_connectors').length, 0, 'nothing stored');
  for (const bad of [null, [], 'text', 3]) assert.throws(() => validateConnectorConfig(bad), (e) => e.code === C.CONNECTOR_CONFIG_INVALID);
  assert.throws(() => validateConnectorConfig({ big: 'x'.repeat(20000) }), (e) => e.code === C.CONNECTOR_CONFIG_INVALID);
});

// ---------- backfill rule (mirror of the M1 SQL) ----------
const frozen = (o) => JSON.parse(JSON.stringify(o), (k, v) => (v && typeof v === 'object' ? Object.freeze(v) : v));

test('backfill: one Shopify merchant -> one CONFIGURED shopify connector with source_id / source_domain', () => {
  assert.deepEqual(planShopifyConnectorBackfill(frozen([M1])), [{ merchant_id: M1.id, kind: 'shopify', external_id: M1.source_id, external_domain: M1.source_domain, status: 'CONFIGURED', config: {} }]);
});

test('backfill: several merchants, run twice -> no duplicate; non-Shopify or blank source -> no invented connector; inputs untouched', () => {
  const blank = { ...M2, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', source_id: '   ' };
  const merchants = frozen([M1, M2, M3, blank]); const before = JSON.stringify(merchants);
  const first = planShopifyConnectorBackfill(merchants);
  assert.deepEqual(first.map((r) => r.merchant_id), [M1.id, M2.id]);
  assert.deepEqual(planShopifyConnectorBackfill(merchants, first), [], 'second run adds nothing');
  assert.equal(JSON.stringify(merchants), before, 'merchants (UUIDs, source_*) unchanged');
});

// ---------- M1 SQL contract ----------
test('M1 SQL: table, columns, open kind check, persisted statuses only, secret-free comment', () => {
  assert.match(SQL, /create table merchant_connectors \(/);
  for (const col of ['id uuid primary key', 'merchant_id uuid not null references merchants\\(id\\) on delete restrict', 'kind text not null', 'external_id text', 'external_domain text', 'status text not null', "config jsonb not null default '\\{\\}'::jsonb", 'created_at timestamptz not null', 'updated_at timestamptz not null']) assert.match(SQL, new RegExp(col), col);
  assert.match(SQL, /check \(kind ~ '\^\[a-z\]\[a-z0-9_\]\{1,39\}\$'\)/, 'format check, not an enum');
  assert.match(SQL, /check \(status in \('CONFIGURED', 'NOT_CONFIGURED', 'MISCONFIGURED'\)\)/);
  assert.doesNotMatch(SQL, /UNAVAILABLE/, 'UNAVAILABLE is never storable');
  assert.doesNotMatch(SQL, /create type/i, 'no SQL enum');
});

test('M1 SQL: UNIQUE(kind, external_id) + index (merchant_id, kind); the redundant 3-column unique is absent', () => {
  assert.match(SQL, /constraint merchant_connectors_kind_external_uq unique \(kind, external_id\)/);
  assert.match(SQL, /create index merchant_connectors_merchant_kind_idx on merchant_connectors \(merchant_id, kind\)/);
  assert.doesNotMatch(SQL, /unique\s*\(\s*merchant_id\s*,\s*kind\s*,\s*external_id\s*\)/i);
  assert.doesNotMatch(SQL, /create unique index/i);
});

test('M1 SQL: RLS enabled with no policy; identity-field guard; no change to merchants or any other table', () => {
  assert.match(SQL, /alter table merchant_connectors enable row level security;/);
  assert.doesNotMatch(SQL, /create policy/i);
  assert.match(SQL, /merchant_id, kind and external_id are immutable/);
  assert.match(SQL, /set search_path = ''/);
  // statements that write or alter a table: insert into X / update X set / delete from X / alter table X / drop / truncate
  const writes = [...SQL.matchAll(/\b(insert into|delete from|alter table|truncate)\s+([a-z_]+)|\bupdate\s+([a-z_]+)\s+set\b/gi)].map((m) => (m[3] ? `update ${m[3]}` : `${m[1].toLowerCase()} ${m[2]}`));
  assert.ok(writes.length >= 2);
  assert.ok(writes.every((w) => /merchant_connectors$/.test(w)), `only merchant_connectors is written/altered: ${writes.join(', ')}`);
  assert.doesNotMatch(SQL, /\bdrop\b|\btruncate\b|delete from/i);
});

test('M1 SQL: backfill = Shopify merchants only, source_id / source_domain, CONFIGURED, idempotent ON CONFLICT DO NOTHING', () => {
  assert.match(SQL, /insert into merchant_connectors \(merchant_id, kind, external_id, external_domain, status\)\s*select m\.id, 'shopify', m\.source_id, m\.source_domain, 'CONFIGURED'\s*from merchants m\s*where m\.source_system = 'shopify' and nullif\(btrim\(m\.source_id\), ''\) is not null\s*on conflict \(kind, external_id\) do nothing;/);
});

test('foreign key policy: a merchant with connectors cannot be deleted (RESTRICT); without connectors it can', async () => {
  assert.match(SQL, /references merchants\(id\) on delete restrict/);
  const { supabase, repo, table } = strictDb(M1, M3);
  await repo.link({ merchantId: M1.id, kind: 'bank' });
  await assert.rejects(supabase.delete('merchants', { id: `eq.${M1.id}` }), /23503/);
  assert.equal(table('merchant_connectors').length, 1, 'connector not cascaded away');
  await supabase.delete('merchants', { id: `eq.${M3.id}` });
  assert.equal(table('merchants').length, 1);
});

// ---------- isolation from business data and from Shopify ----------
test('the layer writes only merchant_connectors (merchants read-only), imports nothing, and never uses the network', async () => {
  const real = globalThis.fetch; const hits = []; globalThis.fetch = async (u) => { hits.push(String(u)); throw new Error('network forbidden'); };
  try {
    const { repo, calls, table } = strictDb(M1, M2); const merchantsBefore = JSON.stringify(table('merchants'));
    const { connector } = await repo.link({ merchantId: M1.id, kind: 'shopify', externalId: SHOP_A, status: 'CONFIGURED' });
    await repo.update({ merchantId: M1.id, connectorId: connector.id, config: { apiVersion: '2025-01' } });
    await repo.listForMerchant(M1.id); await repo.findMerchantByExternal('shopify', SHOP_A);
    assert.ok(calls.filter((c) => c.m !== 'select').every((c) => c.t === 'merchant_connectors'));
    assert.ok(calls.filter((c) => c.t === 'merchants').every((c) => c.m === 'select'));
    assert.equal(JSON.stringify(table('merchants')), merchantsBefore);
    assert.equal(hits.length, 0);
  } finally { globalThis.fetch = real; }
  const src = readFileSync(new URL('../src/tenant/connectors.js', import.meta.url), 'utf8');
  assert.equal([...src.matchAll(/^\s*import\s/gm)].length, 0);
  assert.doesNotMatch(src, /shopify\/client|SHOP_QUERY|graphql|fetch\(/);
});
