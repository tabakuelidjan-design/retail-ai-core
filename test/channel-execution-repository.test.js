import test from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../src/activation/index.js';
import {
  IDS, M1, M2, NOW, TOKENS, advance, createFakeHttp, createJobStore, igRoutes, imageDelivery, jobOf, orderOf, runtime, textDelivery, world, gbpRoutes, ttRoutes,
} from './channel-fixtures.js';

const W = world();
const code = (fn) => { try { fn(); } catch (error) { return error.code; } return assert.fail('expected an error'); };
const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected an error'); };
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const ORDER = orderOf(W);
const drafts = () => A.planChannelExecutionJobs({ order: ORDER, manifest: W.activationManifest, candidates: W.candidates });
const fresh = () => { const store = createJobStore(); return { store, repo: A.createChannelExecutionRepository({ supabase: store }), drafts: drafts() }; };
const resp = (status, body = {}, headers = {}) => ({ status, headers, body });

// ------------------------------------------------------------------ outbox / idempotency (59-64)

test('Outbox: enqueue once, the same intent is idempotent, a changed fingerprint conflicts, a race is protected, jobs are tenant and connector scoped', async () => {
  const { repo, store, drafts: [draft, other] } = fresh();
  const first = await repo.enqueue(draft); // 59
  assert.deepEqual([first.created, first.job.state, first.job.attempt_count], [true, 'PLANNED', 0]);
  assert.equal(store._rows.length, 1);
  const again = await repo.enqueue(draft); // 60
  assert.deepEqual([again.created, again.job.id], [false, first.job.id]);
  assert.equal(store._rows.length, 1);
  assert.equal(await acode(repo.enqueue({ ...draft, request_fingerprint: 'acf_changed' })), 'ACT_IDEMPOTENCY_CONFLICT'); // 61
  // 62: two enqueues race - the second does not see the row on its first read, loses on the UNIQUE constraint, and settles on the first job
  const racing = createJobStore(); const racingRepo = A.createChannelExecutionRepository({ supabase: racing });
  await racingRepo.enqueue(draft);
  let hidden = true; const realSelect = racing.select.bind(racing);
  racing.select = async (...args) => { if (hidden) { hidden = false; return []; } return realSelect(...args); };
  const raced = await racingRepo.enqueue(draft);
  assert.deepEqual([raced.created, racing._rows.length], [false, 1]);
  assert.equal(await racingRepo.getByIdempotencyKey(M2, draft.idempotency_key), null); // 63
  assert.equal((await racingRepo.getByIdempotencyKey(M1, draft.idempotency_key)).id, racing._rows[0].id);
  assert.equal(await acode(racingRepo.enqueue({ ...other, merchant_id: M2 })), 'ACT_STORE_FAILED'); // a connector of M1 can never carry an M2 job
  const second = await repo.enqueue({ ...draft, connector_id: IDS.GBP, idempotency_key: 'acj_other_connector' }); // 64
  assert.equal(second.created, true);
  assert.equal(store._rows.length, 2);
  assert.notEqual(second.job.id, first.job.id);
  assert.ok(first.job.idempotency_key.startsWith('acj_'));
});

// ------------------------------------------------------------------ state machine (65-75)

