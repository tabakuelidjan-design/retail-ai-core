import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore } from '../src/social/store.js';
import { createSocialService } from '../src/social/service.js';
import { lintClaims, newPost, contentHashOf } from '../src/social/post.js';
import { transition } from '../src/social/workflow.js';
import { createSimulatedPublisher } from '../src/social/providers/simulated.js';
import {
  AGENT, OWNER, T0, TOKENS, asset, createFakeHttp, fbRoutes, igRoutes, ok, postInput, runtime, scheduled, sha,
} from './social-fixtures.js';

const HOUR = 3600_000;
const states = async (rt) => (await rt.service.list()).map((p) => p.state);
const hashOf = async (rt, id) => rt.service.contentHashOf(await rt.service.get(id));
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code, `expected ${code}`);

// ---------------------------------------------------------------------------------------------------------------- workflow
test('happy path: draft -> review -> approved -> scheduled -> published -> verified, every step in the history', async () => {
  const rt = runtime();
  const p = await scheduled(rt);
  assert.equal(p.state, 'SCHEDULED');
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  const pass = await rt.publisher.runDue();
  assert.equal(pass.published, 1);
  let cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'PUBLISHED');
  assert.equal(cur.publication.mode, 'LIVE');
  assert.equal(cur.publication.post_id, 'media-1');
  rt.clock.now += 11 * 60_000;
  const next = await rt.publisher.runDue();
  assert.equal(next.verified, 1);
  cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'VERIFIED');
  assert.equal(cur.verification.permalink, 'https://www.instagram.com/p/ABC123/');
  assert.deepEqual(cur.history.map((h) => h.action), ['submit', 'approve', 'schedule', 'claim', 'annotate', 'mark_published', 'mark_verified']);
  assert.deepEqual(cur.history.map((h) => h.actor.role), ['agent', 'owner', 'owner', 'system', 'system', 'system', 'system']);
});

test('only the owner decides: an agent or the publisher can never approve, schedule, reject or revoke', async () => {
  const rt = runtime();
  const post = await rt.service.createPost(postInput(), AGENT);
  await rt.service.act(post.id, 'submit', AGENT);
  const expected_hash = await hashOf(rt, post.id);
  for (const action of ['approve', 'reject', 'request_changes', 'schedule', 'revoke_approval']) {
    await rejects(rt.service.act(post.id, action, AGENT, { expected_hash, note: 'x' }), 'SOCIAL_FORBIDDEN');
    await rejects(rt.service.act(post.id, action, { id: 'nordla-publisher', role: 'system' }, { expected_hash, note: 'x' }), 'SOCIAL_FORBIDDEN');
  }
  await rejects(rt.service.act(post.id, 'claim', OWNER, {}), 'SOCIAL_FORBIDDEN'); // the owner does not drive the publisher either
  assert.equal((await rt.service.get(post.id)).state, 'READY_FOR_REVIEW');
});

test('approval is bound to the exact version the owner saw: a stale hash is refused, a changed caption voids the approval', async () => {
  const rt = runtime();
  const post = await rt.service.createPost(postInput(), AGENT);
  await rt.service.act(post.id, 'submit', AGENT);
  const seen = await hashOf(rt, post.id);
  await rejects(rt.service.act(post.id, 'approve', OWNER, {}), 'SOCIAL_STALE_VERSION'); // no hash named
  await rt.service.editPost(post.id, { caption: 'Une coque qui voyage. Fabriquée à Namur.' }, AGENT); // changes after the owner looked
  assert.equal((await rt.service.get(post.id)).state, 'DRAFT');
  await rt.service.act(post.id, 'submit', AGENT);
  await rejects(rt.service.act(post.id, 'approve', OWNER, { expected_hash: seen }), 'SOCIAL_STALE_VERSION');
  const fresh = await hashOf(rt, post.id);
  await rt.service.act(post.id, 'approve', OWNER, { expected_hash: fresh });
  await rt.service.act(post.id, 'schedule', OWNER, { expected_hash: fresh });
  // editing an approved + scheduled post: back to DRAFT, approval wiped, history says why
  const edited = await rt.service.editPost(post.id, { hashtags: ['habb', 'namur', 'voyage'] }, AGENT);
  assert.equal(edited.state, 'DRAFT');
  assert.equal(edited.approval, null);
  const last = edited.history.at(-1);
  assert.equal(last.action, 'edit');
  assert.equal(last.detail.approval_invalidated, true);
  assert.ok(last.detail.changed_fields.includes('hashtags'));
  await rejects(rt.service.act(post.id, 'schedule', OWNER, { expected_hash: await hashOf(rt, post.id) }), 'SOCIAL_TRANSITION_REFUSED');
});

