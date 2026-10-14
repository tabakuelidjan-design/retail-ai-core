// Nordla HTTP security (Core C4) - time normalisation of login refusals.
//
// Every public LOGIN_FAILED answer (invalid / unknown address, wrong password, no or suspended membership, module absent or
// suspended) is held until at least `minMs` + a random jitter (crypto.randomInt, 0..jitterMs) have elapsed since the attempt
// started, measured with a MONOTONIC clock (performance.now). The wait is an asynchronous timer: nothing blocks the event loop.
// Successful logins, RATE_LIMITED and UNAVAILABLE are not padded (they reveal nothing about the account).
//
// Honest limits: this REDUCES the timing channel, it does not make every path take exactly the same time (a path slower than the
// floor still shows through, and network noise varies). minMs must be calibrated against the real Supabase Auth latency on
// staging so that the floor stays above the slowest refusal path.

import { randomInt as cryptoRandomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/**
 * @param {{ minMs: number, jitterMs: number, now?: () => number, sleep?: (ms: number) => Promise<void>, randomInt?: (min: number, max: number) => number }} cfg
 */
export function createLoginTiming({ minMs, jitterMs, now = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), randomInt = cryptoRandomInt }) {
  /**
   * Runs one login attempt and, when its public answer is LOGIN_FAILED, waits until the floor is reached.
   * @template T
   * @param {() => Promise<T>} attempt
   * @returns {Promise<T>}
   */
  async function normalize(attempt) {
    const started = now();
    const result = await attempt();
    if (result && result.ok === false && result.error === 'LOGIN_FAILED') {
      const target = minMs + (jitterMs > 0 ? randomInt(0, jitterMs + 1) : 0);
      const elapsed = now() - started;
      if (elapsed < target) await sleep(target - elapsed);
    }
    return result;
  }
  return Object.freeze({ normalize, minMs, jitterMs });
}
