import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { buildDemoOpportunities } from '../src/growth/server/demo-opportunities.js';
import { growthDom, all, text, hasClass, navState, title } from './growth-dom.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const ANALYTICS_UI = new URL('../src/analytics-premium/ui/', import.meta.url);
const NOW = new Date('2026-09-26T10:00:00Z');
const sum = (a) => a.reduce((x, y) => x + y, 0);

test('demo opportunities: every KPI is derived from the rows (no contradictory figures)', () => {
  const d = buildDemoOpportunities(NOW);
  const p = d.pipeline;
  assert.equal(d.demo, true);
  assert.equal(d.kpis.potentialRevenue.value, sum(p.map((o) => o.revenue)), 'potential revenue = sum of the active pipeline');
  assert.equal(d.kpis.potentialRevenue.active, p.length);
  assert.equal(d.kpis.priority.value, p.filter((o) => o.priority !== 'low').length);
  assert.equal(d.kpis.priority.high, p.filter((o) => o.priority === 'high').length);
  assert.equal(d.kpis.readyToApprove.value, p.filter((o) => o.status === 'ready').length);
  assert.equal(d.kpis.inProgress.value, p.filter((o) => o.status === 'inProgress').length);
  const thisMonth = d.wins.filter((w) => w.date.startsWith('2026-09'));
  assert.equal(d.kpis.winsThisMonth.value, thisMonth.length);
  assert.equal(d.kpis.winsThisMonth.revenue, sum(thisMonth.map((w) => w.result)));
  // The figures the brief fixed.
  assert.deepEqual([d.kpis.priority.value, d.kpis.priority.value - d.kpis.priority.previous, d.kpis.priority.high], [8, 3, 4]);
  assert.equal(Math.round((d.kpis.potentialRevenue.value / d.kpis.potentialRevenue.previous - 1) * 100), 45);
  assert.deepEqual([d.kpis.potentialRevenue.active, d.kpis.readyToApprove.value, d.kpis.inProgress.value, d.kpis.winsThisMonth.value, d.kpis.winsThisMonth.revenue], [12, 3, 4, 2, 4300]);
  // Cross references: recommendations and approvals point to real pipeline rows; approvals are exactly the "ready" rows.
  const ids = new Set(p.map((o) => o.id));
  for (const r of d.recommendations) assert.ok(ids.has(r.opportunityId), r.opportunityId);
  assert.deepEqual(d.approvals.map((a) => a.opportunityId), p.filter((o) => o.status === 'ready').map((o) => o.id));
  for (const a of d.approvals) assert.equal(a.expectedRevenue, p.find((o) => o.id === a.opportunityId).revenue);
  for (const a of d.approvals) assert.ok(a.budget > 0 && a.budget < a.expectedRevenue);
  // Enumerations the UI knows how to label.
  for (const o of p) {
    assert.ok(['high', 'medium', 'low'].includes(o.priority));
    assert.ok(['low', 'medium', 'high'].includes(o.effort));
    assert.ok(['high', 'low'].includes(o.impact));
    assert.ok(['ready', 'inProgress', 'analysis', 'planned'].includes(o.status));
    assert.ok(o.confidence > 0 && o.confidence <= 1);
    assert.equal(o.budget, undefined, 'budget is only exposed through approvals');
  }
  assert.deepEqual(buildDemoOpportunities(new Date('2026-09-26T20:00:00Z')).pipeline, p, 'deterministic');
});

