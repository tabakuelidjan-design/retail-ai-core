// Nordla Core home, commercial layout: the sales indicators come only from the server's sales figures (never invented, never a zero when
// the source is missing), the average basket follows Nordla's definition, the connections show the states the server returned, and the
// example figures appear only in the demonstration (?demo=1) with a DÉMO tag and the banner. Pure rendering tests: no DOM, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeCards, nordlaHomeHtml, salesModel, connectionRows, NO_DATA } from '../src/sourcing/ui/screens/nordla-home.js';
import { DEMO_BANNER, DEMO_SALES } from '../src/sourcing/ui/screens/nordla-demo.js';

const SERVER = [
  { key: 'core', label: 'Nordla Core', state: 'DISPONIBLE', detail: '' },
  { key: 'finance', label: 'Finance', state: 'LECTURE SEULE', detail: 'x', dashboard: true },
  { key: 'growth', label: 'Développement des ventes', state: 'DISPONIBLE', detail: 'x' },
  { key: 'creative', label: 'Création', state: 'LIMITÉ', detail: 'x' },
];
const LIVE_SALES = {
  status: 'AVAILABLE', source: 'Analytics · test', currency: 'EUR',
  values: [{ key: 'net_sales_ex_tax', value: 1000 }, { key: 'order_count', value: 4 }],
  comparison: { rows: [{ key: 'net_sales_ex_tax', delta_pct: 0.1 }] },
  weekly: [{ week_start: '2026-10-05', net_sales_ex_tax: 400, order_count: 2 }, { week_start: '2026-10-12', net_sales_ex_tax: 600, order_count: 2 }],
  channels: [{ label: 'Boutique en ligne', values: [{ key: 'net_sales_ex_tax', value: 750 }] }, { label: 'Magasin', values: [{ key: 'net_sales_ex_tax', value: 250 }] }, { label: 'Vide', values: [{ key: 'net_sales_ex_tax', value: 0 }] }],
};
const FORBIDDEN = ['Dépenses IA', 'Utilisation des modèles', 'Tâches en cours', 'Actions validées', 'Mes modules', 'Sécurité', 'Guardian', 'Temps moyen'];

test('menu labels: Croissance and Création, Sourcing last, no unbuilt module', () => {
  const cards = homeCards(SERVER);
  const label = (k) => cards.find((c) => c.key === k).label;
  assert.equal(label('growth'), 'Croissance');
  assert.equal(label('creative'), 'Création');
  assert.ok(cards.findIndex((c) => c.key === 'sourcing') < cards.findIndex((c) => c.key === 'growth'), 'Sourcing before Croissance, as in the Menu principal');
  assert.ok(!cards.some((c) => c.key === 'core'));
});

test('sales model: basket is net sales over orders (Nordla definition), shares add up, empty channels are dropped', () => {
  const m = salesModel(LIVE_SALES);
  assert.equal(m.available, true);
  assert.equal(m.net, 1000);
  assert.equal(m.orders, 4);
  assert.equal(m.basket, 250);
  assert.equal(m.deltas.net, 0.1);
  assert.equal(m.deltas.basket, null, 'no comparison row = no delta invented');
  assert.equal(m.channels.length, 2);
  assert.ok(Math.abs(m.channels.reduce((s, c) => s + c.share, 0) - 1) < 1e-9);
  assert.equal(m.weekly.length, 2);
  assert.equal(m.weekly[1].basket, 300);
});

test('sales model: anything but a confirmed AVAILABLE answer gives no figure at all', () => {
  for (const s of [null, undefined, { status: 'RESERVED' }, { status: 'NOT_CONNECTED' }, { status: 'UNAVAILABLE' }]) assert.equal(salesModel(s).available, false);
});

test('production, no source: every commercial card says Données indisponibles, and no euro or count is drawn', () => {
  const html = nordlaHomeHtml({ modules: SERVER, decisions: [], sales: { status: 'UNAVAILABLE' }, connections: 'UNAVAILABLE' });
  for (const title of ['Ventes', 'Commandes', 'Panier moyen', 'Évolution des ventes', 'Répartition des ventes']) assert.ok(html.includes(title), title);
  assert.ok(html.includes(NO_DATA));
  assert.ok(!/\d\s?€|\d\s?%/.test(html), 'no figure without a source');
  assert.ok(!html.includes('nx-h-spark') || !/<span style="height:\d+%"><\/span>/.test(html.split('nx-h-spark')[1] ?? ''), 'no bar without a source');
});

test('production, loading: sales not answered yet say Chargement, never a zero', () => {
  const html = nordlaHomeHtml({ modules: SERVER, decisions: [], sales: null, connections: null });
  assert.ok(html.includes('Chargement'));
  assert.ok(!/nx-h-kpi-v[^>]*>0</.test(html));
});

