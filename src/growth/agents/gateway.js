// Nordla Growth - AI agent gateway. The ONLY place where a model is called for Growth.
//   - Server side only. The provider (agents/anthropic.js or any object with the same shape) holds the secret; nothing here returns it.
//   - No provider configured -> status NOT_CONFIGURED and every run is refused. No answer is ever simulated.
//   - An agent reads only its own Growth sources (the merchant's, from the server session), truncated, and returns a DRAFT with its
//     period, sources, limits and reason. It never performs an action (`requiresHumanConfirmation` is always true).
//   - Limits: question length, context size, output size, timeout, daily quota per merchant. Logs carry the agent id, the status and the
//     duration only - never the prompt, the data or the answer.

import { AGENTS, agentById } from './registry.js';
import { redactPersonalFields } from './priority-ref.js';
import { compareWeeklyTarget } from '../goal/compare.js';
import { detectPersonalData } from './privacy.js';

export const MAX_QUESTION = 500;
export const MAX_CONTEXT_CHARS = 60_000;
export const MAX_DRAFT_CHARS = 8_000;
export const MAX_REASON_CHARS = 1_000;
export const MAX_LIMITS = 10;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_DAILY_LIMIT = 20;

export class AgentError extends Error {
  constructor(code, status = 400, details = null) { super(code); this.code = code; this.status = status; this.details = details; } // details: kind names only, never a value
}

/** Source status derived from a getter's answer: a missing or failed source is never zero. */
export function sourceStatusOf(payload) {
  if (payload === null || payload === undefined) return 'unavailable';
  if (payload.status === 'NOT_CONNECTED' || payload.state === 'NOT_CONNECTED' || payload.connected === false) return 'not_connected';
  return 'available';
}

const SAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function validateQuestion(q) {
  if (q === undefined || q === null || q === '') return '';
  if (typeof q !== 'string' || q.length > MAX_QUESTION || SAFE_TEXT.test(q)) throw new AgentError('BAD_REQUEST', 400);
  return q.trim();
}

/** Parse the provider's answer strictly: a JSON object with a draft, a reason and a list of limits. Anything else is refused. */
export function parseDraft(text) {
  let obj;
  try { obj = JSON.parse(String(text).trim()); } catch { throw new AgentError('AI_BAD_OUTPUT', 502); }
  if (!obj || typeof obj !== 'object' || typeof obj.draft !== 'string' || typeof obj.reason !== 'string' || !Array.isArray(obj.limits)) throw new AgentError('AI_BAD_OUTPUT', 502);
  if (obj.draft.length > MAX_DRAFT_CHARS || obj.reason.length > MAX_REASON_CHARS || obj.limits.length > MAX_LIMITS || obj.limits.some((l) => typeof l !== 'string' || l.length > 300)) throw new AgentError('AI_BAD_OUTPUT', 502);
  return { draft: obj.draft, reason: obj.reason, limits: obj.limits };
}

/**
 * @param provider  null, or { name, model, complete({ system, user, maxTokens, signal }) -> Promise<string> }
 * @param getters   { key: async () => payload } - the merchant's Growth source getters (the same ones the pages use)
 */
