// Nordla Growth - the built scope (owner brief 2026-11-26): every menu entry opens a real page or a clearly explained state.
// Replaces the 2026-09-28 exclusions (no Expériences, Nordla AI / Paramètres as disabled entries). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { createGrowthApp } from '../src/growth/server/app.js';
import { growthDom, text, navState, title } from './growth-dom.js';

const PAGE_HASH = { overview: '#/', opportunities: '#/opportunities', potential: '#/potential', audience: '#/audience', content: '#/content', storeGrowth: '#/storeGrowth', dropoff: '#/dropoff', agents: '#/agents', experiments: '#/experiments', admin: '#/admin' };
const BUILT = Object.keys(PAGE_HASH);

test('the built pages are exactly the PAGES definitions (10); no disabled entry is left in the menu', async () => {
  const { ctx } = await growthDom('#/');
  assert.deepEqual(vm.runInContext('Object.keys(PAGES)', ctx).slice().sort(), BUILT.slice().sort());
  const { root } = await growthDom('#/');
  assert.deepEqual(navState(root).filter((n) => n.inert).map((n) => n.label), [], 'every menu entry has a link');
});

test('every built page opens directly with no error in FR / NL / EN, and its menu entry is the active one', async () => {
  for (const lang of ['fr', 'nl', 'en']) {
    for (const page of BUILT) {
      const { root, errors } = await growthDom(PAGE_HASH[page], { lang });
      assert.deepEqual(errors, [], `${lang} ${page}`);
      assert.ok(title(root), `${lang} ${page}: has a title`);
      assert.ok(navState(root).filter((n) => n.active).length >= 1, `${lang} ${page}: an active entry`); // the rail and the Plus panel can both show it
    }
  }
});

test('Expériences is an explained state: no fake result, no measured figure, the agent link instead', async () => {
  const { root, errors } = await growthDom('#/experiments');
  assert.deepEqual(errors, []);
  assert.match(text(root), /Aucune expérience|Expériences/);
  assert.doesNotMatch(text(root), /\b\d+\s*%/, 'no percentage is invented');
});

test('the scope endpoints answer without inventing data: agents registry, admin state and the experiments state (local preview, no provider)', async () => {
  const server = http.createServer(createGrowthApp({ agentProvider: null, agentConfig: { missing: ['GROWTH_AI_PROVIDER'], unknownProvider: false } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ag = await (await fetch(`${base}/api/growth/agents`)).json();
    assert.equal(ag.configured, false); assert.equal(ag.agents.length, 8);
    const ex = await (await fetch(`${base}/api/growth/experiments`)).json();
    assert.deepEqual(ex, { state: 'NO_MEASUREMENT_SOURCE' });
    const adm = await (await fetch(`${base}/api/growth/admin`)).json();
    assert.ok(adm.sources.every((s) => ['available', 'not_connected', 'unavailable'].includes(s.status)));
    assert.equal(adm.goals.stored, false);
  } finally { server.close(); }
});

test('the agents and admin pages are served with their scripts; no simulated AI text anywhere in the served UI', async () => {
  const { readFileSync } = await import('node:fs');
  const ui = new URL('../src/growth/ui/', import.meta.url);
  const agents = readFileSync(new URL('agents.js', ui), 'utf8');
  assert.doesNotMatch(agents, /lorem|simulé|simulated answer|mock/i);
  assert.match(agents, /disabled/); // the run button is disabled unless a provider is configured
  assert.match(agents, /textContent|h\('pre'/); // the draft is shown as text
  assert.doesNotMatch(agents, /innerHTML/);
});
