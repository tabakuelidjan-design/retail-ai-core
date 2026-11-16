// Lot _09: from a Growth social test to the calendar of Publication sociale and back. Brief (Growth) -> SIMULATED Creator delivery -> social-post-proposal.v1 with origin.links -> draft ->
// the owner's validation -> schedule -> simulated publication -> Growth reads the state and starts the review ONLY from a confirmed publication. No network, no provider, nothing published.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSocialSource } from '../src/growth/server/social.js';
import { reviewSocialPost } from '../src/growth/social/test.js';
import { normalizeSocial } from '../src/growth/social/social.js';
import { createPublicationSource, filePosts } from '../src/growth/server/social-publication.js';
import { createSocialService } from '../src/social/service.js';
import { hasValidApproval } from '../src/social/workflow.js';
import { createPublisher } from '../src/social/publisher.js';
import { createMemoryStore, createFileStore } from '../src/social/store.js';
import { createSimulatedPublisher } from '../src/social/providers/simulated.js';
import { simulatedCreation, merchantRef } from '../scripts/lib/social-creation-sim.mjs';
import { OWNER, media } from './social-fixtures.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const post = (id, structure, reach, follows) => ({ id, url: `https://www.instagram.com/reel/${id}/`, posted_at: '2026-10-20', format: 'reel', paid: 'organic', hook: 'Du plateau vide au cadeau fini', topic: 'impression UV', structure, observed: { age_days: 7, reach, follows_attributed: follows } });
const FACTS = (extra = []) => ({ source_system: 'instagram_insights_SIM', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z',
  followers: { start_total: 1000, end_total: 1060 }, brand: { tone: 'chaleureux, direct', process: 'impression UV' }, capabilities: { trial_reels: true }, posts: [post('demo', 'démonstration', 1200, 12), post('presentation', 'présentation produit', 4000, 8), ...extra] });
const itemOf = async (merchantId = 'merchant-a') => (await createSocialSource({ now: () => NOW, cacheMs: 0, merchantId, loaders: { instagram: async () => FACTS() } })()).items[0];
const AGENT = { id: 'creator-SIMULATED', role: 'agent' };

function world({ store = createMemoryStore(), publisherOver = {}, merchant = 'merchant-a' } = {}) {
  const clock = { now: Date.parse('2026-11-15T09:00:00Z'), tick(ms) { this.now += ms; } };
  const publishers = { instagram: createSimulatedPublisher('instagram', { formats: ['IMAGE', 'REEL'], ...publisherOver }) };
  const service = createSocialService({ store, publishers, clock: () => clock.now, context: { merchantRef: merchantRef(merchant), accounts: { instagram: 'ig-9001', facebook: null } } });
  const publisher = createPublisher({ service, publishers, media: media(), clock: () => clock.now, logger: () => {}, config: {} });
  return { clock, service, publisher, publishers, store };
}
const reads = (service, o = {}) => createPublicationSource({ list: () => service.list(), merchantId: 'merchant-a', ...o });
const stageOf = async (service, item, o) => (await reads(service, o)([item])).get(item.id);
async function approveAndSchedule(w, id, publishAt) {
  await w.service.editPost(id, { publish_at: publishAt }, OWNER);
  await w.service.act(id, 'submit', AGENT).catch(() => {});
  const hash = w.service.contentHashOf(await w.service.get(id));
  await w.service.act(id, 'approve', OWNER, { expected_hash: hash });
  return w.service.act(id, 'schedule', OWNER, { expected_hash: hash });
}