test('production, live sales: the figures shown are the server\'s, formatted in euros, with the source named', () => {
  const html = nordlaHomeHtml({ modules: SERVER, decisions: [], sales: LIVE_SALES, connections: null });
  assert.ok(/1\s000\s€/.test(html), 'ventes');
  assert.ok(/250,00\s€/.test(html), 'panier moyen = 1000 / 4');
  assert.ok(html.includes('>4<'), 'commandes');
  assert.ok(html.includes('Analytics · test'));
  assert.ok(!html.includes('DÉMO'), 'no demo tag in production');
  assert.ok(!html.includes('Affichage de démonstration'), 'no demo banner in production');
});

test('production: the commercial layout keeps the four Core functions and drops the AI panels', () => {
  const html = nordlaHomeHtml({ modules: SERVER, decisions: [], sales: LIVE_SALES, connections: [] });
  for (const t of ['À traiter pour vous', 'Parle à Nordla', 'Connexions', 'Activité récente', 'Nordla Core', 'Tableau de bord']) assert.ok(html.includes(t), t);
  for (const f of FORBIDDEN) assert.ok(!html.includes(f), f);
  assert.ok(html.includes('data-act="nx-home-ask"'));
  assert.ok(html.includes('Lecture seule'));
});

test('connections: the four providers, with the state the server returned (never a generic label)', () => {
  const overview = { categories: [{ providers: [
    { id: 'shopify', label: 'Shopify', statusLabel: 'Disponible', connections: [{ state: 'VERIFIED' }] },
    { id: 'instagram', label: 'Instagram', statusLabel: 'Disponible', connections: [] },
    { id: 'tiktok', label: 'TikTok', statusLabel: 'Bientôt disponible', connections: [] },
  ] }] };
  const rows = connectionRows(overview);
  assert.deepEqual(rows.map((r) => r.id), ['shopify', 'instagram', 'tiktok', 'google_business_profile']);
  assert.equal(rows[0].statusLabel, 'Connecté');
  assert.equal(rows[1].statusLabel, 'Disponible');
  assert.equal(rows[3].statusLabel, 'Statut non disponible', 'absent from the answer: said, not invented');
  assert.equal(connectionRows(null), null);
});

test('connections: a failed overview says so in the panel', () => {
  const html = nordlaHomeHtml({ modules: SERVER, decisions: [], sales: LIVE_SALES, connections: 'UNAVAILABLE' });
  assert.ok(html.includes('état des connexions ne répond pas'));
});

test('to-do: only the pending validations of the journal, with a link to the screen', () => {
  const decisions = [
    { id: 1, recommendation: { kind: 'BUY' }, subject: { title: 'Gourde' }, created_at: '2026-11-01T10:00:00Z' },
    { id: 2, recommendation: { kind: 'BUY' }, human_decision: { decision: 'APPROVED' }, subject: { title: 'Autre' }, created_at: '2026-11-02T10:00:00Z' },
  ];
  const html = nordlaHomeHtml({ modules: SERVER, decisions, sales: LIVE_SALES, connections: [] });
  assert.ok(html.includes('Gourde'));
  assert.ok(html.includes('Ouvrir les validations'));
  const none = nordlaHomeHtml({ modules: SERVER, decisions: [], sales: LIVE_SALES, connections: [] });
  assert.ok(none.includes('Aucune validation en attente'));
});

test('demonstration: example figures only with ?demo=1, each card tagged DÉMO, with the banner', () => {
  const html = nordlaHomeHtml({ demo: true });
  assert.ok(html.includes(DEMO_BANNER));
  assert.ok(html.includes('Affichage de démonstration : valeurs d’exemple, non réelles.'));
  assert.ok(/12\s450,00\s€/.test(html) || /12\s450\s€/.test(html), 'example sales');
  assert.ok(/144,77\s€/.test(html), 'example basket');
  assert.ok(!html.includes('DÉMO'), 'no DÉMO badge or caption (removed on request)');
  for (const f of FORBIDDEN) assert.ok(!html.includes(f), f);
});

test('demonstration figures are internally consistent: 86 orders, weekly series sums to the sales, channel shares 62/28/10', () => {
  assert.equal(DEMO_SALES.values.find((v) => v.key === 'order_count').value, 86);
  const weekly = DEMO_SALES.weekly.reduce((s, w) => s + w.net_sales_ex_tax, 0);
  assert.equal(weekly, 12450);
  assert.equal(DEMO_SALES.weekly.reduce((s, w) => s + w.order_count, 0), 86);
  const m = salesModel(DEMO_SALES);
  assert.deepEqual(m.channels.map((c) => Math.round(c.share * 100)), [62, 28, 10]);
});

test('offline: no server figure is asked for or drawn, Sourcing stays reachable', () => {
  const html = nordlaHomeHtml({ modules: null, online: false, sales: null });
  assert.ok(html.includes('Hors connexion'));
  assert.ok(html.includes('data-act="sl-nav"'));
});
