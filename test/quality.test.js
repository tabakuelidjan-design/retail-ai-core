import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/metrics/ledger.js';
import { detectQualityFlags } from '../src/quality/rules.js';
import { syncQualityFlags } from '../src/quality/flags.js';
import { CONFIG, makeData } from './fixtures/metrics-sample.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';

const NOW = new Date('2026-09-21T09:00:00Z');
const detect = (data, now = NOW) => detectQualityFlags(data, buildLedger(data, { config: CONFIG }), { merchantId: 'm1', now, config: CONFIG });
const byRule = (flags, rule) => flags.filter((f) => f.rule_code === rule);

test('missing cost is flagged only for variants that sold or hold stock', () => {
  const data = makeData();
  data.variants.push({ id: 'v9', product_id: 'p4', sku: 'X-9', title: 'Never sold, no stock, no cost' });
  const flags = byRule(detect(data), 'MISSING_COST');
  assert.deepEqual(flags.map((f) => f.entity_id), ['v3']); // sold + stock, no cost; v9 is harmless
  assert.equal(flags[0].severity, 'warning');
  assert.equal(flags[0].details.reason, 'NO_COST_ROW');
});

test('a zero cost row is flagged as suspicious and the variant as missing cost', () => {
  const data = makeData();
  data.costs = data.costs.map((c) => (c.variant_id === 'v2' ? { ...c, unit_cost: 0 } : c));
  const flags = detect(data);
  assert.ok(byRule(flags, 'MISSING_COST').some((f) => f.entity_id === 'v2'));
  assert.ok(byRule(flags, 'SUSPICIOUS_FINANCIAL_VALUE').some((f) => f.details.problems.includes('NON_POSITIVE_COST')));
});

test('duplicate SKU: one flag per shared SKU, not one per variant', () => {
  const data = makeData();
  data.variants.push({ id: 'v5', product_id: 'p2', sku: 'W-1', title: 'Same sku as v1' });
  data.variants.push({ id: 'v6', product_id: 'p3', sku: 'W-1', title: 'Same sku as v1' });
  const flags = byRule(detect(data), 'DUPLICATE_SKU_OBSERVATION');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].details.variant_count, 3);
  assert.equal(flags[0].severity, 'warning'); // one of them has sales
});

test('null or empty SKUs never count as duplicates', () => {
  const data = makeData();
  data.variants.push({ id: 'v5', product_id: 'p2', sku: null }, { id: 'v6', product_id: 'p3', sku: null }, { id: 'v7', product_id: 'p3', sku: ' ' }, { id: 'v8', product_id: 'p3', sku: ' ' });
  assert.equal(byRule(detect(data), 'DUPLICATE_SKU_OBSERVATION').length, 0);
});

test('suspicious financial values: negative price, discount above gross, zero price - but a normal discount is not flagged', () => {
  const data = makeData();
  data.orderLines.push(
    { id: 'bad1', order_id: 'o2', variant_id: 'v1', title_snapshot: 'x', quantity: 1, unit_price: -5, discount_amount: 0, tax_amount: 0 },
    { id: 'bad2', order_id: 'o2', variant_id: 'v1', title_snapshot: 'x', quantity: 1, unit_price: 10, discount_amount: 15, tax_amount: 0 },
    { id: 'zero', order_id: 'o2', variant_id: 'v1', title_snapshot: 'x', quantity: 1, unit_price: 0, discount_amount: 0, tax_amount: 0 },
  );
  const flags = byRule(detect(data), 'SUSPICIOUS_FINANCIAL_VALUE');
  const byEntity = Object.fromEntries(flags.map((f) => [f.entity_id, f]));
  assert.deepEqual(byEntity.bad1.details.problems, ['NEGATIVE_UNIT_PRICE']);
  assert.ok(byEntity.bad2.details.problems.includes('DISCOUNT_EXCEEDS_GROSS'));
  assert.equal(byEntity.zero.severity, 'info');
  assert.equal(byEntity.l1, undefined); // l1 carries a legitimate discount
});

test('unmatched historical variant: a sold line with no catalog variant', () => {
  const data = makeData();
  data.orderLines.push({ id: 'orphan', order_id: 'o2', variant_id: null, title_snapshot: 'Deleted item', sku_snapshot: 'OLD', quantity: 1, unit_price: 5, discount_amount: 0, tax_amount: 0 });
  const flags = byRule(detect(data), 'UNMATCHED_HISTORICAL_VARIANT');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].entity_id, 'orphan');
});

