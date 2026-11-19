// Supabase-client look-alike for the report child, on Postgres, with NO service key. It accepts only the PostgREST parameter shapes the
// report code uses (eq, neq, gt, gte, lt, lte, in on plain columns; order by one column; limit and offset), and only for the tables
// it is given. Every statement runs in one transaction on one pooled connection, with the merchant set by set_config(..., true);
// the database role then enforces the same merchant scope (row-level security) and the table privileges.
// Identifiers are validated and quoted; values are always bound parameters.

import { inMerchantTransaction, TenantReadError } from './pg-tenant-reader.js';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const SELECT_ONLY = /^\s*select\b/i;
const READ_WRITE = /^\s*(select|insert|update)\b/i;

const ident = (name) => {
  if (!IDENT.test(String(name))) throw new TenantReadError('FILTER_REFUSED', 'an identifier is not a plain column name');
  return `"${name}"`;
};

function whereOf(filters, values) {
  const clauses = [];
  for (const [col, raw] of Object.entries(filters)) {
    if (['select', 'order', 'limit', 'offset'].includes(col)) continue;
    const m = /^([a-z]+)\.([\s\S]*)$/.exec(String(raw));
    if (!m) throw new TenantReadError('FILTER_REFUSED', `filter on ${col} must be op.value`);
    const [, op, value] = m;
    if (op in OPS) {
      values.push(value);
      clauses.push(`${ident(col)} ${OPS[op]} $${values.length}`);
    } else if (op === 'in') {
      const inner = /^\(([\s\S]*)\)$/.exec(value);
      if (!inner) throw new TenantReadError('FILTER_REFUSED', `in filter on ${col} must be in.(a,b)`);
      values.push(inner[1].split(','));
      clauses.push(`${ident(col)} = any($${values.length})`);
    } else {
      throw new TenantReadError('FILTER_REFUSED', `operator ${op} is not allowed`);
    }
  }
  return clauses.length ? ` where ${clauses.join(' and ')}` : '';
}

function orderOf(order) {
  if (!order) return '';
  const m = /^([a-z_][a-z0-9_]{0,62})\.(asc|desc)$/.exec(String(order));
  if (!m) throw new TenantReadError('FILTER_REFUSED', 'order must be column.asc or column.desc');
  return ` order by ${ident(m[1])} ${m[2]}`;
}

function limitOf(params) {
  const limit = params.limit === undefined ? null : Number(params.limit);
  const offset = params.offset === undefined ? 0 : Number(params.offset);
  if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 10000)) throw new TenantReadError('FILTER_REFUSED', 'limit out of range');
  if (!Number.isInteger(offset) || offset < 0) throw new TenantReadError('FILTER_REFUSED', 'offset out of range');
  return { sql: `${limit !== null ? ` limit ${limit}` : ''}${offset ? ` offset ${offset}` : ''}`, limit };
}

/**
 * @param {{ pool: object, merchantId: string, readable: string[], writable?: string[], schema?: string }} options
 */
export function createScopedClient({ pool, merchantId, readable, writable = [], schema = 'public' }) {
  if (!Array.isArray(readable) || readable.length === 0) throw new TypeError('createScopedClient needs the readable tables');
  const reads = new Set(readable);
  const writes = new Set(writable);
  for (const t of [...reads, ...writes]) if (!IDENT.test(t)) throw new TypeError('a table name is not a plain identifier');
  if (!IDENT.test(schema)) throw new TypeError('the schema name is not a plain identifier');
  const mustRead = (t) => { if (!reads.has(t)) throw new TenantReadError('TABLE_NOT_ALLOWED', `table ${t} is not readable here`); return `${schema}.${ident(t).slice(1, -1)}`; };
  const mustWrite = (t) => { if (!writes.has(t)) throw new TenantReadError('TABLE_NOT_ALLOWED', `table ${t} is not writable here`); return `${schema}.${ident(t).slice(1, -1)}`; };

  async function select(table, params = {}) {
    const from = mustRead(table);
    // No select, or '*': every column of this table. Safe here because the database grants SELECT per table to this role only
    // (the reader has all columns of its 13 tables; the writer has data_quality_flags only), and row-level security scopes the rows.
    const cols = !params.select || params.select === '*' ? '*'
      : String(params.select).split(',').map((c) => ident(c.trim())).join(', ');
    const values = [];
    const where = whereOf(params, values);
    const lim = limitOf(params);
    const sql = `select ${cols} from ${from}${where}${orderOf(params.order)}${lim.sql}`;
    return inMerchantTransaction(pool, merchantId, async (tx) => (await tx.query(sql, values)).rows, { allow: SELECT_ONLY });
  }

  /** Every row, page by page (a stable order), each page in its own merchant transaction. */
  async function selectAll(table, params = {}, pageSize = 1000) {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await select(table, { order: 'id.asc', ...params, limit: String(pageSize), offset: String(offset) });
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  async function insert(table, rows) {
    const from = mustWrite(table);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const keys = Object.keys(rows[0]);
    for (const r of rows) if (Object.keys(r).join('|') !== keys.join('|')) throw new TenantReadError('FILTER_REFUSED', 'every row of an insert needs the same columns');
    const cols = keys.map(ident).join(', ');
    const values = [];
    const tuples = rows.map((r) => `(${keys.map((k) => { values.push(r[k]); return `$${values.length}`; }).join(', ')})`);
    const sql = `insert into ${from} (${cols}) values ${tuples.join(', ')} returning *`;
    return inMerchantTransaction(pool, merchantId, async (tx) => (await tx.query(sql, values)).rows, { allow: READ_WRITE });
  }

  async function update(table, filters, patch) {
    const from = mustWrite(table);
    const keys = Object.keys(patch ?? {});
    if (keys.length === 0) throw new TenantReadError('FILTER_REFUSED', 'an update needs at least one column');
    const values = [];
    const sets = keys.map((k) => { values.push(patch[k]); return `${ident(k)} = $${values.length}`; }).join(', ');
    const where = whereOf(filters, values);
    if (!where) throw new TenantReadError('FILTER_REFUSED', 'an update needs a filter');
    const sql = `update ${from} set ${sets}${where} returning *`;
    return inMerchantTransaction(pool, merchantId, async (tx) => (await tx.query(sql, values)).rows, { allow: READ_WRITE });
  }

  return Object.freeze({ select, selectAll, insert, update });
}
