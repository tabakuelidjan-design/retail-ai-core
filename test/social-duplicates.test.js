import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSocialService } from '../src/social/service.js';
import { createFileStore } from '../src/social/store.js';
import { createPublisher } from '../src/social/publisher.js';
import { createInstagramPublisher } from '../src/social/providers/meta.js';
import { createFileKeyring } from '../src/social/integrity.js';
import { contentHashOf } from '../src/social/post.js';
import {
  AGENT, OWNER, T0, asset, createFakeHttp, credentials, igRoutes, media, postInput, sha,
} from './social-fixtures.js';

// E-P1 priority 1 (audit finding D4): two DISTINCT proposals with identical content. Temp folders, fake platform, no real data, no network.
const DUE = Date.parse('2026-10-17T17:05:00Z');
const WORKER = fileURLToPath(new URL('./social-worker.js', import.meta.url));

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'social-dup-'));
  const dir = join(root, 'data'); const keyDir = join(root, 'keys'); const log = join(root, 'platform.log');
  mkdirSync(dir, { recursive: true }); writeFileSync(log, '');
  const integrity = createFileKeyring({ keyDir, dataDir: dir });
  const http = createFakeHttp(igRoutes());
  const clock = { now: T0 };
  const publishers = { instagram: createInstagramPublisher({ http, graphVersion: 'v25.0', credentials: credentials(), timeoutMs: 1000, sleep: async () => {}, settleWaitMs: 0 }) };
  const service = createSocialService({ store: createFileStore(dir), publishers, clock: () => clock.now, integrity });
  const publisher = createPublisher({ service, publishers, media: media(), clock: () => clock.now, logger: () => {} });
  return { root, dir, keyDir, log, integrity, http, clock, service, publisher };
}
const calls = (r) => r.http.count('POST', '/media_publish');
const hashOf = async (r, id) => r.service.contentHashOf(await r.service.get(id));
const proposal = (n, over = {}) => postInput({ origin: { producer: 'chantier-d', proposal_id: `prop-${n}` }, ...over });
async function submitted(r, n, over = {}) {
  const p = await r.service.createPost(proposal(n, over), AGENT);
  await r.service.act(p.id, 'submit', AGENT);
  return p;
}
async function approve(r, p, params = {}) { return r.service.act(p.id, 'approve', OWNER, { expected_hash: await hashOf(r, p.id), ...params }); }
async function schedule(r, p) { return r.service.act(p.id, 'schedule', OWNER, { expected_hash: await hashOf(r, p.id) }); }
const duplicateRefused = (e) => e.code === 'SOCIAL_DUPLICATE_CONTENT';

test('DU-1 (audit D4) a second proposal with the same content is refused at approval; the first is untouched and nothing is deleted', async () => {
  const r = rig();
  const a = await submitted(r, 1); await approve(r, a); await schedule(r, a);
  const b = await submitted(r, 2);
  await assert.rejects(() => approve(r, b), duplicateRefused);
  assert.equal((await r.service.get(b.id)).state, 'READY_FOR_REVIEW');
  assert.equal((await r.service.get(a.id)).state, 'SCHEDULED');
  r.clock.now = DUE; await r.publisher.runDue();
  assert.equal(calls(r), 1);
});

test('DU-2 what counts as "the same": spacing is ignored, date and proposal id are ignored; another picture, platform, account or text is NOT a duplicate', async () => {
  const r = rig();
  const a = await submitted(r, 1); await approve(r, a);
  const same = await submitted(r, 2, { caption: '  Une coque qui voyage   avec vous.\nFabriquée à Namur. ', publish_at: '2026-10-20T10:00:00Z' });
  await assert.rejects(() => approve(r, same), duplicateRefused);
  const otherPicture = await submitted(r, 3, { asset: asset({ sha256: sha('another-picture') }) });
  await approve(r, otherPicture);
  const otherText = await submitted(r, 4, { caption: 'Un autre texte, une autre histoire.' });
  await approve(r, otherText);
  const otherAccount = await submitted(r, 5, { account_ref: 'second-account' });
  await approve(r, otherAccount);
});

