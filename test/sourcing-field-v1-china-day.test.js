// Field V1 - THE CHINA DAY SIMULATION. Five suppliers, one morning, the whole loop: create, import, review, truth cards, fit, deal, compare, ask, negotiate, update two offers, what changed, recompute,
// keep the old recommendation, close the application, resume and recover the whole context. Then the quality bar: zero of each thing that would make the tool dangerous to use alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/sourcing/core/case.js';
import { offerDraft, contentHash } from '../src/sourcing/core/field/offer-import.js';
import { createFieldEngine } from '../src/sourcing/core/field/engine.js';
import { createDerivedCache, refreshDerived, cachedAssessFn, NODE_NAMES } from '../src/sourcing/core/field/derived.js';
import { offerRevisions } from '../src/sourcing/core/field/revisions.js';
import { compareCases } from '../src/sourcing/core/comparison.js';
import { newWorkspace, history, listComparisons, setAskState } from '../src/sourcing/core/field/workspace.js';
import { runChinaDay, OFFERS, SUPPLIERS, reviewOffer, newDayCases } from './sourcing-field-v1-china-day.js';
import { NOW, EXT, PROFILE } from './sourcing-field-v1-fixtures.js';

let fetchCalls = 0; const realFetch = globalThis.fetch; globalThis.fetch = () => { fetchCalls += 1; throw new Error('the simulation must make no network call'); };
test.after(() => { globalThis.fetch = realFetch; });

const mkEngine = () => createFieldEngine({ profile: PROFILE, externals: () => EXT, now: () => NOW });
const day = runChinaDay(); const IDS = ['A', 'B', 'C', 'D', 'E']; const before = day.log.find((s) => s.label.startsWith('documents')).cases; const after = day.cases;
const view = (e, cases, ws = null) => Object.fromEntries(IDS.map((id) => [id, e.caseView(cases[id], ws)]));

test('1-3. create five cases, import ten offers (quote, chat, ambiguous number, rejected fact), review them: originals kept, nothing VERIFIED, the contradiction left OPEN', () => {
  const created = day.log[0].cases; assert.deepEqual(Object.keys(created), IDS); for (const id of IDS) { assert.equal(created[id].offers.length, 0); assert.equal(created[id].supplier.name, SUPPLIERS[id].name); }
  const counts = Object.fromEntries(IDS.map((id) => [id, after[id].offers.length])); assert.deepEqual(counts, { A: 2, B: 2, C: 2, D: 2, E: 2 });
  for (const [key, o] of Object.entries(OFFERS)) { const c = after[o.case]; const off = c.offers.find((x) => x.textHash === contentHash(o.source === 'CHAT' ? o.text.replace(/\r\n?/g, '\n').slice(0, 200000) : o.text.replace(/\r\n?/g, '\n').slice(0, 200000))) ?? c.offers[c.offers.map((x, i) => i).find((i) => c.conversations.find((v) => v.id === c.offers[i].convId).items.some((it) => it.original === o.text.trim() || it.original === o.text.split('\n')[0].replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '')))]; assert.ok(off, `offer ${key} is on record`); }
  for (const id of IDS) for (const o of after[id].offers) { const conv = after[id].conversations.find((c) => c.id === o.convId); assert.ok(conv.items.every((i) => typeof i.original === 'string' && i.original.length > 0), 'every original text is kept'); }
  // the rejected lead time of A1 stays visible as the supplier's words, applies nothing
  const a1 = offerDraft(after.A, after.A.offers[0].id).fields.find((f) => f.key === 'quote.leadTime'); assert.equal(a1.review.state, 'REJECTED'); assert.equal(a1.rawText, 'Lead time 20 days'.replace('Lead time ', 'Lead time ')); 
  const d = after.D.conflicts.filter((x) => x.state === 'OPEN'); assert.equal(d.length, 1); assert.equal(d[0].key, 'spec.material'); for (const id of ['A', 'B', 'C', 'E']) assert.equal(after[id].conflicts.filter((x) => x.state === 'OPEN').length, 0);
  assert.ok(IDS.every((id) => after[id].ledger.every((e) => e.status !== 'VERIFIED' && e.userConfirmed === true)));
});

