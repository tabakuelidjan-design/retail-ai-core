// Stock / Achats mounted on the Nordla server must come back after a container restart. The file store checks its lock by process id, which says nothing
// across containers (reproduced on the candidate image: after `docker restart`, "Stock / Achats OFF (STORE_LOCKED)"). On a Railway volume (one writer) a leftover lock
// is cleared at boot; elsewhere the store's own check keeps protecting the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHostedProcurement } from '../src/procurement/server/hosted.js';

const M = '11111111-2222-4333-8444-555555555555';
async function dirWithForeignLock() {
  const dir = await mkdtemp(join(tmpdir(), 'proc-lock-'));
  await mkdir(join(dir, 'procurement'), { recursive: true });
  // a live process that is not this one (the parent shell / test runner): exactly what a stale lock looks like when the new container reuses the id
  await writeFile(join(dir, 'procurement', 'procurement.json.lock'), String(process.ppid));
  return dir;
}

test('outside a Railway volume the store\'s own lock still protects the file (another live writer = not mounted, Nordla unaffected)', async () => {
  const dir = await dirWithForeignLock();
  try {
    const r = await buildHostedProcurement({ dir, merchantId: M, env: {}, log: () => {} });
    assert.equal(r.handler, null); assert.match(r.status, /OFF \(STORE_LOCKED\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('on a Railway volume a leftover lock from the previous container is cleared: Stock / Achats is ON again and its data is intact', async () => {
  const dir = await dirWithForeignLock();
  try {
    const env = { RAILWAY_VOLUME_MOUNT_PATH: '/app/data' };
    const first = await buildHostedProcurement({ dir, merchantId: M, env, log: () => {} });
    assert.ok(first.handler, first.status);
    const sup = await first.procurement.commands.createSupplier({ id: 'u1', role: 'OWNER' }, 'k-sup-0001', { name: 'Fournisseur de test', country: 'CN', currency: 'USD' });
    await first.store.close(); // a clean stop
    await writeFile(join(dir, 'procurement', 'procurement.json.lock'), String(process.ppid)); // a crash / kill leaves it behind again
    const second = await buildHostedProcurement({ dir, merchantId: M, env, log: () => {} });
    assert.ok(second.handler, second.status);
    const names = (await second.procurement.queries.suppliers()).map((s) => s.name);
    assert.deepEqual(names, ['Fournisseur de test'], 'the data written before the restart is still there');
    assert.ok(JSON.parse(await readFile(join(dir, 'procurement', 'procurement.json'), 'utf8')), 'the data file is valid JSON');
    await second.store.close(); void sup;
  } finally { await rm(dir, { recursive: true, force: true }); }
});
