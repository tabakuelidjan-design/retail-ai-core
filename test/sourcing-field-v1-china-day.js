// THE CHINA DAY SIMULATION (data + steps). One morning at a trade-fair hall: five suppliers of the same UV-printable tumbler, every kind of trouble a day brings. Everything is INVENTED.
//   A  cheapest quote, EXW, claims a certificate it never sends
//   B  higher quote, DAP (better Incoterm), lower landed cost
//   C  changes its MOQ between two offers
//   D  states two different materials
//   E  strongest evidence (documents, sample passed) but a much longer lead time
// The same builder feeds the unit simulation, the benchmarks and the 390 px browser test, so all of them tell the same story.
import { dispatch } from '../src/sourcing/core/case.js';
import { offerDraft } from '../src/sourcing/core/field/offer-import.js';
import { tumbler, withDocs, costsEvent, t } from './sourcing-field-v1-fixtures.js';

export const SUPPLIERS = Object.freeze({
  A: { name: 'Yiwu Brightcup Trading Co.', note: 'hall 2, stand B12' },
  B: { name: 'Ningbo Harbor Drinkware Co.', note: 'hall 1, stand A03' },
  C: { name: 'Yongkang Steelware Factory', note: 'hall 3, stand C21' },
  D: { name: 'Dongguan Metalware Ltd', note: 'hall 2, stand D07' },
  E: { name: 'Zhejiang Stainless Industry Co.', note: 'hall 1, stand A17' },
});

/** the texts the suppliers send, in the order the day brings them */
export const OFFERS = Object.freeze({
  A1: { case: 'A', source: 'PASTED_QUOTE', at: t(8, 10), text: 'Hello boss. Model TB-500 tumbler 500ml. Material: stainless steel 304. USD2.70 for 1000 pcs. MOQ 500 pcs. EXW Ningbo. Lead time 20 days. T/T 30% deposit, 70% before shipment. Packing: opp bag. Sample USD15. CE and RoHS reports available.' },
  A2: { case: 'A', source: 'CHAT', at: t(8, 40), text: '[10:05] Supplier: Sorry boss, the CE report is with our lab, I will send tomorrow.\n[10:06] Me: please send it before we decide\n[10:08] Supplier: ok, CE test report will be sent. Lead time 20 days.' },
  B1: { case: 'B', source: 'PASTED_QUOTE', at: t(8, 55), text: 'TB-500 tumbler. Material: stainless steel 304. 500-999pcs USD3.80, 1000+pcs USD3.60. MOQ 500. DAP Rotterdam. Lead time 28 days. T/T 30% deposit, 70% before shipment. Packing: gift box. Sample USD20, refundable. We are a factory. OEM and custom logo UV printing available. CE and RoHS available.' },
  C1: { case: 'C', source: 'PASTED_QUOTE', at: t(9, 20), text: 'Model TB-500. Material: stainless steel 304. USD3.10 for 1000 pcs. MOQ 500 pcs. FOB Ningbo. Lead time 22 days. T/T 30% deposit, 70% before shipment. Packing: opp bag. CE available.' },
  D1: { case: 'D', source: 'PASTED_QUOTE', at: t(9, 40), text: 'Model TB-500. Material: stainless steel 304. USD3.25 for 1000 pcs. MOQ 500 pcs. FOB Shenzhen. Lead time 25 days. T/T 30% deposit. Packing: opp bag. CE and RoHS available.' },
  E1: { case: 'E', source: 'PASTED_QUOTE', at: t(10, 5), text: 'Model TB-500. Material: stainless steel 304. USD3.35 for 1000 pcs. MOQ 500 pcs. FOB Ningbo. Lead time 45 days. T/T 30% deposit, 70% before shipment. Packing: gift box. Sample USD15, refundable. We are a factory. OEM and custom logo UV printing available. CE and RoHS available.' },
  // later in the day
  C2: { case: 'C', source: 'PASTED_QUOTE', at: t(11, 0), text: 'Model TB-500. USD3.00 for 1000 pcs. MOQ 1000 pcs. FOB Ningbo. Lead time 30 days. Packing: opp bag.' },
  D2: { case: 'D', source: 'PASTED_QUOTE', at: t(11, 30), text: 'Model TB-500. Material: aluminium alloy. USD3.25 for 1000 pcs. MOQ 500 pcs. FOB Shenzhen. Lead time 25 days.' },
  B2: { case: 'B', source: 'PASTED_QUOTE', at: t(14, 0), text: 'TB-500. 1000+pcs USD3.45. MOQ 500. DAP Rotterdam. Lead time 24 days. Packing: gift box included. Sample USD20, refundable.' },
  E2: { case: 'E', source: 'PASTED_QUOTE', at: t(14, 20), text: 'Model TB-500. USD3.20 for 1000 pcs. MOQ 500 pcs. FOB Ningbo. Lead time 38 days.' },
});

