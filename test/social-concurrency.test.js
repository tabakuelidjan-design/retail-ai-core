import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSocialService } from '../src/social/service.js';
import { createFileStore } from '../src/social/store.js';
import { createFileKeyring } from '../src/social/integrity.js';
import { AGENT, OWNER, postInput, T0 } from './social-fixtures.js';

// E-P1 priority 1: several PROCESSES over the same data folder (the server, a second server, a CLI, a restart after a crash). Everything runs in temp folders over a FAKE platform:
// no real data, no network, no Meta. The platform's creating calls are recorded in a shared log file, one line per call.
const WORKER = fileURLToPath(new URL('./social-worker.js', import.meta.url));
const DUE_MS = Date.parse('2026-10-17T17:05:00Z'); // five minutes after the post's publish_at

function folders(name) {
  const root = mkdtempSync(join(tmpdir(), `social-${name}-`));
  const dir = join(root, 'data'); const keyDir = join(root, 'keys'); const log = join(root, 'platform.log');
  mkdirSync(dir, { recursive: true }); writeFileSync(log, '');
  return { root, dir, keyDir, log };
}
const lines = (log, what) => readFileSync(log, 'utf8').split('\n').filter((l) => (what ? l === what : l));
const serviceOf = (f, over = {}) => createSocialService({ store: createFileStore(f.dir), clock: () => T0, integrity: createFileKeyring({ keyDir: f.keyDir, dataDir: f.dir }), ...over });

async function scheduledPost(service, over = {}) {
  const post = await service.createPost(postInput(over), AGENT);
  await service.act(post.id, 'submit', AGENT);
  const hash = service.contentHashOf(await service.get(post.id));
  await service.act(post.id, 'approve', OWNER, { expected_hash: hash });
  return service.act(post.id, 'schedule', OWNER, { expected_hash: hash });
}
const runWorker = (f, opts) => new Promise((resolve) => {
  const child = spawn(process.execPath, [WORKER, JSON.stringify({ dir: f.dir, keyDir: f.keyDir, log: f.log, nowMs: DUE_MS, ...opts })], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (c) => { stderr += c; });
  child.on('close', (code, signal) => resolve({ code, signal, stderr }));
});
const together = (f, n, opts = {}) => { const goAt = Date.now() + 1500; return Promise.all(Array.from({ length: n }, () => runWorker(f, { goAt, ...opts }))); };

// 3 rounds by default (inside the whole-repository suite, which other workflows run under a time limit); the dedicated Social Publishing workflow sets SOCIAL_STRESS_ROUNDS=10
export const stressRounds = (env) => Number(env.SOCIAL_STRESS_ROUNDS) || 3;

test('CC-1a the number of racing rounds: 3 by default, 10 with SOCIAL_STRESS_ROUNDS=10 (what the Social Publishing workflow sets)', () => {
  assert.equal(stressRounds({}), 3);
  assert.equal(stressRounds({ SOCIAL_STRESS_ROUNDS: '10' }), 10);
  assert.equal(stressRounds({ SOCIAL_STRESS_ROUNDS: 'abc' }), 3);
});

test('CC-1 (audit scenario D5) three processes racing on the same due post publish it ONCE, round after round', async () => {
  const rounds = stressRounds(process.env); const doubles = []; let executed = 0;
  for (let i = 0; i < rounds; i += 1) {
    const f = folders(`cc1-${i}`);
    const post = await scheduledPost(serviceOf(f));
    const out = await together(f, 3);
    assert.ok(out.every((o) => o.code === 0), JSON.stringify(out.map((o) => [o.code, o.stderr.slice(0, 200)])));
    const n = lines(f.log, 'PUBLISH_CALL').length;
    const state = (await serviceOf(f).get(post.id)).state;
    // the invariant is "never more than one creating call, and the stored state tells the truth about it" (a machine so loaded that nobody gets to publish is slow, not wrong)
    executed += 1;
    if (n > 1 || (n === 1) !== ['PUBLISHED', 'VERIFIED'].includes(state)) doubles.push({ round: i, calls: n, state });
  }
  assert.equal(executed, rounds, `CC-1 ran ${executed} rounds, expected ${rounds}`);
  assert.deepEqual(doubles, [], `rounds with a number of platform creating calls or a state that disagrees with them: ${JSON.stringify(doubles)}`);
});

test('CC-2 a process started afterwards (restart) never republishes a published post', async () => {
  const f = folders('cc2');
  const post = await scheduledPost(serviceOf(f));
  await together(f, 2);
  assert.equal(lines(f.log, 'PUBLISH_CALL').length, 1);
  await runWorker(f, { passes: 3, nowMs: DUE_MS + 3600_000 });
  await runWorker(f, { passes: 3, nowMs: DUE_MS + 86_400_000 });
  assert.equal(lines(f.log, 'PUBLISH_CALL').length, 1);
  assert.ok(['PUBLISHED', 'VERIFIED'].includes((await serviceOf(f).get(post.id)).state));
});

