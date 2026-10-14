// Développement des ventes - what is NOT built (owner decisions 2026-09-28):
//   - Expériences is not part of the product: no menu entry, no tile, no card, no text, no route, no endpoint (future idea only,
//     docs/growth/README.md "Feuille de route");
//   - Nordla AI and Paramètres are disabled menu entries only: no page, no route, no endpoint, no business code.
// A direct URL to any of them shows Vue d'ensemble.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createGrowthApp } from '../src/growth/server/app.js';
import { growthDom, all, text, navState, title } from './growth-dom.js';

const DISABLED = ['ai', 'settings'];
const BUILT = ['overview', 'opportunities', 'potential', 'audience', 'content', 'storeGrowth'];
const HASH = { overview: '#/', opportunities: '#/opportunities', potential: '#/potential', audience: '#/audience', content: '#/content', storeGrowth: '#/storeGrowth' };
const GROWTH = new URL('../src/growth/', import.meta.url);
const EXPERIMENTS = /exp[ée]rience|experiment/i; // FR "Expériences", NL "Experimenten", EN "Experiments"

test('the 6 built pages are exactly the PAGES definitions; Expériences, Nordla AI and Paramètres have none', async () => {
  const { ctx } = await growthDom('#/');
  assert.deepEqual(vm.runInContext('Object.keys(PAGES)', ctx), BUILT);
  for (const k of ['experiments', ...DISABLED]) assert.equal(vm.runInContext(`PAGES[${JSON.stringify(k)}]`, ctx), undefined, `${k} has no page definition`);
});

test('Expériences is totally absent from the interface: no menu entry, tile, card or text on any page, in FR / NL / EN', async () => {
  for (const lang of ['fr', 'nl', 'en']) {
    for (const page of BUILT) {
      const { root, errors } = await growthDom(HASH[page], { lang });
      assert.deepEqual(errors, [], `${lang} ${page}`);
      assert.doesNotMatch(text(root), EXPERIMENTS, `${lang} ${page}: Expériences shown`);
      assert.ok(!navState(root).some((n) => EXPERIMENTS.test(n.label)), `${lang} ${page}: menu entry`);
    }
  }
  // No UI text for it either: the former dormant opportunity source label went away with the demonstration Opportunités page.
  const ctx = { window: {} }; vm.createContext(ctx);
  for (const l of ['fr', 'nl', 'en']) vm.runInContext(readFileSync(new URL(`ui/lang-${l}.js`, GROWTH), 'utf8'), ctx);
  for (const [l, d] of Object.entries(ctx.window.NORDLA_DICTS)) {
    const keys = Object.keys(d).filter((k) => /experiment|gr\.exp\./i.test(k));
    assert.deepEqual(keys, [], `${l}: no Expériences text left`);
  }
  const app = readFileSync(new URL('ui/app.js', GROWTH), 'utf8');
  assert.doesNotMatch(app, /key: 'experiments'|experimentsCard|experimentsRunning|gr\.exp\./);
});

test('no page file, server module, route or endpoint exists for Expériences, Nordla AI or Paramètres', () => {
  const files = (d) => readdirSync(new URL(d, GROWTH), { recursive: true }).map(String);
  // Icons under ui/assets are not pages (experiments.png stays the icon of the dormant opportunity source type).
  for (const f of [...files('ui/').filter((x) => !/^assets[\\/]/.test(x)), ...files('server/'), ...readdirSync(GROWTH).map(String)]) {
    assert.doesNotMatch(f, /experiment|settings|assistant|nordla-?ai|(^|[\\/])ai\.js$/i, `unexpected ${f}`);
  }
  assert.equal(existsSync(new URL('experiments/', GROWTH)), false);
  assert.doesNotMatch(readFileSync(new URL('server/app.js', GROWTH), 'utf8'), /\/api\/growth\/(experiments|ai|settings)/);
  assert.doesNotMatch(readFileSync(new URL('server/overview.js', GROWTH), 'utf8'), /experiment/i, 'the overview payload carries no experiment field');
});

test('a direct URL to #/experiments, #/ai or #/settings shows Vue d\'ensemble; Nordla AI and Paramètres stay disabled (no link)', async () => {
  for (const k of ['experiments', ...DISABLED]) {
    const { root, errors } = await growthDom(`#/${k}`);
    assert.deepEqual(errors, [], k);
    assert.equal(title(root), 'Développement des ventes', `#/${k} falls back to Vue d'ensemble`);
    const nav = navState(root);
    assert.deepEqual(nav.filter((n) => n.active).map((n) => n.label), ['Vue d’ensemble'], `#/${k}: nothing else is active`);
    const inert = nav.filter((n) => n.inert);
    assert.deepEqual(inert.map((n) => n.label), ['Nordla AI', 'Paramètres']);
    for (const n of inert) assert.ok(n.href == null, `${n.label} has no link`);
  }
});

test('the server has no endpoint for them: /api/growth/experiments, /ai and /settings are 404', async () => {
  const server = http.createServer(createGrowthApp({}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const k of ['experiments', ...DISABLED]) {
      const r = await fetch(`${base}/api/growth/${k}`);
      assert.equal(r.status, 404, k); await r.arrayBuffer();
    }
    for (const f of ['/experiments.js', '/settings.js', '/ai.js']) { const r = await fetch(base + f); assert.equal(r.status, 404, f); await r.arrayBuffer(); }
  } finally { server.close(); }
});
