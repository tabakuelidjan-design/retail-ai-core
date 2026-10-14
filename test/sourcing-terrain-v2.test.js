// NORDLA TERRAIN (mobile V2): the answer to a question is recorded WHERE the question is asked, in the case, with its link; the five states are never mixed; the screens never show a proposal as a fact and escape what
// a supplier or a note can contain. Reference scenario: the real Xiaomi test (supplier Sonny, battery pack).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSalonViews } from './sourcing-salon-load.js';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { planConversation } from '../src/sourcing/core/conversation-engine.js';
import { createFieldEngine } from '../src/sourcing/core/field/engine.js';
import { newWorkspace } from '../src/sourcing/core/field/workspace.js';
import { factStatusBoard } from '../src/sourcing/core/case-facts.js';
import { upgradeCase } from '../src/sourcing/core/upgrade.js';
import { validateCase, buildExport } from '../src/sourcing/core/recovery.js';

await loadSalonViews(); // registers the '/core/...' resolver used by the browser modules
const N = await import(new URL('../src/sourcing/ui/screens/nx.js', import.meta.url).href);
export const SONNY = 'prix 12$, MOQ 60, puissance 10000mAp. variante 4 couleur blanc, blue, rouge et noir. puissance 45W. nom de Modele AB521';
const T0 = new Date('2026-10-20T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
const base = () => { let c = newCase({ id: 'sonny', name: 'batterie externe', now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Sonny' } }, at(0)); return c; };
const eng = createFieldEngine({ now: () => at(5) });
const askIds = (c) => eng.caseView(c, newWorkspace(at(0)), ['askNow']).askNow.items.map((i) => i.id);
const planState = (c, id) => planConversation(c, assess(c, { now: at(30), externals: {} })).questions.find((q) => q.id === id)?.state;

test('1. an ANSWER is an item of the conversation of the right case, linked to the question; the question is logged asked THEN answered; nothing is confirmed', () => {
  let c = base(); assert.ok(askIds(c).includes('model'), 'the model is asked first'); assert.equal(planState(c, 'model'), 'OPEN');
  c = dispatch(c, { type: 'QUESTION_SHOWN', questionId: 'model', via: 'SHOWN_TO_SUPPLIER' }, at(6)); assert.equal(planState(c, 'model'), 'ASKED', 'asked, waiting for the answer');
  c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(7)); const conv = c.conversations.at(-1);
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'supplier', lang: 'auto', text: SONNY, answersQuestion: 'model', questionText: 'Modèle exact' }, at(8));
  const item = c.conversations[0].items[0]; assert.equal(item.original, SONNY, 'the words are kept exactly'); assert.equal(item.answersQuestion, 'model'); assert.equal(item.speaker, 'supplier');
  assert.deepEqual(c.questionLog.map((e) => [e.kind, e.questionId]), [['SHOWN', 'model'], ['ANSWERED', 'model']]); const log = c.questionLog[1]; assert.equal(log.itemId, item.id); assert.equal(log.convId, conv.id); assert.equal(log.questionText, 'Modèle exact');
  assert.equal(planState(c, 'model'), 'ANSWER_PENDING', 'answered, and what it holds is proposed: the engine waits for the owner to decide (the log says ANSWERED)'); assert.ok(c.candidates.length >= 6 && c.candidates.every((k) => k.state === 'PROPOSED' && k.itemId === item.id), 'proposals only');
  assert.equal(c.ledger.length, 0, 'no fact before the owner decides'); assert.equal(c.quotes.length, 0); assert.equal(c.identity.identifiers.model, null);
});

test('2. the five states stay distinct: question asked -> answer noted -> proposed -> confirmed (by the owner) -> and VERIFIED only by an official source, never by a conversation', () => {
  let c = base(); c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(1)); const conv = c.conversations[0];
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'supplier', lang: 'auto', text: SONNY, answersQuestion: 'price' }, at(2));
  const board = (x) => Object.fromEntries(factStatusBoard(x, { locale: 'fr' }).map((b) => [b.fact_type, b]));
  assert.equal(board(c).MODEL.state, 'PROPOSED'); assert.equal(board(c).CAPACITY.state, 'AMBIGUOUS'); assert.equal(board(c).CAPACITY.canConfirm, false, 'an ambiguous fact cannot be confirmed as it is'); assert.equal(board(c).LEAD_TIME.state, 'MISSING');
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: c.candidates.find((k) => k.key === 'identifier.model').id }, at(3)); assert.equal(board(c).MODEL.state, 'CONFIRMED'); assert.equal(c.ledger.find((e) => e.key === 'identifier.model').status, 'SUPPLIER_CLAIM', 'a supplier\'s word is never VERIFIED');
  c = dispatch(c, { type: 'CANDIDATE_CORRECT', id: c.candidates.find((k) => k.key === 'spec.capacity').id, value: { amount: 10000, unit: 'mAh' } }, at(4)); const cap = c.candidates.find((k) => k.key === 'spec.capacity');
  assert.equal(cap.state, 'CORRECTED'); assert.equal(cap.rawText, '10000mAp', 'what the supplier said is kept'); assert.equal(c.ledger.find((e) => e.key === 'spec.capacity').status, 'USER_PROVIDED');
  assert.ok(!c.ledger.some((e) => e.status === 'VERIFIED'));
  // nothing else was decided for the owner
  const other = c.candidates.filter((k) => !['identifier.model', 'spec.capacity'].includes(k.key)); assert.ok(other.length >= 5 && other.every((k) => k.state === 'PROPOSED'));
});

