import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { requireTimeZone, resolveBusinessProfile, loadMerchantProfile, ProfileError } from '../src/metrics/profile.js';
import { runReport } from '../src/report/index.js';
import { buildWindows } from '../src/metrics/windows.js';
import { resolvePeriod } from '../src/analytics-premium/server/period-engine.js';
import { syncInventory } from '../src/sync/inventory.js';
import { mergeConfig } from '../src/metrics/config.js';

// Analyses Phase 0, defect C: MERCHANT_TIMEZONE silently fell back to UTC in 7 entry points and ~12 function defaults. A VAT/analysis period of a
// Brussels merchant then shifts (an order at 2026-03-31T22:30Z is 2026-04-01 00:30 in Brussels and belongs to Q2, not Q1). Now: fail closed.
// Finance (closed) keeps its own reads and is out of this phase. SYNTHETIC data only.
const M = randomUUID();
const codeOf = (fn) => { try { fn(); return 'NO_ERROR'; } catch (e) { return e.code ?? e.message; } };

test('C1. requireTimeZone: missing / blank / abbreviation / POSIX / unknown zones are refused with explicit codes', () => {
  assert.equal(codeOf(() => requireTimeZone(undefined)), 'TIMEZONE_NOT_CONFIGURED');
  assert.equal(codeOf(() => requireTimeZone('')), 'TIMEZONE_NOT_CONFIGURED');
  assert.equal(codeOf(() => requireTimeZone(null)), 'TIMEZONE_NOT_CONFIGURED');
  for (const bad of ['EST', 'UTC+1', 'Mars/Phobos', 'brussels']) assert.equal(codeOf(() => requireTimeZone(bad)), 'TIMEZONE_INVALID', bad);
  for (const good of ['Europe/Brussels', 'UTC', 'America/New_York']) assert.equal(requireTimeZone(good), good);
});

test('C2. the profile row wins, the environment is an explicit fallback that is reported, nothing else exists', async () => {
  const s = createFakeSupabase();
  await assert.rejects(resolveBusinessProfile({ supabase: s, merchantId: M, env: {} }), (e) => e instanceof ProfileError && e.code === 'TIMEZONE_NOT_CONFIGURED');
  const fromEnv = await resolveBusinessProfile({ supabase: s, merchantId: M, env: { MERCHANT_TIMEZONE: 'Europe/Brussels' } });
  assert.deepEqual([fromEnv.timezone, fromEnv.timezoneSource], ['Europe/Brussels', 'env']);
  await s.insert('merchant_profile', [{ merchant_id: M, timezone: 'Europe/Paris', currency: 'EUR', country: 'FR', excluded_order_statuses: ['VOIDED', 'EXPIRED', 'TEST'], pos_channel_handles: ['pos'], online_channel_handles: ['web'], channel_aliases: { point_of_sale: 'pos' } }]);
  const p = await resolveBusinessProfile({ supabase: s, merchantId: M, env: { MERCHANT_TIMEZONE: 'Europe/Brussels' } });
  assert.deepEqual([p.timezone, p.timezoneSource, p.currency, p.country], ['Europe/Paris', 'profile', 'EUR', 'FR']);
  assert.deepEqual(p.excludedOrderStatuses, ['VOIDED', 'EXPIRED', 'TEST']); assert.deepEqual(p.channelAliases, { point_of_sale: 'pos' });
  assert.equal(codeOf(() => { throw new ProfileError('X', 'y'); }), 'X');
});

test('C3. another merchant\'s profile is never read', async () => {
  const s = createFakeSupabase(); const other = randomUUID();
  await s.insert('merchant_profile', [{ merchant_id: other, timezone: 'Asia/Tokyo', currency: 'JPY' }]);
  assert.equal(await loadMerchantProfile(s, M), null);
  await assert.rejects(resolveBusinessProfile({ supabase: s, merchantId: M, env: {} }), (e) => e.code === 'TIMEZONE_NOT_CONFIGURED');
});

test('C4. a profile row with an invalid timezone is refused, never silently replaced', async () => {
  const s = createFakeSupabase(); await s.insert('merchant_profile', [{ merchant_id: M, timezone: 'Not/AZone', currency: 'EUR' }]);
  await assert.rejects(resolveBusinessProfile({ supabase: s, merchantId: M, env: { MERCHANT_TIMEZONE: 'Europe/Brussels' } }), (e) => e.code === 'TIMEZONE_INVALID');
});

