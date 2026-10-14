// Growth > Croissance magasin: store channel, KPIs, signals, guards, honest states, locations, tenant isolation, route, UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildStore, HIGHLIGHT_ALLOWED, FUTURE_SOURCES } from '../src/growth/store/store.js';
import { storeFacts } from '../src/growth/store/facts.js';
import { createStoreSource } from '../src/growth/server/store.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { makeStoreData, FULL, NOW, TZ, CONFIG } from './fixtures/store-sample.js';
import { growthDom, storePayload, all, text, hasClass, title, navState } from './growth-dom.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const run = (spec, potential = new Map(), opts) => buildStore({ ...storeFacts({ data: makeStoreData(spec, opts), now: NOW, timeZone: TZ, config: CONFIG }), potential, config: CONFIG });
const sig = (p, code) => p.signals.find((s) => s.code === code);
const act = (p, code) => p.actions.find((a) => a.code === code);

test('store case 1: pos and point_of_sale -> the same store behaviour (identical payload)', () => {
  const a = run({ ...FULL, store: { ...FULL.store, handle: 'pos' } });
  const b = run({ ...FULL, store: { ...FULL.store, handle: 'point_of_sale' } });
  assert.equal(a.mode, 'store');
  assert.equal(a.kpis.storeOrders.value, 48);
  assert.deepEqual(b, a);
});

test('store case 2: no identifiable store source -> honest empty state, no 0 shown as a known value', () => {
  const p = run({ online: { cur: 40, prev: 40 } });
  assert.equal(p.mode, 'noStore');
  assert.equal(p.kpis, undefined, 'no KPI at all: not "0 store sales"');
  assert.equal(p.footfall.connected, false);
  // Channel present in the history but no sale in the window: a real, known 0 (distinct from "channel absent").
  const quiet = run({ store: { prev: 40 }, online: { cur: 40, prev: 40 } });
  assert.equal(quiet.mode, 'store');
  assert.equal(quiet.kpis.storeOrders.value, 0);
  assert.equal(quiet.kpis.storeAov.value, null, 'no order: average order is not computable, not 0');
});

test('store case 3: store channel with sales -> KPIs computed exactly', () => {
  const p = run(FULL);
  assert.deepEqual(p.kpis.storeNet, { value: 1920, previous: 1620, change: 0.1852 });
  assert.deepEqual(p.kpis.storeOrders, { value: 48, previous: 36, change: 0.3333 });
  assert.deepEqual(p.kpis.storeAov, { value: 40, previous: 45, change: -0.1111 });
  assert.equal(p.kpis.storeShare.value, Math.round((1920 / (1920 + 2400)) * 10000) / 10000);
  assert.equal(p.weekly.length, 8);
  assert.equal(p.weekly.reduce((a, w) => a + w.storeOrders, 0), 48);
  assert.equal(p.weekdays.reduce((a, w) => a + w.orders, 0), 48);
  // No comparable previous window when the history does not cover it.
  const young = run({ store: { cur: 40 }, online: { cur: 40 }, history: false });
  assert.equal(young.window.previousComparable, false);
  assert.equal(young.kpis.storeNet.previous, null);
});

test('store case 4: more orders but a lower average order -> matching signal, facts only (no cause)', () => {
  const p = run(FULL);
  assert.deepEqual(sig(p, 'ordersUpAovDown'), { code: 'ordersUpAovDown', orders: 0.3333, aov: -0.1111 });
  assert.ok(act(p, 'checkAov'));
  const { futureSources, ...facts } = p; // futureSources only lists what a NOT connected source would unlock
  assert.ok(!JSON.stringify(facts).match(/because|parce que|visitor|visiteur|conversion/i));
  // Below the 30-order gate on one side: no signal at all.
  const small = run({ store: { cur: 48, prev: 20, price: 40, prevPrice: 45 }, online: { cur: 40, prev: 40 } });
  assert.equal(sig(small, 'ordersUpAovDown'), undefined);
});

test('store case 5: a strong store product with insufficient stock -> restock first, never a highlight', () => {
  const guards = new Map([['s-p1', { status: 'restock' }], ['s-p2', { status: 'lowMargin' }], ['s-p3', { status: 'returns' }]]);
  const p = run({ ...FULL, store: { ...FULL.store, productWeights: [0, 0, 0, 1, 2] } }, guards);
  assert.equal(p.topProducts[0].id, 's-p1');
  assert.equal(p.topProducts[0].highlightAllowed, false);
  assert.deepEqual(act(p, 'restockFirst'), { code: 'restockFirst', productId: 's-p1', title: 'Produit p1' });
  assert.equal(act(p, 'highlightProduct'), undefined, 'low margin and returns block the highlight too');
  // A product allowed by Produits Potentiels can be highlighted.
  const ok = run({ ...FULL, store: { ...FULL.store, productWeights: [0, 0, 0, 1, 2] } }, new Map([['s-p1', { status: 'topSeller' }]]));
  assert.equal(act(ok, 'highlightProduct').productId, 's-p1');
  assert.deepEqual(HIGHLIGHT_ALLOWED, ['push', 'topSeller', 'stable']);
  // No guard known (not analysed by Produits Potentiels): never highlighted.
  assert.equal(act(run(FULL), 'highlightProduct'), undefined);
});

