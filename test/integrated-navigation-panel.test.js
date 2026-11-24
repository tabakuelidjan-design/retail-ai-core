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

test('Analytics shortcut: with the gateway the module links to /analyses/ in the same tab; an external address is never shown', async () => {
  const ok = make(api({ analytics: { analytics_inframe: true } })); await ok.panel.load(); const html = ok.panel.section();
  assert.match(html, /data-nx-analytics/); assert.match(html, /href="\/analyses\/">Ouvrir Analyses/); assert.ok(!/target="_blank"/.test(html.slice(html.indexOf('data-nx-analytics'))), 'same tab');
  const ext = make(api({ analytics: { analytics_url: 'https://analytics.example.app' } })); await ext.panel.load(); assert.ok(!/data-nx-analytics/.test(ext.panel.section()), 'no external shortcut since 78aa6819');
});

test('Growth module: links to Où les visiteurs abandonnent and Opportunités, absent without a growth_url', async () => {
  const g = make(api({ growth: { growth_url: 'https://growth.example.app' } })); await g.panel.load(); const html = g.panel.section();
  assert.match(html, /href="https:\/\/growth\.example\.app\/#\/dropoff" target="_blank" rel="noopener"/); assert.match(html, /href="https:\/\/growth\.example\.app\/#\/opportunities"/);
  const n = make(api()); await n.panel.load(); assert.ok(!/data-nx-module="growth"/.test(n.panel.section()));
});

test('Analytics: with the gateway the module opens in the Core session (no single sign-on ticket button, no address shown)', async () => {
  const g = make(api({ analytics: { analytics_inframe: true, dashboard: true, analytics_url: 'https://analytics.example.app' } })); await g.panel.load(); const html = g.panel.section();
  assert.ok(!/nx-open-analytics"/.test(html), 'the SSO new-tab button is gone (78aa6819)'); assert.ok(!/analytics\.example\.app/.test(html), 'the address is not shown');
});
