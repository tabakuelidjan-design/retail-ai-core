// The report child's database clients on Postgres, from its two least-privilege URLs (see report-env.js). No service key is read here.
// Returns null when neither URL is set (the local CLI keeps its own REST client). With one URL only, it refuses: a half-configured
// child must not silently fall back to anything else.

import { createScopedClient } from './pg-scoped-client.js';

export const REPORT_READ_TABLES = Object.freeze([
  'merchants', 'merchant_profile', 'products', 'variants', 'orders', 'order_lines', 'order_attribution',
  'refunds', 'refund_lines', 'product_costs', 'product_collections', 'locations', 'inventory_snapshots',
]);
export const REPORT_WRITE_TABLES = Object.freeze(['data_quality_flags']);

const openPools = new Set();

// TLS verifies the server certificate. ANALYTICS_DB_SSL=disable exists ONLY for a local disposable database in tests (never set in the child env).
export function sslOf(env = process.env) {
  return env.ANALYTICS_DB_SSL === "disable" ? false : { rejectUnauthorized: true };
}

async function poolFor(url, env) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000, ssl: sslOf(env) });
  openPools.add(pool);
  return pool;
}

/** Ends every pool this process opened (the report child calls it before exiting, so it does not wait for idle timeouts). */
export async function closeReportDbPools() {
  await Promise.allSettled([...openPools].map((p) => p.end()));
  openPools.clear();
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<null | { read: object, write: object, close: () => Promise<void> }>}
 */
export async function createReportDbClients(env = process.env) {
  const readUrl = env.ANALYTICS_REPORT_READ_DATABASE_URL;
  const writeUrl = env.ANALYTICS_REPORT_WRITE_DATABASE_URL;
  if (!readUrl && !writeUrl) return null;
  if (!readUrl || !writeUrl) throw new Error('report database configuration incomplete: both ANALYTICS_REPORT_*_DATABASE_URL are required');
  const merchantId = String(env.NORDLA_MERCHANT_ID ?? '');
  const readPool = await poolFor(readUrl, env);
  const writePool = await poolFor(writeUrl, env);
  return Object.freeze({
    read: createScopedClient({ pool: readPool, merchantId, readable: [...REPORT_READ_TABLES] }),
    write: createScopedClient({ pool: writePool, merchantId, readable: [...REPORT_WRITE_TABLES], writable: [...REPORT_WRITE_TABLES] }),
    close: async () => { await Promise.allSettled([readPool.end(), writePool.end()]); },
  });
}
