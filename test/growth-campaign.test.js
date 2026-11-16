// Growth > Opportunités > a campaign (reactivation / loyalty): prepare a usable e-mail, record the send done in the merchant's own tool, review it with the measures typed from that tool.
// Simulated data, offline. Independent of any e-mail platform: Growth prepares and follows, the merchant sends and measures elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankWeeklyActions } from '../src/growth/priorities/weekly.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const OK = { products: 'ok', audience: 'ok', store: 'ok', content: 'ok' };
const M = { start: '2026-08-16T22:00:00.000Z', end: '2026-11-14T23:00:00.000Z', calculatedAt: '2026-11-15T10:00:00.000Z' };
const base = prioritiesPayload(); const fxSeg = base.sections.commercial.find((i) => i.kind === 'segment' && i.entity.id === 'reactivate');
const segment = (key, purpose, customers, reason, eligible = null) => ({ ...fxSeg, id: `audience:segment:${key}`, entity: { type: 'segment', id: key }, title: { code: `segment.${key}.title`, params: { customers } }, explanation: { code: 'segment.commercial.why', params: { action: purpose } },
  evidence: { customers, orders: 0, days: 90 }, measurement: M, prerequisites: ['recipientsAndLink'], dataBlocker: null,
  preparedAction: { code: 'segment', segment: key, campaign: { purpose, customers, days: 90, baselineOrders: 0, reason, eligible } }, target: { type: 'segment', page: 'audience', id: key, available: true } });
const reactivation = (eligible = null) => segment('reactivate', 'reactivation', 70, { rule: 'REPEAT_BUYERS_WITHOUT_RECENT_ORDER', revenueShare: null, activeShare: null, previousCustomers: null }, eligible);
const loyalty = () => segment('loyal', 'loyalty', 60, { rule: 'REVENUE_SHARE_ABOVE_CUSTOMER_SHARE', revenueShare: 0.31, activeShare: 0.22, previousCustomers: null });

