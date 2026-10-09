// REAL PostgreSQL + REAL Supabase Vault smoke test of supabase/migrations/20261009200000_provider_connections.sql.
//
// No simulation. It starts a throwaway `supabase/postgres` container (the Supabase image: real `vault` extension, real anon / authenticated /
// service_role roles), applies EVERY migration of the repository in order, then exercises the tables, the guards and the SECURITY DEFINER
// Vault functions with real SQL - including two concurrent sessions racing for one OAuth callback and for one credential rotation, and the
// proof that a token is encrypted in vault.secrets and appears in no table. The only stub is the Supabase-platform `storage` schema when the
// image does not ship it (an unrelated finance migration inserts into storage.buckets); nothing of this feature is stubbed.
//
//   node test/postgres/provider-connections.pg-smoke.mjs        (needs Docker; not part of `npm test`)
//
// Exit code 0 only if every check passes. KEEP_PG_SMOKE=1 keeps the container. PG_SMOKE_IMAGE overrides the image.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = `${ROOT}supabase/migrations/`;
const IMAGE = process.env.PG_SMOKE_IMAGE ?? 'supabase/postgres:17.6.1.054';
const NAME = 'nordla-pg-smoke-provider';
const results = [];

const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8' });
if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
  console.error('STOP: Docker is not available - a real PostgreSQL with the Supabase Vault is required for this smoke test (no in-memory substitute).');
  process.exit(2);
}

const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
/** Runs SQL through psql in the container. ok=false (with stderr) when PostgreSQL raises an error. */
function sql(text) {
  const r = docker(PSQL, text);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
/** Same, but as another role (the way PostgREST connects): the statements run after `set role`. */
/** The Supabase image owns its platform schemas with supabase_admin: used only for the one storage stub below. */
const admin = (text) => { const r = docker(['exec', '-i', '-e', 'PGPASSWORD=smoke', NAME, 'psql', '-U', 'supabase_admin', '-h', 'localhost', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], text); return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
/** Only the last result line of a multi-statement script. */
const last = (r) => ({ ...r, out: r.out.split('\n').pop() });
const as = (role, text) => sql(`set role ${role};\n${text}`);
function sqlAsync(text, delayMs = 0) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const p = spawn('docker', PSQL);
      let out = ''; let err = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
      p.stdin.end(text);
    }, delayMs);
  });
}
const check = (name, pass, detail = '') => { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  -> ${detail}`}`); };
const rejects = (name, r, pattern) => check(name, !r.ok && pattern.test(r.err), r.ok ? 'the statement was ACCEPTED' : r.err.split('\n')[0]);
const accepts = (name, r) => check(name, r.ok, r.err.split('\n')[0]);
const value = (name, r, expected) => check(name, r.ok && r.out === String(expected), r.ok ? `got "${r.out}", expected "${expected}"` : r.err.split('\n')[0]);

