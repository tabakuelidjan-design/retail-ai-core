// Isolated, immutable backup copy (Backblaze B2 Object Lock, owner decision): the server's key may ONLY add files, which is checked at every
// upload; the drill (another machine, a read key) restores the newest archive and reports its compliance retention. In-memory B2 double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupAndShip, drillIsolated, uploadIsolated, isolatedConfigured } from '../tools/sourcing-backup.mjs';

const PASS = 'a test passphrase, not a secret';
const fakeB2 = () => {
  const keys = new Map([['writer', { secret: 'w-secret', caps: ['listBuckets', 'listAllBucketNames', 'writeFiles'] }], ['admin', { secret: 'a-secret', caps: ['writeFiles', 'deleteFiles', 'bypassGovernance'] }], ['reader', { secret: 'r-secret', caps: ['listFiles', 'readFiles', 'readFileRetentions'] }], ['reader-noret', { secret: 'n-secret', caps: ['listFiles', 'readFiles'] }]]);
  const files = new Map(); const RETAIN = Date.parse('2026-11-15T00:00:00Z'); let n = 0;
  const tokenOf = (t) => [...keys.entries()].find(([id]) => t === `tok-${id}`)?.[1];
  const fetchImpl = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const u = new URL(url);
    if (u.pathname === '/b2api/v2/b2_authorize_account') {
      const [id, secret] = Buffer.from(String(headers.authorization).replace(/^Basic /, ''), 'base64').toString().split(':');
      const k = keys.get(id); if (!k || k.secret !== secret) return new Response('{}', { status: 401 });
      return Response.json({ apiUrl: 'https://api000.b2.example', downloadUrl: 'https://f000.b2.example', authorizationToken: `tok-${id}`, allowed: { capabilities: k.caps, bucketId: null } });
    }
    const k = tokenOf(headers.authorization);
    if (u.host === 'api000.b2.example') {
      if (!k) return new Response('{}', { status: 401 });
      const b = JSON.parse(body);
      if (u.pathname.endsWith('/b2_get_upload_url')) return k.caps.includes('writeFiles') ? Response.json({ uploadUrl: 'https://pod.b2.example/upload', authorizationToken: headers.authorization }) : new Response('{}', { status: 401 });
      if (u.pathname.endsWith('/b2_list_file_versions')) return k.caps.includes('listFiles') ? Response.json({ files: [...files.values()].map((f) => ({ fileName: f.name, fileId: f.id, action: f.action ?? 'upload' })) }) : new Response('{}', { status: 401 });
      if (u.pathname.endsWith('/b2_hide_file')) { if (!k.caps.includes('writeFiles')) return new Response('{}', { status: 401 }); n += 1; files.set(`${b.fileName}#${n}`, { name: b.fileName, id: `id-${n}`, action: 'hide' }); return Response.json({ action: 'hide' }); }
      if (u.pathname.endsWith('/b2_get_file_info')) { const f = [...files.values()].find((x) => x.id === b.fileId); return Response.json({ fileName: f.name, fileRetention: { isClientAuthorizedToRead: k.caps.includes('readFileRetentions'), value: k.caps.includes('readFileRetentions') ? { mode: 'compliance', retainUntilTimestamp: RETAIN } : null } }); }
    }
    if (u.host === 'pod.b2.example') {
      if (!k?.caps.includes('writeFiles')) return new Response('{}', { status: 401 });
      const name = decodeURIComponent(headers['x-bz-file-name']); n += 1; files.set(`${name}#${n}`, { name, id: `id-${n}`, data: Buffer.from(body) }); // B2 keeps every version
      return Response.json({ fileId: `id-${n}`, fileName: name });
    }
    if (u.host === 'f000.b2.example') { if (!k?.caps.includes('readFiles')) return new Response('{}', { status: 401 }); const f = [...files.values()].find((x) => x.id === u.searchParams.get('fileId') && x.data); return f ? new Response(f.data) : new Response('{}', { status: 404 }); }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, files };
};
const SUPA = { SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SOURCING_BACKUP_BUCKET: 'nordla-backups' };
const okSupabase = async (url, init = {}) => (String(url).includes('/storage/v1/object/') ? new Response('{}', { status: 200 }) : null);

