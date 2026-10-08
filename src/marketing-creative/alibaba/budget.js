export const ALIBABA_PRICE_USD = Object.freeze({
  verified_at: '2026-10-07',
  text_input_per_million: 1.65,
  text_output_per_million: 4.951,
  image_1k: 0.034,
  image_2k: 0.069,
  video_per_second: Object.freeze({
    '480P': 0.041,
    '720P': 0.083,
    '1080P': 0.165,
  }),
});

function imagePriceUsd(size) {
  const normalized = String(size).replace('*', 'x').toLowerCase();
  const [width, height] = normalized.split('x').map(Number);
  return Math.max(width || 0, height || 0) > 1024
    ? ALIBABA_PRICE_USD.image_2k
    : ALIBABA_PRICE_USD.image_1k;
}

export function priceTextEur({ inputTokens = 0, outputTokens = 0, usdToEur = 1 }) {
  const usd = (
    (inputTokens / 1_000_000) * ALIBABA_PRICE_USD.text_input_per_million
    + (outputTokens / 1_000_000) * ALIBABA_PRICE_USD.text_output_per_million
  );
  return usd * usdToEur;
}

export function priceImagesEur({ n = 1, size = '1024x1024', usdToEur = 1 }) {
  return imagePriceUsd(size) * n * usdToEur;
}

export function priceVideoEur({ duration, resolution, usdToEur = 1 }) {
  const price = ALIBABA_PRICE_USD.video_per_second[resolution];
  if (!price) throw new Error('UNPRICED_VIDEO_RESOLUTION');
  return price * duration * usdToEur;
}

export class SpendGuard {
  #reservedEur = 0;
  #settledEur = 0;
  #images = 0;
  #videoSeconds = 0;
  #reservations = new Map();

  constructor({
    maxSpendEur = 1.5,
    maxImages = 3,
    maxVideoSeconds = 5,
    usdToEur = 1,
  } = {}) {
    if (!(maxSpendEur > 0)) throw new TypeError('maxSpendEur must be > 0');
    if (!Number.isInteger(maxImages) || maxImages < 0) {
      throw new TypeError('maxImages must be >= 0');
    }
    if (!Number.isInteger(maxVideoSeconds) || maxVideoSeconds < 0) {
      throw new TypeError('maxVideoSeconds must be >= 0');
    }
    if (!(usdToEur > 0)) throw new TypeError('usdToEur must be > 0');

    this.maxSpendEur = maxSpendEur;
    this.maxImages = maxImages;
    this.maxVideoSeconds = maxVideoSeconds;
    this.usdToEur = usdToEur;
  }

  snapshot() {
    return Object.freeze({
      max_spend_eur: this.maxSpendEur,
      reserved_eur: this.#reservedEur,
      settled_eur: this.#settledEur,
      images: this.#images,
      video_seconds: this.#videoSeconds,
    });
  }

  #reserve({ id, eur, images = 0, videoSeconds = 0 }) {
    if (this.#reservations.has(id)) throw new Error('duplicate budget reservation id');
    if (this.#images + images > this.maxImages) throw new Error('IMAGE_LIMIT_EXCEEDED');
    if (this.#videoSeconds + videoSeconds > this.maxVideoSeconds) {
      throw new Error('VIDEO_SECONDS_LIMIT_EXCEEDED');
    }
    if (this.#reservedEur + this.#settledEur + eur > this.maxSpendEur) {
      throw new Error('BUDGET_EXCEEDED');
    }

    this.#reservedEur += eur;
    this.#images += images;
    this.#videoSeconds += videoSeconds;

    const token = Object.freeze({
      id,
      reserved_eur: eur,
      images,
      video_seconds: videoSeconds,
    });
    this.#reservations.set(id, token);
    return token;
  }

  reserveCost({ id, eur, images = 0, videoSeconds = 0 }) {
    if (!(eur >= 0)) throw new TypeError('eur must be >= 0');
    if (!Number.isInteger(images) || images < 0) throw new TypeError('images must be >= 0');
    if (!Number.isInteger(videoSeconds) || videoSeconds < 0) {
      throw new TypeError('videoSeconds must be >= 0');
    }
    return this.#reserve({ id, eur, images, videoSeconds });
  }

  reserveText({ id, estimatedInputTokens, maxOutputTokens }) {
    return this.#reserve({
      id,
      eur: priceTextEur({
        inputTokens: estimatedInputTokens,
        outputTokens: maxOutputTokens,
        usdToEur: this.usdToEur,
      }),
    });
  }

  reserveImages({ id, n, size = '1024x1024' }) {
    return this.#reserve({
      id,
      eur: priceImagesEur({ n, size, usdToEur: this.usdToEur }),
      images: n,
    });
  }

  reserveVideo({ id, duration, resolution }) {
    return this.#reserve({
      id,
      eur: priceVideoEur({ duration, resolution, usdToEur: this.usdToEur }),
      videoSeconds: duration,
    });
  }

  settle(token, actualEur = null) {
    const current = this.#reservations.get(token?.id);
    if (!current) throw new Error('unknown budget reservation');

    this.#reservedEur -= current.reserved_eur;
    this.#settledEur += actualEur == null ? current.reserved_eur : actualEur;
    this.#reservations.delete(token.id);
    return this.snapshot();
  }

  hold(token) {
    if (!this.#reservations.has(token?.id)) throw new Error('unknown budget reservation');
    return this.snapshot();
  }
}

export function estimateTextInputTokens(...parts) {
  return Math.max(1, Math.ceil(parts.filter(Boolean).join('\n').length / 4));
}