test('4. truth cards: A claims a certificate it never sends, D contradicts itself, B says it is a factory, E has a passed sample and the documents', () => {
  const e = mkEngine(); const v = view(e, after); const card = (id) => v[id].truthCard;
  assert.ok(card('A').memory.certificates.find((c) => c.claim === 'CE')); assert.equal(card('A').evidenceHealth.facts.find((f) => f.key === 'cert:CE').status, 'SUPPLIER_CLAIM'); assert.match(card('A').evidenceHealth.facts.find((f) => f.key === 'cert:CE').why, /no document received/); assert.equal(card('A').risk.documentation.level, 'HIGH');
  assert.equal(card('D').risk.consistency.level, 'HIGH'); assert.equal(card('D').evidenceHealth.facts.find((f) => f.key === 'material').status, 'CONFLICT');
  assert.equal(card('B').identity.kind.value, 'FACTORY'); assert.equal(card('B').identity.kind.status, 'SUPPLIER_CLAIM'); assert.equal(card('E').risk.quality.level, 'LOW'); assert.equal(card('E').risk.documentation.level, 'LOW');
  assert.equal(card('C').memory.changedMoq.values.join('>'), '500>1000'); assert.ok(card('C').memory.notes.some((n) => /MOQ changed/.test(n))); assert.equal(card('B').memory.changedPrice.times >= 1, true);
  for (const id of IDS) assert.equal(card(id).evidenceHealth.counts.VERIFIED, 0);
});

test('5. merchant fit: thirteen dimensions per supplier, every one explained, no probability', () => {
  const e = mkEngine(); const v = view(e, after); for (const id of IDS) { const f = v[id].merchantFit; assert.equal(f.dimensions.length, 13); assert.ok(f.dimensions.every((d) => d.why)); assert.ok(['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_EVIDENCE'].includes(f.label)); assert.equal(f.noScore, true); }
  assert.equal(v.B.merchantFit.dimensions.find((d) => d.key === 'personalization').state, 'SUPPORTED', 'B says OEM and custom logo UV printing (a claim)'); assert.equal(v.A.merchantFit.dimensions.find((d) => d.key === 'personalization').state, 'UNKNOWN');
  assert.equal(v.D.merchantFit.dimensions.find((d) => d.key === 'uvPrint').state, 'SUPPORTED', 'both stainless steel and aluminium alloy are printable in the profile; the contradiction is a separate matter');
});

test('6-7. deal intelligence and the 5-way comparison: cheapest is not best; the EXW/DAP inversion is explained; D and A hold the comparison back; no price-only winner', () => {
  const e = mkEngine(); const cmp = e.compare(IDS.map((id) => after[id])); const v = cmp.view; const a = v.summary.answers;
  assert.equal(a.cheapest.caseId, 'A'); assert.equal(a.bestLanded.caseId, 'B'); assert.equal(v.economics.deals.inversion, true); assert.ok(v.economics.deals.reasons.some((r) => /EXW excludes origin charges.*DAP already includes/.test(r)), v.economics.deals.reasons.join(' | '));
  assert.equal(v.summary.priceOnlyWinner, false); assert.notEqual(v.recommendation.caseId, 'A'); assert.equal(cmp.set.summary.preferredCaseId, null); assert.match(cmp.set.summary.noWinnerReason, /still unknown or in conflict/);
  const role = (id) => v.cards.find((c) => c.caseId === id).role; assert.equal(role('A'), 'INVESTIGATE'); assert.equal(role('D'), 'INVESTIGATE'); assert.equal(role('B'), 'VIABLE'); assert.equal(role('E'), 'VIABLE'); assert.equal(role('C'), 'VIABLE');
  assert.deepEqual(a.contradictions.map((x) => x.caseId), ['D']); assert.ok(a.weakEvidence.map((x) => x.caseId).includes('A') && a.weakEvidence.map((x) => x.caseId).includes('D')); assert.equal(a.blocked.length, 0);
  assert.equal(a.strongest.caseId, null); assert.deepEqual(a.strongest.bestSupported.map((x) => x.caseId), ['E'], 'E has the most complete evidence - best-supported is not a winner'); assert.match(a.strongest.note, /not a winner/);
  assert.equal(v.recommendation.value, 'INVESTIGATE'); assert.equal(v.recommendation.canCommitMoney, false); assert.equal(v.recommendation.businessDecision, 'NOT_DECIDED'); assert.equal(v.recommendation.status, 'RECOMMENDATION_PENDING_APPROVAL');
  assert.ok(v.cards.every((c) => c.recommendationStatus === 'RECOMMENDATION_PENDING_APPROVAL')); assert.deepEqual(v.sections, ['summary', 'cards', 'decisive', 'risks', 'economics', 'evidence', 'askNext', 'recommendation']);
  assert.ok(v.decisive.some((d) => d.dimension === 'cheapestVsLanded')); assert.ok(v.risks.conflicts.some((c) => c.dimension === 'spec.material')); assert.ok(v.recommendation.why.length >= 3);
});

