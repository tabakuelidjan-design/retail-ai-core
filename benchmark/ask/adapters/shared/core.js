// The provider-neutral adapter engine. A provider adapter is only a `wire` object (how to build the HTTP request and how to read the response); everything else -
// the prompt, the two functions, retries, timeouts, usage and cost, diagnostics, secret handling - is identical for all providers and lives here.
//
//   wire.host / wire.path / wire.defaultBaseUrl / wire.allowedHosts        where the provider lives (the API key can only be sent to these hosts)
//   wire.headers(apiKey)                                                    authentication headers
//   wire.build({ config, system, user, tool, reminder })                    -> JSON body
//   wire.parse(json)                                                        -> { call: {name, args}|null, incomplete, usage: {input, output, cached, cacheWrite, reasoning}|null, model, id }
//   wire.efforts (optional)                                                 the reasoning-effort values the provider documents (a config value outside them is refused)

import { AdapterError, postJson, scrub, defaultSleep } from './http.js';
import { EXPLAIN_FUNCTION, PLAN_FUNCTION, explainUserMessage, planUserMessage, promptFingerprint, reminderText, sha256, systemPrompt } from './prompt.js';
import { redact } from '../../lib/meta.js';

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export function validateConfig(config, wire, providerName) {
  const bad = (m) => { throw new AdapterError('BAD_CONFIG', `${providerName}: ${m}`); };
  if (typeof config.model !== 'string' || !config.model) bad('config.model is required (the exact model id comes from the config, never from the code)');
  if (config.reasoningEffort === undefined) bad('config.reasoningEffort is required (a level, or null to send none)');
  if (config.reasoningEffort !== null && wire.efforts && !wire.efforts.includes(config.reasoningEffort)) bad(`reasoningEffort "${config.reasoningEffort}" is not one of ${wire.efforts.join(', ')}`);
  if (typeof config.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(config.apiKeyEnv)) bad('config.apiKeyEnv must be the NAME of an environment variable (e.g. OPENAI_API_KEY), never a key');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.today ?? '')) bad('config.today (YYYY-MM-DD) is required: the plan contract carries no date, so every provider is told the same fixed reference date');
  const p = config.pricing;
  const priced = (x) => num(x) !== null && x >= 0;   // (null >= 0 is true in JavaScript: a null price must NOT pass)
  if (p !== undefined && p !== null && (!priced(p.inputPerMTok) || !priced(p.outputPerMTok))) bad('config.pricing.inputPerMTok and outputPerMTok must be numbers when config.pricing is given (USD per million tokens, from the provider\'s official price page); leave pricing out and the cost stays null');
  const base = new URL(config.baseUrl ?? wire.defaultBaseUrl);
  if (!wire.allowedHosts.includes(base.hostname) || base.protocol !== 'https:') bad(`baseUrl host must be one of ${wire.allowedHosts.join(', ')} over https (the API key is only ever sent to the provider's official host)`);
  return base;
}

/** USD for one call's tokens. `input` is the TOTAL input (cached and cache-write tokens included); output includes reasoning/thinking tokens (billed as output). */
export function costOf(u, pricing) {
  const inP = pricing.inputPerMTok; const cachedP = pricing.cachedInputPerMTok ?? inP; const writeP = pricing.cacheWriteInputPerMTok ?? inP; const outP = pricing.outputPerMTok;
  const fresh = Math.max(0, u.input - (u.cached ?? 0) - (u.cacheWrite ?? 0));
  return Math.round(((fresh * inP + (u.cached ?? 0) * cachedP + (u.cacheWrite ?? 0) * writeP + u.output * outP) / 1e6) * 1e8) / 1e8;
}

/**
 * @param {{ providerName: string, wire: object, config: object, deps?: { fetch?, sleep?, env? } }} p
 * @returns {{ name, plan(input), explain(input), metadata(), drainUsage() }}
 */
