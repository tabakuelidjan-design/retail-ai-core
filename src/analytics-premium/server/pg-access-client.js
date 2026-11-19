// The access check of the SSO contract (createAccessChecker) on Postgres, with NO service key. It exposes only what that check calls:
//   select('merchant_members', { select, merchant_id: 'eq.<m>', user_id: 'eq.<u>' })   -> the membership of THAT person in THAT merchant
//   select('module_entitlements', { select, merchant_id: 'eq.<m>', module_code: 'eq.<x>' }) -> the entitlements of THAT merchant
//   rpc('security_mfa_status', { p_merchant, p_user })                                  -> the MFA status of THAT pair
// Each call runs in one transaction on one pooled connection that sets app.merchant_id (and app.user_id) with set_config(..., true).
// The database role (analytics_access_checker) then allows only those rows and columns; the MFA wrapper refuses any other pair.
// The person is the one verified by the SSO contract: the caller passes it through, this client never chooses one.

import { TenantReadError } from './pg-tenant-reader.js';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLES = Object.freeze({
  merchant_members: { eqs: ['merchant_id', 'user_id'], cols: ['merchant_id', 'user_id', 'role', 'status', 'removed_at'] },
  module_entitlements: { eqs: ['merchant_id', 'module_code'], cols: ['merchant_id', 'module_code', 'status'] },
});
const RPCS = Object.freeze({ security_mfa_status: ['p_merchant', 'p_user'] });

function eqValue(params, name) {
  const raw = params[name];
  const m = /^eq\.([\s\S]*)$/.exec(String(raw ?? ''));
  if (!m) throw new TenantReadError('FILTER_REFUSED', `${name} must be an eq filter`);
  return m[1];
}

async function inCheckerTransaction(pool, merchant, user, fn) {
  if (!UUID.test(merchant)) throw new TenantReadError('MERCHANT_REQUIRED', 'a merchant id (UUID) is required');
  if (user !== null && !UUID.test(user)) throw new TenantReadError('USER_REQUIRED', 'a user id (UUID) is required');
  const client = await pool.connect();
  try {
    await client.query('begin');
    try {
      await client.query("select set_config('app.merchant_id', $1, true), set_config('app.user_id', $2, true)", [merchant.toLowerCase(), (user ?? '').toLowerCase()]);
      const result = await fn(client);
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

/** @param {{ pool: object }} options */
export function createAccessClient({ pool }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('createAccessClient needs a pool with connect()');

  async function select(table, params = {}) {
    const spec = TABLES[table];
    if (!spec) throw new TenantReadError('TABLE_NOT_ALLOWED', `table ${String(table)} is not available to the access check`);
    const cols = String(params.select ?? '').split(',').map((c) => c.trim());
    if (cols.some((c) => !spec.cols.includes(c))) throw new TenantReadError('COLUMN_NOT_ALLOWED', `a requested column is not available on ${table}`);
    const merchant = eqValue(params, 'merchant_id');
    const user = spec.eqs.includes('user_id') ? eqValue(params, 'user_id') : null;
    const clauses = []; const values = [];
    for (const name of spec.eqs) {
      if (name === 'merchant_id') continue;
      if (params[name] === undefined) throw new TenantReadError('FILTER_REFUSED', `${name} filter is required`);
      values.push(eqValue(params, name)); clauses.push(`"${name}" = $${values.length}`);
    }
    if (params.limit !== undefined && !(Number.isInteger(Number(params.limit)) && Number(params.limit) > 0 && Number(params.limit) <= 100)) throw new TenantReadError('FILTER_REFUSED', 'limit out of range');
    const where = clauses.length ? ` and ${clauses.join(' and ')}` : '';
    const limit = params.limit !== undefined ? ` limit ${Number(params.limit)}` : '';
    const sql = `select ${cols.map((c) => `"${c}"`).join(', ')} from public."${table}" where merchant_id = $${values.length + 1}${where}${limit}`;
    values.push(merchant);
    return inCheckerTransaction(pool, merchant, user, async (client) => (await client.query(sql, values)).rows);
  }

  async function rpc(fn, args = {}) {
    const names = RPCS[fn];
    if (!names) throw new TenantReadError('RPC_NOT_ALLOWED', `function ${String(fn)} is not available to the access check`);
    const merchant = args[names[0]]; const user = args[names[1]];
    return inCheckerTransaction(pool, String(merchant ?? ''), String(user ?? ''), async (client) => {
      const { rows } = await client.query('select analytics_checker.mfa_status($1::uuid, $2::uuid) as status', [merchant, user]);
      return rows[0]?.status ?? null;
    });
  }

  return Object.freeze({ select, rpc });
}

/**
 * The access client from ANALYTICS_ACCESS_DATABASE_URL (the login role of analytics_access_checker). Null when the variable is not set:
 * then the existing Supabase client is used, unchanged. TLS verifies the server certificate.
 */
export async function createAccessClientFromEnv(env = process.env) {
  const url = env.ANALYTICS_ACCESS_DATABASE_URL;
  if (!url) return null;
  const { default: pg } = await import('pg');
  return createAccessClient({ pool: new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000, ssl: { rejectUnauthorized: true } }) });
}
