// The publisher: turns approved, scheduled posts into real publications, exactly once, and reads back what the platform really holds.
//
//   runDue()  one pass: recover dead workers -> finish pending remote cancels -> publish what is due / arm native schedules ->
//             follow platform-held schedules -> verify what was published. Safe to run every minute, from several processes' worth of ticks.
//
// Guarantees (each one is tested):
//   - one publication per post: a durable CAS claim (SCHEDULED -> PUBLISHING) is the only door; a second tick sees PUBLISHING and leaves;
//   - the claim re-checks, in the same atomic write, that the approval covers the CURRENT content hash and that the window is not missed;
//   - the asset is re-fingerprinted against the approved sha256 before any call (ASSET_CHANGED);
//   - a timeout / 5xx on a CREATING call is PUBLICATION_UNKNOWN: never retried, never reported failed, never VERIFIED - the owner reconciles;
//   - a late post is never sent silently: more than MAX_LATE_MS after its time it becomes an ERROR the owner must decide on;
//   - VERIFIED only comes from a live read of the platform (or the owner's attestation for a manual post); a SIMULATION is never verified.

import { randomUUID } from 'node:crypto';
import { redact } from '../activation/validation.js';
import {
  FORMAT, MODE, POST_STATE as S, SocialError,
} from './constants.js';
import { hasValidApproval, transition } from './workflow.js';
import { SYSTEM_ACTOR } from './service.js';

export const PUBLISHER_DEFAULTS = Object.freeze({
  MAX_LATE_MS: 6 * 3600_000, LEASE_MS: 10 * 60_000, MAX_ATTEMPTS: 4, BACKOFF_MS: [60_000, 300_000, 900_000, 3_600_000], VERIFY_EVERY_MS: 10 * 60_000, PLATFORM_GRACE_MS: 2 * 60_000,
});

