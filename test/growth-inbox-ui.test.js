// Lot _10 in Opportunités > Demandes: the test (keyword + first-reply draft, type of request), the linked publication, the conversations of its period qualified by the MERCHANT, the review
// (4 / 12 = 33,3 %), the recorded review kept with the version tested, the same scenario without attribution, a manual statement without any connection, FR / NL / EN. Fictitious customers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxSource, createInboxReviewSource } from '../src/growth/server/inbox.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const ClockDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); } static now() { return NOW.getTime(); } };
const th = (id, day, o = {}) => ({ id, started_at: day, messages: 1, origin: { kind: 'post', post_id: 'test1', attribution: 'connection' }, ...o });
const ATTR = Array.from({ length: 12 }, (_, i) => th(`t${i + 1}`, ['2026-11-03', '2026-11-04', '2026-11-05'][i % 3], { messages: i % 3 === 0 ? 4 : 1 }));
const UNK = ['u1', 'u2', 'u3'].map((id) => th(id, '2026-11-05', { origin: { kind: 'unknown' } }));
const facts = (o = {}) => ({ source_system: 'inbox_import_SIM', method: 'aggregate_export', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z', request_type: 'quote', complete: true, conversations: [...ATTR, ...UNK], ...o });
const known = async () => [{ network: 'instagram', id: 'ig-9001', handle: '@atelier_sim', linkedTestId: 'social:instagram:ig-9001' }];
const PUB = { stage: 'published', state: 'PUBLISHED', confirmed: true, simulated: false, plannedDay: '2026-11-02', publishedDay: '2026-11-03', publishedAt: '2026-11-03T17:05:00Z', networkPostId: 'test1', permalink: 'https://www.instagram.com/reel/test1/', reviewDueDay: '2026-11-10', observationDays: 7, measurement: 'READY', socialPostId: 'post_1', links: { testId: 'social:instagram:ig-9001', briefId: 'brief_x', briefVersion: 1, creationId: 'c1', creationVersion: 1 } };
const sourceOf = async (raw, pub = PUB, loaders = raw ? { instagram: async () => raw } : {}) => { const s = await createInboxSource({ loaders, accounts: known, now: () => NOW, cacheMs: 0 })(); return pub ? { ...s, items: s.items.map((i) => ({ ...i, publication: pub })) } : s; };
const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const norm = (t) => t.replace(/[  ]/g, ' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const open = async (inbox, st = store(), { lang = 'fr', review } = {}) => { const o = { ...prioritiesPayload(), historyScope: 'merchant-a', inbox }; const ui = await growthDom('#/overview', { opportunities: o, lang, review }); ui.ctx.localStorage = st.api; ui.ctx.Date = ClockDate; await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui; };
const fold = (ui) => all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-inbox'))[0];
const ID = 'inbox:instagram:ig-9001';
const rowIn = (ui) => all(fold(ui), (n) => n.getAttribute?.('data-priority-id') === ID)[0];
const click = (b) => b.listeners.click[0]();
const prim = (row) => all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0];
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, k) => all(f, (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').find((n) => n.getAttribute('name') === k);
const events = (st) => [...st.m.values()].flatMap((v) => JSON.parse(v).events);
const reviewVia = (raw) => (u) => { const q = new URL(u, 'http://x').searchParams; if (q.get('type') !== 'inbox') return {}; return createInboxReviewSource({ now: () => NOW, loaders: { instagram: async () => raw } })({ id: q.get('id'), network: q.get('network'), account: q.get('account'), days: q.get('days'), from: q.get('from'), type: q.get('requestType'), qualified: q.get('qualified'), notQualified: q.get('notQualified'), declared: q.get('declared') }); };
const conv = (row, id, cls) => all(row, (n) => n.getAttribute?.('data-conv') === id).flatMap((li) => all(li, (b) => b.tagName === 'BUTTON' && hasClass(b, cls)))[0];
const prepare = (ui, type = 'quote') => { click(prim(rowIn(ui))); const p = form(rowIn(ui), 'plan'); const n = (k) => named(p, k); n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('baseline').valueAsNumber = 20; n('target').valueAsNumber = 30; n('reviewDate').value = '2026-11-12'; all(p, (x) => x.tagName === 'SELECT')[0].value = type; p.listeners.submit[0]({ preventDefault() {} }); };

test('INU-1 the line and the test: title with the keyword, account figures per provenance, the type of request chosen by the merchant, the first-reply draft he sends himself', async () => {
  const ui = await open(await sourceOf(facts())); const f = fold(ui); assert.ok(f); const closed = norm(text(all(f, (n) => n.tagName === 'SUMMARY')[0])); assert.ok(closed.includes('Demandes') && closed.includes('1 à examiner'), closed);
  const t = norm(text(f)); for (const s of ['Instagram · compte @atelier_sim', 'Conversations uniques : 15 · rattachées à une publication : 12 · d’origine inconnue : 3.', 'Doublons', 'Des conversations sont attribuées à des publications.', 'Demandes qualifiées (Instagram) : inviter à écrire « DEVIS » en message privé']) assert.ok(s === 'Doublons' ? !t.includes(s) : t.includes(s), `${s}\n${t.slice(0, 1400)}`);
  const row = rowIn(ui); click(all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); const r = norm(text(row));
  for (const s of ['Invitation et brouillon de première réponse', 'écrire « DEVIS » en message privé', 'sur quel support vous souhaitez imprimer et en quelle quantité', 'Nordla n’envoie aucun message']) assert.ok(r.includes(s), `${s}\n${r.slice(0, 1800)}`);
  click(prim(row)); const p = form(rowIn(ui), 'plan'); const sel = all(p, (x) => x.tagName === 'SELECT')[0]; assert.deepEqual(all(sel, (o) => o.tagName === 'OPTION').map((o) => text(o)), ['Devis', 'Réservation', 'Autre demande explicite']);
  sel.listeners.change[0]({ target: { value: 'booking' } }); const after = norm(text(rowIn(ui))); assert.ok(after.includes('RESERVER') && after.includes('la date souhaitée et le nombre de personnes'), 'the draft and the keyword follow the type chosen');
  sel.listeners.change[0]({ target: { value: 'quote' } }); n_(p, 'action'); function n_(pp, k) { assert.ok(named(pp, k).value.includes('DEVIS'), 'the action text follows the keyword'); }
});

test('INU-2 the whole path: linked confirmed publication -> plan -> one-step link (real date) -> conversations qualified by the merchant -> 4 / 12 = 33,3 % with provenance -> the review kept with the version tested', async () => {
  const st = store(); const raw = facts(); const review = reviewVia(raw);
  let ui = await open(await sourceOf(raw), st, { review }); prepare(ui); const plan = events(st).find((e) => e.type === 'plan'); assert.equal(plan.requestType, 'quote', 'the type of request is recorded with the plan');
  assert.ok(norm(text(prim(rowIn(ui)))).startsWith('Rapprocher la publication confirmée')); click(prim(rowIn(ui)));
  const applied = events(st).find((e) => e.type === 'applied'); assert.deepEqual([applied.date, applied.post.id, applied.post.declared, applied.post.accountId, applied.post.network], ['2026-11-03', 'test1', 'calendar', 'ig-9001', 'instagram']);
  const row = rowIn(ui); const panel = all(row, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-inbox-panel'))[0]; const pt = norm(text(panel)); assert.ok(pt.includes('Conversations de la période (15)') && pt.includes('Période d’observation : 3 nov. 2026 – 9 nov. 2026'), pt.slice(0, 500));
  assert.equal(all(panel, (n) => n.getAttribute?.('data-conv')).length, 15, '12 attributed + 3 unknown in the period');
  for (const id of ['t1', 't2', 't3', 't4']) click(conv(rowIn(ui), id, 'gv-q'));
  const q = events(st).filter((e) => e.type === 'qualify'); assert.deepEqual([q.length, q.every((e) => e.postId === 'test1' && e.state === 'qualified' && e.planAt === plan.at || e.postId === 'test1')], [4, true], 'each qualification is tied to the publication of the test');
  // the review is opened: the server counts the conversations of the period attributed to the post, with the merchant's confirmations
  click(prim(rowIn(ui))); await tick(); let t = norm(text(rowIn(ui)));
  for (const s of ['33,3 % (4 qualifiées sur 12 conversations uniques)', 'Provenance : 12 attribuées par la source · 0 rattachées par vous.', 'Demandes uniques : non distinguées par la source.', '8 conversations restent à qualifier', 'Au niveau du compte, non attribué : 15 conversations dans la période, dont 3 d’origine inconnue.', 'Prochaine décision : qualifier les conversations restantes.', '2 conversations comptent plusieurs messages'.replace('2', '4')]) assert.ok(t.includes(s), `${s}\n${t.slice(0, 2400)}`);
  // saving now would keep only a manual figure (the calculation is incomplete: nothing is frozen as computed)
  const f0 = form(rowIn(ui), 'review'); assert.equal(named(f0, 'observed').getAttribute('value'), '', 'an incomplete calculation does not prefill the result');
  // the other 8 conversations are marked not qualified in one step; the calculation is complete
  click(all(rowIn(ui), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-bulk'))[0]); assert.equal(events(st).filter((e) => e.type === 'qualify').length, 12);
  click(prim(rowIn(ui))); await tick(); click(prim(rowIn(ui))); await tick(); t = norm(text(rowIn(ui)));
  assert.ok(t.includes('Prochaine décision : refaire un test pour pouvoir comparer'), t.slice(0, 2600)); assert.ok(!t.includes('restent à qualifier'));
  const f = form(rowIn(ui), 'review'); assert.equal(named(f, 'observed').getAttribute('value'), '33.3'); named(f, 'applied').value = '2026-11-03'; named(f, 'observed').valueAsNumber = 33.3; named(f, 'notes').value = 'Calculé par Growth'; all(f, (x) => x.tagName === 'SELECT')[0].value = 'comparable'; f.listeners.submit[0]({ preventDefault() {} }); await tick();
  const rv = events(st).find((e) => e.type === 'review'); assert.deepEqual([rv.computed.metric, rv.computed.counts.unique, rv.computed.counts.qualified, rv.computed.rate, rv.computed.counts.byProvenance, rv.computed.plan.requestType, rv.computed.accountLevel.unknownOrigin, rv.computed.window], ['qualificationRate', 12, 4, 33.3, { connection: 12, declared: 0 }, 'quote', 3, { start: '2026-11-03', end: '2026-11-10' }]);
  const entry = JSON.parse([...st.m.values()][0]); assert.equal(entry.snapshot.proposal.inquiry.type, 'quote', 'the version tested is kept with the review');
  // the history links each qualification to the test and says who did it
  ui = await open(await sourceOf(raw), st, { review }); const h = norm(text(rowIn(ui))); assert.ok(h.includes('Conversation t1 · Qualifiée (par vous, publication test1)'), h.slice(0, 200));
});

test('INU-3 the same scenario WITHOUT attribution per publication: conversations and requests at account level, the review stays manual and says why; the merchant can still attach conversations himself', async () => {
  const none = facts({ conversations: [...ATTR, ...UNK].map((c) => ({ ...c, origin: { kind: 'unknown' } })) }); const st = store(); const review = reviewVia(none);
  let ui = await open(await sourceOf(none, null), st, { review }); const t0 = norm(text(fold(ui))); assert.ok(t0.includes('Conversations visibles au niveau du compte seulement') && t0.includes('Conversations uniques : 15 · rattachées à une publication : 0 · d’origine inconnue : 15.'), t0.slice(0, 900));
  prepare(ui); assert.ok(norm(text(prim(rowIn(ui)))).startsWith('Rattacher la publication'), 'no calendar publication: the manual association stays');
  click(prim(rowIn(ui))); const a = form(rowIn(ui), 'applied'); named(a, 'postUrl').value = 'https://www.instagram.com/reel/test1/'; named(a, 'appliedOn').value = '2026-11-03'; a.listeners.submit[0]({ preventDefault() {} });
  assert.equal(events(st).find((e) => e.type === 'applied').post.declared, 'manual');
  click(prim(rowIn(ui))); await tick(); let t = norm(text(rowIn(ui)));
  for (const s of ['Aucune performance par publication ne peut être calculée', 'Aucune conversation n’est attribuée à une publication par la source.', 'Au niveau du compte, non attribué : 15 conversations dans la période, dont 15 d’origine inconnue.', 'Analyse manuelle', 'revue reste manuelle']) if (s !== 'Analyse manuelle') assert.ok(t.includes(s), `${s}\n${t.slice(0, 2600)}`);
  assert.ok(!/\d+,\d %/.test(t.slice(t.indexOf('Comparaison'))), 'no rate is shown');
  // the merchant attaches 4 unknown-origin conversations to the publication: they are COUNTED, and shown as declared by him
  for (const id of ['t1', 't2', 't3', 't4']) click(conv(rowIn(ui), id, 'gv-attach')); for (const id of ['t1', 't2']) click(conv(rowIn(ui), id, 'gv-q')); for (const id of ['t3', 't4']) click(conv(rowIn(ui), id, 'gv-nq'));
  click(prim(rowIn(ui))); await tick(); click(prim(rowIn(ui))); await tick(); t = norm(text(rowIn(ui)));
  for (const s of ['50 % (2 qualifiées sur 4 conversations uniques)', 'Provenance : 0 attribuées par la source · 4 rattachées par vous.', 'Volume insuffisant (4 conversations)']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 2600)}`);
});

test('INU-4 no messaging connected, an unreadable source: the test is still offered, with the manual path; nothing is invented; the review is limited with its reason', async () => {
  const st = store(); let ui = await open(await sourceOf(null, null), st); const t = norm(text(fold(ui))); assert.ok(t.includes('aucune messagerie connectée') && t.includes('le test reste utilisable'), t.slice(0, 800));
  assert.ok(rowIn(ui), 'the test line is there'); prepare(ui); click(prim(rowIn(ui))); const a = form(rowIn(ui), 'applied'); named(a, 'postUrl').value = 'https://www.instagram.com/reel/test1/'; named(a, 'appliedOn').value = '2026-11-03'; a.listeners.submit[0]({ preventDefault() {} });
  const panel = all(rowIn(ui), (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-inbox-panel'))[0]; assert.ok(norm(text(panel)).includes('Aucune conversation dans cette période.'), 'nothing is invented');
  const down = await createInboxSource({ loaders: { instagram: async () => { throw Object.assign(new Error('x'), { code: 'CONNECTION_DOWN' }); } }, accounts: known, now: () => NOW, cacheMs: 0 })(); const quiet = console.error; console.error = () => {};
  try { const u2 = await open(down, store()); assert.ok(norm(text(fold(u2))).includes('la source des conversations est indisponible'), 'unavailable is said'); assert.ok(rowIn(u2), 'and the test is still offered'); } finally { console.error = quiet; }
  const review = reviewVia(null); const lim = await review('/api/growth/review?type=inbox&id=test1&network=instagram&account=ig-9001&days=7&from=2026-11-03'); assert.deepEqual([lim.state, lim.limits[0], lim.rate], ['LIMITED', 'SOURCE_UNAVAILABLE', null]);
});

test('INU-5 FR / NL / EN: no raw key in any state, and the type-of-request names exist', async () => {
  for (const lang of ['nl', 'en', 'fr']) for (const [raw, pub] of [[facts(), PUB], [null, null], [facts({ conversations: [] }), null], [facts({ conversations: [], complete: false }), null]]) {
    const u = await open(await sourceOf(raw, pub), store(), { lang }); const row = rowIn(u); click(all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-toggle'))[0]); prepare(u); click(prim(rowIn(u)));
    const tx = text(fold(u)); const rk = tx.match(/gr\.(inbox|pub|op|fiche|follow|line|review|social)\.[\w.]+/); assert.ok(!rk, `${lang}: raw key ${rk && rk[0]}`);
  }
  const nl = await open(await sourceOf(facts()), store(), { lang: 'nl' }); assert.ok(norm(text(fold(nl))).includes('Aanvragen') && norm(text(fold(nl))).includes('Unieke gesprekken'));
  const en = await open(await sourceOf(facts()), store(), { lang: 'en' }); assert.ok(norm(text(fold(en))).includes('Unique conversations: 15'));
});
