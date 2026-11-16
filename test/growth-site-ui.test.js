// Growth > Opportunités > Site indépendant: the line, the exact page, the proof with the source of each figure, the plan -> applied -> review path, the rate comparison, FR / NL / EN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteSource, createSiteReviewSource } from '../src/growth/server/site.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const NOW = new Date('2026-11-15T12:00:00Z'); const TZ = 'Europe/Brussels'; const PAGE = '/demander-un-devis';
const ClockDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); } static now() { return NOW.getTime(); } };
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
const split = (total, n) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
const rows = (path, from, n, t) => { const s = split(t.sessions, n); const a = split(t.starts, n); const b = split(t.submits, n); const c = t.seq == null ? null : split(t.seq, n); return days(from, n).map((date, i) => ({ date, page_path: path, sessions: s[i], form_start_sessions: a[i], form_submit_sessions: b[i], started_then_submitted_sessions: c ? c[i] : null })); };
const EV = [{ kind: 'form_start', name: 'form_start', configured: true, confirms: 'unknown', page_attributable: true }, { kind: 'form_submit', name: 'generate_lead', configured: true, confirms: 'server_success', page_attributable: true }];
const funnel = (daily, o = {}) => ({ source_system: 'ga4', method: 'manual_export', property_id: '381000111', site_url: 'https://www.atelier-exemple.be', time_zone: TZ, window: { start: '2026-09-28', end: '2026-10-19' }, retrieved_at: '2026-11-15T06:00:00Z', filters: { channel: 'all' }, daily, events: EV, ...o });
const EXAMPLE = { sessions: 240, starts: 60, submits: 12, seq: 12 };
const before = () => funnel(rows(PAGE, '2026-09-28', 21, EXAMPLE));
const both = (after) => funnel([...rows(PAGE, '2026-09-28', 21, EXAMPLE), ...rows(PAGE, '2026-10-19', 1, { sessions: 11, starts: 3, submits: 1, seq: 1 }), ...rows(PAGE, '2026-10-20', 21, after)], { window: { start: '2026-09-28', end: '2026-11-10' } });
const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const norm = (t) => t.replace(/[  ]/g, ' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const sitePayload = (load) => createSiteSource({ timeZone: TZ, now: () => NOW, cacheMs: 0, load })();
const open = async (site, st = store(), { lang = 'fr', review } = {}) => { const o = { ...prioritiesPayload(), historyScope: 'merchant-a', site }; const ui = await growthDom('#/overview', { opportunities: o, lang, review }); ui.ctx.localStorage = st.api; ui.ctx.Date = ClockDate; await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui; };
const fold = (ui) => all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-site'))[0];
const click = (b) => b.listeners.click[0]();
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, k) => all(f, (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').find((n) => n.getAttribute('name') === k);
const events = (st) => [...st.m.values()].flatMap((v) => JSON.parse(v).events);
const ID = 'site:381000111:/demander-un-devis';

test('SU-1 the exact page: the compact line, the rate on the same sessions, the proof with the source of every figure, Search Console apart, a link to open the page', async () => {
  const gsc = { property_url: 'https://www.atelier-exemple.be/', window: { start: '2026-09-28', end: '2026-10-19' }, page_rows: [{ page: PAGE, impressions: 5200, clicks: 190 }], query_page_rows: [] };
  const ui = await open(await sitePayload(async () => ({ ...before(), search_console: gsc }))); const f = fold(ui); assert.ok(f); const closed = norm(text(all(f, (n) => n.tagName === 'SUMMARY')[0])); assert.ok(closed.includes('Site indépendant') && closed.includes('1 à examiner'), closed);
  const t = norm(text(f)); for (const s of ['Page « /demander-un-devis » : des démarrages du formulaire n’aboutissent pas à un envoi', '/demander-un-devis · 12/60 sessions · 20 %', 'propriété 381000111', 'fuseau Europe/Brussels', 'source GA4', 'Search Console : impressions, clics et requêtes dans Google, définitions distinctes des sessions du site']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 1500)}`);
  const row = all(f, (n) => n.getAttribute?.('data-priority-id') === ID)[0]; click(all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); const body = norm(text(row));
  for (const s of ['Page', 'https://www.atelier-exemple.be/demander-un-devis', 'Propriété GA4', 'Sessions de la page', '240', 'Sessions ayant démarré le formulaire', '60', 'Parmi ces sessions, envoi réussi', '12', 'Taux d’envoi (mêmes sessions)', '20 %', 'Source des chiffres', 'Search Console (apparté)', '5 200 / 190', 'Relisez le formulaire de la page']) assert.ok(body.includes(s), `${s}\n${body.slice(0, 1800)}`);
  const link = all(row, (n) => n.tagName === 'A' && n.getAttribute('data-target') === 'sitePage')[0]; assert.equal(link.getAttribute('href'), 'https://www.atelier-exemple.be/demander-un-devis'); assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('SU-2 a missing start event: Growth first asks to complete the measure and names the missing step (no drop-off is shown)', async () => {
  const ui = await open(await sitePayload(async () => ({ ...before(), events: [EV[1]] }))); const f = fold(ui); const t = norm(text(f));
  assert.ok(t.includes('Page « /demander-un-devis » : le démarrage du formulaire n’est pas mesuré') && t.includes('mesure à compléter'), t.slice(0, 900)); assert.ok(!t.includes('20 %'), 'no rate without the start event');
  const row = all(f, (n) => n.getAttribute?.('data-priority-id') === ID)[0]; click(all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); assert.ok(norm(text(row)).includes('Complétez la mesure : ajoutez l’événement « démarrage du formulaire » sur cette page.'));
  const ui3 = await open(await sitePayload(async () => ({ ...before(), events: [EV[0], { ...EV[1], confirms: 'click' }] }))); const row3 = all(fold(ui3), (n) => n.getAttribute?.('data-priority-id') === ID)[0]; click(all(row3, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); const click2 = norm(text(fold(ui3))); assert.ok(click2.includes('l’envoi est mesuré au clic, pas à la réception') && click2.includes('Un clic sur « Envoyer » ne prouve pas qu’une demande a été reçue') || click2.includes('déclenchez l’événement d’envoi à la confirmation'), click2.slice(0, 700));
});

test('SU-3 the path: Préparer -> plan -> Marquer comme appliquée -> À revoir -> 12/60 -> 18/60 = +10 points, kept with the page, the plan version and the application date', async () => {
  const st = store(); const load = async () => both({ sessions: 240, starts: 60, submits: 18, seq: 18 }); const review = (u) => createSiteReviewSource({ timeZone: TZ, now: () => NOW, load })({ id: new URL(u, 'http://x').searchParams.get('id'), applied: new URL(u, 'http://x').searchParams.get('applied'), review: new URL(u, 'http://x').searchParams.get('review') });
  let ui = await open(await sitePayload(async () => before()), st, { review }); const row = () => all(fold(ui), (n) => n.getAttribute?.('data-priority-id') === ID)[0];
  click(all(row(), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); const p = form(row(), 'plan'); const n = (k) => named(p, k); n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('baseline').valueAsNumber = 20; n('target').valueAsNumber = 30; n('reviewDate').value = '2026-11-09'; p.listeners.submit[0]({ preventDefault() {} });
  const a = form(row(), 'applied'); named(a, 'appliedOn').value = '2026-10-19'; a.listeners.submit[0]({ preventDefault() {} });
  const plan = events(st).find((e) => e.type === 'plan'); const applied = events(st).find((e) => e.type === 'applied'); assert.deepEqual([applied.date, applied.planAt], ['2026-10-19', plan.at], 'the application keeps the plan version');
  const entry = JSON.parse([...st.m.values()][0]); assert.deepEqual([entry.snapshot.id, entry.snapshot.targetRef, entry.snapshot.target.url], [ID, { type: 'page', id: PAGE }, 'https://www.atelier-exemple.be/demander-un-devis']);
  ui = await open(await sitePayload(async () => before()), st, { review }); const due = all(ui.root, (x) => x.tagName === 'DETAILS' && hasClass(x, 'gv-reviews'))[0]; assert.ok(due, 'À revoir'); const line = all(due, (x) => hasClass(x, 'gv-action'))[0];
  click(all(line, (x) => x.tagName === 'BUTTON' && hasClass(x, 'gv-primary'))[0]); await tick(); const t = norm(text(line));
  for (const s of ['12/60 → 18/60 sessions · +10 points · 20 % → 30 %', 'Avant : 28 sept. 2026 – 18 oct. 2026', 'Après : 20 oct. 2026 – 9 nov. 2026', '21 jours chacune, jour d’application exclu', 'Taux d’envoi réussi parmi les sessions qui ont démarré le formulaire de cette page']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 1400)}`);
  const f = form(line, 'review'); assert.equal(named(f, 'observed').getAttribute('value'), '30'); named(f, 'applied').value = '2026-10-19'; named(f, 'observed').valueAsNumber = 30; named(f, 'notes').value = 'Calculé par Growth'; all(f, (x) => x.tagName === 'SELECT')[0].value = 'comparable'; f.listeners.submit[0]({ preventDefault() {} }); await tick();
  const rv = events(st).find((e) => e.type === 'review'); assert.deepEqual([rv.computed.metric, rv.computed.before.converted, rv.computed.before.starts, rv.computed.after.converted, rv.computed.after.starts, rv.computed.difference.points, rv.applied], ['rate', 12, 60, 18, 60, 10, '2026-10-19']);
  // the stored review survives changed numbers: the source now says something else, the stored result is untouched and the page stays reachable although the opportunity left the list
  ui = await open(await sitePayload(async () => funnel(rows(PAGE, '2026-09-28', 21, { sessions: 240, starts: 60, submits: 60, seq: 60 }))), st, { review: () => Promise.resolve({}) });
  assert.equal(events(st).find((e) => e.type === 'review').computed.after.converted, 18); assert.match(norm(text(ui.root)), /Page « \/demander-un-devis »/);
});