test('Job state machine: every legal transition works, terminal states are final, a published job is never retried or cancelled', async () => {
  const { repo, drafts: [d1, d2] } = fresh();
  const { job } = await repo.enqueue(d1);
  const ready = await repo.markReady(M1, job.id, { nowIso: NOW }); // 65
  assert.equal(ready.state, 'READY');
  const claimed = await repo.claim(M1, job.id, { nowIso: NOW }); // 66
  assert.deepEqual([claimed.state, claimed.attempt_count], ['SUBMITTING', 1]);
  const processing = await repo.markProcessing(M1, job.id, { providerSubmissionId: 'sub-1', nowIso: NOW }); // 67
  assert.deepEqual([processing.state, processing.provider_submission_id], ['PROCESSING', 'sub-1']);
  const published = await repo.markPublished(M1, job.id, { providerPostIds: ['post-1'], publishedAt: NOW, nowIso: NOW }); // 69
  assert.deepEqual([published.state, [...published.provider_post_ids]], ['PUBLISHED', ['post-1']]);
  const { job: direct } = await repo.enqueue(d2);
  await repo.markReady(M1, direct.id, { nowIso: NOW });
  await repo.claim(M1, direct.id, { nowIso: NOW });
  assert.equal((await repo.markPublished(M1, direct.id, { providerPostIds: ['post-2'], publishedAt: NOW, nowIso: NOW })).state, 'PUBLISHED'); // 68
  // 73, 74, 75: terminal states
  assert.equal(await repo.claim(M1, job.id, { nowIso: NOW }), null); // published: not retried
  assert.equal(await acode(repo.markFinalFailure(M1, job.id, { errorCode: 'X', nowIso: NOW })), 'ACT_JOB_INVALID_TRANSITION');
  assert.equal(await acode(repo.cancelBeforeSubmission(M1, job.id, { nowIso: NOW })), 'ACT_JOB_INVALID_TRANSITION'); // 74
  assert.equal(await acode(repo.markReady(M1, job.id, { nowIso: NOW })), 'ACT_JOB_INVALID_TRANSITION');
  assert.equal(code(() => A.assertTransition('PUBLISHED', 'READY')), 'ACT_JOB_INVALID_TRANSITION');
  assert.equal(code(() => A.assertTransition('PUBLISHED', 'CANCELLED')), 'ACT_JOB_INVALID_TRANSITION');
  assert.equal(code(() => A.assertTransition('FAILED_FINAL', 'READY')), 'ACT_JOB_INVALID_TRANSITION'); // 75
  for (const terminal of ['PUBLISHED', 'FAILED_FINAL', 'CANCELLED']) assert.ok(A.isTerminalState(terminal) && A.JOB_TRANSITIONS[terminal].length === 0);
});

test('Job failures and cancellation: retryable and final failures, cancel only before anything reached the provider', async () => {
  const { repo, drafts: [d1, d2] } = fresh();
  const a = (await repo.enqueue(d1)).job;
  await repo.markReady(M1, a.id, { nowIso: NOW });
  await repo.claim(M1, a.id, { nowIso: NOW });
  const retryable = await repo.markRetryableFailure(M1, a.id, { errorCode: 'RATE_LIMITED', nextAttemptAt: '2026-10-13T09:05:00Z', nowIso: NOW }); // 70
  assert.deepEqual([retryable.state, retryable.last_error_code, retryable.last_error_class], ['FAILED_RETRYABLE', 'RATE_LIMITED', 'RETRYABLE']);
  assert.equal(await repo.claim(M1, a.id, { nowIso: NOW }), null); // not due yet
  const retry = await repo.claim(M1, a.id, { nowIso: '2026-10-13T09:05:00Z' });
  assert.deepEqual([retry.state, retry.attempt_count], ['SUBMITTING', 2]); // 78: the attempt count grows with every claim
  const final = await repo.markFinalFailure(M1, a.id, { errorCode: 'MEDIA_INVALID', nowIso: NOW }); // 71
  assert.deepEqual([final.state, final.last_error_class], ['FAILED_FINAL', 'FINAL']);
  assert.equal(await repo.claim(M1, a.id, { nowIso: '2027-01-01T00:00:00Z' }), null);
  const b = (await repo.enqueue(d2)).job;
  assert.equal((await repo.cancelBeforeSubmission(M1, b.id, { nowIso: NOW })).state, 'CANCELLED'); // 72: PLANNED
  const c = (await repo.enqueue({ ...d2, connector_id: IDS.GBP, idempotency_key: 'acj_c', manifest_delivery_ref: 'mdl_c' })).job;
  await repo.markReady(M1, c.id, { nowIso: NOW });
  assert.equal((await repo.cancelBeforeSubmission(M1, c.id, { nowIso: NOW })).state, 'CANCELLED'); // READY
  const d = (await repo.enqueue({ ...d2, connector_id: IDS.GBP, idempotency_key: 'acj_d', manifest_delivery_ref: 'mdl_d' })).job;
  await repo.markReady(M1, d.id, { nowIso: NOW });
  await repo.claim(M1, d.id, { nowIso: NOW });
  assert.equal(await acode(repo.cancelBeforeSubmission(M1, d.id, { nowIso: NOW })), 'ACT_JOB_INVALID_TRANSITION'); // SUBMITTING: too late
  const e = (await repo.enqueue({ ...d2, connector_id: IDS.GBP, idempotency_key: 'acj_e', manifest_delivery_ref: 'mdl_e' })).job;
  assert.equal(await acode(repo.markProcessing(M1, e.id, { providerSubmissionId: 's', nowIso: NOW })), 'ACT_JOB_INVALID_TRANSITION'); // PLANNED -> PROCESSING is not a transition
});

