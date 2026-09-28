// Nordla sales semantics (metrics/net-sales.js): A. net sales are order-dated, net of every refund of the order; B. refund activity
// is refund-dated. Every Growth page must return the same net sales for the same window (Growth deep audit P1-1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { orderNetFacts, netSalesInWindow, netSalesByProduct, refundActivity } from '../src/metrics/net-sales.js';
import { productPotentialFacts } from '../src/growth/products/facts.js';
import { buildProductPotential } from '../src/growth/products/potential.js';
import { contentFacts } from '../src/growth/content/facts.js';
import { buildContent } from '../src/growth/content/content.js';
import { storeFacts } from '../src/growth/store/facts.js';
import { buildStore } from '../src/growth/store/store.js';
import { audienceFacts } from '../src/growth/audience/facts.js';
import { buildAudience } from '../src/growth/audience/audience.js';

const CONFIG = mergeConfig();
const NOW = new Date('2026-09-21T09:00:00Z'); // a Monday: the 8-week window is [2026-07-27, 2026-09-21)
const TZ = 'UTC';
const DAY = 86400000;
const WINDOW = { start: new Date('2026-07-27T00:00:00Z'), end: new Date('2026-09-21T00:00:00Z') };
const at = (daysBeforeNow, hour = 11) => new Date(NOW.getTime() - daysBeforeNow * DAY + (hour - 9) * 3600000).toISOString();

/**
 * Four products, one per scenario; each also has steady sales so that it is an active, observed product everywhere.
 *   A: an order BEFORE the window, fully refunded INSIDE the window
 *   B: an order inside the window, refunded inside the window
 *   C: an order inside the window, refunded AFTER the window (today, before now)
 *   D: an order inside the window, no refund
 */
function makeData() {
  const products = []; const variants = []; const orders = []; const orderLines = []; const refunds = []; const refundLines = [];
  let n = 0;
  const order = (pid, daysAgo, price = 100, qty = 1) => {
    n += 1;
    orders.push({ id: `o${n}`, ordered_at: at(daysAgo), status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, channel_handle: 'pos', source_name: 'pos', location_id: 'loc', customer_key: `cust-${pid}-${n % 3}`, customer_order_index: 1, journey_ready: true });
    orderLines.push({ id: `l${n}`, order_id: `o${n}`, variant_id: `v-${pid}`, title_snapshot: pid, sku_snapshot: pid, quantity: qty, unit_price: price, discount_amount: 0, tax_amount: 0 });
    return `l${n}`;
  };
  const refund = (lineId, daysAgo, amount = 100, hour = 11) => {
    const id = `r${refunds.length + 1}`;
    refunds.push({ id, order_id: orderLines.find((l) => l.id === lineId).order_id, amount, refunded_at: at(daysAgo, hour) });
    refundLines.push({ id: `${id}-l`, refund_id: id, order_line_id: lineId, quantity: 1, amount, tax_amount: 0 });
  };
  for (const pid of ['A', 'B', 'C', 'D']) {
    products.push({ id: pid, title: `Produit ${pid}`, product_type: 'Cat', source_created_at: '2025-01-01T00:00:00Z', source_status: 'ACTIVE', image_url: null, image_alt_text: null, source_id: `gid-${pid}` });
    variants.push({ id: `v-${pid}`, product_id: pid, sku: pid, title: 'Default', source_id: `gid-v-${pid}` });
    for (let w = 0; w < 8; w += 1) order(pid, 3 + w * 7, 20); // steady weekly sales inside the window
  }
  refund(order('A', 70), 20); // A: ordered before the window, refunded inside it
  refund(order('B', 30), 10); // B: ordered and refunded inside the window
  refund(order('C', 15), 0, 100, 5); // C: ordered inside the window, refunded today after the window end (05:00 < now 09:00)
  order('D', 12); // D: no refund
  return { products, variants, orders, orderLines, refunds, refundLines, costs: [], snapshots: [], collections: [], locations: [{ id: 'loc', name: 'Magasin', type: 'retail', source_id: 'gid-loc' }], firstOrderAt: at(300) };
}

