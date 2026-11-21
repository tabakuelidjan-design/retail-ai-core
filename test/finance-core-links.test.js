// Finance's Core menu and "← Accueil Nordla" build their addresses from the Nordla home address the server gives
// (NORDLA_HOME_URL, read once at start and returned by GET /api/session). No legacy Sourcing address may be written in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(path.join(root, 'src/finance/ui/app.js'), 'utf8');
const server = readFileSync(path.join(root, 'src/finance/server/index.js'), 'utf8');
const app = readFileSync(path.join(root, 'src/finance/server/app.js'), 'utf8');

test('Finance UI writes no legacy Sourcing address: every Core link is relative to the Nordla home address', () => {
  assert.doesNotMatch(ui, /sourcing-staging/, 'no hardcoded legacy host in the Finance UI');
  assert.match(ui, /function coreUrl\(path\) \{ return state\.nordlaHome \? new URL\(path, state\.nordlaHome\)\.href : path; \}/);
  assert.match(ui, /state\.nordlaHome \? h\('a', \{ class: 'back-nordla', href: state\.nordlaHome/, '"← Accueil Nordla" goes to the Nordla home address');
});

test('Core menu destinations: the dashboard opens Core, Sourcing uses /sourcing, Stock & Achats its own route', () => {
  assert.match(ui, /\{ label: 'Tableau de bord', path: '\/', icon: 'grid'/);
  assert.match(ui, /\{ label: 'Sourcing', path: '\/sourcing', icon: 'globe'/);
  assert.match(ui, /\{ label: 'Stock & Achats', path: '\/procurement', icon: 'box'/);
  assert.match(ui, /\{ label: 'Paramètres', path: '\/settings', icon: 'gear'/, 'Core settings stays Nordla\'s module');
});

test('Finance\'s own horizontal menu has no Settings entry (Nordla has its own Settings module)', () => {
  const nav = ui.match(/const NAV = \[([\s\S]*?)\];/)[1];
  assert.doesNotMatch(nav, /#\/settings/);
});

test('the server gives the home address only as a clean https origin, from NORDLA_HOME_URL', () => {
  assert.match(server, /new URL\(String\(env\.NORDLA_HOME_URL \?\? ''\)\.trim\(\)\)/);
  assert.match(server, /u\.protocol === 'https:' && !u\.username && !u\.password \? u\.origin : null/);
  assert.match(app, /\.\.\.\(deps\.homeUrl \? \{ nordlaHome: deps\.homeUrl \} : \{\}\)/);
});