// ------------------------------------------------------------------ claim (76-78)

test('Atomic claim: only one worker wins a job, even concurrently, and attempts increment', async () => {
  const rt = await runtime(W);
  const job = jobOf(rt, 'instagram');
  const [one, two] = await Promise.all([rt.repo.claim(M1, job.id, { nowIso: NOW }), rt.repo.claim(M1, job.id, { nowIso: NOW })]); // 76, 77
  assert.deepEqual([one, two].filter(Boolean).length, 1);
  assert.equal(jobOf(rt, 'instagram').attempt_count, 1);
  const other = jobOf(rt, 'google_business_profile');
  const results = await Promise.all([rt.executor.executeJob(other), rt.executor.executeJob(other)]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ['PUBLISHED', 'SKIPPED']);
  assert.equal(rt.svc.http.raw.filter((r) => r.method === 'POST' && r.url.includes('/localPosts')).length, 1); // one external call for two workers
  const polls = await rt.repo.markProcessing(M1, job.id, { providerSubmissionId: 'sub', nowIso: NOW });
  advance(rt, 120_000);
  const [p1, p2] = await Promise.all([rt.repo.claimPoll(M1, polls.id, { nowIso: new Date(rt.clock.t).toISOString() }), rt.repo.claimPoll(M1, polls.id, { nowIso: new Date(rt.clock.t).toISOString() })]);
  assert.equal([p1, p2].filter(Boolean).length, 1); // one poller too
});

// ------------------------------------------------------------------ retry policy (79-81)

