// Nordla ask orchestrator (Phase 2):   plan -> tools -> facts -> explain -> verify
//
//   1. plan      the provider reads the question (+ short history, tool catalog, selected period) and asks for tool calls, or for a clarification.
//                At most MAX_PLAN_TURNS turns and MAX_TOOL_CALLS calls per question. The second turn only sees the OUTCOME of the first calls, never a value.
//   2. tools     every call is validated against the registry and its JSON Schema, then run by the deterministic Tool Layer (same engines as the pages).
//   3. facts     the results become referenced facts (facts.js).
//   4. explain   the provider words the facts as { answer, claims[], hypotheses[] } (contract.js).
//   5. verify    the server checks every reference and quantity (verify.js). A rejected explanation is never shown: the deterministic facts are.
//
// The provider never computes a figure and never touches data; the Tool Layer makes no network call. Nothing here names a provider.

import { sanitize, validate } from '../tools/contract.js';
import { EXPLAIN_RULES, KNOWN_GAPS, MAX_CLARIFICATION, MAX_HISTORY_TEXT, MAX_HISTORY_TURNS, MAX_PLAN_TURNS, MAX_TOOL_CALLS, PLAN_SCHEMA, PROVIDER_TIMEOUT_MS, assertProvider, callProvider } from './contract.js';
import { buildFacts, caveatsFor, explainPayload } from './facts.js';
import { buildSummary } from './summary.js';
import { verifyExplanation } from './verify.js';

/** The client sends the recent turns; they are untrusted: keep the last few, cap their length, redact anything personal. */
export function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  const turns = history.filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string').slice(-MAX_HISTORY_TURNS)
    .map((h) => ({ role: h.role, text: h.text.slice(0, MAX_HISTORY_TEXT) }));
  return sanitize(turns).value;
}

const cleanSelected = (selected) => (selected && typeof selected.period === 'string' ? sanitize({ period: selected.period, ...(selected.from ? { from: String(selected.from) } : {}), ...(selected.to ? { to: String(selected.to) } : {}) }).value : null);

