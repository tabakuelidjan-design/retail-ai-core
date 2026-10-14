// Growth > Audience: segment rules, business cases, honest states, privacy, tenant isolation, route, UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildAudience, segmentOf, SEGMENTS, STATUSES, SEGMENT_ACTION } from '../src/growth/audience/audience.js';
import { audienceFacts, audienceWindow, WINDOW_DAYS } from '../src/growth/audience/facts.js';
import { createAudienceSource } from '../src/growth/server/audience.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { makeAudienceData, FULL, NOW, TZ, CONFIG } from './fixtures/audience-sample.js';
import { growthDom, audiencePayload, all, text, hasClass, title, navState } from './growth-dom.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const run = (groups, opts) => {
  const f = audienceFacts({ data: makeAudienceData(groups, opts), now: NOW, timeZone: TZ, config: CONFIG });
  return buildAudience({ orders: f.orders, window: f.window, historyStart: f.historyStart, config: CONFIG, currency: f.currency });
};
const seg = (p, key) => p.segments.find((s) => s.key === key);

// ---------- segment rules ----------
test('audience rules: every customer falls in exactly one segment, by explicit rules', () => {
  const c = (o) => ({ knownOrders: 1, lifetimeLowerBound: 1, windowOrders: 0, windowNet: 0, historyNet: 0, provenNewInWindow: false, recencyDays: 0, ...o });
  assert.equal(segmentOf(c({ lifetimeLowerBound: 2, windowOrders: 0 })), 'reactivate');
  assert.equal(segmentOf(c({ lifetimeLowerBound: 3, windowOrders: 1 })), 'loyal');
  assert.equal(segmentOf(c({ lifetimeLowerBound: 2, windowOrders: 2, provenNewInWindow: true })), 'newReturned');
  assert.equal(segmentOf(c({ windowOrders: 1, provenNewInWindow: true })), 'new');
  assert.equal(segmentOf(c({ lifetimeLowerBound: 2, windowOrders: 1 })), 'returning');
  assert.equal(segmentOf(c({ windowOrders: 0 })), 'occasional');
  assert.equal(segmentOf(c({ windowOrders: 1 })), 'unknown', 'a single recent order without a proven index is not called "new"');
  const p = run(FULL);
  assert.deepEqual(Object.fromEntries(p.segments.map((s) => [s.key, s.customers])), { loyal: 60, returning: 45, newReturned: 32, new: 90, reactivate: 70, occasional: 80, unknown: 20 });
  assert.equal(p.segments.reduce((a, s) => a + s.customers, 0), p.identifiedCustomers, 'a partition: no customer counted twice');
  assert.equal(WINDOW_DAYS, CONFIG.customers.shortHistoryDays, 'the window is the customers engine rule (90 days)');
  for (const s of p.segments) { assert.ok(STATUSES.includes(s.status)); assert.equal(s.action, s.status === 'insufficient' ? 'none' : SEGMENT_ACTION[s.key]); }
});

// ---------- mandatory business cases ----------
test('audience case 1: many repeat buyers with a large share of sales -> explicit signal, facts only, no prediction', () => {
  const p = run({ ...FULL, loyal: 120 });
  const s = p.signals.find((x) => x.code === 'repeatRevenueShare');
  assert.ok(s, 'signal present');
  assert.ok(s.revenueShare > s.customerShare);
  assert.equal(seg(p, 'loyal').status, 'priority');
  assert.equal(seg(p, 'loyal').rule, 'REVENUE_SHARE_ABOVE_CUSTOMER_SHARE');
  const json = JSON.stringify(p);
  for (const w of ['uplift', 'forecast', 'predicted', 'potential', 'expected']) assert.ok(!json.toLowerCase().includes(w), `no "${w}" in the payload`);
});

test('audience case 2: a large group of repeat buyers inactive for 90+ days -> segment "À réactiver"', () => {
  const p = run(FULL);
  const r = seg(p, 'reactivate');
  assert.equal(r.customers, 70);
  assert.equal(r.status, 'activate');
  assert.equal(r.action, 'reactivation');
  assert.equal(r.windowNet, 0);
  assert.equal(r.revenueShare, null, 'no share of the window sales for a group that did not buy in it');
  assert.equal(p.kpis.toReactivate.value, 70);
  assert.equal(p.actions[0].code, 'reactivation');
  assert.deepEqual(r.opportunity, { kind: 'audienceReactivate', segment: 'reactivate' });
});

