import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSocialService } from '../src/social/service.js';
import { createFileStore } from '../src/social/store.js';
import { createPublisher } from '../src/social/publisher.js';
import { createInstagramPublisher } from '../src/social/providers/meta.js';
import { createFileKeyring, createEphemeralIntegrity, defaultKeyDir } from '../src/social/integrity.js';
import { contentHashOf } from '../src/social/post.js';
import {
  AGENT, OWNER, T0, asset, createFakeHttp, credentials, igRoutes, media, postInput, sha,
} from './social-fixtures.js';

// E-P1 priority 2 (audit finding C6): the stored data can no longer create an authorisation. Everything runs in temp folders over a fake platform: no real data, no network.
const DUE = Date.parse('2026-10-17T17:05:00Z');

function rig({ keyDir: givenKeyDir = null, dataDir: givenDataDir = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'social-integrity-'));
  const dir = givenDataDir ?? join(root, 'data'); const keyDir = givenKeyDir ?? join(root, 'keys');
  mkdirSync(dir, { recursive: true });
  const integrity = createFileKeyring({ keyDir, dataDir: dir });
  const http = createFakeHttp(igRoutes());
  const clock = { now: T0 };
  const publishers = { instagram: createInstagramPublisher({ http, graphVersion: 'v25.0', credentials: credentials(), timeoutMs: 1000, sleep: async () => {}, settleWaitMs: 0 }) };
  const service = createSocialService({ store: createFileStore(dir), publishers, clock: () => clock.now, integrity });
  const publisher = createPublisher({ service, publishers, media: media(), clock: () => clock.now, logger: () => {} });
  return { root, dir, keyDir, integrity, http, clock, service, publisher, publishers };
}
const calls = (r) => r.http.count('POST', '/media_publish');
async function scheduledPost(r, over = {}) {
  const post = await r.service.createPost(postInput(over), AGENT);
  await r.service.act(post.id, 'submit', AGENT);
  const hash = r.service.contentHashOf(await r.service.get(post.id));
  await r.service.act(post.id, 'approve', OWNER, { expected_hash: hash });
  return r.service.act(post.id, 'schedule', OWNER, { expected_hash: hash });
}
const fileOf = (r, id) => join(r.dir, 'posts', `${id}.json`);
const readPost = (r, id) => JSON.parse(readFileSync(fileOf(r, id), 'utf8'));
const writePost = (r, id, doc) => writeFileSync(fileOf(r, id), JSON.stringify(doc, null, 2));
const publishDue = async (r) => { r.clock.now = DUE; await r.publisher.runDue(); };

test('IN-1 (audit C6) a complete forged authorisation written straight into the data folder is NOT valid: nothing is published', async () => {
  const r = rig();
  const post = await r.service.createPost(postInput(), AGENT); // a draft
  const doc = readPost(r, post.id);
  doc.state = 'SCHEDULED';
  doc.approval = { approved_by: 'owner:habb', approved_at: '2026-10-17T08:00:00.000Z', content_hash: contentHashOf(doc) }; // everything an attacker can compute, except the signature
  writePost(r, post.id, doc);
  await publishDue(r);
  assert.equal(calls(r), 0);
  assert.equal((await r.service.get(post.id)).state, 'ERROR');
  assert.equal((await r.service.get(post.id)).publication.last_error, 'NO_VALID_APPROVAL');
});

test('IN-2 a made-up signature, a signature of another key, a missing signature and a legacy approval (no signature at all) are all refused', async () => {
  const forgeries = {
    random_signature: (doc) => { doc.approval.sig = 'ab'.repeat(32); },
    other_key: (doc) => { const other = createEphemeralIntegrity(); doc.approval.key_id = other.keyId; doc.approval.sig = other.sign(doc, doc.approval); },
    missing_signature: (doc) => { delete doc.approval.sig; },
    legacy_unsigned_approval: (doc) => { delete doc.approval.sig; delete doc.approval.key_id; },
    malformed_signature: (doc) => { doc.approval.sig = 'not-hex'; },
  };
  for (const [name, forge] of Object.entries(forgeries)) {
    const r = rig();
    const p = await scheduledPost(r);
    const doc = readPost(r, p.id); forge(doc); writePost(r, p.id, doc);
    await publishDue(r);
    assert.equal(calls(r), 0, name);
    assert.equal((await r.service.get(p.id)).publication.last_error, 'NO_VALID_APPROVAL', name);
  }
});