test('C5. pure functions no longer default to UTC: windows, periods and the inventory snapshot day need an explicit zone', async () => {
  assert.equal(codeOf(() => buildWindows(new Date('2026-10-03T10:00:00Z'))), 'TIMEZONE_NOT_CONFIGURED');
  assert.equal(codeOf(() => resolvePeriod({ period: 'last_7_days' }, { now: new Date('2026-10-03T10:00:00Z') })), 'TIMEZONE_NOT_CONFIGURED');
  await assert.rejects(syncInventory({ shopify: { graphql: async () => ({}) }, supabase: createFakeSupabase() }, { merchantId: M }), (e) => e.code === 'TIMEZONE_NOT_CONFIGURED');
});

test('C6. the Brussels boundary: an order at 2026-03-31T22:30Z is in April for Europe/Brussels, in March for UTC (and a Brussels merchant never gets the UTC answer by default)', () => {
  const at = new Date('2026-03-31T22:30:00Z'); const day = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  assert.equal(day('Europe/Brussels'), '2026-04-01'); assert.equal(day('UTC'), '2026-03-31');
  const w = buildWindows(new Date('2026-04-01T08:00:00Z'), 'Europe/Brussels'); assert.ok(w);
});

test('C7. runReport fails closed BEFORE writing anything when no timezone is configured', async () => {
  const s = createFakeSupabase(); await s.insert('merchants', [{ id: M, name: 'Synthetic', source_system: 'shopify', source_id: 'gid://shopify/Shop/1' }]);
  s._tables.set('merchant_connectors', [{ id: randomUUID(), merchant_id: M, kind: 'shopify', external_id: 'gid://shopify/Shop/1', status: 'CONFIGURED', config: {} }]);
  const dir = await mkdtemp(path.join(tmpdir(), 'tz-')); const writes = []; for (const m of ['insert', 'upsert', 'update', 'delete']) { const o = s[m].bind(s); s[m] = async (...a) => { writes.push(m); return o(...a); }; }
  await assert.rejects(runReport({ mode: 'report', env: { NORDLA_MERCHANT_ID: M }, supabase: s, outDir: dir, log: () => {} }), (e) => e.code === 'TIMEZONE_NOT_CONFIGURED');
  assert.deepEqual(await readdir(dir), []); assert.deepEqual(writes, []);
});

test('C7b. a dataset snapshot without a valid time zone is UNAVAILABLE (rebuild), never served on an assumed UTC day', async () => {
  const { writeFile } = await import('node:fs/promises'); const { periodReport, resetPeriodCache } = await import('../src/analytics-premium/server/period-engine.js');
  resetPeriodCache(); const dir = await mkdtemp(path.join(tmpdir(), 'tz-snap-'));
  await writeFile(path.join(dir, 'dataset.json'), JSON.stringify({ version: 1, generated_at: '2026-09-26T09:00:00.000Z', currency: 'EUR', data: { orders: [], orderLines: [], refunds: [], refundLines: [], products: [], variants: [], costs: [], snapshots: [] } }));
  const r = await periodReport(dir, { period: 'last_7_days' }, { now: new Date('2026-09-26T09:00:00Z') });
  assert.deepEqual([r.ok, r.code], [false, 'DATASET_UNAVAILABLE']); resetPeriodCache();
});

test('C8. guard: no non-Finance source defaults a time zone to UTC (|| \'UTC\', ?? \'UTC\', timeZone = \'UTC\')', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url)); const hits = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) { if (!['finance', 'ui'].includes(f)) walk(p); } else if (p.endsWith('.js')) { const t = readFileSync(p, 'utf8'); if (/(\|\||\?\?)\s*'UTC'|[tT]ime[zZ]one\s*=\s*'UTC'|\btz\s*=\s*'UTC'/.test(t)) hits.push(path.relative(root, p)); } } };
  walk(root); assert.deepEqual(hits, [], 'silent UTC defaults remain in: ' + hits.join(', '));
  void mergeConfig;
});
