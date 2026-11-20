// Nordla home (Core entry): cards come only from the server's module list, rights are never invented, Sourcing is a module, the return link is one button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeCards, nordlaHomeHtml, nordlaBackBar, MODULE_COLOURS } from '../src/sourcing/ui/screens/nordla-home.js';

const SERVER = [
  { key: 'core', label: 'Nordla Core', state: 'DISPONIBLE', detail: 'x' },
  { key: 'finance', label: 'Finance', state: 'LECTURE SEULE', detail: 'Factures à payer.', dashboard: true },
  { key: 'analytics', label: 'Analytics', state: 'LECTURE SEULE', detail: 'Ventes.', analytics_url: 'https://a.example', dashboard: true },
  { key: 'procurement', label: 'Stock / Achats', state: 'DISPONIBLE', detail: 'Commandes.' },
  { key: 'sourcing', label: 'Sourcing', state: 'DISPONIBLE', detail: 'Hors ligne.' },
  { key: 'branding', label: 'Branding', state: 'NON RACCORDÉ', detail: 'Aucune règle de marque.' },
  { key: 'marketing', label: 'Marketing', state: 'LIMITÉ', detail: 'Proposition.', video_screen: true, gbp_screen: false },
  { key: 'creative', label: 'Création', state: 'BLOQUÉ', detail: 'Aucun fournisseur.', creator_screen: true },
  { key: 'growth', label: 'Développement des ventes', state: 'DISPONIBLE', detail: 'Opportunités.', growth_url: 'https://growth.example', growth_sso: true },
];

test('cards: Sourcing is a module card, first, with a local action that works offline', () => {
  const cards = homeCards(SERVER, { online: false });
  assert.equal(cards[0].key, 'sourcing');
  assert.deepEqual(cards[0].action, { type: 'local', to: 'sourcing', label: 'Ouvrir China Sourcing' });
  assert.equal(cards.filter((c) => c.action && c.action.type !== 'local').length, 0, 'offline: no server action');
});

test('cards: Core is the home itself, not a card; every other server module is shown with its own state', () => {
  const keys = homeCards(SERVER).map((c) => c.key);
  assert.equal(keys.includes('core'), false);
  for (const m of SERVER.filter((x) => x.key !== 'core' && x.key !== 'sourcing')) assert.ok(keys.includes(m.key), m.key);
  const finance = homeCards(SERVER).find((c) => c.key === 'finance');
  assert.equal(finance.state, 'LECTURE SEULE');
  assert.equal(finance.detail, 'Factures à payer.');
});

test('rights: an action appears only where the server confirms it', () => {
  const byKey = Object.fromEntries(homeCards(SERVER).map((c) => [c.key, c]));
  assert.equal(byKey.finance.action.act, 'nx-open-finance');
  assert.equal(byKey.analytics.action.act, 'nx-open-analytics');
  assert.equal(byKey.procurement.action, null, 'Achats: state only');
  assert.equal(byKey.branding.action, null, 'Brand: state only');
  assert.equal(byKey.creative.action.href, '/creator');
  assert.equal(byKey.marketing.action.href, '/videos');
  assert.equal(byKey.growth.action.act, 'nx-open-growth');
  assert.equal(byKey.growth.action.href, 'https://growth.example/#/dropoff');
});

test('rights: a missing confirmation removes the action, and an unsafe Growth address is refused', () => {
  const cards = homeCards([
    { key: 'finance', label: 'Finance', state: 'NON RACCORDÉ', dashboard: false },
    { key: 'growth', label: 'Growth', state: 'DISPONIBLE', growth_url: 'http://insecure.example', growth_sso: true },
    { key: 'creative', label: 'Création', state: 'BLOQUÉ', creator_screen: false },
  ]);
  for (const c of cards.filter((x) => x.key !== 'sourcing')) assert.equal(c.action, null, c.key);
});

test('no invented module: nothing is shown that the server did not list', () => {
  const keys = new Set(SERVER.map((m) => m.key));
  for (const c of homeCards(SERVER)) assert.ok(keys.has(c.key), c.key);
});

test('colours: each module has its own colour, Sourcing included', () => {
  const colours = homeCards(SERVER).map((c) => c.colour);
  assert.equal(new Set(colours).size, colours.length);
  assert.equal(MODULE_COLOURS.sourcing, homeCards([]).find((c) => c.key === 'sourcing').colour);
});

test('html: escapes server text, renders the states, and never shows a figure of its own', () => {
  const html = nordlaHomeHtml({ modules: [{ key: 'finance', label: 'Finance <b>', state: 'LECTURE SEULE', detail: '<script>x</script>', dashboard: true }], online: true });
  assert.ok(!html.includes('<script>'), 'escaped');
  assert.ok(html.includes('LECTURE SEULE'));
  assert.ok(html.includes('data-act="nx-open-finance"'));
  assert.ok(!/\d+\s?(€|%)/.test(html.replace(/\d{4}/g, '')), 'no figure is invented by the home');
});

test('html: loading and offline say so, and the offline screen keeps Sourcing', () => {
  assert.ok(nordlaHomeHtml({ modules: null, online: true }).includes('Chargement des modules'));
  const off = nordlaHomeHtml({ modules: null, online: false });
  assert.ok(off.includes('Hors connexion'));
  assert.ok(off.includes('data-act="sl-nav"'), 'Sourcing stays reachable offline');
});

test('return link: one button back to the Nordla home', () => {
  assert.ok(nordlaBackBar().includes('data-act="sl-nordla"'));
  assert.ok(nordlaBackBar().includes('← Accueil Nordla'));
});
