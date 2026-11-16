// Growth > Opportunités > Campagnes publicitaires: the compact fold, the diagnosis line, the same follow-up (plan, applied, review) as every other action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdsSource } from '../src/growth/server/ads.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const NOW = new Date('2026-11-15T09:00:00Z');
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
const rows = (id, name, n, f) => days('2026-10-18', n).map((date) => ({ date, campaign_id: id, campaign_name: name, impressions: 100, clicks: 4, cost: 3, ...f }));
const facts = (r) => ({ source_system: 'meta_ads', platform: 'meta_ads', account_ref: 'act_SIM', currency: 'EUR', conversion_objective: 'purchase', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z', rows: r });
const adsPayload = (load) => createAdsSource({ timeZone: 'UTC', now: () => NOW, load })();
const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const norm = (t) => t.replace(/[  ]/g, ' ');
const open = async (ads, st = store(), lang = 'fr') => { const o = { ...prioritiesPayload(), historyScope: 'merchant-a', ads }; const ui = await growthDom('#/overview', { opportunities: o, lang }); ui.ctx.localStorage = st.api; await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui; };
const fold = (ui) => all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-ads'))[0];
const click = (b) => b.listeners.click[0]();
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, k) => all(f, (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').find((n) => n.getAttribute('name') === k);

test('ADUI-1 a real zero and unknown conversions: two distinct lines with the exact campaign, channel, period, spend, currency, objective and proof; a clean campaign has no action', async () => {
  const ads = await adsPayload(async () => facts([...rows('c-zero', 'Coques été', 28, { conversions: 0 }), ...rows('c-unk', 'Reels', 28, {}), ...rows('c-ok', 'Bonne', 28, { conversions: 2 }), ...rows('c-gap', 'Courte', 9, { conversions: 0 })]));
  const ui = await open(ads); const f = fold(ui); assert.ok(f, 'the ads fold exists'); const closed = norm(text(all(f, (n) => n.tagName === 'SUMMARY')[0])); assert.ok(closed.includes('Campagnes publicitaires') && closed.includes('2 à examiner'), closed);
  const t = norm(text(f));
  for (const s of ['Campagne « Coques été » : dépense sans conversion mesurée', 'Campagne « Reels » : conversions inconnues', 'Meta Ads · 63,00 € dépensés · 0 conversion', 'Meta Ads · 63,00 € dépensés · conversions inconnues']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 1400)}`);
  assert.ok(t.includes('Bonne : Conversions mesurées, sans anomalie') && t.includes('Courte : Données incomplètes sur la période : pas de conclusion'), 'campaigns without a diagnosis are listed apart, with their reason');
  assert.equal(all(f, (n) => n.getAttribute?.('data-priority-id') != null).length, 2, 'only the two diagnoses are actions');
  const zero = all(f, (n) => n.getAttribute?.('data-priority-id') === 'ad:meta_ads:c-zero')[0]; click(all(zero, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); const body = norm(text(zero));
  for (const s of ['Canal', 'Meta Ads', 'Période jugée', '18 oct. 2026', 'Dépense', '63,00 €', 'Clics', '84', 'Conversions (déclarées par la plateforme)', 'Objectif de conversion', 'purchase', 'Délai de remontée', 'sans modifier le budget']) assert.ok(body.includes(s), `${s}\n${body.slice(0, 1500)}`);
  const unk = all(f, (n) => n.getAttribute?.('data-priority-id') === 'ad:meta_ads:c-unk')[0]; click(all(unk, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); assert.ok(norm(text(unk)).includes('inconnues'), 'unknown, never 0');
});

test('ADUI-2 the follow-up keeps the applied version and the result; a source change re-evaluates the suggestion without touching the recorded review', async () => {
  const st = store(); let conv = 0; const load = async () => facts(rows('c-zero', 'Coques été', 28, { conversions: conv }));
  const ads = await adsPayload(load); let ui = await open(ads, st); const row = () => all(fold(ui), (n) => n.getAttribute?.('data-priority-id') === 'ad:meta_ads:c-zero')[0];
  click(all(row(), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); const p = form(row(), 'plan'); const n = (k) => named(p, k);
  n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('baseline').valueAsNumber = 0; n('target').valueAsNumber = 3; n('reviewDate').value = '2026-11-20'; p.listeners.submit[0]({ preventDefault() {} });
  assert.ok(norm(JSON.parse([...st.m.values()][0]).events[0].action).includes('Examiner la page de destination de la campagne « Coques été »'), 'the plan carries the proposed action');
  const planAt = JSON.parse([...st.m.values()][0]).events.find((e) => e.type === 'plan').at; const entry = JSON.parse([...st.m.values()][0]); assert.equal(entry.snapshot.id, 'ad:meta_ads:c-zero'); assert.equal(entry.snapshot.kind, 'adCampaign');
  conv = 3; ui = await open(await adsPayload(load), st); // the source now reports conversions: the suggestion is gone
  assert.equal(all(fold(ui), (x) => x.getAttribute?.('data-priority-id') === 'ad:meta_ads:c-zero').length, 0, 'no longer suggested');
  const kept = JSON.parse([...st.m.values()][0]); assert.equal(kept.events.find((e) => e.type === 'plan').at, planAt, 'the recorded plan is untouched'); assert.match(text(ui.root), /Campagne « Coques été »/, 'and stays readable among the follow-ups kept');
});

test('ADUI-3 no ad account: the block says so (nothing invented, no zero); invalid or unreadable data are named; without an ad source there is no block; FR / NL / EN have no raw key', async () => {
  const none = await adsPayload(null); const ui = await open(none); const t = norm(text(fold(ui)));
  assert.ok(t.includes('Non connecté') && t.includes('Aucun compte publicitaire (Meta Ads) n’est connecté à Nordla : aucun diagnostic, aucune donnée inventée.'), t);
  assert.equal(all(fold(ui), (n) => n.getAttribute?.('data-priority-id') != null).length, 0);
  assert.ok(norm(text(fold(await open(await adsPayload(async () => ({ rows: [{ campaign_id: 'x' }] })))))).includes('Données invalides'));
  const base = await growthDom('#/overview', { opportunities: { ...prioritiesPayload(), historyScope: 'merchant-a' } }); await base.navigate('#/opportunities'); assert.equal(fold(base), undefined, 'no ads source, no block');
  const full = await adsPayload(async () => facts([...rows('c-zero', 'Z', 28, { conversions: 0 }), ...rows('c-unk', 'U', 28, {}), ...rows('c-gap', 'G', 9, { conversions: 0 })]));
  for (const lang of ['nl', 'en', 'fr']) for (const ads of [none, full]) { const u = await open(ads, store(), lang); const tx = text(fold(u)); assert.ok(!/gr\.(ads|op|fiche|follow|line)\.[\w.]+/.test(tx), `${lang}: raw key in ${tx.slice(0, 300)}`); }
});