test('3. a free typed note (no question) is the same pipeline; answersQuestion is optional and old cases without it still load, validate and export', () => {
  let c = base(); c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(1));
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations[0].id, speaker: 'supplier', lang: 'auto', text: 'MOQ 500' }, at(2)); assert.equal(c.conversations[0].items[0].answersQuestion, undefined); assert.equal(c.questionLog.length, 0);
  const old = JSON.parse(JSON.stringify(c)); const up = upgradeCase(old); assert.equal(up.conversations[0].items[0].original, 'MOQ 500');
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations[0].id, speaker: 'supplier', lang: 'auto', text: 'FOB Ningbo', answersQuestion: 'price' }, at(3)); const exp = JSON.parse(buildExport(c, () => null)); const back = validateCase(exp.case); assert.ok(back.ok, JSON.stringify(back).slice(0, 200)); assert.equal(back.case.questionLog.at(-1).kind, 'ANSWERED');
});

test('4. a question answered can be asked again: a new SHOWN makes it ASKED again (the answer is kept in the conversation)', () => {
  let c = base(); c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(1)); c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations[0].id, speaker: 'supplier', lang: 'auto', text: 'ok', answersQuestion: 'manufacturer' }, at(2));
  assert.equal(planState(c, 'manufacturer'), 'ANSWERED'); c = dispatch(c, { type: 'QUESTION_SHOWN', questionId: 'manufacturer', via: 'SHOWN_TO_SUPPLIER' }, at(3)); assert.equal(planState(c, 'manufacturer'), 'ASKED'); assert.equal(c.conversations[0].items.length, 1);
});