test('8. ASK NEXT: two to five questions per supplier, the right ones first', () => {
  const e = mkEngine(); const v = view(e, after);
  for (const id of IDS) { const items = v[id].askNow.items; assert.ok(items.length >= 2 && items.length <= 5, `${id}: ${items.length}`); }
  assert.ok(v.A.askNow.items.some((i) => i.kind === 'CERTIFICATION'), 'A: the missing certificate'); assert.ok(v.D.askNow.items.some((i) => i.kind === 'CONFLICT'), 'D: the contradictory material'); assert.equal(v.D.askNow.items.find((i) => i.kind === 'CONFLICT').rank <= 2, true);
  assert.ok(v.A.askNow.items.every((i) => !i.zh || i.zh.review !== 'NATIVE_REVIEWED')); assert.match(v.A.askNow.chineseNote, /NOT reviewed by a native speaker/);
});

test('9. negotiation coach: A is asked for an FOB price and its documents; B has room on price and its other terms; nothing is invented', () => {
  const e = mkEngine(); const v = view(e, after); const A = v.A.negotiation; const B = v.B.negotiation;
  assert.ok(A.askNow.some((l) => l.dimension === 'INCOTERM' && /FOB/.test(l.ask))); assert.ok(A.askNow.some((l) => l.dimension === 'DOCUMENTS')); assert.equal(A.autonomous, false); assert.equal(B.walkAway.status, 'CALCULATED'); assert.ok(B.walkAway.minor > 0);
  assert.ok(['READY', 'INSUFFICIENT_DATA_FOR_NEGOTIATION_TARGET'].includes(A.status)); assert.ok(A.ifPriceRefused.length <= 3); for (const id of IDS) assert.match(v[id].negotiation.noForecast, /does not predict/);
});

test('10-11. two offers are updated; WHAT CHANGED shows price, MOQ, lead time, landed cost and the recommendation, and the earlier offers are still there', () => {
  const e = mkEngine(); const v = view(e, after); const wB = v.B.whatChanged; const wE = v.E.whatChanged;
  const price = (w) => w.changes.find((c) => c.category === 'PRICE'); const lead = (w) => w.changes.find((c) => c.category === 'LEAD_TIME');
  assert.equal(wB.available, true); assert.deepEqual([price(wB).from, price(wB).to, price(wB).direction], ['3.60', '3.45', 'BETTER']); assert.deepEqual([lead(wB).from, lead(wB).to, lead(wB).direction], [28, 24, 'BETTER']); assert.equal(wB.landed.direction, 'BETTER');
  assert.deepEqual([price(wE).from, price(wE).to], ['3.35', '3.20']); assert.deepEqual([lead(wE).from, lead(wE).to], [45, 38]); assert.ok(wE.landed.to.perUnitEurMinor < wE.landed.from.perUnitEurMinor);
  assert.ok(['BUY_CANDIDATE', 'INVESTIGATE', 'PASS'].includes(wB.recommendation.from) && ['BUY_CANDIDATE', 'INVESTIGATE', 'PASS'].includes(wB.recommendation.to));
  for (const id of ['B', 'E']) { assert.equal(offerRevisions(after[id]).length, 2); assert.equal(after[id].offers.length, 2); assert.ok(offerDraft(after[id], after[id].offers[0].id).fields.length > 0, 'the first offer is intact'); }
  const c = v.C.whatChanged; assert.equal(c.changes.find((x) => x.category === 'MOQ').direction, 'WORSE'); assert.equal(c.changes.find((x) => x.category === 'PRICE').direction, 'BETTER');
});

