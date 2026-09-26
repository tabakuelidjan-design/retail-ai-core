'use strict';
// Voice input ("Parler à Nordla", the microphone of the "Demander à Nordla" box): speech provider -> text -> the question field -> the SAME /api/ask as typed questions.
// This file only turns speech into TEXT. It never records, stores or uploads audio (no MediaRecorder, no getUserMedia, no fetch), and it never submits
// anything by itself: the transcription lands in the text field, where the user can correct it, and only the user's own "send" runs the question.
//
// Provider-neutral: a speech provider is any object
//   { name, isAvailable(): boolean, start({ lang, onInterim(text), onFinal(text), onError(kind), onEnd() }): void, stop(): void }
// and `SPEECH_PROVIDERS` lists the candidates in priority order. Today the only one is the browser's own recognition (Chrome / Edge first). No external
// speech-to-text service is bundled or chosen; adding one later means adding one object to that list.

const SPEECH_LANGS = { fr: 'fr-FR', nl: 'nl-BE', en: 'en-GB' };
const speechLang = (uiLang) => SPEECH_LANGS[uiLang] || SPEECH_LANGS.fr;

/** Recognition error code (Web Speech API vocabulary) -> one of our fixed kinds. 'aborted' is our own stop, not an error. */
function speechErrorKind(code) {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'denied';
  if (code === 'no-speech') return 'noSpeech';
  if (code === 'audio-capture') return 'mic';
  if (code === 'network') return 'network';
  if (code === 'aborted') return 'aborted';
  return 'generic';
}

/** The browser's own speech recognition (Chrome / Edge expose it; the browser asks for the microphone permission itself when start() is called). */
function browserSpeechProvider(win) {
  const w = win || (typeof window !== 'undefined' ? window : {});
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition || null;
  let rec = null;
  return {
    name: 'browser',
    isAvailable: () => typeof Ctor === 'function',
    start({ lang, onInterim, onFinal, onError, onEnd }) {
      rec = new Ctor();
      rec.lang = lang; rec.continuous = false; rec.interimResults = true; rec.maxAlternatives = 1;
      rec.onresult = (ev) => {
        let interim = ''; let final = '';
        for (let i = ev.resultIndex; i < ev.results.length; i += 1) { const r = ev.results[i]; const txt = r[0] && r[0].transcript ? r[0].transcript : ''; if (r.isFinal) final += txt; else interim += txt; }
        if (final) onFinal(final.trim()); else if (interim) onInterim(interim.trim());
      };
      rec.onerror = (ev) => onError(speechErrorKind(ev && ev.error));
      rec.onend = () => onEnd();
      rec.start(); // the browser shows its own microphone permission prompt here, in response to the user's click
    },
    stop() { try { if (rec) rec.stop(); } catch (e) { /* already stopped */ } },
  };
}

const SPEECH_PROVIDERS = [browserSpeechProvider];
function pickSpeechProvider(factories) {
  for (const make of factories || SPEECH_PROVIDERS) { try { const p = make(); if (p && p.isAvailable()) return p; } catch (e) { /* try the next one */ } }
  return null;
}

/**
 * The voice state machine, independent of any DOM.
 *   idle -> listening -> transcribing -> idle (text delivered)      unsupported: no provider at all
 *   any  -> denied | mic | noSpeech | network | generic (a message, and the user can try again or simply type)
 * `onText(text, isFinal)` receives the transcription for the text field; nothing is ever sent from here.
 */
function createSpeechController({ provider, getLang, onState, onText }) {
  let state = provider ? 'idle' : 'unsupported'; let failed = false;
  const set = (s) => { state = s; onState(s); };
  onState(state);
  return {
    get state() { return state; },
    supported: !!provider,
    toggle() {
      if (!provider) return;
      if (state === 'listening') { provider.stop(); return; }
      if (state === 'transcribing') return;
      failed = false; set('listening');
      try {
        provider.start({
          lang: speechLang(getLang()),
          onInterim: (txt) => { onText(txt, false); },
          onFinal: (txt) => { set('transcribing'); onText(txt, true); },
          onError: (kind) => { if (kind === 'aborted') return; failed = true; set(kind); },
          onEnd: () => { if (!failed) set('idle'); },
        });
      } catch (e) { failed = true; set('generic'); }
    },
    stop() { if (provider && (state === 'listening' || state === 'transcribing')) provider.stop(); },
  };
}