test('changing the asset version or the publish time voids the approval too (what/where/when are all approved)', async () => {
  const rt = runtime();
  for (const patch of [{ asset: asset({ version: 2, sha256: sha('v2') }) }, { publish_at: '2026-10-18T17:00:00Z' }, { account_ref: 'other-account' }]) {
    const p = await scheduled(rt, { subject: { kind: 'product', ref: `ref-${Math.random()}`, label: 'x' } });
    const after = await rt.service.editPost(p.id, patch, AGENT);
    assert.equal(after.state, 'DRAFT');
    assert.equal(after.approval, null);
  }
});

test('defense in depth: a post whose stored state says SCHEDULED but whose approval does not match its content is never published', async () => {
  const rt = runtime();
  const p = await scheduled(rt);
  // tamper directly in the store: change the caption without going through the workflow
  await rt.store.update(p.id, (cur) => ({ ...cur, caption: 'Tout autre texte jamais approuvé.', rev: cur.rev + 1 }));
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  const cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'ERROR');
  assert.equal(cur.publication.last_error, 'NO_VALID_APPROVAL');
  assert.equal(rt.igHttp.count('POST', '/media'), 0);
  assert.equal(rt.igHttp.count('POST', '/media_publish'), 0);
});

test('unconfirmed commercial claims block review and approval: price, discount, delay, guarantee', async () => {
  const rt = runtime();
  const bad = {
    'Coque à 25 € seulement': 'PRICE', 'Profitez de -20% ce week-end': 'DISCOUNT', 'Livraison en 48h partout': 'DELIVERY_DELAY', 'Satisfait ou remboursé': 'GUARANTEE', 'Soldes sur toute la boutique': 'DISCOUNT',
  };
  for (const [caption, code] of Object.entries(bad)) {
    const found = lintClaims({ caption, hashtags: [] });
    assert.ok(found.some((f) => f.code === code), `${caption} -> ${code}`);
    const p = await rt.service.createPost(postInput({ caption, subject: { kind: 'product', ref: `r-${code}-${caption.length}`, label: 'x' } }), AGENT);
    await rejects(rt.service.act(p.id, 'submit', AGENT), 'SOCIAL_UNCONFIRMED_CLAIM');
  }
  assert.deepEqual(lintClaims({ caption: 'Fabriquée à Namur, personnalisée avec votre photo.', hashtags: ['namur'] }), []);
});

test('Instagram needs a JPEG; an image post without a usable asset cannot be submitted', async () => {
  const rt = runtime();
  const png = await rt.service.createPost(postInput({ asset: asset({ content_type: 'image/png' }) }), AGENT);
  await rejects(rt.service.act(png.id, 'submit', AGENT), 'SOCIAL_UNCONFIRMED_CLAIM');
  assert.throws(() => newPost(postInput({ asset: null }), { actor: AGENT, now: '2026-10-17T00:00:00Z' }), /asset is required/);
  assert.throws(() => newPost(postInput({ format: 'TEXT' }), { actor: AGENT, now: '2026-10-17T00:00:00Z' }), /does not support format TEXT/); // Instagram has no text-only post
});

// ---------------------------------------------------------------------------------------------------------------- publishing exactly once
test('two workers racing on the same due post publish exactly once', async () => {
  const rt = runtime();
  await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await Promise.all([rt.publisher.runDue(), rt.publisher.runDue(), rt.publisher.runDue()]);
  assert.equal(rt.igHttp.count('POST', '/media'), 1);
  assert.equal(rt.igHttp.count('POST', '/media_publish'), 1);
  assert.deepEqual(await states(rt), ['PUBLISHED']);
});

