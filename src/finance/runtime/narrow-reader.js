// PILOT: read adapter with the subset of the PostgREST interface that the pre-issue reads use (select / selectAll with eq, gte,
// gt, lte, lt, neq, in.(…), is.null, not.is.null, order, limit, offset). Tables and identifiers are whitelisted; values are bound
// parameters. Each call runs in a transaction on the reader role, for the merchant bound to the PostgreSQL login.
// Result shapes follow PostgREST: timestamps as ISO strings, bigint and numeric as numbers.


export const PILOT_READER_ROLE = 'nordla_fin_reader_pilot';

export const READ_TABLES = Object.freeze({
  fin_documents: null,
  products: null, variants: null, orders: null, order_lines: null, order_attribution: null, inventory_snapshots: null,
  refunds: null, refund_lines: null, product_costs: null, product_collections: null, locations: null,
});
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

export class NarrowReadError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

function ident(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new NarrowReadError('NARROW_IDENTIFIER_REFUSED', 'identifier refused');
  return `"${name}"`;
}

function columns(select) {
  if (!select || select === '*') return '*';
  return String(select).split(',').map((c) => ident(c.trim())).join(', ');
}

function where(filters, values) {
  const parts = [];
  for (const [key, raw] of Object.entries(filters)) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    const col = ident(key);
    const s = String(raw);
    if (s === 'is.null') { parts.push(`${col} is null`); continue; }
    if (s === 'not.is.null') { parts.push(`${col} is not null`); continue; }
    const m = /^(eq|neq|gt|gte|lt|lte|in)\.([\s\S]*)$/.exec(s);
    if (!m) throw new NarrowReadError('NARROW_FILTER_REFUSED', 'filter form refused');
    const [, op, value] = m;
    if (op === 'in') {
      if (!/^\([^()]*\)$/.test(value)) throw new NarrowReadError('NARROW_FILTER_REFUSED', 'in-list form refused');
      values.push(value.slice(1, -1).split(',').map((v) => v.trim()));
      parts.push(`${col}::text = any($${values.length}::text[])`);
    } else {
      values.push(value);
      parts.push(`${col} ${OPS[op]} $${values.length}`);
    }
  }
  return parts.length ? ` where ${parts.join(' and ')}` : '';
}

function order(spec) {
  if (!spec) return ' order by "id" asc';
  return ` order by ${String(spec).split(',').map((c) => {
    const m = /^([a-z_][a-z0-9_]{0,62})\.(asc|desc)$/.exec(c.trim());
    if (!m) throw new NarrowReadError('NARROW_ORDER_REFUSED', 'order form refused');
    return `${ident(m[1])} ${m[2]}`;
  }).join(', ')}`;
}

function limitOffset(p) {
  const out = [];
  const lim = p.limit === undefined ? null : Number(p.limit);
  const off = p.offset === undefined ? null : Number(p.offset);
  if (lim !== null && (!Number.isSafeInteger(lim) || lim < 0 || lim > 10000)) throw new NarrowReadError('NARROW_LIMIT_REFUSED', 'limit refused');
  if (off !== null && (!Number.isSafeInteger(off) || off < 0 || off > 1000000)) throw new NarrowReadError('NARROW_LIMIT_REFUSED', 'offset refused');
  if (lim !== null) out.push(` limit ${lim}`);
  if (off !== null) out.push(` offset ${off}`);
  return out.join('');
}

/**
 * @param {{ transaction: (run: (client: object) => Promise<any>, role: string) => Promise<any> }} deps
 *   transaction() runs `run` inside a transaction on the given pilot role (after the identity check).
 */
export function createNarrowReader({ transaction, tables = READ_TABLES }) {
  const allowed = (table) => {
    if (!Object.prototype.hasOwnProperty.call(tables, table)) throw new NarrowReadError('NARROW_TABLE_REFUSED', `table ${table} is not readable by the pilot reader`);
    return ident(table);
  };
  const run = (table, params) => transaction(async (c) => {
    const values = [];
    const sql = `select ${columns(params.select)} from public.${allowed(table)}${where(params, values)}${order(params.order)}${limitOffset(params)}`;
    const r = await c.query(sql, values);
    return r.rows;
  });

  return Object.freeze({
    async select(table, params = {}) { return run(table, params); },
    async selectAll(table, params = {}, pageSize = 1000) {
      if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > 10000) throw new NarrowReadError('NARROW_LIMIT_REFUSED', 'page size refused');
      const rows = [];
      for (let offset = 0; ; offset += pageSize) {
        const part = await run(table, { ...params, order: params.order ?? 'id.asc', limit: pageSize, offset });
        rows.push(...part);
        if (part.length < pageSize) return rows;
        if (rows.length > 1000000) throw new NarrowReadError('NARROW_LIMIT_REFUSED', 'too many rows');
      }
    },
  });
}
