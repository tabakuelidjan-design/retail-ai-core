// M2 (ADR 0003): the static contract of the NON-DESTRUCTIVE migration that makes merchants' legacy external identity optional and
// deprecated (source_system / source_id lose NOT NULL; source_domain unchanged; the three columns and merchants_source_unique KEPT),
// of its read-only preflight and of its rollback - and the proof that src/ does not read those columns. Hermetic: file contents only
// (no git, no database). The SQL behaviour is exercised in a throwaway PostgreSQL before any application (runbook, "Validation").
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lf = (s) => s.replace(/\r\n?/g, '\n');
const read = (rel) => lf(readFileSync(path.join(ROOT, rel), 'utf8'));
const fp = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32); // 128-bit fingerprint (a full digest trips the secret scan)
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n'); // comments stripped

const MIGRATIONS = 'supabase/migrations';
const M2_FILE = '20260929170000_merchants_deprecate_legacy_identity.sql';
const M2 = read(`${MIGRATIONS}/${M2_FILE}`); const M2_CODE = code(M2);
const PREFLIGHT = read('docs/runbooks/m2-preflight.sql'); const ROLLBACK = read('docs/runbooks/m2-rollback.sql'); const ROLLBACK_CODE = code(ROLLBACK);

test('M1 and every migration before M2 are untouched; M2 is the latest; no destructive M2 file exists', () => {
  assert.equal(fp(read(`${MIGRATIONS}/20260927100000_merchant_connectors.sql`)), 'd60dd3b61f27bb9c791e46ac28a7f761', 'M1 = the file applied in production');
  const all = readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const before = all.filter((f) => f < M2_FILE);
  assert.equal(before.length, 27);
  assert.equal(fp(before.map((f) => `${f}\n${read(`${MIGRATIONS}/${f}`)}`).join('\n')), '530550cd8181628a8939c8dd1a9338b3');
  assert.ok(all.includes(M2_FILE), 'M2 is present (migrations added after M2 by the other lines are allowed: the integration branch carries provider_connections and channel_execution_jobs)');
  assert.equal(existsSync(path.join(ROOT, MIGRATIONS, '20260929170000_merchants_drop_legacy_identity.sql')), false, 'the destructive draft is gone');
});

test('no migration ever drops a merchants legacy column or merchants_source_unique', () => {
  for (const f of readdirSync(path.join(ROOT, MIGRATIONS)).filter((x) => x.endsWith('.sql'))) {
    const statements = code(read(`${MIGRATIONS}/${f}`)).split(';').map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase());
    for (const s of statements.filter((x) => /^alter table (public\.)?merchants\b/.test(x))) {
      assert.doesNotMatch(s, /drop column (if exists )?source_(system|id|domain)\b/, `${f}: ${s}`);
      assert.doesNotMatch(s, /drop constraint (if exists )?merchants_source_unique\b/, `${f}: ${s}`);
    }
    assert.doesNotMatch(statements.join(';'), /drop index (if exists )?(public\.)?merchants_source_unique\b/, f);
  }
});

test('M2 is non-destructive: no DROP COLUMN / CONSTRAINT / INDEX / TABLE, no CASCADE, no data written', () => {
  assert.doesNotMatch(M2_CODE, /\bdrop\s+(column|constraint|index|table|view|function|trigger|policy)\b/i);
  assert.doesNotMatch(M2_CODE, /\bcascade\b/i);
  assert.doesNotMatch(M2_CODE, /\b(insert\s+into|update\s+[\w.]+\s+set|delete\s+from|truncate|merge\s+into)\b/i);
  assert.doesNotMatch(M2_CODE, /\b(create|rename)\b/i);
});

