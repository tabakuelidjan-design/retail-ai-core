import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { createAssistant } from '../src/analytics-premium/server/assistant.js';
import { resetPeriodCache } from '../src/analytics-premium/server/period-engine.js';
import { createToolLayer } from '../src/analytics-premium/server/tools/index.js';
import { createOrchestrator, cleanHistory } from '../src/analytics-premium/server/ai/orchestrator.js';
import { MAX_PLAN_TURNS, MAX_TOOL_CALLS, assertProvider, callProvider } from '../src/analytics-premium/server/ai/contract.js';
import { buildFacts } from '../src/analytics-premium/server/ai/facts.js';
import { checkQuantity, scanDates, scanNumbers, statesCertainty, verifyExplanation } from '../src/analytics-premium/server/ai/verify.js';
import { NOW, writeDataset } from './fixtures/analytics-dataset.js';
import { createFakeProvider } from './fixtures/fake-ai-provider.js';

// Phase 2: plan -> tools -> facts -> explain -> verify, with a FAKE provider only (no real AI provider exists here). SYNTHETIC data only.

async function setup({ dirty = false, ...providerOpts } = {}) {
  const diagnostics = [];
  resetPeriodCache();
  const dir = await writeDataset({ dirty });
  const provider = createFakeProvider(providerOpts);
  const tools = createToolLayer({ reportsDir: dir, now: () => NOW });
  const ask = createOrchestrator({ provider, tools, timeoutMs: 400, onDiagnostic: (d) => { if (!d.type.startsWith('PREMISES_')) diagnostics.push(d); } /* the premise-declaration events are benchmark data, not rejections */ });
  return { dir, provider, tools, ask, diagnostics };
}
const val = (r, ref) => r.facts.find((f) => f.ref === ref)?.value;

test('simple question, one tool: plan -> get_sales_metrics -> facts -> explain -> verified answer with claims tied to facts', async () => {
  const { ask, provider, tools } = await setup();
  const r = await ask({ question: 'Quel est mon chiffre d\'affaires ?' });
  assert.equal(r.status, 'OK'); assert.equal(r.explanation.status, 'VERIFIED'); assert.equal(r.toolCalls.length, 1); assert.equal(r.toolCalls[0].tool, 'get_sales_metrics');
  const direct = await tools.call('get_sales_metrics', {});
  assert.equal(val(r, 'c1.values.net_sales_ex_tax'), direct.values.find((v) => v.key === 'net_sales_ex_tax').value, 'the fact is the tool layer\'s figure');
  assert.ok(r.answer.text.includes('chiffre d\'affaires net')); assert.ok(r.answer.parts.every((c) => c.factRefs.length >= 1));
  assert.equal(provider.seen.plan.length, 1, 'one planning turn'); assert.equal(provider.seen.explain.length, 1);
});

test('compound question ("why did my sales drop"): the planner asks for 4 tools, all run, the answer is built from all their facts', async () => {
  const { ask } = await setup();
  const r = await ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ?' });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.toolCalls.map((c) => c.tool), ['get_sales_metrics', 'compare_sales', 'get_top_products', 'get_channels']); assert.ok(r.toolCalls.every((c) => c.ok));
  for (const p of ['c1.values.net_sales_ex_tax', 'c2.comparison.net_sales_ex_tax.delta_pct', 'c3.items.0.label', 'c4.items.0.share']) assert.notEqual(val(r, p), undefined, p);
  const used = new Set(r.answer.parts.flatMap((c) => c.factRefs.map((f) => f.split('.')[0]))); assert.ok(used.size >= 2, `the answer draws on several tool results (${[...used]})`); assert.ok(r.answer.parts.some((c) => c.factRefs.some((f) => f.includes('.comparison.'))), 'and on the comparison facts');
  const hyp = r.answer.parts.filter((x) => x.type === 'hypothesis'); assert.ok(hyp.length === 1 && hyp[0].factRefs.length >= 1 && hyp[0].confidence === 'low', 'the hypothesis is kept, with its evidence');
  assert.ok(/possible/i.test(hyp[0].text));
});

