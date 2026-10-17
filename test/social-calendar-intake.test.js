import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUCKET, brusselsParts, brusselsToUtc, buildCalendar, bucketOf, proposeSchedule, slotsOf,
} from '../src/social/calendar.js';
import { PROPOSAL_SCHEMA } from '../src/social/constants.js';
import { proposalPostId } from '../src/social/intake.js';
import { newPost } from '../src/social/post.js';
import {
  AGENT, OWNER, T0, asset, postInput, runtime, scheduled, sha,
} from './social-fixtures.js';

// ---------------------------------------------------------------------------------------------------------------- Europe/Brussels
test('Brussels wall clock <-> UTC, across the autumn change of hour of 2026-10-25 that falls inside the trip', () => {
  assert.equal(brusselsToUtc('2026-10-24', '18:00'), '2026-10-24T16:00:00.000Z'); // CEST, UTC+2
  assert.equal(brusselsToUtc('2026-10-26', '18:00'), '2026-10-26T17:00:00.000Z'); // CET, UTC+1
  assert.equal(brusselsToUtc('2026-10-25', '12:00'), '2026-10-25T11:00:00.000Z'); // the day itself, after the change
  assert.equal(brusselsToUtc('2026-10-25', '02:30'), '2026-10-25T00:30:00.000Z'); // ambiguous hour: the first (summer) occurrence
  assert.deepEqual(brusselsParts('2026-10-25T17:00:00Z'), { date: '2026-10-25', time: '18:00' });
  assert.deepEqual(brusselsParts('2026-10-24T22:30:00Z'), { date: '2026-10-25', time: '00:30' }); // UTC day != Brussels day
  assert.throws(() => brusselsToUtc('2027-03-28', '02:30'), /does not exist/); // spring-forward gap
});

test('an 18:00 slot stays 18:00 in Brussels on both sides of the change of hour', () => {
  const slots = slotsOf({ from: '2026-10-23', days: 6, weekdays: [0, 1, 2, 3, 4, 5, 6], time: '18:00', nowMs: Date.parse('2026-10-16T00:00:00Z') });
  assert.deepEqual(slots.map((s) => brusselsParts(s.publish_at).time), Array(6).fill('18:00'));
  assert.deepEqual(slots.map((s) => s.publish_at.slice(11, 16)), ['16:00', '16:00', '17:00', '17:00', '17:00', '17:00']); // 23-24 Oct summer time; from the 25th (change at 03:00) winter time
});

// ---------------------------------------------------------------------------------------------------------------- buckets & grid
test('the calendar sorts every post into what the owner needs to do about it', async () => {
  const rt = runtime();
  const mk = (over) => rt.service.createPost(postInput({ subject: { kind: 'product', ref: `p-${Math.random()}`, label: 'x' }, ...over }), AGENT);
  const approved = await scheduled(rt, { subject: { kind: 'product', ref: 'a', label: 'a' }, publish_at: '2026-10-18T17:00:00Z' });
  const awaiting = await mk({ publish_at: '2026-10-19T17:00:00Z' }); await rt.service.act(awaiting.id, 'submit', AGENT);
  const needsFix = await mk({ caption: 'Seulement 25 € !', publish_at: '2026-10-20T17:00:00Z' });
  const noAsset = await mk({ asset: null, publish_at: '2026-10-22T17:00:00Z' }); // brief delivered, picture missing: kept, flagged
  const png = await mk({ asset: asset({ content_type: 'image/png' }), publish_at: '2026-10-21T17:00:00Z' });
  const all = await rt.service.list();
  const cal = buildCalendar({ posts: all, from: '2026-10-17', days: 14 });
  assert.ok(cal.buckets[BUCKET.MISSING_ASSET].includes(noAsset.id), 'a post without its picture is listed as a missing asset');
  assert.ok(cal.buckets[BUCKET.PROGRAMMABLE].includes(approved.id));
  assert.ok(cal.buckets[BUCKET.AWAITING_APPROVAL].includes(awaiting.id));
  assert.ok(cal.buckets[BUCKET.NEEDS_CORRECTION].includes(needsFix.id), 'claim in the caption');
  assert.ok(cal.buckets[BUCKET.AWAITING_APPROVAL].includes(png.id) === false, 'a PNG draft was never submitted');
  assert.equal(cal.days.length, 14);
  assert.equal(cal.days[0].date, '2026-10-17');
  assert.equal(cal.days[1].entries[0].time, '19:00'); // 17:00Z on 18 Oct is 19:00 in Brussels (summer)
});