test('audience case 3: new customers without enough history are never called "prometteurs"', () => {
  const p = run({ ...FULL, newReturned: 0 });
  assert.equal(seg(p, 'newReturned').customers, 0);
  assert.equal(seg(p, 'new').customers, 90);
  // Only recent orders (no history before the window): new customers stay "new"; inactivity segments cannot be observed.
  const young = run({ new: 60, newReturned: 0, unknown: 5 });
  assert.equal(seg(young, 'new').customers, 60);
  assert.equal(seg(young, 'newReturned').customers, 0);
  assert.equal(young.kpis.toReactivate.value, null, 'short history: unknown, not 0');
  assert.ok(seg(young, 'reactivate').reasons.includes('SHORT_HISTORY'));
  // A single recent order whose index is not trusted is not "new" either.
  assert.equal(seg(run({ ...FULL }), 'unknown').status, 'insufficient');
});

test('audience case 4: a very valuable but very small segment is not made priority', () => {
  const p = run({ ...FULL, loyal: 5 }, { prices: { loyal: 2000 } });
  const l = seg(p, 'loyal');
  assert.ok(l.revenueShare > l.activeShare, 'it does over-contribute...');
  assert.equal(l.status, 'insufficient', '...but 5 customers is below the 30-customer group rule');
  assert.ok(l.reasons.includes('SEGMENT_BELOW_MIN_GROUP'));
  assert.notEqual(p.segments[0].key, 'loyal');
  assert.ok(!p.actions.some((a) => a.segment === 'loyal'));
});

test('audience case 5: insufficient customer data -> honest state, no strong recommendation', () => {
  const p = run({ loyal: 5, returning: 4, new: 6, reactivate: 3, occasional: 4 });
  assert.equal(p.mode, 'customer');
  assert.equal(p.sampleOpen, false);
  assert.ok(p.segments.every((s) => s.status === 'insufficient' && s.action === 'none'));
  assert.equal(p.kpis.repeatRate.value, null, 'below 30 active customers the repeat rate is not computed (null, never 0)');
  assert.ok(!p.signals.some((s) => ['repeatRevenueShare', 'reactivation', 'repeatRateChange', 'aovGap'].includes(s.code)));
  assert.deepEqual(p.actions.map((a) => a.code), ['growSample']);
});

// ---------- states ----------
test('audience state: no pseudonymous customer key -> aggregate mode, no segment of people, order-level KPIs', () => {
  const p = run({ anonymous: 25 });
  assert.equal(p.mode, 'aggregate');
  assert.deepEqual(p.segments, []);
  assert.equal(p.identifiedCustomers, 0);
  assert.deepEqual(Object.keys(p.kpis), ['orders', 'netSales', 'aov', 'returningOrderShare', 'multiProductShare']);
  assert.equal(p.kpis.orders.value, 25);
  assert.equal(p.kpis.returningOrderShare.value, null, 'no trusted index: unknown, not 0');
  assert.deepEqual(p.signals.map((s) => s.code), ['customerLevelMissing'], 'below 30 orders no order-level conclusion either');
  assert.deepEqual(p.actions.map((a) => a.code), ['enableCustomerKey']);
  assert.equal(p.coverage.identifiedOrderShare, 0);
  // Enough orders: basket facts open (same 30-order gate as the customers engine).
  assert.ok(run({ anonymous: 40 }).signals.some((s) => s.code === 'multiProduct'));
});

test('audience state: no repeat customer, no new customer, one significant segment only', () => {
  const noRepeat = run({ new: 50, occasional: 40 });
  assert.equal(noRepeat.kpis.repeatRate.value, 0, 'a real, sample-backed zero');
  assert.ok(!noRepeat.signals.some((s) => s.code === 'repeatRevenueShare'));
  assert.equal(seg(noRepeat, 'loyal').customers, 0);
  const noNew = run({ loyal: 40, returning: 35, reactivate: 30 });
  assert.equal(noNew.kpis.newCustomers.value, 0);
  assert.equal(seg(noNew, 'new').customers, 0);
  const one = run({ new: 45, occasional: 3 });
  assert.deepEqual(one.segments.filter((s) => s.status !== 'insufficient').map((s) => s.key), ['new']);
});

test('audience state: empty dataset -> explicit empty mode', () => {
  const p = run({});
  assert.equal(p.mode, 'empty');
  assert.deepEqual(p.segments, []);
  assert.equal(p.kpis, null);
});