// ------------------------------------------------------------------ environment
docker(['rm', '-f', NAME]);
const run = docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=smoke', IMAGE]);
if (run.status !== 0) { console.error(`STOP: cannot start ${IMAGE} (${run.stderr.trim()})`); process.exit(2); }
try {
  for (let i = 0; i < 90; i += 1) { if (sql('select 1').ok) { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)']); if (sql('select 1').ok) break; } spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)']); }
  accepts('PostgreSQL is running (Supabase image)', sql('select version()'));
  check('the REAL Supabase Vault extension is available', sql("select 1 from pg_extension where extname = 'supabase_vault'").out === '1' || sql('create extension if not exists supabase_vault').ok);
  const probe = sql("select vault.create_secret('probe-value-xyz', 'probe-' || gen_random_uuid()::text)");
  value('the Vault can really encrypt (vault.create_secret / decrypted_secrets)', sql(`select decrypted_secret from vault.decrypted_secrets where id = '${probe.out}'`), 'probe-value-xyz');
  value('and the stored column is not the plaintext', sql(`select secret <> 'probe-value-xyz' from vault.secrets where id = '${probe.out}'`), 't');
  check('the platform roles exist (anon, authenticated, service_role)', sql("select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')").out === '3');
  // the image ships a minimal storage schema: add only the columns an unrelated finance migration uses
  accepts('storage schema columns used by an unrelated finance migration are present', admin("create schema if not exists storage; create table if not exists storage.buckets (id text primary key, name text); create table if not exists storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text); alter table storage.buckets add column if not exists public boolean default false, add column if not exists file_size_limit bigint, add column if not exists allowed_mime_types text[];"));

  // ---------------------------------------------------------------- the real migration chain
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let chainOk = true; let failed = '';
  for (const file of files) {
    const r = sql(readFileSync(`${MIGRATIONS}${file}`, 'utf8'));
    if (!r.ok) { chainOk = false; failed = `${file}: ${r.err.split('\n')[0]}`; break; }
  }
  check(`all ${files.length} migrations apply in order (including 20261009200000_provider_connections.sql)`, chainOk, failed);
  if (!chainOk) throw new Error('migration chain failed');

  // ---------------------------------------------------------------- seed
  const M1 = '11111111-1111-4111-8111-111111111111'; const M2 = '22222222-2222-4222-8222-222222222222';
  const IG1 = 'a1111111-1111-4111-8111-111111111111'; const IG2 = 'a2222222-2222-4222-8222-222222222222'; const GG1 = 'a3333333-3333-4333-8333-333333333333';
  accepts('seed two merchants and their connectors', sql(`
    insert into merchants (id, name, source_system, source_id) values ('${M1}', 'Synthetic A', 'manual', 'smoke-a'), ('${M2}', 'Synthetic B', 'manual', 'smoke-b');
    insert into merchant_connectors (id, merchant_id, kind, external_id, status) values
      ('${IG1}', '${M1}', 'instagram', '17841400000000001', 'NOT_CONFIGURED'),
      ('${IG2}', '${M2}', 'instagram', '17841400000000002', 'NOT_CONFIGURED'),
      ('${GG1}', '${M1}', 'google_business_profile', 'accounts/1/locations/2', 'NOT_CONFIGURED');`));
  const H = (n) => String(n).padStart(64, '0').replace(/[^0-9a-f]/g, '0');
  const session = (extra = {}) => {
    const v = {
      merchant_id: M1, provider: 'instagram', state_hash: H(1), redirect_uri: 'https://nordla.example.test/oauth/callback/instagram', requested_scopes: '{instagram_business_basic}', expires_at: '2099-01-01T00:00:00Z', ...extra,
    };
    const cols = Object.keys(v); const vals = cols.map((c) => (v[c] === null ? 'null' : `'${String(v[c]).replace(/'/g, "''")}'`));
    return `insert into provider_oauth_sessions (${cols.join(', ')}) values (${vals.join(', ')}) returning id`;
  };

  // ---------------------------------------------------------------- OAuth sessions: constraints and guards
  const s1 = sql(session());
  accepts('a valid session is inserted (PENDING by default)', s1);
  value('the new session is PENDING', sql(`select status from provider_oauth_sessions where id = '${s1.out}'`), 'PENDING');
  rejects('a duplicate state hash is refused (the state is unique)', sql(session()), /unique|duplicate/i);
  rejects('a raw (non-hash) state is refused by the format check', sql(session({ state_hash: 'raw-state-value' })), /check constraint/i);
  rejects('an unknown provider is refused', sql(session({ state_hash: H(2), provider: 'facebook' })), /check constraint/i);
  rejects('a redirect URI with a fragment is refused', sql(session({ state_hash: H(3), redirect_uri: 'https://x.test/cb#frag' })), /check constraint/i);
  rejects('an absolute / protocol-relative return_to is refused (no open redirect)', sql(session({ state_hash: H(4), return_to: '//evil.example' })), /check constraint/i);
  rejects('a return_to with a backslash is refused', sql(session({ state_hash: H(5), return_to: '/a\\b' })), /check constraint/i);
  accepts('an internal return_to is accepted', sql(session({ state_hash: H(6), return_to: '/connections' })));
  rejects('a malformed PKCE challenge is refused', sql(session({ state_hash: H(7), pkce_challenge: 'short' })), /check constraint/i);
  rejects('a session of an unknown merchant is refused (FK)', sql(session({ state_hash: H(8), merchant_id: '99999999-9999-4999-8999-999999999999' })), /foreign key/i);
  rejects('a session cannot be born bound to another merchant\'s connector', sql(session({ state_hash: H(9), bound_connector_id: IG2 })), /does not belong|integrity|check/i);
  rejects('the bound connector must be of the session provider', sql(session({ state_hash: H(10), provider: 'tiktok', bound_connector_id: IG1 })), /does not belong|integrity|check/i);
  rejects('BOUND needs a connector and a completion date', sql(`update provider_oauth_sessions set status = 'BOUND' where id = '${s1.out}'`), /integrity|check constraint|a pending session/i);
  rejects('the identity of a session is immutable (merchant)', sql(`update provider_oauth_sessions set merchant_id = '${M2}' where id = '${s1.out}'`), /immutable/i);
  rejects('the identity of a session is immutable (state hash)', sql(`update provider_oauth_sessions set state_hash = '${H(77)}' where id = '${s1.out}'`), /immutable/i);

  // single use: two concurrent callbacks race for the same PENDING session - exactly one wins
  const race = `begin; update provider_oauth_sessions set status = 'AUTHORIZED', authorized_at = now() where id = '${s1.out}' and status = 'PENDING' returning id; select pg_sleep(1.2); commit;`;
  const [r1, r2] = await Promise.all([sqlAsync(race), sqlAsync(race, 400)]);
  const winners = [r1, r2].filter((r) => r.ok && r.out.split('\n').some((l) => l.trim() === s1.out));
  check('two concurrent callbacks: exactly ONE consumes the state (compare-and-set PENDING -> AUTHORIZED)', winners.length === 1, `${winners.length} winners (${r1.out || r1.err} | ${r2.out || r2.err})`);
  value('the session is AUTHORIZED once', sql(`select status from provider_oauth_sessions where id = '${s1.out}'`), 'AUTHORIZED');
  value('a replay finds nothing to authorize', sql(`with u as (update provider_oauth_sessions set status = 'AUTHORIZED' where id = '${s1.out}' and status = 'PENDING' returning 1) select count(*) from u`), '0');
  rejects('AUTHORIZED cannot go back to PENDING', sql(`update provider_oauth_sessions set status = 'PENDING' where id = '${s1.out}'`), /authorized session is bound/i);
  accepts('AUTHORIZED -> BOUND with a connector of the same merchant and provider', sql(`update provider_oauth_sessions set status = 'BOUND', bound_connector_id = '${IG1}', completed_at = now() where id = '${s1.out}'`));
  rejects('a BOUND (finished) session cannot change', sql(`update provider_oauth_sessions set status = 'FAILED' where id = '${s1.out}'`), /finished session/i);

  // ---------------------------------------------------------------- credentials: only through the service role and the Vault functions
  const SECRET = '{"access_token":"IGlonglivedtoken-PLAINTEXT-CANARY-0001"}';
  const store = (merchant, connector, provider, secret = SECRET) => `select provider_vault_store('${merchant}', '${connector}', '${provider}', '${secret}', '{instagram_business_basic}', '2099-01-01T00:00:00Z', true, now())`;
  rejects('a direct INSERT of a credential for another merchant\'s connector is refused (cross-merchant guard)', sql(`insert into connector_credentials (merchant_id, connector_id, provider, vault_secret_id) values ('${M2}', '${IG1}', 'instagram', gen_random_uuid())`), /does not belong/i);
  rejects('a credential row without a secret reference is refused unless REVOKED', sql(`insert into connector_credentials (merchant_id, connector_id, provider) values ('${M1}', '${IG1}', 'instagram')`), /check constraint/i);
  rejects('provider_vault_store refuses a connector of another merchant', as('service_role', store(M2, IG1, 'instagram')), /does not belong/i);
  rejects('provider_vault_store refuses a connector of another provider', as('service_role', store(M1, IG1, 'tiktok')), /does not belong/i);
  rejects('provider_vault_store refuses an empty secret', as('service_role', store(M1, IG1, 'instagram', ' ')), /empty secret/i);
  const stored = as('service_role', store(M1, IG1, 'instagram'));
  accepts('provider_vault_store stores a credential (service role)', stored);
  const meta = JSON.parse(stored.out || '{}');
  check('the returned metadata carries the Vault reference, scopes, expiry and NO secret', Boolean(meta.vault_secret_id) && meta.rotation_version === 1 && !stored.out.includes('PLAINTEXT-CANARY'), stored.out.slice(0, 120));
  value('the token is NOT in connector_credentials (any column)', sql("select count(*) from connector_credentials c where row_to_json(c)::text like '%PLAINTEXT-CANARY%'"), '0');
  value('the token is NOT in provider_oauth_sessions', sql("select count(*) from provider_oauth_sessions c where row_to_json(c)::text like '%PLAINTEXT-CANARY%'"), '0');
  value('the token is NOT in merchant_connectors', sql("select count(*) from merchant_connectors c where row_to_json(c)::text like '%PLAINTEXT-CANARY%'"), '0');
  value('the token is ENCRYPTED at rest in vault.secrets (the stored column is not the plaintext)', sql(`select count(*) from vault.secrets where id = '${meta.vault_secret_id}' and secret not like '%PLAINTEXT-CANARY%'`), '1');
  value('the Vault can decrypt it for the narrow function', sql(`select (provider_vault_read('${M1}', '${IG1}')->>'secret') like '%PLAINTEXT-CANARY-0001%'`), 't');
  rejects('a second live credential for the same connector is refused', as('service_role', store(M1, IG1, 'instagram')), /unique|duplicate/i);

  // scoping: another merchant cannot read, rotate, lease, expire or revoke it
  value('provider_vault_read with another merchant returns nothing (Vault read is scoped)', sql(`select provider_vault_read('${M2}', '${IG1}') is null`), 't');
  value('provider_vault_metadata with another merchant returns nothing', sql(`select provider_vault_metadata('${M2}', '${IG1}') is null`), 't');
  value('provider_vault_rotate with another merchant changes nothing', sql(`select provider_vault_rotate('${M2}', '${IG1}', 1, '{"access_token":"x"}', null, null, null, null) is null`), 't');
  value('provider_vault_revoke with another merchant destroys nothing', last(sql(`select count(*) from (select provider_vault_revoke('${M2}', '${IG1}')) x; select count(*) from connector_credentials where connector_id = '${IG1}' and status = 'ACTIVE'`)), '1');

  // rotation = compare-and-set; two concurrent refreshes cannot both win
  const rotate = (v, token) => `select provider_vault_rotate('${M1}', '${IG1}', ${v}, '{"access_token":"${token}"}', '{instagram_business_basic}', '2099-06-01T00:00:00Z', true, now())`;
  const rr = `begin; ${rotate(1, 'ROTATED-A-CANARY')} is not null; select pg_sleep(1.2); commit;`;
  const rr2 = `begin; ${rotate(1, 'ROTATED-B-CANARY')} is not null; select pg_sleep(0.1); commit;`;
  const [a, b] = await Promise.all([sqlAsync(rr), sqlAsync(rr2, 400)]);
  const won = [a, b].filter((x) => x.ok && /^t$/m.test(x.out)).length;
  check('two concurrent rotations with the same expected version: exactly ONE wins', won === 1, `${won} winners (${a.out || a.err} | ${b.out || b.err})`);
  value('the rotation counter advanced once', sql(`select rotation_version from connector_credentials where connector_id = '${IG1}' and status <> 'REVOKED'`), '2');
  value('a stale rotation (expected version 1) is refused', sql(`select ${rotate(1, 'STALE-CANARY').replace('select ', '')} is null`), 't');
  value('the Vault now holds exactly one of the competing secrets', sql(`select (provider_vault_read('${M1}', '${IG1}')->>'secret') ~ 'ROTATED-[AB]-CANARY'`), 't');
  value('the previous secret was REPLACED, not accumulated (one vault secret for the connector)', sql("select count(*) from vault.secrets where name like 'nordla/connector/" + IG1 + "/%'"), '1');

  // refresh lease: only one holder at a time
  const lease = `select provider_vault_refresh_lease('${M1}', '${IG1}', now(), 30)`;
  value('the first refresh lease is granted', sql(`${lease} is not null`), 't');
  value('a second lease while the first is held is refused', sql(`${lease} is null`), 't');
  accepts('the lease is released', sql(`select provider_vault_release_lease('${M1}', '${IG1}')`));
  value('a new lease is granted after the release', sql(`${lease} is not null`), 't');
  rejects('an absurd lease duration is refused', sql(`select provider_vault_refresh_lease('${M1}', '${IG1}', now(), 100000)`), /invalid lease/i);
  sql(`select provider_vault_release_lease('${M1}', '${IG1}')`);

  // expiry and revocation
  value('mark_expired moves an ACTIVE credential to EXPIRED', sql(`select provider_vault_mark_expired('${M1}', '${IG1}')->>'status'`), 'EXPIRED');
  const secretIdBefore = sql(`select vault_secret_id from connector_credentials where connector_id = '${IG1}' and status <> 'REVOKED'`).out;
  value('revoke returns REVOKED metadata', sql(`select provider_vault_revoke('${M1}', '${IG1}')->>'status'`), 'REVOKED');
  value('revoke DESTROYS the secret in the Vault', sql(`select count(*) from vault.secrets where id = '${secretIdBefore}'`), '0');
  value('the REVOKED row stays as history without any secret reference', sql(`select count(*) from connector_credentials where connector_id = '${IG1}' and status = 'REVOKED' and vault_secret_id is null and revoked_at is not null`), '1');
  rejects('a revoked credential row cannot be resurrected', sql(`update connector_credentials set status = 'ACTIVE' where connector_id = '${IG1}' and status = 'REVOKED'`), /revoked credential cannot change|check constraint/i);
  value('provider_vault_read of a revoked credential returns no secret', sql(`select (provider_vault_read('${M1}', '${IG1}')->>'secret') is null`), 't');
  accepts('a reconnect after revoking creates a NEW credential row for the same connector', as('service_role', store(M1, IG1, 'instagram', '{"access_token":"RECONNECT-CANARY"}')));
  value('the connector has one revoked + one live credential', sql(`select count(*) filter (where status = 'REVOKED') || '/' || count(*) filter (where status <> 'REVOKED') from connector_credentials where connector_id = '${IG1}'`), '1/1');

  // ---------------------------------------------------------------- session secrets (PKCE verifier, pending tokens)
  const sS = sql(session({ state_hash: H(20), provider: 'google_business_profile' })).out;
  value('session secret put (PKCE verifier)', last(sql(`select provider_vault_session_put('${M1}', '${sS}', 'PKCE_VERIFIER', 'VERIFIER-CANARY-0001'); select count(*) from vault.secrets where name = 'nordla/oauth-session/${sS}/PKCE_VERIFIER'`)), '1');
  value('the verifier is NOT in the session row', sql("select count(*) from provider_oauth_sessions s where row_to_json(s)::text like '%VERIFIER-CANARY%'"), '0');
  rejects('putting a secret for another merchant\'s session is refused', sql(`select provider_vault_session_put('${M2}', '${sS}', 'PKCE_VERIFIER', 'x-secret')`), /unknown session/i);
  rejects('an unknown secret kind is refused', sql(`select provider_vault_session_put('${M1}', '${sS}', 'ANYTHING', 'x-secret')`), /invalid request/i);
  value('peek by another merchant returns nothing', sql(`select provider_vault_session_peek('${M2}', '${sS}', 'PKCE_VERIFIER', now()) is null`), 't');
  value('peek returns the verifier to the owner', sql(`select provider_vault_session_peek('${M1}', '${sS}', 'PKCE_VERIFIER', now())`), 'VERIFIER-CANARY-0001');
  value('take returns it ONCE and destroys it', sql(`select provider_vault_session_take('${M1}', '${sS}', 'PKCE_VERIFIER', now())`), 'VERIFIER-CANARY-0001');
  value('a second take finds nothing (single use)', sql(`select provider_vault_session_take('${M1}', '${sS}', 'PKCE_VERIFIER', now()) is null`), 't');
  value('the Vault secret was deleted by take', sql(`select count(*) from vault.secrets where name = 'nordla/oauth-session/${sS}/PKCE_VERIFIER'`), '0');
  value('an expired session yields no verifier', last(sql(`select provider_vault_session_put('${M1}', '${sS}', 'PKCE_VERIFIER', 'LATE-CANARY'); select provider_vault_session_peek('${M1}', '${sS}', 'PKCE_VERIFIER', '2100-01-01') is null`)), 't');
  accepts('pending tokens: put', sql(`select provider_vault_session_put('${M1}', '${sS}', 'PENDING_TOKENS', '{"access_token":"PENDING-CANARY"}')`));
  value('pending tokens are unreadable before the callback authorized the session', sql(`select provider_vault_session_peek('${M1}', '${sS}', 'PENDING_TOKENS', now()) is null`), 't');
  sql(`update provider_oauth_sessions set status = 'AUTHORIZED', authorized_at = now() where id = '${sS}'`);
  value('pending tokens are readable once authorized', sql(`select provider_vault_session_peek('${M1}', '${sS}', 'PENDING_TOKENS', now()) like '%PENDING-CANARY%'`), 't');
  accepts('delete destroys the pending tokens', sql(`select provider_vault_session_delete('${M1}', '${sS}', 'PENDING_TOKENS')`));
  sql(`select provider_vault_session_delete('${M1}', '${sS}', 'PKCE_VERIFIER')`);
  value('no session secret remains in the Vault', sql(`select count(*) from vault.secrets where name like 'nordla/oauth-session/${sS}/%'`), '0');

  // cleanup removes expired never-bound sessions and their secrets
  const sE = sql(session({ state_hash: H(30), expires_at: '2020-01-01T00:00:00Z' })).out;
  sql(`select provider_vault_session_put('${M1}', '${sE}', 'PKCE_VERIFIER', 'EXPIRED-CANARY')`);
  value('cleanup removes the expired unbound session (and counts it)', sql("select provider_oauth_cleanup(now())"), '1');
  value('cleanup destroyed its Vault secret', sql(`select count(*) from vault.secrets where name = 'nordla/oauth-session/${sE}/PKCE_VERIFIER'`), '0');
  value('cleanup keeps BOUND sessions', sql(`select count(*) from provider_oauth_sessions where id = '${s1.out}'`), '1');

  // ---------------------------------------------------------------- privileges: only the service role reaches the Vault door
  value('service_role may execute the Vault functions', sql("select bool_and(has_function_privilege('service_role', p.oid, 'execute')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'provider\\_vault\\_%'"), 't');
  value('anon may NOT execute any Vault function', sql("select bool_or(has_function_privilege('anon', p.oid, 'execute')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'provider\\_vault\\_%' or p.proname = 'provider_oauth_cleanup')"), 'f');
  value('authenticated may NOT execute any Vault function', sql("select bool_or(has_function_privilege('authenticated', p.oid, 'execute')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'provider\\_vault\\_%' or p.proname = 'provider_oauth_cleanup')"), 'f');
  rejects('an authenticated user calling provider_vault_read is denied', as('authenticated', `select provider_vault_read('${M1}', '${IG1}')`), /permission denied/i);
  rejects('an anonymous caller calling provider_vault_store is denied', as('anon', store(M1, IG1, 'instagram')), /permission denied/i);
  rejects('an authenticated user cannot read vault.decrypted_secrets', as('authenticated', 'select count(*) from vault.decrypted_secrets'), /permission denied/i);
  value('every function is SECURITY DEFINER with a fixed (empty) search_path', sql("select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c ~ '^search_path=(\"\")?$')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'provider\\_vault\\_%' or p.proname = 'provider_oauth_cleanup')"), 't');
  value('both tables have row level security enabled', sql("select count(*) from pg_class where relname in ('provider_oauth_sessions','connector_credentials') and relrowsecurity"), '2');
  value('an authenticated user sees no credential row (RLS, no policy)', as('authenticated', 'select count(*) from connector_credentials'), '0');
  value('an authenticated user sees no OAuth session row (RLS, no policy)', as('authenticated', 'select count(*) from provider_oauth_sessions'), '0');
  value('an anonymous caller sees no credential row (RLS, no policy)', as('anon', 'select count(*) from connector_credentials'), '0');

  // ---------------------------------------------------------------- restrictions on existing data
  rejects('a connector that has credentials cannot be deleted (history is kept)', sql(`delete from merchant_connectors where id = '${IG1}'`), /foreign key|violates/i);
  rejects('a merchant that has sessions cannot be deleted', sql(`delete from merchants where id = '${M1}'`), /foreign key|violates/i);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  results.push({ name: `runner error: ${error.message}`, pass: false });
} finally {
  if (!process.env.KEEP_PG_SMOKE) docker(['rm', '-f', NAME]);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
