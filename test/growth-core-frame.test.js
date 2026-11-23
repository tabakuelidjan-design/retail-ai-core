// Croissance inside Nordla (/growth/): the Core rail is Core's own file at the root; Core's endpoints are never sent under the module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteHtmlForPrefix, PREFIX_SHIM_JS } from '../src/shared/nordla-gateway.js';

test('the module page keeps the shared rail files at the Core root and prefixes its own paths', () => {
  const html = '<html><head><link rel="stylesheet" href="/nordla-core-rail.css"><link rel="stylesheet" href="/growth.css"></head><body><script src="/app.js"></script></body></html>';
  const out = rewriteHtmlForPrefix(html, '/growth');
  assert.match(out, /href="\/nordla-core-rail\.css"/);
  assert.match(out, /href="\/growth\/growth\.css"/);
  assert.match(out, /src="\/growth\/app\.js"/);
  assert.doesNotMatch(out, /\/growth\/nordla-core-rail/);
});

test('the browser shim never sends Core endpoints or the rail registry under the module', () => {
  const body = PREFIX_SHIM_JS;
  assert.match(body, /indexOf\('\/api\/core\/'\) !== 0/);
  assert.match(body, /indexOf\('\/nordla-'\) !== 0/);
});

// The Nordla interface never links to Growth's own Railway address; Growth is opened in the same tab, with its two screens.
import { readFileSync } from 'node:fs';
const panel = readFileSync(new URL('../src/sourcing/ui/modules-panel.js', import.meta.url), 'utf8');
const coreHttp = readFileSync(new URL('../src/core-pilot/http.js', import.meta.url), 'utf8');
test('no Growth address leaves Core when the gateway is on: growth_url is null, the two screens open in the same tab', () => {
  assert.match(coreHttp, /growth_url: active\.has\('growth'\) && !String\(env\?\.GROWTH_UPSTREAM_URL \?\? ''\)\.trim\(\) \? growthOrigin\(env\) : null/);
  assert.match(panel, /data-act="nx-open-growth-here" data-to="dropoff">Où les visiteurs abandonnent<\/button>/);
  assert.match(panel, /data-act="nx-open-growth-here" data-to="opportunities">Opportunités<\/button>/);
  assert.doesNotMatch(panel, /up\.railway\.app/);
});
