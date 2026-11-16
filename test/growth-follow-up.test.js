import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrowthApp } from '../src/growth/server/app.js';
import { prepareOpportunityAction } from '../src/growth/priorities/actions.js';
import { all, growthDom, potentialPayload, prioritiesPayload, text } from './growth-dom.js';

test('opportunity endpoint supplies the engine period and a merchant-specific history scope', async () => {
  const products = potentialPayload();
  assert.ok(products.rows.length);
  async function load(merchantId) {
    const handler = createGrowthApp({ productPotential: async () => products, merchantId });
    let body;
    await handler({ method: 'GET', url: '/api/growth/opportunities' }, {
      writeHead(code) { assert.equal(code, 200); },
      end(json) { body = JSON.parse(json); },
    });
    return body;
  }
  const first = await load('merchant-a');
  const second = await load('merchant-b');
  assert.notEqual(first.historyScope, second.historyScope);
  assert.match(first.historyScope, /^[a-f0-9]{64}$/);
  const product = first.sections.commercial.find((item) => item.kind === 'product');
  assert.ok(product);
  assert.ok(product.preparedAction);
  assert.deepEqual(product.measurement, {
    start: products.window.start, end: products.window.end, calculatedAt: products.generatedAt,
  });
});

test('variant action requires a unique sales leader among verified sellable variants', () => {
  const item = { category: 'commercial', kind: 'product', entity: { id: 'product', title: 'Headset' },
    title: { code: 'product.push.title' } };
  const variant = (id, unitsNet, units, usable = true) => ({
    id, title: id, unitsNet, stock: { usable, units, snapshotAt: '2026-09-01T09:00:00Z' }, cover: { status: 'CALCULATED', weeks: 8, minWeeks: 4 },
  });
  const window = { since: '2026-08-01T00:00:00Z', until: '2026-09-01T00:00:00Z' };
  const productWindow = { start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z' };
  const blue = variant('blue', 4, 6);
  const black = variant('black', 3, 5);
  const soldOut = variant('gray', 10, 0);
  const action = prepareOpportunityAction(item, { variants: [black, soldOut, blue] }, window, productWindow);
  assert.deepEqual(action.variant, { id: 'blue', title: 'blue', unitsNet: 4, stockUnits: 6,
    stockSnapshotAt: '2026-09-01T09:00:00Z', coverWeeks: 8, minCoverWeeks: 4, ...window });
  assert.equal(prepareOpportunityAction(item, { variants: [blue, variant('red', 4, 7)] }, window, productWindow).code, 'product');
  assert.equal(prepareOpportunityAction(item, { variants: [blue, variant('red', 8, 7, false)] }, window, productWindow).code, 'product');
  assert.equal(prepareOpportunityAction(item, { variants: [blue] }, null).code, 'product');
  assert.equal(prepareOpportunityAction({ ...item, category: 'watch' }, { variants: [blue] }, window, productWindow), null);
  assert.equal(prepareOpportunityAction({ ...item, title: { code: 'product.restock.title' } },
    { variants: [blue] }, window, productWindow).code, 'restock');
});

test('qualified audience gets a purpose-specific email draft without recipient identities', async () => {
  const data = prioritiesPayload();
  const base = { category: 'commercial', kind: 'segment', id: 'audience:segment:reactivate',
    entity: { id: 'reactivate' }, sourcePage: 'audience',
    evidence: { customers: 38, days: 90, orders: 0 } };
  const item = { ...base, explanation: { params: { action: 'reactivation' } } };
  const loyalty = { ...base, id: 'audience:segment:loyal', entity: { id: 'loyal' },
    explanation: { params: { action: 'loyalty' } } };
  const items = [item, loyalty].map((entry) => ({ ...entry, preparedAction: prepareOpportunityAction(entry) }));
  assert.equal(prepareOpportunityAction({ ...base, explanation: { params: { action: 'none' } } }), null);
  assert.deepEqual(items[0].preparedAction.campaign, { purpose: 'reactivation', customers: 38, days: 90, baselineOrders: 0, reason: { rule: null, revenueShare: null, activeShare: null, previousCustomers: null }, eligible: null });
  const { root, errors } = await growthDom('#/opportunities', {
    opportunities: { ...data, sections: { ...data.sections, commercial: items } },
  });
  assert.deepEqual(errors, []);
  assert.match(text(root), /38 clients dans le segment/);
  assert.match(text(root), /0 commandes sur la période analysée de 90 jours/);
  assert.match(text(root), /Cela fait un moment qu’on ne s’est pas vus/);
  assert.match(text(root), /Merci de revenir chez nous/); // no ranking here: both actions are lines under "Autres actions", each with its own draft
  assert.equal(all(root, (node) => node.tagName === 'TEXTAREA').length, 6);
});

test('tracking survives a reload and disappearing opportunity, with isolation by merchant', async () => {
  const data = prioritiesPayload();
  assert.ok(data.sections.commercial.length);
  const item = { ...data.sections.commercial[0], preparedAction: { code: 'product', target: { title: 'Casque noir' } }, measurement: {
    start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z', calculatedAt: '2026-09-10T10:00:00Z',
  } };
  const entries = new Map();
  const storage = {
    get length() { return entries.size; },
    key: (i) => [...entries.keys()][i],
    getItem: (k) => entries.get(k) ?? null,
    setItem: (k, v) => entries.set(k, v),
  };
  async function open(scope, items) {
    const opportunities = { ...data, historyScope: scope, sections: { ...data.sections, commercial: items } };
    const ui = await growthDom('#/overview', { opportunities });
    ui.ctx.localStorage = storage;
    await ui.navigate('#/opportunities');
    assert.deepEqual(ui.errors, []);
    return ui.root;
  }
  const forms = (root) => all(root, (n) => n.tagName === 'FORM' && ['plan', 'review'].includes(n.getAttribute('data-form')));
  const inputs = (form) => all(form, (n) => n.tagName === 'INPUT');
  const submit = (form) => form.listeners.submit[0]({ preventDefault() {} });

  const root = await open('merchant-a', [item]);
  assert.match(text(root), /Période observée/);
  assert.match(text(root), /Action préparée par Growth/);
  const [plan] = forms(root);
  const named = (form, name) => inputs(form).find((n) => n.getAttribute('name') === name);
  const [action, metric, baseline, target, reviewDate] = ['action', 'metric', 'baseline', 'target', 'reviewDate'].map((n) => named(plan, n));
  assert.match(action.getAttribute('value'), /Casque noir/);
  action.value = 'Change the booking page CTA';
  metric.value = 'Bookings';
  baseline.valueAsNumber = 0;
  target.valueAsNumber = 5;
  reviewDate.value = '2026-12-01';
  submit(plan);
  assert.equal(entries.size, 1);
  const [, review] = forms(root);
  const [applied, observed, notes] = ['applied', 'observed', 'notes'].map((n) => named(review, n));
  applied.value = '2026-09-12';
  observed.valueAsNumber = 3;
  notes.value = 'Equal-length windows';
  all(review, (n) => n.tagName === 'SELECT')[0].value = 'comparable';
  submit(review);
  assert.match(text(root), /Variation observée 3/);

  const archived = await open('merchant-a', []);
  assert.match(text(archived), /Opportunités suivies précédemment/);
  assert.match(text(archived), /Change the booking page CTA/);
  assert.match(text(archived), /Variation observée 3/);
  const other = await open('merchant-b', []);
  assert.doesNotMatch(text(other), /Change the booking page CTA/);
});