test('re-running after success never publishes again', async () => {
  const rt = runtime();
  await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  for (let i = 0; i < 3; i += 1) { rt.clock.tick(HOUR); await rt.publisher.runDue(); }
  assert.equal(rt.igHttp.count('POST', '/media_publish'), 1);
});

test('nothing is published before its time', async () => {
  const rt = runtime();
  await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T16:59:00Z');
  await rt.publisher.runDue();
  assert.equal(rt.igHttp.calls.length, 0);
  assert.deepEqual(await states(rt), ['SCHEDULED']);
});

test('a retryable error is retried later and the container is RESUMED, never created twice', async () => {
  let publishAttempts = 0;
  const rt = runtime({ ig: igRoutes({ 'POST /media_publish': () => { publishAttempts += 1; return publishAttempts === 1 ? { status: 429, headers: { 'retry-after': '120' }, body: { error: { code: 4 } } } : ok({ id: 'media-1' }); } }) });
  const p = await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  let cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'SCHEDULED');
  assert.equal(cur.publication.last_error, 'RATE_LIMITED');
  assert.equal(cur.publication.submission_id, 'container-1');
  await rt.publisher.runDue(); // too early: backoff holds
  assert.equal(publishAttempts, 1);
  rt.clock.tick(5 * 60_000);
  await rt.publisher.runDue();
  cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'PUBLISHED');
  assert.equal(rt.igHttp.count('POST', '/media'), 1, 'one container for two publish attempts');
});

test('a timeout while publishing is UNKNOWN: never retried, never "failed", never verified; the owner reconciles', async () => {
  const rt = runtime({ ig: igRoutes({ 'POST /media_publish': new Error('socket hang up') }) });
  const p = await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  let cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'PUBLICATION_UNKNOWN');
  const attempts = rt.igHttp.count('POST', '/media_publish');
  rt.clock.tick(24 * HOUR);
  await rt.publisher.runDue();
  assert.equal(rt.igHttp.count('POST', '/media_publish'), attempts, 'no automatic second attempt');
  await rejects(rt.service.editPost(p.id, { caption: 'autre' }, AGENT), 'SOCIAL_TRANSITION_REFUSED'); // frozen
  await rejects(rt.service.act(p.id, 'reconcile', AGENT, { outcome: 'published' }), 'SOCIAL_FORBIDDEN');
  await rejects(rt.service.act(p.id, 'reconcile', OWNER, { outcome: 'published' }), 'SOCIAL_INVALID'); // proof required
  cur = await rt.service.act(p.id, 'reconcile', OWNER, { outcome: 'published', permalink: 'https://www.instagram.com/p/REAL/' });
  assert.equal(cur.state, 'PUBLISHED');
  assert.equal(cur.publication.mode, 'MANUAL');
});

test('"not published" reconciliation re-arms the post only on the owner\'s word', async () => {
  const rt = runtime({ ig: igRoutes({ 'POST /media_publish': new Error('socket hang up') }) });
  const p = await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  const cur = await rt.service.act(p.id, 'reconcile', OWNER, { outcome: 'not_published' });
  assert.equal(cur.state, 'SCHEDULED');
  assert.equal(cur.publication.submission_id, null);
});

test('a worker that died mid-call: an existing container is resumed, no container means UNKNOWN (never a blind re-send)', async () => {
  const rt = runtime();
  const a = await scheduled(rt);
  const b = await scheduled(rt, { subject: { kind: 'product', ref: 'other', label: 'o' } });
  // simulate two dead claims
  await rt.store.update(a.id, (p) => transition(p, 'claim', { id: 'w', role: 'system' }, { now: new Date(T0).toISOString(), claim_id: 'dead-1' }));
  await rt.store.update(b.id, (p) => transition(p, 'claim', { id: 'w', role: 'system' }, { now: new Date(T0).toISOString(), claim_id: 'dead-2' }));
  await rt.store.update(b.id, (p) => ({ ...p, publication: { ...p.publication, submission_id: 'container-1' }, rev: p.rev + 1 }));
  rt.clock.now = T0 + 30 * 60_000;
  await rt.publisher.recoverStale();
  assert.equal((await rt.service.get(a.id)).state, 'PUBLICATION_UNKNOWN');
  assert.equal((await rt.service.get(b.id)).state, 'SCHEDULED');
});