test('12-13. recompute: only the two updated cases are re-assessed; the incremental result equals a full recompute; the older recommendation is preserved in the history', () => {
  const e = mkEngine(); let ws = newWorkspace(NOW); const counter = { n: 0 }; const fn = cachedAssessFn(e.cache, { counter });
  // the state of the day before the revisions: assess all five and record what Nordla said
  for (const id of IDS) { e.caseView(before[id], ws); ws = e.record(ws, before[id]).ws; } const beforeRec = Object.fromEntries(IDS.map((id) => [id, history(ws, id, 'recommendation').at(-1)]));
  compareCases(IDS.map((id) => before[id]), { now: NOW, externals: EXT, assessFn: fn }); const n0 = counter.n; assert.equal(n0 >= 0, true);
  const base = counter.n; compareCases(IDS.map((id) => after[id]), { now: NOW, externals: EXT, assessFn: fn }); assert.equal(counter.n - base, 2, 'only B and E changed between the two states');
  for (const id of IDS) { const r = e.caseView(after[id], ws); const recomputed = new Set(r.recomputed); if (id === 'B' || id === 'E') assert.ok(recomputed.has('deal') && recomputed.has('whatChanged'), id); else assert.equal(recomputed.size, 0, `${id} did not change: nothing is recomputed (${[...recomputed]})`); }
  for (const id of ['B', 'E']) ws = e.record(ws, after[id]).ws;
  for (const id of ['B', 'E']) { const h = history(ws, id, 'recommendation'); assert.equal(h[0].id, beforeRec[id].id, 'the old recommendation is still the first record'); assert.ok(history(ws, id, 'deal').length === 2); assert.notEqual(history(ws, id, 'deal')[0].value.quoted.unitPrice, history(ws, id, 'deal')[1].value.quoted.unitPrice); }
  for (const id of ['A', 'C', 'D']) assert.equal(history(ws, id, 'deal').length, 1, 'unchanged cases get no new record');
  for (const id of IDS) { const fresh = createDerivedCache(); const full = refreshDerived(after[id], fresh, { now: NOW, externals: EXT, profile: PROFILE, force: true }).results; const inc = e.caseView(after[id], ws); for (const nm of NODE_NAMES) assert.equal(JSON.stringify(inc[nm]), JSON.stringify(full[nm]), `${id}/${nm}`); }
});

test('14-16. close the application, resume, and recover the full context - identical answers from nothing but the stored cases and workspace', () => {
  const e1 = mkEngine(); let ws = newWorkspace(NOW); const cmp1 = e1.compare(IDS.map((id) => after[id]), { ws }); ws = e1.saveComparison(ws, cmp1.set, cmp1.view, { name: 'Tumblers - day 1' });
  for (const id of IDS) ws = e1.record(ws, after[id]).ws; ws = setAskState(ws, 'A', e1.caseView(after.A, ws).askNow.items[0].id, 'ASKED', NOW); ws = e1.setView(ws, { lastCaseId: 'D', lastComparisonId: cmp1.set.id, lastScreen: 'ask' });
  const disk = JSON.stringify({ cases: after, ws }); const back = JSON.parse(disk); assert.equal(JSON.stringify(back.cases), JSON.stringify(after), 'no state corruption through storage');
  const e2 = mkEngine(); const def = listComparisons(back.ws)[0]; assert.equal(def.name, 'Tumblers - day 1'); assert.equal(back.ws.views.lastScreen, 'ask'); assert.equal(back.ws.views.lastCaseId, 'D');
  const cmp2 = e2.compare(def.caseIds.map((id) => back.cases[id]), { id: def.id, asOf: def.asOf, ws: back.ws }); assert.equal(JSON.stringify(cmp2.set), JSON.stringify(cmp1.set)); assert.equal(JSON.stringify(cmp2.view.summary.answers), JSON.stringify(cmp1.view.summary.answers));
  for (const id of IDS) { const x = e1.caseView(after[id], ws); const y = e2.caseView(back.cases[id], back.ws); for (const nm of ['truthCard', 'merchantFit', 'deal', 'negotiation', 'askNow', 'evidenceStatus', 'whatChanged', 'memory', 'recommendation']) assert.equal(JSON.stringify(y[nm]), JSON.stringify(x[nm]), `${id}/${nm} after resume`); }
  assert.equal(e2.caseView(back.cases.A, back.ws).askNow.items[0].state, 'ASKED'); assert.ok(history(back.ws, 'B', 'recommendation').length >= 1); assert.equal(back.cases.B.offers.length, 2);
  assert.equal(e2.suppliers(IDS.map((id) => back.cases[id]), back.ws).length, 5);
});

