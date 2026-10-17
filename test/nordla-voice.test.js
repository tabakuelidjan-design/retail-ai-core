// Parle à Nordla V2 - voice. Fake microphone / speaker (no real audio in tests) around the REAL controller and the REAL server answers (synthetic data).
// What must hold: the microphone only fills a box the person can read and correct; consent before the first start; every failure falls back to the keyboard;
// a spoken sentence is refused exactly like a typed one; reading aloud is optional and interruptible; the written answer is never replaced.
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { askNordla } from '../src/core-pilot/ask.js';
import { validateConversation } from '../src/core-pilot/field-context.js';
import { recognizeFieldIntent } from '../src/core-pilot/field-intents.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createMemoryJournal } from '../src/core-pilot/journal.js';
import { validateCoreConfig } from '../src/core-pilot/config.js';
import { speakable, classifyError, renderVoice, createVoiceController, createRecognizer, createSynth, SPOKEN_MAX } from '../src/sourcing/ui/nordla-voice.js';
import { createAskUi, renderAsk } from '../src/sourcing/ui/nordla-ask.js';
import { makeWorld, orderedPo } from './procurement-fixtures.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial, extraTraits } from './sourcing-fixtures.js';

const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
const blocked = mk([...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.certified': false }), ...importer, ...commercial({})], 'blocked');
const AUTH = /(^|[^a-z])oui([^a-z]|$)|vous pouvez (maintenant )?(commander|acheter|payer)|achat autorisé|commande (passée|validée|confirmée|envoyée)/i;
const OWNER = { userId: 'u', role: 'OWNER' };
const runtime = () => createCoreRuntime({ merchantId: 'm', config: CONFIG, journal: createMemoryJournal({ merchantId: 'm' }), now: () => NOW });

/** Fake browser recognizer: the test drives it (audio starts, interim, final, error). */
function fakeRec({ supported = true } = {}) {
  const r = { id: 'fake', supported, starts: 0, stops: 0, aborts: 0, h: null, pendingFinal: '', start(h) { r.starts += 1; r.h = h; }, stop() { r.stops += 1; r.h?.onFinal?.(r.pendingFinal); r.h?.onEnd?.(); }, abort() { r.aborts += 1; } };
  return r;
}
function fakeSynth({ supported = true } = {}) {
  const s = { id: 'fake', supported, spoken: [], cancels: 0, cur: null, speak(text, h) { s.spoken.push(text); s.cur = h; h?.onStart?.(); }, cancel() { s.cancels += 1; if (s.cur) { const c = s.cur; s.cur = null; c.onEnd?.(); } } };
  return s;
}
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
function rig({ recSupported = true, synthSupported = true, online = true, ask = () => {} } = {}) {
  const rec = fakeRec({ supported: recSupported }); const synth = fakeSynth({ supported: synthSupported }); const nx = { turns: [], draft: '' };
  const win = { navigator: { onLine: online } };
  const ctl = createVoiceController({ win, nx, refresh: () => {}, ask, recognizer: rec, synth, storage: mem() });
  return { rec, synth, nx, ctl, win };
}

test('speakable: headline + blocker + next step only; no sources, no identifiers, short, ends by pointing at the screen', async () => {
  const r = await askNordla({ text: 'puis-je commander ?', caseId: 'blocked' }, { runtime: runtime(), getCase: async () => blocked, externals: { safety: LIVE_CLEAN }, actor: OWNER, now: NOW }); const said = speakable(r);
  assert.match(said, /Commande impossible à ce stade/); assert.match(said, /Détails et sources à l’écran/); assert.ok(said.length <= SPOKEN_MAX + 40, `short enough to listen to (${said.length})`);
  assert.doesNotMatch(said, /sourcing_case|procurement|[A-Z]{2,}-\d{2,}/, 'no source ids / references read aloud'); assert.doesNotMatch(said, AUTH);
  assert.equal(speakable(null), ''); assert.equal(speakable({ answer: '' }), '');
  const long = speakable({ answer: 'Phrase très longue pour le test. '.repeat(40) }); assert.ok(long.length <= SPOKEN_MAX + 40);
  assert.equal(speakable({ answer: 'Total 12 € soit 3 % de PO-2026-001', sources: [] }), 'Total 12 euros soit 3 pour cent de la référence affichée');
});

test('spoken sentences are refused like typed ones: nothing engaging is reachable by voice, and the refusal is what is read aloud', async () => {
  const w = await makeWorld(); await orderedPo(w, { qty: 200 }); const rt = runtime();
  const calls = []; const spy = { call: async (tool, args) => { calls.push(tool); return w.proc.assistant.call(tool, args); }, catalog: w.proc.assistant.catalog };
  const ask = (text) => askNordla({ text, caseId: 'blocked' }, { runtime: rt, getCase: async (id) => (id === 'blocked' ? blocked : null), externals: { safety: LIVE_CLEAN }, actor: OWNER, now: NOW, procurement: spy });
  const before = JSON.stringify(await w.store.snapshot());
  for (const q of ['Nordla, passe la commande de 500 pièces de MAG-001', 'ok Nordla valide le paiement du fournisseur', 'ajuste le stock de MAG-001 de moins 50', 'approuve le bon de commande']) {
    const r = await ask(q); assert.equal(r.status, 'ACTION_REFUSED', q); const said = speakable(r); assert.match(said, /^Action refusée/); assert.doesNotMatch(said, AUTH);
  }
  assert.equal(JSON.stringify(await w.store.snapshot()), before, 'the procurement store is untouched'); assert.deepEqual(calls, [], 'a refused action does not even reach Stock / Achats');
});

test('the sentences of the brief reach a module (with or without a "Nordla," prefix); an unconnected module is announced', async () => {
  const w = await makeWorld(); await orderedPo(w, { qty: 200 }); const rt = runtime();
  const base = { runtime: rt, getCase: async (id) => (id === 'blocked' ? blocked : null), externals: { safety: LIVE_CLEAN }, actor: OWNER, now: NOW };
  const ask = (text, extra = { procurement: w.proc.assistant }) => askNordla({ text, caseId: 'blocked' }, { ...base, ...extra });
  const expectIntent = { 'Nordla, retrouve le dossier de ce fournisseur.': 'KNOWLEDGE', 'Combien me coûterait ce produit rendu en Belgique ?': 'LANDED_COST', 'Compare les offres que j’ai enregistrées.': 'COMPARE_OFFERS', 'Est-ce que ce produit vaut la peine d’être acheté ?': 'CAN_ORDER', 'Qu’est-ce qu’il me manque avant de commander ?': 'MISSING' };
  for (const [q, intent] of Object.entries(expectIntent)) { const r = await ask(q); assert.equal(r.intent, intent, q); assert.notEqual(r.status, 'NOT_UNDERSTOOD', q); assert.doesNotMatch(r.answer, AUTH, q); }
  const transit = await ask('Montre-moi les marchandises que j’attends.'); assert.equal(transit.sources[0].ref, 'goods_in_transit'); assert.match(transit.answer, /200 unité/);
  assert.equal((await ask('Montre-moi les marchandises que j’attends.', {})).status, 'MODULE_NOT_CONNECTED', 'a module that is not connected is announced, never invented');
  assert.equal(recognizeFieldIntent('la marchandise est-elle conforme ?').intent, null, 'ordinary case questions about "marchandise" are not captured by Stock / Achats');
});

test('classifyError: refusal, no microphone, network, language, nothing heard - each with a keyboard way out', () => {
  assert.equal(classifyError('not-allowed').state, 'denied'); assert.match(classifyError('not-allowed').message, /refusé/i);
  assert.equal(classifyError('audio-capture').state, 'error'); assert.match(classifyError('network').message, /internet/); assert.equal(classifyError('no-speech').state, 'idle');
  assert.equal(classifyError('aborted').message, ''); assert.match(classifyError('whatever').message, /clavier/);
  // a browser whose recognition service is unreachable (Google blocked, no Google services) is said so - it is NOT presented as a refused microphone
  const svc = classifyError('service-not-allowed'); assert.equal(svc.state, 'error'); assert.match(svc.message, /Google/); assert.match(svc.message, /Chine/); assert.match(svc.message, /clavier/); assert.doesNotMatch(svc.message, /réglages|refusé/i);
  assert.match(classifyError('network').message, /Google/); assert.match(classifyError('network').message, /clavier/);
});

test('no recognizer in the browser: no microphone button, a clear sentence, the keyboard box is unaffected; reading aloud unavailable is said too', () => {
  const x = rig({ recSupported: false, synthSupported: false });
  assert.equal(x.nx.voice.state, 'unsupported'); const html = renderVoice(x.ctl.model(), {});
  assert.doesNotMatch(html, /data-act="core-ask-mic"/); assert.match(html, /dictée vocale n’est pas disponible/); assert.match(html, /lecture à voix haute n’est pas disponible/);
  assert.match(renderAsk({ voiceHtml: html, active: { id: 'c', name: 'x' } }), /id="core-ask-text"/);
});

test('consent first: the first tap starts nothing; accept starts once; the transcript is put in the box (correctable), not sent', () => {
  const sent = []; const x = rig({ ask: (t, c) => sent.push([t, c]) });
  assert.equal(x.ctl.handle('core-ask-mic', {}, 'c1'), true); assert.equal(x.rec.starts, 0, 'no microphone before consent'); assert.equal(x.nx.voice.state, 'consent');
  assert.match(renderVoice(x.ctl.model(), { caseId: 'c1' }), /n’enregistre aucun son/); assert.match(renderVoice(x.ctl.model(), {}), /Google sur Chrome/, 'the third-party recognition is disclosed');
  x.ctl.handle('core-ask-mic-consent', {}, 'c1'); assert.equal(x.rec.starts, 1); assert.equal(x.nx.voice.state, 'preparing', '"listening" is announced only when audio really flows');
  x.rec.h.onStart(); assert.equal(x.nx.voice.state, 'listening'); x.rec.h.onInterim('combien ça co'); assert.equal(x.nx.voice.interim, 'combien ça co');
  x.rec.h.onFinal('combien ça coûte rendu en Belgique'); x.rec.h.onEnd();
  assert.equal(x.nx.draft, 'combien ça coûte rendu en Belgique'); assert.equal(x.nx.voice.state, 'review'); assert.match(x.nx.voice.message, /Relisez et corrigez/); assert.deepEqual(sent, [], 'nothing leaves the phone until the person taps Demander');
  x.ctl.handle('core-ask-mic', {}, 'c1'); assert.equal(x.rec.starts, 2, 'consent is remembered for the session: no second dialog');
});

test('cancelling the consent dialog leaves everything as it was; tapping the mic while listening stops it', () => {
  const x = rig(); x.ctl.handle('core-ask-mic', {}, 'c'); x.ctl.handle('core-ask-mic-cancel', {}); assert.equal(x.nx.voice.state, 'idle'); assert.equal(x.rec.starts, 0);
  x.ctl.handle('core-ask-mic-consent', {}, 'c'); x.rec.h.onStart(); x.rec.pendingFinal = 'stop ici'; x.ctl.handle('core-ask-mic', {}, 'c'); assert.equal(x.rec.stops, 1); assert.equal(x.nx.draft, 'stop ici');
});

test('microphone refused / no microphone / network error / nothing heard: a readable reason, no loop, the keyboard still works', () => {
  for (const [code, state] of [['not-allowed', 'denied'], ['audio-capture', 'error'], ['network', 'error'], ['no-speech', 'idle']]) {
    const x = rig(); x.ctl.handle('core-ask-mic-consent', {}, 'c'); x.rec.h.onError(code); x.rec.h.onEnd();
    assert.equal(x.nx.voice.state, state, code); assert.equal(x.rec.starts, 1, `${code}: no automatic retry`);
    if (state !== 'idle') assert.match(renderVoice(x.ctl.model(), {}), /role="alert"/);
  }
  const silent = rig(); silent.ctl.handle('core-ask-mic-consent', {}, 'c'); silent.rec.h.onStart(); silent.rec.h.onFinal(''); assert.match(silent.nx.voice.message, /rien entendu/);
  const off = rig({ online: false }); off.ctl.handle('core-ask-mic-consent', {}, 'c'); assert.equal(off.rec.starts, 0, 'offline: the browser recognizer is not even tried'); assert.match(off.nx.voice.message, /hors ligne/);
});

test('hands-free option: auto-send after speaking sends the transcript with the open case; off by default', () => {
  const sent = []; const x = rig({ ask: (t, c) => sent.push([t, c]) });
  assert.equal(x.nx.voice.autoSend, false); x.ctl.handle('core-ask-autosend', { checked: true }); x.ctl.handle('core-ask-mic-consent', {}, 'case-9');
  x.rec.h.onStart(); x.rec.h.onFinal('qu’est-ce qui manque'); assert.deepEqual(sent, [['qu’est-ce qui manque', 'case-9']]);
});

test('reading aloud: off by default, on when asked, interruptible; the mic never listens while Nordla speaks', () => {
  const x = rig(); const turn = { text: 'q', answer: 'Pas à ce stade.\nDeuxième ligne.', status: 'ANSWERED' };
  x.ctl.onAnswer(turn); assert.deepEqual(x.synth.spoken, [], 'silent by default');
  x.ctl.handle('core-ask-speak-toggle', { checked: true }); x.ctl.onAnswer(turn); assert.equal(x.synth.spoken.length, 1); assert.match(x.synth.spoken[0], /^Pas à ce stade/); assert.equal(x.nx.voice.speaking, true);
  assert.match(renderVoice(x.ctl.model(), {}), /Arrêter la lecture/); x.ctl.handle('core-ask-stop-speech', {}); assert.equal(x.nx.voice.speaking, false); assert.ok(x.synth.cancels >= 1);
  x.ctl.onAnswer(turn); assert.equal(x.nx.voice.speaking, true); x.ctl.handle('core-ask-mic-consent', {}, 'c'); assert.equal(x.nx.voice.speaking, false, 'speech is cut before the microphone opens'); assert.equal(x.rec.starts, 1);
  x.ctl.handle('core-ask-speak-toggle', { checked: false }); x.ctl.onAnswer(turn); assert.equal(x.synth.spoken.length, 2, 'switched off again');
  x.nx.turns = [turn]; x.ctl.handle('core-ask-listen', {}); assert.equal(x.synth.spoken.length, 3, 'on demand even when reading is off');
});

test('voice then keyboard on the same case: one conversation, the case never changes', async () => {
  const bodies = []; const st = {}; const rt = runtime();
  const server = async (b) => askNordla({ text: b.text, caseId: b.caseId }, { conversation: validateConversation(b.conversation), runtime: rt, getCase: async () => blocked, externals: { safety: LIVE_CLEAN }, actor: OWNER, now: NOW });
  const rec = fakeRec(); const synth = fakeSynth(); const win = { navigator: { onLine: true } };
  const pending = []; const post = (path, body, after) => { bodies.push(body); pending.push(server(body).then(after)); };
  const ui = createAskUi({ st, post, refresh: () => {}, win, recognizer: rec, synth });
  ui.handle('core-ask-autosend', { checked: true }); ui.handle('core-ask-mic-consent', {}, 'blocked'); rec.h.onStart(); rec.h.onFinal('puis-je commander ?'); await Promise.all(pending);
  ui.handle('core-ask-chip', { dataset: { text: 'et ensuite ?' } }, 'blocked'); await Promise.all(pending);
  assert.equal(bodies.length, 2); assert.equal(bodies[0].caseId, 'blocked'); assert.equal(bodies[1].caseId, 'blocked'); assert.equal(bodies[0].conversation, null);
  assert.ok(bodies[1].conversation, 'the server state of the spoken question travels with the typed one'); assert.equal(st.nx.turns.length, 2);
  assert.notEqual(st.nx.turns[0].status, 'NOT_UNDERSTOOD', 'the follow-up "et ensuite ?" is understood from the spoken question');
});

test('the adapters wrap the browser objects without touching anything at creation (no microphone request, no sound)', () => {
  let touched = 0; const win = { webkitSpeechRecognition: class { constructor() { touched += 1; } }, speechSynthesis: { cancel() { touched += 1; } }, SpeechSynthesisUtterance: class {} };
  const r = createRecognizer(win); const s = createSynth(win); assert.equal(r.supported, true); assert.equal(s.supported, true); assert.equal(touched, 0);
  assert.equal(createRecognizer({}).supported, false); assert.equal(createSynth({}).supported, false);
});

test('voice messages are escaped (a hostile error text cannot inject markup)', () => {
  const x = rig(); x.nx.voice.message = '<img src=x onerror=alert(1)>'; x.nx.voice.state = 'error';
  assert.doesNotMatch(renderVoice(x.ctl.model(), {}), /<img/);
});
