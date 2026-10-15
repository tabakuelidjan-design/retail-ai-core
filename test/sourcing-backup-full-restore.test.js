// A REAL restore drill of the hosted server's whole data directory (docs/integration/COORDINATION.md, point d): a running server
// holds a case, its photo and Nordla Core decisions; the directory is backed up (encrypted), restored into an EMPTY directory, and a
// NEW server started on the restored copy serves the same case, the same photo (hash re-checked) and the same Core journal (chain
// re-verified). A changed byte in the archive is refused; a restore never writes into a non-empty directory. Nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../src/sourcing/server/index.js';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { backup, restore, verify } from '../tools/sourcing-backup.mjs';
import { NOW, ident, traits, importer, commercial } from './sourcing-fixtures.js';

const TOKEN = 'r'.repeat(40);
const ENV = { SOURCING_TOKEN: TOKEN, SOURCING_MERCHANT_ID: 'habb', SOURCING_BACKUP_PASSPHRASE: 'restore drill passphrase 2026' };
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8=';
const start = (dir) => startSourcingServer({ env: ENV, dir, log: () => {}, port: 0, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) });
const call = (port, method, path, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'x-sourcing-token': TOKEN, 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}) } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
  r.on('error', reject); if (data) r.write(data); r.end();
});
const stop = async (s) => { await new Promise((r) => s.server.close(r)); s.server.closeAllConnections?.(); };

