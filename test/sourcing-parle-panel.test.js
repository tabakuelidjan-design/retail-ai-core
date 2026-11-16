// Parle à Nordla in the Nordla panel: first level (shown before the modules are opened), waiting state, answer zone, explicit errors, read-only (POST /api/core/ask only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './sourcing-ui-load.js';
const { createModulesPanel } = await loadUi('modules-panel.js');

const make = (api) => { let paints = 0; const S = { online: true, token: 'synthetic' }; const panel = createModulesPanel({ S, api, refresh: () => { paints += 1; } }); return { panel, paints: () => paints }; };

test('the question box is on the first level, before the modules are opened, with the three usual questions', () => {
  const { panel } = make(async () => ({}));
  const html = panel.section();
  assert.match(html, /data-nx-parle/); assert.match(html, /id="nx-q"/); assert.match(html, /Ma trésorerie \?/); assert.match(html, /Quelles factures dois-je payer \?/); assert.match(html, /Chiffre d’affaires des 30 derniers jours/);
  assert.match(html, /Ouvrir Nordla/); assert.match(html, /ne commande, ne paie et ne publie rien/);
});

test('a question goes to POST /api/core/ask only; the wait is shown, then the answer and its sources', async () => {
  const calls = []; let release;
  const gate = new Promise((r) => { release = r; });
  const { panel } = make(async (path, init) => { calls.push([path, init?.method, JSON.parse(init.body).text]); await gate; return { status: 'ANSWERED', answer: 'Trésorerie : aucune position bancaire.\nSecond line', sources: [{ ref: 'moteur de trésorerie (Finance)', source: 'Finance · test' }], limits: ['Projection du moteur de trésorerie Finance.'] }; });
  const pending = panel.ask('ma trésorerie', 'Ma trésorerie ?');
  assert.match(panel.section(), /Nordla cherche la réponse/); assert.match(panel.section(), /data-act="nx-parle" disabled/);
  release(); await pending;
  assert.deepEqual(calls, [['/api/core/ask', 'POST', 'ma trésorerie']]);
  const html = panel.section();
  assert.doesNotMatch(html, /Nordla cherche la réponse/); assert.match(html, /aucune position bancaire/); assert.match(html, /Sources : moteur de trésorerie \(Finance\)/); assert.match(html, /Limites : Projection/);
});

test('errors are explicit and an empty question is refused without calling the server', async () => {
  let called = 0;
  const { panel } = make(async () => { called += 1; throw { status: 401, body: { error: 'SESSION_INVALID' } }; });
  await panel.ask('   '); assert.equal(called, 0); assert.match(panel.section(), /Écrivez une question\./);
  await panel.ask('ma trésorerie'); assert.equal(called, 1); assert.match(panel.section(), /data-nx-ask-error/); assert.match(panel.section(), /Session expirée/);
  assert.doesNotMatch(panel.section(), /Nordla cherche la réponse/);
});

test('the Creator link is shown on the Création module only when the server built the Creator module (creator_screen), and points at /creator', async () => {
  const withFlag = (flag) => async (path) => {
    if (path === '/api/core/modules') return { modules: ['core', 'sourcing', 'finance', 'analytics', 'branding', 'marketing', 'creative'].map((key) => ({ key, label: key, state: 'LIMITÉ', detail: 'x', ...(key === 'creative' ? { creator_screen: flag } : {}) })) };
    if (path === '/api/core/branding') return { status: 'NOT_CONNECTED' };
    if (path === '/api/core/campaigns') return { campaigns: [] };
    return { status: 'NOT_CONNECTED' };
  };
  for (const [flag, expected] of [[true, true], [false, false]]) {
    const { panel } = make(withFlag(flag)); await panel.load();
    const html = panel.section();
    assert.equal(/href="\/creator"/.test(html), expected, `creator_screen=${flag}`);
    if (expected) assert.match(html, /mode TEST : résultats archivés, aucun fournisseur/);
  }
});