test('LOT9-1 the whole path: brief -> simulated creation -> draft -> validation -> calendar -> simulated publication -> confirmed date -> review date; a planned date never starts the measurement', async () => {
  const item = await itemOf(); const brief = item.preparedAction.brief; const w = world();
  assert.equal(await stageOf(w.service, item), undefined, 'a prepared brief alone has no post: Growth shows "brief préparé"');
  const [line] = await w.service.importProposals([simulatedCreation(brief, { merchantId: 'merchant-a' })]); assert.deepEqual([line.result, line.problems ?? null], ['CREATED', null]);
  let pub = await stageOf(w.service, item);
  assert.deepEqual([pub.stage, pub.state, pub.measurement, pub.confirmed, pub.simulated, pub.links.briefId === brief.briefId, pub.links.briefVersion, pub.links.creationVersion, pub.observationDays], ['draft', 'READY_FOR_REVIEW', 'NOT_STARTED', false, true, true, 1, 1, 7]);
  const id = line.post_id;
  // the owner approves and schedules in the calendar of Publication sociale: 2026-11-16 18:30 UTC
  await approveAndSchedule(w, id, '2026-11-16T18:30:00Z'); pub = await stageOf(w.service, item);
  assert.deepEqual([pub.stage, pub.plannedDay, pub.measurement, pub.publishedAt, pub.reviewDueDay, pub.approved], ['scheduled', '2026-11-16', 'NOT_STARTED', null, null, true], 'scheduled: a plan, no measurement');
  assert.equal((await w.service.list()).length, 1);
  // the day arrives: the (simulated) publisher publishes
  w.clock.now = Date.parse('2026-11-16T18:31:00Z'); await w.publisher.runDue(); const done = await w.service.get(id); assert.equal(done.state, 'PUBLISHED'); assert.equal(done.publication.mode, 'SIMULATION');
  pub = await stageOf(w.service, item); assert.deepEqual([pub.stage, pub.confirmed, pub.measurement], ['simulated', false, 'NOT_STARTED'], 'a simulated publication starts no review in a real installation');
  pub = await stageOf(w.service, item, { acceptSimulated: true }); // the simulation server only
  assert.deepEqual([pub.stage, pub.confirmed, pub.measurement, pub.publishedDay, pub.networkPostId, pub.reviewDueDay, pub.plannedDay], ['simulated', true, 'READY', '2026-11-16', 'sim_instagram_1', '2026-11-23', '2026-11-16'], 'review date = REAL publication day + the 7 days of the brief; the planned day stays beside it');
  // the Growth review of lot _08 on the network post id carried by the confirmed publication (a simulated source holding that post)
  const { social } = normalizeSocial(FACTS([post(pub.networkPostId, 'démonstration', 1500, 15)]));
  const r = reviewSocialPost({ social, plan: { network: 'instagram', accountId: 'ig-9001', observationDays: 7 }, postId: pub.networkPostId, now: new Date('2026-11-23T12:00:00Z') });
  assert.deepEqual([r.state, r.post.rate, r.baseline.rate, r.next.code], ['COMPARABLE', 10, 3.85, 'repeat']);
});

test('LOT9-2 re-import of the same proposal is idempotent; a new creation version edits the same post, voids the approval and updates the link; a changed date voids it too', async () => {
  const item = await itemOf(); const brief = item.preparedAction.brief; const w = world(); const sim = (v, extra = {}) => simulatedCreation(brief, { merchantId: 'merchant-a', creationVersion: v, ...extra });
  const [a] = await w.service.importProposals([sim(1)]); const [b] = await w.service.importProposals([sim(1)]); assert.deepEqual([b.result, b.post_id === a.post_id, (await w.service.list()).length], ['UNCHANGED', true, 1]);
  await approveAndSchedule(w, a.post_id, '2026-11-16T18:30:00Z'); assert.equal((await stageOf(w.service, item)).stage, 'scheduled');
  const [c] = await w.service.importProposals([sim(2)]); assert.deepEqual([c.result, c.approval_voided, c.post_id === a.post_id], ['UPDATED', true, true], 'a new creation version sends the post back to review');
  let pub = await stageOf(w.service, item); assert.deepEqual([pub.links.creationVersion, pub.approved, pub.stage, pub.plannedDay], [2, false, 'draft', '2026-11-16'], 'the owner\'s calendar date is kept, the validation is not');
  const stored = await w.service.get(a.post_id); assert.equal(stored.origin.links.creation_version, 2);
  // the owner moves the date after validating: the validation no longer covers it
  await w.service.act(a.post_id, 'submit', AGENT).catch(() => {}); const h = w.service.contentHashOf(await w.service.get(a.post_id)); await w.service.act(a.post_id, 'approve', OWNER, { expected_hash: h });
  await w.service.editPost(a.post_id, { publish_at: '2026-11-17T08:00:00Z' }, OWNER); pub = await stageOf(w.service, item); assert.deepEqual([pub.approved, pub.plannedDay, pub.stage], [false, '2026-11-17', 'draft']);
  // only the creation VERSION moves forward on identical content (Creator re-numbered its delivery): content and validation untouched, the link follows
  const [d] = await w.service.importProposals([{ ...sim(2), links: { ...sim(2).links, creation_version: 3 } }]); assert.deepEqual([d.result, d.links_updated], ['UPDATED', true]); assert.equal((await stageOf(w.service, item)).links.creationVersion, 3);
});

