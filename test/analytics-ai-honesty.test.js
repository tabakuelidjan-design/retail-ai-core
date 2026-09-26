import test from 'node:test';
import assert from 'node:assert/strict';
import { resetPeriodCache } from '../src/analytics-premium/server/period-engine.js';
import { createToolLayer } from '../src/analytics-premium/server/tools/index.js';
import { createOrchestrator } from '../src/analytics-premium/server/ai/orchestrator.js';
import { sanitize } from '../src/analytics-premium/server/tools/contract.js';
import { NOW, writeDataset } from './fixtures/analytics-dataset.js';
import { createFakeProvider } from './fixtures/fake-ai-provider.js';

// Phase 3: honest refusal, explicit limitations, no false causality, and a displayed answer that can only be the verified claims. FAKE provider, SYNTHETIC data.

async function setup({ now = NOW, ...providerOpts } = {}) {
  resetPeriodCache(); const dir = await writeDataset(); const diagnostics = [];
  const provider = createFakeProvider(providerOpts); const tools = createToolLayer({ reportsDir: dir, now: () => now });
  return { provider, diagnostics, ask: createOrchestrator({ provider, tools, timeoutMs: 400, onDiagnostic: (d) => { if (!d.type.startsWith('PREMISES_')) diagnostics.push(d); } /* the premise-declaration events are benchmark data, not rejections */ }) };
}
const codes = (r) => r.limitations.map((l) => l.code);

test('the displayed answer is built ONLY from verified claims: a free-text `answer` that changes the meaning is ignored and never shown', async () => {
  const s = await setup({ explainMode: 'sneaky-answer' }); const r = await s.ask({ question: 'Quel est mon chiffre d\'affaires ?' });
  assert.equal(r.status, 'OK'); assert.ok(!JSON.stringify(r).includes('explosé'), 'the provider\'s free text appears nowhere');
  assert.equal(r.answer.text, s.provider.lastExplanation.claims.map((c) => c.text).join(' '));
  assert.ok(r.answer.parts.every((p) => ['fact', 'comparison', 'correlation', 'hypothesis'].includes(p.type)));
});

test('facts, comparisons, correlations and hypotheses are told apart; a correlation needs two tool results, a comparison two facts, and a claim never asserts a cause', async () => {
  const kinds = async (mode, q) => { const s = await setup({ explainMode: mode }); const r = await s.ask({ question: q }); return { r, s }; };
  const ok = await kinds('honest', 'Pourquoi mes ventes ont baissé ce mois-ci ?');
  assert.deepEqual([...new Set(ok.r.answer.parts.map((p) => p.type))].sort(), ['comparison', 'fact', 'hypothesis']);
  const corr = await kinds('correlation', 'Y a-t-il une corrélation ?'); assert.equal(corr.r.status, 'OK'); assert.ok(corr.r.answer.parts.some((p) => p.type === 'correlation'));
  for (const [mode, code] of [['bad-correlation', 'CLAIM_KIND_INVALID'], ['bad-comparison', 'CLAIM_KIND_INVALID'], ['causal-claim', 'CAUSAL_CLAIM_AS_FACT']]) {
    const x = await kinds(mode, 'Y a-t-il une corrélation ?'); assert.equal(x.r.status, 'FACTS_ONLY', mode); assert.equal(x.s.diagnostics[0].reasons[0].code, code, mode); assert.equal(x.r.answer, undefined);
  }
  assert.ok(ok.r.answer.parts.filter((p) => p.type === 'hypothesis').every((p) => /possible/i.test(p.text) && ['low', 'medium', 'high'].includes(p.confidence)));
});

