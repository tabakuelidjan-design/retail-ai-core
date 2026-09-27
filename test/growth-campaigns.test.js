import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createGrowthApp } from '../src/growth/server/app.js';
import { buildDemoCampaigns } from '../src/growth/server/demo-campaigns.js';
import { growthDom, all, text, hasClass, navState, title, NOW } from './growth-dom.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const sum = (a, k) => a.reduce((x, c) => x + c[k], 0);

test('campaigns server: page script and demo payload are served', async () => {
  const server = http.createServer(createGrowthApp({ now: () => NOW }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const js = await fetch(`${base}/campaigns.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    await js.text();
    const d = await (await fetch(`${base}/api/growth/campaigns`)).json();
    assert.equal(d.demo, true);
    assert.equal(d.campaigns.length, 12);
  } finally { server.close(); }
});

test('demo campaigns: KPIs, channel figures and actions are derived from the 12 rows (no contradictory figures)', () => {
  const d = buildDemoCampaigns(NOW);
  const c = d.campaigns;
  assert.equal(c.length, 12);
  assert.equal(d.kpis.revenue.value, sum(c, 'revenue'));
  assert.equal(d.kpis.clicks.value, sum(c, 'clicks'));
  assert.equal(d.kpis.newCustomers.value, sum(c, 'newCustomers'));
  assert.equal(d.kpis.roas.value, Math.round((sum(c, 'revenue') / sum(c, 'spend')) * 10) / 10);
  // The figures the brief fixed.
  assert.deepEqual([d.kpis.revenue.value, d.kpis.clicks.value, d.kpis.newCustomers.value, d.kpis.roas.value], [8400, 24500, 1230, 3.4]);
  const pct = (x) => Math.round((x.value / x.previous - 1) * 100);
  assert.deepEqual([pct(d.kpis.revenue), pct(d.kpis.clicks), pct(d.kpis.newCustomers)], [28, 35, 42]);
  assert.equal(Math.round((d.kpis.roas.value - d.kpis.roas.previous) * 10) / 10, 0.8);
  // Per channel = sum of that channel's rows; shares add up to the whole.
  for (const ch of d.channels) assert.equal(ch.revenue, sum(c.filter((x) => x.channel === ch.id), 'revenue'), ch.id);
  assert.equal(sum(d.channels, 'revenue'), d.kpis.revenue.value);
  assert.deepEqual(d.channels.map((ch) => [ch.id, ch.revenue, Math.round(ch.share * 100)]), [['google-search', 3200, 38], ['instagram', 2100, 25], ['tiktok', 1400, 17], ['facebook', 1200, 14], ['google-business', 500, 6]]);
  // Rows: spend never exceeds budget; campaigns not launched have no results; statuses/objectives are known.
  for (const x of c) {
    assert.ok(x.spend <= x.budget, x.id);
    assert.ok(['running', 'ready', 'planned'].includes(x.status), x.id);
    assert.ok(['sales', 'awareness', 'storeTraffic', 'retention', 'recruitment'].includes(x.objective), x.id);
    assert.ok(d.channels.some((ch) => ch.id === x.channel), x.id);
    if (x.status !== 'running') assert.deepEqual([x.spend, x.revenue, x.clicks, x.newCustomers], [0, 0, 0, 0], x.id);
    assert.ok(x.start <= x.end, x.id);
  }
  // Dates fit the page's window (last 30 days, ending today): running campaigns overlap it, the others start after today.
  const today = '2026-09-26';
  assert.deepEqual([d.period.from, d.period.to], ['2026-08-28', today]);
  for (const x of c) {
    if (x.status === 'running') assert.ok(x.start <= today && x.end >= d.period.from, `${x.id} must overlap the window`);
    else assert.ok(x.start > today, `${x.id} (${x.status}) must start after today`);
  }
  // Revenue vs spend chart: 30 daily points whose sums are the revenue KPI and the spend behind the ROAS.
  const s2 = (a) => a.reduce((x, y) => x + y, 0);
  assert.equal(d.trend.dates.length, 30);
  assert.equal(d.trend.dates[29], today);
  assert.equal(s2(d.trend.revenue), d.kpis.revenue.value);
  assert.equal(s2(d.trend.spend), sum(c, 'spend'));
  assert.ok(d.trend.revenue.every((v) => v >= 0) && d.trend.spend.every((v) => v >= 0));
  // Per channel: spend and ROAS derived from the rows; spends add up to the spend behind the average ROAS.
  for (const ch of d.channels) {
    const rows = c.filter((x) => x.channel === ch.id);
    assert.equal(ch.spend, sum(rows, 'spend'), ch.id);
    assert.equal(ch.roas, ch.spend ? Math.round((ch.revenue / ch.spend) * 10) / 10 : null, ch.id);
  }
  assert.equal(sum(d.channels, 'spend'), sum(c, 'spend'));
  // A campaign not launched yet has no performance; labels carry no fixed year.
  for (const x of c.filter((y) => y.status === 'ready')) assert.equal(x.performance, null, x.id);
  assert.ok(!/20\d\d/.test(JSON.stringify([c.map((x) => [x.title, x.subtitle]), d.actions.map((a) => [a.title, a.text])])), 'no year in demo labels');
  // Priority actions point to real rows (the student offer is the "ready" campaign).
  const ids = new Set(c.map((x) => x.id));
  for (const a of d.actions) assert.ok(ids.has(a.campaignId), a.campaignId);
  assert.equal(c.find((x) => x.id === d.actions[0].campaignId).status, 'ready');
});

test('campaigns UI: labels in FR/NL/EN; no demo value hardcoded; channel logos come from the wired files', async () => {
  const ctx = { window: {} };
  for (const l of ['fr', 'nl', 'en']) vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
  const D = ctx.window.NORDLA_DICTS;
  const src = await readFile(new URL('campaigns.js', UI), 'utf8');
  const d = buildDemoCampaigns(NOW);
  const keys = [
    ...[...src.matchAll(/\bt\('(gr\.[\w.]+)'/g)].map((m) => m[1]),
    ...d.campaigns.flatMap((x) => [`gr.cp.status.${x.status}`, `gr.cp.objective.${x.objective}`]),
    ...['campaign', 'channel', 'objective', 'period', 'budget', 'status', 'performance'].map((k) => `gr.cp.col.${k}`),
    'gr.cp.title', 'gr.cp.subtitle', 'gr.nav.campaigns',
  ];
  for (const k of keys) for (const l of ['fr', 'nl', 'en']) assert.ok(D[l][k], `missing ${l} key ${k}`);
  for (const v of [...d.campaigns.map((x) => x.title.fr), ...d.campaigns.map((x) => x.subtitle.fr), ...d.actions.map((a) => a.title.fr), 'Google Search', '8400', '8 400', '24500', "'EUR'"]) {
    assert.ok(!src.includes(v), `demo value hardcoded in campaigns.js: ${v}`);
  }
  assert.ok(!src.includes('TEMP_ICON'));
  assert.match(src, /kpi\('clicks', t\('gr\.cp\.kpi\.clicks'\)/, 'the Clics KPI uses the supplied clicks icon');
});

test('campaigns UI: renders, sidebar marks Campagnes active, navigation to Overview and Opportunités works', async () => {
  const { root, errors, navigate } = await growthDom('#/campaigns');
  assert.deepEqual(errors, []);
  assert.equal(title(root), 'Campagnes');
  const nav = navState(root);
  assert.deepEqual(nav.filter((n) => n.active).map((n) => n.label), ['Campagnes']);
  assert.deepEqual(nav.filter((n) => n.href).map((n) => [n.label, n.href]), [['Vue d’ensemble', '#/'], ['Opportunités', '#/opportunities'], ['Campagnes', '#/campaigns'], ['Produits Potentiels', '#/potential'], ['Contenu', '#/content'], ['Croissance magasin', '#/storeGrowth'], ['Audience', '#/audience']]);
  assert.equal(all(root, (n) => hasClass(n, 'ex-kpi')).length, 4);
  assert.match(text(root), /Campagnes \(12\)/);
  assert.equal(all(root, (n) => n.tagName === 'TR' && n.children.length === 8 && n.children[0].tagName === 'TD').length, 12);
  // Every channel mark is the logo image (no monogram) and points to a wired logo file.
  const marks = all(root, (n) => hasClass(n, 'gr-ch'));
  assert.ok(marks.length >= 12 + 3 + 5);
  for (const m of marks) { assert.equal(m.tagName, 'IMG'); assert.match(m.getAttribute('src'), /^\/growth-assets\/channels\/[a-z-]+\.png$/); }
  assert.equal(all(root, (n) => hasClass(n, 'gr-ch-fallback')).length, 0);
  assert.ok(text(root).includes('Données de démonstration'));
  await navigate('#/opportunities');
  assert.equal(title(root), 'Opportunités');
  await navigate('#/');
  assert.equal(title(root), 'Growth');
  await navigate('#/campaigns');
  assert.equal(title(root), 'Campagnes');
  assert.deepEqual(errors, []);
});

test('campaigns UI: search (accent/case-insensitive), channel and status filters work on the loaded rows', async () => {
  const { root, errors } = await growthDom('#/campaigns');
  const names = () => all(root, (n) => n.tagName === 'TR' && n.children.length === 8 && n.children[0].tagName === 'TD').map((r) => text(r.children[0].children[0].children[1].children[0]));
  const tools = () => all(all(root, (n) => hasClass(n, 'gr-cp-tools'))[0], (n) => n.tagName === 'INPUT' || n.tagName === 'SELECT');
  const search = (q) => tools()[0].listeners.input[0]({ target: { value: q, selectionStart: q.length } });
  const select = (i, value) => tools()[i].listeners.change[0]({ target: { value } });
  search('ETUDIANT');
  assert.deepEqual(names(), ['Offre étudiants'], 'matches the subtitle, ignoring case and accents');
  search('');
  select(1, 'instagram');
  assert.deepEqual(names(), ['Offre étudiants', 'Bundle accessoires', 'Nouveautés']);
  select(2, 'running');
  assert.deepEqual(names(), ['Bundle accessoires', 'Nouveautés']);
  select(1, 'all'); select(2, 'planned');
  assert.deepEqual(names(), ['Fêtes de fin d’année', 'Recrutement magasin', 'Tutoriels personnalisation']);
  search('zzz');
  assert.deepEqual(names(), []);
  assert.ok(text(root).includes('Aucune campagne ne correspond à cette recherche.'));
  assert.deepEqual(errors, []);
});

// Base updated 2026-09-27: Growth now builds on the Nordla platform baseline (08619d7), not on the old 3c5f473 line.
test('campaigns: no Finance, Analytics or shared file differs from the Nordla platform baseline', () => {
  const out = execFileSync('git', ['diff', '--name-only', '08619d7', '--', 'src/finance', 'src/analytics-premium', 'src/shared'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(out.trim(), '');
});

test('campaigns UI: budget / performance sort, dash for the campaign not launched, spend and ROAS per channel', async () => {
  const { root, errors } = await growthDom('#/campaigns');
  const rows = () => all(root, (n) => n.tagName === 'TR' && n.children.length === 8 && n.children[0].tagName === 'TD');
  const names = () => rows().map((r) => text(r.children[0].children[0].children[1].children[0]));
  const perfOf = (name) => text(rows().find((r) => text(r.children[0]).includes(name)).children[6]);
  const sortSel = () => all(all(root, (n) => hasClass(n, 'gr-cp-tools'))[0], (n) => n.tagName === 'SELECT')[2];
  assert.equal(perfOf('Offre étudiants'), '—');
  const d = buildDemoCampaigns(NOW);
  sortSel().listeners.change[0]({ target: { value: 'budget' } });
  assert.deepEqual(names(), d.campaigns.slice().sort((a, b) => b.budget - a.budget).map((x) => x.title.fr));
  sortSel().listeners.change[0]({ target: { value: 'performance' } });
  const byPerf = names();
  assert.equal(byPerf[0], 'Ouverture Lyon', 'best performance first (110 %)');
  assert.equal(byPerf[byPerf.length - 1], 'Offre étudiants', 'no performance yet = last');
  const chText = text(all(root, (n) => hasClass(n, 'gr-cp-channels'))[0]);
  assert.match(chText, /ROAS 2,9/); assert.match(chText, /ROAS 6,7/);
  assert.deepEqual(errors, []);
});

test('campaigns UI: every campaign thumbnail shows its own theme icon (no empty tile, no icon shared by unrelated campaigns)', async () => {
  const { root, errors } = await growthDom('#/campaigns');
  const thumbs = all(root, (n) => hasClass(n, 'gr-cp-thumb'));
  assert.equal(thumbs.length, 12);
  for (const th of thumbs) assert.equal(th.children.length, 1, 'thumbnail has an icon');
  const src = await readFile(new URL('app.js', UI), 'utf8');
  const map = Object.fromEntries([...src.split('const GROWTH_ICONS = {')[1].split('};')[0].matchAll(/(\w+): '([\w:]+)'/g)].map((m) => [m[1], m[2]]));
  const c = buildDemoCampaigns(NOW).campaigns;
  const icons = c.map((x) => map[`theme${x.theme.charAt(0).toUpperCase()}${x.theme.slice(1)}`]);
  icons.forEach((ic, i) => assert.ok(ic, `no icon for theme ${c[i].theme}`));
  assert.equal(new Set(icons).size, c.length, 'one distinct icon per campaign');
  assert.deepEqual(errors, []);
});
