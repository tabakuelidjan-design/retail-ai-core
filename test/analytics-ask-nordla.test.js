import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { createAssistant, loadAssistantProvider, understand, figuresFor, PROVIDER_REGISTRY } from '../src/analytics-premium/server/assistant.js';

// "Parle à Nordla". SYNTHETIC report only (invented figures). The figures must come from the report, never from a model, and nothing is ever invented.

const sales = (over = {}) => ({ window: { key: 'last_30_days', start: '2026-08-26T22:00:00.000Z', end: '2026-09-25T22:00:00.000Z', timeZone: 'Europe/Brussels' }, order_count: 31, units_sold: 42, net_sales: 1012.34, net_sales_ex_tax: 840.31, aov_ex_tax: 27.11, refunds: 6.9,
  shipping: { net_ex_tax_after_refunds: 23.16 }, refunds_breakdown: { total: 13.9 }, ...over });
const REPORT = { generated_at: '2026-09-26T01:16:18.000Z', currency: 'EUR', merchant_timezone: 'Europe/Brussels',
  sales: { yesterday: sales({ order_count: 1, net_sales_ex_tax: 10 }), last_7_days: sales({ order_count: 7, net_sales_ex_tax: 200.5 }), last_30_days: sales(), available_window: sales() },
  explorer: { last_30_days: { kpis: { active_customers: 12, identified_share: 0.4643 }, top_products: [{ title: 'Casque test', net_sales_ex_tax: 206.48, units_sold: 8 }], channels: [{ name: 'Point of Sale', net_sales_ex_tax: 750.24, share: 0.89 }] } } };

async function dirWith(report) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ask-'));
  if (report) await writeFile(path.join(dir, 'report-2026-09-26.json'), JSON.stringify(report));
  return dir;
}
const ask = (dir, extra = {}) => createAssistant({ reportsDir: dir, ...extra });

test('understanding is deterministic: intent and period from the question, in FR / NL / EN', () => {
  assert.deepEqual({ ...understand('Quel est mon chiffre d’affaires des 30 derniers jours ?') }, { intent: 'revenue', period: 'last_30_days', periodQuery: { period: 'last_30_days' }, periodExplicit: true, unsupportedSpan: false });
  assert.equal(understand('Combien de commandes hier ?').period, 'yesterday');
  assert.deepEqual(understand('Quel est mon CA sur 90 jours ?').periodQuery, { period: 'last_90_days' });
  assert.deepEqual(understand('Quel est mon CA sur 45 jours ?').periodQuery, { period: 'last_n_days', days: 45 });
  assert.deepEqual(understand('Quel est mon CA ce mois ?').periodQuery, { period: 'this_month' });
  assert.deepEqual(understand('Quel est mon CA le mois dernier ?').periodQuery, { period: 'previous_month' });
  assert.equal(understand('Quel est mon CA ?').periodQuery, null, 'no period named: the period selected in the page is used');
  assert.equal(understand('Combien de commandes ces 7 derniers jours ?').intent, 'orders');
  assert.equal(understand('Wat is mijn omzet?').intent, 'revenue'); assert.equal(understand('What is my average order value?').intent, 'aov');
  assert.equal(understand('Quel est mon meilleur produit ?').intent, 'top_product');
  assert.equal(understand('Raconte-moi une blague').intent, null);
  assert.equal(understand('Quel est mon CA sur 5000 jours ?').unsupportedSpan, true);
  assert.equal(understand('chiffre d’affaires du dernier trimestre').unsupportedSpan, true);
});

test('a successful answer: the figures are the report figures, with period, source and an explicit AI status', async () => {
  const { status, body } = await ask(await dirWith(REPORT))({ question: 'Quel est mon chiffre d’affaires des 30 derniers jours ?' });
  assert.equal(status, 200);
  const f = Object.fromEntries(body.figures.map((x) => [x.id, x.value]));
  assert.equal(f.net_sales_ex_tax, 840.31); assert.equal(f.net_sales_incl_tax, 1012.34); assert.equal(f.shipping_net_ex_tax, 23.16);
  assert.deepEqual(body.period, { key: 'last_30_days', start: '2026-08-27', end: '2026-09-25', timeZone: 'Europe/Brussels' });
  assert.deepEqual(body.sources, [{ report: '2026-09-26', generatedAt: '2026-09-26T01:16:18.000Z' }]);
  assert.equal(body.figures[0].note, undefined); assert.equal(body.figures[2].note, 'SEPARATE_FROM_PRODUCT_REVENUE', 'shipping is never folded into product revenue');
});