test('LOT9-3 uncertain, failed and cancelled publications never start a measurement; a published one without date or identifier does not either', async () => {
  const item = await itemOf(); const brief = item.preparedAction.brief;
  const w = world({ publisherOver: { fail: Object.assign(new Error('timeout'), { unknown: true }) } });
  const [a] = await w.service.importProposals([simulatedCreation(brief, { merchantId: 'merchant-a' })]); await approveAndSchedule(w, a.post_id, '2026-11-16T18:30:00Z');
  w.clock.now = Date.parse('2026-11-16T18:31:00Z'); await w.publisher.runDue(); const p = await w.service.get(a.post_id);
  const pub = await stageOf(w.service, item, { acceptSimulated: true }); assert.deepEqual([p.state, pub.stage, pub.confirmed, pub.measurement, pub.reviewDueDay], ['PUBLICATION_UNKNOWN', 'uncertain', false, 'NOT_STARTED', null]);
  const posts = await w.service.list(); const odd = { ...posts[0], state: 'PUBLISHED', publication: { mode: 'MANUAL', published_at: null, post_id: null, permalink: null } };
  const m = await createPublicationSource({ list: async () => [odd], merchantId: 'merchant-a', acceptSimulated: true })([item]); assert.equal(m.get(item.id).confirmed, false, 'published without a date or an identifier is not confirmed');
  const cancelled = { ...posts[0], state: 'CANCELLED' }; assert.equal((await createPublicationSource({ list: async () => [cancelled], merchantId: 'merchant-a' })([item])).get(item.id).stage, 'cancelled');
});

test('LOT9-4 merchant and account are checked from the installation context; another merchant\'s or account\'s posts are ignored by Growth; a legacy proposal without links still imports', async () => {
  const item = await itemOf(); const brief = item.preparedAction.brief; const w = world();
  const other = simulatedCreation(brief, { merchantId: 'merchant-b' }); const [x] = await w.service.importProposals([other]); assert.deepEqual([x.result, /^MERCHANT_MISMATCH/.test(x.error)], ['REJECTED', true]);
  const badAcc = simulatedCreation(brief, { merchantId: 'merchant-a' }); badAcc.targets[0].account_ref = 'ig-OTHER'; const [y] = await w.service.importProposals([badAcc]); assert.deepEqual([y.result, /^ACCOUNT_MISMATCH/.test(y.error)], ['REJECTED', true]);
  const noAcc = simulatedCreation(brief, { merchantId: 'merchant-a' }); delete noAcc.targets[0].account_ref; assert.match((await w.service.importProposals([noAcc]))[0].error, /^ACCOUNT_REQUIRED/);
  const wrongNet = simulatedCreation(brief, { merchantId: 'merchant-a' }); wrongNet.links.account.network = 'facebook'; assert.match((await w.service.importProposals([wrongNet]))[0].error, /^ACCOUNT_NETWORK_MISMATCH/);
  const notConnected = world(); notConnected.service = createSocialService({ store: createMemoryStore(), publishers: {}, clock: () => 1, context: { merchantRef: merchantRef('merchant-a'), accounts: { instagram: 'ig-CONNECTED' } } });
  assert.match((await notConnected.service.importProposals([simulatedCreation(brief, { merchantId: 'merchant-a' })]))[0].error, /^ACCOUNT_NOT_CONNECTED/);
  assert.equal((await w.service.list()).length, 0, 'nothing was created');
  // a post of another merchant that exists in the same folder is ignored by this merchant's Growth, and counted
  const foreign = world({ merchant: 'merchant-b' }); await foreign.service.importProposals([simulatedCreation(brief, { merchantId: 'merchant-b' })]);
  const seen = (await createPublicationSource({ list: () => foreign.service.list(), merchantId: 'merchant-a' })([item])).get(item.id); assert.deepEqual([seen.stage, seen.ignored.otherMerchant], ['none', 1]);
  // legacy: a proposal without links, and a stored post whose origin has no links, stay readable and are never linked
  const legacy = { schema: 'social-post-proposal.v1', proposal_id: 'legacy-001', subject: { kind: 'brand', ref: 'x', label: 'x' }, caption: 'Texte ancien', targets: [{ platform: 'instagram', format: 'IMAGE', account_ref: 'ig-9001' }] };
  const [l] = await w.service.importProposals([legacy]); assert.equal(l.result, 'CREATED'); const lp = await w.service.get(l.post_id); assert.deepEqual([lp.origin.producer, lp.origin.proposal_id, 'links' in lp.origin], ['chantier-d', 'legacy-001', false]);
  assert.equal((await stageOf(w.service, item)), undefined, 'an unlinked post is never attached to a test');
});