test('store case 6: no footfall data -> no visitor, conversion or per-visitor figure anywhere', () => {
  const p = run(FULL);
  assert.equal(p.footfall.connected, false);
  const keys = JSON.stringify(p).match(/"(\w+)":/g).map((k) => k.slice(1, -2).toLowerCase());
  for (const k of keys) assert.ok(!/visitor|footfall(?!$)|traffic|conversion(?!s?$)/.test(k) || k === 'footfall', `unexpected field ${k}`);
  assert.ok(!('visitors' in p) && !('conversion' in p) && !('conversionRate' in p.kpis));
  assert.deepEqual(FUTURE_SOURCES.map((s) => s.code), ['footfall', 'googleBusiness', 'posEnriched']);
});

async function seedTwo() {
  const supabase = createFakeSupabase();
  const [A, B] = [randomUUID(), randomUUID()];
  for (const [m, tag, spec] of [[A, 'a', { store: { cur: 12, price: 30 } }], [B, 'b', { store: { cur: 50, price: 90 }, online: { cur: 10 } }]]) {
    const d = makeStoreData(spec, { merchantId: m, tag });
    for (const [t, rows] of [['products', d.products], ['variants', d.variants], ['locations', d.locations], ['orders', d.orders], ['order_lines', d.orderLines]]) await supabase.insert(t, rows);
  }
  return { supabase, A, B };
}
test('store case 7: two merchants -> strict isolation; merchant required and fixed at creation', async () => {
  const { supabase, A, B } = await seedTwo();
  const pa = await createStoreSource({ supabase, merchantId: A, now: () => NOW })();
  const pb = await createStoreSource({ supabase, merchantId: B, now: () => NOW })();
  assert.equal(pa.kpis.storeOrders.value, 12);
  assert.equal(pa.kpis.storeNet.value, 360);
  assert.equal(pb.kpis.storeOrders.value, 50);
  assert.deepEqual(pa.locations.map((l) => l.name), ['Magasin L1']);
  assert.ok(!JSON.stringify(pa).includes('b-'), 'no id of merchant B in A');
  assert.throws(() => createStoreSource({ supabase }), TypeError);
});

test('store case 8: several locations -> all stores aggregated with a breakdown; never the first one implicitly', () => {
  const data = makeStoreData({ ...FULL, locations: ['L1', 'L2'] });
  let i = 0;
  for (const o of data.orders) if (o.channel_handle === 'pos') { i += 1; o.location_id = i % 3 === 0 ? null : i % 3 === 1 ? 's-L1' : 's-L2'; }
  const p = buildStore({ ...storeFacts({ data, now: NOW, timeZone: TZ, config: CONFIG }), potential: new Map(), config: CONFIG });
  const cur = p.locations;
  assert.equal(cur.reduce((a, l) => a + l.orders, 0), p.kpis.storeOrders.value, 'KPIs add up every location');
  assert.deepEqual(cur.map((l) => l.known).sort(), [false, true, true]);
  assert.equal(p.kpis.locations.value, 2);
  assert.ok(p.kpis.locations.unknownLocationOrders > 0, 'orders without a location stay a separate, visible group');
  assert.equal(cur.find((l) => !l.known).name, null);
});

test('store: weekday rule (2 x an even share on 30+ orders) and product gap rule (2 x the online share) are strict', () => {
  const sat = run({ ...FULL, store: { cur: 48, prev: 36, price: 40, prevPrice: 45, weekday: 5 } });
  assert.deepEqual(sig(sat, 'strongWeekday'), { code: 'strongWeekday', day: 5, share: 1, even: 0.1429 });
  assert.deepEqual(act(sat, 'weekdayHighlight'), { code: 'weekdayHighlight', day: 5, share: 1 });
  assert.equal(sig(run(FULL), 'strongWeekday'), undefined, 'an even spread is no signal');
  assert.equal(sig(run(FULL), 'productGap'), undefined, '33 % vs 32.5 % is not a difference worth a signal');
  const gap = run({ ...FULL, store: { ...FULL.store, productWeights: [0, 0, 0, 0, 1] } });
  assert.equal(sig(gap, 'productGap').id, 's-p1');
  assert.ok(sig(gap, 'productGap').storeShare >= 2 * sig(gap, 'productGap').onlineShare);
});

