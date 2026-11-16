// Lot _11: the commercial follow-up of a qualified request (quote sent -> booking confirmed / sale closed / closed without follow-up), recorded by the MERCHANT in this browser, per merchant scope.
// Simulated, fictitious customers (opaque ids). Nothing is sent, quoted or booked: only dates, references and notes the merchant enters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxSource, createInboxReviewSource, merchantRefOf } from '../src/growth/server/inbox.js';
import { createSiteSource } from '../src/growth/server/site.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const ClockDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); } static now() { return NOW.getTime(); } };
const th = (id, day, o = {}) => ({ id, started_at: day, messages: 1, origin: { kind: 'post', post_id: 'test1', attribution: 'connection' }, ...o });
const facts = (conversations, merchant, o = {}) => ({ merchant_ref: merchant ? merchantRefOf(merchant) : undefined, source_system: 'inbox_import_SIM', method: 'aggregate_export', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z', request_type: 'quote', complete: true, conversations, ...o });
const FILE = (m = 'merchant-a') => facts([th('c1', '2026-11-06'), th('c2', '2026-11-06'), th('c3', '2026-11-07'), th('u1', '2026-11-06', { origin: { kind: 'unknown' } })], m);
const PUB = { stage: 'published', state: 'PUBLISHED', confirmed: true, simulated: false, plannedDay: '2026-11-02', publishedDay: '2026-11-03', publishedAt: '2026-11-03T17:05:00Z', networkPostId: 'test1', permalink: 'https://www.instagram.com/reel/test1/', reviewDueDay: '2026-11-10', observationDays: 7, measurement: 'READY', socialPostId: 'post_1', links: { testId: 'social:instagram:ig-9001', briefId: 'brief_x', briefVersion: 1, creationId: 'c', creationVersion: 1 } };
const known = async () => [{ network: 'instagram', id: 'ig-9001', handle: '@atelier_sim', linkedTestId: 'social:instagram:ig-9001' }];
const sourceOf = async (file, merchantId = 'merchant-a', pub = PUB) => { const s = await createInboxSource({ loaders: file ? { instagram: async () => file } : {}, accounts: known, now: () => NOW, cacheMs: 0, merchantId })(); return pub ? { ...s, items: s.items.map((i) => ({ ...i, publication: pub })) } : s; };
const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const norm = (t) => t.replace(/[  ]/g, ' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const reviewVia = (merchantId, file) => (u) => { const p = new URL(u, 'http://x').searchParams; return createInboxReviewSource({ now: () => NOW, loaders: { instagram: async () => file }, merchantId })({ id: p.get('id'), network: p.get('network'), account: p.get('account'), days: p.get('days'), from: p.get('from'), type: p.get('requestType'), qualified: p.get('qualified'), notQualified: p.get('notQualified'), declared: p.get('declared') }); };
const open = async (inbox, st, { scope = 'scope-a', lang = 'fr', review, extra = {} } = {}) => { const o = { ...prioritiesPayload(), historyScope: scope, inbox, ...extra }; const ui = await growthDom('#/overview', { opportunities: o, lang, review }); ui.ctx.localStorage = st.api; ui.ctx.Date = ClockDate; await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui; };
const ID = 'inbox:instagram:ig-9001'; const REQ = (c) => `req:${ID}:${c}`;
const rowIn = (ui) => all(all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-inbox'))[0], (n) => n.getAttribute?.('data-priority-id') === ID)[0];
const click = (b) => b.listeners.click[0]();
const prim = (row) => all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0];
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, k) => all(f, (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').find((n) => n.getAttribute('name') === k);
const sel = (f, k) => all(f, (n) => n.tagName === 'SELECT').find((n) => n.getAttribute('name') === k);
const btn = (scope, cls) => all(scope, (n) => n.tagName === 'BUTTON' && hasClass(n, cls));
const conv = (row, id, cls) => all(row, (n) => n.getAttribute?.('data-conv') === id).flatMap((li) => btn(li, cls))[0];
const pipe = (row) => all(row, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-pipeline'))[0];
const reqLi = (row, id) => all(row, (n) => n.getAttribute?.('data-request') === id && n.tagName === 'LI')[0];
const pstore = (st, scope = 'scope-a') => JSON.parse(st.m.get(`nordla.growth.pipeline.v1:${scope}`) ?? 'null');
function plan(ui) { click(prim(rowIn(ui))); const p = form(rowIn(ui), 'plan'); const n = (k) => named(p, k); n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('baseline').valueAsNumber = 20; n('target').valueAsNumber = 30; n('reviewDate').value = '2026-11-12'; all(p, (x) => x.tagName === 'SELECT')[0].value = 'quote'; p.listeners.submit[0]({ preventDefault() {} }); click(prim(rowIn(ui))); }
function record(ui, reqId, v) { click(btn(reqLi(rowIn(ui), reqId), 'gv-record')[0]); const f = form(rowIn(ui), 'pipe-event'); sel(f, 'type').value = v.type; named(f, 'date').value = v.date; named(f, 'ref').value = v.ref ?? ''; named(f, 'note').value = v.note ?? ''; named(f, 'amount').value = v.amount ?? ''; if (Number.isFinite(v.amount)) named(f, 'amount').valueAsNumber = v.amount; else named(f, 'amount').valueAsNumber = NaN; named(f, 'currency').value = v.currency ?? 'EUR'; f.listeners.submit[0]({ preventDefault() {} }); }
const status = (ui) => norm(text(all(pipe(rowIn(ui)), (n) => hasClass(n, 'gv-status'))[0]));
const summaryText = (ui) => norm(text(pipe(rowIn(ui))));

test('PIP-1 the example: a request from the Reel, qualified, quote sent on 7 Nov, sale closed on 9 Nov = 1 qualified request, 1 quote sent, 1 sale closed, the three steps linked to the SAME request', async () => {
  const st = store(); let ui = await open(await sourceOf(FILE()), st); plan(ui); click(conv(rowIn(ui), 'c1', 'gv-q'));
  assert.ok(reqLi(rowIn(ui), REQ('c1')), 'the qualified conversation is a request with a stable identity in the merchant scope');
  record(ui, REQ('c1'), { type: 'quote_sent', date: '2026-11-07', ref: 'D-2026-014', note: 'plaque 30 cm, 20 pièces' }); record(ui, REQ('c1'), { type: 'sale_closed', date: '2026-11-09' });
  const s = pstore(st); assert.deepEqual([s.events.length, new Set(s.events.map((e) => e.requestId)).size, s.events.map((e) => e.type), s.events.map((e) => e.date)], [2, 1, ['quote_sent', 'sale_closed'], ['2026-11-07', '2026-11-09']]);
  assert.deepEqual([s.requests[REQ('c1')].provenance, s.requests[REQ('c1')].postId, s.requests[REQ('c1')].network, s.requests[REQ('c1')].start], ['connection', 'test1', 'instagram', '2026-11-06'], 'origin, channel, date and provenance are kept with the request');
  const t = summaryText(ui); for (const x of ['1 demande(s) qualifiée(s) · 1 devis envoyé(s) · 0 réservation(s) confirmée(s) · 1 vente(s) conclue(s)', 'Rattachées à la publication du test', 'Vente conclue · 9 nov. 2026 · saisi par vous', 'demande du 6 nov. 2026', 'Montant non renseigné pour 1 vente(s) : il reste inconnu.', 'Taux sur le même groupe de 1 demande(s) qualifiée(s)', 'devis 100 % · réservation 0 % · vente 100 %', 'n’est pas un paiement encaissé', 'ce navigateur uniquement']) assert.ok(t.includes(x), `${x}\n${t.slice(0, 2400)}`);
  assert.ok(t.includes('Historique (2)'), 'the history is one click away');
  ui = await open(await sourceOf(FILE()), st); assert.ok(summaryText(ui).includes('1 vente(s) conclue(s)'), 'after a reload the result is still there');
});

test('PIP-2 an unknown origin: the sale stays visible, at the merchant level, and is NOT attributed to the Reel; the publication\'s own review is untouched', async () => {
  const st = store(); const file = FILE(); const ui = await open(await sourceOf(file), st, { review: reviewVia('merchant-a', file) }); plan(ui);
  click(conv(rowIn(ui), 'u1', 'gv-q')); assert.ok(reqLi(rowIn(ui), REQ('u1')), 'an unknown-origin conversation can be qualified too'); record(ui, REQ('u1'), { type: 'sale_closed', date: '2026-11-09', amount: 180, currency: 'eur' });
  const s = pstore(st); assert.deepEqual([s.requests[REQ('u1')].provenance, s.requests[REQ('u1')].postId, s.events[0].amount, s.events[0].currency], ['unknown', null, 180, 'EUR']);
  const t = summaryText(ui); for (const x of ['Origine inconnue (conservées au niveau du marchand) :', '1 demande(s) qualifiée(s) · 0 devis envoyé(s) · 0 réservation(s) confirmée(s) · 1 vente(s) conclue(s)', 'Rattachées à la publication du test : aucune demande', 'Montant déclaré des ventes : 180 EUR']) assert.ok(t.includes(x), `${x}\n${t.slice(0, 1800)}`);
  // the review of the test counts only what is attributed to its publication: the unknown conversation is not in it
  click(prim(rowIn(ui))); await tick(); const rt = norm(text(rowIn(ui))); assert.ok(rt.includes('Au niveau du compte, non attribué : 4 conversations dans la période, dont 1 d’origine inconnue.'), rt.slice(0, 200));
  // the merchant may later ATTACH it: it moves to the attributed group, by his declaration
  click(conv(rowIn(ui), 'u1', 'gv-attach')); const t2 = summaryText(ui); assert.ok(t2.includes('Rattachées à la publication du test : 1 demande(s)') && reqLi(rowIn(ui), REQ('u1')) && norm(text(reqLi(rowIn(ui), REQ('u1')))).includes('rattachée par vous à la publication'), t2.slice(0, 900));
});

test('PIP-3 double click and reload: the same step is recorded once, the history is not duplicated, the count is by distinct request', async () => {
  const st = store(); let ui = await open(await sourceOf(FILE()), st); plan(ui); click(conv(rowIn(ui), 'c1', 'gv-q')); click(conv(rowIn(ui), 'c2', 'gv-q'));
  const v = { type: 'quote_sent', date: '2026-11-07', ref: 'D-1', note: 'x' }; record(ui, REQ('c1'), v); record(ui, REQ('c1'), v); assert.equal(pstore(st).events.length, 1, 'a double click adds nothing'); assert.ok(status(ui).includes('Déjà enregistré'), status(ui));
  record(ui, REQ('c1'), { type: 'quote_sent', date: '2026-11-08', ref: 'D-1b', note: 'second quote' }); record(ui, REQ('c2'), { type: 'quote_sent', date: '2026-11-07' });
  assert.equal(pstore(st).events.length, 3); const t = summaryText(ui); assert.ok(t.includes('2 demande(s) qualifiée(s) · 2 devis envoyé(s)'), `two quotes on one request and one on another = 2 DISTINCT requests with a quote\n${t.slice(0, 800)}`);
  ui = await open(await sourceOf(FILE()), st); assert.equal(pstore(st).events.length, 3, 'a reload writes nothing'); assert.ok(summaryText(ui).includes('2 devis envoyé(s)'));
  const again = await open(await sourceOf(FILE()), st); assert.equal(pstore(st).events.length, 3);
});

test('PIP-4 a correction keeps the old line in the history and counts the new one; a withdrawal keeps its trace; nothing is counted twice', async () => {
  const st = store(); const ui = await open(await sourceOf(FILE()), st); plan(ui); click(conv(rowIn(ui), 'c1', 'gv-q'));
  record(ui, REQ('c1'), { type: 'sale_closed', date: '2026-11-09', amount: 120 }); const first = pstore(st).events[0];
  const li = () => reqLi(rowIn(ui), REQ('c1')); click(all(li(), (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-pipe-hist'))[0].children.length ? btn(li(), 'gv-correct')[0] : null);
  let f = form(rowIn(ui), 'pipe-event'); assert.equal(named(f, 'date').getAttribute('value'), '2026-11-09', 'the correction form starts from the recorded values'); sel(f, 'type').value = 'sale_closed'; named(f, 'date').value = '2026-11-10'; named(f, 'amount').value = '150'; named(f, 'amount').valueAsNumber = 150; named(f, 'currency').value = 'EUR'; named(f, 'ref').value = ''; named(f, 'note').value = ''; f.listeners.submit[0]({ preventDefault() {} });
  const s = pstore(st); assert.deepEqual([s.events.length, s.events[1].supersedes === first.id, s.events[1].date, s.events[1].amount], [2, true, '2026-11-10', 150]);
  let t = summaryText(ui); assert.ok(t.includes('1 vente(s) conclue(s)') && t.includes('Montant déclaré des ventes : 150 EUR') && !t.includes('270'), 'the sale is counted ONCE, with the corrected amount\n' + t.slice(0, 900)); assert.ok(t.includes('remplacé ou retiré (conservé, non compté)'), 'the old line is kept and marked');
  click(btn(li(), 'gv-withdraw')[0]); const w = pstore(st); assert.deepEqual([w.events.length, w.events.at(-1).type, w.events.at(-1).supersedes === s.events[1].id], [3, 'void', true]);
  t = summaryText(ui); assert.ok(t.includes('0 vente(s) conclue(s)') && t.includes('1 demande(s) qualifiée(s)') && t.includes('Étape retirée le'), 'withdrawn: no longer counted, still in the history\n' + t.slice(0, 900));
});

test('PIP-5 the checks: a step cannot precede the request, lie in the future, a result cannot precede the quote, an amount only goes with a sale; an unknown amount stays unknown', async () => {
  const st = store(); const ui = await open(await sourceOf(FILE()), st); plan(ui); click(conv(rowIn(ui), 'c1', 'gv-q'));
  record(ui, REQ('c1'), { type: 'quote_sent', date: '2026-11-05' }); assert.ok(status(ui).includes('antérieure à la demande'), status(ui)); assert.equal(pstore(st), null, 'nothing was written');
  record(ui, REQ('c1'), { type: 'quote_sent', date: '2026-11-20' }); assert.ok(status(ui).includes('futur'), status(ui));
  record(ui, REQ('c1'), { type: 'quote_sent', date: '2026-11-08', amount: 50 }); assert.ok(status(ui).includes('Montant ou devise invalide'), status(ui));
  record(ui, REQ('c1'), { type: 'quote_sent', date: '2026-11-08' }); assert.equal(pstore(st).events.length, 1);
  record(ui, REQ('c1'), { type: 'booking_confirmed', date: '2026-11-07' }); assert.ok(status(ui).includes('ne peut pas précéder le devis'), status(ui));
  record(ui, REQ('c1'), { type: 'booking_confirmed', date: '2026-11-09' }); record(ui, REQ('c1'), { type: 'closed_lost', date: '2026-11-12', note: 'plus de réponse' });
  const t = summaryText(ui); assert.ok(t.includes('1 réservation(s) confirmée(s) · 0 vente(s) conclue(s)') && t.includes('1 fermée(s) sans suite'), t.slice(0, 700)); assert.equal(pstore(st).events.length, 3, 'the refused steps left no trace');
});

test('PIP-6 two merchants in one browser: the same conversation id, two separate commercial histories; nothing passes from one to the other, before or after a reload', async () => {
  const st = store(); let a = await open(await sourceOf(FILE('merchant-a'), 'merchant-a'), st, { scope: 'scope-a' }); plan(a); click(conv(rowIn(a), 'c1', 'gv-q')); record(a, REQ('c1'), { type: 'sale_closed', date: '2026-11-09', amount: 100 });
  const fb = facts([th('c1', '2026-11-06'), th('c9', '2026-11-06')], 'merchant-b'); let b = await open(await sourceOf(fb, 'merchant-b'), st, { scope: 'scope-b' }); plan(b); click(conv(rowIn(b), 'c1', 'gv-q'));
  assert.ok(summaryText(b).includes('1 demande(s) qualifiée(s) · 0 devis envoyé(s) · 0 réservation(s) confirmée(s) · 0 vente(s) conclue(s)'), 'B\'s c1 has NO sale: A\'s sale on the same id c1 is invisible to B');
  record(b, REQ('c1'), { type: 'quote_sent', date: '2026-11-07' }); assert.equal(pstore(st, 'scope-a').events.length, 1); assert.equal(pstore(st, 'scope-b').events.length, 1); assert.equal(pstore(st, 'scope-b').events[0].type, 'quote_sent');
  a = await open(await sourceOf(FILE('merchant-a'), 'merchant-a'), st, { scope: 'scope-a' }); b = await open(await sourceOf(fb, 'merchant-b'), st, { scope: 'scope-b' });
  assert.ok(summaryText(a).includes('1 vente(s) conclue(s)') && !summaryText(a).includes('1 devis envoyé(s)')); assert.ok(summaryText(b).includes('1 devis envoyé(s)') && summaryText(b).includes('0 vente(s) conclue(s)'));
  const nr = await open(await sourceOf(FILE('merchant-a'), 'merchant-a'), st, { scope: null }); assert.ok(!norm(text(rowIn(nr))).includes('Enregistrer une étape'), 'without a merchant scope nothing can be recorded, and it is said');
});

test('PIP-7 without messaging, site, shop or CRM: a request stated by hand (origin declared by the merchant), a step recorded, the result kept after the opportunity leaves the list', async () => {
  const st = store(); let ui = await open(await sourceOf(null, 'merchant-a', null), st); assert.ok(norm(text(rowIn(ui))).includes('Suite commerciale')); plan(ui);
  const pp = () => pipe(rowIn(ui)); click(btn(pp(), 'gv-manual')[0]); let f = form(rowIn(ui), 'pipe-manual'); sel(f, 'kind').value = 'unknown'; named(f, 'start').value = '2026-11-06'; named(f, 'label').value = 'plaque, appel du 6'; f.listeners.submit[0]({ preventDefault() {} });
  const reg = pstore(st).requests; const id = Object.keys(reg)[0]; assert.deepEqual([id, reg[id].provenance, reg[id].kind, reg[id].start, reg[id].label], [`req:${ID}:m1`, 'unknown', 'manual', '2026-11-06', 'plaque, appel du 6']);
  record(ui, id, { type: 'quote_sent', date: '2026-11-07' }); record(ui, id, { type: 'sale_closed', date: '2026-11-09', amount: 95 });
  assert.ok(summaryText(ui).includes('1 demande(s) qualifiée(s) · 1 devis envoyé(s) · 0 réservation(s) confirmée(s) · 1 vente(s) conclue(s)'));
  // the opportunity leaves the list (the source disappears): the recorded result is still read from the store
  ui = await open({ state: 'OK', accounts: [], items: [] }, st); assert.equal(rowIn(ui), undefined, 'the test is no longer listed');
  const kept = pstore(st); assert.equal(kept.events.length, 2); assert.ok(ui.ctx.pipeRequests('scope-a', ID, []).length === 1, 'the request and its events remain readable');
  // a request attributed by hand to the publication needs the publication; a site request needs the page (the form stays open on a refusal)
  ui = await open(await sourceOf(null, 'merchant-a', null), st); click(btn(pipe(rowIn(ui)), 'gv-manual')[0]); f = form(rowIn(ui), 'pipe-manual'); sel(f, 'kind').value = 'publication'; named(f, 'start').value = '2026-11-06'; f.listeners.submit[0]({ preventDefault() {} }); assert.ok(norm(text(pipe(rowIn(ui)))).includes('Rattachez d’abord la publication'));
  sel(f, 'kind').value = 'site'; named(f, 'pagePath').value = ''; f.listeners.submit[0]({ preventDefault() {} }); assert.ok(norm(text(pipe(rowIn(ui)))).includes('Indiquez la page du site'));
  named(f, 'pagePath').value = '/demander-un-devis'; f.listeners.submit[0]({ preventDefault() {} });
  const t = summaryText(ui); assert.ok(t.includes('Issues d’une page du site') && t.includes('page du site /demander-un-devis (rapprochement déclaré par vous)'), t.slice(0, 1200));
});

test('PIP-8 a site (lot _07) total of forms sent creates NO individual request; only a request the merchant states, with the page he declares, does', async () => {
  const TZ = 'Europe/Brussels'; const PAGE = '/demander-un-devis'; const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
  const split = (total, n) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
  const rows = (path, from, n, t) => { const s = split(t.sessions, n); const a = split(t.starts, n); const b = split(t.submits, n); const c = t.seq == null ? null : split(t.seq, n); return days(from, n).map((date, i) => ({ date, page_path: path, sessions: s[i], form_start_sessions: a[i], form_submit_sessions: b[i], started_then_submitted_sessions: c ? c[i] : null })); };
  const EV = [{ kind: 'form_start', name: 'form_start', configured: true, confirms: 'unknown', page_attributable: true }, { kind: 'form_submit', name: 'generate_lead', configured: true, confirms: 'server_success', page_attributable: true }];
  const siteFacts = { source_system: 'ga4', method: 'manual_export', property_id: '381000111', site_url: 'https://www.atelier-exemple.be', time_zone: TZ, window: { start: '2026-09-28', end: '2026-10-19' }, retrieved_at: '2026-11-15T06:00:00Z', filters: { channel: 'all' }, daily: rows(PAGE, '2026-09-28', 21, { sessions: 240, starts: 60, submits: 12, seq: 12 }), events: EV };
  const site = await createSiteSource({ timeZone: TZ, now: () => NOW, cacheMs: 0, load: async () => siteFacts })(); const st = store();
  const ui = await open(await sourceOf(FILE()), st, { extra: { site } }); const siteFold = all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-site'))[0]; assert.ok(siteFold && norm(text(siteFold)).includes('12'), 'the site block shows its form totals');
  assert.equal(pstore(st), null, 'nothing was written: 12 forms sent are not 12 requests'); assert.equal(ui.ctx.pipeRequests('scope-a', 'site:381000111:/demander-un-devis', []).length, 0, 'no request exists for the site test');
  const sum = ui.ctx.pipelineSummary({ requests: [], events: [] }); assert.deepEqual([sum.all.qualified, sum.all.reached.quote, sum.all.rates.sale], [0, 0, null], 'no denominator, no rate');
});

test('PIP-9 FR / NL / EN: no raw key in any state of the follow-up', async () => {
  for (const lang of ['nl', 'en', 'fr']) {
    const st = store(); const ui = await open(await sourceOf(FILE()), st, { lang }); plan(ui); click(conv(rowIn(ui), 'c1', 'gv-q')); click(conv(rowIn(ui), 'u1', 'gv-q'));
    record(ui, REQ('c1'), { type: 'quote_sent', date: '2026-11-07', ref: 'D-1' }); record(ui, REQ('c1'), { type: 'sale_closed', date: '2026-11-09', amount: 80 }); record(ui, REQ('u1'), { type: 'closed_lost', date: '2026-11-08' });
    click(btn(reqLi(rowIn(ui), REQ('c1')), 'gv-record')[0]); click(btn(pipe(rowIn(ui)), 'gv-manual')[0]); pipe(rowIn(ui)).open = true;
    const tx = text(rowIn(ui)); const rk = tx.match(/gr\.(pipe|inbox|pub|op|fiche|follow|line|review|social)\.[\w.]+/); assert.ok(!rk, `${lang}: raw key ${rk && rk[0]}`);
  }
  const nl = await open(await sourceOf(FILE()), store(), { lang: 'nl' }); plan(nl); click(conv(rowIn(nl), 'c1', 'gv-q')); assert.ok(norm(text(pipe(rowIn(nl)))).includes('Commerciële opvolging'));
});

test('PIP-10 a request may end DIRECTLY in a booking or a sale, without any quote; when a quote exists the dates must agree (a result not before the first quote, a quote not after the first result)', async () => {
  const st = store(); const ui = await open(await sourceOf(FILE()), st); plan(ui); for (const c of ['c1', 'c2', 'c3']) click(conv(rowIn(ui), c, 'gv-q'));
  // c1: direct booking, c2: direct sale, no quote at all
  record(ui, REQ('c1'), { type: 'booking_confirmed', date: '2026-11-08', note: 'réservation directe' }); record(ui, REQ('c2'), { type: 'sale_closed', date: '2026-11-09', amount: 60 });
  assert.deepEqual(pstore(st).events.map((e) => [e.type, e.requestId.split(':').at(-1)]), [['booking_confirmed', 'c1'], ['sale_closed', 'c2']], 'accepted without a quote');
  let t = summaryText(ui); assert.ok(t.includes('3 demande(s) qualifiée(s) · 0 devis envoyé(s) · 1 réservation(s) confirmée(s) · 1 vente(s) conclue(s)'), t.slice(0, 600)); assert.ok(t.includes('devis 0 % · réservation 33,3 % · vente 33,3 %'), 'rates on the same 3 requests; no quote is not an error');
  // c3: with a quote, the dates must agree
  record(ui, REQ('c3'), { type: 'quote_sent', date: '2026-11-09' });
  record(ui, REQ('c3'), { type: 'sale_closed', date: '2026-11-08' }); assert.ok(status(ui).includes('ne peut pas précéder le devis'), status(ui)); assert.equal(pstore(st).events.length, 3, 'a sale before the quote is refused');
  record(ui, REQ('c3'), { type: 'sale_closed', date: '2026-11-09' }); assert.equal(pstore(st).events.length, 4, 'the same day is coherent');
  record(ui, REQ('c1'), { type: 'quote_sent', date: '2026-11-10' }); assert.ok(status(ui).includes('postérieur à une réservation'), status(ui)); assert.equal(pstore(st).events.length, 4, 'a quote after the booking is refused');
  record(ui, REQ('c1'), { type: 'quote_sent', date: '2026-11-07' }); assert.equal(pstore(st).events.length, 5, 'a quote BEFORE the booking can still be added afterwards');
  t = summaryText(ui); assert.ok(t.includes('3 demande(s) qualifiée(s) · 2 devis envoyé(s) · 1 réservation(s) confirmée(s) · 2 vente(s) conclue(s)'), t.slice(0, 600));
  // correcting the quote of c3 to a day after its sale is refused too (the quote being corrected is not counted against itself)
  const li = () => reqLi(rowIn(ui), REQ('c3')); click(btn(li(), 'gv-correct').find((b) => true)); const f = form(rowIn(ui), 'pipe-event');
  sel(f, 'type').value = 'quote_sent'; named(f, 'date').value = '2026-11-10'; named(f, 'amount').valueAsNumber = NaN; f.listeners.submit[0]({ preventDefault() {} }); assert.equal(pstore(st).events.length, 5, 'the correction is refused: nothing written');
});
