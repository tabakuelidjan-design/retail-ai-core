// Parle à Nordla - voice (V2): speak the question, read the answer aloud. The microphone only FILLS the question box with text the person can read and correct;
// the question then goes through the same server pipeline as a typed one (read-only: a spoken "passe la commande" is refused like a typed one). No audio is recorded or stored
// by Nordla: recognition is the browser's own (Web Speech API), swappable through the two small provider objects below (createRecognizer / createSynth).
// HONEST LIMITS: on Chrome for Android the browser sends the audio to its own recognition service (Google), so it needs a network and may not work in mainland China; it is not an
// offline engine. When it is unavailable, refused or fails, the keyboard stays the way in (Android keyboards have their own microphone key).
// Pure helpers (speakable, classifyError) and the controller take their browser objects as arguments, so they run in Node tests with fakes.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SPOKEN_MAX = 320;
export const LANG = 'fr-FR';

/** What is read aloud: the headline, the blocker and the next step - never sources, tables, identifiers or the whole structured answer. The written answer stays on screen. */
export function speakable(turn, { max = SPOKEN_MAX } = {}) {
  if (!turn) return '';
  const lines = String(turn.answer ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const parts = [];
  if (turn.status === 'ACTION_REFUSED') parts.push('Action refusée. Nordla répond aux questions ; il ne commande, ne paie et ne modifie rien.');
  else {
    if (lines[0]) parts.push(lines[0]);
    if (turn.orderBlocked) parts.push('Commande impossible à ce stade.');
    const next = turn.sections?.next?.[0];
    if (next) parts.push(`Prochaine vérification : ${next}`);
    else if (!turn.sections) parts.push(...lines.slice(1, 3));
  }
  let text = parts.join(' ')
    .replace(/\b[A-Za-z0-9]{2,}(?:-[A-Za-z0-9]+)+\b/g, 'la référence affichée') // identifiers (PO-2026-001, TEST-MAG-001) are unintelligible aloud
    .replace(/(\d)\s?€/g, '$1 euros').replace(/€/g, ' euros').replace(/(\d)\s?%/g, '$1 pour cent').replace(/\bUSD\b/g, 'dollars').replace(/\bMOQ\b/g, 'quantité minimale')
    .replace(/[*_`#>|]/g, ' ').replace(/\s+/g, ' ').trim();
  let cut = false;
  if (text.length > max) { const head = text.slice(0, max); const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; ')); text = (stop > 80 ? head.slice(0, stop + 1) : head.replace(/\s\S*$/, '')).trim(); cut = true; }
  if ((cut || turn.sections || (turn.sources?.length ?? 0) > 0) && text) text += ' Détails et sources à l’écran.';
  return text;
}

/** Browser SpeechRecognition error code -> what the person sees. `fallback` is always the keyboard. */
export function classifyError(code) {
  switch (code) {
    // Chrome without Google services (a phone sold in China, or Google blocked) answers 'service-not-allowed' although the microphone IS allowed: telling the person to change a setting would be wrong
    case 'service-not-allowed': return { state: 'error', message: 'Le service de reconnaissance vocale du navigateur (Google sur Chrome) n’est pas disponible ici : il est souvent inaccessible en Chine. Écrivez la question, ou utilisez la touche micro du clavier du téléphone.' };
    case 'not-allowed': return { state: 'denied', message: 'Le micro est refusé pour ce site. Autorisez-le dans les réglages du navigateur (icône à gauche de l’adresse), ou écrivez la question.' };
    case 'audio-capture': return { state: 'error', message: 'Aucun microphone n’a été trouvé. Écrivez la question au clavier.' };
    case 'network': return { state: 'error', message: 'La reconnaissance vocale du navigateur a besoin d’internet et du service de Google (souvent inaccessible en Chine) : il n’a pas répondu. Écrivez la question (la touche micro du clavier du téléphone peut fonctionner).' };
    case 'language-not-supported': return { state: 'error', message: 'Le français n’est pas disponible pour la dictée sur ce navigateur. Écrivez la question.' };
    case 'no-speech': return { state: 'idle', message: 'Je n’ai rien entendu. Touchez le micro et parlez, ou écrivez la question.' };
    case 'aborted': return { state: 'idle', message: '' };
    default: return { state: 'error', message: 'La dictée n’a pas fonctionné. Écrivez la question au clavier.' };
  }
}

/** Provider 1 - speech to text. Replaceable: anything with { supported, start({lang,onStart,onInterim,onFinal,onError,onEnd}), stop() }. */
export function createRecognizer(win) {
  const SR = win?.SpeechRecognition ?? win?.webkitSpeechRecognition ?? null; let rec = null;
  return {
    id: 'browser-web-speech', supported: !!SR,
    start({ lang = LANG, onStart, onInterim, onFinal, onError, onEnd }) {
      rec = new SR(); rec.lang = lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
      let fin = ''; let failed = false;
      rec.onaudiostart = () => onStart?.(); // "listening" is announced when audio really flows
      rec.onresult = (ev) => { let interim = ''; for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) fin += `${r[0].transcript} `; else interim += r[0].transcript; } if (interim) onInterim?.(interim.trim()); };
      rec.onerror = (ev) => { failed = true; onError?.(ev.error); };
      rec.onend = () => { rec = null; if (!failed) onFinal?.(fin.trim()); onEnd?.(); };
      rec.start();
    },
    stop() { try { rec?.stop(); } catch { /* already stopped */ } },
    abort() { try { rec?.abort(); } catch { /* already stopped */ } },
  };
}

/** Provider 2 - text to speech. Replaceable: { supported, speak(text,{onStart,onEnd}), cancel() }. Picks a French voice if the device has one. */
export function createSynth(win) {
  const synth = win?.speechSynthesis ?? null; const Utt = win?.SpeechSynthesisUtterance ?? null;
  return {
    id: 'browser-speech-synthesis', supported: !!(synth && Utt),
    speak(text, { onStart, onEnd } = {}) {
      synth.cancel(); const u = new Utt(text); u.lang = LANG; u.rate = 1;
      const v = (synth.getVoices?.() ?? []).find((x) => /^fr(-|_)/i.test(x.lang)); if (v) u.voice = v;
      u.onstart = () => onStart?.(); u.onend = () => onEnd?.(); u.onerror = () => onEnd?.();
      synth.speak(u);
    },
    cancel() { try { synth?.cancel(); } catch { /* nothing playing */ } },
  };
}

const LABEL = { idle: 'Parler', consent: 'Parler', preparing: 'Autorisation du micro…', listening: 'J’écoute… (toucher pour finir)', processing: 'Nordla réfléchit…', review: 'Parler à nouveau', denied: 'Micro refusé', error: 'Réessayer', unsupported: 'Dictée indisponible' };
const MIC = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V22h2v-3.1A7 7 0 0 0 19 12h-2z"/></svg>';

/** The voice block (HTML). `v` = the controller's model; `busy` = a question is being answered; `caseId` = the open case. */
export function renderVoice(v, { busy = false, caseId = '', hasAnswer = false } = {}) {
  const state = busy ? 'processing' : v.state;
  const mic = v.recognizerSupported
    ? `<button type="button" class="nxa-mic nxa-mic--${esc(state)}" data-act="core-ask-mic" data-case="${esc(caseId)}" aria-pressed="${state === 'listening' ? 'true' : 'false'}" ${busy || state === 'preparing' ? 'disabled' : ''}>${MIC}<span>${esc(LABEL[state] ?? LABEL.idle)}</span></button>`
    : '<p class="nxa-vnote" role="status">La dictée vocale n’est pas disponible sur ce navigateur. Écrivez la question : la touche micro du clavier Android la dicte aussi dans le champ.</p>';
  const consent = state === 'consent'
    ? '<div class="nxa-block" role="alertdialog" aria-label="Autoriser la dictée"><b>Avant de parler</b>Pour transcrire votre voix, le navigateur envoie le son à son propre service de reconnaissance (Google sur Chrome) et demande l’accès au micro. Nordla n’enregistre aucun son. Le texte reconnu s’affiche dans la case : vous le relisez avant d’envoyer.<div class="nxa-vrow"><button type="button" class="btn" data-act="core-ask-mic-consent" data-case="' + esc(caseId) + '">Accepter et parler</button><button type="button" class="btn sec" data-act="core-ask-mic-cancel">Annuler</button></div></div>'
    : '';
  const status = state === 'listening' ? `<p class="nxa-vstatus" id="nxa-interim" role="status">${esc(v.interim || 'Parlez maintenant…')}</p>`
    : (v.message ? `<p class="${state === 'denied' || state === 'error' ? 'nxa-block' : 'nxa-vnote'}" role="${state === 'denied' || state === 'error' ? 'alert' : 'status'}">${esc(v.message)}</p>` : '');
  const speakCtl = v.synthSupported
    ? `<label class="nxa-vopt"><input type="checkbox" data-act="core-ask-speak-toggle" ${v.speakOn ? 'checked' : ''}> Lire les réponses à voix haute</label>
       <div class="nxa-vrow">${v.speaking ? '<button type="button" class="btn sec" data-act="core-ask-stop-speech">Arrêter la lecture</button>' : (hasAnswer ? '<button type="button" class="btn sec" data-act="core-ask-listen">Écouter la dernière réponse</button>' : '')}</div>`
    : '<p class="nxa-vnote">La lecture à voix haute n’est pas disponible ici : les réponses restent écrites.</p>';
  const auto = v.recognizerSupported ? `<label class="nxa-vopt"><input type="checkbox" data-act="core-ask-autosend" ${v.autoSend ? 'checked' : ''}> Envoyer dès que j’ai fini de parler</label>` : '';
  return `<div class="nxa-voice" data-voice-state="${esc(state)}">${mic}${consent}${status}${auto}${speakCtl}</div>`;
}

export const VOICE_CSS = `.nxa-voice{margin:8px 0 12px}.nxa-mic{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;min-height:72px;font:inherit;font-size:18px;font-weight:700;border-radius:16px;border:2px solid var(--accent,#0f2a52);background:var(--accent,#0f2a52);color:#fff;cursor:pointer}
.nxa-mic:disabled{opacity:.6}.nxa-mic--listening{background:var(--red,#c0392b);border-color:var(--red,#c0392b)}.nxa-mic--denied,.nxa-mic--error{background:var(--card,#fff);color:var(--ink,#183247)}.nxa-mic:focus-visible,.nxa-voice input:focus-visible{outline:3px solid #4b8df0;outline-offset:2px}
.nxa-vstatus{font-size:16px;min-height:24px;margin:8px 0;overflow-wrap:anywhere}.nxa-vnote{font-size:13px;color:var(--muted,#555);margin:6px 0}.nxa-vopt{display:flex;align-items:center;gap:10px;min-height:44px;font-size:14px}.nxa-vopt input{width:22px;height:22px}.nxa-vrow{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}`;

/** Controller. `nx` = the Parle à Nordla state (draft, turns...); `refresh()` re-renders the panel; `ask(text, caseId)` sends a question. All browser objects come from `win`. */
export function createVoiceController({ win = typeof window === 'undefined' ? null : window, nx, refresh = () => {}, ask = () => {}, recognizer = null, synth = null, storage = null } = {}) {
  const rec = recognizer ?? createRecognizer(win); const tts = synth ?? createSynth(win);
  const store = storage ?? (() => { try { return win?.sessionStorage ?? null; } catch { return null; } })();
  const readConsent = () => { try { return store?.getItem('nordla-voice-consent') === '1'; } catch { return false; } };
  const v = (nx.voice ??= { state: rec.supported ? 'idle' : 'unsupported', interim: '', message: '', speakOn: false, autoSend: false, speaking: false, consent: readConsent() });
  const model = () => ({ ...v, recognizerSupported: rec.supported, synthSupported: tts.supported });
  const set = (patch) => { Object.assign(v, patch); refresh(); };
  function stopSpeech() { tts.cancel(); if (v.speaking) set({ speaking: false }); }
  function begin(caseId) {
    if (!rec.supported) return set({ state: 'unsupported' });
    if (win?.navigator && win.navigator.onLine === false) return set({ state: 'error', message: 'Vous êtes hors ligne : la dictée du navigateur a besoin d’internet. Écrivez la question ; elle partira au retour du réseau.' });
    tts.cancel(); v.speaking = false; // never listen while Nordla is talking (it would transcribe itself)
    set({ state: 'preparing', interim: '', message: '' });
    try {
      rec.start({
        onStart: () => set({ state: 'listening' }),
        onInterim: (t) => { v.interim = t; const el = win?.document?.getElementById('nxa-interim'); if (el) el.textContent = t; },
        onFinal: (text) => {
          if (!text) { if (v.state === 'listening' || v.state === 'preparing') set({ state: 'idle', message: 'Je n’ai rien entendu. Touchez le micro et parlez, ou écrivez la question.' }); return; }
          nx.draft = text; // visible and correctable in the question box
          if (v.autoSend) { set({ state: 'idle', message: '' }); ask(text, caseId); } else set({ state: 'review', message: 'Relisez et corrigez si besoin, puis touchez « Demander ».' });
        },
        onError: (code) => { const c = classifyError(code); set({ state: c.state, message: c.message }); },
        onEnd: () => { if (v.state === 'listening' || v.state === 'preparing') set({ state: 'idle' }); },
      });
    } catch { set({ state: 'error', message: 'La dictée n’a pas pu démarrer. Écrivez la question au clavier.' }); }
  }
  return {
    model, speakableOf: speakable,
    /** @returns true when the action was a voice action (the panel stops there) */
    handle(act, t, caseId) {
      if (act === 'core-ask-mic') {
        if (v.state === 'listening') { rec.stop(); return true; }
        if (!v.consent) { set({ state: 'consent', message: '' }); return true; }
        begin(caseId); return true;
      }
      if (act === 'core-ask-mic-consent') { v.consent = true; try { store?.setItem('nordla-voice-consent', '1'); } catch { /* optional convenience */ } begin(caseId); return true; }
      if (act === 'core-ask-mic-cancel') { set({ state: 'idle', message: '' }); return true; }
      if (act === 'core-ask-speak-toggle') { v.speakOn = !!t?.checked; if (!v.speakOn) stopSpeech(); else refresh(); return true; }
      if (act === 'core-ask-autosend') { v.autoSend = !!t?.checked; refresh(); return true; }
      if (act === 'core-ask-stop-speech') { stopSpeech(); return true; }
      if (act === 'core-ask-listen') { this.say(nx.turns?.[0]); return true; }
      return false;
    },
    /** Called with each new answer: reads it aloud only if the person turned reading on. */
    onAnswer(turn) { if (v.speakOn) this.say(turn); },
    say(turn) {
      const text = speakable(turn); if (!text || !tts.supported) return;
      tts.speak(text, { onStart: () => { v.speaking = true; refresh(); }, onEnd: () => { v.speaking = false; refresh(); } });
    },
    stopAll() { try { rec.abort?.(); } catch { /* idle */ } tts.cancel(); },
  };
}
