// Core mobile layout (static checks of the shipped CSS and markup): the menu's Tableau de bord is a real link, the Parle cards and
// buttons wrap without cutting words, and the card grid steps down on narrow screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

test('Tableau de bord in the Core menu is a real same-origin link (same tab), in Finance and Parle pages', async () => {
  const app = await read('../src/sourcing/ui/app.js');
  assert.match(app, /function homeAsLink\(li\)/);
  assert.match(app, /a\.href = '\/'/, 'the link goes to the Core home on the same origin');
  assert.doesNotMatch(app, /home\.dataset\.act = 'close-overlay'/, 'no fake button left for Tableau de bord');
  assert.equal((app.match(/homeAsLink\(aside\.querySelector\('ul > li'\)\)/g) || []).length, 2, 'used by the Finance and the Parle pages');
});

test('Parle à Nordla: words are never cut in the middle; the send button wraps its text', async () => {
  const ask = await read('../src/sourcing/ui/nordla-ask.js');
  assert.match(ask, /\.nxa\{max-width:100%;overflow-wrap:break-word;word-break:normal\}/);
  assert.doesNotMatch(ask, /\.nxa\{[^}]*overflow-wrap:anywhere/, 'the page root does not break words that fit');
  assert.match(ask, /\.nxa-card-txt\{[^}]*overflow-wrap:break-word;word-break:normal/);
  const send = /\.nxa-send\{[^}]*\}/.exec(ask)?.[0] ?? '';
  assert.match(send, /white-space:normal/, 'the button text can wrap');
  assert.doesNotMatch(send, /white-space:nowrap/);
});

test('Parle cards: one column on phones (≤480 px), two on tablets (≤760 px), three on desktop', async () => {
  const ask = await read('../src/sourcing/ui/nordla-ask.js');
  assert.match(ask, /\.nxa-cards\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(ask, /@media \(max-width:760px\)\{\.nxa-cards\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
  assert.match(ask, /@media \(max-width:480px\)\{\.nxa-cards\{grid-template-columns:1fr\}/);
});

test('the mobile ☰ opens and closes the drawer of the page the button is in (Finance and Parle copies included)', async () => {
  const panel = await read('../src/sourcing/ui/modules-panel.js');
  assert.match(panel, /if \(a === 'nx-menu'\) \{ \(t\.closest\('\.nx-home'\) \?\? document\.querySelector\('\.nx-home'\)\)\?\.classList\.toggle\('nx-menu-open'\); return; \}/);
  assert.match(panel, /if \(a === 'nx-open-finance'\) \{ \(t\.closest\('\.nx-home'\)/);
  assert.match(panel, /if \(a === 'nx-open-parle'\) \{ \(t\.closest\('\.nx-home'\)/);
  assert.doesNotMatch(panel, /document\.querySelector\('\.nx-home'\)\?\.classList\.toggle\('nx-menu-open'\)/);
});
