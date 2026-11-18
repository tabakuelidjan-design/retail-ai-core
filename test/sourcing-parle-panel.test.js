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

test('the Google Business drafts link is shown on the Marketing module only when the server built the drafts module (gbp_screen), points at /gbp and says Nordla publishes nothing', async () => {
  const withFlag = (flag) => async (path) => {
    if (path === '/api/core/modules') return { modules: ['core', 'sourcing', 'finance', 'analytics', 'branding', 'marketing', 'creative'].map((key) => ({ key, label: key, state: 'LIMITÉ', detail: 'x', ...(key === 'marketing' ? { gbp_screen: flag } : {}) })) };
    if (path === '/api/core/branding') return { status: 'NOT_CONNECTED' };
    if (path === '/api/core/campaigns') return { campaigns: [] };
    return { status: 'NOT_CONNECTED' };
  };
  for (const [flag, expected] of [[true, true], [false, false]]) {
    const { panel } = make(withFlag(flag)); await panel.load();
    const html = panel.section();
    assert.equal(/href="\/gbp"/.test(html), expected, `gbp_screen=${flag}`);
    if (expected) assert.match(html, /Nordla ne publie rien sur Google/);
  }
});

test('the Développement des ventes module appears only with a https growth_url, opens in a new tab with noopener, and never invents a link', async () => {
  const mk = (extra) => async (path) => {
    if (path === '/api/core/modules') return { modules: ['core', 'sourcing', 'finance', 'analytics', 'branding', 'marketing', 'creative'].map((key) => ({ key, label: key, state: 'LIMITÉ', detail: 'x' })).concat(extra ? [{ key: 'growth', label: 'Développement des ventes', state: 'DISPONIBLE', detail: 'x', ...extra }] : []) };
    if (path === '/api/core/branding') return { status: 'NOT_CONNECTED' };
    if (path === '/api/core/campaigns') return { campaigns: [] };
    return { status: 'NOT_CONNECTED' };
  };
  const html = async (extra) => { const { panel } = make(mk(extra)); await panel.load(); return panel.section(); };
  const ok = await html({ growth_url: 'https://growth.example' });
  assert.match(ok, /href="https:\/\/growth\.example\/#\/dropoff" target="_blank" rel="noopener"/); assert.match(ok, /href="https:\/\/growth\.example\/#\/opportunities"/);
  assert.ok(!/data-nx-growth/.test(await html({ growth_url: 'javascript:alert(1)' })), 'a non-https value is never linked');
  assert.ok(!/data-nx-growth/.test(await html({})), 'no growth_url, no link'); assert.ok(!/data-nx-module="growth"/.test(await html(null)));
});

test('HOME: the Développement des ventes card (same two links) shows on the home without opening the panel, from ONE light read of the module list; absent without a https address, offline, or on failure', async () => {
  const mods = (extra) => ({ modules: ['core', 'sourcing', 'finance'].map((key) => ({ key, label: key, state: 'LIMITÉ', detail: 'x' })).concat(extra ? [{ key: 'growth', label: 'Développement des ventes', state: 'DISPONIBLE', detail: 'x', ...extra }] : []) });
  const calls = []; let repaints = 0;
  const mk = (api, S = { online: true, token: 'synthetic' }) => createModulesPanel({ S, api: async (p) => { calls.push(p); return api(p); }, refresh: () => {}, repaintHome: () => { repaints += 1; } });
  const p = mk(async () => mods({ growth_url: 'https://growth.example' })); assert.equal(p.growthHomeCard(), '', 'nothing before the list is read');
  await p.loadHomeModules(); await p.loadHomeModules();
  assert.deepEqual(calls, ['/api/core/modules'], 'one light read, once: no branding, campaigns or creation'); assert.equal(repaints, 1);
  const card = p.growthHomeCard(); assert.match(card, /data-nx-growth-home/); assert.match(card, /Développement des ventes/);
  assert.match(card, /href="https:\/\/growth\.example\/#\/dropoff" target="_blank" rel="noopener"[^>]*>Où les visiteurs abandonnent/); assert.match(card, /href="https:\/\/growth\.example\/#\/opportunities" target="_blank" rel="noopener"[^>]*>Opportunités/);
  for (const bad of [null, { growth_url: 'http://growth.example' }, { growth_url: 'javascript:alert(1)' }]) { const q = mk(async () => mods(bad)); await q.loadHomeModules(); assert.equal(q.growthHomeCard(), '', JSON.stringify(bad)); }
  const off = mk(async () => mods({ growth_url: 'https://growth.example' }), { online: false, token: 'x' }); await off.loadHomeModules(); assert.equal(off.growthHomeCard(), '');
  const boom = mk(async () => { throw new Error('down'); }); await boom.loadHomeModules(); assert.equal(boom.growthHomeCard(), '', 'a failed read leaves the home exactly as it was');
});

test('the modules counter reflects the list actually shown (no fixed number)', async () => {
  const api = async (path) => (path === '/api/core/modules' ? { modules: ['core', 'sourcing', 'finance', 'analytics', 'branding', 'marketing', 'creative', 'procurement', 'growth'].map((key) => ({ key, label: key, state: 'LIMITÉ', detail: 'x' })) } : { status: 'NOT_CONNECTED' });
  const { panel } = make(api); assert.doesNotMatch(panel.section(), /\(7 modules\)|\d+ modules\)/);
  await panel.load(); const html = panel.section(); assert.match(html, /9 modules — état réel sur ce serveur/); assert.equal((html.match(/data-nx-module="/g) ?? []).length, 9);
});

test('HOME markup: the card sits on the Salon home after the to-do list, and the home is unchanged without it', async () => {
  const { homeHtml } = await loadUi('screens/nx.js'); const base = { overview: [], sync: { kind: 'ok', label: 'ok' }, counts: { toConfirm: 0, waiting: 0, conflicts: 0, cases: { confirm: 0, waiting: 0, conflict: 0 } } };
  assert.equal(homeHtml(base), homeHtml({ ...base, growth: '' })); assert.match(homeHtml({ ...base, growth: '<section data-nx-growth-home></section>' }), /data-nx-growth-home/);
});
