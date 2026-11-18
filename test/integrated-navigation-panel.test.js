// Integrated navigation on the Nordla home panel: the Analytics shortcut and the Growth links only with a clean https address (the module count is covered by the home-card tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './sourcing-ui-load.js';
const { createModulesPanel } = await loadUi('modules-panel.js');

const KEYS = ['core', 'sourcing', 'finance', 'analytics', 'branding', 'marketing', 'creative'];
const api = (extra = {}) => async (path) => {
  if (path === '/api/core/modules') return { modules: KEYS.map((key) => ({ key, label: key, state: 'LIMITÉ', detail: 'x', ...(extra[key] ?? {}) })).concat(extra.growth ? [{ key: 'growth', label: 'Développement des ventes', state: 'DISPONIBLE', detail: 'x', ...extra.growth }] : []) };
  if (path === '/api/core/branding') return { status: 'NOT_CONNECTED' };
  if (path === '/api/core/campaigns') return { campaigns: [] };
  return { status: 'NOT_CONNECTED' };
};
const make = (a) => { const S = { online: true, token: 'synthetic' }; const panel = createModulesPanel({ S, api: a, refresh: () => {} }); return { panel, S }; };

test('Analytics shortcut: a link in the Analytics module only for a clean https address, in a new tab, with the honest note about its own access token', async () => {
  const ok = make(api({ analytics: { analytics_url: 'https://analytics.example.app' } })); await ok.panel.load(); const html = ok.panel.section();
  assert.match(html, /data-nx-analytics/); assert.match(html, /href="https:\/\/analytics\.example\.app\/" target="_blank" rel="noopener">Ouvrir Analyses/); assert.match(html, /jeton d’accès/);
  for (const bad of ['javascript:alert(1)', 'http://a.example', undefined]) { const p = make(api({ analytics: { analytics_url: bad } })); await p.panel.load(); assert.ok(!/data-nx-analytics/.test(p.panel.section()), String(bad)); }
});

test('Growth module: links to Où les visiteurs abandonnent and Opportunités, absent without a growth_url', async () => {
  const g = make(api({ growth: { growth_url: 'https://growth.example.app' } })); await g.panel.load(); const html = g.panel.section();
  assert.match(html, /href="https:\/\/growth\.example\.app\/#\/dropoff" target="_blank" rel="noopener"/); assert.match(html, /href="https:\/\/growth\.example\.app\/#\/opportunities"/);
  const n = make(api()); await n.panel.load(); assert.ok(!/data-nx-module="growth"/.test(n.panel.section()));
});

test('Analytics: with the single sign-on configured the module shows a button (asks the server for a ticket, no token), not a plain link', async () => {
  const sso = make(api({ analytics: { dashboard: true, analytics_url: 'https://analytics.example.app' } })); await sso.panel.load(); const html = sso.panel.section();
  assert.match(html, /data-act="nx-open-analytics">Ouvrir Analyses<\/button>/); assert.match(html, /aucun jeton à saisir/); assert.ok(!/analytics\.example\.app/.test(html), 'the address is only reached through a one-time ticket');
});
