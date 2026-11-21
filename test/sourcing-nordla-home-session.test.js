// Regression: the Nordla home loads the module list in a Nordla session (cookie, token 'session'), never without a session,
// and a failed load says so instead of staying on "Chargement". Pure controller test: fake api, no DOM, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModulesPanel } from '../src/sourcing/ui/modules-panel.js';
import { nordlaHomeHtml } from '../src/sourcing/ui/screens/nordla-home.js';

const MODULES = { modules: [{ key: 'finance', label: 'Finance', state: 'LECTURE SEULE', detail: 'x', dashboard: true }] };

function panel({ token, online = true, reply }) {
  const calls = []; let repaints = 0;
  const S = { online, token, authMode: 'session' };
  const api = async (path) => { calls.push(path); if (reply instanceof Error) throw reply; return reply ?? MODULES; };
  const p = createModulesPanel({ S, api, refresh: () => {}, repaintHome: () => { repaints += 1; } });
  return { p, S, calls, repaints: () => repaints };
}

test('session: a signed-in Nordla session (token "session") loads the modules and repaints the home', async () => {
  const t = panel({ token: 'session' });
  await t.p.loadHomeModules();
  assert.deepEqual(t.calls, ['/api/core/modules', '/api/core/decisions', '/api/core/sales', '/api/connections']);
  assert.ok(t.repaints() >= 1, 'the home repaints once the modules (and then the figures) arrive');
});

test('session: without a session, no module request is sent (the sign-in screen is shown instead)', async () => {
  const t = panel({ token: '' });
  await t.p.loadHomeModules();
  assert.deepEqual(t.calls, []);
});

test('session: a failed module request is a visible state, never an endless "Chargement"', async () => {
  const t = panel({ token: 'session', reply: new Error('network') });
  await t.p.loadHomeModules();
  assert.equal(t.S.nx.homeFailed, true);
  const html = nordlaHomeHtml({ modules: t.S.nx.homeModules ?? null, online: true, error: 'Les modules ne répondent pas pour le moment.' });
  assert.ok(html.includes('ne répondent pas'));
  assert.ok(!html.includes('Chargement des modules'));
});

test('session: a successful load leaves no failure state', async () => {
  const t = panel({ token: 'session', reply: MODULES });
  await t.p.loadHomeModules();
  assert.equal(t.S.nx.homeFailed, false);
});