test('server side: a Write Only key (writeFiles + bucket listing) adds the archive; a key that could delete or bypass retention is REFUSED before anything is sent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nordla-iso-'));
  try {
    const data = join(root, 'data'); await mkdir(join(data, 'cases'), { recursive: true }); await writeFile(join(data, 'cases', 'c1.json'), '{"v":1}');
    const b2 = fakeB2();
    const both = async (url, init) => (await okSupabase(url, init)) ?? b2.fetchImpl(url, init);
    const env = { SOURCING_BACKUP_PASSPHRASE: PASS, ...SUPA, SOURCING_BACKUP_B2_KEY_ID: 'writer', SOURCING_BACKUP_B2_KEY: 'w-secret', SOURCING_BACKUP_B2_BUCKET_ID: 'bucket-1' };
    assert.equal(isolatedConfigured(env), true); assert.equal(isolatedConfigured(SUPA), false);
    const r = await backupAndShip(data, join(root, 'local'), { env, fetchImpl: both });
    assert.equal(r.isolated, r.offsite); assert.equal(b2.files.size, 1);
    assert.ok(![...b2.files.values()][0].data.includes(Buffer.from('"v":1')), 'encrypted before it leaves');
    const admin = { ...env, SOURCING_BACKUP_B2_KEY_ID: 'admin', SOURCING_BACKUP_B2_KEY: 'a-secret' };
    await assert.rejects(uploadIsolated(r.file, { env: admin, fetchImpl: b2.fetchImpl }), (e) => e.code === 'ISOLATED_KEY_TOO_POWERFUL' && /deleteFiles/.test(e.message) && !e.message.includes('a-secret'));
    assert.equal(b2.files.size, 1, 'nothing was sent with the over-powered key');
    await assert.rejects(uploadIsolated(r.file, { env: { ...env, SOURCING_BACKUP_B2_KEY: 'wrong' }, fetchImpl: b2.fetchImpl }), { code: 'ISOLATED_AUTH_FAILED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('drill (another machine, read key): the newest isolated archive is restored and its COMPLIANCE retention is reported; empty store refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nordla-iso-drill-'));
  try {
    const b2 = fakeB2();
    const reader = { SOURCING_BACKUP_PASSPHRASE: PASS, SOURCING_BACKUP_B2_KEY_ID: 'reader', SOURCING_BACKUP_B2_KEY: 'r-secret', SOURCING_BACKUP_B2_BUCKET_ID: 'bucket-1' };
    await assert.rejects(drillIsolated(join(root, 'd0'), join(root, 'r0'), { env: reader, fetchImpl: b2.fetchImpl }), { code: 'ISOLATED_EMPTY' });
    const data = join(root, 'data'); await mkdir(join(data, 'cases'), { recursive: true });
    const writer = { SOURCING_BACKUP_PASSPHRASE: PASS, SOURCING_BACKUP_B2_KEY_ID: 'writer', SOURCING_BACKUP_B2_KEY: 'w-secret', SOURCING_BACKUP_B2_BUCKET_ID: 'bucket-1' };
    const { backup } = await import('../tools/sourcing-backup.mjs');
    await writeFile(join(data, 'cases', 'c1.json'), '{"v":1}'); const a1 = await backup(data, join(root, 'l'), { env: writer, now: () => new Date('2026-10-16T08:00:00Z') }); await uploadIsolated(a1.file, { env: writer, fetchImpl: b2.fetchImpl });
    await writeFile(join(data, 'cases', 'c1.json'), '{"v":2}'); const a2 = await backup(data, join(root, 'l'), { env: writer, now: () => new Date('2026-10-16T09:00:00Z') }); await uploadIsolated(a2.file, { env: writer, fetchImpl: b2.fetchImpl });
    // a compromised server (writeFiles) HIDES the newest archive by name: the locked version is still found, restored, and the hide is reported
    await b2.fetchImpl('https://api000.b2.example/b2api/v2/b2_hide_file', { method: 'POST', headers: { authorization: 'tok-writer' }, body: JSON.stringify({ bucketId: 'bucket-1', fileName: 'sourcing-20261016T090000Z.nsb' }) });
    const d = await drillIsolated(join(root, 'dl'), join(root, 'restored'), { env: reader, fetchImpl: b2.fetchImpl, now: () => Date.parse('2026-10-16T10:00:00Z') });
    assert.equal(d.archive, 'sourcing-20261016T090000Z.nsb'); assert.equal(d.archives_in_store, 2); assert.equal(d.hidden_markers, 1);
    assert.deepEqual(d.retention, { mode: 'compliance', retain_until: '2026-11-15T00:00:00.000Z', locked_now: true });
    assert.equal(await readFile(join(root, 'restored', 'cases', 'c1.json'), 'utf8'), '{"v":2}');
    // a control key that cannot read retentions: the lock is not assumed
    await assert.rejects(drillIsolated(join(root, 'dl4'), join(root, 'r4'), { env: { ...reader, SOURCING_BACKUP_B2_KEY_ID: 'reader-noret', SOURCING_BACKUP_B2_KEY: 'n-secret' }, fetchImpl: b2.fetchImpl }), { code: 'ISOLATED_RETENTION_UNREADABLE' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