test('a post that missed its window by more than 6 h is NOT sent silently: it becomes an ERROR; retry needs the owner', async () => {
  const rt = runtime();
  const p = await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:00Z') + 7 * HOUR;
  await rt.publisher.runDue();
  let cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'ERROR');
  assert.equal(cur.publication.last_error, 'MISSED_WINDOW');
  assert.equal(rt.igHttp.calls.length, 0);
  await rejects(rt.service.act(p.id, 'retry', AGENT), 'SOCIAL_FORBIDDEN');
  cur = await rt.service.act(p.id, 'retry', OWNER);
  assert.equal(cur.state, 'SCHEDULED');
  await rt.publisher.runDue();
  assert.equal((await rt.service.get(p.id)).state, 'PUBLISHED');
});

test('revoking the approval before the time means nothing is published', async () => {
  const rt = runtime();
  const p = await scheduled(rt);
  const cur = await rt.service.act(p.id, 'revoke_approval', OWNER, { note: 'finalement non' });
  assert.equal(cur.state, 'READY_FOR_REVIEW');
  assert.equal(cur.approval, null);
  rt.clock.now = Date.parse('2026-10-17T17:30:00Z');
  await rt.publisher.runDue();
  assert.equal(rt.igHttp.calls.length, 0);
});

test('cancel and unschedule stop a scheduled post; a post being published cannot be cancelled mid-flight', async () => {
  const rt = runtime();
  const a = await scheduled(rt);
  assert.equal((await rt.service.act(a.id, 'unschedule', OWNER)).state, 'APPROVED');
  assert.equal((await rt.service.act(a.id, 'cancel', OWNER, { note: 'annulé' })).state, 'CANCELLED');
  const b = await scheduled(rt, { subject: { kind: 'product', ref: 'b', label: 'b' } });
  await rt.store.update(b.id, (p) => transition(p, 'claim', { id: 'w', role: 'system' }, { now: new Date(T0).toISOString(), claim_id: 'c' }));
  await rejects(rt.service.act(b.id, 'cancel', OWNER, {}), 'SOCIAL_TRANSITION_REFUSED');
  await rejects(rt.service.act(b.id, 'revoke_approval', OWNER, {}), 'SOCIAL_TRANSITION_REFUSED');
});

test('the asset served at publication time must be the approved file: otherwise ERROR before any platform call', async () => {
  const rt = runtime({ mediaOver: { sha256: sha('a different file') } });
  const p = await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  const cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'ERROR');
  assert.equal(cur.publication.last_error, 'ASSET_CHANGED');
  assert.equal(rt.igHttp.calls.length, 0);
});

test('an expired / invalid token is a clear RECONNECT_REQUIRED error, not a retry loop', async () => {
  const rt = runtime({ ig: igRoutes({ 'GET /me': { status: 401, headers: {}, body: { error: { code: 190 } } } }) });
  const p = await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  const cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'ERROR');
  assert.equal(cur.publication.last_error, 'RECONNECT_REQUIRED');
});

test('a personal (non professional) Instagram account is refused by the live check', async () => {
  const rt = runtime({ ig: igRoutes({ 'GET /me': ok({ user_id: '17841400000000001', username: 'x', account_type: 'Personal' }) }) });
  const p = await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  assert.equal((await rt.service.get(p.id)).publication.last_error, 'CONNECTION_ACCOUNT_NOT_PROFESSIONAL');
});

// ---------------------------------------------------------------------------------------------------------------- simulation & manual
test('a SIMULATED publication is labelled as such and can never be VERIFIED', async () => {
  const sim = createSimulatedPublisher('instagram');
  const rt = runtime({ extraPublishers: { instagram: sim } });
  const p = await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  let cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'PUBLISHED');
  assert.equal(cur.publication.mode, 'SIMULATION');
  rt.clock.tick(HOUR);
  await rt.publisher.runDue();
  cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'PUBLISHED', 'machine verification refuses a simulation');
  await assert.rejects(rt.store.update(p.id, (x) => transition(x, 'mark_verified', { id: 's', role: 'system' }, { now: new Date(rt.clock.now).toISOString(), mode: 'LIVE' })), /simulated publication can never be VERIFIED/);
});