test('limitations are deterministic and always delivered: costs incomplete (with the metrics it affects), period includes today, history shorter than the period, comparison impossible, stale data', async () => {
  const s = await setup(); const margin = await s.ask({ question: 'Quelle est ma marge ?' });
  const costs = margin.limitations.find((l) => l.code === 'COSTS_PARTIAL'); assert.ok(costs); assert.deepEqual(costs.affects, ['gross_profit', 'gross_margin']); assert.equal(costs.severity, 'warning');
  const t = await setup({ explainMode: 'margin' }); const m2 = await t.ask({ question: 'Quelle est ma marge ?' });
  const claim = m2.answer.parts.find((p) => /marge brute/.test(p.text)); assert.deepEqual(claim.caveats, ['COSTS_PARTIAL'], 'the claim quoting the margin carries the caveat');
  assert.equal(m2.answer.parts.find((p) => /chiffre d'affaires net est/.test(p.text)).caveats, undefined, 'the revenue claim is not flagged');
  const today = await (await setup()).ask({ question: 'Quel est mon chiffre d\'affaires ?', selected: { period: 'this_month' } });
  const inc = today.limitations.find((l) => l.code === 'PERIOD_INCLUDES_TODAY'); assert.equal(inc.severity, 'info');
  const early = await (await setup()).ask({ question: 'Quel est mon chiffre d\'affaires ?', selected: { period: 'custom', from: '2026-06-01', to: '2026-06-20' } });
  assert.equal(early.limitations.find((l) => l.code === 'PERIOD_STARTS_BEFORE_HISTORY').params.historyStart, '2026-06-12');
  const long = await (await setup()).ask({ question: 'Quel est mon chiffre d\'affaires ?', selected: { period: 'last_90_days' } });
  assert.equal(long.limitations.find((l) => l.code === 'COMPARISON_HISTORY_INSUFFICIENT').params.historyStart, '2026-06-12');
  const stale = await (await setup({ now: new Date('2026-09-27T12:00:00Z') })).ask({ question: 'Quel est mon chiffre d\'affaires ?' });
  const st = stale.limitations.find((l) => l.code === 'DATA_STALE'); assert.ok(st.params.ageMinutes > 180);
  for (const r of [margin, m2, today, early, long, stale]) assert.ok(Array.isArray(r.limitations) && r.summary.calls.every((c) => c.completeness && c.freshness), 'limits + freshness are always in the response');
});

test('impossible question: a deterministic refusal, no tool, no explanation, no generic model answer; it names what is missing only when Nordla knows', async () => {
  const s = await setup(); const r = await s.ask({ question: 'Combien de visites sur le site ?' });
  assert.equal(r.status, 'CANNOT_ANSWER'); assert.equal(r.reason, 'PROVIDER_DECLINED'); assert.deepEqual(r.gaps, ['traffic', 'ad_spend']); assert.deepEqual(r.toolCalls, []); assert.equal(s.provider.seen.explain.length, 0);
  const vague = await (await setup()).ask({ question: 'Devine mon avenir' }); assert.equal(vague.status, 'CANNOT_ANSWER'); assert.deepEqual(vague.gaps, [], 'unknown gap: nothing invented');
  const bad = await (await setup({ planner: () => ({ cannotAnswer: { gaps: ['weather'] } }) })).ask({ question: 'x' });
  assert.equal(bad.status, 'PLAN_FAILED', 'a gap that Nordla does not know is not accepted');
  assert.equal(JSON.stringify(r).includes('explication'), false);
});

test('when every tool fails, the refusal says what Nordla knows: history too short -> gap "history", with the date the history starts', async () => {
  const s = await setup({ planner: () => ({ toolCalls: [{ tool: 'get_sales_metrics', args: { period: { period: 'custom', from: '2026-01-01', to: '2026-03-01' } } }] }) });
  const r = await s.ask({ question: 'Compare mes ventes de janvier' });
  assert.equal(r.status, 'CANNOT_ANSWER'); assert.equal(r.reason, 'NO_DATA'); assert.deepEqual(r.gaps, ['history']); assert.equal(s.provider.seen.explain.length, 0, 'no model wording without facts');
  const l = r.limitations[0]; assert.equal(l.code, 'INSUFFICIENT_HISTORY'); assert.equal(l.severity, 'blocking'); assert.equal(l.params.historyStart, '2026-06-12');
  const empty = await (await setup({ planner: () => ({ toolCalls: [{ tool: 'get_top_products', args: { period: { period: 'yesterday' } } }] }) })).ask({ question: 'x' });
  assert.equal(empty.status, 'CANNOT_ANSWER'); assert.equal(empty.limitations[0].code, 'NO_DATA');
});

test('a partial answer stays honest: revenue can be compared while costs are flagged incomplete in the same response', async () => {
  const s = await setup({ explainMode: 'margin' }); const r = await s.ask({ question: 'Quelle est ma marge ?' });
  assert.equal(r.status, 'OK'); assert.ok(codes(r).includes('COSTS_PARTIAL')); assert.ok(r.summary.calls[0].completeness.reasons.includes('COSTS_PARTIAL')); assert.equal(r.summary.calls[0].completeness.status, 'PARTIAL');
});

test('privacy of every input: question, history, product labels, customer labels and facts never carry an e-mail, phone, IBAN or address to the provider', async () => {
  resetPeriodCache(); const dir = await writeDataset({ dirty: true }); const provider = createFakeProvider();
  const ask = createOrchestrator({ provider, tools: createToolLayer({ reportsDir: dir, now: () => NOW }), timeoutMs: 400 });
  const history = [{ role: 'user', text: 'Ma cliente Marie Dupont, rue de Bruxelles 18, 5000 Namur, tel +32 470 12 34 56' }, { role: 'assistant', text: 'Virement BE68 5390 0754 7034 reçu de marie@example.com' }];
  const r = await ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ? Livrez à Avenue Louise 54, 1050 Bruxelles', history });
  assert.equal(r.status, 'OK');
  const payloads = [...provider.seen.plan, ...provider.seen.explain].map((p) => JSON.stringify(p)).join('\n');
  for (const [name, re] of [['e-mail', /@[\w-]+\./], ['phone', /\+32[\d ]{6,}/], ['IBAN', /BE68/], ['street', /rue de Bruxelles 18|Avenue Louise 54/i], ['postal town', /5000 Namur|1050 Bruxelles/], ['customer key', /[a-e]{64}/]]) assert.ok(!re.test(payloads), `no ${name} reaches the provider`);
  const cust = await createToolLayer({ reportsDir: dir, now: () => NOW }).call('get_customers', { limit: 20 });
  assert.ok(cust.items.every((i) => /^#[A-F0-9]{4,12}$/.test(i.label)), 'customer labels are pseudonymous');
  const { value } = sanitize({ label: 'Coque iPhone 15 Pro Max', phone: '+32 81 12 34 56', note: 'Rue Neuve 5 et 5000 Namur' });
  assert.equal(value.label, 'Coque iPhone 15 Pro Max', 'ordinary product names are untouched'); assert.ok(!('phone' in value)); assert.ok(!/Neuve|Namur/.test(value.note));
});