async function serve(opts) {
  const server = http.createServer(createGrowthApp(opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
test('store route: no tenant -> 503 TENANT_NOT_CONFIGURED; request parameters never choose the merchant', async () => {
  const none = await serve({});
  try {
    const r = await fetch(`${none.base}/api/growth/store`);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: { code: 'TENANT_NOT_CONFIGURED' } });
    assert.equal((await fetch(`${none.base}/store.js`)).status, 200);
  } finally { await none.close(); }
  const { supabase, A, B } = await seedTwo();
  const calls = [];
  const source = createStoreSource({ supabase, merchantId: A, now: () => NOW });
  const app = await serve({ store: (...args) => { calls.push(args); return source(); } });
  try {
    for (const q of ['', `?merchantId=${B}`, `?merchant_id=${B}&tenant=${B}`]) {
      const d = await (await fetch(`${app.base}/api/growth/store${q}`, { headers: { 'x-merchant-id': B } })).json();
      assert.equal(d.kpis.storeOrders.value, 12, `query "${q}" is ignored`);
    }
    assert.ok(calls.every((a) => a.length === 0));
  } finally { await app.close(); }
});

test('store UI: every label exists in FR/NL/EN; no mockup figure, visitor or conversion wording in the code', async () => {
  const ctx = { window: {} };
  for (const l of ['fr', 'nl', 'en']) vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
  const D = ctx.window.NORDLA_DICTS;
  const src = await readFile(new URL('store.js', UI), 'utf8');
  const keys = [
    ...[...src.matchAll(/\bt\('(gr\.[\w.]+)'/g)].map((m) => m[1]),
    ...['sales', 'orders', 'channels'].map((m) => `gr.st.perf.${m}`),
    ...FUTURE_SOURCES.flatMap((s) => [`gr.st.future.${s.code}`, ...s.unlocks.map((u) => `gr.st.future.u.${u}`)]),
    'gr.st.title', 'gr.st.subtitle', 'gr.nav.storeGrowth',
  ];
  for (const k of keys) for (const l of ['fr', 'nl', 'en']) assert.ok(D[l][k], `missing ${l} key ${k}`);
  const st = (l) => Object.keys(D[l]).filter((k) => k.startsWith('gr.st.')).sort();
  assert.deepEqual(st('nl'), st('fr')); assert.deepEqual(st('en'), st('fr'));
  assert.equal(D.en['gr.st.title'], D.en['gr.nav.storeGrowth'], 'page title = menu label');
  for (const f of [new URL('store.js', UI), new URL('../src/growth/store/store.js', import.meta.url), new URL('../src/growth/store/facts.js', import.meta.url)]) {
    const code = await readFile(f, 'utf8');
    for (const v of ['214 380', '4 826', 'Bruxelles', 'Liège', 'HABB', 'Namur']) assert.ok(!code.includes(v), `${f.pathname}: "${v}"`);
  }
});

test('store UI: renders, nav entry active (desktop rail), footfall stated as not connected, no 7th mobile entry', async () => {
  const { root, errors } = await growthDom('#/storeGrowth');
  assert.deepEqual(errors, []);
  assert.equal(title(root), 'Croissance magasin');
  assert.deepEqual(navState(root).filter((n) => n.active).map((n) => [n.label, n.href]), [['Croissance magasin', '#/storeGrowth'], ['Plus', null]], 'Croissance magasin lives in the mobile "Plus" menu, which is active');
  assert.ok(text(root).includes('8 dernières semaines'));
  assert.ok(text(root).includes('Fréquentation non connectée'));
  assert.equal(all(root, (n) => hasClass(n, 'ex-kpi')).length, 5);
  assert.ok(text(root).includes('Source non connectée'));
  const storeNav = all(root, (n) => hasClass(n, 'nav-item') && text(n).includes('Croissance magasin'))[0];
  assert.ok(hasClass(storeNav, 'gr-desktop-only'), 'the mobile bar keeps its 6 entries');
  const mobile = all(root, (n) => hasClass(n, 'nav-item') && !hasClass(n, 'gr-desktop-only'));
  assert.equal(mobile.length, 6);
});

test('store UI: no store source and missing tenant are explicit states', async () => {
  const none = await growthDom('#/storeGrowth', { store: storePayload(makeStoreData({ online: { cur: 40, prev: 40 } })) });
  assert.deepEqual(none.errors, []);
  assert.ok(text(none.root).includes('Aucune vente magasin identifiable sur cette période.'));
  assert.equal(all(none.root, (n) => hasClass(n, 'ex-kpi')).length, 0, 'no KPI shown as 0');
  const t503 = await growthDom('#/storeGrowth', { storeStatus: 503 });
  assert.deepEqual(t503.errors, []);
  assert.equal(all(t503.root, (n) => hasClass(n, 'ex-kpi')).length, 0);
});

test('store UI: every icon used exists (official set or Growth pack) and none is a defective asset', async () => {
  const ctx = { window: {}, document: { createElement: () => ({ setAttribute() {} }) } };
  vm.runInNewContext(await readFile(new URL('../src/shared/nordla-icon.js', import.meta.url), 'utf8'), ctx);
  const NI = ctx.window.NordlaIcon;
  const app = await readFile(new URL('app.js', UI), 'utf8');
  const pack = new Set([...app.split('const GROWTH_PACK = {')[1].split('};')[0].matchAll(/(\w+): '/g)].map((m) => m[1]));
  const icons = new Set([...app.split('const GROWTH_ICONS = {')[1].split('};')[0].matchAll(/(\w+): '/g)].map((m) => m[1]));
  const src = await readFile(new URL('store.js', UI), 'utf8');
  const names = [...new Set([...src.matchAll(/(?:gi|cardHead|kpi|semantic|icoBubble)\('([\w:]+)'/g), ...src.matchAll(/: '((?:pack:)?[a-z]\w*)'[,\s}]/g)].map((m) => m[1]))]
    .filter((n) => n.startsWith('pack:') || icons.has(n) || NI.has(n) || NI.DEFECTIVE[n]);
  assert.ok(names.length >= 8);
  for (const n of names) {
    if (n.startsWith('pack:')) assert.ok(pack.has(n.slice(5)), n);
    else if (!icons.has(n)) { assert.ok(!NI.DEFECTIVE[n], `defective ${n}`); assert.ok(NI.has(n), `unknown ${n}`); }
  }
});

// ---------- v1 rule: product over-represented in store needs a real sample (owner 2026-09-28) ----------
/** FULL data where `storeOrders` store orders (and `onlineOrders` online orders) sell an extra product "px" instead. */
function withExtraProduct(storeOrders, onlineOrders = 0) {
  const data = makeStoreData(FULL);
  data.products.push({ id: 's-px', title: 'Produit px', product_type: 'Cat X', source_status: 'ACTIVE', image_url: null, image_alt_text: null, source_id: 'gid-s-px' });
  data.variants.push({ id: 's-px-v', product_id: 's-px', sku: 'PX', title: 'Default', source_id: 'gid-s-px-v' });
  const inWindow = (o) => new Date(o.ordered_at) >= new Date('2026-07-27T00:00:00Z');
  const store = data.orders.filter((o) => o.channel_handle === 'pos' && inWindow(o)).slice(0, storeOrders).map((o) => o.id);
  const online = data.orders.filter((o) => o.channel_handle === 'online_store' && inWindow(o)).slice(0, onlineOrders).map((o) => o.id);
  for (const l of data.orderLines) if (store.includes(l.order_id) || online.includes(l.order_id)) l.variant_id = 's-px-v';
  return buildStore({ ...storeFacts({ data, now: NOW, timeZone: TZ, config: CONFIG }), potential: new Map(), config: CONFIG });
}
test('store v1 product rule: ratio >= 2x but an insignificant sample (fewer than 3 separate store orders) -> no signal', () => {
  for (const n of [1, 2]) {
    const p = withExtraProduct(n);
    assert.equal(sig(p, 'productGap'), undefined, `${n} store order(s), no online sale: never over-represented`);
    assert.ok(!p.differences.products.some((g) => g.id === 's-px'));
  }
  assert.equal(CONFIG.customers.basket.minPairSupport, 3, 'the reused existing observation minimum');
});
test('store v1 product rule: ratio >= 2x with a sufficient sample -> signal', () => {
  const p = withExtraProduct(5);
  const s = sig(p, 'productGap');
  assert.equal(s.id, 's-px');
  assert.equal(s.onlineShare, 0);
  assert.ok(s.storeShare > 0);
  assert.equal(p.differences.products[0].storeOrders, 5);
});
test('store v1 product rule: ratio below 2x with a sufficient sample -> no signal', () => {
  const p = withExtraProduct(5, 3); // store 200 / 1920 = 10.4 %, online 180 / 2400 = 7.5 % -> ratio 1.4
  assert.equal(sig(p, 'productGap'), undefined);
  assert.ok(!p.differences.products.some((g) => g.id === 's-px'));
});
test('store v1 rules are documented as configurable-later Growth v1 rules and exposed in the payload', async () => {
  const p = run(FULL);
  assert.deepEqual(p.thresholds, { minOrders: 30, weekdayStrongShare: 0.2857, storeOverOnlineRatio: 2, productMinStoreOrders: 3, rulesVersion: 'v1' });
  const src = await readFile(new URL('../src/growth/store/store.js', import.meta.url), 'utf8');
  assert.match(src, /GROWTH V1 RULES/);
  assert.match(src, /to become configurable later - not universal truths/);
});