test('other periods and intents read the matching report blocks', async () => {
  const a = ask(await dirWith(REPORT));
  assert.equal((await a({ question: 'Combien de commandes hier ?' })).body.figures[0].value, 1);
  assert.equal((await a({ question: 'Combien de commandes ces 7 derniers jours ?' })).body.figures[0].value, 7);
  assert.equal((await a({ question: 'Quel est mon panier moyen ?' })).body.figures[0].value, 27.11);
  assert.equal((await a({ question: 'Combien de clients ?' })).body.figures[0].value, 12);
  assert.equal((await a({ question: 'Quel est mon meilleur produit ?' })).body.figures[0].value, 'Casque test');
  assert.equal((await a({ question: 'Quel est mon canal principal ?' })).body.figures[0].value, 'Point of Sale');
  assert.deepEqual((await a({ question: 'Combien de remboursements ?' })).body.figures.map((x) => x.value), [6.9, 13.9]);
  const only30 = await a({ question: 'Quel est mon meilleur produit hier ?' });
  assert.equal(only30.status, 422); assert.equal(only30.body.error.code, 'ONLY_LAST_30_DAYS');
});

test('nothing is invented: unknown question, unavailable period, missing report and empty data all give explicit errors and NO figures', async () => {
  const a = ask(await dirWith(REPORT));
  for (const [q, code, status] of [['Raconte-moi une blague', 'UNSUPPORTED_QUESTION', 422], ['Quel est mon CA du dernier trimestre ?', 'UNSUPPORTED_PERIOD', 422], ['Quel est mon CA sur 90 jours ?', 'DATASET_UNAVAILABLE', 404], ['', 'EMPTY_QUESTION', 400], ['x'.repeat(501), 'QUESTION_TOO_LONG', 400]]) {
    const r = await a({ question: q }); assert.equal(r.status, status, q.slice(0, 20)); assert.equal(r.body.error.code, code); assert.equal(r.body.figures, undefined);
  }
  const none = await ask(await dirWith(null))({ question: 'Quel est mon chiffre d’affaires ?' });
  assert.equal(none.status, 404); assert.equal(none.body.error.code, 'NO_REPORT_AVAILABLE'); assert.equal(none.body.figures, undefined);
  const noSales = await ask(await dirWith({ ...REPORT, explorer: { last_30_days: { kpis: {}, top_products: [], channels: [] } } }))({ question: 'Quel est mon meilleur produit ?' });
  assert.equal(noSales.status, 422); assert.equal(noSales.body.error.code, 'NO_DATA_FOR_QUESTION');
  assert.deepEqual(figuresFor('revenue', 'last_7_days', { sales: {} }), { unavailable: 'PERIOD_NOT_IN_REPORT' });
});

test('no AI configured: the figures are returned and the explanation status says so - no model call, no invented text', async () => {
  assert.deepEqual(loadAssistantProvider({}), { status: 'NOT_CONFIGURED', provider: null });
  assert.deepEqual(loadAssistantProvider({ NORDLA_ASSISTANT_PROVIDER: 'some-provider' }), { status: 'UNKNOWN_PROVIDER', provider: null });
  assert.deepEqual(PROVIDER_REGISTRY, {}, 'no provider adapter is bundled');
  const r = await ask(await dirWith(REPORT))({ question: 'Combien de commandes ?' });
  assert.equal(r.status, 200); assert.deepEqual(r.body.explanation, { status: 'NOT_CONFIGURED' });
  const wrong = await ask(await dirWith(REPORT), { providerStatus: 'UNKNOWN_PROVIDER' })({ question: 'Combien de commandes ?' });
  assert.equal(wrong.body.explanation.status, 'UNKNOWN_PROVIDER');
  const reg = { fake: () => ({ name: 'fake', explain: async () => ({ text: 'ok' }) }), broken: () => { throw new Error('missing key'); } };
  assert.equal(loadAssistantProvider({ NORDLA_ASSISTANT_PROVIDER: 'fake' }, reg).status, 'OK');
  assert.equal(loadAssistantProvider({ NORDLA_ASSISTANT_PROVIDER: 'broken' }, reg).status, 'MISCONFIGURED', 'a missing key is reported, not hidden');
});

test('provider configured: it receives ONLY the question and the figures, and its text is shown next to them', async () => {
  let seen;
  const provider = { name: 'fake', explain: async (input) => { seen = input; return { text: 'Votre chiffre d’affaires est stable.' }; } };
  const r = await ask(await dirWith(REPORT), { provider })({ question: 'Quel est mon chiffre d’affaires ?', lang: 'fr' });
  assert.equal(r.status, 200); assert.deepEqual(r.body.explanation, { status: 'OK', provider: 'fake', text: 'Votre chiffre d’affaires est stable.' });
  assert.deepEqual(Object.keys(seen).sort(), ['facts', 'lang', 'question', 'signal']);
  assert.deepEqual(Object.keys(seen.facts).sort(), ['currency', 'figures', 'intent', 'period']);
  assert.ok(!JSON.stringify(seen).match(/customer|email|order_id/i), 'no raw orders or customer data reach the provider');
  assert.equal(r.body.figures[0].value, 840.31, 'the model cannot change the figures');
});