test('a post whose approval no longer matches its content is NOT programmable, whatever its state says', async () => {
  const rt = runtime();
  const p = await scheduled(rt);
  const tampered = { ...(await rt.service.get(p.id)), caption: 'autre texte' };
  assert.equal(bucketOf(tampered), BUCKET.NEEDS_CORRECTION);
});

// ---------------------------------------------------------------------------------------------------------------- proposals
test('proposeSchedule: one piece per slot, same piece on both channels, no subject twice in a row, owner-chosen dates untouched', () => {
  const now = '2026-10-17T00:00:00Z';
  const piece = (ref, platform, proposal) => ({ ...newPost(postInput({ platform, subject: { kind: 'product', ref, label: ref }, publish_at: null, origin: { producer: 'chantier-d', proposal_id: proposal } }), { actor: AGENT, now }) });
  const posts = [
    piece('coque', 'instagram', 'p1'), piece('coque', 'facebook', 'p1'),
    piece('coque', 'instagram', 'p2'), // same subject again: should not be adjacent to p1 when another subject exists
    piece('gourde', 'instagram', 'p3'),
    { ...piece('boite', 'instagram', 'p4'), publish_at: '2026-10-19T17:00:00Z' }, // the owner already fixed this one
  ];
  const { assignments, leftover } = proposeSchedule({ posts, from: '2026-10-17', days: 14, nowMs: Date.parse(now), cadence: { weekdays: [1, 3, 5, 0], time: '18:00' } });
  const byPost = Object.fromEntries(assignments.map((a) => [a.post_id, a.publish_at]));
  assert.equal(byPost[posts[0].id], byPost[posts[1].id], 'instagram + facebook of one piece share a slot');
  const order = [...new Set(assignments.map((a) => a.publish_at))].sort().map((t) => posts.find((p) => byPost[p.id] === t).subject.ref);
  assert.notEqual(order[0], order[1], 'no identical subject back to back');
  assert.equal(assignments.some((a) => a.post_id === posts[4].id), false, 'a post that has a date is never moved');
  assert.deepEqual(leftover, []);
  assert.ok(!Object.values(byPost).some((t) => brusselsParts(t).date === '2026-10-19'), 'the day the owner chose is not given to another piece');
});

test('proposeSchedule reports pieces that do not fit instead of cramming them', () => {
  const now = '2026-10-17T00:00:00Z';
  const posts = Array.from({ length: 12 }, (_, i) => newPost(postInput({ subject: { kind: 'product', ref: `s${i}`, label: 's' }, publish_at: null }), { actor: AGENT, now }));
  const { assignments, leftover } = proposeSchedule({ posts, from: '2026-10-17', days: 14, nowMs: Date.parse(now), cadence: { weekdays: [1, 3, 5, 0] } });
  assert.equal(assignments.length + leftover.length, 12);
  assert.ok(leftover.length > 0);
  assert.equal(new Set(assignments.map((a) => a.publish_at)).size, assignments.length, 'one piece per slot');
});

// ---------------------------------------------------------------------------------------------------------------- chantier D contract
const proposal = (over = {}) => ({
  schema: PROPOSAL_SCHEMA, proposal_id: 'd-2026-10-17-001', producer: 'chantier-d',
  asset: asset(), subject: { kind: 'product', ref: 'shopify://product/coque-voyage', label: 'Coque voyage' },
  caption: 'Une coque qui voyage avec vous. Fabriquée à Namur.', hashtags: ['habb', 'namur'],
  targets: [{ platform: 'instagram', format: 'IMAGE' }, { platform: 'facebook', format: 'IMAGE' }], ...over,
});

