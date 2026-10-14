// Développement des ventes - server, shell and Vue d'ensemble (owner decisions 2026-09-28): real data or honest states only, no
// demonstration data, no Campagnes, no action button that performs no action. Synthetic engine payloads only (never HABB's database).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createGrowthApp } from '../src/growth/server/app.js';
import { buildOverview } from '../src/growth/server/overview.js';
import { CHECKS as CONTENT_CHECKS } from '../src/growth/content/content.js';
import { STATUSES as POTENTIAL_STATUSES } from '../src/growth/products/potential.js';
import { SEGMENTS } from '../src/growth/audience/audience.js';
import { potentialPayload, audiencePayload, contentPayload, storePayload, prioritiesPayload, overviewPayload, growthDom, all, text, hasClass, NOW } from './growth-dom.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const SHARED = new URL('../src/shared/', import.meta.url);
const sources = () => ({ productPotential: async () => potentialPayload(), audience: async () => audiencePayload(), content: async () => contentPayload(), store: async () => storePayload() });

async function withServer(opts, fn) {
  const server = http.createServer(createGrowthApp(opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('growth server: serves the page, its assets and the shared design system; Campagnes has no script and no endpoint', async () => {
  await withServer({ now: () => NOW }, async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-module="growth"/);
    assert.doesNotMatch(html, /campaigns\.js/, 'the page loads no Campagnes script');
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    for (const p of ['/app.js', '/opportunities.js', '/growth-assets/icons/opportunities.png', '/growth.css', '/lang-fr.js', '/lang-nl.js', '/lang-en.js', '/style.css', '/nordla-tokens.css', '/i18n.js', '/nordla-icon.js', '/nordla-charts.js', '/nordla-charts.css', '/nordla-fonts.css', '/nordla-assets/official-icons/01_navigation_modules_growth.png']) {
      const r = await fetch(base + p); assert.equal(r.status, 200, p); await r.arrayBuffer();
    }
    for (const p of ['/campaigns.js', '/api/growth/campaigns']) assert.equal((await fetch(base + p)).status, 404, `${p} no longer exists`);
    // Reused Analytics stylesheet is served byte-identical (a reuse, not a fork).
    assert.equal(await (await fetch(`${base}/style.css`)).text(), await readFile(new URL('../src/analytics-premium/ui/style.css', import.meta.url), 'utf8'));
    // No tenant configured: Vue d'ensemble states it, Opportunités refuses with the known safe code.
    const d = await (await fetch(`${base}/api/growth/overview`)).json();
    assert.equal(d.demo, undefined, 'no demonstration flag: nothing on this page is demonstration data');
    assert.deepEqual([d.kpis.fix, d.kpis.commercial, d.kpis.watch, d.attention, d.opportunities], [null, null, null, null, null]);
    assert.deepEqual(d.real.store, { mode: 'unavailable' });
    const op = await fetch(`${base}/api/growth/opportunities`);
    assert.equal(op.status, 503);
    assert.deepEqual(await op.json(), { error: { code: 'TENANT_NOT_CONFIGURED' } });
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/growth/overview`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/nordla-assets/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/growth-assets/channels/..%2F..%2Fserver%2Fapp.js`)).status, 404);
  });
});

test('growth server: with the engines configured, Vue d\'ensemble and Opportunités are recomputed from them (same figures on both)', async () => {
  await withServer({ now: () => NOW, ...sources() }, async (base) => {
    const op = await (await fetch(`${base}/api/growth/opportunities`)).json();
    const ov = await (await fetch(`${base}/api/growth/overview`)).json();
    assert.equal(op.connected, undefined, 'no hard-coded { connected: false } any more');
    assert.deepEqual(op.sources, { products: 'ok', audience: 'ok', store: 'ok', content: 'ok' });
    assert.deepEqual(ov.kpis.fix, { value: op.counts.fix, corrections: op.counts.fixCorrections });
    assert.equal(ov.kpis.commercial.value, op.counts.commercial);
    assert.equal(ov.kpis.watch.value, op.counts.watch);
    assert.deepEqual(ov.attention.map((g) => g.id), op.sections.fix.slice(0, 3).map((g) => g.id));
    assert.deepEqual(ov.opportunities.map((i) => i.id), op.sections.commercial.slice(0, 3).map((i) => i.id));
    assert.equal(ov.real.store.mode, 'store');
  });
});

