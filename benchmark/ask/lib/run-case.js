// Plays one benchmark case (1 to 3 turns) through the REAL Nordla orchestrator with the provider it is given, and records everything the scorer needs:
// the response of each turn, the internal diagnostics, and every provider call (input, latency, usage). It never talks to a provider itself.
//
// A provider (adapter) is { name, plan(input), explain(input), drainUsage?() }. `drainUsage()` is optional: it returns { inputTokens, outputTokens, costUsd? } for the
// calls made since its previous call - that is how tokens and cost get measured later without changing the provider contract.

import { createOrchestrator } from '../../../src/analytics-premium/server/ai/orchestrator.js';

/** What the UI would remember of an answer for the next question (short plain text). Neutral English for premise corrections: the benchmark is language-agnostic here. */
export function assistantTextOf(response) {
  if (response.status === 'OK') return response.answer.text;
  if (response.status === 'CLARIFICATION') return response.clarification.text;
  if (response.status === 'CANNOT_ANSWER') return 'I cannot answer this question with the data available.';
  if (response.status === 'PREMISE_CONTRADICTED' || response.status === 'PREMISE_UNVERIFIABLE') {
    const c = response.premise.checks[0]; const what = [c.kind, c.metric ?? c.scope, c.direction ?? c.level].filter(Boolean).join(' ');
    return `The premise (${what}) is ${c.verdict}${c.actual?.direction ? `; observed: ${c.actual.direction}` : ''}.`.slice(0, 300);
  }
  return 'Figures shown.';
}

function recordProvider(provider, sink) {
  const wrap = (kind) => async (input) => {
    const { signal, ...visible } = input; const t0 = performance.now();
    try { return await provider[kind](input); }
    finally { sink.push({ kind, latencyMs: Math.round((performance.now() - t0) * 10) / 10, input: JSON.parse(JSON.stringify(visible)), usage: provider.drainUsage?.() ?? null }); }
  };
  return { name: provider.name, plan: wrap('plan'), explain: wrap('explain') };
}

/** @returns {Promise<{ caseId, turns: { user, response, diagnostics, providerCalls }[] }>} */
export async function runCase({ testCase, provider, tools, timeoutMs = 60_000, onTurn = null }) {
  const turns = []; const history = [];
  for (let i = 0; i < testCase.turns.length; i += 1) {
    const providerCalls = []; const diagnostics = [];
    if (provider.setContext) provider.setContext(testCase.id, i);       // only the scripted oracle uses this
    const ask = createOrchestrator({ provider: recordProvider(provider, providerCalls), tools, timeoutMs, onDiagnostic: (d) => diagnostics.push(d) });
    const user = testCase.turns[i].user;
    const response = await ask({ question: user, lang: testCase.language, history: history.slice(-6), selected: testCase.selectedPeriod });
    turns.push({ user, response, diagnostics, providerCalls }); if (onTurn) onTurn(testCase.id, i, response);
    history.push({ role: 'user', text: user }, { role: 'assistant', text: assistantTextOf(response) });
  }
  return { caseId: testCase.id, turns };
}