test('D delivers a proposal: one post per target, idempotent, offered for review when ready', async () => {
  const rt = runtime({ withFacebook: true });
  const first = await rt.service.importProposals([proposal()], { id: 'chantier-d', role: 'agent' });
  assert.deepEqual(first.map((l) => l.result), ['CREATED', 'CREATED']);
  assert.deepEqual((await rt.service.list()).map((p) => p.state), ['READY_FOR_REVIEW', 'READY_FOR_REVIEW']);
  const again = await rt.service.importProposals([proposal()], { id: 'chantier-d', role: 'agent' });
  assert.deepEqual(again.map((l) => l.result), ['UNCHANGED', 'UNCHANGED']);
  assert.equal((await rt.service.list()).length, 2);
  assert.equal(first[0].post_id, proposalPostId('d-2026-10-17-001', 'instagram', 'IMAGE'));
});

test('D cannot silently change what the owner approved: a new asset version voids the approval; a published post is untouchable', async () => {
  const rt = runtime();
  const actor = { id: 'chantier-d', role: 'agent' };
  await rt.service.importProposals([proposal({ targets: [{ platform: 'instagram', format: 'IMAGE' }] })], actor);
  const [post] = await rt.service.list();
  const h = rt.service.contentHashOf(post);
  await rt.service.act(post.id, 'approve', OWNER, { expected_hash: h });
  const redelivery = await rt.service.importProposals([proposal({ targets: [{ platform: 'instagram', format: 'IMAGE' }], asset: asset({ version: 2, sha256: sha('v2') }) })], actor);
  assert.equal(redelivery[0].result, 'UPDATED');
  assert.equal(redelivery[0].approval_voided, true);
  const after = await rt.service.get(post.id);
  assert.equal(after.approval, null);
  assert.equal(after.state, 'READY_FOR_REVIEW', 'ready again, awaiting a NEW decision');
  assert.equal(after.asset.version, 2);
  // freeze it as published and redeliver
  await rt.store.update(post.id, (p) => ({ ...p, state: 'PUBLISHED', rev: p.rev + 1 }));
  const frozen = await rt.service.importProposals([proposal({ targets: [{ platform: 'instagram', format: 'IMAGE' }], caption: 'Nouveau texte.' })], actor);
  assert.equal(frozen[0].result, 'REFUSED_FROZEN');
});

test('D\'s suggested_date never overwrites the owner\'s calendar choice', async () => {
  const rt = runtime();
  const actor = { id: 'chantier-d', role: 'agent' };
  const t = [{ platform: 'instagram', format: 'IMAGE' }];
  await rt.service.importProposals([proposal({ targets: t, suggested_date: '2026-10-18T17:00:00Z' })], actor);
  const [post] = await rt.service.list();
  await rt.service.editPost(post.id, { publish_at: '2026-10-22T16:00:00Z' }, OWNER);
  await rt.service.importProposals([proposal({ targets: t, suggested_date: '2026-10-18T17:00:00Z', caption: 'Texte corrigé par D.' })], actor);
  assert.equal((await rt.service.get(post.id)).publish_at, '2026-10-22T16:00:00.000Z');
});

test('a bad proposal is rejected with a reason and does not stop the good ones', async () => {
  const rt = runtime();
  const actor = { id: 'chantier-d', role: 'agent' };
  const report = await rt.service.importProposals([
    { ...proposal(), schema: 'wrong' },
    proposal({ proposal_id: 'good-1', targets: [{ platform: 'instagram', format: 'IMAGE' }] }),
    proposal({ proposal_id: 'bad-asset', asset: { ref: 'x' }, targets: [{ platform: 'instagram', format: 'IMAGE' }] }),
    proposal({ proposal_id: 'carousel', targets: [{ platform: 'instagram', format: 'CAROUSEL' }] }), // no `assets` list: kept, flagged as missing
    proposal({ proposal_id: 'reel-on-fb', targets: [{ platform: 'facebook', format: 'REEL' }] }),
    proposal({ proposal_id: 'priced', caption: 'Seulement 19,90 €', targets: [{ platform: 'instagram', format: 'IMAGE' }] }),
  ], actor);
  assert.deepEqual(report.map((l) => l.result), ['REJECTED', 'CREATED', 'REJECTED', 'CREATED', 'REJECTED', 'CREATED']);
  assert.deepEqual(report[3].problems, ['ASSET_MISSING']);
  assert.deepEqual(report[5].problems, ['UNCONFIRMED_CLAIM_PRICE'], 'kept as a draft with the reason, not offered for review');
  assert.equal((await rt.service.get(report[5].post_id)).state, 'DRAFT');
});

void T0;