// ---- the screens ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const cand = (o) => ({ id: 'cand-1', key: 'quote.unitPrice', context: 'product', value: '12', rawText: 'prix 12$', state: 'PROPOSED', speaker: 'supplier', lang: 'fr', flags: [], ...o });
test('5. proposals: a proposal says it is proposed, shows the supplier\'s own words, offers Confirmer / Corriger / Rejeter; an ambiguous one has NO Confirmer; nothing is called verified', () => {
  const html = N.proposalsHtml({ cands: [cand({}), cand({ id: 'cand-2', key: 'spec.capacity', value: null, rawText: '10000mAp', needsCorrection: true, flags: ['UNIT_UNRECOGNISED'] })], caseId: 'sonny' });
  assert.match(html, /Proposée · à confirmer/); assert.match(html, /Ambiguë · à corriger/); assert.match(html, /« prix 12\$ »/); assert.match(html, /dit par le fournisseur · pas encore confirmé/); assert.doesNotMatch(html, /Vérifiée|vérifié/i);
  const rows = html.split('<li class="nx-prop').slice(1); assert.equal(rows.length, 2); assert.match(rows[0], /sl-confirm/); assert.doesNotMatch(rows[1], /data-act="sl-confirm"/, 'an ambiguous fact cannot be confirmed as it is'); assert.match(rows[1], /sl-correct-open/);
});
test('6. outcomes are visible on the same screen with their own state word (Confirmée, Corrigée par vous, Rejetée) and a corrected row keeps what the supplier said', () => {
  const html = N.proposalsHtml({ cands: [cand({ state: 'CONFIRMED' }), cand({ id: 'c2', key: 'spec.capacity', state: 'CORRECTED', rawText: '10000mAp', value: null, correctedValue: { amount: 10000, unit: 'mAh' } }), cand({ id: 'c3', key: 'quote.currency', value: 'USD', state: 'REJECTED' })], caseId: 'x' });
  assert.match(html, /Confirmée/); assert.match(html, /Corrigée par vous/); assert.match(html, /le fournisseur disait « 10000mAp »/); assert.match(html, /Rejetée/); assert.match(html, /<s>USD<\/s>/);
});
test('7. a question card has Montrer / Noter la réponse / Passer: the old "Posée" and "Répondue" buttons no longer exist; the answer box opens inside the card', () => {
  const q = { id: 'price', title: 'Prix unitaire', tag: 'Bloquant pour calcul', tagKind: 'calc', en: 'What is your unit price?', zh: { text: '请问单价是多少?' }, state: 'OPEN' };
  const closed = N.questionCard(q, { caseId: 'sonny' }); assert.match(closed, /Noter la réponse/); assert.match(closed, /Montrer/); assert.match(closed, /Copier/, 'the question can be copied (English + Chinese) to paste into a WeChat chat'); assert.match(closed, /À poser/); assert.doesNotMatch(closed, />Posée<|>Répondue<|sl-ask-state/);
  const open = N.questionCard(q, { caseId: 'sonny', answering: true, draft: 'brouillon' }); assert.match(open, /<textarea/); assert.match(open, /Enregistrer la réponse/); assert.match(open, /brouillon/); assert.match(open, /name="qid" value="price"/);
  assert.match(N.questionCard({ ...q, state: 'ASKED' }, { caseId: 'x' }), /Posée · en attente/); assert.match(N.questionCard({ ...q, state: 'ANSWERED' }, { caseId: 'x' }), /Réponse notée/);
});
test('8. everything a supplier, a product or a note can contain is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>'; const info = { caseId: 'a', title: evil, supplier: evil, sample: { status: 'NONE' } };
  const note = N.noteHtml({ info, mode: 'text', flash: evil, speaker: 'supplier', draft: evil, proposals: '', notes: [{ when: evil, who: evil, text: evil, answers: evil }], photos: [], voice: { available: false, state: 'idle', title: evil, message: evil, items: [] }, online: true });
  assert.doesNotMatch(note, /<img src=x/); assert.match(note, /&lt;img src=x/);
  const cards = N.supplierCards([{ caseId: 'a', title: evil, supplier: evil, evidence: 'WEAK_EVIDENCE', price: evil, landed: null, pending: 1, conflicts: 0, waiting: 0, photo: null }]); assert.doesNotMatch(cards, /<img src=x/);
  const conflict = N.syncHtml({ versions: [{ id: 'a', title: evil, mine: { updatedText: evil, notes: 1, offers: 0, facts: 0 }, server: { updatedText: evil, notes: 1, offers: 0, facts: 0 }, diffs: [{ label: evil, mine: evil, server: evil }], onlyMine: [{ kind: evil, text: evil }], onlyServer: [] }] }); assert.doesNotMatch(conflict, /<img src=x/);
});
test('9. the save state is worded for the owner; a conflict is never silent (banner on every main screen)', () => {
  assert.match(N.syncChip({ kind: 'synced', label: 'Serveur à jour' }), /Serveur à jour/); assert.match(N.syncChip({ kind: 'offline', label: 'Hors ligne · 2 à envoyer' }), /Hors ligne · 2 à envoyer/);
  const banner = N.conflictBanner(1); assert.match(banner, /Conflit de synchronisation/); assert.match(banner, /Rien n'a été écrasé/); assert.equal(N.conflictBanner(0), '');
  const home = N.homeHtml({ overview: [], resume: null, sync: { kind: 'conflict', label: '1 conflit' }, counts: { toConfirm: 0, waiting: 0, conflicts: 0, cases: { confirm: 0, waiting: 0, conflict: 0 } }, conflicts: 1 }); assert.match(home, /Conflit de synchronisation/);
});
test('10. conflict screen: both versions, the differences, and "Garder les deux" is the recommended default; replacing needs a second explicit step that says nothing is lost', () => {
  const v = { id: 'a', title: 'Sonny · batterie', mine: { updatedText: '14 oct., 00:25', notes: 3, offers: 0, facts: 7 }, server: { updatedText: '14 oct., 00:26', notes: 3, offers: 0, facts: 7 }, diffs: [{ label: 'Prix unitaire', mine: '12', server: '11' }], onlyMine: [{ kind: 'Note (fournisseur)', text: 'accepte 55 pièces' }], onlyServer: [{ kind: 'Note libre', text: 'ajoutée ailleurs' }] };
  const first = N.syncHtml({ versions: [v] }); assert.match(first, /Sur ce téléphone/); assert.match(first, /Sur le serveur/); assert.match(first, /Garder les deux \(recommandé\)/); assert.match(first, /Prendre la version du serveur/); assert.match(first, /accepte 55 pièces/); assert.match(first, /ajoutée ailleurs/); assert.match(first, /Prix unitaire/); assert.doesNotMatch(first, /sl-conf-server-go/);
  const confirm = N.syncHtml({ versions: [v], confirmingServer: 'a' }); assert.match(confirm, /Remplacer ma version par celle du serveur \?/); assert.match(confirm, /rien ne sera perdu/); assert.match(confirm, /sl-conf-server-go/); assert.equal(N.syncHtml({ versions: [] }).includes('Aucun conflit'), true);
});
test('11. the fiche offers five tabs, the heavy panes are one level down in "Plus", and no English tab name is mixed in', () => {
  assert.deepEqual(N.FICHE_TABS.map(([, l]) => l), ['Aperçu', 'Infos', 'Questions', 'Chiffres', 'Plus']); assert.equal(N.NOTE_MODES.length, 4); assert.deepEqual(N.NOTE_MODES.map(([, l]) => l), ['Note', 'Photo', 'Audio', 'Document']);
  const all = JSON.stringify([N.FICHE_TABS, N.NOTE_MODES, N.FILTERS, N.ST, N.LADDER]); assert.doesNotMatch(all, /Guided|Quick|Verdict|Rules|Market|Money|Proposed|Confirmed/);
});
test('12. the ladder of states is stated once, in this order', () => { const order = [...N.LADDER.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]); assert.deepEqual(order, ['Question posée', 'Réponse notée', 'Proposée', 'Confirmée', 'Vérifiée']); });

