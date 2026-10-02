// A test-only stand-in for the Supabase REST client (src/supabase/client.js) that talks to the REAL PostgreSQL 17 of the bench.
// It speaks the same interface (select/selectAll/insert/update/delete/upsert/insertIgnoringDuplicates/rpc) and understands the PostgREST filters the Finance store uses
// (eq., is.null, not.is.null, in.(...), order, limit, offset, select). This lets the production store code (supabase-store.js) run unchanged against real PostgreSQL,
// so the memory store and the Supabase store can be held to ONE business contract. Never used outside tests; never connects anywhere but the bench database.
import pg from 'pg';
import { assertSafeServer, testUrl } from './safety.js';

const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`pgrest: bad identifier ${s}`); return `"${s}"`; };
const types = { getTypeParser: (oid, fmt) => (oid === 20 || oid === 1700 ? Number : oid === 1082 ? (v) => v : oid === 1184 || oid === 1114 ? (v) => new Date(v).toISOString() : pg.types.getTypeParser(oid, fmt)) };

export async function createPgRestClient(database) {
  const u = new URL(testUrl()); u.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: u.toString(), types }); client.on('error', () => {});
  await client.connect(); await assertSafeServer(client);
  const fail = (method, path, e) => new Error(`Supabase REST ${method} ${path} -> HTTP 400: ${JSON.stringify({ code: e.code, message: e.message, details: e.detail ?? null })}`);

  function where(filters, params) {
    const parts = [];
    for (const [k, v] of Object.entries(filters)) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
      const c = ident(k); const s = String(v);
      if (s.startsWith('eq.')) { params.push(s.slice(3)); parts.push(`${c}::text = $${params.length}`); }
      else if (s === 'is.null') parts.push(`${c} is null`);
      else if (s === 'not.is.null') parts.push(`${c} is not null`);
      else if (s.startsWith('in.(')) { const list = s.slice(4, -1).split(','); params.push(list); parts.push(`${c}::text = any($${params.length}::text[])`); }
      else throw new Error(`pgrest: unsupported filter ${k}=${s}`);
    }
    return parts.length ? ` where ${parts.join(' and ')}` : '';
  }
  const cols = (select) => (!select || select === '*' ? '*' : select.split(',').map((c) => ident(c.trim())).join(', '));
  const orderBy = (o) => (o ? ` order by ${o.split(',').map((x) => { const [c, d] = x.split('.'); return `${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ')}` : '');

  const api = {
    raw: client,
    async select(table, p = {}) {
      const params = []; const sql = `select ${cols(p.select)} from ${ident(table)}${where(p, params)}${orderBy(p.order)}${p.limit ? ` limit ${Number(p.limit)}` : ''}${p.offset ? ` offset ${Number(p.offset)}` : ''}`;
      try { return (await client.query(sql, params)).rows; } catch (e) { throw fail('GET', `/${table}`, e); }
    },
    async selectAll(table, p = {}) { return api.select(table, { order: 'id.asc', ...p }); },
    async insert(table, rows) {
      if (!rows.length) return [];
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].map(ident).join(', '); // keys that are absent keep the column DEFAULT, like PostgREST
      try { return (await client.query(`insert into ${ident(table)} (${keys}) select ${keys} from json_populate_recordset(null::${ident(table)}, $1) returning *`, [JSON.stringify(rows)])).rows; } catch (e) { throw fail('POST', `/${table}`, e); }
    },
    async insertIgnoringDuplicates(table, rows, { onConflict }) {
      if (!rows.length) return [];
      try { return (await client.query(`insert into ${ident(table)} select * from json_populate_recordset(null::${ident(table)}, $1) on conflict (${onConflict.split(',').map(ident).join(',')}) do nothing returning *`, [JSON.stringify(rows)])).rows; } catch (e) { throw fail('POST', `/${table}`, e); }
    },
    async upsert(table, rows, { onConflict }) {
      if (!rows.length) return [];
      const keys = Object.keys(rows[0]); const conflict = onConflict.split(',');
      const set = keys.filter((k) => !conflict.includes(k)).map((k) => `${ident(k)} = excluded.${ident(k)}`).join(', ');
      try { return (await client.query(`insert into ${ident(table)} select * from json_populate_recordset(null::${ident(table)}, $1) on conflict (${conflict.map(ident).join(',')}) do update set ${set} returning *`, [JSON.stringify(rows)])).rows; } catch (e) { throw fail('POST', `/${table}`, e); }
    },
    async update(table, filters, patch) {
      const keys = Object.keys(patch); if (!keys.length) return [];
      const params = [JSON.stringify(patch)]; const w = where(filters, params);
      const sql = `update ${ident(table)} set (${keys.map(ident).join(', ')}) = (select ${keys.map(ident).join(', ')} from json_populate_record(null::${ident(table)}, $1))${w} returning *`;
      try { return (await client.query(sql, params)).rows; } catch (e) { throw fail('PATCH', `/${table}`, e); }
    },
    async delete(table, filters) {
      const params = []; try { return (await client.query(`delete from ${ident(table)}${where(filters, params)} returning *`, params)).rows; } catch (e) { throw fail('DELETE', `/${table}`, e); }
    },
    async rpc(fn, args = {}) {
      const names = Object.keys(args); const params = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
      const sql = `select ${ident(fn)}(${names.map((n, i) => `${ident(n)} := $${i + 1}`).join(', ')}) as r`;
      try { const r = (await client.query(sql, params)).rows[0]?.r; return r === undefined ? null : r; } catch (e) { throw fail('POST', `/rpc/${fn}`, e); }
    },
    close: () => client.end().catch(() => {}),
  };
  return api;
}