test('opportunities UI: all labels exist in FR/NL/EN; no demo value hardcoded in the page code', async () => {
  const ctx = { window: {} };
  for (const l of ['fr', 'nl', 'en']) vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
  const D = ctx.window.NORDLA_DICTS;
  const src = await readFile(new URL('opportunities.js', UI), 'utf8');
  const d = buildDemoOpportunities(NOW);
  const keys = [
    ...[...src.matchAll(/\bt\('(gr\.[\w.]+)'/g)].map((m) => m[1]),
    ...d.pipeline.flatMap((o) => [`gr.op.src.${o.source}`, `gr.op.status.${o.status}`, `gr.op.priority.${o.priority}`, `gr.op.effort.${o.effort}`]),
    ...['name', 'source', 'priority', 'revenue', 'confidence', 'effort', 'status'].map((c) => `gr.op.col.${c}`),
    ...['priority', 'revenue', 'confidence'].map((s) => `gr.op.f.sort.${s}`),
    ...['highLow', 'highHigh', 'lowLow', 'lowHigh'].map((c) => `gr.op.mx.${c}`),
    'gr.op.title', 'gr.op.subtitle',
  ];
  for (const k of keys) for (const l of ['fr', 'nl', 'en']) assert.ok(D[l][k], `missing ${l} key ${k}`);
  for (const v of [...d.pipeline.map((o) => o.title.fr), ...d.recommendations.map((r) => r.title.fr), ...d.segments.map((s) => s.label.fr), ...d.wins.map((w) => w.title.fr), '14800', '14 800', '4300', "'EUR'"]) {
    assert.ok(!src.includes(v), `demo value hardcoded in opportunities.js: ${v}`);
  }
});



test('opportunities UI: renders without error, sidebar marks Opportunités active, and Vue d\'ensemble leads back to the Overview', async () => {
  const { root, errors, navigate } = await growthDom('#/opportunities');
  assert.deepEqual(errors, []);
  assert.equal(title(root), 'Opportunités');
  const nav = navState(root);
  assert.deepEqual(nav.map((n) => n.label), ['Vue d’ensemble', 'Opportunités', 'Campagnes', 'Contenu', 'Croissance magasin', 'Audience', 'Expériences', 'Nordla AI', 'Paramètres']);
  assert.deepEqual(nav.filter((n) => n.active).map((n) => n.label), ['Opportunités']);
  assert.deepEqual(nav.filter((n) => n.href).map((n) => [n.label, n.href]), [['Vue d’ensemble', '#/'], ['Opportunités', '#/opportunities'], ['Campagnes', '#/campaigns']]);
  assert.equal(nav.filter((n) => n.inert).length, 6, 'the 4 unbuilt pages + Nordla AI + Paramètres stay disabled');
  // Page content: 5 KPIs, 12 pipeline rows, 3 approvals, the demo badge.
  assert.equal(all(root, (n) => hasClass(n, 'ex-kpi')).length, 5);
  assert.equal(all(root, (n) => n.tagName === 'TR' && n.children.length === 8 && n.children[0].tagName === 'TD').length, 12);
  assert.equal(all(root, (n) => hasClass(n, 'gr-approvals'))[0] && all(all(root, (n) => hasClass(n, 'gr-approvals'))[0], (n) => n.tagName === 'BUTTON').length, 3);
  assert.ok(text(root).includes('Données de démonstration'));
  assert.match(text(root), /14\s800\s€/u, 'potential revenue KPI rendered from the payload');
  // Back to the Overview through the sidebar route.
  await navigate('#/');
  assert.deepEqual(errors, []);
  assert.equal(title(root), 'Growth');
  assert.deepEqual(navState(root).filter((n) => n.active).map((n) => n.label), ['Vue d’ensemble']);
});

test('opportunities UI: pipeline filters and sort work on the loaded rows', async () => {
  const { root, errors } = await growthDom('#/opportunities');
  const rowsNames = () => all(root, (n) => n.tagName === 'TR' && n.children.length === 8 && n.children[0].tagName === 'TD').map((r) => text(r.children[0]));
  const selects = () => all(all(root, (n) => hasClass(n, 'gr-filters'))[0], (n) => n.tagName === 'SELECT');
  const change = (i, value) => selects()[i].listeners.change[0]({ target: { value } });
  assert.equal(rowsNames()[0], 'Augmenter le trafic magasin', 'default sort: priority, then revenue');
  change(1, 'ready');
  assert.deepEqual(rowsNames(), ['Augmenter le trafic magasin', 'Offre étudiants', 'Bundle coque + support']);
  change(0, 'customers');
  assert.deepEqual(rowsNames(), [], 'no customer-behaviour opportunity is ready');
  assert.ok(text(root).includes('Aucune opportunité ne correspond à ces filtres.'));
  change(1, 'all');
  assert.deepEqual(rowsNames(), ['Upsell boîte cadeau', 'Relance des clients inactifs', 'Carte de fidélité']);
  change(0, 'all'); change(2, 'confidence');
  const conf = buildDemoOpportunities(NOW).pipeline.slice().sort((a, b) => b.confidence - a.confidence).map((o) => o.title.fr);
  assert.deepEqual(rowsNames(), conf);
  assert.deepEqual(errors, []);
});

// Base updated 2026-09-27: Growth now builds on the Nordla platform baseline (08619d7), not on the old e7c96c2 line.
test('growth: no Finance, Analytics or shared file differs from the Nordla platform baseline', () => {
  const out = execFileSync('git', ['diff', '--name-only', '08619d7', '--', 'src/finance', 'src/analytics-premium', 'src/shared'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(out.trim(), '');
});

test('opportunities UI: every source and segment has an icon (Growth pack or official), none invented', async () => {
  const src = await readFile(new URL('app.js', UI), 'utf8');
  const map = Object.fromEntries([...src.split('const GROWTH_ICONS = {')[1].split('};')[0].matchAll(/(\w+): '([\w:]+)'/g)].map((m) => [m[1], m[2]]));
  const key = (g, k) => `${g}${k.charAt(0).toUpperCase()}${k.slice(1)}`;
  const d = buildDemoOpportunities(NOW);
  for (const s of new Set(d.pipeline.map((o) => o.source))) assert.ok(map[key('src', s)], `no icon for source ${s}`);
  for (const s of d.segments) assert.ok(map[key('seg', s.id)], `no icon for segment ${s.id}`);
  for (const k of ['priorityHigh', 'confidence', 'effort', 'impactEffort']) assert.match(map[k], /^pack:/, k);
});

test('opportunities charts: source / status breakdowns and 30-day series are exactly consistent with the pipeline and KPIs', () => {
  const d = buildDemoOpportunities(NOW);
  const s = (a) => a.reduce((x, y) => x + y, 0);
  const total = s(d.pipeline.map((o) => o.revenue));
  assert.equal(total, 14800);
  // By source: every source present in the pipeline, nothing else; sums = pipeline.
  assert.deepEqual(new Set(d.bySource.map((g) => g.source)), new Set(d.pipeline.map((o) => o.source)));
  assert.equal(s(d.bySource.map((g) => g.revenue)), total);
  assert.equal(s(d.bySource.map((g) => g.count)), d.pipeline.length);
  for (const g of d.bySource) assert.equal(g.revenue, s(d.pipeline.filter((o) => o.source === g.source).map((o) => o.revenue)), g.source);
  // By status: the four statuses, sums = pipeline, counts = KPIs.
  assert.deepEqual(d.byStatus.map((g) => g.status), ['analysis', 'ready', 'inProgress', 'planned']);
  assert.equal(s(d.byStatus.map((g) => g.revenue)), total);
  assert.equal(s(d.byStatus.map((g) => g.count)), d.kpis.potentialRevenue.active);
  assert.equal(d.byStatus.find((g) => g.status === 'ready').count, d.kpis.readyToApprove.value);
  assert.equal(d.byStatus.find((g) => g.status === 'inProgress').count, d.kpis.inProgress.value);
  // 30-day series: start at the previous period's value, end at today's KPI (so the curve and the variation agree).
  assert.equal(d.history.dates.length, 30);
  assert.equal(d.history.dates[29], '2026-09-26');
  assert.deepEqual([d.history.potentialRevenue[0], d.history.potentialRevenue[29]], [d.kpis.potentialRevenue.previous, total]);
  assert.deepEqual([d.history.priority[0], d.history.priority[29]], [d.kpis.priority.previous, d.kpis.priority.value]);
  assert.ok(d.history.priority.every((v) => Number.isInteger(v) && v >= 0));
  for (const k of ['readyToApprove', 'inProgress']) {
    assert.equal(d.history[k].length, 30, k);
    assert.deepEqual([d.history[k][0], d.history[k][29]], [d.kpis[k].previous, d.kpis[k].value], k);
    assert.ok(d.history[k].every((v) => Number.isInteger(v) && v >= 0), k);
  }
});
