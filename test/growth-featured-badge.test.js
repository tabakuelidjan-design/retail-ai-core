// The featured offer from Général is shown on the opportunity row (badge): wired in the screen, translated in FR / EN / NL, CSS only (no layout change).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL(`../src/growth/ui/${f}`, import.meta.url), 'utf8');

test('GB-1 the opportunity row carries the featured offer and a translated label; the badge is CSS only', () => {
  const ui = read('opportunities.js');
  assert.match(ui, /featuredOffer: i\.orientation\?\.featuredOffer \?\? null, featuredLabel: i\.orientation \? t\('gr\.op\.featured'\) : null/);
  assert.match(ui, /'data-featured-offer': view\.featuredOffer/);
  for (const l of ['fr', 'en', 'nl']) assert.match(read(`lang-${l}.js`), /'gr\.op\.featured': '[^']+'/, `label in ${l}`);
  assert.match(read('growth.css'), /\.gv-action\[data-featured-offer\]::before \{ content: attr\(data-featured-label\)/);
  assert.doesNotMatch(read('opportunities.js'), /orientation\.featuredOffer\s*\)\s*\.textContent/, 'no unsafe HTML insertion of the offer (attributes only)');
});
