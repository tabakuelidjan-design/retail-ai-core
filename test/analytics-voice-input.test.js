import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Voice input for "Parle à Nordla": speech -> text -> the question field -> the same /api/ask. No audio is ever recorded, stored or uploaded.
// The real speech.js / ask.js sources run here in a vm with a tiny DOM stub and a fake speech provider (no microphone in tests).

const ui = (f) => readFileSync(new URL(`../src/analytics-premium/ui/${f}`, import.meta.url), 'utf8');
const speechSrc = ui('speech.js'); const askSrc = ui('ask.js');

// ---------- speech.js on its own ----------
function loadSpeech(win = {}) {
  const ctx = { window: win, console };
  vm.runInNewContext(`${speechSrc}\nthis.__api = { speechLang, speechErrorKind, browserSpeechProvider, pickSpeechProvider, createSpeechController, SPEECH_PROVIDERS };`, ctx);
  return ctx.__api;
}
/** A fake browser SpeechRecognition: tests drive its events by hand. */
function fakeRecognitionClass() {
  const inst = [];
  class Rec { constructor() { this.started = 0; this.stopped = 0; inst.push(this); } start() { this.started += 1; } stop() { this.stopped += 1; } }
  return { Rec, inst };
}
const result = (text, isFinal) => ({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });

test('language mapping and error mapping are fixed and safe', () => {
  const s = loadSpeech();
  assert.equal(s.speechLang('fr'), 'fr-FR'); assert.equal(s.speechLang('nl'), 'nl-BE'); assert.equal(s.speechLang('en'), 'en-GB'); assert.equal(s.speechLang('xx'), 'fr-FR');
  for (const [code, kind] of [['not-allowed', 'denied'], ['service-not-allowed', 'denied'], ['no-speech', 'noSpeech'], ['audio-capture', 'mic'], ['network', 'network'], ['aborted', 'aborted'], ['whatever', 'generic'], [undefined, 'generic']]) assert.equal(s.speechErrorKind(code), kind, String(code));
});

test('browser without speech recognition: no provider, the controller says "unsupported", start is a no-op', () => {
  const s = loadSpeech({}); // no SpeechRecognition / webkitSpeechRecognition
  assert.equal(s.browserSpeechProvider({}).isAvailable(), false); assert.equal(s.pickSpeechProvider(), null);
  const states = []; const c = s.createSpeechController({ provider: null, getLang: () => 'fr', onState: (x) => states.push(x), onText: () => assert.fail('no text without a provider') });
  assert.deepEqual(states, ['unsupported']); assert.equal(c.supported, false); c.toggle(); c.stop(); assert.deepEqual(states, ['unsupported']);
});

test('Chrome / Edge: the prefixed webkitSpeechRecognition is used when the standard one is absent', () => {
  const { Rec } = fakeRecognitionClass();
  const s = loadSpeech({ webkitSpeechRecognition: Rec }); assert.equal(s.browserSpeechProvider({ webkitSpeechRecognition: Rec }).isAvailable(), true);
  assert.equal(s.pickSpeechProvider([() => s.browserSpeechProvider({ SpeechRecognition: Rec })]).name, 'browser');
});

test('opening the microphone: nothing starts on its own; one click starts recognition once, with the UI language (the browser asks for permission then)', () => {
  const { Rec, inst } = fakeRecognitionClass(); const s = loadSpeech({});
  const provider = s.browserSpeechProvider({ SpeechRecognition: Rec });
  const c = s.createSpeechController({ provider, getLang: () => 'nl', onState: () => {}, onText: () => {} });
  assert.equal(inst.length, 0, 'creating the controller never touches the microphone');
  c.toggle();
  assert.equal(inst.length, 1); assert.equal(inst[0].started, 1); assert.equal(inst[0].lang, 'nl-BE'); assert.equal(inst[0].continuous, false); assert.equal(inst[0].interimResults, true);
  assert.equal(c.state, 'listening');
});

