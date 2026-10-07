export const RUNWAY_RECIPE_CREDITS = Object.freeze({
  verified_at: '2026-10-07',
  credit_usd: 0.01,
  product_campaign_image: 144,
  product_ad_720p_4s: 200,
  product_ad_720p_extra_second: 36,
  product_ad_1080p_4s: 216,
  product_ad_1080p_extra_second: 40,
});

export function productAdCredits({ duration = 5, resolution = '720p' } = {}) {
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throw new RangeError('Runway Product Ad duration must be 4-15 seconds');
  }
  const extra = duration - 4;
  if (resolution === '720p') {
    return RUNWAY_RECIPE_CREDITS.product_ad_720p_4s
      + extra * RUNWAY_RECIPE_CREDITS.product_ad_720p_extra_second;
  }
  if (resolution === '1080p') {
    return RUNWAY_RECIPE_CREDITS.product_ad_1080p_4s
      + extra * RUNWAY_RECIPE_CREDITS.product_ad_1080p_extra_second;
  }
  throw new Error('unsupported Runway Product Ad resolution');
}

export class RunwayCreditGuard {
  #reserved = 0;
  #spent = 0;

  constructor({ maxCredits = 400 } = {}) {
    if (!Number.isInteger(maxCredits) || maxCredits < 1) {
      throw new TypeError('maxCredits must be a positive integer');
    }
    this.maxCredits = maxCredits;
  }

  reserve(id, credits) {
    if (!Number.isInteger(credits) || credits < 1) throw new TypeError('credits must be positive');
    if (this.#reserved + this.#spent + credits > this.maxCredits) {
      throw new Error('RUNWAY_CREDIT_LIMIT_EXCEEDED');
    }
    this.#reserved += credits;
    return Object.freeze({ id, credits });
  }

  settle(token) {
    this.#reserved -= token.credits;
    this.#spent += token.credits;
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      max_credits: this.maxCredits,
      reserved_credits: this.#reserved,
      spent_credits: this.#spent,
      spent_usd: this.#spent * RUNWAY_RECIPE_CREDITS.credit_usd,
    });
  }
}
