// China Sourcing permanent deployment: the hosted-mode configuration is complete or nothing starts, and the backup can really be restored.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedConfig, isHosted } from '../src/sourcing/server/hosted.js';
import { startSourcingServer } from '../src/sourcing/server/index.js';
import { backup, restore, verify } from '../tools/sourcing-backup.mjs';

const TOKEN = 'hosted-test-token-0123456789-abcdefgh'; // 37 characters
const OK = { SOURCING_HOSTED: '1', SOURCING_TOKEN: TOKEN, SOURCING_ALLOWED_HOSTS: 'sourcing.example.test', SOURCING_MERCHANT_ID: 'demo' };
const ENV = { SOURCING_BACKUP_PASSPHRASE: 'a test passphrase, not a secret' };

test('hosted mode: opt-in, and every missing piece is refused with its own code', () => {
  assert.equal(isHosted({}), false); assert.equal(isHosted({ SOURCING_HOSTED: '1' }), true);
  assert.deepEqual(hostedConfig(OK), { host: '0.0.0.0', allowedHosts: ['sourcing.example.test'], dataDir: 'data/local/sourcing' });
  assert.throws(() => hostedConfig({ ...OK, SOURCING_TOKEN: 'x'.repeat(31) }), { code: 'HOSTED_TOKEN_REQUIRED' });
  assert.throws(() => hostedConfig({ ...OK, SOURCING_ALLOWED_HOSTS: ' , ' }), { code: 'HOSTED_ALLOWED_HOSTS_REQUIRED' });
  for (const h of ['https://x.test', 'x.test:443', '*.x.test', 'x.test/path', 'localhost']) assert.throws(() => hostedConfig({ ...OK, SOURCING_ALLOWED_HOSTS: h }), { code: 'HOSTED_ALLOWED_HOSTS_INVALID' }, h);
  assert.throws(() => hostedConfig({ ...OK, SOURCING_MERCHANT_ID: '' }), { code: 'HOSTED_MERCHANT_REQUIRED' });
  assert.equal(hostedConfig({ ...OK, SOURCING_MERCHANT_ID: '', SOURCING_MERCHANT_PROFILE: '/x.json' }).host, '0.0.0.0');
});