test('manual fallback: the owner publishes by hand, attests with the link, then confirms having looked; only the owner can', async () => {
  const rt = runtime();
  const post = await rt.service.createPost(postInput(), AGENT);
  await rt.service.act(post.id, 'submit', AGENT);
  const h = await hashOf(rt, post.id);
  await rt.service.act(post.id, 'approve', OWNER, { expected_hash: h });
  await rejects(rt.service.act(post.id, 'attest_manual', AGENT, { permalink: 'https://www.instagram.com/p/X/' }), 'SOCIAL_FORBIDDEN');
  await rejects(rt.service.act(post.id, 'attest_manual', OWNER, { permalink: 'not a link' }), 'SOCIAL_INVALID');
  let cur = await rt.service.act(post.id, 'attest_manual', OWNER, { permalink: 'https://www.instagram.com/p/X/' });
  assert.deepEqual([cur.state, cur.publication.mode], ['PUBLISHED', 'MANUAL']);
  cur = await rt.service.act(post.id, 'verify_manual', OWNER, {});
  assert.deepEqual([cur.state, cur.verification.mode], ['VERIFIED', 'MANUAL_ATTESTED']);
  assert.equal(rt.igHttp.calls.length, 0, 'the manual path never calls a platform');
});

test('manual fallback needs an approval of the exact version too', async () => {
  const rt = runtime();
  const post = await rt.service.createPost(postInput(), AGENT);
  await rt.service.act(post.id, 'submit', AGENT);
  await rejects(rt.service.act(post.id, 'attest_manual', OWNER, { permalink: 'https://www.instagram.com/p/X/' }), 'SOCIAL_TRANSITION_REFUSED');
});

// ---------------------------------------------------------------------------------------------------------------- Facebook native scheduling
test('Facebook: an approved post is handed to the platform scheduler (survives Nordla being offline); the plan is recorded', async () => {
  const rt = runtime({ withFacebook: true });
  const p = await scheduled(rt, { platform: 'facebook', publish_at: '2026-10-20T17:00:00Z' });
  const pass = await rt.publisher.runDue();
  assert.equal(pass.armed, 1);
  const cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'SCHEDULED');
  assert.equal(cur.publication.platform_schedule.post_id, `100000000000001_9001`);
  const call = rt.fbHttp.calls.find((c) => c.path.endsWith('/photos'));
  assert.equal(call.body.published, false);
  assert.equal(call.body.scheduled_publish_time, Math.floor(Date.parse('2026-10-20T17:00:00Z') / 1000));
  assert.equal(JSON.stringify(call.body).includes(TOKENS.fb), false, 'the token is sealed in recorded requests');
  await rt.publisher.runDue();
  assert.equal(rt.fbHttp.count('POST', '/photos'), 1, 'armed once');
});

test('Facebook: revoking an approval removes the platform copy; if removal fails it stays PENDING, is retried, and blocks re-scheduling', async () => {
  let deleteFails = true;
  const rt = runtime({ withFacebook: true, fb: fbRoutes({ [`DELETE /100000000000001_9001`]: () => (deleteFails ? { status: 500, headers: {}, body: {} } : ok({ success: true })) }) });
  const p = await scheduled(rt, { platform: 'facebook', publish_at: '2026-10-20T17:00:00Z' });
  await rt.publisher.runDue();
  let cur = await rt.service.act(p.id, 'revoke_approval', OWNER, { note: 'changé d\'avis' });
  assert.equal(cur.state, 'READY_FOR_REVIEW');
  assert.deepEqual(cur.publication.remote_cancel_pending, { post_id: '100000000000001_9001' }, 'still at the platform: it may publish');
  assert.ok(cur.history.some((h) => h.detail?.remote_cancel_failed));
  const h = await hashOf(rt, p.id);
  await rt.service.act(p.id, 'approve', OWNER, { expected_hash: h });
  await rejects(rt.service.act(p.id, 'schedule', OWNER, { expected_hash: h }), 'SOCIAL_CONFLICT');
  deleteFails = false;
  await rt.publisher.runDue(); // the pass retries the removal
  cur = await rt.service.get(p.id);
  assert.equal(cur.publication.remote_cancel_pending, null);
  await rt.service.act(p.id, 'schedule', OWNER, { expected_hash: h });
});

