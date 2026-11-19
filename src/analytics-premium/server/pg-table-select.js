// Routes the THREE Analytics reads to the Postgres pilot reader when ANALYTICS_DATABASE_URL is set. Everything else keeps the
// existing Supabase client. For merchants, merchant_connectors and sync_runs there is NO fallback: if the pool fails, the read fails.
// Only the PostgREST-shaped parameters the three callers actually use are accepted; anything else is refused.

import { TenantReadError } from './pg-tenant-reader.js';

export const PG_ROUTED_TABLES = Object.freeze(['merchants', 'merchant_connectors', 'sync_runs']);
const EQ_UUID = /^eq\.([0-9a-f-]{36})$/i;

function uuidParam(params, name) {
  const m = EQ_UUID.exec(String(params?.[name] ?? ''));
  if (!m) throw new TenantReadError('FILTER_REFUSED', `the ${name} filter must be eq.<uuid>`);
  return m[1];
}

/** A `select(table, params)` with the Supabase client's shape, served by the pilot reader for the three tables only. */
export function createPgSelect(reader) {
  return async function select(table, params = {}) {
    if (table === 'merchants') {
      const row = await reader.merchantById(uuidParam(params, 'id'));
      return row ? [row] : [];
    }
    if (table === 'merchant_connectors') {
      return reader.connectorsOf(uuidParam(params, 'merchant_id'));
    }
    if (table === 'sync_runs') {
      if (params.order !== 'started_at.desc') throw new TenantReadError('FILTER_REFUSED', 'sync_runs is read newest first only');
      const limit = Number(params.limit ?? 10);
      return reader.latestSyncRows(uuidParam(params, 'merchant_id'), limit);
    }
    throw new TenantReadError('TABLE_NOT_ROUTED', `table ${String(table)} is not served by the Postgres pilot`);
  };
}

/**
 * A Supabase-client look-alike: the three routed tables go to Postgres (no fallback); every other method and table stays on the
 * existing client. Its prototype is the original client, so unrelated calls are unchanged.
 */
export function routedSupabase(supabase, pgSelect) {
  if (!supabase || typeof supabase.select !== 'function') throw new TypeError('routedSupabase needs the Supabase client');
  return Object.assign(Object.create(supabase), {
    select(table, params) {
      return PG_ROUTED_TABLES.includes(table) ? pgSelect(table, params) : supabase.select(table, params);
    },
  });
}

/**
 * The pool for the pilot, from ANALYTICS_DATABASE_URL only (never logged). Returns null when the variable is not set.
 * TLS verifies the server certificate (no rejectUnauthorized: false). The pg module is loaded lazily, only when the pilot is on.
 */
export async function createAnalyticsPool(env = process.env) {
  const connectionString = env.ANALYTICS_DATABASE_URL;
  if (!connectionString) return null;
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, ssl: { rejectUnauthorized: true } });
}