test('SU-4 uncertain or unavailable: low volume, a tracking change, separate totals - the comparison says so, shows the numbers, stores nothing as comparable', async () => {
  const st = store(); const call = (load) => (u) => createSiteReviewSource({ timeZone: TZ, now: () => NOW, load })({ id: PAGE, applied: '2026-10-19', review: '2026-11-09' });
  const events2 = EV.map((e) => (e.kind === 'form_submit' ? { ...e, changed_on: '2026-10-05' } : e));
  const limited = async (raw, expected) => { const s = store(); const ui = await open(await sitePayload(async () => before()), s, { review: call(async () => raw) }); const row = all(fold(ui), (n) => n.getAttribute?.('data-priority-id') === ID)[0]; click(all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); const p = form(row, 'plan'); const nn = (k) => named(p, k); nn('action').value = nn('action').getAttribute('value'); nn('metric').value = nn('metric').getAttribute('value'); nn('baseline').valueAsNumber = 20; nn('target').valueAsNumber = 30; nn('reviewDate').value = '2026-11-09'; p.listeners.submit[0]({ preventDefault() {} }); const a = form(row, 'applied'); named(a, 'appliedOn').value = '2026-10-19'; a.listeners.submit[0]({ preventDefault() {} });
    const ui2 = await open(await sitePayload(async () => before()), s, { review: call(async () => raw) }); const line = all(all(ui2.root, (x) => x.tagName === 'DETAILS' && hasClass(x, 'gv-reviews'))[0], (x) => hasClass(x, 'gv-action'))[0]; click(all(line, (x) => x.tagName === 'BUTTON' && hasClass(x, 'gv-primary'))[0]); await tick(); const t = norm(text(line)); assert.ok(t.includes(expected), `${expected}\n${t.slice(0, 900)}`); assert.ok(t.includes('Calcul limité') || t.includes('incertain') || t.includes('limité') || t.includes('Comparaison'), t.slice(0, 400));
    assert.equal(all(line, (x) => x.getAttribute?.('data-compare') === 'COMPARABLE').length, 0, 'never presented as comparable'); };
  await limited(both({ sessions: 90, starts: 20, submits: 7, seq: 7 }), 'Trop peu de démarrages du formulaire dans une des périodes pour comparer.');
  await limited({ ...both({ sessions: 240, starts: 60, submits: 18, seq: 18 }), events: events2 }, 'La mesure d’un événement du formulaire a changé entre les périodes');
  await limited(funnel([...rows(PAGE, '2026-09-28', 21, { ...EXAMPLE, seq: null }), ...rows(PAGE, '2026-10-20', 21, { sessions: 240, starts: 60, submits: 18, seq: null })], { window: { start: '2026-09-28', end: '2026-11-10' } }), 'La source ne fournit que des totaux séparés');
  assert.ok(st);
});