// ---- ONE INTERFACE (owner decision, option B): parity of the former modes ---------------------------------------------------------------------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
const ui = (f) => readFileSync(new URL(`../src/sourcing/ui/${f}`, import.meta.url), 'utf8');
test('13. PARITY: every screen of the former Expert mode, and the live (guided) conversation, has an entry inside the unified navigation', () => {
  const tabsLine = ui('app.js').split('\n').find((l) => l.startsWith('const TABS = ')); const expertKeys = [...tabsLine.matchAll(/\['(\w+)', '[^']+'\]/g)].map((m) => m[1]); assert.equal(expertKeys.length, 9, 'the nine former expert tabs');
  for (const k of [...expertKeys, 'live']) { assert.ok(N.EXPERT_KEYS.includes(k), `${k} has a French label and a place`); assert.match(N.expertMenu('c1'), new RegExp(`data-act="sl-embed" data-key="${k}"`)); }
  assert.equal(N.EXPERT_KEYS.length, expertKeys.length + 1); for (const k of N.EXPERT_KEYS) assert.ok(N.EXPERT_LABELS[k] && N.EXPERT_HINTS[k], k);
  assert.match(ui('screens/salon.js'), /case 'sl-embed'/); assert.match(ui('app.js'), /embedded: embeddedHtml/);
});
test('14. no mode switch is offered anywhere in the screens; the legacy mode code is KEPT but only reachable through the diagnostic flag', () => {
  const more = N.moreHtml({ sync: { kind: 'local', label: 'Sur ce téléphone', detail: '' }, comparisons: [], active: { id: 'c1', supplier: { name: 'Sonny' }, identity: { workingName: 'batterie' } }, conflicts: 0, serverSet: false });
  assert.doesNotMatch(more, /Mode guidé|Mode expert|sl-mode|mode-field|mode-expert/); assert.match(more, /Analyses expertes/);
  const state = ui('state.js'); assert.match(state, /LEGACY_UI/); assert.match(state, /nordla\.sourcing\.legacyUi/); const app = ui('app.js'); for (const kept of ["act === 'mode-field'", "act === 'mode-expert'", 'fieldFirst', 'fmNav']) assert.ok(app.includes(kept), `legacy code kept: ${kept}`);
  for (const f of ['screens/field.js', 'screens/fieldfirst.js', 'screens/fieldhome.js', 'screens/decision.js', 'screens/money.js', 'screens/quick.js']) assert.ok(ui(f).length > 500, `${f} is not removed`);
});
test('15. the sheet reaches the expert sections where they are needed (compliance and calculations from Aperçu / Chiffres, documents from the note, conversation from the notes)', () => {
  const nx = ui('screens/nx.js'); for (const needle of ["'sl-embed', 'compliance'", "'sl-embed', 'money'", "'sl-embed', 'quick'", "'sl-embed', 'docs'", "'sl-embed', 'live'"]) assert.ok(nx.includes(needle), needle);
});