test('DU-3 an authorised republication needs the owner to name the duplicate and give a reason; then both go out, once each', async () => {
  const r = rig();
  const a = await submitted(r, 1); await approve(r, a); await schedule(r, a);
  const b = await submitted(r, 2);
  await assert.rejects(() => approve(r, b, { allow_duplicate_of: ['nobody-12'], duplicate_note: 'republication voulue' }), duplicateRefused);
  await assert.rejects(() => approve(r, b, { allow_duplicate_of: [a.id] }), duplicateRefused); // no reason
  await approve(r, b, { allow_duplicate_of: [a.id], duplicate_note: 'republication voulue, relance de la semaine' });
  await schedule(r, b);
  assert.deepEqual((await r.service.get(b.id)).approval.duplicate_ack.of, [a.id]);
  r.clock.now = DUE; await r.publisher.runDue();
  assert.equal(calls(r), 2);
});

test('DU-4 an acknowledgement written into the data folder by hand is worthless (it is part of the signed approval)', async () => {
  const r = rig();
  const a = await submitted(r, 1); await approve(r, a); await schedule(r, a);
  const b = await submitted(r, 2);
  const file = join(r.dir, 'posts', `${b.id}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.state = 'SCHEDULED';
  doc.approval = { approved_by: 'owner:habb', approved_at: '2026-10-17T08:00:00.000Z', content_hash: contentHashOf(doc), duplicate_ack: { of: [a.id], note: 'faux accord' } };
  writeFileSync(file, JSON.stringify(doc, null, 2));
  r.clock.now = DUE; await r.publisher.runDue();
  assert.equal(calls(r), 1, 'only the genuine post went out');
  assert.equal((await r.service.get(b.id)).publication.last_error, 'NO_VALID_APPROVAL');
});

test('DU-5 defence at the very last step: a genuinely signed but unacknowledged duplicate of a post already out is not published', async () => {
  const r = rig();
  const a = await submitted(r, 1); await approve(r, a); await schedule(r, a);
  r.clock.now = DUE; await r.publisher.runDue();
  assert.equal(calls(r), 1);
  const b = await r.service.createPost(proposal(2), AGENT);
  const file = join(r.dir, 'posts', `${b.id}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.state = 'SCHEDULED';
  const approval = { approved_by: 'owner:habb', approved_at: '2026-10-17T17:06:00.000Z', content_hash: contentHashOf(doc) };
  approval.key_id = r.integrity.keyId; approval.sig = r.integrity.sign(doc, approval); // a valid signature: only the duplicate guard can stop it
  doc.approval = approval;
  writeFileSync(file, JSON.stringify(doc, null, 2));
  r.clock.now = DUE + 60_000; await r.publisher.runDue();
  assert.equal(calls(r), 1, 'no second creating call');
  assert.equal((await r.service.get(b.id)).state, 'ERROR');
  assert.equal((await r.service.get(b.id)).publication.last_error, 'DUPLICATE_CONTENT_PUBLISHED');
});

test('DU-6 two processes approving the two identical proposals at the same moment: exactly one is approved', async () => {
  const r = rig();
  const a = await submitted(r, 1); const b = await submitted(r, 2);
  const goAt = Date.now() + 1500;
  const run = (id) => new Promise((resolve) => {
    const c = spawn(process.execPath, [WORKER, JSON.stringify({ dir: r.dir, keyDir: r.keyDir, log: r.log, nowMs: T0, goAt, approve: { id } })], { stdio: 'ignore' });
    c.on('close', resolve);
  });
  await Promise.all([run(a.id), run(b.id)]);
  const lines = readFileSync(r.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.filter((l) => l.startsWith('APPROVED:')).length, 1, JSON.stringify(lines));
  assert.deepEqual(lines.filter((l) => l.startsWith('REFUSED:')), ['REFUSED:SOCIAL_DUPLICATE_CONTENT']);
});
