import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { KNOWN_GAPS } from '../src/analytics-premium/server/ai/contract.js';
import { ERROR_CODES } from '../src/analytics-premium/server/tools/contract.js';

// Phase 4: the interface of "Demander à Nordla" for mode: 'ai'. The real ask.js runs in a vm with a tiny DOM stub and scripted /api/ask responses.

const ui = (f) => readFileSync(new URL(`../src/analytics-premium/ui/${f}`, import.meta.url), 'utf8');
const speechSrc = ui('speech.js'); const askSrc = ui('ask.js');

function makeDom() {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.value = ''; this._text = ''; this.disabled = false; const set = new Set(); this.classList = { toggle: (c, on) => { if (on) set.add(c); else set.delete(c); }, has: (c) => set.has(c), add: (c) => set.add(c) }; this.className = ''; this.style = {}; }
    setAttribute(k, v) { this.attrs[k] = v; } appendChild(c) { this.children.push(c); return c; } addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
    remove() { this.removed = true; } focus() { this.focused = true; } querySelector() { return null; } scrollIntoView() {}
    set textContent(v) { this._text = String(v); this.children = []; } get textContent() { return this._text; }
    fire(ev, extra = {}) { for (const fn of this.listeners[ev] ?? []) fn({ target: this, preventDefault() {}, ...extra }); }
  }
  const h = (tag, attrs, ...ch) => { const el = new El(tag); for (const [k, v] of Object.entries(attrs ?? {})) { if (k === 'class') el.className = v; else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); else if (v != null) el.attrs[k] = v; } const add = (c) => { if (Array.isArray(c)) c.forEach(add); else if (c != null) { if (typeof c === 'object') el.children.push(c); else el._text += String(c); } }; ch.forEach(add); return el; };
  const deep = (el) => (el._text ?? '') + (el.children ?? []).map(deep).join(' ');
  const walk = (el, pred, out = []) => { if (pred(el)) out.push(el); for (const c of el.children ?? []) walk(c, pred, out); return out; };
  return { h, walk, deep };
}
/** `responses`: a list of JSON bodies (or { ok:false, status, body }) returned by successive POST /api/ask calls. */
function loadAsk(responses) {
  const { h, walk, deep } = makeDom(); const fetches = []; const body = { children: [], appendChild(c) { this.children.push(c); return c; } }; let i = 0;
  const ctx = { document: { body, addEventListener() {}, removeEventListener() {} }, h, t: (k, ...a) => [k, ...a].join('|'), NordlaIcon: { parle: () => 'icon' }, NORDLA_I18N: { getLang: () => 'fr' }, AbortController, setTimeout, clearTimeout, console, Intl,
    location: { hash: '#/' }, fetch: async (url, opts) => { fetches.push({ url, body: JSON.parse(opts.body) }); const r = responses[Math.min(i, responses.length - 1)]; i += 1; if (r instanceof Error) throw r; return r.ok === false ? { ok: false, json: async () => r.body } : { ok: true, json: async () => r }; } };
  vm.runInNewContext(`${speechSrc}\n${askSrc}\nSPEECH_PROVIDERS.splice(0, SPEECH_PROVIDERS.length);\nthis.__api = { openAsk, closeAsk };`, ctx);
  ctx.__api.openAsk();
  const root = () => body.children[body.children.length - 1];
  const find = (cls) => walk(root(), (e) => (e.className || '').split(' ').includes(cls))[0];
  const all = (cls) => walk(root(), (e) => (e.className || '').split(' ').includes(cls));
  const ask = async (q) => { find('ask-input').value = q; find('ask-send').fire('click'); await new Promise((r) => setTimeout(r, 5)); };
  return { ctx, find, all, deep, fetches, ask, body, ...ctx.__api, result: () => deep(find('ask-result')) };
}