test('permission accepted + successful transcription: interim text, then final text, then back to idle; the text is only DELIVERED, never sent', () => {
  const { Rec, inst } = fakeRecognitionClass(); const s = loadSpeech({}); const states = []; const texts = [];
  const c = s.createSpeechController({ provider: s.browserSpeechProvider({ SpeechRecognition: Rec }), getLang: () => 'fr', onState: (x) => states.push(x), onText: (t, f) => texts.push([t, f]) });
  c.toggle(); const r = inst[0];
  r.onresult(result('quel est mon', false)); r.onresult(result('quel est mon chiffre d’affaires', true)); r.onend();
  assert.deepEqual(texts, [['quel est mon', false], ['quel est mon chiffre d’affaires', true]]);
  assert.deepEqual(states, ['idle', 'listening', 'transcribing', 'idle']);
});

test('permission refused: a "denied" state, no text, the user can try again', () => {
  const { Rec, inst } = fakeRecognitionClass(); const s = loadSpeech({}); const states = []; let delivered = 0;
  const c = s.createSpeechController({ provider: s.browserSpeechProvider({ SpeechRecognition: Rec }), getLang: () => 'fr', onState: (x) => states.push(x), onText: () => { delivered += 1; } });
  c.toggle(); inst[0].onerror({ error: 'not-allowed' }); inst[0].onend();
  assert.equal(c.state, 'denied'); assert.equal(delivered, 0); assert.deepEqual(states, ['idle', 'listening', 'denied']);
  c.toggle(); assert.equal(inst.length, 2, 'a new attempt is possible'); assert.equal(c.state, 'listening');
});

test('microphone error, nothing heard, network problem: each gets its own state; our own stop is not an error', () => {
  for (const [code, kind] of [['audio-capture', 'mic'], ['no-speech', 'noSpeech'], ['network', 'network'], ['language-not-supported', 'generic']]) {
    const { Rec, inst } = fakeRecognitionClass(); const s = loadSpeech({});
    const c = s.createSpeechController({ provider: s.browserSpeechProvider({ SpeechRecognition: Rec }), getLang: () => 'fr', onState: () => {}, onText: () => {} });
    c.toggle(); inst[0].onerror({ error: code }); assert.equal(c.state, kind, code);
  }
  const { Rec, inst } = fakeRecognitionClass(); const s = loadSpeech({});
  const c = s.createSpeechController({ provider: s.browserSpeechProvider({ SpeechRecognition: Rec }), getLang: () => 'fr', onState: () => {}, onText: () => {} });
  c.toggle(); c.toggle(); assert.equal(inst[0].stopped, 1, 'a second click stops listening');
  inst[0].onerror({ error: 'aborted' }); inst[0].onend(); assert.equal(c.state, 'idle', 'aborted is not an error');
});

test('a provider that throws on start becomes a clear "generic" state instead of a silent button', () => {
  const s = loadSpeech({}); const bad = { name: 'x', isAvailable: () => true, start() { throw new Error('boom'); }, stop() {} };
  const c = s.createSpeechController({ provider: bad, getLang: () => 'fr', onState: () => {}, onText: () => {} }); c.toggle(); assert.equal(c.state, 'generic');
});

test('provider-neutral: any object with the same contract can replace the browser provider', () => {
  const s = loadSpeech({}); const texts = [];
  const custom = { name: 'future-provider', isAvailable: () => true, start({ onFinal, onEnd }) { onFinal('bonjour'); onEnd(); }, stop() {} };
  assert.equal(s.pickSpeechProvider([() => ({ name: 'off', isAvailable: () => false, start() {}, stop() {} }), () => custom]).name, 'future-provider', 'unavailable providers are skipped, the next one is used');
  const c = s.createSpeechController({ provider: custom, getLang: () => 'fr', onState: () => {}, onText: (t) => texts.push(t) }); c.toggle();
  assert.deepEqual(texts, ['bonjour']);
});