test('Facebook: a text-only post and a native schedule too close to now publish immediately at the due time', async () => {
  const rt = runtime({ withFacebook: true });
  const p = await scheduled(rt, { platform: 'facebook', format: 'TEXT', asset: null, caption: 'La boutique HABB, rue de Bruxelles à Namur.', publish_at: '2026-10-17T08:10:00Z' });
  await rt.publisher.runDue(); // 10 min lead < 15 min minimum: waits for the due time
  assert.equal((await rt.service.get(p.id)).state, 'SCHEDULED');
  assert.equal(rt.fbHttp.calls.length, 0);
  rt.clock.now = Date.parse('2026-10-17T08:10:30Z');
  await rt.publisher.runDue();
  assert.equal((await rt.service.get(p.id)).state, 'PUBLISHED');
  assert.equal(rt.fbHttp.count('POST', '/feed'), 1);
});

// ---------------------------------------------------------------------------------------------------------------- store & secrets
test('no secret ever reaches the store, the audit trail or the logs', async () => {
  const rt = runtime();
  const p = await scheduled(rt);
  rt.clock.now = Date.parse('2026-10-17T17:00:30Z');
  await rt.publisher.runDue();
  rt.clock.tick(11 * 60_000);
  await rt.publisher.runDue();
  const dump = JSON.stringify([await rt.service.get(p.id), await rt.service.audit(), rt.logs, rt.igHttp.calls]);
  for (const t of Object.values(TOKENS)) assert.equal(dump.includes(t), false);
  assert.equal(dump.includes('cdn.habb.be'), false, 'the ephemeral media URL is never persisted or logged');
  // and the store refuses to write one
  await assert.rejects(rt.service.createPost(postInput({ caption: 'voir https://x.test/a?access_token=EAABsecretsecretsecret' }), AGENT), /secret|token/i);
});

test('the file store survives a restart, replaces files atomically, and keeps an append-only audit trail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'social-'));
  try {
    let store = createFileStore(dir);
    let service = createSocialService({ store, clock: () => T0 });
    const p = await service.createPost(postInput(), AGENT);
    await service.act(p.id, 'submit', AGENT);
    store = createFileStore(dir); // "restart"
    service = createSocialService({ store, clock: () => T0 });
    const back = await service.get(p.id);
    assert.equal(back.state, 'READY_FOR_REVIEW');
    assert.equal(back.history.length, 1);
    const audit = await service.audit();
    assert.deepEqual(audit.map((e) => e.action), ['submit']);
    assert.equal((await readdir(join(dir, 'posts'))).filter((n) => n.endsWith('.tmp')).length, 0);
    assert.equal((await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').length, 1);
    assert.equal(contentHashOf(back), contentHashOf(p));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent edits on the file store are serialized; no lost update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'social-'));
  try {
    const service = createSocialService({ store: createFileStore(dir), clock: () => T0 });
    const p = await service.createPost(postInput(), AGENT);
    await Promise.all(Array.from({ length: 8 }, (_, i) => service.editPost(p.id, { notes: `note ${i}` }, AGENT)));
    const cur = await service.get(p.id);
    assert.ok(cur.history.length >= 7, 'every note edit recorded');
    assert.equal(new Set(cur.history.map((h) => h.seq)).size, cur.history.length, 'sequence numbers are unique');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Instagram carousels / stories and unknown platforms are refused by the contract (not implemented, not faked)', () => {
  const now = '2026-10-17T00:00:00Z';
  assert.throws(() => newPost(postInput({ format: 'CAROUSEL' }), { actor: AGENT, now }), /does not support format CAROUSEL/);
  assert.throws(() => newPost(postInput({ platform: 'tiktok' }), { actor: AGENT, now }), /platform must be/);
  assert.throws(() => newPost(postInput({ hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) }), { actor: AGENT, now }), /at most 30 hashtags/);
});

void createFakeHttp;
