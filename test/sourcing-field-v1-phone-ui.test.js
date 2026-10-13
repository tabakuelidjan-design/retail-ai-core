// REAL PHONE FIX #1 - what the first physical-phone test showed on the SCREEN: English sentences in a French UI, a compliance block that filled the phone, and ASK NEXT cards too long to scan.
// The views are pure HTML builders, so they are rendered here from the real-phone case and from the China Day cases and read as text. Supplier-facing English / Chinese (lang="en" / lang="zh-Hans")
// and the supplier's own words (translate="no", « ... ») are NOT the UI and are left out. Internal enum names / contracts are untouched (the core is not changed by this fix).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSalonViews } from './sourcing-salon-load.js';
import { runChinaDay } from './sourcing-field-v1-china-day.js';
import { createFieldEngine } from '../src/sourcing/core/field/engine.js';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { offerDraft } from '../src/sourcing/core/field/offer-import.js';
import { PROFILE, EXT, NOW } from './sourcing-field-v1-fixtures.js';
import { caseFacts, auditCase } from '../src/sourcing/core/case-facts.js';
import { REAL_PHONE_TEXT } from './sourcing-field-v1-phone-fixture.js';

const V = await loadSalonViews();
const { fr, BLOCK_CODE_FR } = await import('../src/sourcing/ui/screens/salon-fr.js');
const NAMES = ['Yiwu Brightcup Trading Co.', 'Ningbo Harbor Drinkware Co.', 'Yongkang Steelware Factory', 'Dongguan Metalware Ltd', 'Zhejiang Stainless Industry Co.', 'Shenzhen Powerco'];
const ENGLISH = /\b(the|is|are|not|with|from|for|and|of|to|has|have|was|were|cannot|unknown|missing|usable|get|enter|ask|request|before|after|only|which|that|this|there|when|because|than|more|less|cost|price|quote|landed|unit|number|clear|weak|evidence|assessment|conclude|yet|leaving|lower-impact|can|wait|no|margin|blocked|required|statements?|differs?)\b/i;
const ENUM_CODE = /\b[A-Z]{2,}_[A-Z_]+\b/;
const visible = (html) => { let x = html; for (let i = 0; i < 5; i += 1) x = x.replace(/<(\w+)[^>]*\b(?:lang="(?:en|zh-Hans)"|translate="no")[^>]*>[\s\S]*?<\/\1>/g, ' '); return NAMES.reduce((h, n) => h.split(n).join('NAME'), x.replace(/<[^>]+>/g, '\n')).replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/«[^»]*»/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean); };
const englishIn = (html) => visible(html).filter((l) => ENGLISH.test(l) || ENUM_CODE.test(l));

const info = (c) => ({ caseId: c.id, title: c.identity?.workingName || c.id, supplier: c.supplier?.name ?? null, sample: { status: 'NONE' }, numbers: {} });
function phoneCase() { let c = newCase({ id: 'cp', name: 'Chargeur 45W', now: NOW }); c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: REAL_PHONE_TEXT, supplier: 'Shenzhen Powerco' }, NOW); return c; }
const engines = () => ({ withProfile: createFieldEngine({ profile: PROFILE, externals: () => EXT, now: () => NOW }), noProfile: createFieldEngine({ profile: null, externals: () => ({}), now: () => NOW }) });

test('UI_LANGUAGE_FR: no screen of the Salon shows an English sentence or a raw engine code (real-phone case + China Day, with and without a merchant profile)', () => {
  const day = runChinaDay().cases; const cases = { phone: phoneCase(), ...day }; const E = engines(); const left = new Map();
  const scan = (label, html) => { for (const l of englishIn(html)) left.set(l, label); };
  for (const [id, c] of Object.entries(cases)) for (const [tag, e] of Object.entries(E)) {
    const v = e.caseView(c, null); const hist = e.suppliers([c], null)[0];
    for (const tab of ['sum', 'facts', 'truth', 'fit', 'deal', 'changed', 'mem', 'more']) scan(`case:${id}:${tab}:${tag}`, V.caseHtml({ info: info(c), tab, v, history: hist, factsView: { facts: caseFacts(c), audit: auditCase(c), observations: [], editing: tab === 'facts' ? 'MOQ' : null, caseId: c.id } }));
    scan(`ask:${id}`, V.askHtml({ info: info(c), ask: v.askNow })); scan(`neg:${id}:${tag}`, V.negotiateHtml({ info: info(c), plan: v.negotiation }));
    scan(`review:${id}`, V.reviewHtml({ draft: offerDraft(c, c.offers.at(-1).id), caseInfo: info(c), groupableIds: [], conflicts: [], unknownNames: [], correcting: null }));
  }
  const e = E.withProfile; scan('compare', V.compareHtml({ view: e.compare(['A', 'B', 'C', 'D', 'E'].map((k) => cases[k]), {}).view, saved: false }));
  scan('compare-sparse', V.compareHtml({ view: E.noProfile.compare([cases.A, cases.phone], {}).view, saved: false }));
  scan('home', V.homeHtml({ overview: e.overview(Object.values(cases), null), comparisons: [], selected: [], resume: null, online: true, ws: { views: {} } }));
  assert.deepEqual([...left].map(([l, w]) => `[${w}] ${l}`), [], 'English text is still on a screen: add a rule to salon-fr.js (or translate it at its place)');
});