// ---------- the question box (real ask.js) with a fake DOM ----------
function makeDom() {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.value = ''; this._text = ''; this.disabled = false; const set = new Set(); this.classList = { toggle: (c, on) => { if (on) set.add(c); else set.delete(c); }, has: (c) => set.has(c), add: (c) => set.add(c) }; this.className = ''; this.style = {}; }
    setAttribute(k, v) { this.attrs[k] = v; } appendChild(c) { this.children.push(c); return c; } addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
    remove() { this.removed = true; } focus() { this.focused = true; } querySelector() { return null; } scrollIntoView() {}
    set textContent(v) { this._text = String(v); this.children = []; } get textContent() { return this._text; }
    fire(ev, extra = {}) { for (const fn of this.listeners[ev] ?? []) fn({ target: this, preventDefault() {}, ...extra }); }
  }
  const h = (tag, attrs, ...ch) => { const el = new El(tag); for (const [k, v] of Object.entries(attrs ?? {})) { if (k === 'class') el.className = v; else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); else if (v != null) el.attrs[k] = v; } const add = (c) => { if (Array.isArray(c)) c.forEach(add); else if (c != null) { if (typeof c === 'object') el.children.push(c); else el._text += String(c); } }; ch.forEach(add); return el; };
  const deep = (el) => (el._text ?? '') + (el.children ?? []).map(deep).join('');
  const walk = (el, pred, out = []) => { if (pred(el)) out.push(el); for (const c of el.children ?? []) walk(c, pred, out); return out; };
  return { El, h, walk, deep };
}
function loadAsk({ providers }) {
  const { h, walk, deep } = makeDom(); const fetches = []; const body = { children: [], appendChild(c) { this.children.push(c); return c; } };
  const ctx = { document: { body, addEventListener() {}, removeEventListener() {} }, h, t: (k, ...a) => [k, ...a].join('|'), NordlaIcon: { parle: () => 'icon' }, NORDLA_I18N: { getLang: () => 'fr' }, AbortController, setTimeout, clearTimeout, console,
    location: { hash: '#/' }, fetch: async (url, opts) => { fetches.push({ url, opts }); return { ok: true, json: async () => ({ figures: [{ id: 'order_count', value: 3 }], sources: [{ report: 'x' }], explanation: { status: 'NOT_CONFIGURED' }, period: {}, currency: 'EUR' }) }; } };
  vm.runInNewContext(`${speechSrc}\n${askSrc}\nSPEECH_PROVIDERS.splice(0, SPEECH_PROVIDERS.length, ...__providers);\nthis.__api = { openAsk, closeAsk, askOpen: () => askOpen };`, Object.assign(ctx, { __providers: providers }));
  ctx.__api.openAsk();
  const root = body.children[0];
  const find = (cls) => walk(root, (e) => (e.className || '').split(' ').includes(cls))[0];
  return { ctx, root, find, fetches, deep, ...ctx.__api };
}
const fakeProvider = () => { const calls = { start: 0, stop: 0 }; let cb = null; return { calls, emit: (name, ...a) => cb[name](...a), provider: { name: 'fake', isAvailable: () => true, start(o) { calls.start += 1; cb = o; }, stop() { calls.stop += 1; } } }; };

test('the question box shows the microphone button, ready, with the privacy note; typed questions still work exactly as before', async () => {
  const fp = fakeProvider(); const d = loadAsk({ providers: [() => fp.provider] });
  const mic = d.find('ask-mic'); assert.ok(mic); assert.match(d.deep(mic), /ask\.voice\.start/); assert.equal(mic.disabled, false);
  assert.ok(d.find('ask-voice-note') && /ask\.voice\.privacy/.test(d.find('ask-voice-note')._text), 'the privacy line is shown');
  assert.equal(fp.calls.start, 0, 'opening the box does not start listening');
  const input = d.find('ask-input'); input.value = 'Combien de commandes ?'; d.find('ask-send').fire('click'); await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.fetches.length, 1); assert.equal(d.fetches[0].url, '/api/ask'); assert.equal(JSON.parse(d.fetches[0].opts.body).question, 'Combien de commandes ?');
});

