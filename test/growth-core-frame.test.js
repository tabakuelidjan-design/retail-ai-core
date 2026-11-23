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
