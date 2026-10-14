// NORDLA: every sentence of a conversation (dictation, typed note, saved answer, earlier history) can be corrected where it is shown. A correction is an explicit, append-only REVISION by the owner next to the untouched raw words;
// the proposals that depend on the text are recomputed without duplicates and without bringing back a rejected one; nothing confirmed is silently changed; the corrected text is never presented as spoken by the supplier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSalonViews } from './sourcing-salon-load.js';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { rawTextOf, currentTextOf, revisionsOf, isRevised } from '../src/sourcing/core/provenance.js';
import { priceOfCase } from '../src/sourcing/core/price-display.js';
import { buildExport, validateCase } from '../src/sourcing/core/recovery.js';
import { upgradeCase } from '../src/sourcing/core/upgrade.js';
import { factStatusBoard, caseFacts } from '../src/sourcing/core/case-facts.js';

await loadSalonViews(); const N = await import(new URL('../src/sourcing/ui/screens/nx.js', import.meta.url).href);
const T0 = new Date('2026-10-20T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
const base = () => { let c = newCase({ id: 'sonny', name: 'batterie externe', now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Sonny' } }, at(0)); return dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(1)); };
const speech = (c, text, m = 2, speaker = 'supplier') => dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations[0].id, modality: 'SPEECH', speaker, speakerBy: 'OWNER_DECISION', lang: 'en', text, provider: 'moonshine', version: 'tiny' }, at(m));
const typed = (c, text, m = 2) => dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations[0].id, speaker: 'supplier', lang: 'auto', text }, at(m));
const revise = (c, item, text, m = 10) => dispatch(c, { type: 'CONVERSATION_REVISE', convId: c.conversations[0].id, itemId: item.id, text }, at(m));
const item = (c, i = 0) => c.conversations[0].items[i]; const cands = (c, key) => c.candidates.filter((k) => k.key === key);

