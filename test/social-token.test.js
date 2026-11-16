import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureOwnerToken } from '../src/social/token-store.js';
import { startSocialServer } from '../src/social/server/index.js';

// The owner's access token must not sit in clear text in the DATA folder. Temp folders only: no real data, no network.
const folders = () => {
  const root = mkdtempSync(join(tmpdir(), 'social-token-'));
  const dir = join(root, 'data'); const keyDir = join(root, 'keys');
  mkdirSync(dir, { recursive: true }); mkdirSync(keyDir, { recursive: true });
  return { root, dir, keyDir };
};
const filesUnder = (d) => readdirSync(d, { recursive: true }).map((f) => join(d, String(f))).filter((f) => statSync(f).isFile());
const dataContains = (dir, secret) => filesUnder(dir).some((f) => readFileSync(f).includes(secret));
const get = (port, path, token) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers: token ? { 'x-social-token': token } : {} }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).on('error', reject);
});

test('TK-1 a new token is created in the KEY folder: nothing in the data folder, and the same token comes back at the next start', () => {
  const f = folders();
  const a = ensureOwnerToken({ env: {}, keyDir: f.keyDir, dataDir: f.dir });
  assert.equal(a.source, 'key-folder');
  assert.ok(a.token.length >= 24);
  assert.equal(existsSync(join(f.dir, 'token.txt')), false);
  assert.equal(dataContains(f.dir, a.token), false);
  assert.equal(readFileSync(join(f.keyDir, 'owner.token'), 'utf8').trim(), a.token);
  assert.equal(ensureOwnerToken({ env: {}, keyDir: f.keyDir, dataDir: f.dir }).token, a.token);
});

test('TK-2 a legacy token.txt in the data folder is migrated once (same value: the phone keeps working) and removed from the data folder', () => {
  const f = folders();
  const legacy = 'legacy-token-0123456789abcdef0123456789';
  writeFileSync(join(f.dir, 'token.txt'), `${legacy}\n`);
  const a = ensureOwnerToken({ env: {}, keyDir: f.keyDir, dataDir: f.dir });
  assert.equal(a.token, legacy);
  assert.equal(a.migrated, true);
  assert.equal(existsSync(join(f.dir, 'token.txt')), false);
  assert.equal(dataContains(f.dir, legacy), false);
  assert.equal(readFileSync(join(f.keyDir, 'owner.token'), 'utf8').trim(), legacy);
  const again = ensureOwnerToken({ env: {}, keyDir: f.keyDir, dataDir: f.dir });
  assert.equal(again.token, legacy); assert.equal(again.migrated, false);
});

test('TK-3 SOCIAL_TOKEN from the environment: nothing is written anywhere; a too-short one is ignored', () => {
  const f = folders();
  const secret = 'env-token-0123456789abcdef0123456789';
  const a = ensureOwnerToken({ env: { SOCIAL_TOKEN: secret }, keyDir: f.keyDir, dataDir: f.dir });
  assert.equal(a.source, 'env'); assert.equal(a.token, secret); assert.equal(a.file, null);
  assert.deepEqual(filesUnder(f.root), []);
  const b = ensureOwnerToken({ env: { SOCIAL_TOKEN: 'short' }, keyDir: f.keyDir, dataDir: f.dir });
  assert.equal(b.source, 'key-folder'); assert.notEqual(b.token, 'short');
});

test('TK-4 a half-written or too-short token file is refused, not used', () => {
  const f = folders();
  writeFileSync(join(f.keyDir, 'owner.token'), 'abc\n');
  assert.throws(() => ensureOwnerToken({ env: {}, keyDir: f.keyDir, dataDir: f.dir }), (e) => e.code === 'SOCIAL_INTEGRITY');
});

test('TK-5 POSIX: a token file readable by other users is refused', { skip: process.platform === 'win32' }, () => {
  const f = folders();
  ensureOwnerToken({ env: {}, keyDir: f.keyDir, dataDir: f.dir });
  chmodSync(join(f.keyDir, 'owner.token'), 0o644);
  assert.throws(() => ensureOwnerToken({ env: {}, keyDir: f.keyDir, dataDir: f.dir }), (e) => e.code === 'SOCIAL_INTEGRITY');
});

test('TK-6 the real server: legacy token migrated, the same token still opens the API, no token in the data folder nor in the logs, a wrong one is refused', async () => {
  const f = folders();
  const legacy = 'legacy-token-fedcba9876543210fedcba9876';
  writeFileSync(join(f.dir, 'token.txt'), `${legacy}\n`);
  const logs = [];
  const s = await startSocialServer({ env: { SOCIAL_KEY_DIR: f.keyDir }, dir: f.dir, port: 0, log: (l) => logs.push(l), tickMs: 3_600_000 });
  try {
    assert.equal(s.token, legacy);
    assert.equal(await get(s.port, '/api/state', legacy), 200);
    assert.equal(await get(s.port, '/api/state', 'wrong-token-wrong-token-wrong'), 401);
    assert.equal(await get(s.port, '/api/state', null), 401);
    assert.equal(dataContains(f.dir, legacy), false, 'no copy of the token left in the data folder');
    assert.equal(logs.join('\n').includes(legacy), false, 'the token is never logged');
    assert.match(logs.join('\n'), /owner\.token/);
  } finally { await s.close(); }
});