test('IN-3 every field the approval covers is protected, even when the attacker recomputes the content hash: text, hashtags, picture, date, platform, format, account, subject', async () => {
  const tampers = {
    caption: (d) => { d.caption = 'Un texte que personne n\'a approuvé.'; },
    hashtags: (d) => { d.hashtags = [...d.hashtags, 'pirate']; },
    visual_sha256: (d) => { d.asset.sha256 = sha('another picture'); },
    visual_reference: (d) => { d.asset.ref = 'asset://elsewhere/other'; },
    visual_version: (d) => { d.asset.version = 9; },
    date: (d) => { d.publish_at = '2026-10-17T17:01:00.000Z'; },
    platform: (d) => { d.platform = 'facebook'; },
    format: (d) => { d.format = 'REEL'; d.asset.content_type = 'video/mp4'; },
    account: (d) => { d.account_ref = 'another-account'; },
    subject: (d) => { d.subject = { kind: 'product', ref: 'other', label: 'Autre' }; },
  };
  for (const [name, tamper] of Object.entries(tampers)) {
    const r = rig();
    const p = await scheduledPost(r);
    const doc = readPost(r, p.id); tamper(doc);
    doc.approval.content_hash = contentHashOf(doc); // the attacker knows the hashing: the SIGNATURE is what he cannot recompute
    writePost(r, p.id, doc);
    await publishDue(r);
    assert.equal(calls(r), 0, name);
    const after = await r.service.get(p.id);
    assert.notEqual(after.state, 'PUBLISHED', name);
    assert.equal(r.integrity.verifyApproval({ ...after }), false, name);
  }
});

test('IN-3b the simplest attack: change the text and leave the genuine signed approval untouched -> refused (the approval must cover the post AS IT IS NOW)', async () => {
  const r = rig();
  const p = await scheduledPost(r);
  const doc = readPost(r, p.id); doc.caption = 'Texte modifié sur le disque, approbation intacte.'; writePost(r, p.id, doc);
  assert.equal(r.integrity.verifyApproval(doc), false);
  await publishDue(r);
  assert.equal(calls(r), 0);
});

test('IN-4 the identity of the approver and the time of approval are signed: changing either voids the approval', async () => {
  for (const [name, tamper] of Object.entries({
    approver: (d) => { d.approval.approved_by = 'someone:else'; },
    approver_as_owner_impersonation: (d) => { d.approval.approved_by = 'owner:habb-2'; },
    approved_at: (d) => { d.approval.approved_at = '2026-10-17T08:00:01.000Z'; },
    key_id: (d) => { d.approval.key_id = 'ffffffffffff'; },
    duplicate_acknowledgement_injected: (d) => { d.approval.duplicate_ack = { of: ['post_x'], note: 'forged acknowledgement' }; },
  })) {
    const r = rig();
    const p = await scheduledPost(r);
    const doc = readPost(r, p.id); tamper(doc); writePost(r, p.id, doc);
    await publishDue(r);
    assert.equal(calls(r), 0, name);
  }
});

test('IN-5 an approval copied from another post (same text, other post) is worthless: the post id is signed', async () => {
  const r = rig();
  const a = await scheduledPost(r);
  const b = await r.service.createPost(postInput({ caption: 'Un autre texte pour b.' }), AGENT);
  const docA = readPost(r, a.id); const docB = readPost(r, b.id);
  // make b look identical to a, then graft a's whole approval onto it
  docB.caption = docA.caption; docB.hashtags = docA.hashtags; docB.asset = docA.asset; docB.publish_at = docA.publish_at; docB.state = 'SCHEDULED'; docB.approval = { ...docA.approval };
  writePost(r, b.id, docB);
  assert.equal(r.integrity.verifyApproval(docB), false);
  r.clock.now = DUE; await r.publisher.publishOne(b.id);
  assert.equal(calls(r), 0);
});

test('IN-6 the genuine path still works: owner approval -> signed -> valid -> published once; restart with the same key ring keeps every approval valid; another key (lost or replaced key) fails CLOSED', async () => {
  const r = rig();
  const p = await scheduledPost(r);
  const stored = readPost(r, p.id);
  assert.match(stored.approval.sig, /^[0-9a-f]{64}$/);
  assert.equal(stored.approval.key_id, r.integrity.keyId);
  assert.equal(r.integrity.verifyApproval(stored), true);
  const restarted = createFileKeyring({ keyDir: r.keyDir, dataDir: r.dir }); // a new process reads the same key
  assert.equal(restarted.keyId, r.integrity.keyId);
  assert.equal(restarted.verifyApproval(stored), true);
  const stranger = createFileKeyring({ keyDir: join(r.root, 'other-keys'), dataDir: r.dir });
  assert.notEqual(stranger.keyId, r.integrity.keyId);
  assert.equal(stranger.verifyApproval(stored), false, 'a different key never validates our approvals');
  await publishDue(r);
  assert.equal(calls(r), 1);
});

