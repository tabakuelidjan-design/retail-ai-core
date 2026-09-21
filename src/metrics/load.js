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

async function selectByIds(supabase, table, column, ids, select) {
  const rows = [];
  for (const part of chunks(ids, CHUNK)) {
    rows.push(...await supabase.selectAll(table, { select, [column]: `in.(${part.join(',')})` }));
  }
  return rows;
}

export async function loadDataset(supabase, merchantId, { since }) {
  const eq = { merchant_id: `eq.${merchantId}` };
  const [products, variants, orders, costs] = await Promise.all([
    supabase.selectAll('products', { select: 'id,title,handle', ...eq }),
    supabase.selectAll('variants', { select: 'id,product_id,sku,title', ...eq }),
    supabase.selectAll('orders', { select: 'id,ordered_at,status,currency,taxes_included,location_id,is_test', ...eq, ordered_at: `gte.${since.toISOString()}` }),
    supabase.selectAll('product_costs', { select: 'variant_id,unit_cost,currency,effective_from,source,validation_status', ...eq }),
  ]);

  const orderIds = orders.map((o) => o.id);
  const [orderLines, refunds] = await Promise.all([
    selectByIds(supabase, 'order_lines', 'order_id', orderIds, 'id,order_id,variant_id,title_snapshot,sku_snapshot,quantity,unit_price,discount_amount,tax_amount'),
    selectByIds(supabase, 'refunds', 'order_id', orderIds, 'id,order_id,amount,refunded_at'),
  ]);
  const refundLines = await selectByIds(supabase, 'refund_lines', 'refund_id', refunds.map((r) => r.id), 'id,refund_id,order_line_id,quantity,amount,tax_amount');

  // Snapshots carry no merchant column: bound by recency from the newest one, then scope by this merchant's variants.
  const [newest] = await supabase.select('inventory_snapshots', { select: 'synced_at', order: 'synced_at.desc', limit: '1' });
  let snapshots = [];
  if (newest) {
    const from = new Date(new Date(newest.synced_at).getTime() - 2 * DAY_MS).toISOString();
    const variantIds = new Set(variants.map((v) => v.id));
    snapshots = (await supabase.selectAll('inventory_snapshots', { select: 'id,variant_id,location_id,quantity,synced_at', synced_at: `gte.${from}` }))
      .filter((s) => variantIds.has(s.variant_id));
  }

  return { products, variants, orders, orderLines, refunds, refundLines, costs, snapshots };
}
