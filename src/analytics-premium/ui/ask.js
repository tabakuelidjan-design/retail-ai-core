'use strict';
// "Demander à Nordla": the question box (typed questions; "Parler à Nordla" is only the microphone inside it). The figures come from the server (read from the Nordla report - never computed in the browser, never by a model);
// this file only asks, waits, and shows the answer, its period and source, the AI explanation status, or a clear error. No innerHTML anywhere.

const ASK_TIMEOUT_MS = 30000;
const ASK_EXAMPLES = ['ask.q.revenue', 'ask.q.orders', 'ask.q.aov', 'ask.q.topProduct', 'ask.q.channel'];
let askOpen = null;
let askSpeech = null;

/** error code -> message key (fixed set: a provider's or a server's free text is never displayed) */
function askErrorKey(code) {
  const known = ['EMPTY_QUESTION', 'QUESTION_TOO_LONG', 'UNSUPPORTED_QUESTION', 'UNSUPPORTED_PERIOD', 'ONLY_LAST_30_DAYS', 'NO_REPORT_AVAILABLE', 'NO_DATA_FOR_QUESTION', 'PERIOD_NOT_IN_REPORT', 'ASSISTANT_NOT_AVAILABLE'];
  return known.includes(code) ? `ask.err.${code}` : 'ask.err.GENERIC';
}
function askMoney(v, cur) {
  if (v == null) return t('common.dash');
  try { return new Intl.NumberFormat(NORDLA_I18N.getLang() === 'nl' ? 'nl-BE' : NORDLA_I18N.getLang() === 'en' ? 'en-GB' : 'fr-BE', { style: 'currency', currency: cur || 'EUR' }).format(v); } catch (e) { return `${Number(v).toFixed(2)} ${cur || ''}`; }
}
function askFigureValue(f, currency) {
  if (f.id === 'identified_share') return f.value == null ? t('common.dash') : `${(f.value * 100).toFixed(1)} %`;
  if (f.id === 'top_product' || f.id === 'top_channel') return `${f.value} — ${askMoney(f.net_sales_ex_tax, currency)}`;
  if (f.currency) return askMoney(f.value, f.currency);
  return f.value == null ? t('common.dash') : String(f.value);
}

function askRenderAnswer(box, a) {
  box.textContent = '';
  const cur = a.currency || 'EUR';
  const main = a.figures[0];
  box.appendChild(h('div', { class: 'ask-answer', role: 'status' },
    h('div', { class: 'ask-main-label' }, t(`ask.f.${main.id}`)),
    h('div', { class: 'ask-main-value' }, askFigureValue(main, cur)),
    a.figures.length > 1 ? h('ul', { class: 'ask-figures' }, a.figures.slice(1).map((f) => h('li', null, h('span', null, t(`ask.f.${f.id}`)), h('strong', null, askFigureValue(f, cur))))) : null,
    a.period && a.period.start ? h('div', { class: 'ask-meta' }, t('ask.period', a.period.start, a.period.end)) : null,
    h('div', { class: 'ask-meta' }, t('ask.source', a.sources && a.sources[0] ? a.sources[0].report : t('common.dash'))),
    askExplanation(a.explanation)));
}
function askExplanation(e) {
  if (!e) return null;
  if (e.status === 'OK') return h('div', { class: 'ask-explain' }, h('div', { class: 'ask-meta' }, t('ask.explainBy', e.provider || '')), h('p', null, e.text));
  const key = { NOT_CONFIGURED: 'ask.ai.notConfigured', UNKNOWN_PROVIDER: 'ask.ai.misconfigured', MISCONFIGURED: 'ask.ai.misconfigured', PROVIDER_UNAVAILABLE: 'ask.ai.unavailable', TIMEOUT: 'ask.ai.timeout' }[e.status] || 'ask.ai.unavailable';
  return h('div', { class: 'ask-explain ask-ai-note' }, t(key));
}
function askRenderError(box, key) {
  box.textContent = '';
  box.appendChild(h('div', { class: 'ask-error', role: 'alert' }, t(key)));
}

/** The period chosen in the page, only on the pages that have the selector (Explorer, Produits, Clients); elsewhere the assistant uses the last 30 days. */
function askSelectedPeriod() {
  if (typeof periodState === 'undefined' || !/^#\/(explorer|products|customers)/.test(location.hash)) return null;
  return { period: periodState.key, from: periodState.from, to: periodState.to };
}

async function askSubmit(input, box, btn) {
  const question = input.value.trim();
  if (!question) { askRenderError(box, 'ask.err.EMPTY_QUESTION'); input.focus(); return; }
  btn.disabled = true; box.textContent = ''; box.appendChild(h('div', { class: 'ask-loading', role: 'status' }, t('ask.loading')));
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), ASK_TIMEOUT_MS);
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, lang: NORDLA_I18N.getLang(), period: askSelectedPeriod() }), signal: ac.signal });
    let data = null; try { data = await res.json(); } catch (e) { data = null; }
    if (res.ok && data && Array.isArray(data.figures) && data.figures.length) askRenderAnswer(box, data);
    else askRenderError(box, askErrorKey(data && data.error && data.error.code));
  } catch (e) {
    askRenderError(box, e && e.name === 'AbortError' ? 'ask.err.TIMEOUT' : 'ask.err.GENERIC');
  } finally { clearTimeout(timer); btn.disabled = false; }
}

