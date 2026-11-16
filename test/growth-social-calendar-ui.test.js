// Lot _09 in Opportunités > Abonnés: the compact line shows where the test stands in Publication sociale; the panel (on demand) shows the planned date beside the real one, the versions and the
// review date; only a CONFIRMED publication offers the one-step link; a plan or a scheduled state starts nothing; the manual association stays; the review is the lot _08 one. FR / NL / EN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialSource, createSocialReviewSource } from '../src/growth/server/social.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const ClockDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); } static now() { return NOW.getTime(); } };
const post = (id, structure, reach, follows, o = {}) => ({ id, url: `https://www.instagram.com/reel/${id}/`, posted_at: '2026-10-20', format: 'reel', paid: 'organic', hook: 'Du plateau vide au cadeau fini', topic: 'impression UV', structure, observed: { age_days: 7, reach, follows_attributed: follows }, ...o });
const facts = (posts) => ({ source_system: 'instagram_insights_SIM', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z', followers: { start_total: 1000, end_total: 1060 }, brand: { tone: 'chaleureux, direct', process: 'impression UV' }, capabilities: { trial_reels: true }, posts });
const EX = [post('demo', 'démonstration', 1200, 12), post('presentation', 'présentation produit', 4000, 8)]; const TEST = post('test1', 'démonstration', 1500, 15, { posted_at: '2026-11-03' });
const ID = 'social:instagram:ig-9001';
const L = (o = {}) => ({ testId: ID, briefId: 'brief_x', briefVersion: 1, creationId: 'c1', creationVersion: 1, ...o });
const PUB = {
  draft: { stage: 'draft', state: 'READY_FOR_REVIEW', confirmed: false, simulated: false, plannedDay: null, publishedDay: null, reviewDueDay: null, observationDays: 7, measurement: 'NOT_STARTED', socialPostId: 'post_1', links: L() },
  scheduled: { stage: 'scheduled', state: 'SCHEDULED', confirmed: false, simulated: false, plannedDay: '2026-11-20', publishedDay: null, reviewDueDay: null, observationDays: 7, measurement: 'NOT_STARTED', socialPostId: 'post_1', links: L() },
  published: { stage: 'published', state: 'PUBLISHED', confirmed: true, simulated: false, plannedDay: '2026-11-02', publishedDay: '2026-11-03', publishedAt: '2026-11-03T17:05:00Z', networkPostId: 'test1', permalink: 'https://www.instagram.com/reel/test1/', reviewDueDay: '2026-11-10', observationDays: 7, measurement: 'READY', socialPostId: 'post_1', links: L(), openUrl: 'http://127.0.0.1:8980' },
  uncertain: { stage: 'uncertain', state: 'PUBLICATION_UNKNOWN', confirmed: false, simulated: false, plannedDay: '2026-11-03', publishedDay: null, reviewDueDay: null, observationDays: 7, measurement: 'NOT_STARTED', socialPostId: 'post_1', links: L() },
};
const sourceWith = async (pub, raw = facts(EX)) => { const s = await createSocialSource({ now: () => NOW, cacheMs: 0, loaders: { instagram: async () => raw } })(); return pub ? { ...s, items: s.items.map((i) => ({ ...i, publication: pub })) } : s; };
const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const norm = (t) => t.replace(/[  ]/g, ' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const open = async (social, st = store(), { lang = 'fr', review } = {}) => { const o = { ...prioritiesPayload(), historyScope: 'merchant-a', social }; const ui = await growthDom('#/overview', { opportunities: o, lang, review }); ui.ctx.localStorage = st.api; ui.ctx.Date = ClockDate; await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui; };
const fold = (ui) => all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-social'))[0];
const click = (b) => b.listeners.click[0]();
const rowIn = (ui) => all(fold(ui), (n) => n.getAttribute?.('data-priority-id') === ID)[0];
const prim = (row) => all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0];
const panel = (row) => all(row, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-pub'))[0];
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, k) => all(f, (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').find((n) => n.getAttribute('name') === k);
const events = (st) => [...st.m.values()].flatMap((v) => JSON.parse(v).events);
const reviewVia = (raw) => (u) => { const q = new URL(u, 'http://x').searchParams; return createSocialReviewSource({ now: () => NOW, loaders: { instagram: async () => raw } })({ id: q.get('id'), network: q.get('network'), account: q.get('account'), days: q.get('days') }); };
function preparePlan(ui) { click(prim(rowIn(ui))); const p = form(rowIn(ui), 'plan'); const n = (k) => named(p, k); n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('baseline').valueAsNumber = 3.85; n('target').valueAsNumber = 8; n('reviewDate').value = '2026-11-12'; p.listeners.submit[0]({ preventDefault() {} }); }

test('LOT9-UI-1 a brief only prepared shows "Brief préparé"; a draft, a scheduled and an uncertain publication show their own state and start NOTHING (no one-step link, the manual association stays)', async () => {
  let ui = await open(await sourceWith(null)); assert.ok(norm(text(panel(rowIn(ui)))).includes('Brief préparé : aucune création de Creator'), 'prepared only');
  for (const [k, label, note] of [['draft', 'Brouillon', 'Pas encore publiée.'], ['scheduled', 'Planifié', 'Date prévue au calendrier : 20 nov. 2026'], ['uncertain', 'Publication incertaine', 'Pas encore publiée.']]) {
    const st = store(); ui = await open(await sourceWith(PUB[k]), st); const row = rowIn(ui); const t = norm(text(row));
    assert.ok(t.includes(label), `${k}: chip\n${t.slice(0, 600)}`); const pt = norm(text(panel(row))); for (const s of [`État : ${label}`, note, 'Aucune mesure ne démarre avant une publication confirmée', 'Brief version 1 · création version 1']) assert.ok(pt.includes(s), `${k}: ${s}\n${pt}`);
    preparePlan(ui); assert.ok(norm(text(prim(rowIn(ui)))).startsWith('Rattacher la publication'), `${k}: only the manual association is offered`); assert.equal(events(st).filter((e) => e.type === 'applied').length, 0, `${k}: nothing is recorded as applied`);
  }
});

test('LOT9-UI-2 a CONFIRMED publication: planned day beside the real one, review date = real day + 7; one step links it with the real date; the review is the lot _08 one, kept with the brief version', async () => {
  const st = store(); const raw = facts([...EX, TEST]); const review = reviewVia(raw);
  let ui = await open(await sourceWith(PUB.published, raw), st, { review }); const row0 = rowIn(ui); const pt = norm(text(panel(row0)));
  for (const s of ['État : Publication confirmée', 'Date prévue au calendrier : 2 nov. 2026', 'Date réelle de publication : 3 nov. 2026', 'Revue possible à partir du 10 nov. 2026 (7 jours après la publication réelle).', 'Ouvrir Publication sociale']) assert.ok(pt.includes(s), `${s}\n${pt}`);
  assert.equal(all(panel(row0), (n) => n.tagName === 'A')[0].getAttribute('href'), 'http://127.0.0.1:8980');
  preparePlan(ui); assert.ok(norm(text(prim(rowIn(ui)))).startsWith('Rapprocher la publication confirmée')); click(prim(rowIn(ui)));
  const applied = events(st).find((e) => e.type === 'applied'); assert.deepEqual([applied.date, applied.post.id, applied.post.url, applied.post.declared, applied.post.socialPostId, applied.post.briefVersion, applied.post.creationVersion, applied.post.accountId], ['2026-11-03', 'test1', 'https://www.instagram.com/reel/test1/', 'calendar', 'post_1', 1, 1, 'ig-9001'], 'the REAL date, not the planned one');
  ui = await open(await sourceWith(PUB.published, raw), st, { review }); const due = all(ui.root, (x) => x.tagName === 'DETAILS' && hasClass(x, 'gv-reviews'))[0]; const line = all(due, (x) => hasClass(x, 'gv-action'))[0];
  assert.ok(norm(text(line)).includes('rapprochée depuis Publication sociale ; date réelle 2026-11-03'));
  click(prim(line)); await tick(); const t = norm(text(line)); for (const s of ['10 pour 1 000 (15/1 500) contre 3,85 pour 1 000 (20/5 200)', 'Prochaine décision : refaire le format.']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 1500)}`);
});

test('LOT9-UI-3 a brief version different from the one the plan was made with is flagged; FR / NL / EN show no raw key', async () => {
  const st = store(); let ui = await open(await sourceWith(PUB.published), st); preparePlan(ui);
  ui = await open(await sourceWith({ ...PUB.published, links: L({ briefVersion: 2 }) }), st); assert.ok(norm(text(panel(rowIn(ui)))).includes('Le plan a été fait avec la version 1 du brief ; cette publication vient de la version 2.'));
  for (const lang of ['nl', 'en', 'fr']) for (const k of ['draft', 'scheduled', 'published', 'uncertain']) { const u = await open(await sourceWith(PUB[k]), store(), { lang }); const tx = text(fold(u)); assert.ok(!/gr\.(pub|social|op|fiche|follow|line|review)\.[\w.]+/.test(tx), `${lang}/${k}: raw key in ${tx.slice(0, 300)}`); }
  const nl = await open(await sourceWith(PUB.published), store(), { lang: 'nl' }); assert.match(norm(text(panel(rowIn(nl)))), /Werkelijke publicatiedatum: 3 nov\.? 2026/);
});
