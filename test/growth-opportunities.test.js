import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { buildDemoOpportunities } from '../src/growth/server/demo-opportunities.js';
import { buildDemoOverview } from '../src/growth/server/demo-overview.js';

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

// ---------- a real render of the Growth UI in a minimal DOM (router, sidebar, both pages) ----------
class Node { constructor(tag) { this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.children = []; this.attrs = {}; this.className = ''; this.style = { cssText: '' }; this.listeners = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
  append(...c) { this.children.push(...c); } appendChild(c) { this.children.push(c); return c; } replaceChildren(...c) { this.children = c; }
  addEventListener(e, f) { (this.listeners[e] ||= []).push(f); } replaceWith() {} }
const text = (n) => (n.nodeType === 3 ? n.data : (n.children || []).map(text).join(''));
const all = (n, pred, out = []) => { if (n.nodeType === 1) { if (pred(n)) out.push(n); n.children.forEach((c) => all(c, pred, out)); } return out; };
const hasClass = (n, c) => ` ${n.className} `.includes(` ${c} `);

async function growthDom(hash) {
  const root = new Node('div');
  const errors = [];
  const listeners = {};
  const doc = { createElement: (t) => new Node(t), createElementNS: (_, t) => new Node(t), createTextNode: (s) => ({ nodeType: 3, data: s }), getElementById: () => root, documentElement: { lang: '' } };
  const payloads = { '/api/growth/overview': buildDemoOverview(NOW), '/api/growth/opportunities': buildDemoOpportunities(NOW) };
  const el = () => new Node('div');
  const ctx = {
    document: doc, location: { hash }, console: { error: (...a) => errors.push(a.join(' ')), log() {} },
    localStorage: { getItem: () => 'fr', setItem() {} }, Intl, Math, Date, JSON, Object, Array, Set, Number, String, Error, Promise, setTimeout,
    fetch: async (u) => ({ ok: true, json: async () => JSON.parse(JSON.stringify(payloads[u])) }),
    NordlaIcon: { semantic: (n) => Object.assign(new Node('img'), { className: `nordla-icon official ${n}` }), parle: () => new Node('img') },
    NordlaCharts: { head: el, trendLines: el, trendLine: el, sparkline: el, insufficient: el },
  };
  ctx.window = ctx; ctx.window.addEventListener = (e, f) => { listeners[e] = f; }; ctx.window.scrollTo = () => {};
  vm.createContext(ctx);
  for (const f of [new URL('i18n.js', ANALYTICS_UI), new URL('lang-fr.js', UI), new URL('lang-nl.js', UI), new URL('lang-en.js', UI), new URL('opportunities.js', UI), new URL('app.js', UI)]) vm.runInContext(await readFile(f, 'utf8'), ctx, { filename: f.pathname });
  await new Promise((r) => setTimeout(r, 20));
  const navigate = async (h) => { ctx.location.hash = h; await listeners.hashchange(); };
  return { root, errors, navigate, ctx };
}
const navState = (root) => all(root, (n) => hasClass(n, 'nav-item')).map((n) => ({ label: text(n), active: hasClass(n, 'active'), href: n.getAttribute('href'), inert: hasClass(n, 'inert') }));
const title = (root) => text(all(root, (n) => hasClass(n, 'ex-title'))[0]);

test('opportunities UI: renders without error, sidebar marks Opportunités active, and Vue d\'ensemble leads back to the Overview', async () => {
  const { root, errors, navigate } = await growthDom('#/opportunities');
  assert.deepEqual(errors, []);
  assert.equal(title(root), 'Opportunités');
  const nav = navState(root);
  assert.deepEqual(nav.map((n) => n.label), ['Vue d’ensemble', 'Opportunités', 'Campagnes', 'Contenu', 'Croissance magasin', 'Audience', 'Expériences', 'Nordla AI', 'Paramètres']);
  assert.deepEqual(nav.filter((n) => n.active).map((n) => n.label), ['Opportunités']);
  assert.deepEqual(nav.filter((n) => n.href).map((n) => [n.label, n.href]), [['Vue d’ensemble', '#/'], ['Opportunités', '#/opportunities']]);
  assert.equal(nav.filter((n) => n.inert).length, 7, 'the 5 unbuilt pages + Nordla AI + Paramètres stay disabled');
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

test('growth: no Finance, Analytics or shared file differs from the validated Growth Overview commit', () => {
  const out = execFileSync('git', ['diff', '--name-only', 'e7c96c2', '--', 'src/finance', 'src/analytics-premium', 'src/shared'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(out.trim(), '');
});
