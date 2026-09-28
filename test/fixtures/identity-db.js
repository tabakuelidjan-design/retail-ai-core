// In-memory stand-in for the two Core C1a tables (app_sessions, identity_events) with the SAME rules as the migration
// supabase/migrations/20260928120000_identity_sessions_events.sql: unique token hash, 12-hour maximum lifetime, immutable session
// identity, last_seen_at never moving backwards, final revocations, append-only journal, no e-mail in the journal. Every call is
// recorded so tests can count reads and writes exactly. Synthetic data only; the real SQL is checked by the contract tests.
import { randomUUID } from 'node:crypto';

const ms = (v) => new Date(v).getTime();
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;
const dbError = (msg) => new Error(`Supabase REST -> HTTP 409: ${msg}`);

function matches(row, filters) {
  return Object.entries(filters).every(([k, v]) => {
    if (['select', 'order', 'limit', 'offset'].includes(k)) return true;
    if (v === 'is.null') return row[k] === null || row[k] === undefined;
    const inList = /^in\.\((.*)\)$/.exec(v);
    if (inList) return inList[1].split(',').includes(String(row[k]));
    const m = /^eq\.(.*)$/.exec(v);
    if (!m) throw new Error(`fake identity db: unsupported filter ${k}=${v}`);
    return String(row[k]) === m[1];
  });
}

/** @param {{ merchants?: string[] }} [o] merchant ids that exist (foreign keys) */
export function createIdentityDb({ merchants = [] } = {}) {
  const tables = { app_sessions: [], identity_events: [], identity_rate_limits: [] };
  const calls = [];
  let failNext = null;
  let eventSeq = 0;
  const copy = (r) => JSON.parse(JSON.stringify(r));
  const maybeFail = () => { if (failNext) { const e = failNext; failNext = null; throw e; } };

  const api = {
    async select(table, params) {
      calls.push({ op: 'select', table }); maybeFail();
      let rows = (tables[table] ?? []).filter((r) => matches(r, params));
      if (params.limit) rows = rows.slice(0, Number(params.limit));
      return rows.map(copy);
    },
    async insert(table, rows) {
      calls.push({ op: 'insert', table, count: rows.length }); maybeFail();
      const out = [];
      for (const r of rows) {
        if (!merchants.includes(r.merchant_id)) throw dbError('foreign key violation (merchant_id)');
        if (table === 'app_sessions') {
          if (!/^[0-9a-f]{64}$/.test(r.token_hash)) throw dbError('check violation (token_hash)');
          if (tables.app_sessions.some((s) => s.token_hash === r.token_hash)) throw dbError('unique violation (token_hash)');
          if (!(ms(r.expires_at) > ms(r.created_at) && ms(r.expires_at) <= ms(r.created_at) + 12 * 3_600_000)) throw dbError('check violation (expiry)');
          if (ms(r.last_seen_at) < ms(r.created_at)) throw dbError('check violation (last_seen_at)');
          const row = { id: randomUUID(), revoked_at: null, revoked_reason: null, ...r };
          tables.app_sessions.push(row); out.push(copy(row));
        } else if (table === 'identity_events') {
          const text = JSON.stringify(r.detail ?? {});
          if (EMAIL.test(text) || (r.entity_id && EMAIL.test(r.entity_id))) throw dbError('check violation (no e-mail)');
          if ((r.entity_type == null) !== (r.entity_id == null)) throw dbError('check violation (entity)');
          eventSeq += 1;
          const row = { id: eventSeq, ...r };
          tables.identity_events.push(row); out.push(copy(row));
        } else throw new Error(`fake identity db: unknown table ${table}`);
      }
      return out;
    },
    async update(table, filters, patch) {
      calls.push({ op: 'update', table, keys: Object.keys(patch) }); maybeFail();
      if (table === 'identity_events') throw dbError('identity_events is append-only: UPDATE is not allowed');
      const hit = tables[table].filter((r) => matches(r, filters));
      for (const r of hit) {
        const next = { ...r, ...patch };
        for (const k of ['id', 'merchant_id', 'user_id', 'module', 'token_hash', 'created_at', 'expires_at']) if (next[k] !== r[k]) throw dbError('identity and expiry of a session are immutable');
        if (ms(next.last_seen_at) < ms(r.last_seen_at)) throw dbError('last_seen_at cannot move backwards');
        if (r.revoked_at && (next.revoked_at !== r.revoked_at || next.revoked_reason !== r.revoked_reason)) throw dbError('a revocation is final');
        if ((next.revoked_at == null) !== (next.revoked_reason == null)) throw dbError('check violation (revocation)');
      }
      for (const r of hit) Object.assign(r, patch);
      return hit.map(copy);
    },
    // Same rule as the SQL function identity_rate_limit_record_failure (C1b migration; verified for real in PGlite).
    async rpc(fn, a) {
      calls.push({ op: 'rpc', fn }); maybeFail();
      if (fn !== 'identity_rate_limit_record_failure') throw new Error(`fake identity db: unknown function ${fn}`);
      if (!['email', 'ip'].includes(a.p_dimension) || !/^[0-9a-f]{64}$/.test(a.p_subject)) throw dbError('check violation (identity_rate_limits)');
      if (!(a.p_window_seconds >= 60 && a.p_window_seconds <= 86400 && a.p_max_failures >= 1 && a.p_max_failures <= 1000 && a.p_block_seconds >= 60 && a.p_block_seconds <= 86400)) throw dbError('invalid limits');
      const now = ms(a.p_now);
      let r = tables.identity_rate_limits.find((x) => x.dimension === a.p_dimension && x.subject_hmac === a.p_subject);
      if (!r) { r = { dimension: a.p_dimension, subject_hmac: a.p_subject, window_started_at: a.p_now, failures: 1, blocked_until: null, updated_at: a.p_now }; tables.identity_rate_limits.push(r); }
      else {
        const expired = ms(r.window_started_at) <= now - a.p_window_seconds * 1000;
        r.failures = expired ? 1 : r.failures + 1;
        if (expired) r.window_started_at = a.p_now;
        r.updated_at = new Date(Math.max(ms(r.updated_at), now)).toISOString();
      }
      if (r.failures >= a.p_max_failures) r.blocked_until = new Date(Math.max(r.blocked_until ? ms(r.blocked_until) : now, now + a.p_block_seconds * 1000)).toISOString();
      return r.blocked_until && ms(r.blocked_until) > now ? r.blocked_until : null;
    },
    async delete(table) {
      calls.push({ op: 'delete', table }); maybeFail();
      if (table === 'identity_events') throw dbError('identity_events is append-only: DELETE is not allowed');
      throw new Error('fake identity db: delete not used in C1a');
    },
  };
  return {
    supabase: api,
    calls,
    table: (name) => tables[name],
    writes: () => calls.filter((c) => c.op !== 'select').length,
    reset: () => { calls.length = 0; },
    failNextWith: (err) => { failNext = err; },
  };
}