export function createPublisher({
  service, publishers = {}, media = null, clock = () => Date.now(), logger = () => {}, config = {},
}) {
  const cfg = { ...PUBLISHER_DEFAULTS, nativeScheduling: true, ...config };
  const { store } = service;
  const nowIso = () => new Date(clock()).toISOString();
  const log = (event, post, extra = {}) => logger(redact({ event, post_id: post.id, platform: post.platform, state: post.state, ...extra }));
  const sys = (id, action, params) => store.update(id, (p) => transition(p, action, SYSTEM_ACTOR, { now: nowIso(), ...params }));

  const lateness = (post) => clock() - Math.max(Date.parse(post.publish_at ?? 0), Date.parse(post.publication?.retry_authorized_at ?? 0) || 0);
  const notBefore = (post) => Date.parse(post.publication?.next_attempt_at ?? 0) || 0;

  /** Atomically claim a SCHEDULED post. Returns the claimed post, or null when someone else holds it / it is no longer eligible. */
  async function claim(id, { native = false } = {}) {
    const claimId = randomUUID();
    let verdict = null;
    const after = await store.update(id, (p) => {
      if (p.state !== S.SCHEDULED || p.publication?.platform_schedule || p.publication?.remote_cancel_pending) { verdict = 'NOT_ELIGIBLE'; return p; }
      if (!hasValidApproval(p)) { verdict = 'NO_VALID_APPROVAL'; return transition(p, 'mark_error', SYSTEM_ACTOR, { now: nowIso(), code: 'NO_VALID_APPROVAL' }); }
      if (!native) {
        if (clock() < Date.parse(p.publish_at ?? 0) || clock() < notBefore(p)) { verdict = 'NOT_DUE'; return p; }
        if (lateness(p) > cfg.MAX_LATE_MS) { verdict = 'MISSED_WINDOW'; return transition(p, 'mark_error', SYSTEM_ACTOR, { now: nowIso(), code: 'MISSED_WINDOW' }); }
      }
      verdict = 'CLAIMED';
      return transition(p, 'claim', SYSTEM_ACTOR, { now: nowIso(), claim_id: claimId });
    });
    if (verdict !== 'CLAIMED' || after.publication?.claim_id !== claimId) { if (verdict && verdict !== 'NOT_ELIGIBLE' && verdict !== 'NOT_DUE') log('post.not_published', after, { code: verdict }); return null; }
    return after;
  }

  async function failure(post, publisher, error) {
    const n = publisher.normalizeError(error);
    if (n.unknown) { log('post.unknown', post, { code: n.code }); return sys(post.id, 'mark_unknown', { code: n.code }); }
    if (n.code === 'AUTH_INVALID') return sys(post.id, 'mark_error', { code: 'RECONNECT_REQUIRED' });
    if (n.retryable) {
      const attempts = post.publication?.attempts ?? 1;
      if (attempts >= cfg.MAX_ATTEMPTS) return sys(post.id, 'mark_error', { code: 'RETRIES_EXHAUSTED' });
      const wait = Math.max(cfg.BACKOFF_MS[Math.min(attempts - 1, cfg.BACKOFF_MS.length - 1)], n.retry_after_ms ?? 0);
      log('post.retry_later', post, { code: n.code, wait_ms: wait });
      return sys(post.id, 'retry_later', { code: n.code, next_attempt_at: new Date(clock() + wait).toISOString() });
    }
    log('post.error', post, { code: n.code });
    return sys(post.id, 'mark_error', { code: n.code });
  }

  /** Publish now, or hand the post to the platform's own scheduler (scheduleAt). One claimed attempt. */
  async function publishOne(id, { scheduleAt = null } = {}) {
    const claimed = await claim(id, { native: Boolean(scheduleAt) });
    if (!claimed) return null;
    const publisher = publishers[claimed.platform];
    if (!publisher) return sys(id, 'retry_later', { code: 'NO_PUBLISHER', next_attempt_at: new Date(clock() + 3600_000).toISOString() });
    // Only the provider-facing part is inside the try: a failure to RECORD an outcome must never be mistaken for a failed publication
    // (it would be retried and duplicate). If recording fails after a successful call the post stays PUBLISHING: recoverStale makes it UNKNOWN.
    let stopCode = null;
    let result = null;
    try {
      let mediaInfo = null;
      if (claimed.format !== FORMAT.TEXT) {
        if (!media) stopCode = 'MEDIA_TRANSPORT_MISSING';
        else {
          mediaInfo = await media.resolve(claimed.asset);
          // what is served must be exactly what was approved
          if (mediaInfo.sha256 !== claimed.asset.sha256 || mediaInfo.content_type !== claimed.asset.content_type) stopCode = 'ASSET_CHANGED';
        }
      }
      if (!stopCode) {
        const live = await publisher.verifyConnection();
        if (!live.ok) stopCode = `CONNECTION_${live.reason ?? 'NOT_OK'}`;
        else {
          result = await publisher.publish(claimed, {
            media: mediaInfo,
            scheduleAt,
            onProgress: (progress) => sys(id, 'annotate', { note: 'platform container created', publication: { submission_id: progress.submission_id }, detail: { progress: 'CONTAINER_CREATED' } }),
          });
        }
      }
    } catch (error) {
      return failure(claimed, publisher, error);
    }
    if (stopCode) return sys(id, 'mark_error', { code: stopCode });
    if (result.status === 'PUBLISHED') {
      log('post.published', claimed, { mode: publisher.mode });
      return sys(id, 'mark_published', { mode: publisher.mode, submission_id: result.submission_id, post_id: result.post_id, permalink: result.permalink ?? null });
    }
    if (result.status === 'SCHEDULED') {
      log('post.platform_scheduled', claimed, { mode: publisher.mode, scheduled_for: result.scheduled_for });
      return sys(id, 'platform_scheduled', { mode: publisher.mode, post_id: result.post_id, scheduled_for: result.scheduled_for });
    }
    // PROCESSING: a container exists at the platform. Keep its id so the next pass RESUMES it instead of creating a second one.
    return sys(id, 'retry_later', { code: 'PROCESSING', submission_id: result.submission_id, next_attempt_at: new Date(clock() + 30_000).toISOString() });
  }

  async function recoverStale() {
    for (const p of await store.list()) {
      if (p.state !== S.PUBLISHING) continue;
      if (clock() - Date.parse(p.publication?.claimed_at ?? 0) < cfg.LEASE_MS) continue;
      if (p.publication?.submission_id) await sys(p.id, 'retry_later', { code: 'WORKER_RESTARTED', next_attempt_at: nowIso() }); // a container exists: safe to resume
      else await sys(p.id, 'mark_unknown', { code: 'WORKER_DIED_MID_CALL' }); // a creating call may have gone out: the owner reconciles
    }
  }

  /** A copy held by the platform (Facebook scheduled natively): did it publish? did it vanish? */
  async function followPlatformSchedule(p) {
    const publisher = publishers[p.platform];
    if (!publisher) return;
    const due = Date.parse(p.publication.platform_schedule.scheduled_for) + cfg.PLATFORM_GRACE_MS;
    if (clock() < due) return;
    let seen;
    try { seen = await publisher.inspect({ ...p, publication: { ...p.publication, post_id: p.publication.platform_schedule.post_id } }); } catch { return; }
    if (seen.exists && seen.published) {
      await sys(p.id, 'mark_published', { mode: publisher.mode, post_id: p.publication.platform_schedule.post_id, permalink: seen.permalink ?? null, published_at: p.publication.platform_schedule.scheduled_for });
    } else if (!seen.exists) {
      await sys(p.id, 'annotate', { note: 'the platform no longer holds the scheduled copy', detail: { alert: 'PLATFORM_SCHEDULE_MISSING' } });
    }
  }

  async function verifyOne(p) {
    const publisher = publishers[p.platform];
    if (!publisher || publisher.mode !== MODE.LIVE || p.publication?.mode !== MODE.LIVE) return false; // simulation and manual posts are never verified by a machine
    if (clock() - Date.parse(p.publication.last_verify_at ?? 0) < cfg.VERIFY_EVERY_MS) return false;
    let seen;
    try { seen = await publisher.inspect(p); } catch (error) { log('post.verify_error', p, { code: publisher.normalizeError(error).code }); return false; }
    if (seen.exists && seen.published) {
      await sys(p.id, 'mark_verified', { mode: MODE.LIVE, permalink: seen.permalink ?? null, evidence: { checked_at: nowIso(), platform_post_id: p.publication.post_id } });
      return true;
    }
    await sys(p.id, 'annotate', { note: 'verification: the platform does not show this post', detail: { alert: 'VERIFICATION_FAILED' }, publication: { last_verify_at: nowIso() } });
    return false;
  }

  async function runDue() {
    const done = { published: 0, armed: 0, verified: 0, skipped: 0 };
    await recoverStale();
    for (const p of await store.list()) if (p.publication?.remote_cancel_pending) await service.settleRemoteCancel(p.id);
    for (const p of await store.list()) {
      try {
        if (p.state === S.SCHEDULED) {
          const publisher = publishers[p.platform];
          if (p.publication?.platform_schedule) { await followPlatformSchedule(p); continue; }
          if (p.publication?.remote_cancel_pending || !publisher) { done.skipped += 1; continue; }
          const lead = Date.parse(p.publish_at) - clock();
          const caps = publisher.capabilities;
          if (cfg.nativeScheduling && caps.native_scheduling && lead >= caps.schedule_min_lead_ms && lead <= caps.schedule_max_lead_ms) {
            const r = await publishOne(p.id, { scheduleAt: p.publish_at });
            if (r?.state === S.SCHEDULED && r.publication?.platform_schedule) done.armed += 1;
          } else if (lead <= 0) {
            const r = await publishOne(p.id);
            if (r?.state === S.PUBLISHED) done.published += 1;
          }
        } else if (p.state === S.PUBLISHED) {
          if (await verifyOne(p)) done.verified += 1;
        }
      } catch (error) { log('post.pass_error', p, { error: error.code ?? error.name }); }
    }
    return done;
  }

  return { runDue, publishOne, recoverStale, verifyOne, config: cfg };
}
