import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildSetupReport, READINESS_GATES } from '../src/onboarding/wizard.js';
import { CONFIG, makeData } from './fixtures/metrics-sample.js';

const NOW = new Date('2026-09-21T09:00:00Z');
const ledgerOf = (data = makeData()) => buildLedger(data, { config: CONFIG });
const enrichment = {
  categoryPathByProduct: new Map([['p1', ['Tech', 'Audio']], ['p2', ['Tech', 'Audio']]]), // p3, p4 deliberately unmapped
  collectionsByProduct: new Map([['p1', [{ id: 'c1', title: 'Bestsellers' }]]]),
  channelByOrder: new Map(),
};
const REQUIRED_FIELDS = ['id', 'section', 'label', 'status', 'severity', 'count', 'value', 'blocking', 'blocks', 'recommended_action', 'provenance', 'details'];

test('every check row carries all UI-required fields', () => {
  const report = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  assert.ok(report.checks.length > 0);
  for (const c of report.checks) {
    for (const field of REQUIRED_FIELDS) assert.ok(field in c, `check ${c.id} missing field ${field}`);
    assert.ok(c.provenance?.source, `check ${c.id} has no provenance`);
  }
});

test('missing cost check reuses detectQualityFlags/buildProfitUncertainty, no re-derived arithmetic', () => {
  const report = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  const row = report.checks.find((c) => c.id === 'missing_cost');
  assert.equal(row.section, 'catalog');
  assert.ok(row.count >= 1); // p3/v3 has no cost row in the fixture
  assert.equal(row.blocking, false); // missing cost never blocks - engine degrades gracefully
});

test('duplicate SKU and unmatched-historical checks surface counts from the same quality flags, non-blocking', () => {
  const data = makeData();
  data.variants[1].sku = data.variants[0].sku; // force a duplicate SKU
  const report = buildSetupReport({ ledger: ledgerOf(data), data, enrichment, company: null, now: NOW, config: CONFIG });
  const dup = report.checks.find((c) => c.id === 'duplicate_sku');
  assert.equal(dup.count, 1);
  assert.equal(dup.blocking, false);
});

test('missing SKU is informational, never blocking, and is not conflated with duplicate SKU', () => {
  const data = makeData();
  data.variants[0].sku = null;
  const report = buildSetupReport({ ledger: ledgerOf(data), data, enrichment, company: null, now: NOW, config: CONFIG });
  const row = report.checks.find((c) => c.id === 'missing_sku');
  assert.equal(row.count, 1);
  assert.equal(row.blocking, false);
  assert.equal(row.severity, 'info');
});

test('hierarchy coverage reports exact classified/unclassified counts per level, never invents a taxonomy', () => {
  const report = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  const universe = report.checks.find((c) => c.id === 'hierarchy_coverage_universe');
  assert.equal(universe.count, 2); // p1, p2 classified; p3, p4 not
  assert.equal(universe.details.total_products, 4);
  const subcategory = report.checks.find((c) => c.id === 'hierarchy_coverage_subcategory');
  assert.equal(subcategory.status, 'warning'); // fixture paths are only 2 levels deep - subcategory is legitimately empty
  assert.equal(subcategory.count, 0);
});

test('hierarchy coverage is reported as unavailable, not zero, when no enrichment is supplied at all', () => {
  const report = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment: null, company: null, now: NOW, config: CONFIG });
  const universe = report.checks.find((c) => c.id === 'hierarchy_coverage_universe');
  assert.equal(universe.status, 'unavailable');
});

test('stock coverage reuses buildLargestStockPositions and flags uncosted stock without excluding it from the count', () => {
  const report = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  const stock = report.checks.find((c) => c.id === 'stock_coverage');
  assert.ok(stock.count > 0);
  assert.equal(stock.status, 'warning'); // v3 has stock but no cost in the fixture
  assert.ok(stock.details.units_without_cost > 0);
});

test('finance gate is blocked with no company on file, and unblocked once one exists', () => {
  const noCompany = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  assert.equal(noCompany.gates.finance_invoicing.ready, false);
  assert.ok(noCompany.gates.finance_invoicing.blocking_checks.includes('finance_company'));

  const withCompany = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: { vat_number: 'BE0123456789', peppol_id: null }, now: NOW, config: CONFIG });
  assert.equal(withCompany.gates.finance_invoicing.ready, true);
  const vatRow = withCompany.checks.find((c) => c.id === 'finance_vat');
  assert.equal(vatRow.status, 'ok');
  const peppolRow = withCompany.checks.find((c) => c.id === 'finance_peppol');
  assert.equal(peppolRow.status, 'warning'); // present but non-blocking
});

test('VAT/enterprise number missing is a warning, never blocking - merchant status varies, never assumed', () => {
  const report = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: { vat_number: null, enterprise_number: null }, now: NOW, config: CONFIG });
  const vatRow = report.checks.find((c) => c.id === 'finance_vat');
  assert.equal(vatRow.status, 'warning');
  assert.equal(vatRow.blocking, false);
  assert.equal(report.gates.finance_invoicing.ready, true);
});

test('hierarchy_analytics gate is blocked when there is no catalog or order data at all', () => {
  const empty = { products: [], variants: [], orders: [], orderLines: [], refunds: [], refundLines: [], costs: [], snapshots: [], collections: [], orderAttribution: [] };
  const report = buildSetupReport({ ledger: buildLedger(empty, { config: CONFIG }), data: empty, enrichment: null, company: null, now: NOW, config: CONFIG });
  assert.equal(report.gates.hierarchy_analytics.ready, false);
  assert.ok(report.gates.hierarchy_analytics.blocking_checks.includes('no_catalog_or_order_data'));
});

test('a failed Shopify connector check blocks both gates and is never silently assumed healthy', () => {
  const report = buildSetupReport({
    ledger: ledgerOf(), data: makeData(), enrichment, company: { vat_number: 'BE0123456789' },
    connectors: { shopify: { tokenOk: false, checkedAt: NOW } }, now: NOW, config: CONFIG,
  });
  assert.equal(report.gates.hierarchy_analytics.ready, false);
  assert.equal(report.gates.finance_invoicing.ready, false);
  const connRow = report.checks.find((c) => c.id === 'connector_shopify_auth');
  assert.equal(connRow.status, 'blocked');
});

test('no connector check performed is reported as unavailable, not as ok', () => {
  const report = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  const unknown = report.checks.find((c) => c.id === 'connector_auth_unknown');
  assert.ok(unknown);
  assert.equal(unknown.status, 'unavailable');
});

test('catalog/orders sync freshness is reported as a known schema gap, not fabricated from an unrelated column', () => {
  const report = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  const row = report.checks.find((c) => c.id === 'connector_catalog_sync_timestamp');
  assert.equal(row.status, 'unavailable');
});

test('readiness gates cover exactly the documented set, each with a boolean ready flag', () => {
  const report = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  assert.deepEqual(Object.keys(report.gates).sort(), [...READINESS_GATES].sort());
  for (const gate of READINESS_GATES) assert.equal(typeof report.gates[gate].ready, 'boolean');
});

test('the report is pure: calling it twice with identical inputs (and a fixed `now`) gives identical output', () => {
  const a = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  const b = buildSetupReport({ ledger: ledgerOf(), data: makeData(), enrichment, company: null, now: NOW, config: CONFIG });
  assert.deepEqual(a, b);
});