test('growth server: a failing engine is reported as unavailable, the others still count; nothing is written', async () => {
  const calls = [];
  const s = sources();
  const opts = { now: () => NOW, ...s, audience: async () => { calls.push('audience'); throw new Error('db down: token=secret'); } };
  await withServer(opts, async (base) => {
    const op = await (await fetch(`${base}/api/growth/opportunities`)).json();
    assert.equal(op.sources.audience, 'unavailable');
    assert.equal(op.sources.products, 'ok');
    assert.ok(!JSON.stringify(op).includes('secret'), 'no internal error detail in the payload');
    assert.ok(op.sections.fix.length > 0);
  });
  assert.deepEqual(calls, ['audience']);
});

test('growth UI: no data value lives in the UI - every figure, name and text comes from the payload or the dictionaries', async () => {
  const src = await readFile(new URL('app.js', UI), 'utf8') + await readFile(new URL('opportunities.js', UI), 'utf8');
  for (const v of ['HABB', 'Namur', 'Écouteurs', 'Spike', 'Baskets', '126', "currency: 'EUR'"]) assert.ok(!src.includes(v), `hard-coded value in the UI: ${v}`);
  assert.ok(!/GROWTH_(FINANCE|ANALYTICS)_URL|modules\[/.test(src), 'no inter-service routing in the UI');
  assert.ok(!/isDemo|gr\.demo|demoTitle/.test(src), 'no demonstration badge logic left');
  assert.ok(!/CHANNEL_LOGOS|campaignsCard|channelCard|renderCampaigns|roasFmt/.test(src), 'no Campagnes / channel code left');
});

test('growth UI: sidebar is Growth\'s own navigation (6 built pages + disabled entries Nordla AI, Paramètres), no Campagnes, no other module', async () => {
  const src = await readFile(new URL('app.js', UI), 'utf8');
  const keys = (block) => [...src.split(`const ${block} = [`)[1].split('];')[0].matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys('GROWTH_NAV'), ['overview', 'opportunities', 'potential', 'content', 'storeGrowth', 'audience']);
  assert.deepEqual(keys('GROWTH_NAV_FOOT'), ['ai', 'settings']);
  assert.ok(!/gr\.nav\.(finance|analytics|buying|afterSales|compliance|campaigns)|tresorerie|buyingSuppliers/.test(src), 'no other Nordla module in the Growth navigation');
});

test('Vue d\'ensemble payload: real sources only - store sales from Croissance magasin, priorities from Opportunités; nothing without a source', () => {
  const store = storePayload(); const priorities = prioritiesPayload();
  const d = buildOverview({ now: NOW, store, priorities });
  assert.deepEqual(d.sources, { store: 'real', priorities: 'real' });
  // Removed for this beta (owner rule 2026-09-28): no attribution, pulse, AI insights or social content source exists.
  assert.deepEqual(Object.keys(d.kpis), ['fix', 'commercial', 'watch']);
  assert.deepEqual(Object.keys(d).sort(), ['attention', 'currency', 'generatedAt', 'kpis', 'opportunities', 'real', 'sources', 'waiting']);
  assert.equal(JSON.stringify(d).includes('notConnected'), false, 'no "not connected" source left');
  assert.equal(d.real.store.net, store.kpis.storeNet.value);
  assert.equal(d.real.store.orders, store.kpis.storeOrders.value);
  assert.equal(d.kpis.fix.value, priorities.counts.fix);
  assert.equal(d.kpis.commercial.value, priorities.counts.commercial);
  assert.equal(d.attention.length, Math.min(3, priorities.sections.fix.length));
  for (const k of ['campaigns', 'channels', 'roas', 'activeCampaigns', 'experiments', 'demo']) assert.equal(JSON.stringify(d).includes(`"${k}"`), false, `no ${k} field`);
  // Unavailable sources stay unavailable (null), never 0.
  const empty = buildOverview({ now: NOW });
  assert.deepEqual([empty.kpis.fix, empty.kpis.commercial, empty.kpis.watch, empty.attention, empty.opportunities], [null, null, null, null, null]);
  assert.deepEqual(empty.real.store, { mode: 'unavailable' });
});

test('Vue d\'ensemble UI: every KPI and card has a real source (no "Source non connectée" card), links to Opportunités, no demo, no action button', async () => {
  const { root, errors } = await growthDom('#/');
  assert.deepEqual(errors, []);
  const body = text(root);
  assert.ok(!/Démo|Données de démonstration|ROAS|Campagnes/.test(body), 'no demonstration badge, no campaign figure');
  assert.ok(body.includes('Nordla vérifie la qualité de vos fiches produit et de vos données'), 'the honest promise is shown');
  assert.ok(!/croissance mesurable|mesurables/i.test(body), 'no promise of measurable growth');
  assert.equal(all(root, (n) => hasClass(n, 'ex-kpi')).length, 3);
  // Only the cards with a real source: priorities (attention, commercial opportunities) and Croissance magasin's store sales.
  assert.deepEqual(all(root, (n) => hasClass(n, 'ex-card')).map((c) => ['gr-att', 'gr-opps', 'gr-store'].find((k) => hasClass(c, k)) || 'other'), ['gr-att', 'gr-opps', 'gr-store']);
  for (const cls of ['gr-pulse', 'gr-ai', 'gr-content']) assert.equal(all(root, (n) => hasClass(n, 'ex-card') && hasClass(n, cls)).length, 0, `${cls} card removed`);
  assert.ok(!/Source non connectée|Non connecté|CA influencé|Pouls des ventes|Analyses Nordla AI|Performance du contenu|Trafic magasin|Taux de conversion/.test(body), 'no unconnected indicator');
  const links = all(root, (n) => n.tagName === 'A' && hasClass(n, 'gr-op-link'));
  assert.ok(links.length >= 2 && links.every((a) => a.getAttribute('href') === '#/opportunities'));
  assert.equal(all(root, (n) => n.tagName === 'BUTTON' && n.getAttribute('disabled') != null).length, 0);
  assert.equal(all(root, (n) => hasClass(n, 'gr-demo')).length, 0);
  assert.ok(body.includes('Données réelles'));
});

test('« À corriger maintenant » total: counted as corrections (one product may need several), in FR / NL / EN, on both pages', async () => {
  const p = prioritiesPayload();
  const total = p.sections.fix.reduce((a, g) => a + g.evidence.count, 0);
  const want = {
    fr: [`${total} corrections détectées`, 'Un même produit peut nécessiter plusieurs corrections.'],
    nl: [`${total} correcties gevonden`, 'Eenzelfde product kan meerdere correcties nodig hebben.'],
    en: [`${total} corrections detected`, 'The same product may need several corrections.'],
  };
  for (const [lang, [note, hint]] of Object.entries(want)) {
    for (const h of ['#/', '#/opportunities']) {
      const { root, errors } = await growthDom(h, { lang });
      assert.deepEqual(errors, []);
      const tile = text(all(root, (n) => hasClass(n, 'ex-kpi'))[0]);
      assert.ok(tile.includes(note) && tile.includes(hint), `${lang} ${h}: ${tile}`);
      assert.ok(!/éléments concernés|betrokken elementen|items affected/.test(text(root)), `${lang} ${h}: ambiguous wording`);
    }
  }
});

test('growth UI: FR, NL and EN dictionaries have exactly the same keys, and every key the pages build exists', async () => {
  const ctx = { window: {} };
  for (const l of ['fr', 'nl', 'en']) vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
  const D = ctx.window.NORDLA_DICTS;
  const fr = Object.keys(D.fr).sort();
  assert.deepEqual(Object.keys(D.nl).sort(), fr);
  assert.deepEqual(Object.keys(D.en).sort(), fr);
  for (const f of ['app.js', 'opportunities.js']) {
    const src = await readFile(new URL(f, UI), 'utf8');
    for (const k of [...src.matchAll(/\bt\('(gr\.[\w.]+)'/g)].map((m) => m[1])) assert.ok(D.fr[k], `${f}: missing key ${k}`);
  }
  // Keys built from an engine value: every value an engine can emit has its text in the three languages.
  const dyn = [
    ...['overview', 'opportunities', 'potential', 'content', 'storeGrowth', 'audience', 'ai', 'settings'].map((k) => `gr.nav.${k}`),
    ...CONTENT_CHECKS.flatMap((c) => [`gr.op.fix.content.${c.code}.title`, `gr.op.fix.content.${c.code}.why`]),
    ...POTENTIAL_STATUSES.map((s) => `gr.op.f.potential.${s}`),
    ...['risingBlocked', 'watch', 'declining', 'lowMargin', 'returns', 'storeSuggestionThin', 'notValidated', 'noProductEngine'].map((c) => `gr.op.why.${c}`),
    ...['productSales', 'verifiedCosts', 'identifiedCustomers', 'storeHistory', 'onlineOrders', 'storeOrders'].map((c) => `gr.op.wait.${c}`),
    ...['verifiedCost', 'moreWeeks', 'risingDemand', 'fewerReturns', 'productHistory'].map((c) => `gr.op.m.${c}`),
    ...['storeTop', 'storeTopBlocked', 'storeSuggested', 'storeSuggestedNotRecommended', 'costUnverified', 'costMissing', 'contentIncomplete', 'risingDemand'].map((c) => `gr.op.f.${c}`),
    ...['push', 'restock'].flatMap((s) => [`gr.op.item.product.${s}.title`, `gr.op.item.product.${s}.why`]),
    ...SEGMENTS.map((s) => `gr.au.seg.${s}`),
    ...['potential', 'content', 'storeGrowth', 'audience'].map((p) => `gr.op.link.${p}`),
  ];
  for (const k of dyn) for (const l of ['fr', 'nl', 'en']) assert.ok(D[l][k], `missing ${l} key ${k}`);
  // No key of a removed feature is left.
  assert.deepEqual(fr.filter((k) => /^gr\.(cp|camp|ch)\.|^gr\.demo|^gr\.nav\.campaigns$|opportunitySoon|improveSoon|newSegmentSoon/.test(k)), []);
});

test('growth UI: every icon it asks for is a Growth pack file on disk or a valid (non-defective) official Nordla icon', async () => {
  const ctx = { window: {}, document: { createElement: () => ({ setAttribute() {} }) } };
  vm.runInNewContext(await readFile(new URL('nordla-icon.js', SHARED), 'utf8'), ctx);
  const { ICONS, DEFECTIVE } = ctx.window.NordlaIcon;
  const src = await readFile(new URL('app.js', UI), 'utf8');
  const ops = await readFile(new URL('opportunities.js', UI), 'utf8');
  const pack = Object.fromEntries([...src.split('const GROWTH_PACK = {')[1].split('};')[0].matchAll(/(\w+): '([\w-]+)'/g)].map((m) => [m[1], m[2]]));
  for (const f of Object.values(pack)) {
    const png = await readFile(new URL(`assets/icons/${f}.png`, UI)); // throws if missing
    assert.equal(png.toString('latin1', 1, 4), 'PNG', `${f}.png is a PNG`);
    assert.equal(png[25], 6, `${f}.png must be RGBA (transparent), PNG colour type 6`);
  }
  assert.ok(!/GROWTH_PACK_OPAQUE|gr-pack-opaque/.test(src), 'no opaque-icon workaround left');
  assert.ok(!/mix-blend-mode/.test(await readFile(new URL('growth.css', UI), 'utf8')), 'no blend-mode workaround left in growth.css');
  const aliasMap = Object.fromEntries([...src.split('const GROWTH_ICONS = {')[1].split('};')[0].matchAll(/(\w+): '([\w:]+)'/g)].map((m) => [m[1], m[2]]));
  const navSrc = src.split('const GROWTH_NAV = [')[1].split('function navItem')[0];
  const nav = [...navSrc.matchAll(/icon: '(\w+)'/g)].map((m) => aliasMap[m[1]] || m[1]);
  const direct = [...(src + ops).matchAll(/NordlaIcon\.semantic\('(\w+)'/g)].map((m) => m[1]);
  // Icons named by the Opportunités page (kpi / cardHead / icoBubble / OP_ITEM_ICON).
  const opNames = [...ops.matchAll(/(?:kpi|cardHead|icoBubble)\('(\w+)'/g), ...ops.split('const OP_ITEM_ICON = {')[1].split('};')[0].matchAll(/: '(\w+)'/g)].map((m) => aliasMap[m[1]] || m[1]);
  for (const name of [...Object.values(aliasMap), ...nav, ...direct, ...opNames]) {
    if (name.startsWith('pack:')) { assert.ok(pack[name.slice(5)], `${name} is not in GROWTH_PACK`); continue; }
    assert.ok(!DEFECTIVE[name], `${name} is a defective export and must not be rendered`);
    assert.ok(ICONS[name], `${name} is not an official Nordla icon`);
  }
});
