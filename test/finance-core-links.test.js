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

test('Finance UI writes no legacy Sourcing address: the Core menu and "← Accueil Nordla" use the Nordla home address', () => {
  assert.doesNotMatch(ui, /sourcing-staging/, 'no hardcoded legacy host in the Finance UI');
  assert.ok(ui.includes("window.NordlaCoreRail.create({ current: 'finance', base: state.nordlaHome })"), 'the Core menu is the shared frame, based on the Nordla home address');
  assert.ok(ui.includes("state.nordlaHome ? h('a', { class: 'back-nordla', href: state.nordlaHome"), '"← Accueil Nordla" goes to the Nordla home address');
});

test('Finance uses the shared Core frame and still works without it', () => {
  assert.ok(ui.includes("const rail = coreRail();"));
  assert.ok(ui.includes("h('div', { class: rail ? 'shell nordla-frame' : 'shell' }, rail,"));
  assert.ok(ui.includes('return window.NordlaCoreRail ? window.NordlaCoreRail.toggle() : null;'));
  const html = readFileSync(path.join(root, 'src/finance/ui/index.html'), 'utf8');
  assert.ok(html.includes('<script src="/nordla-core-rail.js" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="/nordla-core-rail.css">'));
  const css = readFileSync(path.join(root, 'src/finance/ui/style.css'), 'utf8');
  assert.ok(!css.includes('.corerail {'), 'the rail styles live in the shared frame, not in Finance');
});

test('Core menu destinations (the shared frame): Core home, Parle, Analyses and Finance open their action; Stock & Achats and Sourcing their route', () => {
  const shared = readFileSync(path.join(root, 'src/shared/nordla-core-rail.js'), 'utf8');
  assert.ok(shared.includes("{ key: 'dashboard', label: 'Tableau de bord', path: '/'"));
  assert.ok(shared.includes("{ key: 'parle', label: 'Parle à Nordla', path: '/?ouvrir=parle'"));
  assert.ok(shared.includes("{ key: 'analytics', label: 'Analyses', path: '/?ouvrir=analyses'"));
  assert.ok(shared.includes("{ key: 'procurement', label: 'Stock & Achats', path: '/procurement/'"));
  assert.ok(shared.includes("{ key: 'sourcing', label: 'Sourcing', path: '/sourcing'"));
  assert.ok(shared.includes("{ key: 'settings', label: 'Paramètres', path: '/settings'"), "Core settings stays Nordla's module");
});

test("Finance's own horizontal menu has no Settings entry (Nordla has its own Settings module)", () => {
  const nav = ui.match(/const NAV = \[([\s\S]*?)\];/)[1];
  assert.doesNotMatch(nav, /#\/settings/);
});

test('the server gives the home address only as a clean https origin, from NORDLA_HOME_URL', () => {
  assert.match(server, /new URL\(String\(env\.NORDLA_HOME_URL \?\? ''\)\.trim\(\)\)/);
  assert.match(server, /u\.protocol === 'https:' && !u\.username && !u\.password \? u\.origin : null/);
  assert.match(app, /\.\.\.\(deps\.homeUrl \? \{ nordlaHome: deps\.homeUrl \} : \{\}\)/);
});
