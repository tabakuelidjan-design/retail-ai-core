// Growth - proofs for the correction of the three former demonstration pages (Vue d'ensemble, Opportunités, Campagnes):
//   1. no demonstration figure is presented as real: every number Vue d'ensemble / Opportunités receive has a named source
//      (Campagnes' own dataset, badged "démo", or the real store sales); everything else is "Source non connectée" - never 0,
//      never a former demo value;
//   2. one campaign counter: Campagnes is the only source; Vue d'ensemble shows exactly its "En cours" count;
//   3. no store footfall / visitors / conversion without a source;
//   4. design unchanged: same cards, same classes, same order, same titles as the connected rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview } from '../src/growth/server/overview.js';
import { buildOpportunities } from '../src/growth/server/opportunities.js';
import { buildDemoCampaigns } from '../src/growth/server/demo-campaigns.js';
import { buildDemoOverview } from './fixtures/growth-overview-sample.js';
import { buildDemoOpportunities } from './fixtures/growth-opportunities-sample.js';
import { growthDom, overviewPayload, all, text, hasClass, NOW } from './growth-dom.js';

/** Every numeric leaf of a payload, with its path (a.b[2].c -> 'a.b[].c'). */
function numbers(v, p = '', out = []) {
  if (typeof v === 'number') out.push([p, v]);
  else if (Array.isArray(v)) v.forEach((x) => numbers(x, `${p}[]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) numbers(x, p ? `${p}.${k}` : k, out);
  return out;
}
/** Text of the page content only (KPI row + card grids), without the shell (sidebar, period pill). */
const cardsText = (root) => all(root, (n) => ['ex-kpi-row', 'gr-grid', 'gr-grid-pipe', 'ex-grid-2'].some((c) => hasClass(n, c))).map(text).join(' ');
const kpiTile = (root, label) => all(root, (n) => hasClass(n, 'ex-kpi')).find((k) => text(k).includes(label));
const kpiValue = (tile) => text(all(tile, (n) => hasClass(n, 'ex-kpi-value'))[0]);

test('proof 1 - Vue d\'ensemble payload: every number comes from Campagnes (and equals it); nothing else carries a figure', () => {
  const d = buildOverview(NOW);
  const camp = buildDemoCampaigns(NOW);
  const running = camp.campaigns.filter((c) => c.status === 'running');
  const FROM_CAMPAIGNS = /^(kpis\.activeCampaigns\.(value|performingWell)|kpis\.roas\.(value|deltaPct)|channels\[\]\.(revenue|roas)|campaigns\[\]\.(spend|budget|roas|newCustomers))$/;
  for (const [p] of numbers(d)) assert.match(p, FROM_CAMPAIGNS, `figure without a Campagnes source: ${p}`);
  // ... and those figures ARE Campagnes' figures.
  assert.equal(d.sources.campaigns, 'demo');
  assert.equal(d.kpis.roas.value, camp.kpis.roas.value);
  assert.deepEqual(d.channels.map((c) => [c.id, c.revenue, c.roas]), camp.channels.map((c) => [c.id, c.revenue, c.roas]));
  for (const c of d.campaigns) {
    const r = running.find((x) => x.id === c.id);
    assert.ok(r, `${c.id} is a running campaign of Campagnes`);
    assert.deepEqual([c.name, c.spend, c.budget, c.newCustomers], [r.title, r.spend, r.budget, r.newCustomers]);
  }
  // Unavailable = null (never 0, never a former demo value).
  for (const k of ['revenueInfluenced', 'activeOpportunities', 'experimentsRunning']) assert.equal(d.kpis[k], null, k);
  for (const k of ['pulse', 'insights', 'attention', 'content', 'opportunities', 'experiments']) assert.equal(d[k], null, k);
  for (const c of d.channels) assert.deepEqual([c.reach, c.reachKind, c.conversion], [null, null, null], c.id);
});

test('proof 1 - Opportunités payload carries no figure at all', () => {
  const d = buildOpportunities(NOW);
  assert.equal(d.connected, false);
  assert.deepEqual(numbers(d), []);
});

test('proof 1 - no former demo value is displayed on Vue d\'ensemble or Opportunités (FR / NL / EN)', async () => {
  const sample = buildDemoOverview(NOW); const opp = buildDemoOpportunities(NOW);
  const fmt = (lang, v) => new Intl.NumberFormat({ fr: 'fr-BE', nl: 'nl-BE', en: 'en-GB' }[lang], { maximumFractionDigits: 0 }).format(v);
  for (const lang of ['fr', 'nl', 'en']) {
    const ov = text((await growthDom('#/', { lang })).root);
    const op = cardsText((await growthDom('#/opportunities', { lang })).root);
    const demoTexts = [...sample.insights, ...sample.attention, ...sample.opportunities, ...sample.content].map((x) => x.title[lang]);
    for (const s of demoTexts) assert.ok(!ov.includes(s), `${lang} overview shows demo text: ${s}`);
    for (const s of [...opp.pipeline.map((o) => o.title[lang]), ...opp.segments.map((s) => s.label[lang]), ...opp.wins.map((w) => w.title[lang]), ...opp.recommendations.map((r) => r.title[lang])]) assert.ok(!op.includes(s), `${lang} opportunities shows demo text: ${s}`);
    for (const v of [sample.kpis.revenueInfluenced.value, sample.pulse.totals.totalRevenue, opp.kpis.potentialRevenue.value, opp.kpis.winsThisMonth.revenue]) {
      assert.ok(!ov.includes(fmt(lang, v)) && !op.includes(fmt(lang, v)), `${lang}: former demo amount ${v} displayed`);
    }
    assert.doesNotMatch(op, /\d/u, `${lang}: Opportunités shows no figure at all`);
  }
});

test('proof 1 - every figure without a source reads "—" + "Source non connectée" on Vue d\'ensemble, never 0', async () => {
  const { root, errors } = await growthDom('#/');
  assert.deepEqual(errors, []);
  for (const label of ['CA influencé', 'Opportunités actives']) {
    const tile = kpiTile(root, label);
    assert.ok(tile, label);
    assert.equal(kpiValue(tile), '—', label);
    assert.match(text(tile), /Source non connectée/u, label);
  }
  for (const c of ['gr-ai', 'gr-att', 'gr-content', 'gr-opps']) assert.match(text(all(root, (n) => hasClass(n, 'ex-card') && hasClass(n, c))[0]), /Source non connectée/u, c);
  // Growth Pulse: its honest state is drawn by NordlaCharts.insufficient (stubbed here) -> checked in the real browser test.
  // Channel table: revenue / ROAS from Campagnes (chip says so), reach / conversion "—".
  const ch = all(root, (n) => hasClass(n, 'ex-card') && hasClass(n, 'gr-channels'))[0];
  assert.ok(ch, 'channel card');
  assert.match(text(ch), /Source : Campagnes \(démo\)/u);
  for (const tr of all(ch, (n) => n.tagName === 'TR' && n.children[0]?.tagName === 'TD')) {
    assert.equal(text(tr.children[2]), '—', 'reach'); assert.equal(text(tr.children[3]), '—', 'conversion');
  }
  // The page keeps its demo badge (Campagnes figures are demonstration data), with a tooltip that says exactly what is what.
  assert.ok(text(root).includes('Données de démonstration'));
});

test('proof 2 - one campaign counter: Vue d\'ensemble KPI = its campaigns card = "En cours" rows on Campagnes = Campagnes dataset', async () => {
  const running = buildDemoCampaigns(NOW).campaigns.filter((c) => c.status === 'running').length;
  const ov = (await growthDom('#/')).root;
  const kpi = Number(kpiValue(kpiTile(ov, 'Campagnes actives')));
  const cardChip = text(all(ov, (n) => hasClass(n, 'gr-camp'))[0] || all(ov, (n) => hasClass(n, 'ex-card') && text(n).includes('actives'))[0]).match(/(\d+) actives/u);
  const cp = (await growthDom('#/campaigns')).root;
  const table = all(cp, (n) => hasClass(n, 'gr-cp-table'))[0];
  const enCours = all(table, (n) => hasClass(n, 'ex-chip') && text(n) === 'En cours').length;
  assert.equal(kpi, running);
  assert.ok(cardChip, 'campaigns card count');
  assert.equal(Number(cardChip[1]), running);
  assert.equal(enCours, running);
  // No other Growth page states a campaign count; the Overview builder keeps no count of its own (derived from Campagnes).
  for (const pg of ['#/opportunities', '#/potential', '#/audience', '#/content', '#/storeGrowth']) assert.doesNotMatch(text((await growthDom(pg)).root), /campagnes? (actives|en cours)/iu, pg);
});

test('proof 3 - no store footfall, visitors or store conversion without a source', async () => {
  const d = buildOverview(NOW);
  assert.deepEqual(d.store, { footfallConnected: false });
  assert.equal(d.sources.footfall, 'notConnected');
  for (const [p] of numbers(d)) assert.doesNotMatch(p, /visit|footfall|traffic|frequent|conversion/i, p);
  for (const real of [{ store: { mode: 'unavailable' } }, { store: { mode: 'noStore' } }, { store: { mode: 'store', net: 1234, change: 0.1, orders: 9, weekly: [1, 2, 3, 4], weeks: 4, currency: 'EUR' } }]) {
    const { root } = await growthDom('#/', { overview: overviewPayload(real) });
    const store = text(all(root, (n) => hasClass(n, 'gr-store'))[0]);
    assert.equal((store.match(/Non connecté/gu) || []).length >= 2, true, `${real.store.mode}: traffic + conversion not connected`);
    assert.doesNotMatch(store.replace(/1\s?234/u, ''), /\b0\b|\d+[,.]\d+\s?%/u, `${real.store.mode}: no 0 / no invented rate`);
  }
  // Pulse "traffic" view: footfall not connected, nothing drawn.
  const { root } = await growthDom('#/');
  const sel = all(all(root, (n) => hasClass(n, 'gr-pulse'))[0], (n) => n.tagName === 'SELECT')[0];
  sel.listeners.change[0]({ target: { value: 'traffic' } });
  const pulse = text(all(root, (n) => hasClass(n, 'gr-pulse'))[0]);
  assert.doesNotMatch(pulse.replace(/\d+ jours|30/gu, ''), /\d/u, 'no visitor figure');
  sel.listeners.change[0]({ target: { value: 'revenue' } });
});

/** Card skeleton of a page: [grid classes, [card classes, card title]] in DOM order. */
function skeleton(root) {
  const grids = all(root, (n) => ['ex-kpi-row', 'gr-grid', 'gr-grid-pipe', 'ex-grid-2'].some((c) => hasClass(n, c)));
  return grids.map((g) => [g.className, all(g, (n) => hasClass(n, 'ex-card') || hasClass(n, 'ex-kpi')).map((c) => [c.className, text(all(c, (n) => hasClass(n, 'gr-card-title') || hasClass(n, 'ex-kpi-label'))[0] || { children: [] })])]);
}

test('proof 4 - design unchanged: same cards, classes, order and titles as the connected rendering (Vue d\'ensemble, Opportunités)', async () => {
  const connectedOv = skeleton((await growthDom('#/', { overview: { ...buildDemoOverview(NOW), real: { store: { mode: 'unavailable' } } } })).root);
  const honestOv = skeleton((await growthDom('#/')).root);
  assert.deepEqual(honestOv, connectedOv);
  const connectedOp = skeleton((await growthDom('#/opportunities', { opportunities: buildDemoOpportunities(NOW) })).root);
  const honestOp = skeleton((await growthDom('#/opportunities')).root);
  assert.deepEqual(honestOp, connectedOp);
});