test('restore drill: cases + photos + Core journal come back identical on a new server; a tampered archive is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nordla-restore-drill-'));
  try {
    const live = join(root, 'live'); const out = join(root, 'backups'); const restored = join(root, 'restored');
    let c = newCase({ id: 'drill-1', name: 'x', now: NOW }); for (const e of [...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, ...commercial({ unitPrice: 4.2, qty: 1000, moq: 500 })]) c = dispatch(c, e, NOW);
    const a = await start(live);
    let decision;
    try {
      assert.equal((await call(a.port, 'PUT', '/api/cases/drill-1', c)).status, 200);
      assert.equal((await call(a.port, 'PUT', '/api/cases/drill-1/photos/photo%3Adrill-1.0', { dataUrl: PHOTO })).body.status, 'STORED');
      decision = (await call(a.port, 'POST', '/api/core/cases/drill-1/analyse')).body.decision;
      assert.ok(decision?.id, 'the Core is on and analysed the case');
      assert.equal((await call(a.port, 'POST', `/api/core/decisions/${decision.id}/human`, { decision: 'DEFERRED', reason: 'restore drill' })).status, 200);
    } finally { await stop(a); }

    const { file } = await backup(live, out, { env: ENV });
    assert.ok((await verify(file, { env: ENV })).ok !== false);
    // one changed byte: refused, nothing restored
    const raw = await readFile(file); const bad = Buffer.from(raw); bad[bad.length - 5] ^= 0xff; const badFile = join(out, 'tampered.nsb'); await writeFile(badFile, bad);
    await assert.rejects(restore(badFile, join(root, 'never'), { env: ENV }));
    await assert.rejects(readdir(join(root, 'never')), { code: 'ENOENT' });
    // a restore never writes into a non-empty directory
    await assert.rejects(restore(file, live, { env: ENV }));

    await restore(file, restored, { env: ENV });
    const b = await start(restored);
    try {
      const got = (await call(b.port, 'GET', '/api/cases/drill-1')).body;
      assert.equal(got.id, 'drill-1'); assert.equal(got.identity.workingName, 'Bamboo kitchen organiser');
      const photo = (await call(b.port, 'GET', '/api/cases/drill-1/photos/photo%3Adrill-1.0')).body;
      assert.equal(photo.dataUrl, PHOTO, 'the photo comes back byte for byte (its hash is re-checked on read)');
      const st = (await call(b.port, 'GET', '/api/core/status')).body;
      assert.equal(st.enabled, true, 'the restored Core journal verifies (hash chain)');
      const list = (await call(b.port, 'GET', '/api/core/decisions?case=drill-1')).body.decisions;
      assert.equal(list.length, 1); assert.equal(list[0].id, decision.id); assert.equal(list[0].human_decision.decision, 'DEFERRED');
    } finally { await stop(b); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- the off-server copy (a private Supabase Storage bucket), with an in-memory double of the Storage API
function fakeStorage() {
  const objects = new Map(); const seen = [];
  const fetchImpl = async (url, { method = 'GET', headers = {}, body } = {}) => {
    seen.push({ url, method, auth: headers.authorization, upsert: headers['x-upsert'] });
    const key = new URL(url).pathname.replace('/storage/v1/object/', '');
    if (headers.authorization !== 'Bearer service-key') return new Response('{}', { status: 403 });
    if (method === 'POST') { if (objects.has(key)) return new Response('{"error":"Duplicate"}', { status: 409 }); objects.set(key, Buffer.from(body)); return new Response('{}', { status: 200 }); }
    return objects.has(key) ? new Response(objects.get(key), { status: 200 }) : new Response('{}', { status: 404 });
  };
  return { objects, seen, fetchImpl };
}
const OFF = { ...ENV, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SOURCING_BACKUP_BUCKET: 'nordla-backups' };

test('off-server copy: uploaded encrypted, never overwritten; downloaded, verified and restored; the daily run logs and never throws', async () => {
  const { backupAndShip, downloadOffsite, uploadOffsite } = await import('../tools/sourcing-backup.mjs');
  const { scheduleBackups } = await import('../src/sourcing/server/index.js');
  const root = await mkdtemp(join(tmpdir(), 'nordla-offsite-'));
  try {
    const data = join(root, 'data');
    const { mkdir } = await import('node:fs/promises'); await mkdir(join(data, 'cases'), { recursive: true }); await writeFile(join(data, 'cases', 'c1.json'), '{"id":"c1"}');
    const st = fakeStorage();
    const r = await backupAndShip(data, join(root, 'local'), { env: OFF, fetchImpl: st.fetchImpl });
    assert.equal(st.objects.size, 1); assert.ok(st.objects.has(`nordla-backups/${r.offsite}`));
    assert.ok(!st.objects.get(`nordla-backups/${r.offsite}`).includes(Buffer.from('"id":"c1"')), 'what leaves the server is encrypted');
    assert.equal(st.seen[0].upsert, 'false');
    await assert.rejects(uploadOffsite(r.file, { env: OFF, fetchImpl: st.fetchImpl }), { code: 'OFFSITE_EXISTS_OR_REFUSED' }, 'never overwritten');
    await assert.rejects(uploadOffsite(r.file, { env: { ...OFF, SOURCING_BACKUP_BUCKET: '' }, fetchImpl: st.fetchImpl }), { code: 'OFFSITE_NOT_CONFIGURED' });
    const got = await downloadOffsite(r.offsite, join(root, 'downloaded'), { env: OFF, fetchImpl: st.fetchImpl });
    await restore(got.file, join(root, 'restored'), { env: OFF });
    assert.equal(await readFile(join(root, 'restored', 'cases', 'c1.json'), 'utf8'), '{"id":"c1"}');
    // scheduler: not configured -> says so; configured -> a failing run is logged, never thrown
    const logs = [];
    assert.equal(await scheduleBackups({ env: ENV, dir: data, log: (m) => logs.push(m) }).runNow(), null); assert.match(logs[0], /NOT scheduled/);
    const s = scheduleBackups({ env: OFF, dir: data, log: (m) => logs.push(m), run: async () => { throw Object.assign(new Error('bucket unreachable'), { code: 'OFFSITE_UPLOAD_FAILED' }); } });
    assert.equal(await s.runNow(), null); s.stop(); assert.match(logs.at(-1), /Backup FAILED \(OFFSITE_UPLOAD_FAILED\).*data is untouched/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scheduled run on the server: few local copies by default (the volume is shared), a real run writes the local archive even when the off-server copy fails', async () => {
  const { scheduleBackups } = await import('../src/sourcing/server/index.js');
  const root = await mkdtemp(join(tmpdir(), 'nordla-sched-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    const data = join(root, 'sourcing'); await mkdir(join(data, 'cases'), { recursive: true }); await writeFile(join(data, 'cases', 'c1.json'), '{"id":"c1"}');
    const logs = []; const env = { ...OFF, SUPABASE_URL: 'http://127.0.0.1:9', SOURCING_BACKUP_DIR: join(root, 'local') };
    const s = scheduleBackups({ env, dir: data, log: (m) => logs.push(m) }); s.stop();
    assert.match(logs[0], / 3 local copies /);
    scheduleBackups({ env: { ...env, SOURCING_BACKUP_KEEP: '5' }, dir: data, log: (m) => logs.push(m) }).stop(); assert.match(logs[1], / 5 local copies /);
    assert.equal(await s.runNow(), null, 'the off-server copy cannot be sent here: logged, not thrown');
    assert.match(logs.at(-1), /Backup FAILED .*data is untouched/);
    assert.equal((await readdir(join(root, 'local'))).filter((n) => n.endsWith('.nsb')).length, 1, 'the local encrypted archive exists');
  } finally { await rm(root, { recursive: true, force: true }); }
});