test('Retry policy: deterministic backoff 1m 5m 15m 60m, Retry-After wins when later, never past the deadline, exhausted after five attempts', () => {
  const deadline = '2026-10-15T00:00:00Z';
  const at = (attempt, extra = {}) => A.decideRetry({ attemptCount: attempt, nowIso: NOW, deadlineAt: deadline, ...extra });
  assert.deepEqual([1, 2, 3, 4].map((n) => at(n).next_attempt_at), ['2026-10-13T09:01:00.000Z', '2026-10-13T09:05:00.000Z', '2026-10-13T09:15:00.000Z', '2026-10-13T10:00:00.000Z']); // 79
  assert.deepEqual(at(5), { retry: false, reason: 'RETRIES_EXHAUSTED' });
  assert.equal(at(1, { retryAfterMs: 2 * 3_600_000 }).next_attempt_at, '2026-10-13T11:00:00.000Z'); // 80
  assert.equal(at(1, { retryAfterMs: 1000 }).next_attempt_at, '2026-10-13T09:01:00.000Z'); // a shorter Retry-After never speeds it up
  assert.deepEqual(A.decideRetry({ attemptCount: 1, nowIso: deadline, deadlineAt: deadline }), { retry: false, reason: 'DEADLINE_PASSED' }); // 81
  assert.deepEqual(A.decideRetry({ attemptCount: 1, nowIso: '2026-10-14T23:59:30Z', deadlineAt: deadline }), { retry: false, reason: 'DEADLINE_PASSED' });
  assert.equal(A.parseRetryAfter({ 'retry-after': '120' }), 120_000);
  assert.equal(A.parseRetryAfter({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, Date.parse('2026-10-21T07:27:00Z')), 60_000);
  assert.equal(A.parseRetryAfter({}), null);
});

test('Provider errors: only transient failures are retried, never a permanent 4xx, an auth failure or a changed deadline', async () => {
  const igFail = (status, extra = {}) => [{ method: 'POST', url: '/17841400000000001/media', respond: resp(status, { error: { code: extra.code, message: 'x' } }, extra.headers) }, ...igRoutes().filter((r) => !(r.method === 'POST' && r.url.endsWith('/media')))];
  const only = (deliveries) => ({ deliveries });
  const permanent = await runtime(W, { routes: [...igFail(400), ...ttRoutes(), ...gbpRoutes()], ...only([imageDelivery(W), textDelivery(W)]) }); // 82
  await permanent.executor.runDueJobs({ merchantId: M1 });
  assert.deepEqual([jobOf(permanent, 'instagram').state, jobOf(permanent, 'instagram').last_error_code], ['FAILED_FINAL', 'INVALID_PAYLOAD']);
  advance(permanent, 3_600_000);
  const before = permanent.svc.http.raw.length;
  await permanent.executor.runDueJobs({ merchantId: M1 });
  assert.equal(permanent.svc.http.raw.length, before); // a final failure is never retried
  const limited = await runtime(W, { routes: [{ method: 'POST', url: '/17841400000000001/media', respond: (_r, n) => (n === 1 ? resp(429, {}, { 'Retry-After': '120' }) : resp(200, { id: 'container-1' })) }, ...igRoutes().filter((r) => !(r.method === 'POST' && r.url.endsWith('/media'))), ...ttRoutes(), ...gbpRoutes()] }); // 83
  await limited.executor.runDueJobs({ merchantId: M1 });
  const row = jobOf(limited, 'instagram');
  assert.deepEqual([row.state, row.last_error_code, row.attempt_count], ['FAILED_RETRYABLE', 'RATE_LIMITED', 1]);
  assert.equal(row.next_attempt_at, new Date(Date.parse(NOW) + 120_000).toISOString()); // Retry-After (120s) is later than the 60s backoff
  advance(limited, 119_000);
  await limited.executor.runDueJobs({ merchantId: M1 });
  assert.equal(jobOf(limited, 'instagram').state, 'FAILED_RETRYABLE'); // not due yet
  advance(limited, 2_000);
  await limited.executor.runDueJobs({ merchantId: M1 });
  assert.deepEqual([jobOf(limited, 'instagram').state, jobOf(limited, 'instagram').attempt_count], ['PROCESSING', 2]);
  const flaky = await runtime(W, { routes: [{ method: 'POST', url: '/17841400000000001/media', respond: (_r, n) => (n === 1 ? resp(503) : resp(200, { id: 'container-1' })) }, ...igRoutes().filter((r) => !(r.method === 'POST' && r.url.endsWith('/media'))), ...ttRoutes(), ...gbpRoutes()] }); // 84
  await flaky.executor.runDueJobs({ merchantId: M1 });
  assert.deepEqual([jobOf(flaky, 'instagram').state, jobOf(flaky, 'instagram').last_error_code], ['FAILED_RETRYABLE', 'PROVIDER_UNAVAILABLE']);
  const slow = await runtime(W, { timeoutMs: 20, routes: [{ method: 'POST', url: '/17841400000000001/media', respond: () => new Promise(() => {}) }, ...igRoutes().filter((r) => !(r.method === 'POST' && r.url.endsWith('/media'))), ...ttRoutes(), ...gbpRoutes()] }); // 85
  await slow.executor.runDueJobs({ merchantId: M1 });
  assert.deepEqual([jobOf(slow, 'instagram').state, jobOf(slow, 'instagram').last_error_code], ['FAILED_RETRYABLE', 'TIMEOUT']);
  const hung = await runtime(W, { timeoutMs: 20, routes: [{ method: 'POST', url: '/localPosts', respond: () => new Promise(() => {}) }, ...igRoutes(), ...ttRoutes()] }); // a creating call that timed out may have created the post
  await hung.executor.runDueJobs({ merchantId: M1 });
  assert.deepEqual([jobOf(hung, 'google_business_profile').state, jobOf(hung, 'google_business_profile').last_error_code], ['SUBMISSION_UNKNOWN', 'SUBMISSION_OUTCOME_UNKNOWN']);
  const auth = await runtime(W, { routes: [...igFail(401, { code: 190 }), ...ttRoutes(), ...gbpRoutes()] }); // 86
  await auth.executor.runDueJobs({ merchantId: M1 });
  assert.deepEqual([jobOf(auth, 'instagram').state, jobOf(auth, 'instagram').last_error_code], ['FAILED_FINAL', 'AUTH_INVALID']);
  const late = await runtime(W, { routes: [{ method: 'POST', url: '/17841400000000001/media', respond: resp(503) }, ...igRoutes().filter((r) => !(r.method === 'POST' && r.url.endsWith('/media'))), ...ttRoutes(), ...gbpRoutes()] }); // 81
  await late.executor.runDueJobs({ merchantId: M1 });
  assert.equal(jobOf(late, 'instagram').state, 'FAILED_RETRYABLE');
  late.clock.t = Date.parse('2026-10-15T00:00:01Z'); // the order (and with it the retry window) has expired
  await late.executor.runDueJobs({ merchantId: M1 });
  assert.equal(jobOf(late, 'instagram').state, 'FAILED_FINAL');
  assert.equal(jobOf(late, 'instagram').last_error_code, 'STALE_ORDER');
  assert.deepEqual(A.RETRYABLE_PROVIDER_ERRORS, ['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'PROCESSING_TRANSIENT']);
});

// ------------------------------------------------------------------ outputs (87-88)

test('Outbox outputs are frozen and the persisted rows carry no secret', async () => {
  const rt = await runtime(W);
  const job = await rt.repo.getById(M1, jobOf(rt, 'instagram').id);
  assert.ok(isDeepFrozen(job)); // 87
  assert.ok(isDeepFrozen(await rt.repo.listDue({ merchantId: M1, nowIso: NOW })));
  assert.ok(isDeepFrozen(A.planChannelExecutionJobs({ order: ORDER, manifest: W.activationManifest, candidates: W.candidates })));
  await rt.executor.runDueJobs({ merchantId: M1 });
  advance(rt, 120_000);
  await rt.executor.runDueJobs({ merchantId: M1 });
  const stored = JSON.stringify(rt.store._rows); // 88
  for (const token of Object.values(TOKENS)) assert.ok(!stored.includes(token));
  assert.doesNotMatch(stored, /SIGNEDSECRET|Bearer|access_token|https?:\/\//);
  assert.deepEqual(A.findSecretLeaks(rt.store._rows), []);
  assert.deepEqual(Object.keys(rt.store._rows[0]).filter((k) => /token|secret|password|credential|url/i.test(k)), []);
  const nobody = createFakeHttp([]); assert.equal(nobody.raw.length, 0);
});

test('Stale worker recovery: a job claimed by a dead worker is never resubmitted blindly', async () => {
  const rt = await runtime(W);
  const job = jobOf(rt, 'google_business_profile');
  await rt.repo.claim(M1, job.id, { nowIso: NOW }); // the worker dies right here
  advance(rt, 20 * 60_000);
  const recovered = await rt.executor.recoverStale({ merchantId: M1 });
  assert.deepEqual(recovered.map((j) => [j.state, j.last_error_code]), [['SUBMISSION_UNKNOWN', 'SUBMISSION_STATE_UNKNOWN']]);
  assert.equal(rt.svc.http.raw.filter((r) => r.method === 'POST').length, 0);
  assert.equal(M2.length > 0, true);
});

test('Ambiguous submission: a timeout after a creating call is SUBMISSION_UNKNOWN - no retry, no receipt, no failure claim, never a fresh post for the same intent', async () => {
  const never = () => new Promise(() => {});
  const hung = await runtime(W, { timeoutMs: 20, routes: [{ method: 'POST', url: '/localPosts', respond: never }, ...igRoutes(), ...ttRoutes()] });
  await hung.executor.runDueJobs({ merchantId: M1 });
  const row = jobOf(hung, 'google_business_profile'); // 215
  assert.deepEqual([row.state, row.last_error_code, row.last_error_class], ['SUBMISSION_UNKNOWN', 'SUBMISSION_OUTCOME_UNKNOWN', 'AMBIGUOUS']);
  assert.ok(!['FAILED_FINAL', 'FAILED_RETRYABLE'].includes(row.state)); // 217: it is not claimed to have failed
  const posts = () => hung.svc.http.raw.filter((r) => r.method === 'POST' && r.url.includes('/localPosts')).length;
  assert.equal(posts(), 1);
  advance(hung, 24 * 3_600_000); // 216: no blind retry, however long we wait
  await hung.executor.runDueJobs({ merchantId: M1 });
  assert.deepEqual([posts(), jobOf(hung, 'google_business_profile').attempt_count, jobOf(hung, 'google_business_profile').state], [1, 1, 'SUBMISSION_UNKNOWN']);
  assert.equal(await hung.repo.claim(M1, row.id, { nowIso: new Date(hung.clock.t).toISOString() }), null);
  assert.equal(code(() => A.buildChannelPublicationReceipt(jobOf(hung, 'google_business_profile'))), 'ACT_RECEIPT_NOT_PUBLISHED'); // 218
  assert.equal(code(() => A.buildChannelPublicationReceipt({ ...jobOf(hung, 'google_business_profile'), provider_submission_id: 'guess', published_at: NOW })), 'ACT_RECEIPT_NOT_PUBLISHED');
  // 219: the same logical intent is never a fresh post - enqueue returns the same halted job, and no new call is made
  const again = await hung.executor.enqueueChannelExecutionOrder({ ...hung.input, asOf: new Date(hung.clock.t - 24 * 3_600_000 + 60_000).toISOString() });
  const entry = again.jobs.find((j) => j.job?.id === row.id);
  assert.deepEqual([entry.status, entry.reason_codes, entry.job.state], ['RECONCILIATION_REQUIRED', ['RECONCILIATION_REQUIRED'], 'SUBMISSION_UNKNOWN']);
  assert.equal(hung.store._rows.filter((r) => r.provider === 'google_business_profile').length, 1);
  const enqueued = await hung.repo.enqueue(A.planChannelExecutionJobs({ order: hung.order, manifest: W.activationManifest, candidates: W.candidates })[1]);
  assert.deepEqual([enqueued.created, enqueued.job.state], [false, 'SUBMISSION_UNKNOWN']);
  assert.equal(posts(), 1);
  // 220: only an explicit reconciliation, with its evidence reference, leaves the state
  const at = new Date(hung.clock.t).toISOString();
  assert.equal(code(() => A.assertTransition('SUBMISSION_UNKNOWN', 'READY')), 'ACT_JOB_INVALID_TRANSITION');
  assert.equal(code(() => A.assertTransition('SUBMISSION_UNKNOWN', 'FAILED_RETRYABLE')), 'ACT_JOB_INVALID_TRANSITION');
  assert.ok(A.WORKER_HALTED_STATES.includes('SUBMISSION_UNKNOWN'));
  assert.equal(await acode(hung.repo.reconcilePublished(M1, row.id, { providerPostIds: ['p'], publishedAt: at, nowIso: at })), 'ACT_RECONCILIATION_REF_REQUIRED');
  assert.equal(await acode(hung.repo.reconcilePublished(M1, row.id, { reconciliationRef: 'reconciliation://operator-1', publishedAt: at, nowIso: at })), 'ACT_RECEIPT_PROVIDER_REF_REQUIRED');
  assert.equal(await acode(hung.repo.reconcileNotPublished(M1, row.id, { nowIso: at })), 'ACT_RECONCILIATION_REF_REQUIRED');
  const reconciled = await hung.repo.reconcilePublished(M1, row.id, { reconciliationRef: 'reconciliation://operator-1', providerPostIds: ['accounts/111/locations/222/localPosts/9'], publishedAt: at, nowIso: at });
  assert.deepEqual([reconciled.state, reconciled.reconciliation_ref], ['PUBLISHED', 'reconciliation://operator-1']);
  assert.equal(A.buildChannelPublicationReceipt(reconciled).provider_post_ids.length, 1); // a receipt exists only AFTER the reconciliation proved the publication
  const verified = await runtime(W, { timeoutMs: 20, routes: [{ method: 'POST', url: '/localPosts', respond: never }, ...igRoutes(), ...ttRoutes()] });
  await verified.executor.runDueJobs({ merchantId: M1 });
  const none = await verified.repo.reconcileNotPublished(M1, jobOf(verified, 'google_business_profile').id, { reconciliationRef: 'reconciliation://operator-2', nowIso: NOW });
  assert.deepEqual([none.state, none.last_error_code], ['FAILED_FINAL', 'RECONCILED_NOT_PUBLISHED']);
  const stillSame = await verified.executor.enqueueChannelExecutionOrder({ ...verified.input, asOf: NOW });
  assert.equal(stillSame.jobs.find((j) => j.job?.id === none.id).job.state, 'FAILED_FINAL'); // even verified "not published", the same intent does not become a new post
  // 221: Instagram - a container is harmless to retry, but media_publish may have published
  const container = await runtime(W, { timeoutMs: 20, routes: [{ method: 'POST', url: '/17841400000000001/media', respond: never }, ...igRoutes().filter((r) => !(r.method === 'POST' && r.url.endsWith('/media'))), ...ttRoutes(), ...gbpRoutes()] });
  await container.executor.runDueJobs({ merchantId: M1 });
  assert.equal(jobOf(container, 'instagram').state, 'FAILED_RETRYABLE'); // nothing can have been published yet
  const publishing = await runtime(W, { timeoutMs: 20, routes: [{ method: 'POST', url: '/media_publish', respond: never }, ...igRoutes().filter((r) => !r.url.endsWith('/media_publish')), ...ttRoutes(), ...gbpRoutes()] });
  await publishing.executor.runDueJobs({ merchantId: M1 });
  advance(publishing, 120_000);
  await publishing.executor.runDueJobs({ merchantId: M1 });
  const ig = jobOf(publishing, 'instagram');
  assert.deepEqual([ig.state, ig.last_error_code, ig.provider_submission_id], ['SUBMISSION_UNKNOWN', 'SUBMISSION_OUTCOME_UNKNOWN', 'container-1']);
  advance(publishing, 24 * 3_600_000);
  await publishing.executor.runDueJobs({ merchantId: M1 });
  assert.equal(publishing.svc.http.raw.filter((r) => r.url.endsWith('/media_publish')).length, 1); // never published a second time
  const exhausted = await runtime(W, { routes: [...igRoutes({ statuses: ['IN_PROGRESS'] }), ...ttRoutes(), ...gbpRoutes()] }); // a job that stays PROCESSING may still publish later
  for (let i = 0; i < 16; i += 1) { await exhausted.executor.runDueJobs({ merchantId: M1 }); advance(exhausted, 61_000); }
  assert.deepEqual([jobOf(exhausted, 'instagram').state, jobOf(exhausted, 'instagram').last_error_code], ['SUBMISSION_UNKNOWN', 'STATUS_POLL_EXHAUSTED']);
});
