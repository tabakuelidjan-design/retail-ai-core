// Merchant Setup Wizard — a read-only, source-agnostic "is this store's data clean enough" report.
// Pure: no I/O, no network calls, no persistence. Every number is produced by an existing, already-
// validated function (quality/rules.js, analysis/triage.js, metrics/*.js) - this file only shapes their
// output into a UI-ready, merchant-generic checklist. It never invents a "readiness score": every check
// reports a plain status derived from an objective, already-documented rule, never a weighted composite.
//
// Inputs the caller must fetch (this module does none of it):
//   ledger      - buildLedger(data, {config})
//   data        - the raw loadDataset() rows (needed for SKU/company-adjacent raw fields)
//   enrichment  - {categoryPathByProduct, collectionsByProduct, channelByOrder} from a SalesDataAdapter, or
//                 null if the merchant's adapter hasn't produced one yet (reported as 'unavailable', not skipped)
//   company     - the merchant's fin_companies row, or null if none exists yet
//   connectors  - pre-fetched live connector facts, e.g. { shopify: { tokenOk: boolean, checkedAt: Date } }.
//                 Omit a key (or the whole object) when that check wasn't performed - reported 'unavailable',
//                 never assumed healthy.

import { HIERARCHY_LEVELS, UNCLASSIFIED } from '../metrics/hierarchy.js';
import { detectQualityFlags } from '../quality/rules.js';
import { buildCostTriage, buildLargestStockPositions, buildProfitUncertainty } from '../analysis/triage.js';
import { buildWindows } from '../metrics/windows.js';

export const WIZARD_VERSION = 'W1.0';
export const READINESS_GATES = ['hierarchy_analytics', 'finance_invoicing'];

const round2 = (x) => (x === null || x === undefined ? null : Math.round((x + Number.EPSILON) * 100) / 100);

/** One UI-ready row. Every field the spec asked for is always present, even when null/unknown - never omitted. */
function check({ id, section, label, status, severity, count = null, value = null, blocking = false, blocks = [], recommended_action = null, provenance, details = {} }) {
  return { id, section, label, status, severity, count, value, blocking, blocks, recommended_action, provenance, details };
}

function missingCostCheck(data, ledger, flags, window, now) {
  const missing = flags.filter((f) => f.rule_code === 'MISSING_COST');
  const uncertainty = buildProfitUncertainty(ledger, window);
  const affected = round2(uncertainty.revenue_ex_tax.cost_missing);
  const p0 = missing.filter((f) => f.details.priority === 'P0').length;
  if (missing.length === 0) {
    return check({
      id: 'missing_cost', section: 'catalog', label: 'Product cost coverage', status: 'ok', severity: 'info',
      count: 0, value: 0, recommended_action: null,
      provenance: { source: 'quality/rules.js: detectQualityFlags (MISSING_COST)' },
    });
  }
  return check({
    id: 'missing_cost', section: 'catalog', label: 'Product cost coverage',
    status: p0 > 0 ? 'warning' : 'ok', severity: p0 > 0 ? 'warning' : 'info',
    count: missing.length, value: affected, blocking: false, blocks: [],
    recommended_action: p0 > 0
      ? `${p0} variant(s) sold with no recorded cost — margin for those sales is unclassified, not wrong. Add unit costs to unlock margin reporting.`
      : `${missing.length} unsold/stocked variant(s) have no recorded cost. Add costs before they sell to avoid unclassified margin later.`,
    provenance: { source: 'quality/rules.js: detectQualityFlags (MISSING_COST); analysis/triage.js: buildProfitUncertainty' },
    details: { window: window.key, revenue_ex_tax_affected: affected, p0_sold_with_missing_cost: p0 },
  });
}

function missingSkuCheck(data) {
  const missing = data.variants.filter((v) => !v.sku || !String(v.sku).trim());
  return check({
    id: 'missing_sku', section: 'catalog', label: 'Variants without a SKU',
    status: missing.length > 0 ? 'warning' : 'ok', severity: 'info',
    count: missing.length, blocking: false,
    recommended_action: missing.length > 0
      ? `${missing.length} variant(s) have no SKU. SKU is never required for analytics/finance identity here, but is often needed for barcode/POS scanning — add one if you scan at checkout.`
      : null,
    provenance: { source: 'raw variants (SKU is nullable by design, never a join key — see schema comment)' },
  });
}

