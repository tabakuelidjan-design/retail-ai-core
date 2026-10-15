// China Sourcing permanent deployment: the backup can really be restored; the phone asks to keep its storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, restore, verify } from '../tools/sourcing-backup.mjs';

const ENV = { SOURCING_BACKUP_PASSPHRASE: 'a test passphrase, not a secret' };

// The hosted mode (Core identity sign-in, no development token) is covered by test/sourcing-hosted-identity.test.js.

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
