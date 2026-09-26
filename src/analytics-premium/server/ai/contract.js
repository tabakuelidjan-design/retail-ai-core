// Nordla AI Provider contract (Phase 2). Provider-neutral: NO provider is named, bundled or called from here.
//
//   AI Provider = {
//     name: string,
//     plan({ question, lang, history, catalog, selectedPeriod, turn, previousCalls, signal })  -> Plan
//     explain({ question, lang, facts, calls, rules, signal })                                 -> Explanation
//   }
//
// The provider NEVER computes a figure and never reads data: it (1) understands the question and picks tools from the catalog, then (2) words the facts
// the tools returned, in structured form so that the server can verify every quantity against those facts before anything is shown.
//
// What each call receives (nothing else):
//   plan     the question, the language, a short sanitized history, the tool catalog (names, descriptions, JSON Schemas), the period selected in the page,
//            and - on the second turn only - the OUTCOME of the calls already made (tool, args, ok, error code): never a value.
//   explain  the question and the FACTS returned by the tools (aggregated, pseudonymous), with each call's completeness. Never raw records, never personal data.

import { MAX_PREMISES, PREMISE_SCHEMA } from './premise.js';

export const MAX_TOOL_CALLS = 4;        // per question, across all planning turns
export const MAX_PLAN_TURNS = 2;
export const MAX_HISTORY_TURNS = 6;      // messages = 3 exchanges (question + answer); kept in the page only, never stored
export const MAX_HISTORY_TEXT = 300;
export const MAX_CLARIFICATION = 300;
export const PROVIDER_TIMEOUT_MS = 20_000;

/** What Nordla knows it does not have (yet). Only these codes can be named as missing; anything else stays generic. */
export const KNOWN_GAPS = ['costs', 'traffic', 'ad_spend', 'payment_fees', 'inventory', 'finance', 'forecast', 'history'];

/** Plan: exactly one of toolCalls / clarification / cannotAnswer / done (`more` optionally asks for a second planning turn). */
export const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    toolCalls: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['tool'], properties: { tool: { type: 'string', maxLength: 64 }, args: { type: 'object' } } } },
    clarification: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: MAX_CLARIFICATION } } },
    done: { type: 'boolean' },
    // The provider says the question cannot be answered with these tools; `gaps` optionally names what is missing, from KNOWN_GAPS only.
    cannotAnswer: { type: 'object', additionalProperties: false, properties: { gaps: { type: 'array', maxItems: 4, items: { type: 'string', enum: KNOWN_GAPS } } } },
    // What the question TAKES FOR GRANTED ("why did my sales drop?" assumes a drop), stated as structure. Nordla checks each premise against its own facts
    // before any analysis is built on it (premise.js). Not counted as an intent: it accompanies toolCalls, or stands alone.
    premises: { type: 'array', maxItems: MAX_PREMISES, items: PREMISE_SCHEMA },
    more: { type: 'boolean' },   // with toolCalls: ask me to plan again once these calls have run (turn 2 sees their outcome, never a value)
  },
};

/** fact: states a value. comparison: puts two values side by side (>= 2 facts). correlation: two things that moved together, from >= 2 different tool results - never a cause. */
export const CLAIM_KINDS = ['fact', 'comparison', 'correlation'];
const QUANTITY_KINDS = ['money', 'count', 'percent', 'days', 'date'];
const QUANTITY_SCHEMA = { type: 'object', additionalProperties: false, required: ['kind', 'value', 'factRef'], properties: { kind: { type: 'string', enum: QUANTITY_KINDS }, value: {}, factRef: { type: 'string', maxLength: 200 } } };
const REFS = { type: 'array', minItems: 0, maxItems: 24, items: { type: 'string', maxLength: 200 } };

/** Explanation: an answer, its claims (each tied to facts) and optional "why" hypotheses (each tied to facts). */
export const EXPLANATION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['claims'],
  properties: {
    answer: { type: 'string', maxLength: 1200 },   // legacy free text: accepted but NEVER displayed - the shown answer is built from the verified claims only
    claims: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['text', 'factRefs'], properties: { kind: { type: 'string', enum: CLAIM_KINDS }, text: { type: 'string', minLength: 1, maxLength: 400 }, factRefs: REFS, quantities: { type: 'array', maxItems: 8, items: QUANTITY_SCHEMA } } } },
    hypotheses: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['text', 'factRefs', 'confidence'], properties: { text: { type: 'string', minLength: 1, maxLength: 400 }, factRefs: REFS, confidence: { type: 'string', enum: ['low', 'medium', 'high'] }, quantities: { type: 'array', maxItems: 8, items: QUANTITY_SCHEMA } } } },
  },
};

export const QUANTITY_KIND_LIST = QUANTITY_KINDS;

/** The rules handed to `explain` so a provider (or its prompt) knows the contract it is verified against. */
export const EXPLAIN_RULES = [
  'Use ONLY the facts provided. Never compute, estimate or round a figure yourself.',
  'Every number, percentage, amount, count, period or date you write must appear in `quantities` with the factRef of the single fact that holds it.',
  'Every claim lists the factRefs that justify it. A claim without a factRef is rejected.',
  'A claim has a kind: fact (states a value), comparison (two values side by side), correlation (two things that moved together - never a cause). Only what is in claims and hypotheses is shown: free text is ignored.',
  'A "why" is a hypothesis: give it factRefs and a confidence (low | medium | high), and word it as a possible cause, never as a certainty.',
  'If the facts are missing or partial (see each call\'s completeness / errorCode), say so instead of answering.',
];

export function assertProvider(p) {
  if (!p || typeof p.plan !== 'function' || typeof p.explain !== 'function') throw new TypeError('An AI provider needs plan() and explain()');
  return p;
}

/** Run a provider call with a hard timeout and an abort signal. Rejects with { code: 'PROVIDER_TIMEOUT' | 'PROVIDER_ERROR' } - never leaks the provider's message. */
export async function callProvider(fn, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const ac = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(Object.assign(new Error('timeout'), { code: 'PROVIDER_TIMEOUT' })); }, timeoutMs); });
  try { return await Promise.race([Promise.resolve().then(() => fn(ac.signal)), timeout]); }
  catch (e) { throw e?.code === 'PROVIDER_TIMEOUT' ? e : Object.assign(new Error('provider error'), { code: 'PROVIDER_ERROR' }); }
  finally { clearTimeout(timer); }
}