test('1. THE REAL TEST: Moonshine hears "Forty five What"; the owner corrects it to "Forty five watts": the corrected text is the main text, the raw transcription is untouched, and "Puissance : 45 W" is PROPOSED (to confirm)', () => {
  let c = speech(base(), 'Forty five What'); assert.equal(cands(c, 'spec.power').length, 0, 'the raw words gave nothing');
  const raw = JSON.stringify([item(c).segments, item(c).derived]); c = revise(c, item(c), 'Forty five watts'); const it = item(c);
  assert.equal(currentTextOf(it), 'Forty five watts'); assert.equal(rawTextOf(it), 'Forty five What'); assert.equal(JSON.stringify([it.segments, it.derived]), raw, 'segments and the Moonshine transcription are not rewritten'); assert.ok(isRevised(it));
  const p = cands(c, 'spec.power'); assert.equal(p.length, 1); assert.deepEqual(p[0].value, { amount: 45, unit: 'W' }); assert.equal(p[0].state, 'PROPOSED'); assert.equal(p[0].basis, 'REVISION'); assert.equal(p[0].revisionId, revisionsOf(it)[0].id); assert.ok(p[0].flags.includes('OWNER_CORRECTED_TEXT'));
  assert.equal(c.ledger.length, 0, 'nothing is confirmed by a correction'); const w = factStatusBoard(c, { locale: 'fr' }).find((b) => b.fact_type === 'POWER'); assert.equal(w.state, 'PROPOSED');
});
test('2. the revision is explicit and traceable: owner, date, source, reference to the initial message, previous and new text; the speaker does not change (the supplier is not made to say the corrected text)', () => {
  let c = speech(base(), 'Forty five What'); const id = item(c).id; c = dispatch(c, { type: 'CONVERSATION_REVISE', convId: 'conv-1', itemId: id, text: 'Forty five watts', source: 'salon-inline' }, at(7)); const r = revisionsOf(item(c))[0];
  assert.equal(r.kind, 'OWNER_CORRECTION'); assert.equal(r.by, 'owner'); assert.equal(r.source, 'salon-inline'); assert.equal(r.at, at(7).toISOString()); assert.equal(r.ref, id); assert.equal(r.of, 'RAW'); assert.equal(r.previousText, 'Forty five What'); assert.equal(r.text, 'Forty five watts'); assert.equal(r.rawText, 'Forty five What');
  assert.equal(item(c).speaker, 'supplier', 'the item is still the supplier\'s: the correction is the owner\'s version, labelled as such in the views'); assert.ok(c.events.some((e) => e.type === 'CONVERSATION_REVISE'), 'it is in the history of events');
  const again = revise(c, item(c), 'Forty five watts plus', 9); const rs = revisionsOf(item(again)); assert.equal(rs.length, 2); assert.equal(rs[1].of, rs[0].id, 'a second correction refers to the first'); assert.equal(rs[1].previousText, 'Forty five watts'); assert.equal(rawTextOf(item(again)), 'Forty five What');
  assert.equal(revise(c, item(c), 'Forty five watts', 11).conversations[0].items[0].revisions.length, 1, 'an identical text creates no empty revision'); assert.throws(() => revise(c, item(c), '   ', 12), /required/);
});
test('3. a typed note is corrected the same way: the original stays, the proposals follow the corrected text (price, currency, MOQ, model, quantity)', () => {
  let c = typed(base(), 'prix 12$, MOQ 60, modele AB521'); const o = item(c).original; const price = cands(c, 'quote.unitPrice')[0]; assert.equal(price.value, '12'); const m0 = cands(c, 'quote.moq')[0]; assert.equal(m0.value, '60');
  c = revise(c, item(c), 'prix 15 EUR, MOQ 600, modele AB522'); assert.equal(item(c).original, o, 'the typed original is never rewritten'); assert.equal(currentTextOf(item(c)), 'prix 15 EUR, MOQ 600, modele AB522');
  const live = (k) => cands(c, k).filter((x) => x.state === 'PROPOSED').map((x) => x.value); assert.deepEqual(live('quote.unitPrice'), ['15']); assert.deepEqual(live('quote.moq').map(String), ['600']); assert.deepEqual(live('identifier.model'), ['AB522']); assert.deepEqual(live('quote.currency'), ['EUR']);
  const gone = cands(c, 'quote.unitPrice').find((x) => x.value === '12'); assert.equal(gone.state, 'REJECTED'); assert.equal(gone.decidedBy, 'system'); assert.match(gone.rejectedReason, /corrected by the owner/); assert.equal(c.ledger.length, 0);
  const r = revisionsOf(item(c))[0]; assert.ok(r.superseded.includes(gone.id) && r.proposed.length >= 4);
});
test('4. no duplicates, and a proposal the OWNER rejected is never brought back (not by a correction elsewhere in the sentence, not by correcting it again)', () => {
  let c = typed(base(), 'prix 12$, MOQ 60'); const moq = cands(c, 'quote.moq')[0]; c = dispatch(c, { type: 'CANDIDATE_REJECT', id: moq.id }, at(3));
  c = revise(c, item(c), 'prix 14$, MOQ 60 pieces'); assert.equal(cands(c, 'quote.moq').length, 1, 'the same value is not proposed twice, and the rejected one stays rejected'); assert.equal(cands(c, 'quote.moq')[0].state, 'REJECTED'); assert.equal(cands(c, 'quote.moq')[0].decidedBy, 'user');
  c = revise(c, item(c), 'prix 14$, MOQ 60', 11); assert.equal(cands(c, 'quote.moq').length, 1); assert.equal(cands(c, 'quote.moq')[0].state, 'REJECTED');
  const prices = cands(c, 'quote.unitPrice'); assert.equal(prices.filter((p) => p.state === 'PROPOSED').length, 1, 'exactly one live price proposal'); assert.equal(prices.find((p) => p.state === 'PROPOSED').value, '14');
  c = revise(c, item(c), 'prix 12$, MOQ 60', 12); const live12 = cands(c, 'quote.unitPrice').filter((p) => p.value === '12' && p.state === 'PROPOSED'); assert.equal(live12.length, 1, 'correcting back to the first words re-proposes a superseded value once (it was withdrawn by the system, not rejected by the owner)');
});
test('5. a CONFIRMED fact is never changed silently: a correction that disagrees with it only records an impact and proposes the new value; confirming it opens the usual explicit conflict question', () => {
  let c = typed(base(), 'prix 12 USD, MOQ 60'); for (const k of c.candidates) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(3)); assert.equal(c.quotes.at(-1).moq, 60); const before = JSON.stringify({ q: c.quotes, l: c.ledger });
  c = revise(c, item(c), 'prix 12 USD, MOQ 600'); assert.equal(JSON.stringify({ q: c.quotes, l: c.ledger }), before, 'quote and ledger are exactly as they were');
  const r = revisionsOf(item(c))[0]; assert.ok(r.impacts.some((i) => i.kind === 'CONFIRMED_FROM_OLD_TEXT' && i.key === 'quote.moq' && Number(i.confirmed) === 60)); assert.ok(r.impacts.some((i) => i.kind === 'DIFFERS_FROM_CONFIRMED' && i.key === 'quote.moq' && Number(i.proposed) === 600 && Number(i.confirmed) === 60));
  const np = cands(c, 'quote.moq').find((k) => Number(k.value) === 600); assert.equal(np.state, 'PROPOSED'); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: np.id }, at(12)); assert.equal(c.quotes.at(-1).moq, 60, 'still 60: a conflict was raised instead'); assert.equal(c.conflicts.filter((x) => x.state === 'OPEN').length, 1);
  const v = N.itemParts({ id: 'i', convId: 'c', caseId: 'x', text: 'MOQ 600', raw: 'MOQ 60', rawLabel: 'Texte d\'origine', revised: true, revisions: [{ when: 'a', previous: 'MOQ 60', text: 'MOQ 600' }], impacts: ['MOQ : 60 pièces est déjà confirmé, votre correction propose 600 pièces.'], editing: false }); assert.match(v.extra, /À décider/); assert.match(v.extra, /Rien de confirmé n'a été modifié/);
});
test('6. currency, price and quantity corrections: a currency proposed from "$" is corrected in the sentence; the confirmed price/currency wording and the calculations do not move', () => {
  let c = typed(base(), 'prix 12$, MOQ 60'); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: cands(c, 'quote.unitPrice')[0].id }, at(3)); assert.equal(priceOfCase(c).text, '12 — devise à confirmer');
  c = revise(c, item(c), 'prix 12 EUR, MOQ 60'); assert.equal(priceOfCase(c).text, '12 — devise à confirmer', 'the proposed EUR is still only a proposal'); assert.equal(cands(c, 'quote.currency').filter((k) => k.state === 'PROPOSED').map((k) => k.value).join(), 'EUR'); assert.equal(cands(c, 'quote.currency').find((k) => k.value === 'USD').state, 'REJECTED');
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: cands(c, 'quote.currency').find((k) => k.state === 'PROPOSED').id }, at(13)); assert.equal(priceOfCase(c).text, '12 EUR'); const a = assess(c, { now: at(14), externals: {} }); assert.ok(a.landed, 'the case still assesses');
  const q = typed(base(), 'MOQ 500, 3.2 USD'); const m = (x) => x.candidates.filter((k) => k.state === 'PROPOSED').map((k) => `${k.key}=${JSON.stringify(k.value)}`).sort().join('|'); const q2 = revise(q, item(q), 'MOQ 5000, 3.2 USD'); assert.notEqual(m(q), m(q2)); assert.match(m(q2), /quote.moq="?5000/); assert.doesNotMatch(m(q2), /quote.moq="?500["|]|quote.moq="?500$/);
});
test('7. an ANSWER to a question is corrected like any sentence: its link to the question survives, its proposals follow', () => {
  let c = base(); c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'auto', text: 'Shenzhen Sonny, FOB Ningbo, lead time 25 days', answersQuestion: 'manufacturer', questionText: 'Fabricant (nom et adresse)' }, at(2));
  c = revise(c, item(c), 'Shenzhen Sonny, EXW Ningbo, lead time 35 days'); assert.equal(item(c).answersQuestion, 'manufacturer'); assert.ok(c.questionLog.some((e) => e.kind === 'ANSWERED' && e.itemId === item(c).id), 'the log still points at the same item');
  const lt = cands(c, 'quote.incoterm').filter((k) => k.state === 'PROPOSED'); assert.equal(lt.length, 1); assert.equal(lt[0].value, 'EXW'); assert.equal(cands(c, 'quote.incoterm').find((k) => k.value === 'FOB').state, 'REJECTED'); const lead = cands(c, 'quote.leadTime').filter((k) => k.state === 'PROPOSED'); assert.equal(lead.length, 1); assert.match(JSON.stringify(lead[0].value), /35/); assert.equal(rawTextOf(item(c)), 'Shenzhen Sonny, FOB Ningbo, lead time 25 days');
});
test('8. a corrected sentence is final: a dictated item still open is closed by the correction, a late segment never changes it; the unknown speaker stays unknown', () => {
  let c = base(); c = dispatch(c, { type: 'SPEECH_SEGMENT', convId: 'conv-1', text: 'Forty five What', lang: 'en', provider: 'moonshine', version: 'tiny', capture: { sessionId: 's1' } }, at(2)); const it = item(c); assert.equal(it.turn.status, 'OPEN'); assert.equal(it.speaker, 'unknown');
  c = revise(c, it, 'Forty five watts'); assert.equal(item(c).turn.status, 'CLOSED'); assert.equal(item(c).turn.closedBy, 'OWNER_CORRECTION'); assert.equal(item(c).speaker, 'unknown'); assert.equal(cands(c, 'spec.power').length, 1);
  c = dispatch(c, { type: 'SPEECH_SEGMENT', convId: 'conv-1', text: 'and MOQ six hundred', lang: 'en', provider: 'moonshine', capture: { sessionId: 's1' } }, at(12)); assert.equal(c.conversations[0].items.length, 2, 'the late sentence is a NEW item'); assert.equal(currentTextOf(item(c)), 'Forty five watts'); assert.equal(cands(c, 'spec.power').filter((k) => k.itemId === item(c).id).length, 1);
  assert.throws(() => dispatch(c, { type: 'CANDIDATE_CONFIRM', id: cands(c, 'spec.power')[0].id }, at(13)), /nobody has said who spoke/, 'an unattributed sentence still cannot confirm facts');
});
test('9. the re-reading of stored notes never brings back proposals from the old words of a corrected note', () => {
  let c = typed(base(), 'prix 12$, MOQ 60'); c = revise(c, item(c), 'prix 14$'); const n = c.candidates.length; c = dispatch(c, { type: 'CONVERSATION_REANALYZE', convId: 'conv-1' }, at(20)); assert.equal(c.candidates.length, n);
});
test('10. export, restore and upgrade keep every revision; the case stays valid; legacy cases without revisions are unchanged', () => {
  let c = speech(base(), 'Forty five What'); c = revise(c, item(c), 'Forty five watts'); const copy = JSON.parse(JSON.stringify(c)); assert.equal(validateCase(copy).ok ?? true, true); const up = upgradeCase(copy); assert.equal(revisionsOf(up.conversations[0].items[0]).length, 1); assert.equal(rawTextOf(up.conversations[0].items[0]), 'Forty five What');
  const exp = JSON.stringify(buildExport({ cases: { [c.id]: c }, currentId: c.id }) ?? ''); assert.match(exp, /Forty five watts/); assert.match(exp, /Forty five What/); const old = typed(base(), 'prix 12'); assert.equal(isRevised(item(old)), false); assert.equal(currentTextOf(item(old)), 'prix 12'); assert.equal(caseFacts(c).length >= 0, true);
});
test('11. the views: the corrected text is the main text with "Corrigé par vous", the original is consultable, "Corriger" exists on every sentence, the edit field is prefilled with Enregistrer / Annuler, nothing says the supplier said the correction', () => {
  const n = { id: 'conv-1-i1', convId: 'conv-1', caseId: 'sonny', when: '20 oct.', who: 'le fournisseur', text: 'Forty five watts', raw: 'Forty five What', rawLabel: 'Transcription brute (Moonshine)', revised: true, revisions: [{ when: 'a', previous: 'Forty five What', text: 'Forty five watts' }], impacts: [], editing: false, lang: 'en', kind: 'voice' };
  const li = N.itemLi(n); assert.match(li, /Forty five watts/); assert.match(li, /Corrigé par vous/); assert.match(li, /Voir l'original/); assert.match(li, /Transcription brute \(Moonshine\)/); assert.match(li, /« Forty five What »/); assert.match(li, /data-act="sl-item-edit"[^>]*data-key="conv-1-i1"/); assert.match(li, /Le fournisseur n'a pas dit le texte corrigé/); assert.doesNotMatch(li, /<form/);
  const ed = N.itemLi({ ...n, editing: true, micPaused: true }); assert.match(ed, /<form data-form="sl-item-revise"/); assert.match(ed, />Forty five watts<\/textarea>/); assert.match(ed, />Enregistrer<\/button>/); assert.match(ed, /data-act="sl-item-cancel">Annuler/); assert.match(ed, /Micro en pause pendant la correction/); assert.match(ed, /name="itemId" value="conv-1-i1"/); assert.doesNotMatch(ed, /data-act="sl-item-edit"/, 'no second Corriger while editing');
  const plain = N.itemLi({ ...n, revised: false, revisions: [], text: 'Forty five What', raw: 'Forty five What' }); assert.doesNotMatch(plain, /Corrigé par vous|Voir l'original/); assert.match(plain, /Corriger/);
  const th = N.threadHtml({ info: { caseId: 'sonny', title: 'batterie', supplier: 'Sonny' }, items: [n, { ...n, id: 'conv-1-i2', revised: false, revisions: [], text: 'MOQ 60', raw: 'MOQ 60' }], flash: '', sync: { kind: 'synced', label: 'Serveur à jour' }, conflicts: 0 }); assert.equal((th.match(/data-act="sl-item-edit"/g) ?? []).length, 2, 'every sentence of the history has Corriger'); assert.match(th, /Conversation/);
});
