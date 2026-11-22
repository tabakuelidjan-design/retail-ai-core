import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

test('Core mounts Finance in its central workspace: no iframe, no new window, the Core address and navigation stay', async () => {
  const app = await read('../src/sourcing/ui/app.js');
  const start = app.indexOf('async function openFinance()');
  const end = app.indexOf('function openMenu()', start);
  assert.ok(start >= 0 && end > start, 'in-page Finance renderer exists');
  const screen = app.slice(start, end);
  assert.match(screen, /nx-home-side/);
  assert.match(screen, /nx-h-top/);
  // no iframe anywhere in the Finance path of Core
  assert.doesNotMatch(screen, /<iframe|createElement\('iframe'\)|\.src = /);
  assert.doesNotMatch(app.slice(0, start) + app.slice(end), /nx-finance-frame/);
  // the Finance UI is mounted into a Shadow DOM root of this document, with Finance\'s own API prefix
  assert.match(screen, /host\.attachShadow\(\{ mode: 'open' \}\)/);
  assert.match(screen, /window\.__nordlaFinanceEmbed\(host\.attachShadow/);
  assert.match(screen, /apiBase: '\/finance\/'/);
  // the module session is opened in the background, same origin, with the target checked first
  assert.match(screen, /target\.origin !== window\.location\.origin/);
  assert.match(screen, /startsWith\('\/finance\/sso'\)/);
  assert.doesNotMatch(screen, /window\.open|target="_blank"|window\.location\.assign|window\.location\.href\s*=/);
  assert.match(app, /document\.addEventListener\('nordla:finance', \(\) => openFinance\(\)\)/);
});

test('Core loads the Finance UI as one same-origin script (no inline script, no eval)', async () => {
  const app = await read('../src/sourcing/ui/app.js');
  assert.match(app, /s\.src = '\/finance\/finance-embed\.js'/);
  assert.doesNotMatch(app, /innerHTML = '<script|eval\(|new Function\(/);
});

test('the generated Finance embed is up to date with its sources and has no eval, no iframe, no inline script', async () => {
  const build = fileURLToPath(new URL('../tools/build-finance-embed.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [build, '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
  const embed = await read('../src/finance-embed/finance-embed.js');
  assert.doesNotMatch(embed, /\beval\(|new Function\(/);
  assert.doesNotMatch(embed, /createElement\(['"]iframe['"]\)/, 'the Finance UI creates no iframe of its own');
  assert.match(embed, /window\.__nordlaFinanceEmbed = function \(shadowRoot, options\)/);
});

test('Finance returns to the top-level Core page when embedded', async () => {
  const finance = await read('../src/finance/ui/app.js');
  assert.match(finance, /window\.top\.location\.assign\(state\.nordlaHome\)/);
  assert.match(finance, /class: 'back-nordla', href: state\.nordlaHome, target: '_top'/);
});

test('Finance calls its own API through the module prefix, never a root API path', async () => {
  const finance = await read('../src/finance/ui/app.js');
  assert.match(finance, /const FIN_API_BASE = typeof finApiBase === 'string' \? finApiBase : ''/);
  assert.match(finance, /fetch\(FIN_API_BASE \+ path,/);
  const roots = [...(await read('../src/finance/ui/app.js')).matchAll(/fetch\(['"`]\/api\//g)];
  assert.equal(roots.length, 0, 'no fetch to a root /api path');
});