export function createAgentGateway({ provider = null, getters = {}, timeoutMs = DEFAULT_TIMEOUT_MS, dailyLimit = DEFAULT_DAILY_LIMIT, now = () => new Date(), log = () => {} } = {}) {
  const quota = new Map(); // `${scope}|${day}` -> count (in memory: a restart resets it; the daily limit is a cost guard, not a ledger)

  function status() {
    return {
      configured: Boolean(provider),
      provider: provider ? provider.name : null,
      model: provider ? provider.model ?? null : null, // the model name only; no key
      dailyLimit,
      agents: AGENTS.map((a) => ({ id: a.id, sources: a.sources.map((k) => ({ key: k, available: typeof getters[k] === 'function' })), period: a.period, confirmations: a.confirmations })),
    };
  }

  async function run({ agentId, question = '', scope = 'anonymous', focus = null, goal = null }) { // focus: a priority the server has verified (A5), or null; goal: the weekly target or null
    const agent = agentById(agentId);
    if (!agent) throw new AgentError('BAD_AGENT', 400);
    const q = validateQuestion(question);
    // the merchant's free question: high-confidence personal formats are refused before any provider call (kinds only, no value kept)
    const questionKinds = detectPersonalData(q);
    if (questionKinds.length) throw new AgentError('QUESTION_PERSONAL_DATA', 400, questionKinds);
    if (!provider) throw new AgentError('AI_NOT_CONFIGURED', 503);
    const day = now().toISOString().slice(0, 10);
    const k = `${scope}|${day}`;
    const used = quota.get(k) ?? 0;
    if (used >= dailyLimit) throw new AgentError('AI_QUOTA_EXCEEDED', 429);
    quota.set(k, used + 1);

    const started = Date.now();
    // each source is read ONCE for this run: its status and its (truncated) data come from the same answer
    const sources = []; const context = {}; const truncated = []; const payloads = {};
    const perSource = Math.floor(MAX_CONTEXT_CHARS / Math.max(1, agent.sources.length));
    for (const key of agent.sources) {
      let payload = null; let st = 'unavailable';
      if (typeof getters[key] === 'function') { try { payload = await getters[key](); st = sourceStatusOf(payload); } catch { payload = null; st = 'unavailable'; } }
      sources.push({ key, status: st });
      if (st !== 'available') { context[key] = { status: st }; continue; }
      payloads[key] = payload;
      const text = JSON.stringify(redactPersonalFields(payload)); // personal fields never reach the provider (A5 hardening)
      if (text.length > perSource) { context[key] = { status: 'available', data_truncated: text.slice(0, perSource) }; truncated.push(key); }
      else context[key] = { status: 'available', data: JSON.parse(text) };
    }
    // the weekly target: a TARGET set by the merchant, never a realised figure; only the agents given it (registry goal: true)
    let goalSaid = false; let goalNote = null;
    if (agent.goal) {
      // the same bounds as the stored value (follow-up-store.js): a whole number from 0 to 100 000 000 EUR, otherwise no target
      const t = goal && Number.isInteger(goal.weeklySalesTargetEur) && goal.weeklySalesTargetEur >= 0 && goal.weeklySalesTargetEur <= 100000000 ? goal.weeklySalesTargetEur : null;
      if (t !== null) {
        // the comparison is computed here, on the server, from the store weekly rows (no model choice of week or gap)
        const comparison = compareWeeklyTarget({ target: t, store: payloads.store ?? null });
        if (comparison.status !== 'computed') goalNote = comparison.reason;
        context.goal = { status: 'available', data: redactPersonalFields({ kind: 'target', period: 'weekly', weeklySalesTargetEur: t, basis: 'chiffre d’affaires hebdomadaire boutique + en ligne ; cible définie par le marchand, pas un résultat', note: typeof goal.note === 'string' ? goal.note : null, comparison }) };
      } else {
        context.goal = { status: 'unavailable' };
        goalSaid = true;
      }
    }
    const user = JSON.stringify({ period: agent.period, question: q, context, ...(focus ? { priority: redactPersonalFields(focus) } : {}) });

    const ac = new AbortController();
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new AgentError('AI_TIMEOUT', 504)); }, timeoutMs); });
    try {
      const text = await Promise.race([provider.complete({ system: agent.system, user, maxTokens: 1200, signal: ac.signal }), timeout]);
      const out = parseDraft(text);
      // the model's answer: a draft that contains a high-confidence personal format is NOT kept (kinds only, no value)
      const leaks = detectPersonalData([out.draft, out.reason, ...out.limits].join('\n'));
      if (leaks.length) throw new AgentError('AI_OUTPUT_BLOCKED', 422, leaks);
      log(`growth agent ${agent.id} ok ${Date.now() - started}ms`);
      return {
        agent: agent.id, generatedAt: now().toISOString(), period: agent.period,
        sources, truncated,
        limits: [...out.limits, ...(goalSaid ? ["objectif hebdomadaire indisponible : aucun écart ne peut être calculé"] : []), ...(goalNote ? ['comparaison objectif / ventes indisponible : ' + goalNote] : []), ...sources.filter((s) => s.status !== 'available').map((s) => `source ${s.key}: ${s.status === 'not_connected' ? 'non connectée' : 'indisponible'}`)],
        reason: out.reason, draft: out.draft,
        requiresHumanConfirmation: true, confirmations: agent.confirmations,
      };
    } catch (e) {
      const code = e instanceof AgentError ? e.code : 'AI_PROVIDER_ERROR';
      log(`growth agent ${agent.id} ${code} ${Date.now() - started}ms`);
      if (e instanceof AgentError) throw e;
      throw new AgentError('AI_PROVIDER_ERROR', 502);
    } finally { clearTimeout(timer); }
  }

  return { status, run };
}