/** the owner's estimates per case: an Incoterm that already covers a cost must not get that cost typed in again */
const COST = { A: { origin: 700 }, B: { freight: null }, C: {}, D: {}, E: {} };
export const costsOf = (id) => COST[id];

export function newDayCases(now = t(8)) {
  return Object.fromEntries(Object.entries(SUPPLIERS).map(([id, s]) => [id, tumbler(id, { supplier: s.name, now, costs: COST[id], extra: [{ type: 'NOTE', text: s.note }] })]));
}

/** imports one offer and confirms what is clean; an ambiguous number is corrected by the owner, one wrong lead time is rejected; a conflict is left OPEN. Returns the new case. */
export function reviewOffer(c, key, { correct = {}, reject = [], at = null } = {}) {
  const o = OFFERS[key]; const when = at ?? o.at; let s = dispatch(c, { type: 'OFFER_IMPORT', source: o.source, text: o.text, meNames: ['Me'] }, when);
  const draft = offerDraft(s, s.offers.at(-1).id);
  for (const f of draft.fields) {
    if (f.review.state !== 'PENDING') continue;
    if (reject.includes(f.key)) { s = dispatch(s, { type: 'CANDIDATE_REJECT', id: f.id }, when); continue; }
    if (correct[f.key] !== undefined) { s = dispatch(s, { type: 'CANDIDATE_CORRECT', id: f.id, value: correct[f.key] }, when); continue; }
    if (f.needsCorrection || f.speaker === 'unknown') continue;
    s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: f.id }, when);
  }
  return s;
}

/** the whole morning, step by step; returns every intermediate state so a test can look at any moment */
export function runChinaDay({ upTo = 'end' } = {}) {
  const log = []; let cases = newDayCases(); const snap = (label) => log.push({ label, cases: JSON.parse(JSON.stringify(cases)) });
  snap('created');
  const go = (id, key, o) => { cases = { ...cases, [id]: reviewOffer(cases[id], key, o) }; };
  go('A', 'A1', { reject: ['quote.leadTime'] }); go('A', 'A2'); go('B', 'B1'); go('C', 'C1'); go('D', 'D1'); go('E', 'E1'); snap('first offers');
  go('C', 'C2'); go('D', 'D2'); snap('second offers (C changes MOQ, D changes material)');
  cases = { ...cases, B: withDocs(cases.B, 'TB-500', t(12)), C: withDocs(cases.C, 'TB-500', t(12, 5)), E: withDocs(cases.E, 'TB-500', t(12, 10)) };
  cases = { ...cases, E: dispatch(dispatch(dispatch(cases.E, { type: 'SAMPLE_RECORD', status: 'REQUESTED' }, t(9, 0)), { type: 'SAMPLE_RECORD', status: 'RECEIVED' }, t(12, 30)), { type: 'SAMPLE_RECORD', status: 'EVALUATED', verdict: 'PASS', note: 'weld and lid fit well' }, t(13)) };
  snap('documents received, sample evaluated');
  if (upTo === 'documents') return { log, cases };
  go('B', 'B2'); go('E', 'E2'); snap('B and E send revised offers');
  return { log, cases };
}
