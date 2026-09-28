// Développement des ventes - Expériences, Nordla AI and Paramètres are NOT built (owner correction 2026-09-28): they are only disabled
// menu entries. No page file, no page definition (PAGES), no route, no endpoint, no business code; a direct URL shows Vue d'ensemble.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createGrowthApp } from '../src/growth/server/app.js';
import { growthDom, all, hasClass, navState, title } from './growth-dom.js';

const UNBUILT = ['experiments', 'ai', 'settings'];
const BUILT = ['overview', 'opportunities', 'campaigns', 'potential', 'audience', 'content', 'storeGrowth'];
const GROWTH = new URL('../src/growth/', import.meta.url);

test('the 7 built pages are exactly the PAGES definitions; Expériences, Nordla AI and Paramètres have none', async () => {
  const { ctx } = await growthDom('#/');
  assert.deepEqual(vm.runInContext('Object.keys(PAGES)', ctx), BUILT);
  for (const k of UNBUILT) assert.equal(vm.runInContext(`PAGES[${JSON.stringify(k)}]`, ctx), undefined, `${k} has no page definition`);
});

test('no page file, server module or business code exists for Expériences, Nordla AI or Paramètres', () => {
  const files = (d) => readdirSync(new URL(d, GROWTH), { recursive: true }).map(String);
  // The only files that mention them are the menu-entry icons (ui/assets/icons/experiments.png, settings.png): assets, not pages.
  for (const f of [...files('ui/').filter((x) => !/^assets[\\/]/.test(x)), ...files('server/'), ...readdirSync(GROWTH).map(String)]) {
    assert.doesNotMatch(f, /experiment|settings|assistant|nordla-?ai|(^|[\\/])ai\.js$/i, `unexpected ${f}`);
  }
  assert.equal(existsSync(new URL('experiments/', GROWTH)), false);
  const server = readFileSync(new URL('server/app.js', GROWTH), 'utf8');
  assert.doesNotMatch(server, /\/api\/growth\/(experiments|ai|settings)/);
});

test('a direct URL to #/experiments, #/ai or #/settings shows Vue d\'ensemble; the three entries stay disabled (no link)', async () => {
  for (const k of UNBUILT) {
    const { root, errors } = await growthDom(`#/${k}`);
    assert.deepEqual(errors, [], k);
    assert.equal(title(root), 'Développement des ventes', `#/${k} falls back to Vue d'ensemble`);
    const nav = navState(root);
    assert.deepEqual(nav.filter((n) => n.active).map((n) => n.label), ['Vue d’ensemble'], `#/${k}: nothing else is active`);
    const inert = nav.filter((n) => n.inert);
    assert.deepEqual(inert.map((n) => n.label), ['Expériences', 'Nordla AI', 'Paramètres']);
    for (const n of inert) assert.ok(n.href == null, `${n.label} has no link`);
  }
  const { root } = await growthDom('#/');
  const disabled = all(root, (n) => n.attrs && n.attrs['aria-disabled'] === 'true' && /Expériences|Nordla AI|Paramètres/.test(String(n.attrs.title ?? '') + JSON.stringify(n.children.map((c) => c.data ?? ''))));
  assert.ok(disabled.length >= 3, 'rendered as aria-disabled');
  assert.ok(!all(root, (n) => hasClass(n, 'gr-exp-page')).length);
});

test('the server has no endpoint for them: /api/growth/experiments, /ai and /settings are 404', async () => {
  const server = http.createServer(createGrowthApp({}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const k of UNBUILT) {
      const r = await fetch(`${base}/api/growth/${k}`);
      assert.equal(r.status, 404, k); await r.arrayBuffer();
    }
    for (const f of ['/experiments.js', '/settings.js', '/ai.js']) { const r = await fetch(base + f); assert.equal(r.status, 404, f); await r.arrayBuffer(); }
  } finally { server.close(); }
});