test('click on the microphone: "listening" is shown; transcription appears in the field; NOTHING is sent until the user sends', async () => {
  const fp = fakeProvider(); const d = loadAsk({ providers: [() => fp.provider] });
  const mic = d.find('ask-mic'); const status = d.find('ask-voice-status'); const input = d.find('ask-input');
  mic.fire('click');
  assert.equal(fp.calls.start, 1); assert.match(status._text, /ask\.voice\.listening/); assert.equal(mic.attrs['aria-pressed'], 'true'); assert.match(d.deep(mic), /ask\.voice\.stop/);
  fp.emit('onInterim', 'quel est mon chi');   assert.equal(input.value, 'quel est mon chi');
  fp.emit('onFinal', 'quel est mon chiffre d’affaires');
  assert.equal(input.value, 'quel est mon chiffre d’affaires'); assert.match(status._text, /ask\.voice\.transcribing/); assert.equal(mic.disabled, true, 'busy while transcribing');
  fp.emit('onEnd'); assert.match(status._text, /ask\.voice\.done/, 'the user is told to check and send'); assert.equal(mic.disabled, false);
  assert.equal(d.fetches.length, 0, 'no business action, no request, on the strength of the voice alone');
});

test('manual correction, then send: the CORRECTED text goes through the same POST /api/ask, and only text is sent (no audio field)', async () => {
  const fp = fakeProvider(); const d = loadAsk({ providers: [() => fp.provider] });
  d.find('ask-mic').fire('click'); fp.emit('onFinal', 'quel est mon chiffre d’affaire des trente jours'); fp.emit('onEnd');
  const input = d.find('ask-input'); input.value = 'Quel est mon chiffre d’affaires des 30 derniers jours ?'; // the user fixes the transcription
  d.find('ask-send').fire('click'); await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.fetches.length, 1);
  const { url, opts } = d.fetches[0]; assert.equal(url, '/api/ask'); assert.equal(opts.method, 'POST'); assert.equal(opts.headers['Content-Type'], 'application/json');
  const sent = JSON.parse(opts.body); assert.equal(sent.question, 'Quel est mon chiffre d’affaires des 30 derniers jours ?');
  assert.deepEqual(Object.keys(sent).sort(), ['history', 'lang', 'period', 'question'], 'exactly the typed-question payload (+ the short text history of this open box): no audio, no transcript metadata');
  assert.deepEqual(sent.history, [], 'the first question of a conversation carries no history');
});

test('Enter in the field after a dictation also goes through the normal path', async () => {
  const fp = fakeProvider(); const d = loadAsk({ providers: [() => fp.provider] });
  d.find('ask-mic').fire('click'); fp.emit('onFinal', 'combien de commandes'); fp.emit('onEnd');
  d.find('ask-input').fire('keydown', { key: 'Enter' }); await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.fetches.length, 1); assert.equal(JSON.parse(d.fetches[0].opts.body).question, 'combien de commandes');
});

test('permission refused / microphone error: a clear message, the field stays usable, nothing is sent', async () => {
  for (const [kind, key] of [['denied', 'ask.voice.denied'], ['mic', 'ask.voice.mic'], ['noSpeech', 'ask.voice.noSpeech'], ['network', 'ask.voice.network']]) {
    const fp = fakeProvider(); const d = loadAsk({ providers: [() => fp.provider] });
    d.find('ask-mic').fire('click'); fp.emit('onError', kind); fp.emit('onEnd');
    assert.match(d.find('ask-voice-status')._text, new RegExp(key.replace(/\./g, '\\.')), kind); assert.ok(d.find('ask-voice-status').classList.has('bad'));
    assert.equal(d.find('ask-mic').disabled, false, 'the user can try again');
    const input = d.find('ask-input'); input.value = 'Combien de commandes ?'; d.find('ask-send').fire('click'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(d.fetches.length, 1, 'typing still works after a voice failure'); assert.equal(JSON.parse(d.fetches[0].opts.body).question, 'Combien de commandes ?');
  }
});

test('browser without speech recognition: the button is disabled with a clear message, the text field works, no privacy claim about a service that is not used', async () => {
  const d = loadAsk({ providers: [] });
  const mic = d.find('ask-mic'); assert.equal(mic.disabled, true); assert.match(d.find('ask-voice-status')._text, /ask\.voice\.unsupported/); assert.equal(d.find('ask-voice-note'), undefined);
  const input = d.find('ask-input'); input.value = 'Combien de commandes ?'; d.find('ask-send').fire('click'); await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.fetches.length, 1);
});

