// Core C1a - session timing configuration (src/identity/config.js) and the SQL contract of the C1a migration
// (supabase/migrations/20260928120000_identity_sessions_events.sql). The migration is NOT applied anywhere; these tests read its text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadIdentityConfig, IdentityConfigError, IDENTITY_ENV, IDENTITY_DEFAULTS } from '../src/identity/config.js';

// ---------- configuration ----------
test('config: defaults are 12 h absolute, 120 min inactivity, 5 min between activity writes', () => {
  const c = loadIdentityConfig({});
  assert.deepEqual({ ...c }, { absoluteHours: 12, idleMinutes: 120, touchMinutes: 5, absoluteMs: 43_200_000, idleMs: 7_200_000, touchMs: 300_000 });
  assert.ok(Object.isFrozen(c));
  assert.deepEqual(loadIdentityConfig({ NORDLA_SESSION_ABSOLUTE_HOURS: '', NORDLA_SESSION_IDLE_MINUTES: '  ' }), c, 'blank = default');
  assert.deepEqual(IDENTITY_DEFAULTS, { absoluteHours: 12, idleMinutes: 120, touchMinutes: 5 });
  assert.deepEqual(Object.values(IDENTITY_ENV), ['NORDLA_SESSION_ABSOLUTE_HOURS', 'NORDLA_SESSION_IDLE_MINUTES', 'NORDLA_SESSION_TOUCH_MINUTES']);
});

test('config: values inside the safe bounds are accepted', () => {
  const c = loadIdentityConfig({ NORDLA_SESSION_ABSOLUTE_HOURS: '8', NORDLA_SESSION_IDLE_MINUTES: '60', NORDLA_SESSION_TOUCH_MINUTES: '2' });
  assert.deepEqual([c.absoluteMs, c.idleMs, c.touchMs], [8 * 3_600_000, 3_600_000, 120_000]);
});

test('config: anything invalid refuses start-up, naming the variable and never repeating the value', () => {
  const cases = [
    ['NORDLA_SESSION_ABSOLUTE_HOURS', '13'], ['NORDLA_SESSION_ABSOLUTE_HOURS', '0'], ['NORDLA_SESSION_ABSOLUTE_HOURS', '12h'],
    ['NORDLA_SESSION_ABSOLUTE_HOURS', '1e1'], ['NORDLA_SESSION_ABSOLUTE_HOURS', '-3'], ['NORDLA_SESSION_ABSOLUTE_HOURS', '7.5'],
    ['NORDLA_SESSION_IDLE_MINUTES', '121'], ['NORDLA_SESSION_IDLE_MINUTES', '4'], ['NORDLA_SESSION_IDLE_MINUTES', 'zz9qx'],
    ['NORDLA_SESSION_TOUCH_MINUTES', '0'], ['NORDLA_SESSION_TOUCH_MINUTES', '11'],
  ];
  for (const [variable, value] of cases) {
    assert.throws(() => loadIdentityConfig({ [variable]: value }), (e) => e instanceof IdentityConfigError && e.code === 'IDENTITY_CONFIG_INVALID'
      && e.variable === variable && e.message.includes(variable) && !e.message.includes(`"${value}"`) && !e.message.includes(`=${value}`) && (value.length < 3 || !e.message.includes(value)), `${variable}=${value}`);
  }
  // cross-field rules
  assert.throws(() => loadIdentityConfig({ NORDLA_SESSION_ABSOLUTE_HOURS: '1', NORDLA_SESSION_IDLE_MINUTES: '90' }), (e) => e.variable === 'NORDLA_SESSION_IDLE_MINUTES');
  assert.throws(() => loadIdentityConfig({ NORDLA_SESSION_IDLE_MINUTES: '10', NORDLA_SESSION_TOUCH_MINUTES: '10' }), (e) => e.variable === 'NORDLA_SESSION_TOUCH_MINUTES');
});

