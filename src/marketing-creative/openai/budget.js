export const OPENAI_SUNBURST_PRICE_USD_PER_M = Object.freeze({
  verified_at: '2026-10-07',
  text_input: 5,
  image_input: 8,
  output: 30,
});

export function calculateOpenAIImageUsageUsd(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const textInput = usage?.input_tokens_details?.text_tokens;
  const imageInput = usage?.input_tokens_details?.image_tokens;
  const output = usage?.output_tokens;
  if (![textInput, imageInput, output].every(Number.isFinite)) return null;
  return (
    (textInput / 1_000_000) * OPENAI_SUNBURST_PRICE_USD_PER_M.text_input
    + (imageInput / 1_000_000) * OPENAI_SUNBURST_PRICE_USD_PER_M.image_input
    + (output / 1_000_000) * OPENAI_SUNBURST_PRICE_USD_PER_M.output
  );
}

export class OpenAIImageSpendGuard {
  #reserved = 0;
  #calls = 0;

  constructor({ maxSpendUsd = 1, reservePerCallUsd = 1, maxCalls = 1 } = {}) {
    if (!(maxSpendUsd > 0)) throw new TypeError('maxSpendUsd must be > 0');
    if (!(reservePerCallUsd > 0)) throw new TypeError('reservePerCallUsd must be > 0');
    if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new TypeError('maxCalls must be >= 1');
    this.maxSpendUsd = maxSpendUsd;
    this.reservePerCallUsd = reservePerCallUsd;
    this.maxCalls = maxCalls;
  }

  reserve(id) {
    if (this.#calls + 1 > this.maxCalls) throw new Error('OPENAI_CALL_LIMIT_EXCEEDED');
    if (this.#reserved + this.reservePerCallUsd > this.maxSpendUsd) {
      throw new Error('OPENAI_BUDGET_EXCEEDED');
    }
    this.#calls += 1;
    this.#reserved += this.reservePerCallUsd;
    return Object.freeze({ id, reserved_usd: this.reservePerCallUsd });
  }

  settle(token) {
    if (!token || token.reserved_usd !== this.reservePerCallUsd) {
      throw new Error('invalid OpenAI budget reservation');
    }
    this.#reserved -= token.reserved_usd;
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      max_spend_usd: this.maxSpendUsd,
      reserved_usd: this.#reserved,
      calls: this.#calls,
      max_calls: this.maxCalls,
    });
  }
}