test('hosted server: refuses an incomplete configuration before listening; when complete, a foreign Host is refused and /healthz carries no data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hosted-'));
  try {
    await assert.rejects(startSourcingServer({ env: { SOURCING_HOSTED: '1', SOURCING_TOKEN: TOKEN }, log: () => {}, port: 0, dir }), { code: 'HOSTED_ALLOWED_HOSTS_REQUIRED' });
    const s = await startSourcingServer({ env: { ...OK, SOURCING_HOST: '127.0.0.1', SOURCING_DATA_DIR: join(dir, 'data') }, log: () => {}, port: 0, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) });
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const health = await fetch(`${base}/healthz`); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true });
      const foreign = await new Promise((ok, ko) => http.get({ port: s.port, host: '127.0.0.1', path: '/api/cases', headers: { host: 'evil.example', 'x-sourcing-token': TOKEN } }, (r) => { r.resume(); ok(r.statusCode); }).on('error', ko));
      assert.equal(foreign, 421, 'a Host that is not the served name is refused (DNS rebinding)');
      const noToken = await fetch(`${base}/api/cases`); assert.equal(noToken.status, 401);
      const ok = await fetch(`${base}/api/cases`, { headers: { 'x-sourcing-token': TOKEN } }); assert.equal(ok.status, 200);
      assert.deepEqual(await readdir(join(dir, 'data')).then((l) => l.filter((f) => f === 'token.txt')), [], 'the hosted server never writes a token file');
    } finally { await new Promise((r) => s.server.close(r)); s.server.closeAllConnections?.(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('backup -> verify -> restore gives back every file byte for byte; a restore never overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nsb-'));
  try {
    const data = join(root, 'data'); await mkdir(join(data, 'cases'), { recursive: true }); await mkdir(join(data, 'safety-gate'), { recursive: true });
    await writeFile(join(data, 'cases', 'case-1.json'), JSON.stringify({ id: 'case-1', rev: 3, notes: ['é', '中文'] }));
    await writeFile(join(data, 'cases', 'case-1.json.123.tmp'), 'half-written');
    await writeFile(join(data, 'safety-gate', 'alerts.json'), Buffer.from([0, 1, 2, 255]));
    const b = await backup(data, join(root, 'out'), { env: ENV, now: () => new Date('2026-10-15T08:00:00.000Z') });
    assert.equal(b.files, 2, 'the interrupted .tmp write is not backed up');
    assert.match(b.file, /sourcing-20261015T080000Z\.nsb$/);
    assert.ok(!(await readFile(b.file)).includes(Buffer.from('case-1')), 'the archive is encrypted');
    assert.equal((await verify(b.file, { env: ENV })).files, 2);
    const back = join(root, 'restored'); await restore(b.file, back, { env: ENV });
    assert.deepEqual(await readFile(join(back, 'cases', 'case-1.json')), await readFile(join(data, 'cases', 'case-1.json')));
    assert.deepEqual(await readFile(join(back, 'safety-gate', 'alerts.json')), Buffer.from([0, 1, 2, 255]));
    await assert.rejects(restore(b.file, back, { env: ENV }), { code: 'RESTORE_TARGET_NOT_EMPTY' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup refusals: no passphrase, wrong passphrase, a changed byte; retention keeps the newest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nsb-'));
  try {
    const data = join(root, 'data'); await mkdir(data); await writeFile(join(data, 'a.json'), '{}');
    await assert.rejects(backup(data, join(root, 'out'), { env: {} }), { code: 'BACKUP_PASSPHRASE_REQUIRED' });
    const b = await backup(data, join(root, 'out'), { env: ENV });
    await assert.rejects(verify(b.file, { env: { SOURCING_BACKUP_PASSPHRASE: 'another passphrase, wrong' } }), { code: 'BACKUP_DECRYPT_FAILED' });
    const bytes = await readFile(b.file); bytes[bytes.length - 1] ^= 1; await writeFile(join(root, 'bad.nsb'), bytes);
    await assert.rejects(verify(join(root, 'bad.nsb'), { env: ENV }), { code: 'BACKUP_DECRYPT_FAILED' });
    await assert.rejects(restore(join(root, 'bad.nsb'), join(root, 'r2'), { env: ENV }), { code: 'BACKUP_DECRYPT_FAILED' });
    await assert.rejects(readdir(join(root, 'r2')), { code: 'ENOENT' }, 'nothing is written from a bad archive');
    for (const h of ['09', '10', '11']) await backup(data, join(root, 'keep'), { env: ENV, keep: 2, now: () => new Date(`2026-10-15T${h}:00:00.000Z`) });
    assert.deepEqual(await readdir(join(root, 'keep')), ['sourcing-20261015T100000Z.nsb', 'sourcing-20261015T110000Z.nsb']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('phone: persistent storage is requested and its outcome reported (Android eviction), never assumed', async () => {
  const { requestPersistentStorage } = await import('../src/sourcing/ui/storage.js');
  assert.equal(await requestPersistentStorage(undefined), 'UNSUPPORTED');
  assert.equal(await requestPersistentStorage({ storage: {} }), 'UNSUPPORTED');
  assert.equal(await requestPersistentStorage({ storage: { persisted: async () => true, persist: async () => { throw new Error('not asked twice'); } } }), 'PERSISTED');
  assert.equal(await requestPersistentStorage({ storage: { persisted: async () => false, persist: async () => true } }), 'PERSISTED');
  assert.equal(await requestPersistentStorage({ storage: { persisted: async () => false, persist: async () => false } }), 'NOT_GRANTED');
  assert.equal(await requestPersistentStorage({ storage: { persist: async () => { throw new Error('blocked'); } } }), 'UNSUPPORTED');
});