const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const norm = (t) => t.replace(/[  ]/g, ' ');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// A controllable clock: the screen reads "today" from Date, so each step of the chronology is dated explicitly (plan 2 Nov, send 4 Nov, review 16 Nov 2026).
const clock = { iso: '2026-11-02T12:00:00.000Z', n: 0 };
const setClock = (day) => { clock.iso = `${day}T12:00:00.000Z`; };
const local = () => clock.iso.slice(0, 10);
const ClockDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(new Date(clock.iso).getTime() + (clock.n++)); } static now() { return new Date(clock.iso).getTime() + (clock.n++); } };
const PLAN_DAY = '2026-11-02'; const SEND_DAY = '2026-11-04'; const REVIEW_DAY = '2026-11-16'; // plan prepared -> send declared -> measurement window after the send -> review
/** The whole chronology up to a review that is due: prepared on 2 Nov, sent on 4 Nov (64 targeted of the 70 customers of the segment), then the clock moves to the review day. */
function flow(ui, { recipients = null } = {}) {
  setClock(PLAN_DAY); click(primary(ui)); savePlan(ui); click(primary(ui)); setClock(SEND_DAY); click(primary(ui)); setClock(REVIEW_DAY);
  if (recipients != null) { const f = form(row(ui), 'applied'); named(f, 'recipients').valueAsNumber = recipients; all(f, (n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'date')[0].value = SEND_DAY; submit(f); }
}
async function open(items, st, { scope = 'merchant-a', lang = 'fr', copied = null } = {}) {
  const opportunities = { ...base, historyScope: scope, sections: { ...base.sections, commercial: items }, weekly: rankWeeklyActions(items, { sources: OK }) };
  const ui = await growthDom('#/overview', { lang, opportunities }); ui.ctx.localStorage = st.api; ui.ctx.Date = ClockDate; if (copied) ui.ctx.navigator = { clipboard: { writeText: async (t) => { copied.push(t); } } };
  await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui;
}
const ROW = 'audience:segment:reactivate';
const row = (ui, id = ROW) => all(ui.root, (n) => n.getAttribute?.('data-priority-id') === id)[0];
const primary = (ui, id = ROW) => all(row(ui, id), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0];
const click = (b) => b.listeners.click[0]();
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, name) => all(f, (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').find((n) => n.getAttribute('name') === name);
const submit = (f) => f.listeners.submit[0]({ preventDefault() {} });
const events = (st) => [...st.m.values()].flatMap((v) => JSON.parse(v).events);
const state = (ui, id = ROW) => text(all(row(ui, id), (n) => hasClass(n, 'gr-follow-state'))[0]);
const URL1 = 'https://habb.be/collections/coques?utm_source=email'; const URL2 = 'https://habb.be/collections/nouveautes';
function savePlan(ui, { id = ROW, url = URL1, subject = null, reviewDate = '2026-11-16', baseline = 0, target = 5 } = {}) {
  const f = form(row(ui, id), 'plan'); const n = (k) => named(f, k);
  n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('subject').value = subject ?? n('subject').getAttribute('value'); n('cta').value = n('cta').getAttribute('value'); n('url').value = url;
  n('baseline').valueAsNumber = baseline; n('target').valueAsNumber = target; n('reviewDate').value = reviewDate; submit(f);
}
const status = (ui, id = ROW) => text(all(row(ui, id), (n) => n.getAttribute?.('role') === 'status')[0]);
const dueEntry = (ui) => all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-reviews'))[0] ?? null;
const reviewLine = (ui) => all(dueEntry(ui), (n) => hasClass(n, 'gv-action'))[0];

test('CA-1 the campaign sheet: the exact segment, why it was selected, the analysed period, its size - which is NOT a number of recipients - and what Growth does not know (the eligible send list)', async () => {
  const ui = await open([reactivation(), loyalty()], store()); let t = text(row(ui, ROW));
  for (const s of ['Segment · Clients à réactiver', 'Pourquoi ce segment · Ces clients ont prouvé qu’ils rachètent', 'Période analysée · ', 'Clients dans le segment (analyse) · 70', 'ce n’est pas un nombre de destinataires',
    'Growth ne connaît pas la liste d’envoi admissible (consentement, désabonnés, doublons…) : vérifiez-la dans votre outil e-mail avant l’envoi.']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 1200)}`);
  assert.ok(!/70 destinataires/i.test(t) && !/destinataires admissibles/i.test(t), 'the size of the segment is never called recipients; unknown eligibility is not shown as a number');
  const open2 = await open([loyalty(), reactivation()], store()); t = text(row(open2, 'audience:segment:loyal')); assert.ok(norm(t).includes('Ce segment pèse 31 % du CA récent pour 22 % des clients actifs'), 'the engine\'s own reason and figures');
  const known = await open([reactivation({ count: 55, source: 'Klaviyo' })], store()); t = text(row(known)); assert.ok(t.includes('Destinataires admissibles · 55') && t.includes('source : Klaviyo') && !t.includes('Growth ne connaît pas la liste'), 'when a connection knows it, it is shown with its source');
});

test('CA-2 the draft is editable (subject, message, button text, real destination link), saved WITH the plan; the link must be a real https address; the content can be copied to any tool', async () => {
  const st = store(); const copied = []; const ui = await open([reactivation()], st, { copied }); click(primary(ui));
  const f = form(row(ui), 'plan'); assert.deepEqual(['subject', 'body', 'cta', 'url'].map((k) => !!named(f, k)), [true, true, true, true]);
  assert.match(named(f, 'subject').getAttribute('value'), /Cela fait un moment/); assert.equal(named(f, 'cta').getAttribute('value'), 'Voir la sélection');
  savePlan(ui, { url: '' }); assert.equal(events(st).length, 0, 'the real link is required');
  for (const bad of ['http://habb.be', 'javascript:alert(1)', 'habb.be/coques', 'https://', 'https:// espace']) { savePlan(ui, { url: bad }); assert.equal(events(st).length, 0, bad); assert.ok(status(ui).includes('Le lien doit être une adresse https:// valide.'), bad); }
  named(form(row(ui), 'plan'), 'body').value = 'Bonjour, une sélection pour vous.'; savePlan(ui, { url: URL1, subject: 'Revoyons-nous' });
  const plan = events(st).find((e) => e.type === 'plan'); assert.deepEqual(plan.campaign, { segment: 'reactivate', subject: 'Revoyons-nous', body: 'Bonjour, une sélection pour vous.', cta: 'Voir la sélection', url: URL1 }, 'the prepared version is saved with the plan');
  click(all(row(ui), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-link') && text(n) === 'Copier le brouillon')[0]); await tick();
  assert.equal(copied.length, 1); for (const s of ['Objet: Revoyons-nous', 'Bonjour, une sélection pour vous.', 'Texte du bouton: Voir la sélection -> ' + URL1]) assert.ok(copied[0].includes(s), s); assert.ok(status(ui).includes('Brouillon copié'));
  const blocked = await open([reactivation()], store()); blocked.ctx.navigator = { clipboard: { writeText: async () => { throw new Error('denied'); } } }; click(all(row(blocked), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-link') && text(n) === 'Copier le brouillon')[0]); await tick(); assert.ok(status(blocked).includes('Copie impossible'));
});

test('CA-3 a changed link or segment asks again for the check "recipients and link verified"; a changed subject or message does not; the check stays tied to the version that was verified', async () => {
  const st = store(); const ui = await open([reactivation()], st); click(primary(ui)); savePlan(ui); assert.ok(text(primary(ui)).startsWith('Destinataires et lien vérifiés')); click(primary(ui));
  const verified = () => text(form(row(ui), 'prereq')).includes('Destinataires et lien vérifiés pour ce plan.'); assert.ok(verified());
  savePlan(ui, { subject: 'Autre objet', baseline: 1, target: 9 }); assert.ok(verified(), 'subject, figures and review date do not concern the verification');
  savePlan(ui, { url: URL2 }); assert.ok(!verified()); assert.ok(text(form(row(ui), 'prereq')).includes('Le plan a changé depuis la dernière confirmation : à reconfirmer')); assert.ok(text(primary(ui)).startsWith('Destinataires et lien vérifiés'));
  click(primary(ui)); assert.ok(verified()); assert.equal(events(st).filter((e) => e.type === 'prereq').length, 2);
  // the segment is part of the verified version too
  const mk = (segmentKey, url) => ({ type: 'plan', at: segmentKey + url, action: 'a', metric: 'm', campaign: { segment: segmentKey, url } });
  const evs = [mk('reactivate', 'u1'), { type: 'prereq', at: 'p', planAt: 'reactivateu1', code: 'recipientsAndLink' }, mk('loyal', 'u1')];
  evs[0].at = '2026-01-01T00:00:01.000Z'; evs[1].planAt = evs[0].at; evs[2].at = '2026-01-01T00:00:03.000Z';
  assert.equal(ui.ctx.opPrereqValid(evs, 'recipientsAndLink'), false, 'another segment: verify again'); evs[2].campaign.segment = 'reactivate'; assert.equal(ui.ctx.opPrereqValid(evs, 'recipientsAndLink'), true);
});

test('CA-4 "Marquer comme envoyée": the real date, the version sent and, when known, the recipients actually targeted; a double click or a reload records once; the recipients can be added by a correction', async () => {
  setClock(SEND_DAY); const st = store(); const ui = await open([reactivation()], st); click(primary(ui)); savePlan(ui); click(primary(ui)); // prerequisite confirmed
  assert.equal(text(primary(ui)), 'Marquer comme envoyée'); const planAt = events(st).find((e) => e.type === 'plan').at;
  click(primary(ui)); click(primary(ui)); // double click
  let sent = events(st).filter((e) => e.type === 'applied'); assert.equal(sent.length, 1); assert.deepEqual([sent[0].date, sent[0].planAt, sent[0].recipients, sent[0].prerequisites], [local(), planAt, null, 'confirmed']);
  assert.equal(state(ui), `Envoyée le ${local()} (déclarée par vous)`); const t = text(row(ui)); assert.ok(t.includes('version du') && t.includes('Destinataires ciblés : non renseigné.'));
  const reloaded = await open([reactivation()], st); assert.equal(events(st).filter((e) => e.type === 'applied').length, 1); assert.equal(state(reloaded), `Envoyée le ${local()} (déclarée par vous)`);
  const f = form(row(reloaded), 'applied'); assert.ok(text(f).includes('Date d’envoi') && text(f).includes('Destinataires effectivement ciblés (facultatif)') && text(f).includes('Corriger l’envoi'));
  named(f, 'sentOn' in {} ? 'sentOn' : 'recipients').valueAsNumber = 64; all(f, (n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'date')[0].value = local(); submit(f); submit(f);
  sent = events(st).filter((e) => e.type === 'applied'); assert.equal(sent.length, 2, 'the recipients make it a correction, once'); assert.equal(sent.at(-1).recipients, 64); assert.ok(norm(text(row(reloaded))).includes('Destinataires ciblés : 64 (saisis par vous).'));
  const bad = form(row(reloaded), 'applied'); all(bad, (n) => n.tagName === 'INPUT' && n.getAttribute('name') === 'recipients')[0].valueAsNumber = -5; all(bad, (n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'date')[0].value = local(); submit(bad); assert.equal(events(st).filter((e) => e.type === 'applied').length, 2, 'negative recipients refused');
  assert.ok(norm(text(all(row(reloaded), (n) => hasClass(n, 'gv-campaign-summary'))[0])).includes('Clients dans le segment (analyse) · 70'), 'the 64 targeted recipients never replace the 70 customers of the analysed segment');
});

test('CA-5 "À revoir": a sent campaign whose review date is reached is listed (also when the opportunity is gone), survives a reload, stays isolated per merchant', async () => {
  const st = store(); const ui = await open([reactivation()], st); flow(ui);
  const live = await open([reactivation()], st); assert.ok(dueEntry(live) && text(all(dueEntry(live), (n) => n.tagName === 'SUMMARY')[0]).startsWith('À revoir (1)'));
  const gone = await open([], st); assert.ok(dueEntry(gone), 'the opportunity left the list, the campaign did not'); assert.ok(text(reviewLine(gone)).includes('Clients à réactiver : 70 clients') && text(reviewLine(gone)).includes('Revue prévue le 2026-11-16'));
  assert.equal(dueEntry(await open([reactivation()], st, { scope: 'merchant-b' })), null); assert.ok([...st.m.keys()].every((k) => k.startsWith('nordla.growth.follow-up.v1:merchant-a:')));
  const future = store(); const u2 = await open([reactivation()], future); click(primary(u2)); savePlan(u2, { reviewDate: '2999-01-01' }); click(primary(u2)); click(primary(u2)); assert.equal(dueEntry(await open([reactivation()], future)), null, 'a future review is not due');
  const unsent = store(); const u3 = await open([reactivation()], unsent); click(primary(u3)); savePlan(u3); assert.equal(dueEntry(await open([reactivation()], unsent)), null, 'a prepared campaign that was not sent is not a review to do');
});

test('CA-6 the review: measures typed from the sending tool with their source and period; the click rate only when delivered e-mails are known and above zero; attributed orders are not additional sales; kept with the version sent, after a reload too', async () => {
  const st = store(); const ui = await open([reactivation()], st); flow(ui); const planAt = events(st).find((e) => e.type === 'plan').at;
  const due = await open([reactivation()], st); click(all(reviewLine(due), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]);
  const f = form(reviewLine(due), 'campaign-review'); assert.ok(f, 'the campaign has its own review form'); const set = (k, v) => { named(f, k).value = v; }; const setn = (k, v) => { named(f, k).valueAsNumber = v; };
  assert.ok(text(f).includes('Commandes attribuées à la campagne (si l’outil les fournit)') && text(f).includes('Les commandes attribuées sont celles que l’outil d’envoi rattache à la campagne : ce ne sont pas des ventes supplémentaires.'));
  set('mSource', 'Klaviyo'); set('mStart', '2026-11-04'); set('mEnd', '2026-11-11'); setn('mDelivered', 61); setn('mClicks', 5); setn('mOrders', 1); set('mNotes', 'Envoi du 4 novembre'); submit(f); await tick();
  const rv = events(st).find((e) => e.type === 'review'); assert.deepEqual(rv.campaign, { source: 'Klaviyo', periodStart: '2026-11-04', periodEnd: '2026-11-11', delivered: 61, clicks: 5, orders: 1, clickRate: 0.082 }); assert.equal(rv.planAt, planAt, 'kept with the version that was sent'); assert.equal(rv.quality, 'comparable');
  assert.equal(dueEntry(await open([reactivation()], st)), null, 'reviewed: out of the list, history kept');
  const check = (ui2, where) => { const t = text(all(row(ui2), (n) => hasClass(n, 'gv-campaign-measures'))[0]); for (const s of ['Source : Klaviyo · période du 2026-11-04 au 2026-11-11', 'E-mails délivrés : 61', 'Clics uniques : 5', 'Taux de clic : 8,2 %', 'Commandes attribuées : 1', 'version envoyée du', 'ne conclut pas à un gain causé par la campagne']) assert.ok(t.replace(/ | /g, ' ').includes(s), `${where}: ${s}\n${t}`); assert.ok(!/ventes supplémentaires : \d|gain de|\+\d+ commandes/.test(t), `${where}: no incremental claim`); };
  const reloaded = await open([reactivation()], st); check(reloaded, 'after reload'); assert.equal(state(reloaded), 'Résultat mesuré');
  assert.ok(text(all(row(reloaded), (n) => hasClass(n, 'gr-follow-body'))[0]).replace(/ | /g, ' ').includes('Source : Klaviyo · période du 2026-11-04 au 2026-11-11 · E-mails délivrés 61 · Clics uniques 5 · Taux de clic 8,2 % · Commandes attribuées 1 · version envoyée du'), 'the history of the sent version carries the figures and the source');
});

test('CA-7 missing or impossible measures: absent data is "indisponible", no click rate without delivered e-mails above zero, impossible figures are refused, the review can still be saved', async () => {
  const run = async (fill) => {
    const st = store(); const ui = await open([reactivation()], st); flow(ui);
    const due = await open([reactivation()], st); click(all(reviewLine(due), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); const f = form(reviewLine(due), 'campaign-review');
    const set = (k, v) => { named(f, k).value = v; }; const setn = (k, v) => { named(f, k).valueAsNumber = v; }; set('mSource', 'Mailchimp'); set('mStart', '2026-11-04'); set('mEnd', '2026-11-11'); set('mNotes', ''); fill({ set, setn }); submit(f); await tick();
    return { st, ui: await open([reactivation()], st), saved: events(st).find((e) => e.type === 'review') };
  };
  const none = await run(() => {}); assert.deepEqual(none.saved.campaign, { source: 'Mailchimp', periodStart: '2026-11-04', periodEnd: '2026-11-11', delivered: null, clicks: null, orders: null, clickRate: null });
  const t0 = text(all(row(none.ui), (n) => hasClass(n, 'gv-campaign-measures'))[0]); assert.ok(t0.includes('E-mails délivrés : indisponible') && t0.includes('Taux de clic : indisponible (e-mails délivrés inconnus ou nuls)') && t0.includes('Commandes attribuées : indisponible'), t0); assert.equal(none.saved.quality, 'insufficient'); assert.equal(state(none.ui), 'Résultat non concluant');
  const clicksOnly = await run(({ setn }) => setn('mClicks', 40)); assert.equal(clicksOnly.saved.campaign.clickRate, null, 'clicks without delivered e-mails: no rate');
  const zero = await run(({ setn }) => { setn('mDelivered', 0); setn('mClicks', 0); }); assert.equal(zero.saved.campaign.clickRate, null, 'delivered = 0: never a division by zero'); assert.equal(zero.saved.campaign.delivered, 0);
  const noOrders = await run(({ setn }) => { setn('mDelivered', 800); setn('mClicks', 20); }); assert.deepEqual([noOrders.saved.campaign.clickRate, noOrders.saved.campaign.orders], [0.025, null]); assert.ok(text(all(row(noOrders.ui), (n) => hasClass(n, 'gv-campaign-measures'))[0]).includes('Commandes attribuées : indisponible'));
  for (const [label, fill] of [['clicks above delivered', ({ setn }) => { setn('mDelivered', 10); setn('mClicks', 11); }], ['negative', ({ setn }) => setn('mDelivered', -1)], ['decimal', ({ setn }) => setn('mDelivered', 10.5)], ['end before start', ({ set }) => { set('mStart', '2026-11-09'); set('mEnd', '2026-11-07'); }], ['start before the send', ({ set }) => set('mStart', '2026-11-03')], ['future end', ({ set }) => set('mEnd', '2999-01-01')], ['no source', ({ set }) => set('mSource', '')]]) {
    const r = await run(fill); assert.equal(r.saved, undefined, label);
  }
});

test('CA-8 reactivation and loyalty: each has its own draft and reason; FR / NL / EN: no raw key, the campaign wording is translated', async () => {
  const st = store(); const ui = await open([loyalty()], st); assert.match(named(form(row(ui, 'audience:segment:loyal'), 'plan'), 'subject').getAttribute('value'), /Merci de revenir chez nous/);
  for (const [lang, probes] of [['nl', ['Segment · ', 'Waarom dit segment', 'Klanten in het segment (analyse)', 'dit is geen aantal ontvangers', 'Growth kent de lijst van toegestane ontvangers niet', 'E-mailconcept (aanpasbaar)']], ['en', ['Segment · ', 'Why this segment', 'Customers in the segment (analysis)', 'this is not a number of recipients', 'Growth does not have the eligible send list', 'Email draft (editable)']], ['fr', ['Segment · ', 'Pourquoi ce segment', 'Clients dans le segment (analyse)', 'ce n’est pas un nombre de destinataires', 'Growth ne connaît pas la liste d’envoi admissible', 'Brouillon d’e-mail (modifiable)']]]) {
    const s2 = store(); const u = await open([reactivation()], s2, { lang }); flow(u);
    const due = await open([reactivation()], s2, { lang }); click(all(reviewLine(due), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]);
    const t = text(due.root); for (const p of probes) assert.ok(t.includes(p), `${lang}: ${p}`); assert.ok(!/gr\.(mail|follow|review|wk|fiche)\.[\w.]+/.test(t), `${lang}: raw key`);
    assert.ok(/Mark as sent|Markeren als verzonden|Marquer comme envoyée/.test(t) || /Sent on|Verzonden op|Envoyée le/.test(t));
  }
});

/** A campaign sent on 4 Nov and reviewable on 16 Nov, ready to be reviewed: returns the store and the open review form. */
async function dueForm(o = {}) {
  const st = store(); const ui = await open([reactivation()], st); flow(ui, o); const due = await open([reactivation()], st);
  click(all(reviewLine(due), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); return { st, due, f: form(reviewLine(due), 'campaign-review') };
}
const fillReview = (f, { start = SEND_DAY, end = '2026-11-11' } = {}) => { const set = (k, v) => { named(f, k).value = v; }; const setn = (k, v) => { named(f, k).valueAsNumber = v; };
  set('mSource', 'Klaviyo'); set('mStart', start); set('mEnd', end); setn('mDelivered', 61); setn('mClicks', 5); setn('mOrders', 1); set('mNotes', 'Envoi du 4 novembre'); };

test('CA-9 REGRESSION the measurement period cannot start before the real send date recorded for the reviewed version', async () => {
  const { st, due, f } = await dueForm({ recipients: 64 }); // plan 2 Nov, sent 4 Nov, 64 targeted of 70 customers
  fillReview(f, { start: '2026-11-03' }); submit(f); await tick();
  assert.equal(events(st).filter((e) => e.type === 'review').length, 0, 'nothing saved'); const msg = text(all(reviewLine(due), (n) => n.getAttribute?.('role') === 'status')[0]);
  assert.equal(msg, 'La période de mesure commence le 2026-11-03, avant l’envoi du 2026-11-04. Elle doit commencer le jour de l’envoi ou après.');
  fillReview(f, { start: SEND_DAY }); submit(f); await tick(); const rv = events(st).find((e) => e.type === 'review'); assert.ok(rv, 'the send day itself is accepted');
  assert.deepEqual([rv.applied, rv.campaign.periodStart, rv.campaign.periodEnd, rv.campaign.delivered, rv.campaign.clickRate], [SEND_DAY, SEND_DAY, '2026-11-11', 61, 0.082]);
  // no recorded send: no measures either
  const st2 = store(); const ui = await open([reactivation()], st2); setClock(PLAN_DAY); click(primary(ui)); savePlan(ui); const f2 = form(row(ui), 'campaign-review'); if (f2) { fillReview(f2); submit(f2); await tick(); }
  assert.equal(events(st2).filter((e) => e.type === 'review').length, 0, 'a campaign that was not declared sent has no review');
});

test('CA-10 REGRESSION declaring or correcting the send date: the planned review must come after it, and a date that contradicts a recorded review is refused with the history untouched', async () => {
  // planned review before the send
  const st = store(); const ui = await open([reactivation()], st); setClock(PLAN_DAY); click(primary(ui)); savePlan(ui, { reviewDate: '2026-11-03' }); click(primary(ui)); setClock(SEND_DAY); click(primary(ui));
  assert.equal(events(st).filter((e) => e.type === 'applied').length, 0); assert.equal(status(ui), 'La revue est prévue le 2026-11-03, avant ou le jour de l’envoi du 2026-11-04. Modifiez la date de revue du plan ou la date d’envoi.');
  // correction of an existing send date to one after the planned review
  const ok = store(); const u = await open([reactivation()], ok); flow(u); const f = form(row(u), 'applied'); all(f, (n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'date')[0].value = '2026-11-16'; submit(f);
  assert.equal(events(ok).filter((e) => e.type === 'applied').length, 1); assert.ok(status(u).includes('avant ou le jour de l’envoi du 2026-11-16'));
  // a recorded review (period from 4 Nov): moving the send to 6 Nov (before the planned 16 Nov review) contradicts it
  const { st: s3, due, f: rf } = await dueForm(); fillReview(rf); submit(rf); await tick(); const before = JSON.stringify([...s3.m.entries()]);
  const row3 = row(await open([reactivation()], s3)); const u3 = await open([reactivation()], s3); const af = form(row(u3), 'applied');
  all(af, (n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'date')[0].value = '2026-11-06'; submit(af);
  assert.equal(JSON.stringify([...s3.m.entries()]), before, 'history untouched: no new send event, the review keeps its figures');
  assert.equal(status(u3), 'Un envoi au 2026-11-06 contredit la revue déjà enregistrée, dont la période de mesure commence le 2026-11-04. Rien n’a été modifié : corrigez d’abord la période de la revue.');
  // an earlier correction (3 Nov) does not contradict the review and is accepted
  const u4 = await open([reactivation()], s3); const bf = form(row(u4), 'applied'); all(bf, (n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'date')[0].value = '2026-11-03'; submit(bf);
  assert.equal(events(s3).filter((e) => e.type === 'applied').at(-1).date, '2026-11-03'); assert.equal(events(s3).filter((e) => e.type === 'review').length, 1, 'the review is kept');
  assert.ok(row3);
});

test('CA-11 once the review is recorded, its title and its note appear once; the demo chronology keeps the segment (70), the targeted (64) and the delivered (61) apart', async () => {
  const { st, f } = await dueForm({ recipients: 64 }); fillReview(f); submit(f); await tick(); const ui = await open([reactivation()], st);
  const body = row(ui); const t = norm(text(body));
  assert.equal(t.split('Mesures de la campagne').length - 1, 1, 'title once'); assert.equal(t.split('ne conclut pas à un gain causé par la campagne').length - 1, 1, 'note once');
  assert.ok(t.includes('Clients dans le segment (analyse) · 70') && t.includes('Destinataires ciblés : 64 (saisis par vous).') && t.includes('E-mails délivrés : 61'));
  assert.deepEqual([events(st).find((e) => e.type === 'plan').at.slice(0, 10), events(st).find((e) => e.type === 'applied').date, events(st).find((e) => e.type === 'review').campaign.periodStart], [PLAN_DAY, SEND_DAY, SEND_DAY], 'plan, then send, then the window starts at the send');
});