/** The Nordla microphone icon (ui/assets, 96 px + 192 px for dense screens). Decorative: the button's text says what it does. */
function askMicIcon() {
  return h('img', { class: 'ask-mic-icon', src: '/assets/nordla-mic.png', srcset: '/assets/nordla-mic.png 1x, /assets/nordla-mic@2x.png 2x', width: '22', height: '22', alt: '', 'aria-hidden': 'true', draggable: 'false' });
}

function closeAsk() { if (askSpeech) { askSpeech.stop(); askSpeech = null; } if (askOpen) { askOpen.remove(); askOpen = null; document.removeEventListener('keydown', askEsc, true); } }
function askEsc(e) { if (e.key === 'Escape') { e.preventDefault(); closeAsk(); } }

function openAsk() {
  if (askOpen) { const i = askOpen.querySelector('input'); if (i) i.focus(); return; }
  const input = h('input', { type: 'text', class: 'ask-input', maxlength: '500', placeholder: t('ask.placeholder'), 'aria-label': t('ask.title'), autocomplete: 'off' });
  const box = h('div', { class: 'ask-result' });
  const send = h('button', { type: 'button', class: 'cta-primary ask-send' }, t('ask.send'));
  const run = () => askSubmit(input, box, send);
  send.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  // Voice: speech -> text in THIS field (correctable) -> the same run() / POST /api/ask as a typed question. Nothing is ever sent by the voice layer itself.
  const micFull = h('span', { class: 'ask-mic-full' }); const micShort = h('span', { class: 'ask-mic-short', 'aria-hidden': 'true' });
  const micLabel = h('span', { class: 'ask-mic-label' }, micFull, micShort);
  const mic = h('button', { type: 'button', class: 'ask-mic', 'aria-pressed': 'false' }, askMicIcon(), micLabel);
  const voiceStatus = h('div', { class: 'ask-voice-status', role: 'status', 'aria-live': 'polite' });
  let delivered = false;
  const renderVoice = (st) => {
    mic.classList.toggle('on', st === 'listening'); mic.setAttribute('aria-pressed', st === 'listening' ? 'true' : 'false');
    mic.disabled = st === 'unsupported' || st === 'transcribing';
    micFull.textContent = t(st === 'listening' ? 'ask.voice.stop' : 'ask.voice.start'); micShort.textContent = t(st === 'listening' ? 'ask.voice.stop' : 'ask.voice.short');
    mic.setAttribute('aria-label', micFull.textContent); // the full name stays available to screen readers when the compact text is shown
    const key = { listening: 'ask.voice.listening', transcribing: 'ask.voice.transcribing', denied: 'ask.voice.denied', mic: 'ask.voice.mic', noSpeech: 'ask.voice.noSpeech', network: 'ask.voice.network', generic: 'ask.voice.generic', unsupported: 'ask.voice.unsupported' }[st] || (delivered ? 'ask.voice.done' : null);
    voiceStatus.textContent = key ? t(key) : '';
    voiceStatus.classList.toggle('bad', ['denied', 'mic', 'noSpeech', 'network', 'generic', 'unsupported'].includes(st));
  };
  askSpeech = createSpeechController({ provider: pickSpeechProvider(), getLang: () => NORDLA_I18N.getLang(), onState: renderVoice, onText: (txt, isFinal) => { input.value = String(txt).slice(0, 500); if (isFinal) { delivered = true; input.focus(); } } });
  mic.addEventListener('click', () => { delivered = false; askSpeech.toggle(); });
  const voice = h('div', { class: 'ask-voice' }, mic, voiceStatus, askSpeech.supported ? h('div', { class: 'ask-meta ask-voice-note' }, t('ask.voice.privacy')) : null);
  const examples = h('div', { class: 'ask-examples' }, h('div', { class: 'ask-meta' }, t('ask.examples')), ASK_EXAMPLES.map((k) => h('button', { type: 'button', class: 'ask-chip', on: { click: () => { input.value = t(k); run(); } } }, t(k))));
  const panel = h('div', { class: 'ask-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('ask.title') },
    h('div', { class: 'ask-head' }, h('h2', null, t('ask.title')), h('button', { type: 'button', class: 'ask-close', 'aria-label': t('ask.close'), on: { click: closeAsk } }, '×')),
    h('div', { class: 'ask-form' }, input, send), voice, examples, box);
  const back = h('div', { class: 'ask-back', on: { click: (e) => { if (e.target === back) closeAsk(); } } }, panel);
  document.body.appendChild(back); askOpen = back; document.addEventListener('keydown', askEsc, true);
  input.focus();
}

/** The "Demander à Nordla" button (Brief and What changed heroes). */
function askButton() {
  return h('button', { class: 'cta-primary', type: 'button', on: { click: openAsk } }, NordlaIcon.parle('onTerracotta', 'md'), t('nav.askNordla'), h('kbd', null, '⌘K'));
}
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') { e.preventDefault(); openAsk(); } });
