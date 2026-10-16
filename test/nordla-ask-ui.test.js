// Parle à Nordla screen: pure rendering + controller (no DOM needed). Real server answers are rendered, so a change of the answer shape breaks THIS test, not the phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { askNordla } from '../src/core-pilot/ask.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createMemoryJournal } from '../src/core-pilot/journal.js';
import { validateCoreConfig } from '../src/core-pilot/config.js';
import { renderAsk, renderTurn, createAskUi, MAX_TURNS } from '../src/sourcing/ui/nordla-ask.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial, extraTraits } from './sourcing-fixtures.js';

const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
const blocked = mk([...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({})], 'blocked');
const go = mk([...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, ...commercial({})], 'go');
const rt = () => createCoreRuntime({ merchantId: 'm', config: CONFIG, journal: createMemoryJournal({ merchantId: 'm' }), now: () => NOW });
const ask = async (text, c, runtime = null) => ({ text, ...(await askNordla({ text, caseId: c?.id ?? null }, { runtime, getCase: async () => c, externals: { safety: LIVE_CLEAN }, actor: { userId: 'u', role: 'OWNER' }, now: NOW })) });
const visible = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, (e) => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" }[e] ?? e)).replace(/\s+/g, ' ');

test('a blocked order is a red alert banner naming the blocker; an open case shows none', async () => {
  const b = renderTurn(await ask('puis-je commander ?', blocked), { newest: true });
  assert.match(b, /class="nxa-block" role="alert"/); assert.match(visible(b), /Commande impossible à ce stade documents obligatoires manquants ou inexploitables/); assert.match(visible(b), /Nordla ne commande et ne paie rien/);
  assert.match(b, /data-core-answer(?!-old)/); assert.match(visible(b), /verdict : Sous conditions, commande bloquée/, 'the engine code is worded for a person');
  assert.doesNotMatch(visible(b), /CONDITIONAL_GO/);
  const g = renderTurn(await ask('quelle est la marge ?', go)); assert.doesNotMatch(g, /nxa-block/, 'a case that can commit money shows no blocker banner');
});

test('sections are labelled; the next check is emphasised; sources are visible text; limits are in a details block', async () => {
  const h = renderTurn(await ask('qu’est-ce qu’on sait sur ce fournisseur ?', blocked)); const t = visible(h);
  for (const x of ['Ce que nous savons', 'Ce que nous ne savons pas', 'Risques', 'Prochaine vérification']) assert.ok(t.includes(x), x);
  assert.match(h, /class="nxa-sec nxa-next"/); assert.match(t, /Sources : dossier blocked/); assert.match(h, /<details><summary>Limites et fraîcheur des données<\/summary>/);
  const q = visible(renderTurn(await ask('quelles questions poser au fournisseur ?', blocked))); assert.ok(q.includes('À demander (anglais / chinois)'), 'the section title comes from the server');
});

test('the recommendation is justified on screen: facts, eliminated options with reasons, owner rules (none)', async () => {
  const runtime = rt(); await ask('dois-je acheter ce produit ?', blocked, runtime);
  const t = visible(renderTurn(await ask('pourquoi cette recommandation ?', blocked, runtime)));
  assert.match(t, /recommandation du Core : « Tester petit »/); assert.match(t, /écartée : Commander 1000 unités/); assert.match(t, /règles propriétaire appliquées : aucune/); assert.match(t, /aucune décision humaine enregistrée/);
});

test('an action request and a refusal are shown as such; a legacy (unstructured) answer still renders', async () => {
  assert.match(renderTurn(await ask('passe la commande', blocked)), /<b>Action refusée<\/b>/);
  const legacy = renderTurn(await ask('comment évoluent mes ventes ?', go)); assert.match(visible(legacy), /Module non relié/); assert.doesNotMatch(legacy, /nxa-block/);
});

test('every value is escaped: markup in a question, an answer, a product name or a blocker label never becomes an element', () => {
  const evil = '<img src=x onerror=alert(1)>"\'<script>1</script>';
  const html = renderAsk({ turns: [{ text: evil, status: 'ANSWERED', intent: 'RISKS', answer: `${evil}\nx`, sections: { known: [evil], unknown: [evil], risks: [evil], consequences: [evil], next: [evil] }, knownTitle: evil, sources: [{ kind: evil, ref: evil }], limits: [evil], case: { ref: evil, version: evil, productName: evil }, verdict: evil, orderBlocked: true, blockers: [{ code: evil, label: evil, detail: evil }] }], notice: evil, draft: evil, active: { id: evil, name: evil } });
  assert.ok(!html.includes('<img') && !html.includes('<script>'));
});

test('the chips depend on the open case; with no case only case-free questions are offered; the screen says Nordla orders nothing', () => {
  const noCase = renderAsk({ active: null }); assert.doesNotMatch(noCase, /peux commander/); assert.match(noCase, /Aucun dossier ouvert/);
  const withCase = renderAsk({ active: { id: 'c1', name: 'Mug' } }); assert.match(withCase, /Puis-je commander \?/); assert.match(withCase, /Dossier ouvert : Mug/);
  assert.match(renderAsk({ active: { id: 'c1' }, busy: true }), /disabled/);
  assert.match(renderAsk({ turns: [{ text: 'q', answer: 'a' }], active: { id: 'c1' } }), /Nouvelle conversation/);
});

test('controller: the conversation state travels with every question, is replaced by the server\'s, resets on demand, and a server without it degrades to single questions', () => {
  const st = {}; const sent = [];
  let reply = { status: 'ANSWERED', answer: 'x', sources: [], limits: [], conversation: { v: 1, n: 1 } };
  const post = (path, body, after) => { sent.push({ path, body: JSON.parse(JSON.stringify(body)) }); after(reply); };
  const ui = createAskUi({ st, post });
  ui.handle('core-ask-chip', { dataset: { text: 'Quels sont les risques ?' } }, 'c1');
  assert.equal(sent[0].path, '/api/core/ask'); assert.equal(sent[0].body.conversation, null, 'first question: explicit null = start a conversation'); assert.equal(sent[0].body.caseId, 'c1');
  reply = { ...reply, conversation: { v: 1, n: 2 } }; ui.handle('core-ask-chip', { dataset: { text: 'et ensuite ?' } }, 'c1');
  assert.deepEqual(sent[1].body.conversation, { v: 1, n: 1 }, 'the previous server state is sent back'); assert.equal(st.nx.turns.length, 2); assert.equal(st.nx.turns[0].text, 'et ensuite ?', 'newest first');
  assert.equal(ui.handle('core-ask-reset', {}, 'c1'), 'reset'); assert.equal(st.nx.turns.length, 0); assert.equal(st.nx.conversation, null);
  reply = { status: 'ANSWERED', answer: 'x', sources: [], limits: [] }; ui.handle('core-ask-chip', { dataset: { text: 'a' } }, 'c1'); ui.handle('core-ask-chip', { dataset: { text: 'b' } }, 'c1');
  assert.equal(sent.at(-1).body.conversation, null, 'a server that returns no state: every question stands alone');
  for (let i = 0; i < MAX_TURNS + 5; i += 1) ui.handle('core-ask-chip', { dataset: { text: `q${i}` } }, 'c1'); assert.equal(st.nx.turns.length, MAX_TURNS);
  const before = sent.length; assert.equal(ui.handle('core-load', {}, 'c1'), false, 'other panel actions are not swallowed'); assert.equal(sent.length, before);
});
