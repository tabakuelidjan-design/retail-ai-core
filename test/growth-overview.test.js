import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createGrowthApp } from '../src/growth/server/app.js';
import { buildDemoOverview } from '../src/growth/server/demo-overview.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const SHARED = new URL('../src/shared/', import.meta.url);

async function withServer(opts, fn) {
  const server = http.createServer(createGrowthApp(opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('growth server: serves the page, its own assets, the shared design system and the demo overview', async () => {
  await withServer({ now: () => new Date('2026-09-26T10:00:00Z') }, async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-module="growth"/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    for (const p of ['/app.js', '/growth.css', '/lang-fr.js', '/lang-nl.js', '/lang-en.js', '/style.css', '/nordla-tokens.css', '/i18n.js', '/nordla-icon.js', '/nordla-charts.js', '/nordla-charts.css', '/nordla-fonts.css', '/nordla-assets/official-icons/01_navigation_modules_growth.png']) {
      const r = await fetch(base + p); assert.equal(r.status, 200, p); await r.arrayBuffer();
    }
    // Reused Analytics stylesheet is served byte-identical (a reuse, not a fork).
    assert.equal(await (await fetch(`${base}/style.css`)).text(), await readFile(new URL('../src/analytics-premium/ui/style.css', import.meta.url), 'utf8'));
    const d = await (await fetch(`${base}/api/growth/overview`)).json();
    assert.equal(d.demo, true, 'the overview must always be flagged as demonstration data');
    assert.equal(d.modules, undefined, 'Growth does not route between services (no module links in the payload)');
    assert.equal(d.period.to, '2026-09-26');
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/growth/overview`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/nordla-assets/../package.json`)).status, 404);
    // Channel logo slot: no official file supplied yet -> 404 (UI shows placeholders); traversal impossible.
    assert.equal((await fetch(`${base}/growth-assets/channels/instagram.svg`)).status, 404);
    assert.equal((await fetch(`${base}/growth-assets/channels/..%2F..%2Fserver%2Fapp.js`)).status, 404);
  });
});

test('growth UI: no demonstration value lives in the UI - the data source can be replaced without touching the page', async () => {
  const src = await readFile(new URL('app.js', UI), 'utf8');
  const d = buildDemoOverview(new Date('2026-09-26T10:00:00Z'));
  // No demo figure, name or text from the payload is hardcoded in the UI.
  const demoLiterals = [
    ...d.channels.map((c) => c.name),
    ...[...d.insights, ...d.attention, ...d.opportunities].map((x) => x.title.fr),
    ...d.campaigns.map((c) => c.name.fr), ...d.content.map((c) => c.title.fr), ...d.experiments.map((x) => x.name.fr),
    '12540', '12 540', '39600', '4860', '14380', '3.2', "'EUR'",
  ];
  for (const v of demoLiterals.filter((v) => v !== "'EUR'")) assert.ok(!src.includes(v), `demo value hardcoded in UI: ${v}`);
  assert.equal((src.match(/currency: 'EUR'/g) || []).length, 0, 'currency must come from the payload');
  assert.ok(!/GROWTH_(FINANCE|ANALYTICS)_URL|modules\[/.test(src), 'no inter-service routing in the UI');
  // Every row kind the data uses has a UI icon mapping (presentation stays in the UI).
  const map = src.split('const GROWTH_ICONS = {')[1].split('};')[0];
  const key = (g, k) => `${g}${k.charAt(0).toUpperCase()}${k.slice(1)}`;
  for (const k of [...d.insights.map((x) => key('insight', x.kind)), ...d.attention.map((x) => key('attention', x.kind)), ...d.opportunities.map((x) => key('opportunity', x.kind))]) assert.match(map, new RegExp(`\\b${k}:`), `no icon for ${k}`);
  for (const x of [...d.insights, ...d.attention, ...d.opportunities]) assert.equal(x.icon, undefined, 'the data source never names icons');
});

test('growth UI: sidebar is Growth\'s own navigation (7 Growth pages + Nordla AI and Settings), no other Nordla module', async () => {
  const src = await readFile(new URL('app.js', UI), 'utf8');
  const keys = (block) => [...src.split(`const ${block} = [`)[1].split('];')[0].matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys('GROWTH_NAV'), ['overview', 'opportunities', 'campaigns', 'content', 'storeGrowth', 'audience', 'experiments']);
  assert.deepEqual(keys('GROWTH_NAV_FOOT'), ['ai', 'settings']);
  assert.ok(!/gr\.nav\.(finance|analytics|buying|afterSales|compliance)|tresorerie|buyingSuppliers/.test(src), 'no other Nordla module in the Growth navigation');
});

test('growth UI: temporary icons and channel placeholders are explicitly marked', async () => {
  const src = await readFile(new URL('app.js', UI), 'utf8');
  assert.match(src, /PLACEHOLDER thumbnail/);
  for (const concept of ['Opportunities', 'Campaigns', 'Experiments', 'AI Insights', 'Needs Attention']) assert.ok(src.includes(`TEMP_ICON (${concept})`), `TEMP_ICON marker missing for ${concept}`);
  assert.match(src, /const CHANNEL_LOGOS = \{[^}]*\}/);
  assert.ok(!/CHANNEL_LOGOS = \{[^}]*'[a-z-]+\.(svg|png|webp)'/.test(src), 'no logo file is wired until an official asset is supplied');
  assert.match(src, /CHANNEL_PLACEHOLDER = .*\/\/ PLACEHOLDER/);
});

