// Reads the synced rows the metric engine needs. The only I/O in the metrics
// layer; everything downstream is pure. Order history is bounded by `since`
// (the source system exposes a limited order window anyway).

const CHUNK = 40; // ids per `in.(...)` filter, keeps the request URL short
const DAY_MS = 24 * 60 * 60 * 1000;

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function selectByIds(supabase, table, column, ids, select, extra = {}) {
  const rows = [];
  for (const part of chunks(ids, CHUNK)) {
    rows.push(...await supabase.selectAll(table, { select, [column]: `in.(${part.join(',')})`, ...extra }));
  }
  return rows;
}

export async function loadDataset(supabase, merchantId, { since }) {
  const eq = { merchant_id: `eq.${merchantId}` };
  const [products, variants, orders, costs, collections] = await Promise.all([
    supabase.selectAll('products', { select: 'id,title,handle,product_type,source_created_at,source_status,source_id', ...eq }),
    supabase.selectAll('variants', { select: 'id,product_id,sku,title,source_id', ...eq }),
    supabase.selectAll('orders', { select: 'id,customer_key,ordered_at,status,currency,taxes_included,location_id,is_test,source_name,channel_handle,channel_name,sub_channel_name,customer_order_index,journey_ready,days_to_conversion', ...eq, ordered_at: `gte.${since.toISOString()}` }),
    supabase.selectAll('product_costs', { select: 'variant_id,unit_cost,currency,effective_from,source,validation_status', ...eq }),
    supabase.selectAll('product_collections', { select: 'product_id,source_id,title,is_current', ...eq, is_current: 'eq.true' }),
  ]);

  // orderIds is already merchant-scoped (orders was fetched with merchant_id above), but every one of these
  // now also carries its own merchant_id column (migration 20260922230000) - passed explicitly as
  // defense-in-depth so a future caller reusing selectByIds elsewhere can never accidentally drop the scope.
  const orderIds = orders.map((o) => o.id);
  const orderAttribution = await selectByIds(supabase, 'order_attribution', 'order_id', orderIds, 'order_id,touch,occurred_at,source,source_type,source_description,referrer_host,landing_path,utm_source,utm_medium,utm_campaign,utm_content,utm_term', eq);
  const [orderLines, refunds] = await Promise.all([
    selectByIds(supabase, 'order_lines', 'order_id', orderIds, 'id,order_id,variant_id,title_snapshot,sku_snapshot,quantity,unit_price,discount_amount,tax_amount,tax_rate_bp', eq),
    selectByIds(supabase, 'refunds', 'order_id', orderIds, 'id,order_id,amount,refunded_at', eq),
  ]);
  const refundLines = await selectByIds(supabase, 'refund_lines', 'refund_id', refunds.map((r) => r.id), 'id,refund_id,order_line_id,quantity,amount,tax_amount', eq);

  // Fixed 2026-09-22: previously fetched the globally newest snapshot across ALL merchants, then a global
  // window, filtering to this merchant's variants only in JS afterward - a CRITICAL tenant-isolation finding
  // from the RLS/merchant-isolation review. inventory_snapshots.merchant_id now exists (migration
  // 20260922230000): both the "newest" probe and the bulk fetch are scoped by it directly, so no other
  // merchant's snapshot rows are ever fetched into this process at all.
  const [newest] = await supabase.select('inventory_snapshots', { select: 'synced_at', ...eq, order: 'synced_at.desc', limit: '1' });
  let snapshots = [];
  if (newest) {
    const from = new Date(new Date(newest.synced_at).getTime() - 2 * DAY_MS).toISOString();
    snapshots = await supabase.selectAll('inventory_snapshots', { select: 'id,variant_id,location_id,quantity,synced_at', ...eq, synced_at: `gte.${from}` });
  }

  return { products, variants, orders, orderLines, refunds, refundLines, costs, snapshots, collections, orderAttribution };
}