const okAnswer = { mode: 'ai', status: 'OK', turns: 1, explanation: { status: 'VERIFIED' },
  answer: { text: 'Du 2026-08-27 au 2026-09-25, le CA net est de 489,25 €.', parts: [
    { type: 'fact', text: 'Le chiffre d’affaires net est de 489,25 €.', factRefs: ['c1.values.net_sales_ex_tax'] },
    { type: 'comparison', text: 'Il évolue de 1,72 % par rapport à la période de référence.', factRefs: ['c1.comparison.net_sales_ex_tax.delta_pct'] },
    { type: 'fact', text: 'La marge brute est de 60 %.', factRefs: ['c1.values.gross_margin'], caveats: ['COSTS_PARTIAL'] },
    { type: 'hypothesis', text: 'Une cause possible est le poids du produit X.', factRefs: ['c3.items.0.label'], confidence: 'low' }] },
  limitations: [{ callId: 'c1', tool: 'get_sales_metrics', code: 'COSTS_PARTIAL', severity: 'warning', params: {}, affects: ['gross_margin'] }, { callId: 'c1', tool: 'get_sales_metrics', code: 'PERIOD_INCLUDES_TODAY', severity: 'info', params: {} }],
  summary: { currency: 'EUR', calls: [{ id: 'c1', tool: 'get_sales_metrics', period: { from: '2026-08-27', to: '2026-09-25', days: 30 }, values: [{ key: 'net_sales_ex_tax', value: 489.25, unit: 'EUR' }], items: [], comparison: { reference: { from: '2026-07-28', to: '2026-08-26' }, basis: 'previous_equivalent_period', rows: [{ key: 'net_sales_ex_tax', unit: 'EUR', current: 489.25, previous: 481, delta_abs: 8.25, delta_pct: 0.0172 }] }, completeness: { status: 'PARTIAL', reasons: ['COSTS_PARTIAL'], missing: [] }, freshness: { dataAsOf: '2026-09-26T09:00:00.000Z', ageMinutes: 60, stale: false } }] },
  facts: [{ ref: 'c1.values.net_sales_ex_tax', value: 489.25, unit: 'EUR', description: 'x' }, { ref: 'c1.comparison.net_sales_ex_tax.delta_pct', value: 0.0172, unit: 'ratio', description: 'y' }, { ref: 'c1.period.from', value: '2026-08-27', unit: 'date', description: 'z' }],
  toolCalls: [{ id: 'c1', tool: 'get_sales_metrics', ok: true }] };

test('answer: natural text first (facts, comparisons), hypotheses labelled as not proven, limitations always visible, data used and sources collapsed', async () => {
  const d = loadAsk([okAnswer]); await d.ask('Pourquoi mes ventes ont baissé ?');
  const text = d.result();
  assert.match(text, /Le chiffre d’affaires net est de 489,25 €\./); assert.match(text, /ask\.kind\.comparison/); assert.match(text, /ask\.hyp\.title/); assert.match(text, /ask\.conf\.low/); assert.match(text, /Une cause possible est le poids/);
  assert.equal(d.all('ask-limit').length, 2, 'limitations are visible without opening anything'); assert.match(d.deep(d.all('ask-limit')[0]), /ask\.lim\.COSTS_PARTIAL/);
  assert.match(d.deep(d.all('ask-caveat')[0]), /ask\.lim\.COSTS_PARTIAL/, 'the margin claim carries its caveat');
  const used = d.find('ask-used'); assert.equal(used.tag, 'details'); assert.ok(used.children[0].tag === 'summary' && /ask\.used\.title/.test(used.children[0]._text));
  assert.match(d.deep(used), /ask\.used\.compared\|/); assert.match(d.deep(used), /ask\.used\.fresh\|/); assert.match(d.deep(used), /ask\.used\.partial/);
  const src = d.find('ask-sources'); assert.equal(src.tag, 'details'); assert.ok(/ask\.sources\.title/.test(src.children[0]._text));
  assert.equal(d.find('ask-used').attrs.open, undefined, 'collapsed by default'); assert.equal(src.attrs.open, undefined);
  assert.equal(d.all('ask-part').length, 3, 'the readable answer shows the claims, not the raw facts');
  assert.ok(!/c1\.values\.net_sales_ex_tax/.test(d.deep(d.find('ask-ai'))), 'fact references are not shown in the answer itself');
  assert.equal(d.find('ask-input').value, '', 'the field is ready for a follow-up');
});