test('SU-5 no GA4 / Search Console connected: the block says so (nothing invented); without a site source there is no block; FR / NL / EN have no raw key at any state', async () => {
  const none = await sitePayload(null); const t = norm(text(fold(await open(none)))); assert.ok(t.includes('Non connecté') && t.includes('Aucune propriété GA4 ni Search Console n’est connectée à Nordla : aucun diagnostic, aucune donnée inventée.'), t);
  const base = await growthDom('#/overview', { opportunities: { ...prioritiesPayload(), historyScope: 'merchant-a' } }); await base.navigate('#/opportunities'); assert.equal(fold(base), undefined);
  const full = await sitePayload(async () => ({ ...funnel([...rows(PAGE, '2026-09-28', 21, EXAMPLE), ...rows('/contact', '2026-09-28', 21, { sessions: 90, starts: 10, submits: 4, seq: 4 })]), search_console: { property_url: 'https://www.atelier-exemple.be/', window: { start: '2026-09-28', end: '2026-10-19' }, page_rows: [], query_page_rows: [] } }));
  const bad = await sitePayload(async () => ({ daily: [] }));
  for (const lang of ['nl', 'en', 'fr']) for (const site of [none, full, bad]) { const ui = await open(site, store(), { lang }); const row = all(fold(ui), (n) => n.getAttribute?.('data-priority-id') === ID)[0]; if (row) click(all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); const tx = text(fold(ui)); assert.ok(!/gr\.(site|op|fiche|follow|line|review)\.[\w.]+/.test(tx), `${lang}: raw key in ${tx.slice(0, 300)}`); }
});