export function createOrchestrator({ provider, tools, timeoutMs = PROVIDER_TIMEOUT_MS, onDiagnostic = () => {} }) {
  assertProvider(provider);
  const catalog = tools.catalog();

  /** Fill the page-selected period into a call that names none (same rule as the keyword fallback). The filled args are what is reported. */
  const withSelected = (call, selected) => {
    const schema = catalog.find((t) => t.name === call.tool)?.inputSchema;
    const args = { ...(call.args ?? {}) };
    if (selected && schema?.properties?.period && args.period === undefined) args.period = selected;
    return args;
  };

  return async function ask({ question, lang = 'fr', history = [], selected = null }) {
    const q = sanitize(String(question ?? '')).value;
    const hist = cleanHistory(history); const sel = cleanSelected(selected);
    const executed = []; const rejectedCalls = []; let turns = 0; let truncated = false;

    for (let turn = 1; turn <= MAX_PLAN_TURNS; turn += 1) {
      let plan;
      try {
        plan = await callProvider((signal) => provider.plan({ question: q, lang, history: hist, catalog, selectedPeriod: sel, turn, previousCalls: executed.map((e) => ({ tool: e.tool, args: e.args, ok: e.result.ok, ...(e.result.ok ? {} : { errorCode: e.result.error.code }) })), signal }), timeoutMs);
      } catch (e) { return { status: 'PLAN_FAILED', code: e.code ?? 'PROVIDER_ERROR', turns }; }
      turns = turn;
      const shape = plan && typeof plan === 'object' ? validate(PLAN_SCHEMA, plan, 'plan') : 'plan must be an object';
      const intents = plan && typeof plan === 'object' ? ['toolCalls', 'clarification', 'cannotAnswer', 'done'].filter((k) => plan[k] !== undefined && !(k === 'toolCalls' && !plan.toolCalls.length) && !(k === 'done' && plan.done === false)).length : 0;
      if (shape || intents > 1) return { status: 'PLAN_FAILED', code: 'PLAN_INVALID', turns };
      if (plan.clarification) {
        if (executed.length) break;                                   // facts already exist: answer with them rather than ask late
        if (/\d/.test(plan.clarification.text)) return { status: 'PLAN_FAILED', code: 'PLAN_INVALID', turns };   // a question to the user carries no figure
        return { status: 'CLARIFICATION', clarification: { text: sanitize(plan.clarification.text.slice(0, MAX_CLARIFICATION)).value }, turns, toolCalls: [] };
      }
      if (plan.cannotAnswer) {
        if (executed.length) break;
        return { status: 'CANNOT_ANSWER', reason: 'PROVIDER_DECLINED', gaps: [...new Set((plan.cannotAnswer.gaps ?? []).filter((g) => KNOWN_GAPS.includes(g)))], turns, toolCalls: [], limitations: [], summary: { currency: 'EUR', calls: [] }, facts: [] };
      }
      if (!plan.toolCalls?.length) break;                             // done (or nothing to add)
      for (const call of plan.toolCalls) {
        if (executed.length + rejectedCalls.length >= MAX_TOOL_CALLS) { truncated = true; break; }
        if (!tools.has(call.tool)) { rejectedCalls.push({ tool: String(call.tool).slice(0, 64), code: 'UNKNOWN_TOOL' }); continue; }
        const args = withSelected(call, sel);
        const result = await tools.call(call.tool, args);
        if (!result.ok && result.error.code === 'INVALID_ARGUMENT') { rejectedCalls.push({ tool: call.tool, code: 'INVALID_ARGUMENT' }); continue; }
        executed.push({ tool: call.tool, args, result });
      }
      if (!plan.more || truncated) break;   // a second planning turn only when the provider asks for one
    }

    const facts = buildFacts(executed);
    const currency = executed.find((e) => e.result.ok)?.result.currency ?? 'EUR';
    const base = {
      turns, toolCalls: [...facts.calls, ...rejectedCalls.map((r) => ({ ok: false, tool: r.tool, errorCode: r.code, rejected: true }))],
      limits: { maxToolCalls: MAX_TOOL_CALLS, maxPlanTurns: MAX_PLAN_TURNS, truncated },
      limitations: facts.notices, summary: buildSummary(executed, currency),
      facts: facts.list.map((f) => ({ ref: f.ref, value: f.value, unit: f.unit, description: f.description })),   // for "Voir les sources de l'analyse" only
    };
    if (!facts.list.length) {
      // Every call failed (no data, history too short, ...): a deterministic refusal that says what Nordla knows to be missing. No model text.
      const gaps = [...new Set(facts.notices.filter((n) => n.code === 'INSUFFICIENT_HISTORY').map(() => 'history'))];
      return { status: 'CANNOT_ANSWER', reason: 'NO_DATA', gaps, ...base, explanation: { status: 'SKIPPED' } };
    }

    let explanation;
    try { explanation = await callProvider((signal) => provider.explain({ ...explainPayload({ question: q, lang, facts, rules: EXPLAIN_RULES }), signal }), timeoutMs); }
    catch (e) { onDiagnostic({ type: 'EXPLAIN_FAILED', code: e.code }); return { status: 'FACTS_ONLY', ...base, explanation: { status: e.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : 'UNAVAILABLE' } }; }
    const v = verifyExplanation(explanation, facts);
    // Technical rejection reasons are diagnostics: they never reach the client.
    if (v.status !== 'VERIFIED') { onDiagnostic({ type: 'EXPLANATION_REJECTED', reasons: v.reasons, suppressedHypotheses: v.suppressedHypotheses }); return { status: 'FACTS_ONLY', ...base, explanation: { status: 'REJECTED' } }; }
    if (v.suppressedHypotheses.length) onDiagnostic({ type: 'HYPOTHESES_SUPPRESSED', suppressedHypotheses: v.suppressedHypotheses });
    // The displayed answer is the verified claims and hypotheses only; each part carries the limitations that affect the figures it quotes.
    const parts = v.parts.map((p) => { const caveats = caveatsFor(p.factRefs, facts.notices); return caveats.length ? { ...p, caveats } : p; });
    return { status: 'OK', ...base, answer: { text: v.text, parts }, explanation: { status: 'VERIFIED' } };
  };
}
