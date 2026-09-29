// M2 (ADR 0003): the static contract of the migration that removes merchants' legacy external identity (source_system, source_id,
// source_domain, merchants_source_unique), of its read-only preflight and of its rollback - and the proof that src/ no longer reads
// those columns. Hermetic: file contents only (no git, no database). The SQL behaviour itself is exercised in a throwaway PostgreSQL
// before any application (see docs/runbooks/m2-merchants-legacy-identity.md, "Validation").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lf = (s) => s.replace(/\r\n?/g, '\n');
const read = (rel) => lf(readFileSync(path.join(ROOT, rel), 'utf8'));
const fp = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32); // 128-bit fingerprint (a full digest trips the secret scan)
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n'); // comments stripped

const M2_FILE = '20260929170000_merchants_drop_legacy_identity.sql';
const M2 = read(`supabase/migrations/${M2_FILE}`); const M2_CODE = code(M2);
const PREFLIGHT = read('docs/runbooks/m2-preflight.sql'); const ROLLBACK = read('docs/runbooks/m2-rollback.sql');

test('M1 and every migration before M2 are untouched (content fingerprints of the applied files)', () => {
  assert.equal(fp(read('supabase/migrations/20260927100000_merchant_connectors.sql')), 'd60dd3b61f27bb9c791e46ac28a7f761', 'M1 = the file applied in production');
  const files = readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql') && f < M2_FILE).sort();
  assert.equal(files.length, 27);
  assert.equal(fp(files.map((f) => `${f}\n${read(`supabase/migrations/${f}`)}`).join('\n')), '530550cd8181628a8939c8dd1a9338b3');
  assert.equal(readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort().at(-1), M2_FILE, 'M2 is the latest migration');
});

test('M2 removes exactly the legacy identity of merchants: one constraint, three columns, RESTRICT (no CASCADE)', () => {
  assert.match(M2_CODE, /alter table public\.merchants drop constraint merchants_source_unique;/);
  assert.match(M2_CODE, /alter table public\.merchants drop column source_domain, drop column source_id, drop column source_system;/);
  assert.doesNotMatch(M2_CODE, /cascade/i);
  const alters = [...M2_CODE.matchAll(/alter table\s+([\w.]+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(alters)], ['public.merchants'], 'no other table is altered');
  assert.doesNotMatch(M2_CODE, /\b(create|drop)\s+(table|view|function|trigger|index|policy)\b/i);
  assert.doesNotMatch(M2_CODE, /\bdrop\s+column\s+(?!source_(domain|id|system)\b)/i);
});

test('M2 writes no data: no insert / update / delete / truncate / merge, merchants UUIDs and connectors untouched', () => {
  assert.doesNotMatch(M2_CODE, /\b(insert\s+into|update\s+[\w.]+\s+set|delete\s+from|truncate|merge\s+into)\b/i);
  assert.match(M2_CODE, /lock table public\.merchants in access exclusive mode;/);
  assert.match(M2_CODE, /lock table public\.merchant_connectors in share mode;/, 'connectors are read-locked, never written');
  assert.match(M2_CODE, /set local lock_timeout = '5s';/);
});

test('M2 checks everything BEFORE the first drop, each refusal is explicit, and a postcondition closes it', () => {
  const firstDrop = M2_CODE.indexOf('drop constraint');
  const refusals = ['merchant_connectors (M1) is missing', 'not in the expected state', 'linked to a connector of another merchant', 'no matching connector',
    'ambiguous identity', 'duplicated legacy identity', 'differs from its connector external_domain', 'cannot be rebuilt', 'other object(s) depend', 'may use the legacy columns'];
  for (const r of refusals) {
    const at = M2_CODE.indexOf(r);
    assert.ok(at > 0, `refusal present: ${r}`); assert.ok(at < firstDrop, `checked before any drop: ${r}`);
  }
  assert.ok(M2_CODE.indexOf('connector of another merchant') < M2_CODE.indexOf('no matching connector'), 'the most specific diagnosis first');
  assert.ok(M2_CODE.indexOf('postcondition failed') > firstDrop);
  assert.match(M2_CODE, /array\['shopify', 'woocommerce', 'prestashop', 'odoo'\]/, 'the kinds with a natural external id');
  assert.match(M2_CODE, /'nordla:' \|\| m\.id::text/, 'the only accepted value without an external identity: the canonical placeholder');
});

test('the identity kinds of M2 are exactly the connector kinds that require an external id', async () => {
  const { KINDS_REQUIRING_EXTERNAL_ID } = await import('../src/tenant/connectors.js');
  for (const sql of [M2_CODE, code(ROLLBACK)]) assert.ok(sql.includes(`array[${KINDS_REQUIRING_EXTERNAL_ID.map((k) => `'${k}'`).join(', ')}]`));
});

test('the preflight is read-only and reports every blocker M2 refuses on', () => {
  const sql = code(PREFLIGHT);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|lock|merge|comment)\b/i);
  for (const b of ['CONNECTOR_OF_ANOTHER_MERCHANT', 'NO_MATCHING_CONNECTOR', 'SEVERAL_CONNECTORS_OF_IDENTITY_KIND', 'DUPLICATED_LEGACY_IDENTITY', 'DOMAIN_NOT_REBUILDABLE',
    'NON_REBUILDABLE_LEGACY_VALUE', 'OTHER_DEPENDENT_OBJECT', 'FUNCTION_MAY_USE_LEGACY_COLUMNS']) assert.ok(sql.includes(`'${b}'`), b);
});