test('refund without mapping: money refunded but no product line attached; a mapped refund with extra shipping is not flagged', () => {
  const data = makeData();
  assert.equal(byRule(detect(data), 'REFUND_WITHOUT_EXPECTED_MAPPING').length, 0); // r1 has a line plus 5.00 shipping: expected
  data.refunds.push({ id: 'r2', order_id: 'o2', amount: 12, refunded_at: '2026-09-16T00:00:00Z' });
  const flags = byRule(detect(data), 'REFUND_WITHOUT_EXPECTED_MAPPING');
  assert.deepEqual(flags.map((f) => f.entity_id), ['r2']);
});

test('stale inventory snapshot: flagged when the newest snapshot is older than the freshness window, not before', () => {
  assert.equal(byRule(detect(makeData(), new Date('2026-09-20T20:00:00Z')), 'STALE_INVENTORY_SNAPSHOT').length, 0); // 8h old
  const stale = byRule(detect(makeData(), NOW), 'STALE_INVENTORY_SNAPSHOT'); // 21h... snapshot 2026-09-20T12:00Z
  assert.equal(stale.length, 0);
  const [flag] = byRule(detect(makeData(), new Date('2026-09-23T12:00:00Z')), 'STALE_INVENTORY_SNAPSHOT');
  assert.equal(flag.entity_type, 'merchant');
  assert.equal(flag.details.age_hours, 72);

  const none = makeData();
  none.snapshots = [];
  assert.equal(byRule(detect(none), 'STALE_INVENTORY_SNAPSHOT')[0].severity, 'critical');
});

test('every flag carries rule_code, entity, severity and evidence details', () => {
  for (const f of detect(makeData(), new Date('2026-09-23T12:00:00Z'))) {
    assert.ok(f.rule_code && f.entity_type && f.entity_id && ['info', 'warning', 'critical'].includes(f.severity));
    assert.equal(typeof f.details, 'object');
  }
});

test('persistence is idempotent, never duplicates open flags, resolves cleared ones and reopens returning ones', async () => {
  const supabase = createFakeSupabase();
  const data = makeData();
  const run = (d, now) => syncQualityFlags({ supabase }, { merchantId: 'm1', detected: detect(d, now), now });

  const first = await run(data, NOW);
  assert.ok(first.created >= 1);
  const rowsAfterFirst = supabase._tables.get('data_quality_flags').length;
  assert.ok(supabase._tables.get('data_quality_flags').every((r) => r.status === 'open' && r.detected_at));

  const second = await run(data, NOW);
  assert.equal(second.created, 0);
  assert.equal(second.alreadyOpen, first.created);
  assert.equal(supabase._tables.get('data_quality_flags').length, rowsAfterFirst);

  // Cost for v3 gets recorded: its MISSING_COST condition clears.
  data.costs.push({ variant_id: 'v3', unit_cost: 6, currency: 'EUR', effective_from: '2026-01-01T00:00:00Z', source: 'manual_entry', validation_status: 'verified' });
  const third = await run(data, NOW);
  assert.equal(third.resolved, 1);
  const v3 = supabase._tables.get('data_quality_flags').find((r) => r.rule_code === 'MISSING_COST' && r.entity_id === 'v3');
  assert.equal(v3.status, 'resolved');
  assert.ok(v3.resolved_at);

  // The condition returns (cost removed again): a fresh open flag is created, the resolved row stays as history.
  data.costs.pop();
  const reopened = await run(data, NOW);
  assert.equal(reopened.created, 1);
  assert.equal(supabase._tables.get('data_quality_flags').filter((r) => r.rule_code === 'MISSING_COST' && r.entity_id === 'v3').length, 2);

  // A flag a human deliberately ignored is neither duplicated nor resolved by the engine.
  const dup = supabase._tables.get('data_quality_flags').find((r) => r.rule_code === 'MISSING_COST' && r.status === 'open');
  if (dup) {
    dup.status = 'ignored';
    const fourth = await run(data, NOW);
    assert.equal(fourth.keptIgnored, 1);
    assert.equal(dup.status, 'ignored');
  }
});
