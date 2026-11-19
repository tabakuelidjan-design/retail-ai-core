// Analytics read path on a direct Postgres pool, as the LOGIN role analytics_reader (read only). Pilot, not yet the default.
// One transaction per read: acquire a connection, BEGIN, set the merchant with set_config(..., true) (valid for this transaction
// only), the query, COMMIT (or ROLLBACK on any error), and ALWAYS release the connection. Nothing here falls back to another key.
// Only three reads exist: merchants, merchant_connectors, sync_runs. Column lists mirror supabase/migrations (the real tables).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

export class TenantReadError extends Error {
  constructor(code, message) { super(message); this.name = 'TenantReadError'; this.code = code; }
}

/**
 * Runs `fn(tx)` in one transaction on ONE pooled connection whose merchant is `merchantId`.
 * `pool` is anything with connect() -> client, client.query(text, params), client.release().
 * `tx.query` accepts SELECT statements only.
 */
export async function inMerchantTransaction(pool, merchantId, fn, { allow = /^\s*select\b/i } = {}) {
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) throw new TenantReadError('MERCHANT_REQUIRED', 'a merchant id (UUID) is required for every read');
  const client = await pool.connect();
  try {
    await client.query('begin');
    try {
      await client.query("select set_config('app.merchant_id', $1, true)", [merchantId.toLowerCase()]);
      const tx = {
        query(text, params = []) {
          if (!allow.test(String(text))) throw new TenantReadError('READ_ONLY', 'this transaction accepts only the statements its role allows');
          return client.query(text, params);
        },
      };
      const result = await fn(tx);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

/** The three reads of the Analytics server, each in its own merchant transaction. */
export function createTenantReader({ pool, schema = 'analytics_pilot' }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('createTenantReader needs a pool with connect()');
  if (!SCHEMA.test(schema)) throw new TypeError('the schema name is not a plain identifier'); // only a fixed name is ever put into SQL
  return Object.freeze({
    merchantById: (merchantId) => inMerchantTransaction(pool, merchantId, async (tx) => {
      const { rows } = await tx.query(`select id, name, vertical from ${schema}.merchants where id = $1`, [merchantId.toLowerCase()]);
      return rows[0] ?? null;
    }),
    connectorsOf: (merchantId) => inMerchantTransaction(pool, merchantId, async (tx) => {
      const { rows } = await tx.query(
        `select id, merchant_id, kind, external_id, external_domain, status, config, created_at, updated_at
           from ${schema}.merchant_connectors where merchant_id = $1 order by created_at asc, id asc`,
        [merchantId.toLowerCase()],
      );
      return rows;
    }),
    latestSyncRows: (merchantId, limit = 10) => inMerchantTransaction(pool, merchantId, async (tx) => {
      const n = Math.min(Math.max(Number(limit) || 10, 1), 100);
      const { rows } = await tx.query(
        `select id, mode, status, started_at, finished_at, summary, error
           from ${schema}.sync_runs where merchant_id = $1 order by started_at desc limit $2`,
        [merchantId.toLowerCase(), n],
      );
      return rows;
    }),
  });
}
