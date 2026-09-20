// A tiny in-memory stand-in for the Supabase client, implementing just the
// upsert/insert/select surface the sync modules use. Good enough to test
// idempotency (same on_conflict semantics) without any network or real DB.

import { randomUUID } from 'node:crypto';

export function createFakeSupabase() {
  const tables = new Map(); // table -> array of row objects

  function getTable(name) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  }

  function matchesConflict(row, existing, keys) {
    return keys.every((k) => row[k] === existing[k]);
  }

  return {
    _tables: tables,

    async upsert(table, rows, { onConflict }) {
      const keys = onConflict.split(',');
      const t = getTable(table);
      const results = [];
      for (const row of rows) {
        const existing = t.find((e) => matchesConflict(row, e, keys));
        if (existing) {
          Object.assign(existing, row);
          results.push(existing);
        } else {
          const created = { id: randomUUID(), ...row };
          t.push(created);
          results.push(created);
        }
      }
      return results;
    },

    async insert(table, rows) {
      const t = getTable(table);
      const created = rows.map((row) => ({ id: randomUUID(), ...row }));
      t.push(...created);
      return created;
    },

    async select(table, params) {
      const t = getTable(table);
      let rows = t.slice();

      for (const [key, value] of Object.entries(params)) {
        if (key === 'select' || key === 'order' || key === 'limit') continue;
        const match = /^eq\.(.*)$/.exec(value);
        if (match) rows = rows.filter((r) => String(r[key]) === match[1]);
      }

      if (params.order) {
        const [col, dir] = params.order.split('.');
        rows.sort((a, b) => (a[col] > b[col] ? 1 : -1) * (dir === 'desc' ? -1 : 1));
      }
      if (params.limit) rows = rows.slice(0, Number(params.limit));

      if (params.select) {
        const cols = params.select.split(',');
        rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      return rows;
    },
  };
}
