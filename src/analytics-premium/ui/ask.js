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

// ---------- the conversation: the last 3 exchanges, in memory, for this open box only (closing the box forgets them) ----------
const ASK_MAX_TURNS = 3;
let askThread = []; // [{ q, text, node }] oldest first; `text` is what the follow-up questions may refer to

/** What the server may use to understand a follow-up ("Et le mois dernier ?"): the last exchanges as plain text. Sent with each question, never stored. */
function askHistory() {
  return askThread.filter((x) => x.text).flatMap((x) => [{ role: 'user', text: x.q }, { role: 'assistant', text: x.text }]).slice(-2 * ASK_MAX_TURNS);
}
function askRenderThread(box, pending) {
  box.textContent = '';
  if (pending) box.appendChild(pending);
  for (let i = askThread.length - 1; i >= 0; i -= 1) box.appendChild(askThread[i].node);
}
function askTurn(question, body) {
  return h('div', { class: 'ask-turn' }, h('div', { class: 'ask-turn-q' }, question), body);
}

// ---------- the answer of the AI mode (mode: 'ai') ----------
function askLocale() { return NORDLA_I18N.getLang() === 'nl' ? 'nl-BE' : NORDLA_I18N.getLang() === 'en' ? 'en-GB' : 'fr-BE'; }
function askDate(iso) {
  if (!iso) return t('common.dash');
  try { const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso); return new Intl.DateTimeFormat(askLocale(), { dateStyle: 'medium', timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? 'UTC' : undefined }).format(d); } catch (e) { return String(iso); }
}
function askDateTime(iso) {
  try { return new Intl.DateTimeFormat(askLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch (e) { return String(iso); }
}
/** A fact / value with its unit: currency code -> money, ratio -> percent, count/days -> number, date -> localized date, text as is. */
function askFmt(value, unit) {
  if (value == null) return t('common.dash');
  if (unit === 'ratio') { try { return new Intl.NumberFormat(askLocale(), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value); } catch (e) { return `${(value * 100).toFixed(1)} %`; } }
  if (unit === 'count' || unit === 'days') { try { return new Intl.NumberFormat(askLocale()).format(value); } catch (e) { return String(value); } }
  if (unit === 'date') return askDate(value);
  if (unit === 'text') return String(value);
  if (/^[A-Z]{3}$/.test(unit || '')) return askMoney(value, unit);
  return String(value);
}
function askMetric(key) { const k = `ask.metric.${key}`; const v = t(k); return v === k ? String(key).replace(/_/g, ' ') : v; }
function askTool(name) { const k = `ask.tool.${name}`; const v = t(k); return v === k ? String(name).replace(/^get_/, '').replace(/_/g, ' ') : v; }
function askPeriodText(p) { return t('ask.period', askDate(p.from), askDate(p.to)); }

/** One limitation of the data, in words. Codes and parameters come from Nordla; the wording is here. */
function askLimitText(l) {
  const p = l.params || {}; const k = l.code === 'NOT_FOUND' && p.reason ? `ask.lim.NOT_FOUND.${p.reason}` : `ask.lim.${l.code}`;
  const arg = l.code === 'DATA_STALE' ? p.ageMinutes : l.code === 'CUSTOMERS_PARTIALLY_IDENTIFIED' ? (p.identifiedShare == null ? '' : `${Math.round(p.identifiedShare * 100)} %`) : l.code === 'COSTS_PARTIAL' ? '' : l.code === 'VALUE_MISSING' ? askMetric(p.metric) : l.code === 'SHIPPING_DATA_PARTIAL' ? p.ordersWithoutShippingData : l.code === 'PRODUCT_HAS_NO_SALES_IN_PERIOD' ? p.count : p.historyStart ? askDate(p.historyStart) : '';
  const s = t(k, arg);
  return s === k ? t('ask.lim.GENERIC') : s;
}
function askLimits(list) {
  const items = (list || []).filter((l, i, a) => a.findIndex((x) => x.code === l.code && x.callId === l.callId) === i);
  if (!items.length) return null;
  return h('ul', { class: 'ask-limits', 'aria-label': t('ask.lim.title') }, items.map((l) => h('li', { class: `ask-limit ${l.severity || 'warning'}` }, askLimitText(l))));
}

function askPart(p) {
  return h('p', { class: `ask-part ${p.type}` },
    p.type === 'comparison' || p.type === 'correlation' ? h('span', { class: 'ask-part-tag' }, t(`ask.kind.${p.type}`)) : null,
    p.text,
    (p.caveats || []).map((c) => h('span', { class: 'ask-caveat' }, askLimitText({ code: c, params: {} }))));
}
/** The clean, deterministic answer built from the tools' figures alone (no model text): used whenever the explanation is not shown. */
function askDeterministic(summary) {
  return h('div', { class: 'ask-answer ask-det', role: 'status' }, h('p', { class: 'ask-det-title' }, t('ask.det.title')),
    (summary.calls || []).map((c) => h('div', { class: 'ask-call' },
      h('div', { class: 'ask-call-title' }, askTool(c.tool)), h('div', { class: 'ask-meta' }, askPeriodText(c.period)),
      c.values.length ? h('ul', { class: 'ask-figures' }, c.values.filter((v) => v.value != null).map((v) => h('li', null, h('span', null, askMetric(v.key)), h('strong', null, askFmt(v.value, v.unit))))) : null,
      c.items.length ? h('ol', { class: 'ask-items' }, c.items.map((i) => h('li', null, h('span', null, i.label == null ? t('ask.item.none') : i.label), i.values[0] ? h('strong', null, askFmt(i.values[0].value, i.values[0].unit)) : i.status === 'NO_SALES_IN_PERIOD' ? h('em', null, t('ask.item.noSales')) : null))) : null,
      c.comparison && c.comparison.rows.length ? h('div', { class: 'ask-meta' }, t('ask.used.compared', askDate(c.comparison.reference && c.comparison.reference.from), askDate(c.comparison.reference && c.comparison.reference.to)),
        c.comparison.rows.filter((r) => r.delta_pct != null).slice(0, 4).map((r) => h('span', { class: 'ask-delta' }, `${askMetric(r.key)} ${r.delta_pct > 0 ? '+' : ''}${askFmt(r.delta_pct, 'ratio')}`))) : null)));
}
function askFactLabel(ref, summary) {
  let m;
  if ((m = ref.match(/^c(\d+)\.period\.(from|to|days)$/))) return t(`ask.fact.period.${m[2]}`);
  if ((m = ref.match(/^c(\d+)\.comparison\.reference\.(from|to)$/))) return t(`ask.fact.refperiod.${m[2]}`);
  if ((m = ref.match(/^c(\d+)\.comparison\.(.+)\.(current|previous|delta_abs|delta_pct)$/))) return `${askMetric(m[2])} — ${t(`ask.fact.cmp.${m[3]}`)}`;
  if ((m = ref.match(/^c(\d+)\.items\.(\d+)\.(.+)$/))) return `#${Number(m[2]) + 1} ${m[3] === 'label' ? t('ask.fact.label') : askMetric(m[3])}`;
  if ((m = ref.match(/^c(\d+)\.values\.(.+)$/))) return askMetric(m[2]);
  return ref;
}
/** "Données utilisées" (period, tools, comparison, freshness) and, inside it, "Voir les sources de l'analyse" (the detailed facts). Both closed by default. */
function askUsed(d) {
  const calls = (d.summary && d.summary.calls) || [];
  if (!calls.length) return null;
  const rows = calls.map((c) => h('li', null, h('strong', null, askTool(c.tool)), ' · ', askPeriodText(c.period),
    c.comparison && c.comparison.reference ? h('div', { class: 'ask-meta' }, t('ask.used.compared', askDate(c.comparison.reference.from), askDate(c.comparison.reference.to))) : null,
    h('div', { class: 'ask-meta' }, t('ask.used.fresh', askDateTime(c.freshness.dataAsOf)), c.completeness.status === 'PARTIAL' ? ` · ${t('ask.used.partial')}` : '')));
  const facts = (d.facts || []).map((f) => { const m = f.ref.match(/^c(\d+)\./); const c = m && calls.find((x) => x.id === `c${m[1]}`); return h('tr', null, h('td', null, c ? h('span', { class: 'ask-src-tool' }, `${askTool(c.tool)} · `) : null, askFactLabel(f.ref)), h('td', { class: 'num' }, askFmt(f.value, f.unit))); });
  return h('details', { class: 'ask-used' }, h('summary', null, t('ask.used.title')), h('ul', { class: 'ask-used-list' }, rows),
    facts.length ? h('details', { class: 'ask-sources' }, h('summary', null, t('ask.sources.title')), h('div', { class: 'ask-sources-wrap' }, h('table', { class: 'ask-sources-table' }, h('tbody', null, facts)))) : null);
}

/** @returns {{ node, text }} node = what is displayed for this answer, text = a short plain-text version for the conversation memory */
function askAiEntry(d) {
  let main; let text = '';
  if (d.status === 'OK' && d.answer && Array.isArray(d.answer.parts)) {
    const plain = d.answer.parts.filter((p) => p.type !== 'hypothesis'); const hyps = d.answer.parts.filter((p) => p.type === 'hypothesis');
    main = h('div', { class: 'ask-answer ask-ai', role: 'status' }, plain.map(askPart),
      hyps.length ? h('div', { class: 'ask-hyps' }, h('div', { class: 'ask-hyps-title' }, t('ask.hyp.title')), h('ul', null, hyps.map((p) => h('li', null, p.text, h('span', { class: 'ask-conf' }, ` (${t(`ask.conf.${p.confidence}`)})`))))) : null);
    text = String(d.answer.text || '').slice(0, 300);
  } else if (d.status === 'CLARIFICATION' && d.clarification) {
    main = h('div', { class: 'ask-answer ask-clarify', role: 'status' }, h('p', null, d.clarification.text), h('div', { class: 'ask-meta' }, t('ask.clarify.hint')));
    text = String(d.clarification.text).slice(0, 300);
  } else if (d.status === 'CANNOT_ANSWER') {
    const gaps = (d.gaps || []).map((g) => t(`ask.gap.${g}`)); // the gap codes are a fixed set, all translated (dictionary coverage test)
    main = h('div', { class: 'ask-answer ask-refusal', role: 'status' }, h('p', null, t('ask.cannot.title')), gaps.length ? h('p', { class: 'ask-meta' }, t('ask.cannot.missing', gaps.join(', '))) : null);
    text = t('ask.cannot.title');
  } else { // FACTS_ONLY (explanation rejected, unavailable or timed out): the figures, cleanly, with no technical detail
    main = askDeterministic(d.summary || { calls: [] });
    text = (d.summary && d.summary.calls && d.summary.calls[0]) ? `${askTool(d.summary.calls[0].tool)} ${askPeriodText(d.summary.calls[0].period)}` : '';
  }
  return { node: h('div', { class: 'ask-ai-result' }, main, askLimits(d.limitations), askUsed(d)), text };
}

async function askSubmit(input, box, btn) {
  const question = input.value.trim();
  if (!question) { const err = h('div', { class: 'ask-turn-body' }); askRenderError(err, 'ask.err.EMPTY_QUESTION'); askRenderThread(box, err); input.focus(); return; }
  btn.disabled = true; askRenderThread(box, askTurn(question, h('div', { class: 'ask-loading', role: 'status' }, t('ask.loading'))));
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), ASK_TIMEOUT_MS);
  let entry = null; let failed = null;
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, lang: NORDLA_I18N.getLang(), period: askSelectedPeriod(), history: askHistory() }), signal: ac.signal });
    let data = null; try { data = await res.json(); } catch (e) { data = null; }
    if (res.ok && data && data.mode === 'ai') entry = askAiEntry(data);
    else if (res.ok && data && Array.isArray(data.figures) && data.figures.length) { const body = h('div', { class: 'ask-turn-body' }); askRenderAnswer(body, data); entry = { node: body, text: `${t(`ask.f.${data.figures[0].id}`)} : ${askFigureValue(data.figures[0], data.currency || 'EUR')}` }; }
    else failed = askErrorKey(data && data.error && data.error.code);
  } catch (e) {
    failed = e && e.name === 'AbortError' ? 'ask.err.TIMEOUT' : 'ask.err.GENERIC';
  } finally { clearTimeout(timer); btn.disabled = false; }
  if (failed) { const err = h('div', { class: 'ask-turn-body' }); askRenderError(err, failed); askRenderThread(box, askTurn(question, err)); return; }   // an error is not remembered; the question stays in the field
  askThread.push({ q: question, text: entry.text, node: askTurn(question, entry.node) });
  if (askThread.length > ASK_MAX_TURNS) askThread.shift();
  askRenderThread(box, null); input.value = ''; input.focus();
}

/** The Nordla microphone icon (ui/assets, 96 px + 192 px for dense screens). Decorative: the button's text says what it does. */
function askMicIcon() {
  return h('img', { class: 'ask-mic-icon', src: '/assets/nordla-mic.png', srcset: '/assets/nordla-mic.png 1x, /assets/nordla-mic@2x.png 2x', width: '22', height: '22', alt: '', 'aria-hidden': 'true', draggable: 'false' });
}

function closeAsk() { askThread = []; /* the conversation lives only while the box is open */ if (askSpeech) { askSpeech.stop(); askSpeech = null; } if (askOpen) { askOpen.remove(); askOpen = null; document.removeEventListener('keydown', askEsc, true); } }
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