test('closing the question box while listening stops the microphone', () => {
  const fp = fakeProvider(); const d = loadAsk({ providers: [() => fp.provider] });
  d.find('ask-mic').fire('click'); assert.equal(fp.calls.stop, 0); d.closeAsk(); assert.equal(fp.calls.stop, 1);
});

test('no audio handling anywhere in the front end, and no new server route: speech.js only produces text', () => {
  assert.doesNotMatch(speechSrc.replace(/^\s*\/\/.*$/gm, ''), /MediaRecorder|getUserMedia|AudioContext|Blob|FormData|fetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon/);
  assert.doesNotMatch(askSrc.replace(/^\s*\/\/.*$/gm, ''), /MediaRecorder|getUserMedia|audio/i);
  const app = readFileSync(new URL('../src/analytics-premium/server/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\/api\/(speech|voice|transcri|audio)/i, 'no second assistant endpoint: voice uses /api/ask');
  assert.match(ui('index.html'), /speech\.js[\s\S]*ask\.js/, 'speech.js is loaded before ask.js');
  for (const lang of ['fr', 'nl', 'en']) { const src = ui(`lang-${lang}.js`); for (const k of ['start', 'stop', 'listening', 'transcribing', 'done', 'denied', 'mic', 'noSpeech', 'network', 'generic', 'unsupported', 'privacy']) assert.match(src, new RegExp(`'ask\\.voice\\.${k}'`), `${lang} ${k}`); }
  assert.match(ui('lang-fr.js'), /'ask\.voice\.listening': 'Je vous écoute…'/);
});

// ---------- names + icon ("Demander à Nordla" = the text assistant, "Parler à Nordla" = the microphone only) ----------
const langSrc = (l) => ui(`lang-${l}.js`);
const val = (src, key) => { const m = new RegExp(`'${key.replace(/\./g, '\.')}': '([^']*)'`).exec(src); return m ? m[1] : null; };

test('names: the text assistant is "Demander à Nordla" everywhere; "Parler à Nordla" is reserved for the microphone (FR / NL / EN)', () => {
  const expected = { fr: ['Demander à Nordla', 'Parler à Nordla'], nl: ['Vraag het Nordla', 'Praat met Nordla'], en: ['Ask Nordla', 'Talk to Nordla'] };
  for (const [l, [text, voice]] of Object.entries(expected)) {
    const src = langSrc(l);
    assert.equal(val(src, 'nav.askNordla'), text, `${l} open button / sidebar`); assert.equal(val(src, 'ask.title'), text, `${l} window title + aria-label`);
    assert.equal(val(src, 'ask.voice.start'), voice, `${l} microphone button`);
    assert.notEqual(text, voice, `${l}: the two uses have different names`);
  }
  for (const l of ['fr', 'nl', 'en']) assert.doesNotMatch(langSrc(l), /Parle à Nordla/, `${l}: the old name is gone`);
  // the box itself: title and field label use ask.title, the microphone uses ask.voice.start
  assert.match(askSrc, /'aria-label': t\('ask\.title'\)/); assert.match(askSrc, /h\('h2', null, t\('ask\.title'\)\)/);
});

test('icon: the microphone button shows the new Nordla microphone icon, never the old emoji, in the ready AND listening states', () => {
  assert.doesNotMatch(askSrc, /\uD83C\uDFA4|🎤/, 'the emoji is gone from ask.js');
  const fp = fakeProvider(); const d = loadAsk({ providers: [() => fp.provider] });
  const mic = d.find('ask-mic'); const icon = () => mic.children.find((c) => c.className === 'ask-mic-icon');
  assert.equal(icon().tag, 'img'); assert.equal(icon().attrs.src, '/assets/nordla-mic.png'); assert.match(icon().attrs.srcset, /nordla-mic@2x\.png 2x/);
  assert.equal(icon().attrs.alt, ''); assert.equal(icon().attrs['aria-hidden'], 'true', 'decorative: the button text says what it does');
  assert.equal(icon().attrs.width, icon().attrs.height, 'square: the proportions are kept');
  assert.match(d.deep(mic), /ask\.voice\.start/);
  mic.fire('click'); // listening: same icon, "Stop" label, active state
  assert.ok(icon(), 'the icon stays during listening'); assert.match(d.deep(mic), /ask\.voice\.stop/); assert.ok(mic.classList.has('on')); assert.equal(mic.attrs['aria-pressed'], 'true');
  fp.emit('onEnd'); assert.ok(icon()); assert.match(d.deep(mic), /ask\.voice\.start/); assert.ok(!mic.classList.has('on'));
  assert.equal(d.fetches.length, 0, 'the end of speech never sends anything by itself');
});

test('icon files are real square PNGs served by the Analytics server; the active state is styled on the same icon', async () => {
  for (const [f, px] of [['nordla-mic.png', 96], ['nordla-mic@2x.png', 192]]) {
    const b = readFileSync(new URL(`../src/analytics-premium/ui/assets/${f}`, import.meta.url));
    assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG'); assert.equal(b.readUInt32BE(16), px); assert.equal(b.readUInt32BE(20), px);
  }
  const { createAnalyticsPremiumApp } = await import('../src/analytics-premium/server/app.js');
  const http = await import('node:http'); const { mkdtemp } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: await mkdtemp(path.join(tmpdir(), 'ap-mic-')) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/assets/nordla-mic.png`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  } finally { server.close(); }
  const css = ui('style.css');
  assert.match(css, /\.ask-mic-icon \{ width: 22px; height: 22px; flex: 0 0 22px;[^}]*object-fit: contain;/, 'fixed square size, never stretched');
  assert.match(css, /\.ask-mic\.on \.ask-mic-icon \{/, 'listening: an active state on the same icon');
});

test('privacy wording: audio is neither recorded nor stored, recognition is the browser\'s, only the transcribed text reaches Nordla (FR / NL / EN)', () => {
  assert.equal(val(langSrc('fr'), 'ask.voice.privacy'), 'Nordla n’enregistre ni ne stocke votre audio. La reconnaissance vocale est fournie par votre navigateur et peut, selon le navigateur, utiliser les services de son fournisseur. Seul le texte transcrit est envoyé à Nordla.');
  assert.match(val(langSrc('nl'), 'ask.voice.privacy'), /neemt uw audio niet op en slaat die niet op[\s\S]*browser[\s\S]*Alleen de getranscribeerde tekst wordt naar Nordla verzonden\./);
  assert.match(val(langSrc('en'), 'ask.voice.privacy'), /does not record or store your audio[\s\S]*provided by your browser[\s\S]*Only the transcribed text is sent to Nordla\./);
});

test('mobile: the microphone is never hidden on small screens; below 360 px only the text is shortened, the full aria-label stays, the icon stays', () => {
  const css = ui('style.css'); const ask = ui('ask.js');
  assert.ok(!/@media[^{]*\{[^}]*\.ask-mic(?!-)[^}]*display:\s*none/.test(css), 'no media query hides the microphone button');
  assert.match(css, /@media \(max-width: 359px\) \{ \.ask-mic-full \{ display: none; \} \.ask-mic-short \{ display: inline; \} \}/);
  assert.match(ask, /mic\.setAttribute\('aria-label', micFull\.textContent\)/);
  assert.match(ask, /ask\.voice\.short/);
  for (const l of ['lang-fr.js', 'lang-nl.js', 'lang-en.js']) assert.match(ui(l), /'ask\.voice\.short':/);
});