function duplicateSkuCheck(flags) {
  const dup = flags.filter((f) => f.rule_code === 'DUPLICATE_SKU_OBSERVATION');
  const anySold = dup.some((f) => f.severity === 'warning');
  return check({
    id: 'duplicate_sku', section: 'catalog', label: 'SKUs shared by more than one variant',
    status: dup.length > 0 ? 'warning' : 'ok', severity: dup.length > 0 ? (anySold ? 'warning' : 'info') : 'info',
    count: dup.length, blocking: false,
    recommended_action: dup.length > 0 ? `${dup.length} SKU(s) are shared by multiple variants — this can misattribute sales/stock scans between them. Give each variant a unique SKU.` : null,
    provenance: { source: 'quality/rules.js: detectQualityFlags (DUPLICATE_SKU_OBSERVATION)' },
    details: { affected_variants: dup.reduce((a, f) => a + f.details.variant_count, 0) },
  });
}

function unmatchedHistoricalCheck(flags) {
  const unmatched = flags.filter((f) => f.rule_code === 'UNMATCHED_HISTORICAL_VARIANT');
  return check({
    id: 'unmatched_historical_lines', section: 'catalog', label: 'Sold lines with no matching catalog variant',
    status: unmatched.length > 0 ? 'warning' : 'ok', severity: 'info',
    count: unmatched.length, blocking: false,
    recommended_action: unmatched.length > 0 ? `${unmatched.length} historical sold line(s) no longer match a catalog variant (deleted/renamed product). They still count in sales totals under their recorded title, but cannot be grouped by category/collection.` : null,
    provenance: { source: 'quality/rules.js: detectQualityFlags (UNMATCHED_HISTORICAL_VARIANT)' },
  });
}