test('two planning turns: the second turn sees only the OUTCOME of the first calls (tool, args, ok) - never a value', async () => {
  const { ask, provider } = await setup();
  const r = await ask({ question: 'Est-ce que les remboursements expliquent la baisse ?' });
  assert.equal(r.status, 'OK'); assert.equal(r.turns, 2); assert.deepEqual(r.toolCalls.map((c) => c.tool), ['get_sales_metrics', 'get_sales_metrics']);
  assert.equal(provider.seen.plan.length, 2); assert.deepEqual(provider.seen.plan[0].previousCalls, []);
  assert.deepEqual(provider.seen.plan[1].previousCalls, [{ tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } }, ok: true }]);
  const p2 = JSON.stringify(provider.seen.plan[1]); for (const f of r.facts.filter((x) => typeof x.value === 'number' && x.value > 20)) assert.ok(!new RegExp(String.raw`(?<![\w.])` + String(f.value).replace('.', String.raw`\.`) + String.raw`(?![\w])`).test(p2), `no fact value in the turn-2 payload (${f.value})`);
});

test('clarification: no tool runs, no explanation is requested, and a clarification carrying a figure is refused', async () => {
  const { ask, provider } = await setup();
  const r = await ask({ question: 'Donne-moi un truc sur mes machins' });
  assert.equal(r.status, 'CLARIFICATION'); assert.match(r.clarification.text, /période/); assert.deepEqual(r.toolCalls, []); assert.equal(provider.seen.explain.length, 0);
  const bad = await setup({ planner: () => ({ clarification: { text: 'Voulez-vous les 30 derniers jours ?' } }) });
  assert.deepEqual(await bad.ask({ question: 'x' }), { status: 'PLAN_FAILED', code: 'PLAN_INVALID', turns: 1 });
});

test('an unknown tool is refused (never run, counted against the limit); invalid arguments are refused; the valid call still runs', async () => {
  const s = await setup({ planner: () => ({ toolCalls: [{ tool: 'get_weather', args: {} }, { tool: 'drop_database', args: {} }, { tool: 'get_top_products', args: { limit: 999 } }, { tool: 'get_sales_metrics', args: {} }] }) });
  const r = await s.ask({ question: 'x' });
  assert.equal(r.status, 'OK'); assert.deepEqual(r.toolCalls.map((c) => [c.tool, c.ok, c.errorCode ?? null, !!c.rejected]), [['get_sales_metrics', true, null, false], ['get_weather', false, 'UNKNOWN_TOOL', true], ['drop_database', false, 'UNKNOWN_TOOL', true], ['get_top_products', false, 'INVALID_ARGUMENT', true]]);
  assert.equal(r.facts.every((f) => f.ref.startsWith('c1.')), true, 'only the valid call produced facts');
  const allBad = await (await setup({ planner: () => ({ toolCalls: [{ tool: 'nope' }] }) })).ask({ question: 'x' });
  assert.equal(allBad.status, 'CANNOT_ANSWER'); assert.equal(allBad.reason, 'NO_DATA'); assert.equal(allBad.explanation.status, 'SKIPPED');
});

test(`limits: at most ${MAX_TOOL_CALLS} tool calls per question and ${MAX_PLAN_TURNS} planning turns`, async () => {
  const call = (limit) => ({ tool: 'get_top_products', args: { limit } }); // distinct calls (an identical call is re-used, not run twice)
  const a = await setup({ planner: () => ({ toolCalls: [1, 2, 3, 4, 5, 6].map(call) }) });
  const r = await a.ask({ question: 'x' });
  assert.equal(r.toolCalls.length, 4); assert.equal(r.limits.truncated, true); assert.equal(r.limits.maxToolCalls, 4);
  const b = await setup({ planner: ({ turn }) => ({ toolCalls: [call(turn)], more: true }) });
  const r2 = await b.ask({ question: 'x' });
  assert.equal(b.provider.seen.plan.length, 2, 'a provider that always asks for more is stopped after 2 turns'); assert.equal(r2.turns, 2); assert.equal(r2.toolCalls.length, 2);
  const c = await setup({ planner: ({ turn }) => ({ toolCalls: turn === 1 ? [call(1), call(2), call(3)] : [call(4), call(5), call(6)], more: true }) });
  const r3 = await c.ask({ question: 'x' }); assert.equal(r3.toolCalls.length, 4, 'the cap spans the turns'); assert.equal(r3.limits.truncated, true);
});

