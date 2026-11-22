import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the Core Finance menu action opens an in-page screen, without a window or location navigation', async () => {
  const panel = await read('../src/sourcing/ui/modules-panel.js');
  const start = panel.indexOf("if (a === 'nx-open-finance')");
  const end = panel.indexOf("if (a === 'nx-ask')", start);
  assert.ok(start >= 0 && end > start, 'Finance action block exists');
  const action = panel.slice(start, end);
  assert.match(action, /new CustomEvent\('nordla:finance'\)/);
  assert.doesNotMatch(action, /window\.location|window\.open|api\('\/api\/core\/finance\/open'/);
});

test('Core renders Finance in the central workspace and preserves the Core navigation and address', async () => {
  const app = await read('../src/sourcing/ui/app.js');
  const start = app.indexOf('async function openFinance()');
  const end = app.indexOf('function openMenu()', start);
  assert.ok(start >= 0 && end > start, 'in-page Finance renderer exists');
  const screen = app.slice(start, end);
  assert.match(screen, /nx-home-side/);
  assert.match(screen, /nx-h-top/);
  assert.match(screen, /<iframe class="nx-finance-frame"/);
  assert.match(screen, /target\.origin !== window\.location\.origin/);
  assert.match(screen, /frame\.src = target\.href/);
  assert.doesNotMatch(screen, /window\.location\.assign|window\.location\.href\s*=/);
  assert.match(app, /document\.addEventListener\('nordla:finance', \(\) => openFinance\(\)\)/);
});

test('Finance returns to the top-level Core page when embedded', async () => {
  const finance = await read('../src/finance/ui/app.js');
  assert.match(finance, /window\.top\.location\.assign\(state\.nordlaHome\)/);
  assert.match(finance, /class: 'back-nordla', href: state\.nordlaHome, target: '_top'/);
});
