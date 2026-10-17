// A publisher that publishes NOTHING. For demos and tests only. Every outcome it returns is marked SIMULATION, the post then shows
// "SIMULÉ - rien n'a été publié", and the workflow refuses to ever VERIFY a simulated publication.

import { FORMAT, MODE } from '../constants.js';

export function createSimulatedPublisher(platform, { formats = [FORMAT.IMAGE, FORMAT.REEL, FORMAT.TEXT], nativeScheduling = false, fail = null } = {}) {
  const calls = [];
  let n = 0;
  return {
    platform,
    mode: MODE.SIMULATION,
    calls,
    capabilities: Object.freeze({ formats, native_scheduling: nativeScheduling, image_types: ['image/jpeg', 'image/png'], max_caption: 2200, schedule_min_lead_ms: 15 * 60_000, schedule_max_lead_ms: 28 * 86_400_000 }),
    normalizeError: (e) => ({ code: e?.code ?? 'SIMULATED_ERROR', retryable: Boolean(e?.retryable), unknown: Boolean(e?.unknown), retry_after_ms: null }),
    async verifyConnection() { return { ok: true, display_name: `simulation:${platform}` }; },
    async publish(post, { scheduleAt = null } = {}) {
      calls.push({ op: 'publish', post: post.id, scheduleAt });
      if (fail) throw fail;
      n += 1;
      return scheduleAt
        ? { status: 'SCHEDULED', post_id: `sim_${platform}_${n}`, scheduled_for: scheduleAt }
        : { status: 'PUBLISHED', post_id: `sim_${platform}_${n}`, permalink: null };
    },
    async inspect() { return { exists: false, published: false }; },
    async cancelScheduled(post) { calls.push({ op: 'cancel', post: post.id }); },
  };
}
