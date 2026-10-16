// PostgreSQL store for Stock / Achats: same interface as memory-store.js, over the proc_* tables of supabase/migrations/20261016090000_procurement_stock.sql.
//
// It takes an INJECTED node-postgres-compatible pool ({ connect(): Promise<client>, query(text, params) }; client.query / client.release). This module imports no
// database driver: wiring a real Supabase connection (the `pg` package, a direct connection string) is a deployment step that needs the owner's approval.
//
// What the database guarantees (and this adapter relies on): tenant-composite keys, the append-only ledger, balances maintained by a trigger with CHECK
// constraints, legal PO transitions, single-use approvals, unique idempotency keys. What the adapter adds: one real transaction per command, a row lock on
// the purchase-order header (concurrent receipts on one order serialise), an advisory lock on the idempotency key (two concurrent identical commands:
// the second waits, then replays), and a stable error vocabulary (INSUFFICIENT_STOCK, RESERVED_STOCK, OVER_RECEIPT, STORE_UNAVAILABLE ...).
import { randomUUID } from 'node:crypto';
import { StoreError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const TS_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

// column -> type. 'ord' (insertion order) is read-only and never returned.
const SPEC = {
  items: { table: 'proc_items', cols: { id: 'uuid', merchant_id: 'uuid', sku: 'text', name: 'text', barcode: 'text', variant_ref: 'text', status: 'text', reorder_point: 'int', reorder_qty: 'int', attachments: 'json', version: 'int', created_at: 'ts' } },
  locations: { table: 'proc_locations', cols: { id: 'uuid', merchant_id: 'uuid', name: 'text', type: 'text', created_at: 'ts' } },
  suppliers: { table: 'proc_suppliers', cols: { id: 'uuid', merchant_id: 'uuid', name: 'text', country: 'text', currency: 'text', incoterm_default: 'text', deposit_bps: 'int', lead_time_days: 'int', finance_company_id: 'text', contacts: 'json', documents: 'json', status: 'text', version: 'int', created_at: 'ts' } },
  supplierItems: { table: 'proc_supplier_items', cols: { id: 'uuid', merchant_id: 'uuid', supplier_id: 'uuid', item_id: 'uuid', supplier_sku: 'text', moq: 'int', lead_time_days: 'int', created_at: 'ts' } },
  quotes: { table: 'proc_quotes', cols: { id: 'uuid', merchant_id: 'uuid', supplier_id: 'uuid', item_id: 'uuid', revision: 'int', currency: 'text', tiers: 'json', moq: 'int', incoterm: 'text', lead_time_days: 'int', valid_until: 'date', status: 'text', provenance: 'text', reason: 'text', evidence: 'json', recorded_by: 'text', version: 'int', created_at: 'ts' } },
  purchaseOrders: { table: 'proc_purchase_orders', cols: { id: 'uuid', merchant_id: 'uuid', number: 'text', supplier_id: 'uuid', currency: 'text', incoterm: 'text', status: 'text', expected_date: 'date', original_expected_date: 'date', date_changes: 'json', destination_location_id: 'uuid', deposit_bps: 'int', fx: 'json', total_minor: 'bigint', supplier_reference: 'text', ordered_at: 'ts', closed_short: 'bool', close_reason: 'text', cancel_reason: 'text', created_by: 'text', submitted_by: 'text', version: 'int', created_at: 'ts' } },
  receipts: { table: 'proc_receipts', cols: { id: 'uuid', merchant_id: 'uuid', po_id: 'uuid', supplier_id: 'uuid', received_at: 'date', promised_date: 'date', on_time: 'bool', location_id: 'uuid', quarantine_location_id: 'uuid', lines: 'json', idempotency_key: 'text', approval_id: 'text', recorded_by: 'text', created_at: 'ts' } },
  movements: { table: 'proc_stock_movements', cols: { id: 'uuid', merchant_id: 'uuid', idempotency_key: 'text', group_id: 'uuid', at: 'ts', item_id: 'uuid', location_id: 'uuid', bucket: 'text', delta: 'int', kind: 'text', reason: 'text', reference: 'json', cost_status: 'text', unit_cost_eur_micro: 'bigint', actor_id: 'text', approval_id: 'text' } },
  events: { table: 'proc_events', cols: { id: 'uuid', merchant_id: 'uuid', at: 'ts', type: 'text', actor: 'json', object: 'json', approval: 'json', detail: 'json', idempotency_key: 'text' } },
  incidents: { table: 'proc_incidents', cols: { id: 'uuid', merchant_id: 'uuid', supplier_id: 'uuid', po_id: 'uuid', type: 'text', severity: 'text', description: 'text', at: 'ts', recorded_by: 'text' } },
};
const LINE_COLS = { line_id: 'text', position: 'int', item_id: 'uuid', qty: 'int', unit_price_micro: 'bigint', total_minor: 'bigint', quote_id: 'uuid', price_source: 'text', qty_received: 'int', qty_defective: 'int' };
const SCHED_COLS = { kind: 'text', amount_minor: 'bigint', due_event: 'text', status: 'text', payment_ref: 'text', paid_amount_minor: 'bigint', paid_at: 'date' };
const MUTABLE = new Set(['items', 'locations', 'suppliers', 'quotes', 'purchaseOrders']);
const VERSIONED = new Set(['items', 'suppliers', 'quotes', 'purchaseOrders']);

const sel = (cols, a = '') => Object.entries(cols).map(([c, t]) => (t === 'date' ? `to_char(${a}${c}, 'YYYY-MM-DD') as ${c}` : t === 'ts' ? `to_char(${a}${c} at time zone 'UTC', '${TS_FORMAT}') as ${c}` : `${a}${c}`)).join(', ');
function fromRow(cols, row) {
  const o = {};
  for (const [c, t] of Object.entries(cols)) { const v = row[c]; o[camel(c)] = v === null || v === undefined ? null : t === 'bigint' ? Number(v) : v; }
  return o;
}
const cast = { uuid: '::uuid', date: '::date', ts: '::timestamptz', json: '::jsonb', bigint: '::bigint' };
function paramOf(t, v) { return t === 'json' ? (v === null ? null : JSON.stringify(v)) : v; }

/** Database error -> stable StoreError. Anything unrecognised is rethrown untouched. */
export function mapPgError(e) {
  if (e instanceof StoreError) return e;
  const c = e?.code; const constraint = e?.constraint ?? '';
  if (c === '23505') return new StoreError('UNIQUE_VIOLATION', `unique constraint ${constraint || ''} violated`, { constraint });
  if (c === '23514' || c === '23000') {
    if (/proc_balance_nonneg/.test(constraint)) return new StoreError('INSUFFICIENT_STOCK', 'the balance would go negative', { constraint });
    if (/proc_balance_reserved_le_onhand/.test(constraint)) return new StoreError('RESERVED_STOCK', 'reserved units would exceed on-hand', { constraint });
    if (/proc_po_line_received_le_ordered/.test(constraint)) return new StoreError('OVER_RECEIPT', 'received would exceed ordered', { constraint });
    if (/illegal purchase order transition/.test(e.message)) return new StoreError('INVALID_TRANSITION', e.message, { constraint });
    return new StoreError('CHECK_VIOLATION', e.message, { constraint });
  }
  if (c === '23503') return new StoreError('FOREIGN_KEY_VIOLATION', e.message, { constraint });
  if (c === '40001' || c === '40P01') return new StoreError('STORE_RETRYABLE', 'serialization failure or deadlock: nothing was committed', { pg: c });
  const text = String(e?.message ?? '');
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', '57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004'].includes(c) || /terminat|connection|timeout|ECONN|socket/i.test(text)) {
    return new StoreError('STORE_UNAVAILABLE', 'the database connection failed', { pg: c ?? null, outcome: e?.outcome ?? 'NOT_COMMITTED' });
  }
  return e;
}