test('UI_LANGUAGE_FR: the sentences the phone test showed are now French; the contracts (enum names, engine sentences) are unchanged', () => {
  const E = engines().noProfile; const c = phoneCase(); const v = E.caseView(c, null); const html = [...['sum', 'truth', 'fit', 'deal', 'more'].map((tab) => V.caseHtml({ info: info(c), tab, v, history: null })), V.askHtml({ info: info(c), ask: v.askNow }), V.compareHtml({ view: E.compare([c, runChinaDay().cases.A], {}).view, saved: false })].join('\n');
  const text = visible(html).join('\n');
  for (const en of ['assessment cannot conclude yet', 'landed cost unknown', 'no usable unit price', 'get the exact model number', 'get a clear unit price', 'questions before leaving the stand', 'lower-impact', 'evidence too weak', 'margin unknown']) assert.ok(!text.includes(en), `still English: ${en}`);
  assert.match(text, /l'évaluation ne peut pas encore conclure/); assert.match(text, /coût rendu inconnu/); assert.match(text, /aucun prix unitaire utilisable/); assert.match(text, /obtenir le numéro de modèle exact/); assert.match(text, /\d+ questions? avant de quitter le stand/); assert.match(text, /moins importantes? peuvent? attendre|moins importante peut attendre/); assert.match(text, /preuves trop faibles/); assert.match(text, /marge inconnue/);
  assert.equal(v.evidenceStatus.blocking[0], 'the exact product (model) is not established', 'the engine sentence (and its contract) is untouched'); assert.equal(v.assessment.decision.verdict, 'INSUFFICIENT_INFORMATION'); assert.ok(v.askNow.message.includes('before leaving the stand'));
  assert.equal(fr('a sentence that no rule knows'), 'a sentence that no rule knows', 'an unknown sentence is returned unchanged (and the coverage test above then fails)');
});

test('COMPLIANCE_MOBILE_SUMMARY: first level = a title and 2-4 short words; every detail and every gate is still there behind "Voir les détails"', () => {
  const E = engines().noProfile; const c = phoneCase(); const v = E.caseView(c, null);
  const sum = V.blockerSummary(v.evidenceStatus, v.assessment);
  assert.match(sum.title, /^Bloqué — \d+ éléments? critiques? (manquants?|à régler)$/); assert.ok(sum.labels.length >= 2 && sum.labels.length <= 4, `short list: ${sum.labels}`);
  for (const l of ['Modèle exact', 'Prix unitaire']) assert.ok(sum.labels.includes(l), l);
  assert.equal(sum.labels.length, new Set(sum.labels).size, 'no duplicate word');
  const html = V.blockerHtml(v.evidenceStatus, v.assessment); assert.match(html, /<details class="sl-blkd"><summary>Voir les détails<\/summary>/);
  const first = html.slice(0, html.indexOf('<details')); assert.ok(visible(first).join(' ').length < 200, 'the first level is short enough for a phone');
  // nothing was dropped: every engine reason, every hard blocker code and its detail are in the disclosure
  const det = html.slice(html.indexOf('<details')); const dt = visible(det).join('\n');
  for (const b of v.evidenceStatus.blocking) assert.ok(dt.includes(fr(b)), `blocking reason kept: ${b}`);
  for (const b of v.assessment.decision.hardBlockers) { const label = BLOCK_CODE_FR[b.code]; assert.ok(label, `a French label exists for ${b.code}`); assert.ok(dt.toLowerCase().includes(label.toLowerCase()), `hard blocker kept in the details: ${b.code}`); assert.ok(dt.includes(fr(b.detail)), `its detail is kept: ${b.detail}`); }
  assert.equal(v.assessment.decision.canCommitMoney, false); assert.ok(v.assessment.decision.hardBlockers.length >= 3, 'no gate was weakened: the three hard blockers are still produced by the engine');
  assert.ok(V.caseHtml({ info: info(c), tab: 'sum', v, history: null }).includes('class="sl-blk"'), 'the case summary uses the compact block');
  // required documents (the standards) stay reachable: China Day case D lacks the food-contact declaration and the migration report
  const d = runChinaDay().cases.D; const vd = createFieldEngine({ profile: PROFILE, externals: () => EXT, now: () => NOW }).caseView(d, null); const sd = V.blockerSummary(vd.evidenceStatus, vd.assessment);
  const hd = V.blockerHtml(vd.evidenceStatus, vd.assessment); const detailsPart = hd.slice(hd.indexOf('<details')); assert.match(detailsPart, /Documents à obtenir/); assert.match(detailsPart, /contact alimentaire/); assert.match(detailsPart, /migration/i); assert.ok(!hd.slice(0, hd.indexOf('<details')).includes('contact alimentaire'), 'the long document names are NOT on the first level');
  assert.ok(sd.docs.length >= 3, 'the missing documents are listed in the details'); assert.ok(sd.docs.some((x) => /contact alimentaire/.test(x)) && sd.docs.some((x) => /migration/i.test(x)));
  assert.ok(sd.labels.includes('Documents de conformité') && sd.labels.includes('Contradiction à lever'));
  assert.equal(V.blockerSummary({ blocking: [], blockingCodes: [] }, { decision: { hardBlockers: [], gaps: { missingDocs: [] } } }), null, 'nothing blocking, nothing shown');
});

test('ASK_NEXT_MOBILE_UX: title, one compact tag, EN, 中文, [Copier]; priority order kept; native-review warning kept; no long reason paragraph; no fake [Écouter]', () => {
  const E = engines().noProfile; const c = phoneCase(); const ask = E.caseView(c, null, ['askNow']).askNow; assert.ok(ask.items.length >= 2);
  const html = V.askHtml({ info: info(c), ask });
  const titles = [...html.matchAll(/<b>(\d+)\. ([^<]+)<\/b>/g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(titles.map((t) => t[0]), ask.items.map((i) => i.rank), 'the priority order is the engine order'); assert.equal(titles[0][1], 'Modèle exact'); const mf = ask.items.find((i) => i.id === 'manufacturer'); if (mf) assert.equal(titles.find((t) => t[0] === mf.rank)[1], 'Fabricant (nom et adresse)', 'the manufacturer question is not titled "Modèle exact"'); assert.equal(V.askTitle('IDENTITY', 'manufacturer'), 'Fabricant (nom et adresse)'); assert.equal(V.askTitle('IDENTITY', 'model'), 'Modèle exact');
  assert.equal([...html.matchAll(/class="sl-tag /g)].length, ask.items.length); for (const m of html.matchAll(/class="sl-tag [^"]+">([^<]+)</g)) assert.ok(['Bloquant pour conformité', 'Bloquant pour calcul', 'Important avant achat'].includes(m[1]), m[1]);
  assert.match(html, /<p class="sl-lang">EN<\/p><p class="sl-qen" lang="en">What is the exact model number/);
  assert.equal([...html.matchAll(/data-act="sl-copy"/g)].length, ask.items.length, 'one Copier per question'); assert.match(html, />Copier</);
  for (const i of ask.items) { assert.ok(!html.includes(i.whyFr), `the long reason is not shown: ${i.whyFr}`); if (i.zh) assert.ok(html.includes(`<p class="sl-lang">中文</p><p class="zh sl-qzh" lang="zh-Hans">${i.zh.text}`) || html.includes(i.zh.text), 'the Chinese line is shown'); }
  assert.ok(ask.items.some((i) => i.zh), 'the phrasebook has Chinese for the first questions'); assert.match(html, /PAS relu par un locuteur natif/, 'the native-review warning is kept');
  assert.ok(!/Écouter/.test(html), 'no listen button: no local text-to-speech exists in the app, so none is faked');
  assert.equal(V.askCopyText({ en: 'E', zh: { text: 'Z' } }), 'E\n\nZ'); assert.equal(V.askCopyText({ en: 'E', zh: null }), 'E');
  // the tags follow the kind of question
  assert.equal(V.askTag('IDENTITY'), 'Bloquant pour conformité'); assert.equal(V.askTag('PRICE'), 'Bloquant pour calcul'); assert.equal(V.askTag('LEAD_TIME'), 'Important avant achat'); assert.equal(V.askTitle('PRICE'), 'Prix unitaire');
  // the compact list on the case summary has the same pattern
  assert.match(V.caseHtml({ info: info(c), tab: 'sum', v: E.caseView(c, null), history: null }), /class="sl-tag /);
});

test('SOURCE_EVIDENCE_PRESERVED: the French layer only changes presentation; the English supplier questions, the engine data and the snapshots are the same', () => {
  const E = engines().withProfile; const c = phoneCase(); const v = E.caseView(c, null); const before = JSON.stringify(v.askNow.items.map((i) => ({ id: i.id, en: i.en, zh: i.zh, kind: i.kind })));
  V.askHtml({ info: info(c), ask: v.askNow }); V.caseHtml({ info: info(c), tab: 'truth', v, history: null });
  assert.equal(JSON.stringify(E.caseView(c, null).askNow.items.map((i) => ({ id: i.id, en: i.en, zh: i.zh, kind: i.kind }))), before, 'rendering changes nothing');
  assert.ok(v.askNow.items[0].en && /^What is the exact model/.test(v.askNow.items[0].en));
});