test('a rejected explanation never shows the provider\'s text nor a technical code: a clean deterministic answer from the figures is shown instead', async () => {
  const rejected = { ...okAnswer, status: 'FACTS_ONLY', explanation: { status: 'REJECTED', reasons: [{ code: 'QUANTITY_NOT_SUPPORTED', where: 'claims[0]' }] }, answer: { text: 'Le CA a progressé de 52 %.', parts: [{ type: 'fact', text: 'Le CA a progressé de 52 %.', factRefs: [] }] } };
  const d = loadAsk([rejected]); await d.ask('Pourquoi mes ventes ont baissé ?');
  const text = d.result();
  assert.ok(!/52/.test(text), 'the rejected number is not displayed'); assert.ok(!/QUANTITY_NOT_SUPPORTED|REJECTED|claims\[/.test(text), 'no technical code');
  assert.match(text, /ask\.det\.title/); assert.match(text, /489/); assert.ok(d.find('ask-det'), 'the deterministic answer is built from the summary'); assert.equal(d.all('ask-part').length, 0);
  for (const status of ['TIMEOUT', 'UNAVAILABLE']) { const e = loadAsk([{ ...okAnswer, status: 'FACTS_ONLY', explanation: { status }, answer: undefined }]); await e.ask('x'); assert.ok(e.find('ask-det'), status); assert.ok(!/TIMEOUT|UNAVAILABLE/.test(e.result())); }
});

test('clarification: the question is shown naturally and the user answers in the same field; the next request carries it as context', async () => {
  const clar = { mode: 'ai', status: 'CLARIFICATION', clarification: { text: 'Parlez-vous de tous les produits ou d’un produit en particulier ?' }, toolCalls: [], turns: 1 };
  const d = loadAsk([clar, okAnswer]); await d.ask('Donne-moi les chiffres');
  assert.match(d.result(), /Parlez-vous de tous les produits/); assert.ok(d.find('ask-clarify')); assert.match(d.deep(d.find('ask-clarify')), /ask\.clarify\.hint/);
  assert.equal(d.find('ask-input').value, ''); assert.equal(d.find('ask-input').focused, true);
  await d.ask('Tous les produits');
  assert.deepEqual(d.fetches[1].body.history, [{ role: 'user', text: 'Donne-moi les chiffres' }, { role: 'assistant', text: 'Parlez-vous de tous les produits ou d’un produit en particulier ?' }]);
});

test('impossible question: the honest refusal, and what is missing only when Nordla knows it', async () => {
  const d = loadAsk([{ mode: 'ai', status: 'CANNOT_ANSWER', reason: 'PROVIDER_DECLINED', gaps: ['traffic', 'ad_spend'], toolCalls: [], limitations: [], summary: { currency: 'EUR', calls: [] }, facts: [] }, { mode: 'ai', status: 'CANNOT_ANSWER', reason: 'PROVIDER_DECLINED', gaps: [], toolCalls: [], limitations: [], summary: { currency: 'EUR', calls: [] }, facts: [] }]);
  await d.ask('Combien de visites ?'); assert.match(d.result(), /ask\.cannot\.title/); assert.match(d.result(), /ask\.cannot\.missing\|.*ask\.gap\.traffic.*ask\.gap\.ad_spend/); assert.ok(d.find('ask-refusal'));
  await d.ask('Devine'); const second = d.all('ask-refusal')[0]; assert.ok(!/ask\.cannot\.missing/.test(d.deep(second)), 'no invented reason');
  const blocked = loadAsk([{ mode: 'ai', status: 'CANNOT_ANSWER', reason: 'NO_DATA', gaps: ['history'], toolCalls: [], limitations: [{ callId: 'c1', code: 'INSUFFICIENT_HISTORY', severity: 'blocking', params: { historyStart: '2026-06-12' } }], summary: { currency: 'EUR', calls: [] }, facts: [] }]);
  await blocked.ask('x'); assert.match(blocked.result(), /ask\.lim\.INSUFFICIENT_HISTORY\|/); assert.ok(blocked.find('ask-limit').className.includes('blocking'));
});

test('short conversation: at most 3 exchanges are kept and sent (6 messages), oldest first out; closing the box forgets everything', async () => {
  const d = loadAsk([okAnswer]);
  for (const q of ['q1', 'q2', 'q3', 'q4']) await d.ask(q);
  assert.deepEqual(d.fetches.map((f) => f.body.history.length), [0, 2, 4, 6]);
  assert.deepEqual(d.fetches[3].body.history.map((m) => m.text).filter((_, i) => i % 2 === 0), ['q1', 'q2', 'q3']);
  assert.equal(d.all('ask-turn').length, 3, 'three exchanges are displayed, newest first'); assert.match(d.deep(d.all('ask-turn')[0]), /q4/);
  await d.ask('q5'); assert.deepEqual(d.fetches[4].body.history.filter((m) => m.role === 'user').map((m) => m.text), ['q2', 'q3', 'q4']);
  d.closeAsk(); d.openAsk(); await d.ask('q6'); assert.deepEqual(d.fetches[5].body.history, [], 'no memory once the box is closed');
  assert.ok(d.fetches.every((f) => Object.keys(f.body).sort().join() === 'history,lang,period,question'), 'only text is sent');
});

test('errors are shown as before, are not remembered, and keep the question in the field for a retry; simple (keyword) answers still render', async () => {
  const d = loadAsk([{ ok: false, body: { error: { code: 'UNSUPPORTED_QUESTION' } } }, { figures: [{ id: 'order_count', value: 3 }], sources: [{ report: 'x' }], explanation: { status: 'NOT_CONFIGURED' }, period: {}, currency: 'EUR' }]);
  await d.ask('question libre'); assert.match(d.result(), /ask\.err\.UNSUPPORTED_QUESTION/); assert.equal(d.find('ask-input').value, 'question libre');
  await d.ask('Combien de commandes ?'); assert.ok(d.find('ask-answer')); assert.match(d.result(), /ask\.f\.order_count/); assert.match(d.result(), /ask\.ai\.notConfigured/);
  assert.deepEqual(d.fetches[1].body.history, [], 'the failed question was not remembered');
  const t = loadAsk([new Error('boom')]); await t.ask('x'); assert.match(t.result(), /ask\.err\.GENERIC/);
});

test('safety: no innerHTML anywhere, provider text is only ever set as text, and the examples are only starters (label "Quelques exemples")', () => {
  assert.ok(!/\.innerHTML|innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write/.test(askSrc));
  const fr = ui('lang-fr.js');
  assert.match(fr, /'ask\.examples': 'Quelques exemples'/);
  assert.match(fr, /'ask\.ai\.notConfigured': 'Nordla peut répondre aux questions simples sur vos données\. Activez l’assistant IA pour les analyses et questions libres\.'/);
  assert.match(fr, /'ask\.cannot\.title': 'Je n’ai pas encore les données nécessaires pour répondre à cette question\.'/);
});

test('dictionary coverage: every key the answer UI needs exists in FR, NL and EN - limitation codes, tool names, metrics, gaps, kinds, confidences', () => {
  const dicts = { fr: ui('lang-fr.js'), nl: ui('lang-nl.js'), en: ui('lang-en.js') };
  const toolsSrc = ['analytics-tools.js', 'analytics-tools-extra.js'].map((f) => readFileSync(new URL(`../src/analytics-premium/server/tools/${f}`, import.meta.url), 'utf8')).join(' ');
  const factsSrc = readFileSync(new URL('../src/analytics-premium/server/ai/facts.js', import.meta.url), 'utf8');
  const reasonCodes = [...new Set([...toolsSrc.matchAll(/code: '([A-Z_]+)'/g)].map((m) => m[1]))];
  const metricKeys = [...new Set([...toolsSrc.matchAll(/fact\('([a-z_]+)'/g)].map((m) => m[1]).concat([...toolsSrc.matchAll(/\['([a-z_]+)', '(?:money|count)'\]/g)].map((m) => m[1])))];
  const toolNames = [...toolsSrc.matchAll(/(?:name: |moneyTool\()'(get_[a-z_]+|compare_[a-z_]+|find_[a-z_]+)'/g)].map((m) => m[1]);
  const need = [...reasonCodes.map((c) => `ask.lim.${c}`), ...ERROR_CODES.filter((c) => !['UNKNOWN_TOOL', 'INVALID_ARGUMENT'].includes(c)).map((c) => `ask.lim.${c}`), 'ask.lim.VALUE_MISSING', 'ask.lim.DATA_STALE', 'ask.lim.GENERIC', 'ask.lim.title',
    ...metricKeys.map((k) => `ask.metric.${k}`), ...toolNames.map((n) => `ask.tool.${n}`), ...KNOWN_GAPS.map((g) => `ask.gap.${g}`), 'ask.kind.comparison', 'ask.kind.correlation', 'ask.conf.low', 'ask.conf.medium', 'ask.conf.high'];
  assert.ok(toolNames.length >= 13 && metricKeys.length >= 35 && reasonCodes.length >= 6, 'the scan found the codes it should');
  const staticKeys = [...askSrc.matchAll(/t\('((?:ask|common)\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]);
  for (const [lang, src] of Object.entries(dicts)) for (const key of new Set([...need, ...staticKeys])) assert.ok(src.includes(`'${key}':`), `${lang}: missing ${key}`);
  const sev = [...factsSrc.matchAll(/([A-Z_]+): '(?:info|warning)'/g)].map((m) => m[1]); for (const c of sev) assert.ok(dicts.fr.includes(`'ask.lim.${c}':`), c);
});
