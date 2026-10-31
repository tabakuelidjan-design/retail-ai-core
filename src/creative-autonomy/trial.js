// THE FIRST REAL TRIAL, PREPARED BUT NOT RUN. What Nordla may call, where, for how much, and how it stops.
// Facts below were read on the provider's documentation on 2026-11-01 and are dated: re-verify before the trial (the trial script also asks the provider's own
// free model list, before any paid call, whether the chosen model is served to this workspace).
import { createHash } from 'node:crypto';

export const SCOPE = Object.freeze({ EU: 'EU', GLOBAL: 'GLOBAL' });

/**
 * Germany (Frankfurt), per deployment scope. EU = inference stays in the EU; GLOBAL = "any available node, including Chinese mainland and overseas".
 * Prices: list prices in USD per million tokens, input <= 32k tier, non-thinking output; no free quota in Frankfurt (the 1M free tokens are Singapore only).
 */
export const FRANKFURT_CATALOGUE = Object.freeze({
  verified_at: '2026-11-01',
  sources: [
    'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
    'https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-plus',
    'https://www.alibabacloud.com/help/en/model-studio/context-cache',
    'https://www.alibabacloud.com/help/en/model-studio/germany-frankfurt-global',
    'https://www.alibabacloud.com/help/en/model-studio/data-retention-policy',
  ],
  models: {
    'qwen3.8-max': { scopes: ['GLOBAL'], input: ['text'], usd_in: 1.65, usd_out: 4.951, note: 'flagship; Frankfurt GLOBAL only: inference may run outside the EU' },
    'qwen3.7-plus': { scopes: ['GLOBAL'], input: ['text', 'image', 'video'], usd_in: 0.276, usd_out: 1.101, note: 'multimodal; GLOBAL only' },
    'qwen-plus': { scopes: ['EU', 'GLOBAL'], input: ['text'], usd_in: 0.4, usd_out: 1.2, note: 'EU price; text only: cannot be the visual critic' },
    'qwen3-vl-plus': { scopes: ['EU', 'GLOBAL'], input: ['text', 'image', 'video'], usd_in: 0.2, usd_out: 1.6, note: 'EU price; structured output; thinking switchable; 262k context' },
    'qwen3-vl-flash': { scopes: ['EU', 'GLOBAL'], input: ['text', 'image', 'video'], usd_in: null, usd_out: null, note: 'EU; cheaper, weaker; price not read' },
    'qwen3.8-flash': { scopes: ['UNCONFIRMED'], input: ['text', 'image', 'video'], usd_in: null, usd_out: null, note: 'sources disagree on an EU scope in Frankfurt: not used until the provider model list confirms it' },
  },
  retention: { standard_inference_retention_days_max: 30, zdr: 'enterprise customers only, after assessment: NOT_CONFIRMED for HABB', training_on_api_data: false },
});

export const modelAllowedInScope = (model, scope) => (FRANKFURT_CATALOGUE.models[model]?.scopes ?? []).includes(scope);

export const RECOMMENDED = Object.freeze({ model: 'qwen3-vl-plus', scope: SCOPE.EU, why: 'the only model that is served with EU-only inference in Frankfurt AND reads images, so one model frames, imagines, stages AND critiques the renders' });

export const TRIAL_LIMITS = Object.freeze({
  max_spend_eur: 1.5, // hard: SpendGuard refuses a call whose WORST case would cross it, before anything is sent
  max_text_calls_per_product: 20, // 14 planned + protocol repairs
  max_vision_calls_per_product: 6, // 3 concepts x (1 + up to 1 re-critique)
  max_output_tokens_per_text_call: 4000, // the brain port's cap
  max_output_tokens_per_vision_call: 2200,
  render: { scale: 0.5, samples: 32 }, // 540 x 675 for a 4:5 feed format: enough for a critique, fast on CPU
  products: ['gid://shopify/Product/15514012254556 (variant Noir)', 'gid://shopify/Product/15684480696668'],
  attempts: 1, // the live-call lock: a second attempt needs a human review of the first
});

/** A stable id of what the owner authorises: model, scope, region, limits, products. Changing any of these needs a new authorisation. */
export function trialPlanId({ model, scope, region = 'eu-central-1', limits = TRIAL_LIMITS }) {
  return `trial-${createHash('sha256').update(JSON.stringify({ model, scope, region, limits })).digest('hex').slice(0, 16)}`;
}

/**
 * Cost of a run from measured call sizes. calls: [{ kind: 'TEXT'|'VISION', input_chars, expected_output_chars, images }]
 * Three figures: EXPECTED at the model's list price; WORST at list price with every output at its cap; RESERVED = what the existing SpendGuard books
 * (it prices every call at the qwen3.8-max rate and USD = EUR, i.e. it over-reserves for qwen3-vl-plus: the cap binds earlier than the real spend).
 */
export function forecastCost({ calls, model, imageTokens = 3000, usdToEur = 0.92, reservedPrice = { usd_in: 1.65, usd_out: 4.951 } }) {
  const m = FRANKFURT_CATALOGUE.models[model];
  if (!m?.usd_in) throw new Error(`no verified price for ${model}`);
  let expected = 0; let worst = 0; let reserved = 0; let tokensIn = 0; let tokensOut = 0;
  for (const c of calls) {
    const inTok = Math.ceil(c.input_chars / 4) + (c.images ?? 0) * imageTokens;
    const outTok = Math.ceil(c.expected_output_chars / 4);
    const cap = c.kind === 'VISION' ? TRIAL_LIMITS.max_output_tokens_per_vision_call : TRIAL_LIMITS.max_output_tokens_per_text_call;
    tokensIn += inTok; tokensOut += outTok;
    expected += (inTok * m.usd_in + outTok * m.usd_out) / 1e6;
    worst += (inTok * m.usd_in + cap * m.usd_out) / 1e6;
    reserved += (inTok * reservedPrice.usd_in + cap * reservedPrice.usd_out) / 1e6;
  }
  const eur = (usd) => Math.round(usd * usdToEur * 10000) / 10000;
  return { model, calls: calls.length, tokens_in: tokensIn, tokens_out_expected: tokensOut, expected_eur: eur(expected), worst_case_eur: eur(worst), spendguard_reserved_eur: Math.round(reserved * 10000) / 10000, usd_to_eur: usdToEur };
}