test('demo overview: figures are internally consistent (no contradictory example numbers)', () => {
  const d = buildDemoOverview(new Date('2026-09-26T10:00:00Z'));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  assert.equal(d.pulse.dates.length, 30);
  assert.equal(sum(d.pulse.influencedRevenue), d.kpis.revenueInfluenced.value);
  assert.equal(sum(d.pulse.influencedRevenue), d.pulse.totals.influencedRevenue);
  assert.equal(sum(d.pulse.totalRevenue), d.pulse.totals.totalRevenue);
  assert.equal(sum(d.pulse.storeVisitors), d.pulse.totals.storeVisitors);
  assert.equal(sum(d.store.traffic.series), d.store.traffic.value);
  assert.equal(sum(d.store.revenue.series), d.store.revenue.value);
  assert.equal(sum(d.channels.map((c) => c.revenue)), d.kpis.revenueInfluenced.value, 'channel revenues add up to the influenced revenue');
  assert.ok(d.pulse.totalRevenue.every((v, i) => v >= d.pulse.influencedRevenue[i]));
  assert.equal(d.campaigns.length, d.kpis.activeCampaigns.value);
  assert.equal(d.campaigns.filter((c) => c.status === 'performing').length, d.kpis.activeCampaigns.performingWell);
  assert.equal(d.experiments.length, d.kpis.experimentsRunning.value);
  const endsThisWeek = d.experiments.filter((x) => (new Date(`${x.end}T00:00:00Z`) - new Date('2026-09-26T00:00:00Z')) / 86400000 <= 7);
  assert.equal(endsThisWeek.length, d.kpis.experimentsRunning.endingThisWeek);
  // Deterministic: same day, same payload.
  assert.deepEqual(buildDemoOverview(new Date('2026-09-26T18:00:00Z')).pulse, d.pulse);
});

test('growth UI: FR, NL and EN dictionaries have exactly the same keys, and every key used by app.js exists', async () => {
  const ctx = { window: {} };
  for (const l of ['fr', 'nl', 'en']) vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
  const D = ctx.window.NORDLA_DICTS;
  const fr = Object.keys(D.fr).sort();
  assert.deepEqual(Object.keys(D.nl).sort(), fr);
  assert.deepEqual(Object.keys(D.en).sort(), fr);
  const src = await readFile(new URL('app.js', UI), 'utf8');
  const literal = [...src.matchAll(/\bt\('(gr\.[\w.]+)'/g)].map((m) => m[1]);
  for (const k of literal) assert.ok(D.fr[k], `missing key ${k}`);
  // Keys built from a prefix + data value (t(`gr.x.${v}`)) must exist for every value the demo payload uses.
  const d = buildDemoOverview(new Date('2026-09-26T10:00:00Z'));
  const dyn = [
    ...['overview', 'opportunities', 'campaigns', 'content', 'storeGrowth', 'audience', 'experiments', 'ai', 'settings'].map((k) => `gr.nav.${k}`),
    ...d.attention.flatMap((a) => [`gr.att.status.${a.status}`, `gr.att.action.${a.action}`]),
    ...d.channels.map((c) => `gr.ch.unit.${c.reachKind}`),
    ...d.campaigns.map((c) => `gr.camp.status.${c.status}`),
    ...d.content.flatMap((c) => [`gr.content.kind.${c.kind}`, `gr.content.perf.${c.performance}`]),
    ...d.opportunities.flatMap((o) => [`gr.opp.priority.${o.priority}`, `gr.opp.status.${o.status}`]),
    ...d.experiments.map((x) => `gr.exp.status.${x.status}`),
    'gr.pulse.revenue', 'gr.pulse.traffic',
  ];
  for (const k of dyn) assert.ok(D.fr[k], `missing key ${k}`);
  // Demo content carries all three languages.
  for (const i of [...d.insights, ...d.attention, ...d.opportunities]) for (const l of ['fr', 'nl', 'en']) assert.ok(i.title[l], `demo text missing ${l}`);
});

test('growth UI: every official icon it asks for exists and is not a known-defective export', async () => {
  const ctx = { window: {}, document: { createElement: () => ({ setAttribute() {} }) } };
  vm.runInNewContext(await readFile(new URL('nordla-icon.js', SHARED), 'utf8'), ctx);
  const { ICONS, DEFECTIVE } = ctx.window.NordlaIcon;
  const src = await readFile(new URL('app.js', UI), 'utf8');
  const aliasMap = Object.fromEntries([...src.split('const GROWTH_ICONS = {')[1].split('};')[0].matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]));
  const aliases = Object.values(aliasMap);
  const navSrc = src.split('const GROWTH_NAV = [')[1].split('function navItem')[0];
  const nav = [...navSrc.matchAll(/icon: '(\w+)'/g)].map((m) => aliasMap[m[1]] || m[1]);
  const direct = [...src.matchAll(/NordlaIcon\.semantic\('(\w+)'/g)].map((m) => m[1]);
  for (const name of [...aliases, ...nav, ...direct]) {
    assert.ok(!DEFECTIVE[name], `${name} is a defective export and must not be rendered`);
    assert.ok(ICONS[name], `${name} is not an official Nordla icon`);
  }
});