export function createPgProcurementStore({ pool, newId = randomUUID } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new TypeError('createPgProcurementStore needs a pg-compatible pool');

  function ops(run, inTx) {
    const orderBy = (coll) => (coll === 'purchaseOrders' || SPEC[coll].cols.created_at ? ' order by ord' : '');
    async function loadPo(headers) {
      if (!headers.length) return [];
      const ids = headers.map((h) => h.id);
      const lines = (await run(`select po_id, ${sel(LINE_COLS)} from proc_po_lines where po_id = any($1::uuid[]) order by po_id, position`, [ids])).rows;
      const sched = (await run(`select po_id, ${sel(SCHED_COLS)} from proc_po_schedule where po_id = any($1::uuid[]) order by po_id, kind desc`, [ids])).rows; // DEPOSIT before BALANCE
      return headers.map((h) => ({
        ...fromRow(SPEC.purchaseOrders.cols, h),
        lines: lines.filter((l) => l.po_id === h.id).map((l) => { const x = fromRow(LINE_COLS, l); const { lineId, position, ...rest } = x; return { id: lineId, ...rest }; }),
        schedule: sched.filter((s) => s.po_id === h.id).map((s) => fromRow(SCHED_COLS, s)),
      }));
    }

    const api = {
      newId,
      async get(coll, merchantId, id) {
        if (typeof id !== 'string' || !UUID.test(id)) return null;
        const spec = SPEC[coll];
        const lock = inTx && coll === 'purchaseOrders' ? ' for update' : ''; // concurrent receipts / transitions on one order serialise here
        const r = await run(`select ${sel(spec.cols)} from ${spec.table} where id = $1 and merchant_id = $2${lock}`, [id, merchantId]);
        if (!r.rows[0]) return null;
        return coll === 'purchaseOrders' ? (await loadPo(r.rows))[0] : fromRow(spec.cols, r.rows[0]);
      },
      async list(coll, merchantId) {
        const spec = SPEC[coll];
        const r = await run(`select ${sel(spec.cols)} from ${spec.table} where merchant_id = $1${orderBy(coll)}`, [merchantId]);
        return coll === 'purchaseOrders' ? loadPo(r.rows) : r.rows.map((x) => fromRow(spec.cols, x));
      },
      async insert(coll, row) {
        const spec = SPEC[coll];
        const cols = []; const vals = []; const ph = [];
        for (const [k, v] of Object.entries(row)) {
          if (v === undefined || k === 'version') continue;
          if ((coll === 'purchaseOrders') && (k === 'lines' || k === 'schedule')) continue;
          const c = snake(k); const t = spec.cols[c];
          if (!t) throw new Error(`pg-store: ${coll} has no column for "${k}"`);
          cols.push(c); vals.push(paramOf(t, v)); ph.push(`$${vals.length}${cast[t] ?? ''}`);
        }
        await run(`insert into ${spec.table} (${cols.join(', ')}) values (${ph.join(', ')})`, vals);
        if (coll === 'purchaseOrders') {
          for (const [i, l] of row.lines.entries()) {
            await run('insert into proc_po_lines (merchant_id, po_id, line_id, position, item_id, qty, unit_price_micro, total_minor, quote_id, price_source, qty_received, qty_defective) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
              [row.merchantId, row.id, l.id, i + 1, l.itemId, l.qty, l.unitPriceMicro, l.totalMinor, l.quoteId ?? null, l.priceSource, l.qtyReceived ?? 0, l.qtyDefective ?? 0]);
          }
          for (const s of row.schedule) {
            await run('insert into proc_po_schedule (merchant_id, po_id, kind, amount_minor, due_event, status, payment_ref, paid_amount_minor, paid_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [row.merchantId, row.id, s.kind, s.amountMinor, s.dueEvent, s.status, s.paymentRef ?? null, s.paidAmountMinor ?? null, s.paidAt ?? null]);
          }
        }
        return api.get(coll, row.merchantId, row.id);
      },
      async update(coll, merchantId, id, patch, expectedVersion) {
        if (!MUTABLE.has(coll)) throw new StoreError('IMMUTABLE', `${coll} rows are never updated`);
        const spec = SPEC[coll];
        const cur = await api.get(coll, merchantId, id);
        if (!cur) throw new StoreError('NOT_FOUND', `${coll} ${id}`);
        if (expectedVersion !== undefined && cur.version !== expectedVersion) throw new StoreError('VERSION_CONFLICT', `${coll} ${id} is at version ${cur.version}, not ${expectedVersion}`, { current: cur.version });
        const sets = []; const vals = [];
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || ['id', 'merchantId', 'version'].includes(k)) continue;
          if (coll === 'purchaseOrders' && (k === 'lines' || k === 'schedule')) continue;
          const c = snake(k); const t = spec.cols[c];
          if (!t) throw new Error(`pg-store: ${coll} has no column for "${k}"`);
          vals.push(paramOf(t, v)); sets.push(`${c} = $${vals.length}${cast[t] ?? ''}`);
        }
        if (VERSIONED.has(coll)) sets.push('version = version + 1');
        if (sets.length) {
          vals.push(id, merchantId);
          let where = `id = $${vals.length - 1} and merchant_id = $${vals.length}`;
          if (VERSIONED.has(coll)) { vals.push(cur.version); where += ` and version = $${vals.length}`; }
          const r = await run(`update ${spec.table} set ${sets.join(', ')} where ${where}`, vals);
          if (r.rowCount === 0) throw new StoreError('VERSION_CONFLICT', `${coll} ${id} changed concurrently`);
        }
        if (coll === 'purchaseOrders') {
          for (const l of patch.lines ?? []) await run('update proc_po_lines set qty_received = $1, qty_defective = $2 where po_id = $3 and line_id = $4 and merchant_id = $5', [l.qtyReceived, l.qtyDefective, id, l.id, merchantId]);
          for (const s of patch.schedule ?? []) await run('update proc_po_schedule set status = $1, payment_ref = $2, paid_amount_minor = $3, paid_at = $4::date where po_id = $5 and kind = $6 and merchant_id = $7', [s.status, s.paymentRef ?? null, s.paidAmountMinor ?? null, s.paidAt ?? null, id, s.kind, merchantId]);
        }
        return api.get(coll, merchantId, id);
      },
      async appendMovement(row) { return append('movements', row); },
      async appendEvent(row) { return append('events', row); },
      async appendIncident(row) { return append('incidents', row); },
      async listMovements(merchantId, { itemId, locationId } = {}) {
        const where = ['merchant_id = $1']; const vals = [merchantId];
        if (itemId) { vals.push(itemId); where.push(`item_id = $${vals.length}::uuid`); }
        if (locationId) { vals.push(locationId); where.push(`location_id = $${vals.length}::uuid`); }
        if ((itemId && !UUID.test(itemId)) || (locationId && !UUID.test(locationId))) return [];
        return (await run(`select ${sel(SPEC.movements.cols)} from proc_stock_movements where ${where.join(' and ')} order by ord`, vals)).rows.map((r) => fromRow(SPEC.movements.cols, r));
      },
      async listEvents(merchantId) { return (await run(`select ${sel(SPEC.events.cols)} from proc_events where merchant_id = $1 order by ord`, [merchantId])).rows.map((r) => fromRow(SPEC.events.cols, r)); },
      async listIncidents(merchantId) { return (await run(`select ${sel(SPEC.incidents.cols)} from proc_incidents where merchant_id = $1 order by ord`, [merchantId])).rows.map((r) => fromRow(SPEC.incidents.cols, r)); },
      /** Current balance of one (item, location), straight from the trigger-maintained table. */
      async balanceOf(merchantId, itemId, locationId) {
        const r = await run('select on_hand, reserved from proc_stock_balances where merchant_id = $1 and item_id = $2::uuid and location_id = $3::uuid', [merchantId, itemId, locationId]);
        return r.rows[0] ? { itemId, locationId, onHand: r.rows[0].on_hand, reserved: r.rows[0].reserved } : undefined;
      },
      async getIdem(merchantId, key) {
        if (inTx) await run('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${merchantId}:${key}`]); // a concurrent identical command waits here, then replays
        const r = await run('select command, fingerprint, result from proc_idempotency where merchant_id = $1 and idempotency_key = $2', [merchantId, key]);
        return r.rows[0] ? { command: r.rows[0].command, fingerprint: r.rows[0].fingerprint, result: r.rows[0].result } : null;
      },
      async putIdem(merchantId, key, rec) { await run('insert into proc_idempotency (merchant_id, idempotency_key, command, fingerprint, result) values ($1,$2,$3,$4,$5::jsonb)', [merchantId, key, rec.command, rec.fingerprint, JSON.stringify(rec.result)]); },
      async consumeApproval(merchantId, approvalId) {
        const r = await run('insert into proc_approvals_used (merchant_id, approval_id) values ($1,$2) on conflict do nothing', [merchantId, approvalId]);
        if (r.rowCount === 0) throw new StoreError('APPROVAL_ALREADY_USED', 'this approval was already consumed');
      },
      async nextSeq(merchantId, name) { return (await run('select proc_next_number($1::uuid, $2) as n', [merchantId, name])).rows[0].n; },
      /** Test helper: every proc_ table as plain data, to prove that a read changed nothing. */
      async snapshot() {
        const out = {};
        for (const [coll, spec] of Object.entries(SPEC)) out[coll] = (await run(`select ${sel(spec.cols)} from ${spec.table}${spec.cols.id ? ' order by ord' : ''}`, [])).rows;
        out.balances = (await run('select merchant_id, item_id, location_id, on_hand, reserved from proc_stock_balances order by merchant_id, item_id, location_id', [])).rows;
        out.approvalsUsed = (await run('select merchant_id, approval_id from proc_approvals_used order by 1, 2', [])).rows;
        out.idempotency = (await run('select merchant_id, idempotency_key from proc_idempotency order by 1, 2', [])).rows;
        return JSON.parse(JSON.stringify(out));
      },
    };
    async function append(coll, row) {
      const spec = SPEC[coll]; const cols = []; const vals = []; const ph = [];
      for (const [k, v] of Object.entries(row)) {
        if (v === undefined) continue;
        const c = snake(k); const t = spec.cols[c];
        if (!t) throw new Error(`pg-store: ${coll} has no column for "${k}"`);
        cols.push(c); vals.push(paramOf(t, v)); ph.push(`$${vals.length}${cast[t] ?? ''}`);
      }
      await run(`insert into ${spec.table} (${cols.join(', ')}) values (${ph.join(', ')})`, vals);
      return row;
    }
    return api;
  }

  const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw mapPgError(e); } };
  const readOps = ops((text, params) => pool.query(text, params), false);
  const store = {};
  for (const [k, v] of Object.entries(readOps)) store[k] = typeof v === 'function' && k !== 'newId' ? wrap(v) : v;
  store.transaction = async (fn) => {
    let client;
    try { client = await pool.connect(); } catch (e) { throw mapPgError(e); }
    let committing = false;
    try {
      await client.query('begin');
      const tx = ops((text, params) => client.query(text, params), true);
      const wrapped = {};
      for (const [k, v] of Object.entries(tx)) wrapped[k] = typeof v === 'function' && k !== 'newId' ? wrap(v) : v;
      const result = await fn(wrapped);
      committing = true;
      await client.query('commit');
      return result;
    } catch (e) {
      const mapped = mapPgError(e);
      // a failure while COMMIT was in flight leaves the outcome unknown: the caller must retry with the SAME idempotency key (it replays if the commit landed)
      if (committing && mapped instanceof StoreError && mapped.code === 'STORE_UNAVAILABLE') mapped.detail.outcome = 'UNKNOWN';
      try { await client.query('rollback'); } catch { /* the connection may be gone: the server rolls back */ }
      throw mapped;
    } finally { try { client.release(); } catch { /* already released */ } }
  };
  return store;
}