test('the rollback never writes a connector or a business table, never changes an id, and refuses to choose', () => {
  const sql = code(ROLLBACK);
  assert.doesNotMatch(sql, /(insert\s+into|update|delete\s+from|truncate)\s+public\.(?!merchants\b)/i);
  assert.doesNotMatch(sql, /set\s+id\s*=|\bid\s*=\s*gen_random_uuid/i);
  assert.match(sql, /M2 rollback refused: .* several external connectors and no proof row/);
  assert.match(sql, /pg_temp\.m2_proof/, 'the pre-M2 proof, when loaded, wins over any rebuild');
  assert.match(sql, /add constraint merchants_source_unique unique \(source_system, source_id\);/);
  assert.match(sql, /alter column source_system set not null;[\s\S]*alter column source_id set not null;/);
});

test('src/ reads no legacy merchant identity: merchants is only ever selected by id, for id / name / vertical', () => {
  const files = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(ROOT, 'src'));
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8'); const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (/source_domain/.test(src)) offenders.push(`${rel}: source_domain`);
    for (const m of src.matchAll(/\.(select|selectAll|insert|upsert|update|delete)\(\s*'merchants'\s*,([^)]*)\)/g)) {
      if (m[1] !== 'select') offenders.push(`${rel}: writes merchants (${m[1]})`);
      const cols = /select:\s*'([^']*)'/.exec(m[2])?.[1] ?? '*';
      if (cols.split(',').some((c) => !['id', 'name', 'vertical'].includes(c.trim()))) offenders.push(`${rel}: selects merchants columns "${cols}"`);
      if (/source_/.test(m[2])) offenders.push(`${rel}: filters merchants on a source column`);
    }
  }
  assert.deepEqual(offenders, []);
  // the identity layer never mentions a source column at all (Finance's runtime legitimately reads orders.source_id - an ORDER's
  // Shopify number, business data - so it is covered by the merchants-access rule above instead)
  for (const rel of ['src/tenant/index.js', 'src/tenant/connectors.js', 'src/tenant/tool-context.js', 'src/sync/tenant-context.js', 'src/analytics-premium/server/tenant.js', 'src/connectors/shopify.js']) {
    assert.doesNotMatch(code(read(rel).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), /source_(system|id|domain)/, rel);
  }
});