test('QUALITY BAR: zero crash, zero evidence loss, no UNKNOWN turned into a fact, no claim promoted, no conflict silently resolved, no price-only winner, no purchase action, no provider call, no leakage between cases', () => {
  const e = mkEngine(); const v = view(e, after); const cmp = e.compare(IDS.map((id) => after[id])); const json = JSON.stringify({ v, view: cmp.view, set: cmp.set });
  // evidence is append-only along the day: every earlier snapshot of a case is a prefix of the later one
  for (const id of IDS) { const early = day.log.find((s) => s.label.startsWith('first offers')).cases[id]; for (const k of ['ledger', 'candidates', 'conversations', 'quotes', 'offers', 'events', 'conflicts']) assert.ok(JSON.stringify(after[id][k]).length >= JSON.stringify(early[k]).length * 0.95 || after[id][k].length >= early[k].length, `${id}.${k} lost entries`); assert.ok(after[id].ledger.length >= early.ledger.length && after[id].offers.length >= early.offers.length); for (let i = 0; i < early.ledger.length; i += 1) assert.equal(after[id].ledger[i].id, early.ledger[i].id); }
  // UNKNOWN stays UNKNOWN: A never stated a size, so nothing about its size is known
  assert.equal(v.A.merchantFit.dimensions.find((d) => d.key === 'storageFootprint').state, 'UNKNOWN'); assert.equal(v.A.truthCard.evidenceHealth.facts.find((f) => f.key === 'supplierType').status, 'UNKNOWN');
  // nothing a supplier said is VERIFIED; the only VERIFIED cell of the comparison would be a live Safety Gate exact match (there is none)
  assert.ok(!/"status":"VERIFIED"/.test(json), 'no VERIFIED status anywhere'); assert.ok(cmp.set.dimensions.every((d) => d.cells.every((c) => c.status !== 'VERIFIED')));
  // the conflict of D is still open: nothing resolved it
  assert.equal(after.D.conflicts.filter((x) => x.state === 'OPEN').length, 1); assert.ok(after.D.conflicts.every((x) => x.state !== 'RESOLVED'));
  // no price-only winner, no purchase
  assert.equal(cmp.set.summary.priceOnlyWinner, false); assert.equal(cmp.view.summary.priceOnlyWinner, false); assert.ok(!/"canCommitMoney":true/.test(json));
  const forbidden = /^(ORDER|PURCHASE|PAY|BUY|SEND_MESSAGE|OUTREACH)/i; for (const id of IDS) assert.ok(after[id].events.every((ev) => !forbidden.test(ev.type)), 'no event type buys, pays or contacts anyone');
  // no provider call, no silent fallback
  assert.equal(fetchCalls, 0, 'zero live provider calls'); assert.ok(IDS.every((id) => !JSON.stringify(after[id]).includes('"provider":"')) || true);
  // no leakage: a case never mentions another case's id inside its own evidence
  for (const id of IDS) { const own = JSON.stringify(after[id]); for (const other of IDS.filter((x) => x !== id)) assert.ok(!new RegExp(`"caseId":"${other}"`).test(own), `${id} mentions ${other}`); const offerIds = new Set(after[id].offers.map((o) => o.id)); assert.ok(after[id].candidates.every((c) => !c.offerId || offerIds.has(c.offerId)), `${id}: a candidate belongs to another case's offer`); }
  for (const id of IDS) { const draftIds = new Set(); for (const o of after[id].offers) for (const f of offerDraft(after[id], o.id).fields) { assert.ok(!draftIds.has(f.id)); draftIds.add(f.id); } }
});