test('sales semantics A: order-dated net, every refund of the order deducted from THAT order', () => {
  const ledger = buildLedger(makeData(), { config: CONFIG });
  const facts = orderNetFacts(ledger, CONFIG);
  const byProduct = netSalesByProduct(facts, WINDOW);
  assert.equal(byProduct.get('A').net, 160, 'A: only its 8 in-window sales; the old order and its refund belong to the previous period');
  assert.equal(byProduct.get('B').net, 160, 'B: 160 + 100 - 100 (refunded inside the window)');
  assert.equal(byProduct.get('C').net, 160, 'C: refunded after the window -> the refund still reduces the order it belongs to');
  assert.equal(byProduct.get('D').net, 260, 'D: 160 + 100');
  assert.equal(netSalesInWindow(facts, WINDOW).net, 740);
  const prev = { start: new Date(WINDOW.start.getTime() - 56 * DAY), end: WINDOW.start };
  assert.equal(netSalesByProduct(facts, prev).get('A').net, 0, 'the old order of A is fully refunded in its own period');
});

test('sales semantics B: refund activity is dated by the refund, whatever the order date', () => {
  const ledger = buildLedger(makeData(), { config: CONFIG });
  assert.deepEqual(refundActivity(ledger, WINDOW), { refundLines: 2, units: 2, amountExTax: 200 }, 'A and B refunded inside the window; C refunded after it');
});

test('cross-page: Produits Potentiels, Contenu, Croissance magasin and Audience return the same net sales for the same orders', () => {
  const data = makeData();
  const expected = netSalesByProduct(orderNetFacts(buildLedger(data, { config: CONFIG }), CONFIG), WINDOW);

  const pf = productPotentialFacts({ data, now: NOW, timeZone: TZ, config: CONFIG });
  const potential = buildProductPotential(pf.facts, { config: CONFIG, currency: 'EUR', window: pf.window, dataQuality: {} });
  const content = buildContent(contentFacts({ data, now: NOW, timeZone: TZ, config: CONFIG }));
  const sf = storeFacts({ data, now: NOW, timeZone: TZ, config: CONFIG });
  const store = buildStore({ ...sf, potential: new Map(), config: CONFIG });

  assert.equal(new Date(pf.window.start).getTime(), WINDOW.start.getTime(), 'same 8-week window');
  assert.equal(content.window.start, WINDOW.start.toISOString());
  assert.equal(store.window.start, WINDOW.start.toISOString());
  for (const pid of ['A', 'B', 'C', 'D']) {
    const want = expected.get(pid).net;
    assert.equal(potential.rows.find((r) => r.id === pid).netSales, want, `Produits Potentiels ${pid}`);
    assert.equal(content.rows.find((r) => r.id === pid).netSales, want, `Contenu ${pid}`);
    assert.equal(store.topProducts.find((p) => p.id === pid).net, want, `Croissance magasin ${pid}`);
  }
  assert.equal(store.kpis.storeNet.value, 740, 'store KPI = the same total (every order is an in-store order)');
  assert.equal(potential.totals.netSales, 740, 'Produits Potentiels total');
  assert.equal(content.rows.reduce((a, r) => a + r.netSales, 0), 740, 'Contenu total');

  // Audience uses its own 90-day window: its figure must be exactly the canonical figure for that window.
  const af = audienceFacts({ data, now: NOW, timeZone: TZ, config: CONFIG });
  const audience = buildAudience({ orders: af.orders, window: af.window, historyStart: af.historyStart, config: CONFIG, currency: af.currency });
  const canonical90 = netSalesInWindow(orderNetFacts(buildLedger(data, { config: CONFIG }), CONFIG), { start: af.window.start, end: af.window.end });
  assert.equal(audience.orderFacts.current.netSales, canonical90.net);
  assert.equal(audience.orderFacts.current.orders, canonical90.orders);
});

test('cross-page: refund rates follow the same order-dated rule (Produits Potentiels and Croissance magasin agree)', () => {
  const data = makeData();
  const pf = productPotentialFacts({ data, now: NOW, timeZone: TZ, config: CONFIG });
  const potential = buildProductPotential(pf.facts, { config: CONFIG, currency: 'EUR', window: pf.window, dataQuality: {} });
  assert.equal(potential.rows.find((r) => r.id === 'A').refunds.units, 0, 'the refund of an old order is not a refund of this period’s sales');
  assert.equal(potential.rows.find((r) => r.id === 'B').refunds.units, 1);
  assert.equal(potential.rows.find((r) => r.id === 'C').refunds.units, 1, 'refunded after the window, still a refund of an in-window sale');
  const store = buildStore({ ...storeFacts({ data, now: NOW, timeZone: TZ, config: CONFIG }), potential: new Map(), config: CONFIG });
  assert.equal(store.store.refundRate, Math.round((2 / 35) * 10000) / 10000, '2 refunded units out of the 35 sold in the window');
});