export function createAdapter({ providerName, wire, config, deps = {} }) {
  const base = validateConfig(config, wire, providerName);
  const env = deps.env ?? process.env; const fetchImpl = deps.fetch ?? globalThis.fetch; const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = config.timeoutMs ?? 60_000; const maxRetries = config.maxRetries ?? 2; const maxFormatRetries = config.maxFormatRetries ?? 1;
  const ctx = { today: config.today, timeZone: config.timeZone ?? 'Europe/Brussels' };
  const system = systemPrompt(ctx);
  const url = `${base.origin}${base.pathname.replace(/\/$/, '')}${wire.path}`;

  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 };
  let pending = null; let calls = { plan: 0, explain: 0, requests: 0, formatRetries: 0, rateLimited: 0, serverErrors: 0, timeouts: 0, failures: 0 };
  const errors = []; const models = new Set(); let lastResponseId = null;
  const secretsNow = () => [env[config.apiKeyEnv]];   // read at use time; never kept on the adapter object

  // EVERY request that is really sent counts - successes and failures (401, 400, 429, 5xx, timeouts, network errors) alike - so that this counter agrees with the budget guard,
  // which counts at the same point. A request refused by the guard (BUDGET_EXCEEDED) was never sent and is not counted.
  const sendingFetch = async (u, init) => { try { const r = await fetchImpl(u, init); calls.requests += 1; return r; } catch (e) { if (e?.code !== 'BUDGET_EXCEEDED') calls.requests += 1; throw e; } };
  const note = (kind, e) => { errors.push({ kind, code: e.code ?? null, status: e.status ?? null, message: scrub(e.message, secretsNow()).slice(0, 200) }); if (errors.length > 20) errors.shift(); };
  const priced = !!config.pricing;   // without pricing the cost is null - never invented
  const account = (u) => {
    if (!u) return;
    const add = { inputTokens: u.input ?? 0, outputTokens: u.output ?? 0, cachedTokens: u.cached ?? 0, cacheWriteTokens: u.cacheWrite ?? 0, reasoningTokens: u.reasoning ?? 0, costUsd: priced ? costOf({ input: u.input ?? 0, output: u.output ?? 0, cached: u.cached, cacheWrite: u.cacheWrite }, config.pricing) : 0 };
    pending ??= { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 };
    for (const k of Object.keys(add)) { pending[k] += add[k]; totals[k] += add[k]; }
  };

  async function call(kind, input) {
    const apiKey = env[config.apiKeyEnv];
    if (!apiKey) throw new AdapterError('MISSING_API_KEY', `${providerName}: environment variable ${config.apiKeyEnv} is not set`);
    const { signal, ...visible } = input; const tool = kind === 'plan' ? PLAN_FUNCTION : EXPLAIN_FUNCTION;
    const user = kind === 'plan' ? planUserMessage(visible) : explainUserMessage(visible);
    calls[kind] += 1;
    try {
      for (let attempt = 0; ; attempt += 1) {
        const body = wire.build({ config, system, user, tool, reminder: attempt > 0 ? reminderText(tool.name) : null });
        const { json, events } = await postJson({ url, headers: wire.headers(apiKey), body, fetchImpl: sendingFetch, timeoutMs, signal, maxRetries, sleep, secrets: [apiKey], provider: providerName }).catch((e) => { for (const ev of e.events ?? []) countEvent(ev); throw e; });
        for (const ev of events) countEvent(ev);
        const r = wire.parse(json); if (r.model) models.add(r.model); lastResponseId = r.id ?? lastResponseId; account(r.usage);
        if (r.incomplete) throw new AdapterError('INCOMPLETE', `${providerName}: the model stopped before finishing (raise maxOutputTokens)`);
        if (r.call && r.call.name === tool.name && r.call.args && typeof r.call.args === 'object' && !Array.isArray(r.call.args)) return r.call.args;   // returned exactly as the model wrote it
        if (attempt >= maxFormatRetries) throw new AdapterError('INVALID_RESPONSE', `${providerName}: no valid ${tool.name} call after ${attempt + 1} attempt(s)`);
        calls.formatRetries += 1;
      }
    } catch (e) { calls.failures += 1; if (e.code === 'PROVIDER_TIMEOUT') calls.timeouts += 1; note(kind, e); throw e; }
  }
  function countEvent(ev) { if (ev.kind === 'rate_limit') calls.rateLimited += 1; else if (ev.kind === 'server_error') calls.serverErrors += 1; }

  return {
    name: providerName,
    plan: (input) => call('plan', input),
    explain: (input) => call('explain', input),
    /** Tokens and cost of the calls since the previous drain (null when there were none). The benchmark reads it after every provider call. */
    drainUsage() { const u = pending; pending = null; return u ? { ...u, costUsd: priced ? Math.round(u.costUsd * 1e8) / 1e8 : null } : null; },
    /** Everything needed to reproduce and interpret the run - no secret (the key is never stored here; the environment variable NAME only). */
    metadata() {
      const own = redact({
        provider: providerName, model: config.model, modelVersion: [...models].length === 1 ? [...models][0] : [...models].join(', ') || null, modelsSeen: [...models], lastResponseId,
        reasoningEffort: config.reasoningEffort, temperature: config.params?.temperature ?? null,
        params: { maxOutputTokens: config.maxOutputTokens ?? null, toolChoice: wire.toolChoiceFor(config), ...(config.params ?? {}) },
        endpoint: url /* exactly the URL that is called */, apiKeyEnv: config.apiKeyEnv, timeoutMs, maxRetries, maxFormatRetries, today: config.today, timeZone: ctx.timeZone,
        pricing: config.pricing ?? null, pricingSource: config.pricingSource ?? null, promptSha256: promptFingerprint(ctx), systemPromptSha256: sha256(system),
        usageTotals: { ...totals, costUsd: priced ? Math.round(totals.costUsd * 1e8) / 1e8 : null }, callCounts: { ...calls }, recentErrors: errors,
      });
      return own;
    },
  };
}

/** Fields the adapter itself controls in the request body: a config `params` entry may never override them. */
export const CONTROLLED_FIELDS = ['model', 'input', 'messages', 'system', 'tools', 'tool_choice', 'reasoning', 'reasoning_effort', 'output_config', 'max_output_tokens', 'max_tokens', 'max_completion_tokens', 'store', 'stream', 'thinking'];
export const CONFIG_KEYS = ['model', 'reasoningEffort', 'apiKeyEnv', 'today', 'timeZone', 'maxOutputTokens', 'timeoutMs', 'maxRetries', 'maxFormatRetries', 'pricing', 'pricingSource', 'params', 'toolChoice', 'baseUrl'];

/**
 * What an adapter declares about itself (read by the preflight, no network): the provider, its ONLY endpoint, the reasoning efforts it accepts, the extra request
 * parameters it supports (anything else in config.params is refused, never silently forwarded or dropped) and the tool-choice modes it can honour.
 */
export function specOf(provider, wire, { supportedParams = [], unsupportedParams = {}, toolChoices = ['forced'] } = {}) {
  const base = new URL(wire.defaultBaseUrl);
  return { provider, allowedHosts: wire.allowedHosts, defaultBaseUrl: wire.defaultBaseUrl, path: wire.path, endpoint: `${base.origin}${base.pathname.replace(/\/$/, '')}${wire.path}`, efforts: wire.efforts, supportedParams, unsupportedParams, toolChoices, controlledFields: CONTROLLED_FIELDS, configKeys: CONFIG_KEYS };
}
