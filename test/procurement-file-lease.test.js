// The Stock / Achats file store as a LEASE (opt-in, used on a Railway volume): a restarted container takes the file back WITHOUT ever deleting the lock of a writer that
// is still alive; two simultaneous starts have exactly one winner; a writer that lost its lock cannot write; a clean stop releases at once; no data is lost.
// Real processes, real files (the lock is about processes: an in-process fake would prove nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openFileProcurementStore } from '../src/procurement/file-store.js';
import { createProcurement } from '../src/procurement/index.js';

const STORE_URL = pathToFileURL(join(import.meta.dirname, '..', 'src', 'procurement', 'index.js')).href;
const FAST = { heartbeatMs: 150, staleMs: 1200, waitMs: 5000, pollMs: 80 };
const M = '11111111-2222-4333-8444-555555555555';
const owner = { id: 'u-owner', role: 'OWNER' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a child process that opens the store with a lease, optionally writes one supplier, announces what happened, then stays alive until killed
function child(path, { lease = FAST, supplier = null } = {}) {
  const code = `
    import { openFileProcurementStore, createProcurement } from ${JSON.stringify(STORE_URL)};
    try {
      const store = await openFileProcurementStore({ path: ${JSON.stringify(path)}, lease: ${JSON.stringify(lease)} });
      const p = createProcurement({ store, merchantId: ${JSON.stringify(M)} });
      ${supplier ? `await p.commands.createSupplier({ id: 'u-owner', role: 'OWNER' }, 'k-child-00001', { name: ${JSON.stringify(supplier)}, country: 'CN', currency: 'USD' });` : ''}
      console.log('OPEN');
      setInterval(() => {}, 1000);
    } catch (e) { console.log('ERR ' + (e.code ?? e.message)); process.exit(3); }`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  const first = new Promise((resolve) => { const t = setInterval(() => { if (/OPEN|ERR/.test(out)) { clearInterval(t); resolve(out.trim().split('\n')[0]); } }, 30); proc.on('exit', () => { clearInterval(t); resolve(out.trim().split('\n')[0] || 'EXIT'); }); });
  return { proc, first, kill: () => new Promise((r) => { if (proc.exitCode !== null || proc.signalCode) return r(); proc.once('exit', r); proc.kill('SIGKILL'); }) };
}
const tmp = () => mkdtemp(join(tmpdir(), 'proc-lease-'));

test('after a crash (kill -9, the lock is left behind) a new start takes over once the lease has expired, and every record written before is still there', async () => {
  const dir = await tmp(); const path = join(dir, 'procurement.json');
  try {
    const a = child(path, { supplier: 'Fournisseur A' }); assert.equal(await a.first, 'OPEN');
    await a.kill(); await access(`${path}.lock`); // the lock really is left behind
    const t0 = Date.now(); const store = await openFileProcurementStore({ path, lease: FAST }); const waited = Date.now() - t0;
    assert.ok(waited >= 300, `it must not take over a lock that is not yet stale (waited ${waited} ms)`);
    assert.ok(waited < FAST.waitMs, 'it takes over as soon as the lease expired');
    const p = createProcurement({ store, merchantId: M });
    assert.deepEqual((await p.queries.suppliers()).map((s) => s.name), ['Fournisseur A']);
    await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a LIVE writer is never displaced: its lock is not deleted, a second start is refused (STORE_LOCKED), the first keeps its lease and its data', async () => {
  const dir = await tmp(); const path = join(dir, 'procurement.json');
  try {
    const a = child(path, { supplier: 'Fournisseur A' }); assert.equal(await a.first, 'OPEN');
    const before = await readFile(`${path}.lock`, 'utf8'); const m1 = (await stat(`${path}.lock`)).mtimeMs;
    await assert.rejects(openFileProcurementStore({ path, lease: { ...FAST, waitMs: 2500 } }), { code: 'STORE_LOCKED' });
    await sleep(400);
    assert.equal(await readFile(`${path}.lock`, 'utf8'), before, 'the live writer\'s lock was neither removed nor replaced');
    assert.ok((await stat(`${path}.lock`)).mtimeMs > m1, 'the live writer keeps refreshing its lease');
    await a.kill();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('four simultaneous starts on one file: exactly one opens it, the others are refused', async () => {
  const dir = await tmp(); const path = join(dir, 'procurement.json');
  try {
    const lease = { ...FAST, waitMs: 1500 };
    const cs = [1, 2, 3, 4].map(() => child(path, { lease }));
    const results = await Promise.all(cs.map((c) => c.first));
    assert.equal(results.filter((r) => r === 'OPEN').length, 1, results.join(' | '));
    assert.equal(results.filter((r) => r === 'ERR STORE_LOCKED').length, 3, results.join(' | '));
    for (const c of cs) await c.kill();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a writer whose lock was taken from it refuses to write (STORE_LOCK_LOST): nothing is committed by a second writer', async () => {
  const dir = await tmp(); const path = join(dir, 'procurement.json');
  try {
    const store = await openFileProcurementStore({ path, lease: FAST }); const p = createProcurement({ store, merchantId: M });
    await p.commands.createSupplier(owner, 'k-s-000001', { name: 'Avant', country: 'CN', currency: 'USD' });
    await writeFile(`${path}.lock`, JSON.stringify({ v: 2, instance: 'someone-else', host: 'other', pid: 1, at: new Date().toISOString() }));
    await assert.rejects(p.commands.createSupplier(owner, 'k-s-000002', { name: 'Apres', country: 'CN', currency: 'USD' }), (e) => /LOCK_LOST|STORE_UNAVAILABLE/.test(`${e.code} ${e.message}`));
    const onDisk = JSON.parse(await readFile(path, 'utf8')); assert.ok(!JSON.stringify(onDisk).includes('Apres'), 'the refused write is not on disk');
    await store.close(); // it must not delete the other writer's lock
    assert.ok(JSON.parse(await readFile(`${path}.lock`, 'utf8')).instance === 'someone-else', 'closing never removes a lock that is not ours');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a clean stop releases the lease at once: the next start does not wait', async () => {
  const dir = await tmp(); const path = join(dir, 'procurement.json');
  try {
    const first = await openFileProcurementStore({ path, lease: FAST }); await first.close();
    await assert.rejects(access(`${path}.lock`), { code: 'ENOENT' });
    const t0 = Date.now(); const second = await openFileProcurementStore({ path, lease: FAST }); assert.ok(Date.now() - t0 < 500); await second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('without a lease the original process-id lock is unchanged (a live foreign holder still refuses)', async () => {
  const dir = await tmp(); const path = join(dir, 'procurement.json');
  try {
    await writeFile(`${path}.lock`, String(process.ppid));
    await assert.rejects(openFileProcurementStore({ path }), { code: 'STORE_LOCKED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('hosted mount on a Railway volume: a restart after a crash finds Stock / Achats and its data again, and a live writer is not displaced', async () => {
  const { buildHostedProcurement } = await import('../src/procurement/server/hosted.js');
  const dir = await tmp(); const env = { RAILWAY_VOLUME_MOUNT_PATH: '/app/data' };
  try {
    const sig = process.listenerCount('SIGTERM');
    const first = await buildHostedProcurement({ dir, merchantId: M, env, lease: FAST, log: () => {} }); assert.ok(first.handler, first.status);
    await first.procurement.commands.createSupplier(owner, 'k-h-000001', { name: 'Hébergé', country: 'CN', currency: 'USD' });
    const refused = await buildHostedProcurement({ dir, merchantId: M, env, lease: { ...FAST, waitMs: 1000 }, log: () => {} });
    assert.equal(refused.handler, null); assert.match(refused.status, /OFF \(STORE_LOCKED\)/, 'the live mount is not displaced; Nordla itself would keep running');
    await first.close();
    assert.equal(process.listenerCount('SIGTERM'), sig, 'no signal handler is left behind');
    const again = await buildHostedProcurement({ dir, merchantId: M, env, lease: FAST, log: () => {} }); assert.ok(again.handler, again.status);
    assert.deepEqual((await again.procurement.queries.suppliers()).map((s) => s.name), ['Hébergé']);
    await again.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