test('provider error and timeout: explicit statuses, the exact figures are still returned, the provider message is not exposed', async () => {
  const dir = await dirWith(REPORT);
  const failing = await ask(dir, { provider: { name: 'fake', explain: async () => { throw new Error('secret-key-abc rejected'); } } })({ question: 'Combien de commandes ?' });
  assert.equal(failing.status, 200); assert.deepEqual(failing.body.explanation, { status: 'PROVIDER_UNAVAILABLE', provider: 'fake' }); assert.equal(failing.body.figures[0].value, 31);
  assert.ok(!JSON.stringify(failing.body).includes('secret-key'));
  const empty = await ask(dir, { provider: { name: 'fake', explain: async () => ({ text: '  ' }) } })({ question: 'Combien de commandes ?' });
  assert.equal(empty.body.explanation.status, 'PROVIDER_UNAVAILABLE', 'an empty model answer is not shown as an answer');
  let aborted = false;
  const slow = await ask(dir, { timeoutMs: 40, provider: { name: 'fake', explain: ({ signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) } })({ question: 'Combien de commandes ?' });
  assert.deepEqual(slow.body.explanation, { status: 'TIMEOUT', provider: 'fake' }); assert.equal(aborted, true, 'the provider call is cancelled'); assert.equal(slow.body.figures[0].value, 31);
});

// ---------- HTTP route ----------
const post = (port, body, headers = {}) => new Promise((resolve, reject) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, path: '/api/ask', method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, ...headers } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString('utf8') || 'null') })); });
  r.on('error', reject); r.end(data);
});
async function serve(report, extra = {}) {
  const dir = await dirWith(report);
  const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir, ask: createAssistant({ reportsDir: dir }), ...extra }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('POST /api/ask: sends the question, returns the answer; validation, size and origin rules', async () => {
  const s = await serve(REPORT);
  try {
    const ok = await post(s.port, { question: 'Quel est mon chiffre d’affaires des 30 derniers jours ?', lang: 'fr' });
    assert.equal(ok.status, 200); assert.equal(ok.json.figures[0].value, 840.31); assert.equal(ok.json.explanation.status, 'NOT_CONFIGURED');
    assert.equal((await post(s.port, { question: 'blague' })).status, 422);
    assert.equal((await post(s.port, '{not json')).status, 400);
    assert.equal((await post(s.port, { question: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(s.port, { question: 'x'.repeat(5000) })).status, 413);
    assert.equal((await post(s.port, { question: 'Combien de commandes ?' }, { Origin: 'https://evil.example.com' })).status, 403, 'cross-site posts are refused');
    assert.equal((await post(s.port, { question: 'Combien de commandes ?' }, { Origin: `http://127.0.0.1:${s.port}` })).status, 200);
  } finally { await s.close(); }
});

test('POST /api/ask: no assistant wired -> a clear 503; no report -> a clear 404', async () => {
  const dir = await dirWith(null);
  const bare = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir })); await new Promise((r) => bare.listen(0, '127.0.0.1', r));
  const empty = await serve(null);
  try {
    assert.equal((await post(bare.address().port, { question: 'Combien de commandes ?' })).json.error.code, 'ASSISTANT_NOT_AVAILABLE');
    const r = await post(empty.port, { question: 'Combien de commandes ?' }); assert.equal(r.status, 404); assert.equal(r.json.error.code, 'NO_REPORT_AVAILABLE');
  } finally { await new Promise((r) => bare.close(r)); await empty.close(); }
});

test('hosted: the assistant is behind the same access barrier as every other route', async () => {
  const { createGuard } = await import('../src/analytics-premium/server/hosting.js');
  const guard = createGuard({ allowedHosts: ['a.example.test'], token: 't'.repeat(32) });
  const s = await serve(REPORT, { guard });
  try { assert.equal((await post(s.port, { question: 'Combien de commandes ?' }, { Host: 'a.example.test' })).status, 401); } finally { await s.close(); }
});

// ---------- UI (real source, evaluated with a minimal DOM stub; the browser flow was also verified manually) ----------
const ui = (f) => readFileSync(new URL(`../src/analytics-premium/ui/${f}`, import.meta.url), 'utf8');
const askSrcFull = ui('ask.js'); const askSrc = askSrcFull.replace(/^\s*\/\/.*$/gm, ''); const appSrc = ui('app.js'); const html = ui('index.html');