/** One row per hierarchy level (universe/product_group/category/subcategory), plus one for collections. Never invents a taxonomy - reports exactly what the adapter's enrichment produced. */
function hierarchyCoverageChecks(data, enrichment) {
  if (!enrichment) {
    return HIERARCHY_LEVELS.map((level) => check({
      id: `hierarchy_coverage_${level}`, section: 'catalog', label: `Category coverage — ${level}`,
      status: 'unavailable', severity: 'info', blocking: false,
      recommended_action: 'No enrichment provided by the source adapter yet — category-level analytics cannot run until one is wired up.',
      provenance: { source: 'SalesDataAdapter enrichment (not supplied)' },
    }));
  }
  const total = data.products.length;
  const rows = HIERARCHY_LEVELS.map((level, idx) => {
    let classified = 0;
    const groups = new Map();
    for (const p of data.products) {
      const path = enrichment.categoryPathByProduct?.get(p.id) ?? [];
      const val = path[idx] ?? null;
      if (val) classified += 1;
      const key = val ?? UNCLASSIFIED;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const pct = total > 0 ? round2((classified / total) * 100) : null;
    const topUnclassified = [...groups.entries()].filter(([k]) => k === UNCLASSIFIED).map(([, v]) => v)[0] ?? 0;
    const status = total === 0 ? 'unavailable' : classified === 0 ? 'warning' : 'ok';
    return check({
      id: `hierarchy_coverage_${level}`, section: 'catalog', label: `Category coverage — ${level}`,
      status, severity: 'info', count: classified, value: pct, blocking: false,
      recommended_action: status === 'warning'
        ? `No product is classified at the "${level}" level (0/${total}). If your catalogue doesn't use this depth of taxonomy, no action needed; otherwise map it via categoryPathOverrides.`
        : status === 'ok' && classified < total
          ? `${total - classified} of ${total} product(s) unclassified at "${level}" (${topUnclassified} under Unclassified).`
          : null,
      provenance: { source: 'metrics/sales-data-adapter.js: deriveEnrichmentFromShopifyShape (categoryPathByProduct)' },
      details: { total_products: total, classified, unclassified: total - classified, coverage_pct: pct },
    });
  });

  const withCollections = data.products.filter((p) => (enrichment.collectionsByProduct?.get(p.id) ?? []).length > 0).length;
  rows.push(check({
    id: 'collection_coverage', section: 'catalog', label: 'Products with at least one collection',
    status: total === 0 ? 'unavailable' : withCollections === 0 ? 'warning' : 'ok', severity: 'info',
    count: withCollections, value: total > 0 ? round2((withCollections / total) * 100) : null, blocking: false,
    recommended_action: total > 0 && withCollections < total ? `${total - withCollections} of ${total} product(s) belong to no collection.` : null,
    provenance: { source: 'metrics/sales-data-adapter.js: deriveEnrichmentFromShopifyShape (collectionsByProduct)' },
    details: { total_products: total, with_collection: withCollections },
  }));
  return rows;
}

function stockCoverageCheck(ledger, now, config) {
  const stock = buildLargestStockPositions(ledger, now, config);
  return check({
    id: 'stock_coverage', section: 'inventory', label: 'Stock value at cost',
    status: stock.total_stock_units === 0 ? 'unavailable' : stock.units_without_cost === 0 ? 'ok' : 'warning',
    severity: 'info', count: stock.total_stock_units, value: stock.total_value_at_cost, blocking: false,
    recommended_action: stock.units_without_cost > 0 ? `${stock.units_without_cost} unit(s) in stock have no cost on file — their stock value is excluded from the total above, not assumed zero.` : null,
    provenance: { source: 'analysis/triage.js: buildLargestStockPositions' },
    details: { units_without_cost: stock.units_without_cost, round_quantity_units: stock.round_quantity_units },
  });
}

function financeChecks(company) {
  const companyRow = check({
    id: 'finance_company', section: 'finance', label: 'Company profile configured',
    status: company ? 'ok' : 'blocked', severity: company ? 'info' : 'critical',
    count: company ? 1 : 0, blocking: !company, blocks: company ? [] : ['finance_invoicing'],
    recommended_action: company ? null : 'Create a company profile (seller identity) in Finance settings before issuing any quote/invoice.',
    provenance: { source: 'fin_companies row (pre-fetched by caller)' },
  });
  if (!company) return [companyRow];

  const hasTaxId = Boolean(company.vat_number || company.enterprise_number);
  const vatRow = check({
    id: 'finance_vat', section: 'finance', label: 'VAT / enterprise number on file',
    status: hasTaxId ? 'ok' : 'warning', severity: hasTaxId ? 'info' : 'warning',
    count: hasTaxId ? 1 : 0, blocking: false,
    recommended_action: hasTaxId ? null : 'No VAT or enterprise number on file. Add one if your business is required to display one on invoices — this varies by merchant status, so it is reported, not assumed mandatory.',
    provenance: { source: 'fin_companies.vat_number / enterprise_number' },
  });
  const peppolRow = check({
    id: 'finance_peppol', section: 'finance', label: 'Peppol e-invoicing configured',
    status: company.peppol_id ? 'ok' : 'warning', severity: 'info',
    count: company.peppol_id ? 1 : 0, blocking: false,
    recommended_action: company.peppol_id ? null : 'Peppol is not configured. Needed only if you send B2B e-invoices in Belgium/EU — increasingly mandated, worth setting up ahead of time.',
    provenance: { source: 'fin_companies.peppol_id' },
  });
  return [companyRow, vatRow, peppolRow];
}

/** Reuses the exact same staleness threshold as STALE_INVENTORY_SNAPSHOT for consistency - never a second invented number for "how stale is too stale". */
function connectorChecks(data, flags, connectors, config) {
  const rows = [];
  const staleFlag = flags.find((f) => f.rule_code === 'STALE_INVENTORY_SNAPSHOT');
  rows.push(check({
    id: 'connector_inventory_sync', section: 'connectors', label: 'Inventory sync freshness',
    status: staleFlag ? (staleFlag.details.reason === 'NO_SNAPSHOT_EXISTS' ? 'blocked' : 'warning') : 'ok',
    severity: staleFlag?.severity ?? 'info',
    count: null, blocking: staleFlag?.details.reason === 'NO_SNAPSHOT_EXISTS', blocks: staleFlag?.details.reason === 'NO_SNAPSHOT_EXISTS' ? ['hierarchy_analytics'] : [],
    recommended_action: staleFlag ? (staleFlag.details.reason === 'NO_SNAPSHOT_EXISTS' ? 'No inventory snapshot has ever synced. Run the inventory sync before trusting any stock figure.' : `Latest inventory snapshot is ${staleFlag.details.age_hours}h old (limit ${staleFlag.details.max_age_hours}h). Check the sync job.`) : null,
    provenance: { source: 'quality/rules.js: detectQualityFlags (STALE_INVENTORY_SNAPSHOT); threshold config.quality.staleInventoryHours' },
  }));

  const lastSyncOf = (rows2, field = 'synced_at') => rows2.reduce((a, r) => (!a || r[field] > a ? r[field] : a), null);
  rows.push(check({
    id: 'connector_collections_sync', section: 'connectors', label: 'Collections sync last seen',
    status: data.collections?.length ? 'ok' : 'unavailable', severity: 'info',
    count: data.collections?.length ?? 0,
    recommended_action: !data.collections?.length ? 'No product_collections rows synced yet — collection-level analytics will be empty, not wrong.' : null,
    provenance: { source: 'product_collections.synced_at (max)' },
    details: { last_synced_at: data.collections?.length ? lastSyncOf(data.collections) : null },
  }));
  rows.push(check({
    id: 'connector_attribution_sync', section: 'connectors', label: 'Order attribution sync last seen',
    status: data.orderAttribution?.length ? 'ok' : 'unavailable', severity: 'info',
    count: data.orderAttribution?.length ?? 0,
    provenance: { source: 'order_attribution.synced_at (max)' },
    details: { last_synced_at: data.orderAttribution?.length ? lastSyncOf(data.orderAttribution) : null },
  }));
  // Products/variants/orders/costs carry no sync timestamp column in the current schema - reported as a real,
  // known gap rather than fabricated from an unrelated column (e.g. source_created_at is the product's own
  // creation date in Shopify, not our sync time).
  rows.push(check({
    id: 'connector_catalog_sync_timestamp', section: 'connectors', label: 'Catalog/orders sync freshness',
    status: 'unavailable', severity: 'info', blocking: false,
    recommended_action: 'products/variants/orders/costs carry no sync timestamp column today — freshness for these cannot be reported until one is added. Known schema gap, not a bug.',
    provenance: { source: 'schema: no synced_at column on products/variants/orders/product_costs' },
  }));

  for (const [name, status] of Object.entries(connectors ?? {})) {
    const known = status?.tokenOk !== undefined;
    rows.push(check({
      id: `connector_${name}_auth`, section: 'connectors', label: `${name} connection`,
      status: !known ? 'unavailable' : status.tokenOk ? 'ok' : 'blocked',
      severity: known && !status.tokenOk ? 'critical' : 'info',
      blocking: known && !status.tokenOk, blocks: known && !status.tokenOk ? ['hierarchy_analytics', 'finance_invoicing'] : [],
      recommended_action: known && !status.tokenOk ? `${name} authentication failed at ${status.checkedAt?.toISOString?.() ?? 'last check'} — reconnect before trusting any new data.` : null,
      provenance: { source: `live connector check (caller-supplied, not fetched by the wizard)` },
      details: { checked_at: status?.checkedAt ?? null },
    }));
  }
  if (!connectors || Object.keys(connectors).length === 0) {
    rows.push(check({
      id: 'connector_auth_unknown', section: 'connectors', label: 'Connector authentication status',
      status: 'unavailable', severity: 'info', blocking: false,
      recommended_action: 'No live connector check was performed for this report.',
      provenance: { source: 'not supplied by caller' },
    }));
  }
  return rows;
}

function computeGates(allChecks, data) {
  const blockersFor = (gate) => allChecks.filter((c) => c.blocking && c.blocks.includes(gate)).map((c) => c.id);
  const gates = {};
  for (const gate of READINESS_GATES) {
    const blocking_checks = blockersFor(gate);
    // hierarchy_analytics has an additional structural precondition no single check owns: something to analyze at all.
    const structurallyBlocked = gate === 'hierarchy_analytics' && (data.products.length === 0 || data.orders.length === 0);
    gates[gate] = {
      ready: blocking_checks.length === 0 && !structurallyBlocked,
      blocking_checks: structurallyBlocked ? [...blocking_checks, 'no_catalog_or_order_data'] : blocking_checks,
    };
  }
  return gates;
}

/**
 * @param {{ledger: object, data: object, enrichment: object|null, company: object|null, connectors?: object,
 *           now?: Date, timeZone?: string, window?: object, config: object}} input
 */
export function buildSetupReport({ ledger, data, enrichment = null, company = null, connectors = {}, now = new Date(), timeZone = 'UTC', window, config }) {
  const win = window ?? buildWindows(now, timeZone).available_window;
  const flags = detectQualityFlags(data, ledger, { merchantId: null, now, config });

  const sections = {
    catalog: [
      missingCostCheck(data, ledger, flags, win, now),
      missingSkuCheck(data),
      duplicateSkuCheck(flags),
      unmatchedHistoricalCheck(flags),
      ...hierarchyCoverageChecks(data, enrichment),
    ],
    inventory: [stockCoverageCheck(ledger, now, config)],
    finance: financeChecks(company),
    connectors: connectorChecks(data, flags, connectors, config),
  };
  const allChecks = Object.values(sections).flat();
  return {
    wizard_version: WIZARD_VERSION,
    generated_at: now.toISOString(),
    window: { key: win.key, start: win.start.toISOString(), end: win.end.toISOString() },
    sections,
    checks: allChecks,
    gates: computeGates(allChecks, data),
  };
}
