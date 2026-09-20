// Minimal Supabase (PostgREST) client. No SDK dependency - just fetch.
// Server-side only: the service role key this is built for must never reach
// frontend code. This module has no knowledge of "frontend" at all - that
// boundary is enforced by where it's imported from, not by code here.

export class SupabaseConfigError extends Error {}

export function loadSupabaseConfigFromEnv(env = process.env) {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new SupabaseConfigError('SUPABASE_URL is not set');
  if (!serviceRoleKey) throw new SupabaseConfigError('SUPABASE_SERVICE_ROLE_KEY is not set');

  return { url, serviceRoleKey };
}

/**
 * @param {{url: string, serviceRoleKey: string}} config
 */
export function createSupabaseClient(config) {
  const baseHeaders = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  async function request(path, options) {
    const res = await fetch(`${config.url}/rest/v1${path}`, {
      ...options,
      headers: { ...baseHeaders, ...(options?.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase REST ${options?.method || 'GET'} ${path} -> HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    /** Upsert rows into `table`, keyed on the DB unique constraint matching `onConflict` columns. */
    async upsert(table, rows, { onConflict }) {
      if (rows.length === 0) return [];
      return request(`/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows),
      });
    },

    /** Plain insert, never merges - used for append-only tables like inventory_snapshots. */
    async insert(table, rows) {
      if (rows.length === 0) return [];
      return request(`/${table}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rows),
      });
    },

    /** Select rows with raw PostgREST query params, e.g. { select: 'id,unit_cost', variant_id: 'eq.<uuid>' }. */
    async select(table, params) {
      const qs = new URLSearchParams(params).toString();
      return request(`/${table}?${qs}`, { method: 'GET' });
    },
  };
}
