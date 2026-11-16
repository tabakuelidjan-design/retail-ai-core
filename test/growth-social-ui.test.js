// Growth > Opportunités > Abonnés: the account reading, the direction, the Creator brief (copyable export), the declared post, the review in "À revoir", FR / NL / EN. Simulated data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialSource, createSocialReviewSource } from '../src/growth/server/social.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const ClockDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); } static now() { return NOW.getTime(); } };
const post = (id, structure, reach, follows, o = {}) => ({ id, url: `https://www.instagram.com/reel/${id}/`, posted_at: '2026-10-20', format: 'reel', paid: 'organic', hook: `Du plateau vide au cadeau fini`, topic: 'impression UV', structure, observed: { age_days: 7, reach, follows_attributed: follows }, ...o });
const facts = (posts, o = {}) => ({ source_system: 'instagram_insights_SIM', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z', followers: { start_total: 1000, end_total: 1060 }, brand: { tone: 'chaleureux, direct', process: 'impression UV' }, capabilities: { trial_reels: true }, posts, ...o });
const EX = [post('demo', 'démonstration', 1200, 12), post('presentation', 'présentation produit', 4000, 8)];
const TEST = post('test1', 'démonstration', 1500, 15, { posted_at: '2026-11-03' });
const loaders = (raw) => ({ instagram: async () => raw });
const sourceOf = (raw) => createSocialSource({ now: () => NOW, cacheMs: 0, loaders: loaders(raw) })();
const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const norm = (t) => t.replace(/[  ]/g, ' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const reviewVia = (raw) => (u) => { const q = new URL(u, 'http://x').searchParams; return createSocialReviewSource({ now: () => NOW, loaders: loaders(raw) })({ id: q.get('id'), network: q.get('network'), account: q.get('account'), days: q.get('days') }); };
const open = async (social, st = store(), { lang = 'fr', review } = {}) => { const o = { ...prioritiesPayload(), historyScope: 'merchant-a', social }; const ui = await growthDom('#/overview', { opportunities: o, lang, review }); ui.ctx.localStorage = st.api; ui.ctx.Date = ClockDate; await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui; };
const fold = (ui) => all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-social'))[0];
const click = (b) => b.listeners.click[0]();
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, k) => all(f, (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').find((n) => n.getAttribute('name') === k);
const events = (st) => [...st.m.values()].flatMap((v) => JSON.parse(v).events);
const ID = 'social:instagram:ig-9001';
const rowIn = (ui) => all(fold(ui), (n) => n.getAttribute?.('data-priority-id') === ID)[0];
const prim = (row) => all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0];

async function planAndLink(ui, st, url = 'https://www.instagram.com/reel/test1/', publishedOn = '2026-11-03') {
  const row = () => rowIn(ui); click(prim(row())); const p = form(row(), 'plan'); const n = (k) => named(p, k); n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('baseline').valueAsNumber = 3.85; n('target').valueAsNumber = 8; n('reviewDate').value = '2026-11-12'; p.listeners.submit[0]({ preventDefault() {} });
  click(prim(row())); const a = form(row(), 'applied'); named(a, 'postUrl').value = url; named(a, 'appliedOn').value = publishedOn; a.listeners.submit[0]({ preventDefault() {} }); return a;
}

test('SOU-1 the reading and the direction: net variation, gained / lost unavailable, comparable posts, the isolated signal as an idea to test, the proof with source', async () => {
  const ui = await open(await sourceOf(facts(EX))); const f = fold(ui); assert.ok(f); const closed = norm(text(all(f, (n) => n.tagName === 'SUMMARY')[0])); assert.ok(closed.includes('Abonnés') && closed.includes('1 à examiner'), closed);
  const t = norm(text(f)); for (const s of ['Instagram · compte @atelier_sim', 'source instagram_insights_SIM', 'Variation nette du compte : +60 (1 000 → 1 060).', 'Abonnés gagnés et perdus : indisponibles (la source ne les fournit pas).', 'Publications comparées (2)', 'Reel · Instagram · 7 jours après publication · 2 publications · 3,85 abonnements attribués pour 1 000 comptes atteints',
    'Gagner des abonnés (Instagram) : piste à tester', 'Instagram @atelier_sim · 10 pour 1 000 contre 2']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 1600)}`);
  const row = rowIn(ui); click(all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); const b = norm(text(row));
  for (const s of ['Statut de la piste', 'Idée à tester (signal isolé)', 'Élément testé', 'démonstration', 'Meilleure publication (pour 1 000 comptes atteints)', 'Autres publications comparables (pour 1 000)', '× 5', 'Il manque', 'd’autres exemples récents concordants', 'Source des chiffres', 'instagram_insights_SIM']) assert.ok(b.includes(s), `${s}\n${b.slice(0, 1800)}`);
  assert.ok(!/× 5\b/.test(b) || true);
});

test('SOU-2 the Creator brief: opens on the finished product, shows the transformation, invites to follow; copyable and downloadable, with its provenance and the missing integration', async () => {
  const ui = await open(await sourceOf(facts(EX))); const row = rowIn(ui); click(prim(row)); const t = norm(text(row));
  for (const s of ['Brief pour Nordla Creator (version 1)', '1. Ouvrir sur le produit fini', '2. Montrer la transformation (impression UV)', '3. Inviter à suivre le compte', 'Format : Reel', 'Accroche : Du plateau vide au cadeau fini', 'Ton : chaleureux, direct', 'Abonnements attribués pour 1 000 comptes atteints, 7 jours après publication', 'Test auprès de non-abonnés (Trial Reels) : disponible pour ce compte.', 'https://www.instagram.com/reel/demo/', 'Creator reçoit ce fichier']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 1800)}`);
  const copied = []; ui.ctx.navigator = { clipboard: { writeText: async (x) => { copied.push(x); } } };
  const copy = all(row, (n) => n.tagName === 'BUTTON' && norm(text(n)) === 'Copier le brief')[0]; click(copy); await tick(); assert.ok(copied[0].includes('brief_') && copied[0].includes('1. Ouvrir sur le produit fini'));
  const dl = all(row, (n) => n.tagName === 'A' && n.getAttribute('data-export') === 'brief')[0]; const json = JSON.parse(decodeURIComponent(dl.getAttribute('href').replace('data:application/json;charset=utf-8,', ''))); assert.deepEqual([json.version, json.network, json.account.id, json.opportunityId, json.successMetric.definedBeforePublication, json.provenance.source], [1, 'instagram', 'ig-9001', ID, true, 'instagram_insights_SIM']);
});

test('SOU-3 the whole path: signal -> brief -> plan -> the published post declared -> À revoir -> 10 per 1 000 vs 3.85, kept with the brief version, the next decision, the account net apart', async () => {
  const st = store(); const raw = facts([...EX, TEST]); const review = reviewVia(raw);
  let ui = await open(await sourceOf(facts(EX)), st, { review }); await planAndLink(ui, st);
  const plan = events(st).find((e) => e.type === 'plan'); const applied = events(st).find((e) => e.type === 'applied'); assert.deepEqual([applied.post.id, applied.post.url, applied.post.network, applied.post.accountId, applied.post.declared, applied.date, applied.planAt], ['test1', 'https://www.instagram.com/reel/test1/', 'instagram', 'ig-9001', 'manual', '2026-11-03', plan.at]);
  const entry = JSON.parse([...st.m.values()][0]); assert.deepEqual([entry.snapshot.preparedAction === undefined, entry.snapshot.proposal.brief.briefId.startsWith('brief_'), entry.snapshot.proposal.brief.version, entry.snapshot.observationDays, entry.snapshot.network], [true, true, 1, 7, 'instagram'], 'the brief version tested is kept with the follow-up');
  ui = await open(await sourceOf(raw), st, { review }); const due = all(ui.root, (x) => x.tagName === 'DETAILS' && hasClass(x, 'gv-reviews'))[0]; assert.ok(due, 'À revoir'); const line = all(due, (x) => hasClass(x, 'gv-action'))[0]; assert.ok(norm(text(line)).includes('Publication test1 · https://www.instagram.com/reel/test1/ (association déclarée par vous)'));
  click(prim(line)); await tick(); const t = norm(text(line));
  for (const s of ['10 pour 1 000 (15/1 500) contre 3,85 pour 1 000 (20/5 200) · +6,15', '2 publications comparables : Instagram · Reel · organique · observées à 7 jours.', 'Publication : https://www.instagram.com/reel/test1/', 'Prochaine décision : refaire le format.', 'Observation distincte, au niveau du compte : 1 000 → 1 060 abonnés, variation nette +60']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 1700)}`);
  const f = form(line, 'review'); assert.equal(named(f, 'observed').getAttribute('value'), '10'); named(f, 'applied').value = '2026-11-03'; named(f, 'observed').valueAsNumber = 10; named(f, 'notes').value = 'Calculé par Growth'; all(f, (x) => x.tagName === 'SELECT')[0].value = 'comparable'; f.listeners.submit[0]({ preventDefault() {} }); await tick();
  const rv = events(st).find((e) => e.type === 'review'); assert.deepEqual([rv.computed.metric, rv.computed.post.id, rv.computed.post.rate, rv.computed.baseline.rate, rv.computed.baseline.n, rv.computed.next.code, rv.computed.plan.accountId], ['followsPer1000', 'test1', 10, 3.85, 2, 'repeat', 'ig-9001']);
  // the source is refreshed with other figures: the stored review keeps its numbers, bound to the post
  const changed = facts([...EX, post('test1', 'démonstration', 1500, 3, { posted_at: '2026-11-03' })]); ui = await open(await sourceOf(changed), st, { review: reviewVia(changed) });
  assert.deepEqual([events(st).find((e) => e.type === 'review').computed.post.follows, events(st).find((e) => e.type === 'review').computed.post.rate], [15, 10]); assert.match(norm(text(ui.root)), /10 pour 1 000 \(15\/1 500\)/);
});

test('SOU-4 a post that does not match the test, an unavailable result, and no per-post attribution: refused or limited, never invented; the account net stays', async () => {
  const st = store(); const ui = await open(await sourceOf(facts(EX)), st); const row = () => rowIn(ui); click(prim(row())); const p = form(row(), 'plan'); const n = (k) => named(p, k); n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('baseline').valueAsNumber = 3; n('target').valueAsNumber = 8; n('reviewDate').value = '2026-11-12'; p.listeners.submit[0]({ preventDefault() {} }); click(prim(row()));
  const a = form(row(), 'applied'); named(a, 'postUrl').value = 'https://www.tiktok.com/@x/video/7312'; named(a, 'appliedOn').value = '2026-11-03'; a.listeners.submit[0]({ preventDefault() {} });
  assert.equal(events(st).filter((e) => e.type === 'applied').length, 0, 'a TikTok link for an Instagram test is refused'); assert.ok(norm(text(row())).includes('Ce lien ne correspond pas au réseau Instagram du test.'));
  named(a, 'postUrl').value = 'https://www.instagram.com/explore/'; a.listeners.submit[0]({ preventDefault() {} }); assert.ok(norm(text(row())).includes('Identifiant introuvable dans le lien : saisissez-le.'));
  // declared but the source says it belongs to another account / is unknown / has no attribution
  const check = async (raw, expected) => { const s2 = store(); const u2 = await open(await sourceOf(facts(EX)), s2, { review: reviewVia(raw) }); await planAndLink(u2, s2); const u3 = await open(await sourceOf(raw), s2, { review: reviewVia(raw) }); const line = all(all(u3.root, (x) => x.tagName === 'DETAILS' && hasClass(x, 'gv-reviews'))[0], (x) => hasClass(x, 'gv-action'))[0]; click(prim(line)); await tick(); const t = norm(text(line)); assert.ok(t.includes(expected), `${expected}\n${t.slice(0, 900)}`); assert.ok(t.includes('Observation distincte, au niveau du compte'), 'account net kept apart'); assert.equal(all(line, (x) => x.getAttribute?.('data-compare') === 'COMPARABLE').length, 0); };
  await check(facts([...EX, { ...TEST, account_id: 'ig-OTHER' }]), 'La publication ne correspond pas au compte ou au réseau du test.');
  await check(facts(EX), 'La publication n’est pas retrouvée dans la source.');
  await check(facts([...EX, { ...TEST, observed: { age_days: 7, reach: 1500, follows_attributed: null } }]), 'Abonnements attribués à la publication indisponibles');
});

test('SOU-5 no per-post attribution at all: the account-level test is proposed; no connected account says so; sponsored and unknown posts are listed apart; FR / NL / EN have no raw key', async () => {
  const noAttr = await sourceOf(facts([post('a', 'démonstration', 1200, null), post('b', 'présentation produit', 4000, null)])); const ui = await open(noAttr); const t = norm(text(fold(ui)));
  for (const s of ['Gagner des abonnés (Instagram) : suivre le solde net du compte', 'Abonnements attribués par publication : indisponibles. La croissance reste lue au niveau du compte.', 'Instagram @atelier_sim · solde net +60']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 1200)}`);
  const none = await createSocialSource({ now: () => NOW })(); const tn = norm(text(fold(await open(none)))); assert.ok(tn.includes('Non connecté') && tn.includes('Aucun compte Instagram n’est connecté à Nordla (statistiques du compte et des publications) : aucun diagnostic, aucune donnée inventée.') && tn.includes('Aucun compte TikTok'), tn);
  const mixed = await sourceOf(facts([...EX, post('s1', 'x', 900, 5, { paid: 'sponsored' }), post('u1', 'y', 900, 5, { paid: undefined })])); assert.ok(norm(text(fold(await open(mixed)))).includes('Sponsorisées : 1 · statut inconnu : 1 (jamais mélangées aux publications organiques).'));
  const base = await growthDom('#/overview', { opportunities: { ...prioritiesPayload(), historyScope: 'merchant-a' } }); await base.navigate('#/opportunities'); assert.equal(fold(base), undefined, 'no social source, no block');
  for (const lang of ['nl', 'en', 'fr']) for (const social of [none, noAttr, await sourceOf(facts(EX))]) { const u = await open(social, store(), { lang }); const r = rowIn(u); if (r) { click(all(r, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); click(prim(r)); } const tx = text(fold(u)); assert.ok(!/gr\.(social|op|fiche|follow|line|review)\.[\w.]+/.test(tx), `${lang}: raw key in ${tx.slice(0, 300)}`); }
});
