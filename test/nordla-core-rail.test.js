// The shared Nordla Core frame (src/shared/nordla-core-rail.*): one menu for every rebuilt module, real destinations only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readNordlaShared } from '../src/shared/nordla-static.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const rail = read('src/shared/nordla-core-rail.js');
const railCss = read('src/shared/nordla-core-rail.css');
const procIndex = read('src/procurement/ui/index.html');
const procCss = read('src/procurement/ui/app.css');
const sourcingApp = read('src/sourcing/server/app.js');
const coreUi = read('src/sourcing/ui/core-link.js');
const coreApp = read('src/sourcing/ui/app.js');
const modules = read('src/sourcing/ui/modules-panel.js');

const menu = () => {
  const block = rail.match(/var MENU = Object\.freeze\(\[([\s\S]*?)\]\);/)[1];
  return [...block.matchAll(/\{ key: '([^']+)', label: '([^']+)'(?:, path: '([^']*)')?/g)].map((m) => ({ key: m[1], label: m[2], path: m[3] }));
};

test('the shared frame never writes HTML strings into the page (DOM API only) and has no hardcoded legacy host', () => {
  assert.doesNotMatch(rail, /.innerHTMLs*=|insertAdjacentHTML|.outerHTMLs*=/);
  assert.doesNotMatch(rail, /sourcing-staging|localhost|app\.nordla\.app/);
});

test('one Core menu with the Nordla modules, in the existing order; each entry either opens a destination or says it is not available', () => {
  const items = menu();
  assert.deepEqual(items.map((i) => i.label), ['Tableau de bord', 'Parle à Nordla', 'Finance', 'Analyses', 'Stock & Achats', 'Sourcing', 'Développement des ventes', 'Marketing', 'Création', 'Branding', 'Paramètres']);
  assert.equal(new Set(items.map((i) => i.key)).size, items.length, 'keys are unique');
  for (const i of items) if (i.path !== undefined) assert.match(i.path, /^\//, `${i.label} is a path on the Nordla home`);
  assert.equal(items.find((i) => i.label === 'Développement des ventes').path, '/growth/', 'Croissance opens its screen in the Core frame');
  assert.equal(items.find((i) => i.label === 'Branding').path, undefined, 'Branding has no link until its screen is reachable');
  assert.doesNotMatch(rail, /Écran pas encore accessible.*Développement|Développement.*Écran pas encore accessible/);
});

test('Parle à Nordla, Analyses and Finance open their own action on Core, never just the Core home', () => {
  const byLabel = Object.fromEntries(menu().map((i) => [i.label, i.path]));
  assert.equal(byLabel['Parle à Nordla'], '/?ouvrir=parle');
  assert.equal(byLabel['Analyses'], '/?ouvrir=analytics');
  assert.equal(byLabel['Finance'], '/?ouvrir=finance');
  assert.equal(byLabel['Stock & Achats'], '/?ouvrir=procurement'); // Core opens Stock & Achats from the Core menu (25b76501) // Stock is the arrival section from the Core menu
  assert.equal(byLabel['Sourcing'], '/?ouvrir=sourcing'); // Core opens Sourcing in its frame (9ab94dc8)
  assert.equal(byLabel['Paramètres'], '/?ouvrir=settings'); // Core opens the settings sheet in its frame (core-link.js)
});

test('Core opens the requested action from ?ouvrir= with the existing buttons only (no new endpoint, no token)', () => {
  assert.ok(coreApp.includes("import { openFromLink } from './core-link.js';"));
  assert.match(coreApp, /openFromLink\(\);/);
  assert.match(coreUi, /const act = \{ finance: 'nx-open-finance' \}\[want\];/);
  assert.match(modules, /a === 'nx-open-analytics'/);
  assert.match(modules, /a === 'nx-open-finance'/);
  assert.match(coreUi, /if \(want === 'parle'\) \{[^}]*nordla:parle/);
  assert.match(coreUi, /history\.replaceState\(null, '', '\/'\)/, 'the parameter is removed so a reload does not repeat it');
});

test('the frame is served by Core and by Finance from the same shared files', async () => {
  const js = await readNordlaShared('/nordla-core-rail.js');
  const css = await readNordlaShared('/nordla-core-rail.css');
  assert.match(js.body.toString('utf8'), /window\.NordlaCoreRail = \{/);
  assert.equal(js.type, 'text/javascript; charset=utf-8');
  assert.match(css.body.toString('utf8'), /\.corerail \{/);
  assert.equal(css.type, 'text/css; charset=utf-8');
  assert.match(sourcingApp, /url\.pathname === '\/nordla-core-rail\.js' \|\| url\.pathname === '\/nordla-core-rail\.css'/);
});

test('the frame is isolated: its layout is scoped to .nordla-frame and it adds no global rule', () => {
  for (const line of railCss.split('\n').filter((l) => /^[.a-z@]/.test(l.trim()) && !l.trim().startsWith('@'))) {
    assert.match(line, /corerail|nordla-frame|menu-toggle/, `scoped selector: ${line.slice(0, 60)}`);
  }
});

test('Stock & Achats shows the Core menu on a computer (left) and in a drawer on a phone, with its sections in a top bar', () => {
  assert.match(procIndex, /<div class="shell">\s*<div data-nordla-core-rail="procurement"><\/div>\s*<div class="mainarea">/, 'two columns only once the script adds .nordla-frame');
  assert.match(procIndex, /<span data-nordla-core-toggle><\/span>/);
  assert.match(procIndex, /<script src="\/nordla-core-rail\.js" defer><\/script>/);
  assert.match(procIndex, /<link rel="stylesheet" href="\/nordla-core-rail\.css">/);
  assert.match(procCss, /\.tabs\{display:flex;gap:4px;overflow-x:auto/, 'the sections are a horizontal bar, not a bottom bar');
  assert.doesNotMatch(procCss, /\.tabs\{position:fixed/);
});

test('Stock & Achats keeps its sections (top bar) and its Nordla home link', () => {
  for (const id of ['data-tab="visits"', 'data-tab="items"', 'data-tab="compare"', 'data-tab="orders"', 'data-tab="stock"', 'id="nordla-home"']) assert.ok(procIndex.includes(id), id);
});