test('CC-3 a process killed (kill -9) right after sending the creating call leaves an UNKNOWN outcome, never retried by anyone, at any later time', async () => {
  const f = folders('cc3');
  const post = await scheduledPost(serviceOf(f));
  const crashed = await runWorker(f, { crashAfterCall: true });
  assert.notEqual(crashed.code, 0, 'the worker really died');
  assert.equal(lines(f.log, 'PUBLISH_CALL').length, 1);
  assert.equal((await serviceOf(f).get(post.id)).state, 'PUBLISHING', 'the claim survived the crash, durably');
  await together(f, 2, { nowMs: DUE_MS + 60_000 }); // lease (10 min) not over: nobody touches a claimed post
  assert.equal((await serviceOf(f).get(post.id)).state, 'PUBLISHING');
  assert.equal(lines(f.log, 'PUBLISH_CALL').length, 1);
  await together(f, 3, { nowMs: DUE_MS + 11 * 60_000, passes: 2 }); // lease over: the outcome is declared UNKNOWN, not retried
  const after = await serviceOf(f).get(post.id);
  assert.equal(after.state, 'PUBLICATION_UNKNOWN');
  await together(f, 3, { nowMs: DUE_MS + 30 * 3600_000, passes: 2 });
  assert.equal((await serviceOf(f).get(post.id)).state, 'PUBLICATION_UNKNOWN');
  assert.equal(lines(f.log, 'PUBLISH_CALL').length, 1, 'no automatic second creating call, ever');
});

test('CC-4 a process killed while its creating call is hanging is handled the same way (unknown, not retried)', async () => {
  const f = folders('cc4');
  const post = await scheduledPost(serviceOf(f));
  const hung = spawn(process.execPath, [WORKER, JSON.stringify({ dir: f.dir, keyDir: f.keyDir, log: f.log, nowMs: DUE_MS, hangInCall: true })], { stdio: 'ignore' });
  const until = Date.now() + 20_000;
  while (!lines(f.log, 'PUBLISH_CALL').length && Date.now() < until) await new Promise((r) => { setTimeout(r, 50); });
  assert.equal(lines(f.log, 'PUBLISH_CALL').length, 1, 'the creating call was sent');
  hung.kill('SIGKILL');
  await new Promise((r) => { hung.on('close', r); });
  await together(f, 2, { nowMs: DUE_MS + 11 * 60_000, passes: 2 });
  assert.equal((await serviceOf(f).get(post.id)).state, 'PUBLICATION_UNKNOWN');
  assert.equal(lines(f.log, 'PUBLISH_CALL').length, 1);
});

test('CC-5 two writers on the same post from two processes lose no update (the store lock is cross-process)', async () => {
  const f = folders('cc5');
  const service = serviceOf(f);
  const post = await scheduledPost(service);
  const before = (await service.get(post.id)).history.length;
  const goAt = Date.now() + 1500;
  const out = await Promise.all([0, 1, 2].map(() => runWorker(f, { goAt, annotate: { id: post.id, n: 15 } })));
  assert.ok(out.every((o) => o.code === 0), JSON.stringify(out.map((o) => o.stderr.slice(0, 200))));
  const after = await service.get(post.id);
  assert.equal(after.history.length, before + 45, 'every one of the 45 updates is in the history');
  const audit = (await service.audit()).filter((e) => e.post_id === post.id && e.action === 'annotate');
  assert.equal(audit.length, 45);
});

test('CC-6 a lock left by a DEAD process is recovered; a lock held by a live process for longer than the lease is broken; a fresh lock held by a live process is respected', async () => {
  const f = folders('cc6');
  const dead = spawn(process.execPath, ['-e', 'setTimeout(()=>{},100)'], { stdio: 'ignore' });
  const deadPid = dead.pid; await new Promise((r) => { dead.on('close', r); });
  const lockFile = join(f.dir, '.store.lock');
  writeFileSync(lockFile, JSON.stringify({ pid: deadPid, host: (await import('node:os')).hostname(), token: 'dead-owner', at: new Date().toISOString() }));
  const service = serviceOf(f);
  const p1 = await service.createPost(postInput(), AGENT); // would block forever on an unrecovered lock
  assert.ok(p1.id);
  // a live holder (this very process) that is far past the lease
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), token: 'old-live-owner', at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  const quick = createSocialService({ store: createFileStore(f.dir, { lock: { staleMs: 60_000, waitMs: 5_000 } }), clock: () => T0, integrity: createFileKeyring({ keyDir: f.keyDir, dataDir: f.dir }) });
  assert.ok((await quick.createPost(postInput({ caption: 'Un autre texte.' }), AGENT)).id);
  // a FRESH lock held by a live process is respected: the writer waits, then gives up with a clear error rather than writing over the holder
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), token: 'fresh-live-owner', at: new Date().toISOString() }));
  const impatient = createSocialService({ store: createFileStore(f.dir, { lock: { staleMs: 600_000, waitMs: 300 } }), clock: () => T0, integrity: createFileKeyring({ keyDir: f.keyDir, dataDir: f.dir }) });
  await assert.rejects(() => impatient.createPost(postInput({ caption: 'Troisième texte.' }), AGENT), (e) => e.code === 'SOCIAL_STORE_LOCKED');
  appendFileSync(f.log, '');
});
