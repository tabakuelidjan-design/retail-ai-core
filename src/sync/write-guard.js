// Central tenant guard for connector writes (ADR 0003, step 5). The sync modules receive THIS object instead of the raw Supabase client,
// so every write coming from a connector is checked against one validated identity - { merchantId, connectorId, externalId } - before
// anything reaches the database:
//   - only the sync's own tables can be written (never merchants, merchant_connectors or another module's tables);
//   - every inserted/upserted row must carry merchant_id === the tenant (a row of another merchant is refused, the whole call with it);
//   - an update must be scoped to the tenant (merchant_id=eq.<tenant>), or be the sync_runs row this guard itself created;
//   - deletes and RPCs are refused.
// Reads pass through unchanged. A refusal throws TenantWriteViolation and writes nothing.

import { isUuid } from '../tenant/index.js';

export const SYNC_WRITE_TABLES = Object.freeze([
  'locations', 'products', 'variants', 'product_collections', 'inventory_snapshots', 'product_costs',
  'orders', 'order_attribution', 'order_lines', 'refunds', 'refund_lines', 'sync_runs',
]);

export class TenantWriteViolation extends Error {
  constructor(reason, detail = {}) {
    super(`Refused connector write (${reason})`);
    this.name = 'TenantWriteViolation'; this.code = 'TENANT_WRITE_VIOLATION'; this.reason = reason; this.detail = detail;
  }
}

/**
 * @param {object} supabase the raw client (select/insert/upsert/update/delete/rpc)
 * @param {{ merchantId: string, connectorId?: string|null, externalId?: string|null }} context the validated identity; a data write
 *        additionally needs connectorId + externalId (a context without them - before validation - may only write sync_runs)
 * @param {{ tables?: readonly string[] }} [options]
 */
export function guardSyncWrites(supabase, context, { tables = SYNC_WRITE_TABLES } = {}) {
  if (!context || !isUuid(context.merchantId)) throw new TenantWriteViolation('NO_VALIDATED_TENANT');
  const merchantId = context.merchantId;
  const validated = Boolean(context.connectorId && context.externalId);
  const allowed = new Set(validated ? tables : tables.filter((t) => t === 'sync_runs'));
  const ownRuns = new Set();

  const table = (name) => {
    if (!allowed.has(name)) throw new TenantWriteViolation(validated ? 'TABLE_NOT_WRITABLE_BY_CONNECTOR' : 'CONNECTOR_NOT_VALIDATED', { table: name });
  };
  const rows = (name, list) => {
    table(name);
    if (!Array.isArray(list)) throw new TenantWriteViolation('ROWS_NOT_AN_ARRAY', { table: name });
    const foreign = list.filter((r) => r?.merchant_id !== merchantId).length;
    if (foreign) throw new TenantWriteViolation('ROW_NOT_OF_THIS_TENANT', { table: name, rows: foreign });
  };

  return Object.freeze({
    context: Object.freeze({ ...context }),
    select: (...args) => supabase.select(...args),
    selectAll: (...args) => supabase.selectAll(...args),
    async upsert(name, list, opts) { rows(name, list); return supabase.upsert(name, list, opts); },
    async insertIgnoringDuplicates(name, list, opts) { rows(name, list); return supabase.insertIgnoringDuplicates(name, list, opts); },
    async insert(name, list, opts) {
      rows(name, list);
      const out = await supabase.insert(name, list, opts);
      if (name === 'sync_runs') for (const r of out ?? []) if (r?.id != null) ownRuns.add(String(r.id));
      return out;
    },
    async update(name, filters, patch) {
      table(name);
      if (patch && 'merchant_id' in patch && patch.merchant_id !== merchantId) throw new TenantWriteViolation('RE_ASSIGNS_MERCHANT', { table: name });
      const scoped = name === 'sync_runs'
        ? ownRuns.has(String(filters?.id ?? '').replace(/^eq\./, ''))
        : filters?.merchant_id === `eq.${merchantId}`;
      if (!scoped) throw new TenantWriteViolation('UPDATE_NOT_SCOPED_TO_TENANT', { table: name });
      return supabase.update(name, filters, patch);
    },
    async delete(name) { throw new TenantWriteViolation('DELETE_NOT_ALLOWED', { table: name }); },
    async rpc(fn) { throw new TenantWriteViolation('RPC_NOT_ALLOWED', { fn }); },
  });
}
