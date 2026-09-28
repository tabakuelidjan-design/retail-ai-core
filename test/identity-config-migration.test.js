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
  assert.deepEqual([...RL.matchAll(/create table (\w+)/g)].map((m) => m[1]), ['identity_rate_limits', 'identity_auth_reservations']);
  assert.ok(!/\bdrop\b/i.test(RL) && !/\binsert\s+into\s+(?!public\.identity_(rate_limits|auth_reservations))/i.test(RL), 'no DROP, no write outside its own tables');
  const body = /create table identity_rate_limits \(([\s\S]*?)\n\);/.exec(RL)[1];
  const columns = body.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => c && !/^(primary|\))/.test(c));
  assert.deepEqual(columns, ['dimension', 'subject_hmac', 'window_started_at', 'failures', 'blocked_until', 'updated_at']);
  assert.match(body, /subject_hmac ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(body, /dimension in \('email', 'ip'\)/);
  assert.match(body, /primary key \(dimension, subject_hmac\)/);
  assert.match(RL, /create index identity_rate_limits_updated_idx on identity_rate_limits \(updated_at\);/);
  assert.match(RL, /create index identity_rate_limits_blocked_idx on identity_rate_limits \(blocked_until\) where blocked_until is not null;/);
  const res = /create table identity_auth_reservations \(([\s\S]*?)\n\);/.exec(RL)[1];
  const resCols = res.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => c && !/^(constraint|\))/.test(c));
  assert.deepEqual(resCols, ['id', 'email_subject', 'ip_subject', 'reserved_at', 'expires_at']);
  assert.match(res, /email_subject ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(res, /expires_at <= reserved_at \+ interval '5 minutes'/);
  for (const idx of ['identity_auth_reservations_email_idx', 'identity_auth_reservations_ip_idx', 'identity_auth_reservations_expires_idx']) assert.ok(RL.includes(`create index ${idx}`), idx);
  for (const t of ['identity_rate_limits', 'identity_auth_reservations']) {
    assert.match(RL, new RegExp(`alter table ${t} enable row level security;`));
    assert.match(RL, new RegExp(`revoke all on table ${t} from anon, authenticated;`));
  }
  assert.ok(!/create policy/i.test(RL) && !/\bgrant\b/i.test(RL));
  for (const fn of ['identity_rate_limit_check_args', 'identity_auth_reserve', 'identity_auth_settle']) {
    assert.match(RL, new RegExp(`revoke execute on function ${fn}\\([^)]*\\) from public, anon, authenticated;`), fn);
  }
  assert.ok(!/identity_rate_limit_record_failure/.test(RL), 'the non-atomic check-then-count function is gone');
  assert.equal((RL.match(/security invoker set search_path = ''/g) ?? []).length, 2);
  // atomicity: both counter rows are locked, always e-mail before IP (no deadlock), before counting and reserving
  const reserve = /create function identity_auth_reserve\([\s\S]*?\$\$;/.exec(RL)[0];
  const lockE = reserve.indexOf("where dimension = 'email' and subject_hmac = p_email_subject for update");
  const lockI = reserve.indexOf("where dimension = 'ip' and subject_hmac = p_ip_subject for update");
  assert.ok(lockE > 0 && lockI > lockE && reserve.indexOf('insert into public.identity_auth_reservations') > lockI, 'lock e-mail, then IP, then reserve');
  assert.ok(!/cron|schedule/i.test(RL), 'no clean-up job in C1b');
});

// ---------- C2 migration contract (merchant_members) ----------
const MM_RAW = readFileSync(new URL('../supabase/migrations/20260928140000_identity_members.sql', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const MM = MM_RAW.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('C2 migration: not applied, additive, one table; roles, statuses, suspended_at, one membership per merchant and user', () => {
  assert.match(MM_RAW, /NOT APPLIED anywhere/);
  assert.deepEqual([...MM.matchAll(/create table (\w+)/g)].map((m) => m[1]), ['merchant_members']);
  assert.ok(!/\bdrop\b/i.test(MM) && !/alter table (?!merchant_members)\w+/.test(MM), 'no DROP, no change to an existing table');
  const body = /create table merchant_members \(([\s\S]*?)\n\);/.exec(MM)[1];
  assert.match(body, /role text not null check \(role in \('OWNER', 'ADMIN', 'COLLABORATOR', 'VIEWER', 'ACCOUNTANT'\)\)/);
  assert.match(body, /status text not null check \(status in \('ACTIVE', 'SUSPENDED'\)\)/);
  assert.match(body, /\(status = 'SUSPENDED'\) = \(suspended_at is not null\)/);
  assert.match(body, /primary key \(merchant_id, user_id\)/);
  assert.match(body, /merchant_id uuid not null references merchants\(id\) on delete restrict/);
  assert.match(body, /user_id uuid not null references auth\.users\(id\) on delete restrict/);
  const cols = body.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => c && !/^(primary|constraint|\))/.test(c));
  assert.deepEqual(cols, ['merchant_id', 'user_id', 'role', 'status', 'created_at', 'updated_at', 'suspended_at', 'created_by', 'updated_by']);
  assert.ok(!cols.some((c) => /mail|name|phone|token/.test(c)), 'no personal data column');
});

test('C2 migration: writes only through two audited functions; last OWNER and no-delete guarded in the database; RLS without policy', () => {
  assert.match(MM, /revoke insert, update, delete, truncate on table merchant_members from service_role;/);
  assert.match(MM, /revoke all on table merchant_members from anon, authenticated;/);
  assert.match(MM, /alter table merchant_members enable row level security;/);
  assert.ok(!/create policy/i.test(MM) && !/\bgrant\b/i.test(MM));
  for (const fn of ['identity_member_bootstrap_owner', 'identity_member_apply']) {
    const start = MM.indexOf(`create function ${fn}(`);
    const def = MM.slice(start, MM.indexOf('$$;', start) + 3);
    assert.ok(start > 0 && def.length > 50, `${fn} defined`);
    assert.match(def, /security definer set search_path = ''/, fn);
    assert.ok(def.indexOf('identity_member_lock(p_merchant)') > 0, `${fn} takes the per-merchant lock`);
    assert.ok(def.includes('insert into public.identity_events'), `${fn} journals in the same transaction`);
    assert.ok(MM.split('\n').some((l) => l.startsWith(`revoke execute on function ${fn}(`) && l.trim().endsWith(') from public, anon, authenticated;')), `${fn} not executable by public / anon / authenticated`);
  }
  assert.match(MM, /revoke execute on function identity_member_lock\(uuid\) from public, anon, authenticated, service_role;/);
  const guard = /create function merchant_members_guard\(\)[\s\S]*?\$\$;/.exec(MM)[0];
  assert.ok(guard.includes("if tg_op = 'DELETE' then") && guard.includes('identity_member_lock(old.merchant_id)') && guard.includes('the last active owner'));
  assert.match(MM, /before update or delete on merchant_members for each row execute function merchant_members_guard\(\)/);
  assert.match(MM, /before truncate on merchant_members for each statement/);
  assert.ok(!/app_sessions|module_entitlements|shopify|source_id/i.test(MM), 'no session, no module, no Shopify');
});
