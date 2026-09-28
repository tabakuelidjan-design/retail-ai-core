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
    const m = /^eq\.(.*)$/.exec(v);
    if (!m) throw new Error(`fake identity db: unsupported filter ${k}=${v}`);
    return String(row[k]) === m[1];
  });
}

/** @param {{ merchants?: string[] }} [o] merchant ids that exist (foreign keys) */
export function createIdentityDb({ merchants = [] } = {}) {
  const tables = { app_sessions: [], identity_events: [] };
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