test('IN-7 the key lives OUTSIDE the data folder: a key folder inside the data folder (or around it) is refused, and no data file ever contains the key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'social-integrity-k-'));
  const dir = join(root, 'data'); mkdirSync(dir, { recursive: true });
  assert.throws(() => createFileKeyring({ keyDir: join(dir, 'keys'), dataDir: dir }), (e) => e.code === 'SOCIAL_INTEGRITY');
  assert.throws(() => createFileKeyring({ keyDir: dir, dataDir: dir }), (e) => e.code === 'SOCIAL_INTEGRITY');
  assert.throws(() => createFileKeyring({ keyDir: root, dataDir: dir }), (e) => e.code === 'SOCIAL_INTEGRITY', 'a key folder that CONTAINS the data folder is refused too');
  const r = rig();
  await scheduledPost(r);
  await publishDue(r);
  const keyHex = readFileSync(join(r.keyDir, 'approval.key'), 'utf8').trim();
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(r.dir)) assert.equal(readFileSync(f, 'utf8').includes(keyHex), false, `${f} must not contain the key`);
  const described = JSON.stringify(r.integrity.describe());
  assert.equal(described.includes(keyHex), false);
  assert.equal(described.includes(keyHex.slice(0, 20)), false);
  assert.equal(JSON.stringify(Object.entries(r.integrity)).includes(keyHex), false);
  assert.equal(defaultKeyDir({ SOCIAL_KEY_DIR: join(r.root, 'x') }).startsWith(r.root), true);
});

test('IN-8 rights of the key: owner-only. POSIX: mode 0600 and a world-readable key is refused. Windows: inherited rights removed, only the current user listed', async () => {
  const r = rig();
  const file = join(r.keyDir, 'approval.key');
  if (process.platform === 'win32') {
    assert.equal(r.integrity.describe().hardened, true, 'the operating system accepted the owner-only rights');
    const out = spawnSync('icacls', [file], { encoding: 'utf8' }).stdout;
    assert.equal(/Everyone|BUILTIN\\Users|Authenticated Users|NT AUTHORITY\\Authenticated/i.test(out), false, `broad groups still have rights on the key: ${out}`);
    assert.ok(new RegExp(String(process.env.USERNAME).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(out), 'the current user keeps access');
  } else {
    assert.equal(statSync(file).mode & 0o077, 0);
    const { chmodSync } = await import('node:fs');
    chmodSync(file, 0o644);
    assert.throws(() => createFileKeyring({ keyDir: r.keyDir, dataDir: r.dir }), (e) => e.code === 'SOCIAL_INTEGRITY');
  }
});

test('IN-9 two processes creating the key at the same moment end up with ONE key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'social-integrity-race-'));
  const keyDir = join(root, 'keys'); const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const script = join(root, 'k.mjs');
  writeFileSync(script, `import { createFileKeyring } from ${JSON.stringify(new URL('../src/social/integrity.js', import.meta.url).href)};
    const go = Number(process.argv[2]); while (Date.now() < go) {}
    console.log(createFileKeyring({ keyDir: ${JSON.stringify(keyDir)}, dataDir: ${JSON.stringify(dataDir)} }).keyId);`);
  const go = Date.now() + 1200;
  const ids = await Promise.all([0, 1, 2, 3].map(() => new Promise((resolve) => {
    const c = spawn(process.execPath, [script, String(go)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => resolve(out.trim()));
  })));
  assert.equal(new Set(ids).size, 1, `key ids: ${ids}`);
  assert.match(ids[0], /^[0-9a-f]{12}$/);
});

test('IN-10 the owner phone API signs through the same service: an approval obtained over HTTP carries a valid signature, and the API shows the key id but never the key', async () => {
  const { createSocialApp } = await import('../src/social/server/app.js');
  const { default: http } = await import('node:http');
  const r = rig();
  const post = await r.service.createPost(postInput(), AGENT); await r.service.act(post.id, 'submit', AGENT);
  const app = createSocialApp({ token: 't'.repeat(40), service: r.service, publisher: r.publisher, publishers: r.publishers, assets: null, uiDir: join(process.cwd(), 'src', 'social', 'ui') });
  const srv = http.createServer(app.handler); await new Promise((res) => { srv.listen(0, '127.0.0.1', res); });
  const call = (path, method = 'GET', body) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: srv.address().port, path, method, headers: { 'x-social-token': 't'.repeat(40), 'content-type': 'application/json' } }, (resp) => { let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => res({ status: resp.statusCode, body: JSON.parse(d) })); }); q.on('error', rej); if (body) q.write(JSON.stringify(body)); q.end(); });
  const hash = r.service.contentHashOf(await r.service.get(post.id));
  const approved = await call(`/api/posts/${post.id}/act`, 'POST', { action: 'approve', params: { expected_hash: hash, integrity: 'attacker-supplied', duplicate_ack: { of: ['x'], note: 'attacker supplied' } } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approval_valid, true);
  assert.equal(r.integrity.verifyApproval(await r.service.get(post.id)), true);
  assert.equal(readPost(r, post.id).approval.duplicate_ack, undefined, 'a client cannot smuggle an acknowledgement through params');
  const state = await call('/api/state');
  assert.equal(state.body.integrity.persistent, true);
  assert.equal(JSON.stringify(state.body).includes(readFileSync(join(r.keyDir, 'approval.key'), 'utf8').trim()), false);
  await new Promise((res) => { srv.close(res); });
});
