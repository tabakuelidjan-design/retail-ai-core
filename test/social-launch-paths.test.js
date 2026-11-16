import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSocialService } from '../src/social/service.js';
import { createFileStore } from '../src/social/store.js';
import { createPublisher } from '../src/social/publisher.js';
import { createInstagramPublisher } from '../src/social/providers/meta.js';
import { createFileKeyring } from '../src/social/integrity.js';
import { createSocialApp } from '../src/social/server/app.js';
import { startSocialServer } from '../src/social/server/index.js';
import { contentHashOf } from '../src/social/post.js';
import {
  AGENT, OWNER, T0, createFakeHttp, credentials, igRoutes, media, postInput,
} from './social-fixtures.js';

// E-P1 priority 3: the two ways a publication can start (the server's timer, and POST /api/run) go through the same guarded path. Temp folders, fake platform, no network.
const DUE = Date.parse('2026-10-17T17:05:00Z');
const TOKEN = 't'.repeat(40);

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'social-launch-'));
  const dir = join(root, 'data'); const keyDir = join(root, 'keys');
  mkdirSync(dir, { recursive: true });
  const integrity = createFileKeyring({ keyDir, dataDir: dir });
  const fake = createFakeHttp(igRoutes());
  const clock = { now: T0 };
  const publishers = { instagram: createInstagramPublisher({ http: fake, graphVersion: 'v25.0', credentials: credentials(), timeoutMs: 5000, sleep: async () => {}, settleWaitMs: 0 }) };
  const service = createSocialService({ store: createFileStore(dir), publishers, clock: () => clock.now, integrity });
  const publisher = createPublisher({ service, publishers, media: media(), clock: () => clock.now, logger: () => {} });
  const app = createSocialApp({ token: TOKEN, service, publisher, publishers, assets: null, uiDir: join(process.cwd(), 'src', 'social', 'ui') });
  return { root, dir, keyDir, integrity, fake, clock, service, publisher, app };
}
const calls = (r) => r.fake.count('POST', '/media_publish');
async function scheduledPost(r, over = {}) {
  const p = await r.service.createPost(postInput(over), AGENT);
  await r.service.act(p.id, 'submit', AGENT);
  const hash = r.service.contentHashOf(await r.service.get(p.id));
  await r.service.act(p.id, 'approve', OWNER, { expected_hash: hash });
  const out = await r.service.act(p.id, 'schedule', OWNER, { expected_hash: hash });
  r.clock.now = DUE;
  return out;
}
async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((res) => { srv.listen(0, '127.0.0.1', res); });
  const call = (path, method = 'GET', token = TOKEN) => new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port: srv.address().port, path, method, headers: token ? { 'x-social-token': token } : {} }, (resp) => {
      let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => res({ status: resp.statusCode, body: d ? JSON.parse(d) : null }));
    });
    q.on('error', rej); q.end();
  });
  try { return await fn(call); } finally { await new Promise((res) => { srv.close(res); }); }
}

test('LP-1 POST /api/run needs the owner token; with it, a due approved post goes out once, and running again changes nothing', async () => {
  const r = rig();
  await scheduledPost(r);
  await withServer(r.app.handler, async (call) => {
    assert.equal((await call('/api/run', 'POST', null)).status, 401);
    assert.equal((await call('/api/run', 'POST', 'x'.repeat(40))).status, 401);
    assert.equal(calls(r), 0);
    assert.equal((await call('/api/run', 'POST')).status, 200);
    assert.equal((await call('/api/run', 'POST')).status, 200);
    assert.equal(calls(r), 1);
  });
});

test('LP-2 the timer path and /api/run firing at the same moment (many times) publish once', async () => {
  const r = rig();
  await scheduledPost(r);
  await withServer(r.app.handler, async (call) => {
    await Promise.all([
      call('/api/run', 'POST'), r.publisher.runDue(), call('/api/run', 'POST'), r.publisher.runDue(), call('/api/run', 'POST'), r.publisher.runDue(),
    ]);
    assert.equal(calls(r), 1);
  });
});

test('LP-3 neither path publishes a post whose authorisation does not hold (forged state)', async () => {
  const r = rig();
  r.clock.now = DUE;
  const forged = await r.service.createPost(postInput({ caption: 'Brouillon jamais approuvé.' }), AGENT);
  const file = join(r.dir, 'posts', `${forged.id}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.state = 'SCHEDULED'; doc.approval = { approved_by: 'owner:habb', approved_at: '2026-10-17T08:00:00.000Z', content_hash: contentHashOf(doc) };
  writeFileSync(file, JSON.stringify(doc, null, 2));
  await withServer(r.app.handler, async (call) => {
    await call('/api/run', 'POST'); await r.publisher.runDue();
    assert.equal(calls(r), 0);
    assert.equal((await r.service.get(forged.id)).publication.last_error, 'NO_VALID_APPROVAL');
  });
});

test('LP-4 the real server entry point starts with a key folder OUTSIDE the data folder, signs approvals with it, and refuses a key folder inside the data folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'social-server-'));
  const dir = join(root, 'data'); const keyDir = join(root, 'keys');
  const logs = [];
  const s = await startSocialServer({ env: { SOCIAL_KEY_DIR: keyDir, SOCIAL_PORT: '0' }, dir, port: 0, log: (l) => logs.push(l), tickMs: 3_600_000 });
  try {
    const res = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { 'x-social-token': s.token } }, (resp) => { let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
    });
    assert.equal(res.integrity.persistent, true);
    assert.equal(JSON.stringify(res).includes(readFileSync(join(keyDir, 'approval.key'), 'utf8').trim()), false);
    assert.equal(logs.join('\n').includes(readFileSync(join(keyDir, 'approval.key'), 'utf8').trim()), false, 'the key is never logged');
  } finally { await s.close(); }
  await assert.rejects(() => startSocialServer({ env: { SOCIAL_KEY_DIR: join(dir, 'keys-inside') }, dir, port: 0, log: () => {}, tickMs: 3_600_000 }), (e) => e.code === 'SOCIAL_INTEGRITY');
});