test('config: holds durations only - no secret, no Supabase key, no token', () => {
  const src = readFileSync(new URL('../src/identity/config.js', import.meta.url), 'utf8');
  for (const word of ['SUPABASE', 'SECRET', 'PASSWORD', 'process.env.']) assert.ok(!src.includes(word), `config.js must not mention ${word}`);
});

// ---------- migration contract ----------
const FILE = '20260928120000_identity_sessions_events.sql';
const RAW = readFileSync(new URL(`../supabase/migrations/${FILE}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const SQL = RAW.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n'); // code only, comments stripped
const tableBody = (name) => new RegExp(`create table ${name} \\(([\\s\\S]*?)\\n\\);`).exec(SQL)[1];

test('migration: the file exists, says it is not applied, and touches no existing table', () => {
  assert.ok(readdirSync(new URL('../supabase/migrations/', import.meta.url)).includes(FILE));
  assert.match(RAW, /NOT APPLIED anywhere/);
  assert.deepEqual([...SQL.matchAll(/create table (\w+)/g)].map((m) => m[1]), ['app_sessions', 'identity_events']);
  assert.ok(!/alter table (?!app_sessions|identity_events)\w+/.test(SQL), 'no ALTER of an existing table');
  assert.ok(!/\bdrop\b/i.test(SQL) && !/\binsert\s+into\b/i.test(SQL) && !/\bupdate\s+\w+\s+set\b/i.test(SQL), 'no DROP, no data written');
});

test('migration: app_sessions has the required columns, a unique 64-hex token hash and never a raw token', () => {
  const body = tableBody('app_sessions');
  for (const col of ['id uuid primary key', 'merchant_id uuid not null references merchants', 'user_id uuid not null references auth.users', 'module text not null', 'token_hash text not null', 'created_at timestamptz not null', 'last_seen_at timestamptz not null', 'expires_at timestamptz not null', 'revoked_at timestamptz', 'revoked_reason text']) {
    assert.ok(body.includes(col), `app_sessions: ${col}`);
  }
  assert.match(body, /unique \(token_hash\)/);
  assert.match(body, /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(body, /expires_at <= created_at \+ interval '12 hours'/);
  assert.match(body, /\(revoked_at is null\) = \(revoked_reason is null\)/);
  const columns = body.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => c && !/^(constraint|\))/.test(c));
  assert.ok(!columns.some((c) => /^(token|session_token|refresh_token|access_token|password|email|cookie)$/.test(c)), `no raw secret column: ${columns}`);
});

test('migration: indexes for token lookup, log-out-everywhere, merchant isolation and expiry clean-up', () => {
  assert.match(SQL, /create index app_sessions_user_active_idx on app_sessions \(user_id\) where revoked_at is null;/);
  assert.match(SQL, /create index app_sessions_merchant_user_idx on app_sessions \(merchant_id, user_id\);/);
  assert.match(SQL, /create index app_sessions_expires_idx on app_sessions \(expires_at\);/);
  assert.match(SQL, /create index app_sessions_last_seen_active_idx on app_sessions \(last_seen_at\) where revoked_at is null;/);
  assert.match(SQL, /create index app_sessions_revoked_idx on app_sessions \(revoked_at\) where revoked_at is not null;/);
  assert.ok(!/cron|pg_cron|schedule/i.test(SQL), 'no clean-up job in C1a');
});

test('migration: session identity is immutable, last_seen_at only moves forward, a revocation is final (database trigger)', () => {
  assert.match(SQL, /create trigger app_sessions_guard_trg before update on app_sessions for each row execute function app_sessions_guard\(\);/);
  const fn = /create function app_sessions_guard\(\)[\s\S]*?\$\$;/.exec(SQL)[0];
  for (const col of ['merchant_id', 'user_id', 'module', 'token_hash', 'created_at', 'expires_at']) assert.ok(fn.includes(`new.${col} is distinct from old.${col}`), col);
  assert.ok(fn.includes('new.last_seen_at < old.last_seen_at'));
  assert.ok(fn.includes('old.revoked_at is not null'));
});

test('migration: identity_events is append-only IN THE DATABASE (triggers + revoked privileges) and has the required columns', () => {
  const body = tableBody('identity_events');
  for (const col of ['id bigint generated always as identity primary key', 'occurred_at timestamptz not null', 'merchant_id uuid not null references merchants', 'user_id uuid', 'session_id uuid', 'module text not null', 'event_type text not null', 'outcome text not null', 'correlation_id uuid not null', 'entity_type text', 'entity_id text', 'detail jsonb not null']) {
    assert.ok(body.includes(col), `identity_events: ${col}`);
  }
  assert.ok(!/references auth\.users/.test(body), 'the journal outlives users: no foreign key to auth.users');
  assert.match(SQL, /before update or delete on identity_events for each row execute function identity_events_append_only\(\)/);
  assert.match(SQL, /before truncate on identity_events for each statement execute function identity_events_append_only\(\)/);
  assert.match(SQL, /revoke update, delete, truncate on table identity_events from service_role;/);
  assert.match(body, /octet_length\(detail::text\) <= 4096/);
  assert.match(body, /identity_events_no_email_ck/);
  const columns = body.split('\n').map((l) => l.trim().split(/\s+/)[0]);
  assert.ok(!columns.some((c) => /mail|password|token|cookie|secret/i.test(c)), 'no e-mail or secret column in the journal');
});

test('migration: RLS enabled on both tables, no policy, no privilege for anon / authenticated', () => {
  assert.match(SQL, /alter table app_sessions enable row level security;/);
  assert.match(SQL, /alter table identity_events enable row level security;/);
  assert.ok(!/create policy/i.test(SQL), 'no policy in C1a');
  assert.match(SQL, /revoke all on table app_sessions from anon, authenticated;/);
  assert.match(SQL, /revoke all on table identity_events from anon, authenticated;/);
  assert.ok(!/\bgrant\b/i.test(SQL), 'nothing is granted');
});

// ---------- C1b migration contract (identity_rate_limits) ----------
const RL_FILE = '20260928130000_identity_rate_limits.sql';
const RL_RAW = readFileSync(new URL(`../supabase/migrations/${RL_FILE}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const RL = RL_RAW.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('C1b migration: not applied, additive, HMAC subjects only (no e-mail / IP column), RLS without policy', () => {
  assert.match(RL_RAW, /NOT APPLIED anywhere/);
  assert.deepEqual([...RL.matchAll(/create table (\w+)/g)].map((m) => m[1]), ['identity_rate_limits']);
  assert.ok(!/\bdrop\b/i.test(RL) && !/\binsert\s+into\s+(?!public\.identity_rate_limits)/i.test(RL), 'no DROP, no write outside its own table');
  const body = /create table identity_rate_limits \(([\s\S]*?)\n\);/.exec(RL)[1];
  const columns = body.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => c && !/^(primary|\))/.test(c));
  assert.deepEqual(columns, ['dimension', 'subject_hmac', 'window_started_at', 'failures', 'blocked_until', 'updated_at']);
  assert.match(body, /subject_hmac ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(body, /dimension in \('email', 'ip'\)/);
  assert.match(body, /primary key \(dimension, subject_hmac\)/);
  assert.match(RL, /create index identity_rate_limits_updated_idx on identity_rate_limits \(updated_at\);/);
  assert.match(RL, /create index identity_rate_limits_blocked_idx on identity_rate_limits \(blocked_until\) where blocked_until is not null;/);
  assert.match(RL, /alter table identity_rate_limits enable row level security;/);
  assert.ok(!/create policy/i.test(RL) && !/\bgrant\b/i.test(RL));
  assert.match(RL, /revoke all on table identity_rate_limits from anon, authenticated;/);
  assert.match(RL, /revoke execute on function identity_rate_limit_record_failure\([^)]*\) from public, anon, authenticated;/);
  assert.match(RL, /security invoker set search_path = ''/);
  assert.ok(!/cron|schedule/i.test(RL), 'no clean-up job in C1b');
});
