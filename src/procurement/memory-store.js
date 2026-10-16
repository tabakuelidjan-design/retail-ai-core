// In-memory reference store for Stock / Achats. It deliberately mirrors what the SQL schema enforces (supabase/migrations/20261016090000_procurement_stock.sql):
// per-merchant unique keys, optimistic versions, an append-only ledger and journal (no update/delete method exists for them), single-use approvals,
// and an all-or-nothing transaction. Tests run on this store only: no production data, no network.
import { randomUUID } from 'node:crypto';
import { StoreError } from './errors.js';

const UNIQUE = {
  items: [(r) => ['sku', r.sku], (r) => (r.barcode ? ['barcode', r.barcode] : null)],
  locations: [(r) => ['name', r.name.toLowerCase()]],
  suppliers: [(r) => ['name', r.name.toLowerCase()]],
  supplierItems: [(r) => ['supplier_item', `${r.supplierId}|${r.itemId}`]],
  quotes: [(r) => ['revision', `${r.supplierId}|${r.itemId}|${r.revision}`]],
  purchaseOrders: [(r) => ['number', r.number]],
  receipts: [(r) => ['po_idem', r.idempotencyKey]],
};
const MUTABLE = new Set(['items', 'locations', 'suppliers', 'supplierItems', 'quotes', 'purchaseOrders', 'visits']);

const fresh = () => ({
  items: new Map(), locations: new Map(), suppliers: new Map(), supplierItems: new Map(), quotes: new Map(), purchaseOrders: new Map(), receipts: new Map(), visits: new Map(),
  movements: [], events: [], incidents: [], idem: new Map(), approvals: new Set(), seq: new Map(), movementKeys: new Set(),
});

const MAPS = ['items', 'locations', 'suppliers', 'supplierItems', 'quotes', 'purchaseOrders', 'receipts', 'visits', 'idem', 'seq'];
const SETS = ['approvals', 'movementKeys'];
const ARRAYS = ['movements', 'events', 'incidents'];
/** Plain-JSON form of the whole state (for the file store). */
export const serializeState = (d) => ({ format: 1, ...Object.fromEntries(MAPS.map((k) => [k, [...d[k].entries()]])), ...Object.fromEntries(SETS.map((k) => [k, [...d[k]]])), ...Object.fromEntries(ARRAYS.map((k) => [k, d[k]])) });
export function reviveState(j) {
  if (!j || j.format !== 1) throw new Error('procurement state: unknown format');
  const d = fresh();
  for (const k of MAPS) d[k] = new Map(j[k] ?? []);
  for (const k of SETS) d[k] = new Set(j[k] ?? []);
  for (const k of ARRAYS) d[k] = j[k] ?? [];
  return d;
}

/**
 * @param {{ newId?: () => string, state?: object, onCommit?: (state: object) => Promise<void> }} opts
 *   state    a serialized state to start from (see serializeState);
 *   onCommit awaited after every successful transaction, BEFORE it resolves: if it throws, the transaction is rolled back and the error surfaces as
 *            STORE_UNAVAILABLE (the file store persists here, so "committed" means "on disk").
 */