test('M2 changes exactly two nullabilities and three comments on merchants, nothing on source_domain but its comment', () => {
  const alters = [...M2_CODE.matchAll(/alter table\s+[^;]+;/gi)].map((m) => m[0].replace(/\s+/g, ' ').trim());
  assert.deepEqual(alters, ['alter table public.merchants alter column source_system drop not null, alter column source_id drop not null;']);
  assert.doesNotMatch(M2_CODE, /alter\s+column\s+source_domain/i);
  for (const col of ['source_system', 'source_id', 'source_domain']) assert.match(M2, new RegExp(`comment on column public\\.merchants\\.${col} is\\n  'DEPRECATED \\(M2, ADR 0003\\)`), col);
  assert.equal([...M2_CODE.matchAll(/comment on column/gi)].length, 3);
  assert.match(M2_CODE, /lock table public\.merchant_connectors in share mode;/, 'connectors are read-locked, never written');
  assert.match(M2_CODE, /set local lock_timeout = '5s';/);
});

test('M2 checks the expected schema and the consistency with merchant_connectors BEFORE its ALTER, then a postcondition', () => {
  const alterAt = M2_CODE.indexOf('alter table public.merchants alter column');
  for (const r of ['merchant_connectors (M1) is missing', 'not in the expected state', "is_nullable = 'NO'", "column_name = 'source_domain' and is_nullable = 'YES'",
    "pg_get_constraintdef(oid) = 'UNIQUE (source_system, source_id)'", 'connector of another merchant', 'no matching connector']) {
    const at = M2_CODE.indexOf(r); assert.ok(at > 0 && at < alterAt, `before the ALTER: ${r}`);
  }
  assert.ok(M2_CODE.indexOf('connector of another merchant') < M2_CODE.indexOf('no matching connector'), 'the most specific diagnosis first');
  const post = M2_CODE.slice(M2_CODE.indexOf('$m2check$'));
  assert.match(post, /is_nullable = 'YES'\) <> 3/); assert.match(post, /merchants_source_unique/);
});

test('the identity kinds of M2 are exactly the connector kinds that require an external id', async () => {
  const { KINDS_REQUIRING_EXTERNAL_ID } = await import('../src/tenant/connectors.js');
  assert.ok(M2_CODE.includes(`array[${KINDS_REQUIRING_EXTERNAL_ID.map((k) => `'${k}'`).join(', ')}]`));
  assert.ok(code(PREFLIGHT).includes(`values ${KINDS_REQUIRING_EXTERNAL_ID.map((k) => `('${k}')`).join(', ')}`));
});

test('the preflight is read-only and reports every blocker M2 refuses on', () => {
  const sql = code(PREFLIGHT);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|lock|merge|comment)\b/i);
  for (const b of ['M1_MISSING', 'UNEXPECTED_COLUMN_STATE', 'UNEXPECTED_UNIQUE_CONSTRAINT', 'CONNECTOR_OF_ANOTHER_MERCHANT', 'NO_MATCHING_CONNECTOR']) assert.ok(sql.includes(`'${b}'`), b);
});

test('the rollback only restores the two NOT NULL, refuses on a NULL value, never invents an identity nor touches anything else', () => {
  const alters = [...ROLLBACK_CODE.matchAll(/alter table\s+[^;]+;/gi)].map((m) => m[0].replace(/\s+/g, ' ').trim());
  assert.deepEqual(alters, ['alter table public.merchants alter column source_system set not null, alter column source_id set not null;']);
  assert.match(ROLLBACK_CODE, /where source_system is null or source_id is null/);
  assert.match(ROLLBACK_CODE, /M2 rollback refused: % merchant\(s\) have a NULL source_system or source_id/);
  assert.ok(ROLLBACK_CODE.indexOf('M2 rollback refused') < ROLLBACK_CODE.indexOf('alter table'), 'the refusal comes before the ALTER');
  assert.doesNotMatch(ROLLBACK_CODE, /\b(insert\s+into|update\s+[\w.]+\s+set|delete\s+from|truncate|drop|cascade|merchant_connectors|nordla:)\b/i);
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