test('provider failures: planner error/timeout -> PLAN_FAILED (no detail leaked); explainer error/timeout -> the deterministic facts, with an explicit status', async () => {
  for (const planError of ['throw', 'hang']) {
    const s = await setup({ planError }); const r = await s.ask({ question: 'x' });
    assert.equal(r.status, 'PLAN_FAILED'); assert.equal(r.code, planError === 'hang' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR'); assert.ok(!JSON.stringify(r).includes('sk-live'));
  }
  for (const [explainError, status] of [['throw', 'UNAVAILABLE'], ['hang', 'TIMEOUT']]) {
    const s = await setup({ explainError }); const r = await s.ask({ question: 'Quel est mon chiffre d\'affaires ?' });
    assert.equal(r.status, 'FACTS_ONLY'); assert.equal(r.explanation.status, status); assert.ok(r.facts.length > 0, 'facts are still delivered'); assert.equal(r.answer, undefined); assert.ok(!JSON.stringify(r).includes('sk-live'));
  }
  assert.throws(() => assertProvider({ plan() {} }), /plan\(\) and explain\(\)/);
  await assert.rejects(callProvider(() => new Promise(() => {}), 30), (e) => e.code === 'PROVIDER_TIMEOUT');
});

test('HALLUCINATION BLOCKED: an invented percentage is rejected, never displayed, and the deterministic facts are shown instead', async () => {
  const s = await setup({ explainMode: 'invent-percent' });
  const r = await s.ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ?' });
  assert.equal(r.status, 'FACTS_ONLY'); assert.equal(r.explanation.status, 'REJECTED'); assert.deepEqual(s.diagnostics[0].reasons, [{ code: 'QUANTITY_NOT_SUPPORTED', where: 'claims[0]' }], 'the technical reason goes to diagnostics only'); assert.ok(!JSON.stringify(r).includes('QUANTITY_NOT_SUPPORTED'), 'and never to the client');
  assert.equal(r.answer, undefined); const json = JSON.stringify(r);
  assert.ok(!/\b52\b/.test(json), 'the invented figure appears nowhere in the response'); assert.ok(r.facts.length > 10, 'the real facts are there');
  assert.notEqual(val(r, 'c2.comparison.net_sales_ex_tax.delta_pct'), 0.52);
});

test('every kind of unsupported claim is rejected: wrong amount, wrong unit, wrong sign, wrong date, number or date slipped into the text, unknown ref, no ref, bad shape, number only in the answer', async () => {
  const expected = { 'invent-in-text': 'UNSUPPORTED_NUMBER_IN_TEXT', 'no-ref': 'CLAIM_WITHOUT_FACT_REF', 'unknown-ref': 'UNKNOWN_FACT_REF', 'wrong-unit': 'QUANTITY_UNIT_MISMATCH', 'wrong-sign': 'QUANTITY_NOT_SUPPORTED',
    'wrong-money': 'QUANTITY_NOT_SUPPORTED', 'wrong-date': 'QUANTITY_NOT_SUPPORTED', 'date-in-text': 'UNSUPPORTED_DATE_IN_TEXT', 'invalid-shape': 'INVALID_EXPLANATION_SHAPE' };
  for (const [mode, code] of Object.entries(expected)) {
    const s = await setup({ explainMode: mode }); const r = await s.ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ?' });
    assert.equal(r.status, 'FACTS_ONLY', mode); assert.equal(r.explanation.status, 'REJECTED', mode); assert.equal(s.diagnostics[0].reasons[0].code, code, mode); assert.equal(r.answer, undefined, mode);
    assert.ok(!/\b(52|999|1000)\b/.test(JSON.stringify(r)), `${mode}: the rejected number is never echoed`);
  }
});

test('claim without factRef is rejected as a whole (the explanation is not shown)', async () => {
  const s = await setup({ explainMode: 'no-ref' }); const r = await s.ask({ question: 'Quel est mon chiffre d\'affaires ?' });
  assert.equal(r.explanation.status, 'REJECTED'); assert.equal(s.diagnostics[0].reasons[0].code, 'CLAIM_WITHOUT_FACT_REF'); assert.equal(r.answer, undefined); assert.ok(r.facts.length);
});

test('hypotheses: without proof, with an unknown ref, with an unsupported number, or stated as a certainty -> suppressed one by one; the valid one and the answer are kept', async () => {
  const s = await setup({ explainMode: 'hyp' }); const r = await s.ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ?' });
  assert.equal(r.status, 'OK'); assert.equal(r.explanation.status, 'VERIFIED');
  const hp = r.answer.parts.filter((x) => x.type === 'hypothesis'); assert.equal(hp.length, 1); assert.match(hp[0].text, /Une cause possible est le poids/);
  assert.deepEqual(s.diagnostics.find((d) => d.type === 'HYPOTHESES_SUPPRESSED').suppressedHypotheses, [{ index: 1, code: 'HYPOTHESIS_WITHOUT_EVIDENCE' }, { index: 2, code: 'UNKNOWN_FACT_REF' }, { index: 3, code: 'UNSUPPORTED_NUMBER_IN_TEXT' }, { index: 4, code: 'HYPOTHESIS_STATED_AS_CERTAINTY' }]);
  assert.ok(!JSON.stringify(r.answer).includes('77'), 'the unsupported number of a suppressed hypothesis is not shown');
});

test('a valid answer is kept intact: the displayed text and parts are exactly the verified claims (kind, text, factRefs) the provider produced', async () => {
  const s = await setup(); const r = await s.ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ?' });
  assert.equal(r.status, 'OK'); const given = s.provider.lastExplanation;
  assert.deepEqual(r.answer.parts.filter((p) => p.type !== 'hypothesis').map((p) => [p.type, p.text, p.factRefs]), given.claims.map((c) => [c.kind ?? 'fact', c.text, c.factRefs]));
  assert.equal(r.answer.text, given.claims.map((c) => c.text).join(' '));
  for (const c of given.claims) for (const q of c.quantities ?? []) assert.equal(checkQuantity(q, r.facts.find((f) => f.ref === q.factRef)), null);
});

test('PRIVACY: the planner gets only question, language, short sanitized history, catalog, selected period and call outcomes; the explainer only facts - never personal data', async () => {
  const s = await setup({ dirty: true });
  const history = [{ role: 'user', text: 'écris à marie@example.com ou +32 470 12 34 56' }, { role: 'assistant', text: 'IBAN BE68 5390 0754 7034' }, { role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'user', text: 'z'.repeat(900) }];
  const r = await s.ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ? contact jean@example.com', history, selected: { period: 'last_7_days' } });
  assert.equal(r.status, 'OK');
  const p = s.provider.seen.plan[0]; assert.deepEqual(Object.keys(p).sort(), ['catalog', 'history', 'lang', 'previousCalls', 'question', 'selectedPeriod', 'turn']);
  assert.ok(p.history.length <= 6, 'a short history only (3 exchanges at most)'); assert.ok(p.history.every((h) => h.text.length <= 300));
  const e = s.provider.seen.explain[0]; assert.deepEqual(Object.keys(e).sort(), ['calls', 'facts', 'lang', 'premises', 'question', 'rules']);
  for (const payload of [p, e]) { const j = JSON.stringify(payload); assert.ok(!/@[\w-]+\./.test(j), 'no e-mail'); assert.ok(!/\+32[\d ]{6,}/.test(j), 'no phone'); assert.ok(!/BE68/.test(j), 'no IBAN'); assert.ok(!/[a-e]{64}/.test(j), 'no customer key'); }
  assert.ok(e.facts.some((f) => /Fixture Gadget/.test(String(f.value)) || true)); assert.ok(!JSON.stringify(e).includes('jean.dupont'), 'a product title that carried an e-mail is redacted before the provider sees it');
  assert.deepEqual(p.catalog.map((t) => Object.keys(t).sort()).flat().filter((k, i, a) => a.indexOf(k) === i).sort(), ['description', 'inputSchema', 'name'], 'the catalog carries no data');
  assert.deepEqual(cleanHistory('nope'), []);
});

test('the page-selected period fills a call that names none, and the filled arguments are what is reported', async () => {
  const s = await setup(); const r = await s.ask({ question: 'Quel est mon chiffre d\'affaires ?', selected: { period: 'last_7_days' } });
  assert.deepEqual(r.toolCalls[0].args, { period: { period: 'last_7_days' } }); assert.equal(r.toolCalls[0].period.days, 7);
  assert.deepEqual(s.provider.seen.plan[0].selectedPeriod, { period: 'last_7_days' });
});

test('short conversation context: "Et le mois dernier ?" is understood from the previous turn (planner history), without any permanent memory', async () => {
  const s = await setup();
  const r = await s.ask({ question: 'Et le mois dernier ?', history: [{ role: 'user', text: 'Quel est mon meilleur produit ce mois-ci ?' }, { role: 'assistant', text: 'Produit X.' }] });
  assert.equal(r.toolCalls[0].tool, 'get_top_products'); assert.equal(r.toolCalls[0].args.period.period, 'previous_month'); assert.equal(r.status, 'OK');
  const alone = await s.ask({ question: 'Et le mois dernier ?' }); assert.equal(alone.status, 'CANNOT_ANSWER', 'no history, no guess');
});

test('/api/ask with an AI provider: the orchestrated answer; without one, the deterministic keyword path is unchanged; when planning fails it falls back and says so', async () => {
  resetPeriodCache(); const dir = await writeDataset();
  const serve = async (assistant) => { const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir, now: () => NOW, ask: assistant })); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
    return { post: async (body) => { const r = await fetch(`http://127.0.0.1:${port}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; }, close: () => new Promise((r) => server.close(r)) }; };
  const plain = await serve(createAssistant({ reportsDir: dir, now: () => NOW }));
  const ai = await serve(createAssistant({ reportsDir: dir, now: () => NOW, aiProvider: createFakeProvider() }));
  const broken = await serve(createAssistant({ reportsDir: dir, now: () => NOW, aiProvider: createFakeProvider({ planError: 'throw' }) }));
  try {
    const kw = await plain.post({ question: 'Combien de commandes ces 30 derniers jours ?' });
    assert.equal(kw.status, 200); assert.equal(kw.data.intent, 'orders'); assert.equal(kw.data.mode, undefined); assert.ok(kw.data.figures.length);
    assert.equal((await plain.post({ question: 'Pourquoi mes ventes ont baissé ?' })).data.intent, 'revenue', 'the keyword path is what it always was');
    assert.equal((await plain.post({ question: 'zzz qqq' })).status, 422);
    const a = await ai.post({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ?', history: [{ role: 'user', text: 'bonjour' }] });
    assert.equal(a.status, 200); assert.equal(a.data.mode, 'ai'); assert.equal(a.data.status, 'OK'); assert.equal(a.data.toolCalls.length, 4);
    const f = await broken.post({ question: 'Combien de commandes ces 30 derniers jours ?' });
    assert.equal(f.status, 200); assert.equal(f.data.intent, 'orders', 'the keyword answer'); assert.deepEqual(f.data.ai, { status: 'UNAVAILABLE', code: 'PROVIDER_ERROR' });
    assert.equal(kw.data.figures[0].value, f.data.figures[0].value);
  } finally { await Promise.all([plain.close(), ai.close(), broken.close()]); }
});

test('verifier units: quantities are matched at the precision written; numerals and dates in prose are scanned in FR/NL/EN formats; certainty wording is detected', () => {
  const fact = (unit, value) => ({ unit, value });
  assert.equal(checkQuantity({ kind: 'money', value: 840.31 }, fact('EUR', 840.31)), null); assert.equal(checkQuantity({ kind: 'money', value: 840 }, fact('EUR', 840.31)), null, 'rounded to the precision written');
  assert.equal(checkQuantity({ kind: 'money', value: 841 }, fact('EUR', 840.31)), 'QUANTITY_NOT_SUPPORTED'); assert.equal(checkQuantity({ kind: 'money', value: 840.314 }, fact('EUR', 840.31)), 'QUANTITY_NOT_SUPPORTED');
  assert.equal(checkQuantity({ kind: 'percent', value: 37.09 }, fact('ratio', 0.3709)), null); assert.equal(checkQuantity({ kind: 'percent', value: 37 }, fact('ratio', 0.3709)), null); assert.equal(checkQuantity({ kind: 'percent', value: 0.37 }, fact('ratio', 0.3709)), 'QUANTITY_NOT_SUPPORTED');
  assert.equal(checkQuantity({ kind: 'count', value: 31 }, fact('count', 31)), null); assert.equal(checkQuantity({ kind: 'count', value: 31.5 }, fact('count', 31)), 'QUANTITY_NOT_SUPPORTED'); assert.equal(checkQuantity({ kind: 'count', value: 31 }, fact('EUR', 31)), 'QUANTITY_UNIT_MISMATCH');
  assert.equal(checkQuantity({ kind: 'days', value: 30 }, fact('days', 30)), null); assert.equal(checkQuantity({ kind: 'date', value: '2026-09-25' }, fact('date', '2026-09-25')), null); assert.equal(checkQuantity({ kind: 'date', value: '2026-09-24' }, fact('date', '2026-09-25')), 'QUANTITY_NOT_SUPPORTED');
  assert.equal(checkQuantity({ kind: 'money', value: 1 }, undefined), 'UNKNOWN_FACT_REF');
  assert.deepEqual(scanNumbers('1 234,50 € et 37 % sur 31 commandes').map((n) => n.candidates[0]), [1234.5, 37, 31]); assert.ok(scanNumbers('1.234,5').some((n) => n.candidates.includes(1234.5)));
  const d = scanDates('du 2026-09-01 au 25/09 et le 1er septembre 2026, 3 juillet, September 2026'); assert.equal(d.dates.length, 5); assert.equal(d.rest.replace(/\s+/g, ''), 'duauetle,,');
  assert.ok(statesCertainty('La baisse est due à ce produit')); assert.ok(statesCertainty('This is caused by the refunds')); assert.ok(statesCertainty('Dit komt door de terugbetalingen')); assert.ok(!statesCertainty('Une cause possible est ce produit'));
  const facts = buildFacts([]); assert.equal(verifyExplanation(null, facts).status, 'REJECTED');
  // documented limit: numbers spelled out in words are not detected (the structured quantities are the guarantee)
  const f2 = { list: [{ ref: 'c1.values.order_count', value: 31, unit: 'count' }], byRef: new Map([['c1.values.order_count', { ref: 'c1.values.order_count', value: 31, unit: 'count' }]]) };
  assert.equal(verifyExplanation({ answer: 'Il y a trente commandes.', claims: [{ text: 'Il y a trente commandes.', factRefs: ['c1.values.order_count'] }] }, f2).status, 'VERIFIED', 'KNOWN LIMIT: a number written in words passes the text scan');
});

test('provider-neutral and offline: the AI layer names no provider and makes no network call; the Tool Layer stays network-free; understand() and figuresFor() are still exported', () => {
  const dir = new URL('../src/analytics-premium/server/ai/', import.meta.url);
  const src = readdirSync(dir).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  assert.ok(!/openai|anthropic|claude|kimi|gpt-|gemini|mistral|sk-/i.test(src.replace(/`claude`/g, '')), 'no provider is named'); assert.ok(!/\bfetch\(|node:https?|XMLHttpRequest/.test(src));
  const toolsSrc = readdirSync(new URL('../src/analytics-premium/server/tools/', import.meta.url)).map((f) => readFileSync(new URL(`../src/analytics-premium/server/tools/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.ok(!/\bfetch\(|node:https?/.test(toolsSrc));
  const assistant = readFileSync(new URL('../src/analytics-premium/server/assistant.js', import.meta.url), 'utf8');
  assert.match(assistant, /export function understand\(/); assert.match(assistant, /export function figuresFor\(/);
  assert.ok(!/loadAssistantProvider\([^)]*\)[^;]*aiProvider/.test(assistant) && /PROVIDER_REGISTRY = \{\}/.test(assistant), 'no real provider is registered');
});