test('LOT9-5 the link survives the import and a reload from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lot9-')); const item = await itemOf(); const brief = item.preparedAction.brief;
  try {
    const w = world({ store: createFileStore(dir) }); const [a] = await w.service.importProposals([simulatedCreation(brief, { merchantId: 'merchant-a' })]);
    const w2 = world({ store: createFileStore(dir) }); const again = await w2.service.get(a.post_id); assert.deepEqual([again.origin.links.growth_test_id, again.origin.links.brief_version, again.origin.links.creation_version, again.origin.links.merchant_ref === merchantRef('merchant-a')], [item.id, 1, 1, true]);
    const [b] = await w2.service.importProposals([simulatedCreation(brief, { merchantId: 'merchant-a' })]); assert.equal(b.result, 'UNCHANGED', 'a reload does not duplicate');
    const fromFiles = await createPublicationSource({ list: filePosts(dir), merchantId: 'merchant-a' })([item]); assert.equal(fromFiles.get(item.id).stage, 'draft', 'Growth reads the posts folder read-only');
    assert.equal(JSON.stringify(fromFiles.get(item.id)).includes('SIMULATION —'), false, 'no caption is returned to Growth');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const snap = async (service, id) => { const p = await service.get(id); return JSON.stringify({ origin: p.origin, history: p.history, rev: p.rev, state: p.state, hash: service.contentHashOf(p), approval: p.approval }); };

test('LOT9-6 the link is never moved silently: another test, brief, brief version, merchant, account, window, a dropped link or a link added to an unlinked post are REFUSED; the origin, the history and the revision stay intact', async () => {
  const item = await itemOf(); const brief = item.preparedAction.brief; const w = world(); const base = simulatedCreation(brief, { merchantId: 'merchant-a' });
  const [a] = await w.service.importProposals([base]); await approveAndSchedule(w, a.post_id, '2026-11-16T18:30:00Z'); const before = await snap(w.service, a.post_id);
  const same = await w.service.importProposals([base]); assert.equal(same[0].result, 'UNCHANGED', 'same proposal, same link: idempotent'); assert.equal(await snap(w.service, a.post_id), before);
  const attempt = (patch) => ({ ...base, links: { ...base.links, ...patch } });
  const cases = [['growth_test_id', attempt({ growth_test_id: 'social:instagram:ig-OTHER' })], ['brief_id', attempt({ brief_id: 'brief_000000000000' })], ['brief_version', attempt({ brief_version: 2 })], ['creation_id', attempt({ creation_id: 'other-creation' })],
    ['observation_days', attempt({ observation_days: 14 })], ['merchant_ref', attempt({ merchant_ref: merchantRef('merchant-b') })], ['account', attempt({ account: { network: 'instagram', id: 'ig-OTHER' } })]];
  for (const [field, proposal] of cases) {
    const [r] = await w.service.importProposals([proposal]); assert.equal(r.result, 'REJECTED', field); assert.match(r.error, /^(LINK_CONFLICT|MERCHANT_MISMATCH|ACCOUNT_)/, `${field}: ${r.error}`);
    assert.equal(await snap(w.service, a.post_id), before, `${field}: the post, its link, its history and its approval are untouched`);
  }
  const { links: _drop, ...noLinks } = base; const [dropped] = await w.service.importProposals([noLinks]); assert.deepEqual([dropped.result, /^LINK_REMOVED/.test(dropped.error)], ['REJECTED', true]);
  const older = await w.service.importProposals([{ ...simulatedCreation(brief, { merchantId: 'merchant-a', creationVersion: 1 }), links: { ...base.links, creation_version: 1 } }]); assert.equal(older[0].result, 'UNCHANGED', 'the same delivery again');
  const [up] = await w.service.importProposals([simulatedCreation(brief, { merchantId: 'merchant-a', creationVersion: 2 })]); assert.equal(up.result, 'UPDATED');
  const [down] = await w.service.importProposals([simulatedCreation(brief, { merchantId: 'merchant-a', creationVersion: 1 })]); assert.deepEqual([down.result, /^CREATION_VERSION_OLDER/.test(down.error)], ['REJECTED', true], 'no going back to an earlier creation version');
  assert.equal((await w.service.list()).length, 1, 'still one post');
  // a post imported WITHOUT a link cannot be linked later by re-delivery; a legacy proposal keeps working
  const legacy = { schema: 'social-post-proposal.v1', proposal_id: 'legacy-002', subject: { kind: 'brand', ref: 'x', label: 'x' }, caption: 'Texte ancien', targets: [{ platform: 'instagram', format: 'IMAGE', account_ref: 'ig-9001' }] };
  const [l1] = await w.service.importProposals([legacy]); assert.equal(l1.result, 'CREATED'); assert.equal((await w.service.importProposals([legacy]))[0].result, 'UNCHANGED');
  const lbefore = await snap(w.service, l1.post_id); const [l2] = await w.service.importProposals([{ ...legacy, links: base.links }]); assert.deepEqual([l2.result, /^LINK_ON_UNLINKED_POST/.test(l2.error)], ['REJECTED', true]); assert.equal(await snap(w.service, l1.post_id), lbefore);
  const edited = await w.service.importProposals([{ ...legacy, caption: 'Texte ancien modifié' }]); assert.equal(edited[0].result, 'UPDATED', 'a legacy proposal still follows the existing edit path');
});

test('LOT9-7 a new creation version for the same test and brief follows the existing path: draft updated, validation voided when the content changes, the owner date kept; and the review uses the CONFIRMED real date even if the planned date differs', async () => {
  const item = await itemOf(); const brief = item.preparedAction.brief; const w = world(); const sim = (v) => simulatedCreation(brief, { merchantId: 'merchant-a', creationVersion: v });
  const [a] = await w.service.importProposals([sim(1)]); await approveAndSchedule(w, a.post_id, '2026-11-16T22:30:00Z'); const planned = (await w.service.get(a.post_id)).publish_at;
  const [b] = await w.service.importProposals([sim(2)]); assert.deepEqual([b.result, b.approval_voided], ['UPDATED', true]);
  const p = await w.service.get(a.post_id); assert.deepEqual([p.state, hasValidApproval(p, w.service.integrity), p.publish_at === planned, p.asset.version, p.origin.links.creation_version], ['READY_FOR_REVIEW', false, true, 2, 2], 'content updated, validation gone, the owner date kept');
  // the owner re-validates but the day the network really published is NOT the planned day (published a day later)
  await w.service.act(a.post_id, 'submit', AGENT).catch(() => {}); const h = w.service.contentHashOf(await w.service.get(a.post_id)); await w.service.act(a.post_id, 'approve', OWNER, { expected_hash: h }); await w.service.act(a.post_id, 'schedule', OWNER, { expected_hash: h });
  w.clock.now = Date.parse('2026-11-17T03:00:00Z'); await w.publisher.runDue(); // 4 h 30 late (the publisher tolerates 6 h): planned 23:30 Brussels on the 16th, really published 04:00 on the 17th
  const pub = await stageOf(w.service, item, { acceptSimulated: true });
  assert.deepEqual([pub.plannedDay, pub.publishedDay, pub.reviewDueDay, pub.confirmed], ['2026-11-16', '2026-11-17', '2026-11-24', true], 'the review date comes from the REAL day, not the planned one');
  const { social } = normalizeSocial(FACTS([post(pub.networkPostId, 'démonstration', 1500, 15)]));
  const early = reviewSocialPost({ social, plan: { network: 'instagram', accountId: 'ig-9001', observationDays: 7 }, postId: pub.networkPostId, now: NOW }); assert.equal(early.state, 'COMPARABLE', 'the review itself reads the network post by its id');
});
