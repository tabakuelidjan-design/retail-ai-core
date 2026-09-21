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
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
        const match = /^(eq|gte|lte|lt|in)\.(.*)$/.exec(value);
        if (!match) continue;
        const [, op, arg] = match;
        const norm = (v) => (v instanceof Date ? v.toISOString() : String(v));
        if (op === 'eq') rows = rows.filter((r) => String(r[key]) === arg);
        if (op === 'gte') rows = rows.filter((r) => norm(r[key]) >= arg);
        if (op === 'lte') rows = rows.filter((r) => norm(r[key]) <= arg);
        if (op === 'lt') rows = rows.filter((r) => norm(r[key]) < arg);
        if (op === 'in') {
          const set = new Set(arg.replace(/^\(|\)$/g, '').split(','));
          rows = rows.filter((r) => set.has(String(r[key])));
        }
      }

      if (params.order) {
        const [col, dir] = params.order.split('.');
        rows.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      if (params.offset) rows = rows.slice(Number(params.offset));
      if (params.limit) rows = rows.slice(0, Number(params.limit));

      if (params.select) {
        const cols = params.select.split(',');
        rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      return rows;
    },

    async selectAll(table, params) {
      return this.select(table, { ...params, limit: undefined, offset: undefined });
    },

    async update(table, filters, patch) {
      const matches = await this.select(table, filters);
      const t = getTable(table);
      for (const m of matches) Object.assign(t.find((r) => r.id === m.id), patch);
      return matches;
    },
  };
}