test('audience state: equal periods -> no "À surveiller" from evolution, deltas are real zeros', () => {
  // Hand-built orders: 35 proven-new customers in the current window and 35 in the previous one, history long enough.
  const w = audienceWindow(NOW, TZ);
  const orders = [];
  const mk = (key, at, idx) => ({ at, net: 50, multiProduct: false, group: idx === 1 ? 'new' : 'returning', key, idx });
  for (let i = 0; i < 35; i += 1) {
    orders.push(mk(`a${i}`, new Date(w.start.getTime() + 5 * 86400000), 1));
    orders.push(mk(`b${i}`, new Date(w.prevStart.getTime() + 5 * 86400000), 1));
  }
  orders.push(mk('old', new Date(w.prevStart.getTime() - 10 * 86400000), 1));
  orders.sort((a, b) => a.at - b.at);
  const p = buildAudience({ orders, window: w, historyStart: orders[0].at, config: CONFIG, currency: 'EUR' });
  const n = seg(p, 'new');
  assert.equal(n.customers, 35);
  assert.equal(n.previousCustomers, 35);
  assert.equal(n.status, 'develop');
  assert.equal(p.kpis.newCustomers.previous, 35);
  assert.equal(p.kpis.aov.value, p.kpis.aov.previous);
});

test('audience: deterministic and private - same result whatever the input order, no customer key or label in the output', () => {
  const data = makeAudienceData(FULL);
  const a = run(FULL);
  const shuffled = { ...data, orders: data.orders.slice().reverse(), orderLines: data.orderLines.slice().reverse() };
  const f = audienceFacts({ data: shuffled, now: NOW, timeZone: TZ, config: CONFIG });
  const b = buildAudience({ orders: f.orders, window: f.window, historyStart: f.historyStart, config: CONFIG, currency: f.currency });
  assert.deepEqual(b, a);
  const json = JSON.stringify(a);
  assert.ok(!json.includes('cust-'), 'no customer key');
  // Segment ids are the only "key" fields; no customer-level field of any kind.
  assert.deepEqual([...json.matchAll(/"key":"(\w+)"/g)].map((m) => m[1]).sort(), [...SEGMENTS].sort());
  for (const k of ['"label"', 'email', 'phone', 'address', 'customer_key', 'customerKey']) assert.ok(!json.includes(k), `no ${k}`);
});

// ---------- tenant ----------
async function seedTwo() {
  const supabase = createFakeSupabase();
  const [A, B] = [randomUUID(), randomUUID()];
  for (const [m, tag, groups] of [[A, 'alpha', { new: 3 }], [B, 'beta', { loyal: 40, reactivate: 35 }]]) {
    const d = makeAudienceData(groups, { merchantId: m, tag });
    await supabase.insert('products', d.products); await supabase.insert('variants', d.variants);
    await supabase.insert('orders', d.orders); await supabase.insert('order_lines', d.orderLines);
  }
  return { supabase, A, B };
}
test('audience tenant: each source reads only its merchant; merchant required and fixed at creation', async () => {
  const { supabase, A, B } = await seedTwo();
  const pa = await createAudienceSource({ supabase, merchantId: A, now: () => NOW })();
  const pb = await createAudienceSource({ supabase, merchantId: B, now: () => NOW })();
  assert.equal(pa.identifiedCustomers, 3);
  assert.equal(pb.identifiedCustomers, 75);
  assert.equal(seg(pa, 'reactivate').customers, 0, 'none of B\'s inactive buyers in A');
  assert.throws(() => createAudienceSource({ supabase }), TypeError);
});