test('both "Parle à Nordla" buttons now have a handler (the bug: they were plain buttons with no click handler and no route behind them)', () => {
  assert.doesNotMatch(appSrc, /h\('button', \{ class: 'cta-primary', type: 'button' \}, NordlaIcon\.parle/);
  assert.equal((appSrc.match(/askButton\(\)/g) ?? []).length, 2);
  assert.match(askSrc, /class: 'cta-primary', type: 'button', on: \{ click: openAsk \}/);
  assert.match(askSrc, /metaKey \|\| e\.ctrlKey\) && String\(e\.key\)\.toLowerCase\(\) === 'k'/, '⌘K / Ctrl+K opens it');
  assert.ok(html.indexOf('/ask.js') > 0 && html.indexOf('/ask.js') < html.indexOf('/app.js'));
});

test('the question is POSTed to /api/ask as JSON, every failure is shown, and nothing is rendered with innerHTML', () => {
  assert.match(askSrc, /fetch\('\/api\/ask', \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ question, lang:/);
  assert.match(askSrc, /AbortController/); assert.match(askSrc, /ask\.err\.TIMEOUT/); assert.match(askSrc, /ask\.err\.GENERIC/);
  assert.match(askSrc, /askErrorKey\(data && data\.error && data\.error\.code\)/);
  assert.doesNotMatch(askSrc, /innerHTML|html:/);
  assert.match(askSrc, /'ask\.err\.EMPTY_QUESTION'/, 'an empty question is answered with a message, not silence');
  assert.match(askSrc, /Array\.isArray\(data\.figures\) && data\.figures\.length/, 'an answer is only rendered when real figures came back');
});

function loadAsk() {
  const el = () => ({ children: [], appendChild(c) { this.children.push(c); return c; }, set textContent(v) { this.children = []; this._t = v; }, get textContent() { return this._t ?? ''; }, remove() {}, addEventListener() {}, querySelector() { return null; }, focus() {}, setAttribute() {} });
  const ctx = { document: { addEventListener() {}, removeEventListener() {}, body: el() }, h: (tag, attrs, ...ch) => ({ tag, attrs, ch: ch.flat(3).filter((x) => x != null) }), t: (k, ...a) => [k, ...a].join('|'), NordlaIcon: { parle: () => 'icon' }, NORDLA_I18N: { getLang: () => 'fr' }, AbortController, setTimeout, clearTimeout, console };
  vm.runInNewContext(`${askSrc}\nthis.__api = { askErrorKey, askExplanation, askFigureValue, askRenderAnswer, askRenderError };`, ctx);
  return { ...ctx.__api, ctx };
}

test('UI error mapping: every server error code has a fixed message; unknown ones fall back to a generic error, never blank', () => {
  const { askErrorKey } = loadAsk();
  for (const c of ['EMPTY_QUESTION', 'QUESTION_TOO_LONG', 'UNSUPPORTED_QUESTION', 'UNSUPPORTED_PERIOD', 'ONLY_LAST_30_DAYS', 'NO_REPORT_AVAILABLE', 'NO_DATA_FOR_QUESTION', 'PERIOD_NOT_IN_REPORT', 'ASSISTANT_NOT_AVAILABLE']) assert.equal(askErrorKey(c), `ask.err.${c}`);
  assert.equal(askErrorKey('SOMETHING_ELSE'), 'ask.err.GENERIC'); assert.equal(askErrorKey(undefined), 'ask.err.GENERIC');
  for (const lang of ['fr', 'nl', 'en']) { const src = ui(`lang-${lang}.js`); for (const c of ['NO_REPORT_AVAILABLE', 'UNSUPPORTED_QUESTION', 'GENERIC', 'TIMEOUT']) assert.match(src, new RegExp(`'ask\\.err\\.${c}'`), `${lang} ${c}`); for (const k of ['notConfigured', 'unavailable', 'timeout', 'misconfigured']) assert.match(src, new RegExp(`'ask\\.ai\\.${k}'`)); }
});

test('UI shows the AI explanation status honestly: not configured / unavailable / timeout are labelled, an explanation only appears with a real text', () => {
  const { askExplanation } = loadAsk();
  const txt = (n) => JSON.stringify(n);
  assert.match(txt(askExplanation({ status: 'NOT_CONFIGURED' })), /ask\.ai\.notConfigured/);
  assert.match(txt(askExplanation({ status: 'PROVIDER_UNAVAILABLE' })), /ask\.ai\.unavailable/);
  assert.match(txt(askExplanation({ status: 'TIMEOUT' })), /ask\.ai\.timeout/);
  assert.match(txt(askExplanation({ status: 'OK', provider: 'p', text: 'Explication.' })), /Explication\./);
  assert.equal(askExplanation(null), null);
});