export function createMemoryProcurementStore({ newId = randomUUID, state = null, onCommit = null } = {}) {
  let data = state ? reviveState(state) : fresh();
  let chain = Promise.resolve();
  const copy = (v) => structuredClone(v);
  const keyOf = (m, id) => `${m}|${id}`;

  const api = {
    newId,
    /** All-or-nothing, serialised (stands in for a DB transaction with row locks). Do not nest. */
    transaction(fn) {
      const run = chain.then(async () => {
        const snapshot = copy(data);
        try {
          const result = await fn(api);
          if (onCommit) {
            try { await onCommit(serializeState(data)); } catch (e) { throw new StoreError('STORE_UNAVAILABLE', `could not persist the transaction: ${e.message}`, { outcome: 'NOT_COMMITTED' }); }
          }
          return result;
        } catch (e) { data = snapshot; throw e; }
      });
      chain = run.catch(() => {});
      return run;
    },
    get(coll, merchantId, id) { const r = data[coll].get(id); return r && r.merchantId === merchantId ? copy(r) : null; },
    list(coll, merchantId) {
      if (Array.isArray(data[coll])) return data[coll].filter((r) => r.merchantId === merchantId).map(copy);
      return [...data[coll].values()].filter((r) => r.merchantId === merchantId).map(copy);
    },
    insert(coll, row) {
      for (const u of UNIQUE[coll] ?? []) {
        const k = u(row); if (!k) continue;
        for (const o of data[coll].values()) { const ok = u(o); if (o.merchantId === row.merchantId && ok && ok[0] === k[0] && ok[1] === k[1]) throw new StoreError('UNIQUE_VIOLATION', `${coll}.${k[0]} already exists`, { constraint: `${coll}.${k[0]}` }); }
      }
      if (data[coll].has(row.id)) throw new StoreError('UNIQUE_VIOLATION', `${coll}.id already exists`, { constraint: `${coll}.id` });
      const stored = { ...copy(row), version: 1 };
      data[coll].set(row.id, stored);
      return copy(stored);
    },
    update(coll, merchantId, id, patch, expectedVersion) {
      if (!MUTABLE.has(coll)) throw new StoreError('IMMUTABLE', `${coll} rows are never updated`);
      const cur = data[coll].get(id);
      if (!cur || cur.merchantId !== merchantId) throw new StoreError('NOT_FOUND', `${coll} ${id}`);
      if (expectedVersion !== undefined && cur.version !== expectedVersion) throw new StoreError('VERSION_CONFLICT', `${coll} ${id} is at version ${cur.version}, not ${expectedVersion}`, { current: cur.version });
      const next = { ...cur, ...copy(patch), id: cur.id, merchantId: cur.merchantId, version: cur.version + 1 };
      data[coll].set(id, next);
      return copy(next);
    },
    /** Append-only ledger: no update, no delete. One movement idempotency key per merchant, ever. */
    appendMovement(row) {
      const k = keyOf(row.merchantId, row.idempotencyKey);
      if (data.movementKeys.has(k)) throw new StoreError('UNIQUE_VIOLATION', 'movement idempotency key already used', { constraint: 'movements.idempotency_key' });
      data.movementKeys.add(k); data.movements.push(copy(row)); return copy(row);
    },
    listMovements(merchantId, { itemId, locationId } = {}) {
      return data.movements.filter((m) => m.merchantId === merchantId && (!itemId || m.itemId === itemId) && (!locationId || m.locationId === locationId)).map(copy);
    },
    /** Current balance of one (item, location). The SQL store reads the trigger-maintained table; here it is summed from the ledger. */
    balanceOf(merchantId, itemId, locationId) {
      let onHand = 0; let reserved = 0; let seen = false;
      for (const m of data.movements) if (m.merchantId === merchantId && m.itemId === itemId && m.locationId === locationId) { seen = true; if (m.bucket === 'ON_HAND') onHand += m.delta; else reserved += m.delta; }
      return seen ? { itemId, locationId, onHand, reserved } : undefined;
    },
    appendEvent(row) { data.events.push(copy(row)); return copy(row); },
    listEvents(merchantId) { return data.events.filter((e) => e.merchantId === merchantId).map(copy); },
    appendIncident(row) { data.incidents.push(copy(row)); return copy(row); },
    listIncidents(merchantId) { return data.incidents.filter((e) => e.merchantId === merchantId).map(copy); },
    getIdem(merchantId, key) { const r = data.idem.get(keyOf(merchantId, key)); return r ? copy(r) : null; },
    putIdem(merchantId, key, rec) { data.idem.set(keyOf(merchantId, key), copy(rec)); },
    /** An approval is single-use: consuming it twice is a hard error. */
    consumeApproval(merchantId, approvalId) {
      const k = keyOf(merchantId, approvalId);
      if (data.approvals.has(k)) throw new StoreError('APPROVAL_ALREADY_USED', 'this approval was already consumed');
      data.approvals.add(k);
    },
    nextSeq(merchantId, name) { const k = keyOf(merchantId, name); const n = (data.seq.get(k) ?? 0) + 1; data.seq.set(k, n); return n; },
    /** Test helper: a deep copy of everything, to prove that a read changes nothing. */
    snapshot() { return copy(data); },
    exportState() { return serializeState(data); },
  };
  return api;
}