async function serve(opts) {
  const server = http.createServer(createGrowthApp(opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
test('audience route: no tenant -> 503 TENANT_NOT_CONFIGURED; request parameters never choose the merchant', async () => {
  const none = await serve({});
  try {
    const r = await fetch(`${none.base}/api/growth/audience`);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: { code: 'TENANT_NOT_CONFIGURED' } });
    assert.equal((await fetch(`${none.base}/audience.js`)).status, 200);
  } finally { await none.close(); }
  const { supabase, A, B } = await seedTwo();
  const calls = [];
  const source = createAudienceSource({ supabase, merchantId: A, now: () => NOW });
  const app = await serve({ audience: (...args) => { calls.push(args); return source(); } });
  try {
    for (const q of ['', `?merchantId=${B}`, `?merchant_id=${B}&tenant=${B}`]) {
      const d = await (await fetch(`${app.base}/api/growth/audience${q}`, { headers: { 'x-merchant-id': B } })).json();
      assert.equal(d.identifiedCustomers, 3, `query "${q}" is ignored`);
    }
    assert.ok(calls.every((a) => a.length === 0));
  } finally { await app.close(); }
});

// ---------- UI ----------
test('audience UI: every label exists in FR/NL/EN; no mockup figure or hard-coded copy', async () => {
  const ctx = { window: {} };
  for (const l of ['fr', 'nl', 'en']) vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
  const D = ctx.window.NORDLA_DICTS;
  const src = await readFile(new URL('audience.js', UI), 'utf8');
  const RULES = ['INSUFFICIENT', 'REPEAT_BUYERS_WITHOUT_RECENT_ORDER', 'REVENUE_SHARE_ABOVE_CUSTOMER_SHARE', 'SMALLER_THAN_PREVIOUS_WINDOW', 'ONE_ORDER_NOT_REPEATED', 'ACTIVE_SEGMENT'];
  const ACTIONS = ['reactivation', 'loyalty', 'secondPurchase', 'targetedOffer', 'none'];
  const keys = [
    ...[...src.matchAll(/\bt\('(gr\.[\w.]+)'/g)].map((m) => m[1]),
    ...SEGMENTS.flatMap((s) => [`gr.au.seg.${s}`, `gr.au.segDef.${s}`, `gr.au.segRule.${s}`]),
    ...STATUSES.map((s) => `gr.au.status.${s}`), ...RULES.map((r) => `gr.au.rule.${r}`),
    ...ACTIONS.flatMap((a) => [`gr.au.action.${a}`, `gr.au.actionText.${a}`]),
    ...['reactivation', 'loyalty', 'secondPurchase', 'targetedOffer', 'growSample', 'enableCustomerKey'].flatMap((a) => [`gr.au.actTitle.${a}`, `gr.au.actBenefit.${a}`]),
    ...['SAMPLE_BELOW_MIN_CUSTOMERS', 'SEGMENT_BELOW_MIN_GROUP', 'SHORT_HISTORY', 'FIRST_ORDER_NOT_PROVEN'].map((r) => `gr.au.reason.${r}`),
    ...['new', 'returning', 'first_recorded_pos', 'unknown'].map((g) => `gr.au.orderGroup.${g}`),
    ...['segment', 'customers', 'frequency', 'revenue', 'aov', 'recency', 'statusAction'].map((c) => `gr.au.col.${c}`),
    'gr.au.title', 'gr.au.subtitle', 'gr.nav.audience', 'gr.period.lastDays', 'gr.period.daysNote',
  ];
  for (const k of keys) for (const l of ['fr', 'nl', 'en']) assert.ok(D[l][k], `missing ${l} key ${k}`);
  const au = (l) => Object.keys(D[l]).filter((k) => k.startsWith('gr.au.')).sort();
  assert.deepEqual(au('nl'), au('fr')); assert.deepEqual(au('en'), au('fr'));
  for (const f of [new URL('audience.js', UI), new URL('../src/growth/audience/audience.js', import.meta.url), new URL('../src/growth/audience/facts.js', import.meta.url)]) {
    const code = await readFile(f, 'utf8');
    for (const v of ['4 820', '1 230', "'640'", ' 640 ', '12 400', 'VIP', 'HABB', 'Namur', 'Clients fidèles', 'Prioritaire']) assert.ok(!code.includes(v), `${f.pathname}: hard-coded "${v}"`);
  }
});

test('audience UI: renders the customer mode, nav entry active, rows open the detail panel', async () => {
  const { root, errors } = await growthDom('#/audience');
  assert.deepEqual(errors, []);
  assert.equal(title(root), 'Audience');
  assert.deepEqual(navState(root).filter((n) => n.active).map((n) => [n.label, n.href]), [['Audience', '#/audience']]);
  assert.ok(text(root).includes('90 derniers jours'));
  assert.equal(all(root, (n) => hasClass(n, 'ex-kpi')).length, 5);
  const rows = all(root, (n) => hasClass(n, 'gr-au-row'));
  assert.equal(rows.length, 7);
  assert.ok(text(root).includes('Clients à réactiver'));
  assert.ok(text(root).includes('Préparer une campagne de réactivation'));
  // No action button that performs no action (owner rule 2026-09-28): the former disabled "+ Nouveau segment" is gone.
  assert.equal(all(root, (n) => n.tagName === 'BUTTON' && /Nouveau segment/.test(text(n))).length, 0);
  assert.equal(all(root, (n) => n.tagName === 'BUTTON' && n.getAttribute('disabled') != null).length, 0);
  rows.find((r) => text(r).includes('Clients à réactiver')).listeners.click[0]();
  const drawer = all(root, (n) => hasClass(n, 'gr-pp-drawer'))[0];
  for (const s of ['Définition', 'Taille et valeur', 'Pourquoi Nordla le signale', 'Action suggérée']) assert.ok(text(drawer).includes(s), s);
  all(root, (n) => hasClass(n, 'gr-pp-close'))[0].listeners.click[0]();
  assert.equal(all(root, (n) => hasClass(n, 'gr-pp-drawer')).length, 0);
  assert.deepEqual(errors, []);
});

test('audience UI: no customer key, empty data and missing tenant are explicit states', async () => {
  const agg = await growthDom('#/audience', { audience: audiencePayload(makeAudienceData({ anonymous: 25 })) });
  assert.deepEqual(agg.errors, []);
  assert.ok(text(agg.root).includes('Niveau client indisponible'));
  assert.ok(text(agg.root).includes('Activer l’identification client pseudonymisée'));
  assert.equal(all(agg.root, (n) => hasClass(n, 'gr-au-row')).length, 0, 'no segment of people');
  assert.equal(all(agg.root, (n) => hasClass(n, 'ex-kpi')).length, 5);
  const empty = await growthDom('#/audience', { audience: audiencePayload(makeAudienceData({})) });
  assert.deepEqual(empty.errors, []);
  assert.equal(all(empty.root, (n) => hasClass(n, 'ex-kpi')).length, 0);
  const none = await growthDom('#/audience', { audienceStatus: 503 });
  assert.deepEqual(none.errors, []);
  assert.equal(title(none.root), 'Audience');
  assert.equal(all(none.root, (n) => hasClass(n, 'ex-kpi')).length, 0);
});

test('audience UI: every icon used exists in the official set or the Growth pack, none is a defective asset', async () => {
  const ctx = { window: {}, document: { createElement: () => ({ setAttribute() {} }) } };
  vm.runInNewContext(await readFile(new URL('../src/shared/nordla-icon.js', import.meta.url), 'utf8'), ctx);
  const NI = ctx.window.NordlaIcon ?? ctx.NordlaIcon;
  const app = await readFile(new URL('app.js', UI), 'utf8');
  const pack = new Set([...app.split('const GROWTH_PACK = {')[1].split('};')[0].matchAll(/(\w+): '/g)].map((m) => m[1]));
  const src = await readFile(new URL('audience.js', UI), 'utf8');
  const names = new Set([...src.matchAll(/(?:gi|cardHead|kpi|icoBubble)\('([\w:]+)'/g), ...src.matchAll(/: '((?:pack:)?[a-z][\w]*)'[,\s}]/g)].map((m) => m[1])
    .filter((n) => n.startsWith('pack:') || NI.has(n) || NI.DEFECTIVE[n]));
  assert.ok(names.size >= 10, 'icon names were found');
  for (const n of names) {
    if (n.startsWith('pack:')) assert.ok(pack.has(n.slice(5)), `unknown Growth pack icon ${n}`);
    else { assert.ok(!NI.DEFECTIVE[n], `defective official icon ${n}`); assert.ok(NI.has(n), `unknown official icon ${n}`); }
  }
});

test('audience v1 rules: 90-day inactivity and 30-customer minimum are documented v1 values, exposed in the payload', async () => {
  const { AUDIENCE_RULES_V1 } = await import('../src/growth/audience/audience.js');
  assert.deepEqual(AUDIENCE_RULES_V1, { version: 'v1', inactivityDays: 90, minCustomers: 30, configurable: false });
  assert.equal(AUDIENCE_RULES_V1.minCustomers, CONFIG.customers.minCustomers);
  assert.equal(AUDIENCE_RULES_V1.inactivityDays, CONFIG.customers.shortHistoryDays);
  assert.deepEqual(run(FULL).thresholds.rules, AUDIENCE_RULES_V1);
  const src = await readFile(new URL('../src/growth/audience/audience.js', import.meta.url), 'utf8');
  assert.match(src, /GROWTH V1 RULES/);
  assert.match(src, /NOT universal truths/);
});
