// "Found again after a restart, with no loss": the file store survives a clean close, a process killed without any cleanup, a half-written temp file, and refuses
// to start over a corrupt file or a file in use. Also: a failed write rolls the command back instead of pretending it succeeded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openFileProcurementStore, createMemoryProcurementStore, createProcurement, ProcurementError } from '../src/procurement/index.js';
import { rejects, approval, key, buyer, wh, owner } from './procurement-fixtures.js';

const dir = () => mkdtempSync(join(tmpdir(), 'nordla-dur-'));
const NOW = '2026-10-20T09:00:00.000Z';

test('a process killed with SIGKILL right after its last command loses nothing', () => {
  const path = join(dir(), 'procurement.json'); const merchantId = randomUUID();
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./procurement-child-writer.mjs', import.meta.url)), path, merchantId], { encoding: 'utf8' });
  assert.notEqual(child.status, 0, 'the child really died abruptly'); // killed: no clean exit code
  const printed = JSON.parse(child.stdout.trim().split('\n').at(-1));
  return (async () => {
    const store = await openFileProcurementStore({ path }); // the dead process left a stale lock: taken over
    const { queries: q, commands: c } = createProcurement({ store, merchantId, now: () => NOW });
    const po = await q.purchaseOrder(printed.poId);
    assert.equal(po.number, printed.number); assert.equal(po.status, 'PARTIALLY_RECEIVED');
    assert.equal(po.lines[0].qty, 5000); assert.equal(po.lines[0].qtyReceived, 2000); assert.equal(po.lines[0].qtyDefective, 10);
    assert.equal(po.lines[0].unitPriceMicro, 72000, 'the 5000+ tier of the imported quote');
    assert.equal(po.totalMinor, 36000);
    const pos = await q.stockPosition(printed.itemId);
    assert.equal(pos.available, 1990); assert.equal(pos.quarantine, 10); assert.equal(pos.incoming.qty, 3000);
    const item = await q.item(printed.itemId);
    assert.equal(item.status, 'PROSPECT'); assert.equal(item.attachments[0].ref, 'upload://aaa.jpg');
    assert.equal((await q.priceHistory({ supplierId: printed.supplierId, itemId: printed.itemId })).length, 1);
    assert.equal((await q.events({ objectId: po.id })).map((e) => e.type).join(','), 'PO_CREATED,PO_SUBMITTED,PO_APPROVED,PO_ORDERED,GOODS_RECEIVED');
    // idempotency and single-use approvals survive the restart too
    const replay = await c.submitPurchaseOrder(buyer, 'k-submit', { poId: printed.poId });
    assert.equal(replay.replayed, true);
    await rejects(c.receiveGoods(wh, key(), { poId: printed.poId, receivedAt: '2026-12-10', lines: [{ poLineId: 'L1', qtyAccepted: 1 }], approval: { id: 'ap-STOCK_SALES.receive_goods-' + printed.poId, action: 'STOCK_SALES.receive_goods', subject_ref: `nordla:purchase:${printed.poId}`, approver: { kind: 'HUMAN', id: 'reviewer-1', role: 'AUTHORIZED_REVIEWER' }, approved_at: NOW } }), 'APPROVAL_ALREADY_USED');
    // the work can simply continue: the balance arrives
    await c.receiveGoods(wh, key(), { poId: printed.poId, receivedAt: '2026-12-12', lines: [{ poLineId: 'L1', qtyAccepted: 3000 }], approval: approval('STOCK_SALES.receive_goods', printed.poId) });
    assert.equal((await q.purchaseOrder(printed.poId)).status, 'RECEIVED');
    await store.close();
  })();
});

test('a clean close and reopen gives back exactly the same state', async () => {
  const path = join(dir(), 'p.json'); const merchantId = randomUUID();
  const s1 = await openFileProcurementStore({ path });
  const p1 = createProcurement({ store: s1, merchantId, now: () => NOW });
  await p1.commands.createItem(buyer, key(), { sku: 'DUR-1', name: 'durable' });
  await p1.commands.createLocation(owner, key(), { name: 'Shelf', type: 'STORE' });
  const before = JSON.stringify(s1.exportState());
  await s1.close();
  const s2 = await openFileProcurementStore({ path });
  assert.equal(JSON.stringify(s2.exportState()), before);
  assert.equal((await createProcurement({ store: s2, merchantId }).queries.items()).length, 1);
  await s2.close();
});

test('a half-written temp file from a crash is ignored; the last committed state wins', async () => {
  const path = join(dir(), 'p.json'); const merchantId = randomUUID();
  const s1 = await openFileProcurementStore({ path });
  await createProcurement({ store: s1, merchantId, now: () => NOW }).commands.createItem(buyer, key(), { sku: 'DUR-2', name: 'before the crash' });
  await s1.close();
  writeFileSync(`${path}.99999.tmp`, '{"format":1,"items":[["half-writ'); // what a crash in the middle of a save leaves behind
  const s2 = await openFileProcurementStore({ path });
  assert.deepEqual((await createProcurement({ store: s2, merchantId }).queries.items()).map((i) => i.sku), ['DUR-2']);
  await s2.close();
});

test('a corrupt data file is never replaced by an empty store', async () => {
  const path = join(dir(), 'p.json');
  writeFileSync(path, '{ this is not json');
  await assert.rejects(openFileProcurementStore({ path }), (e) => e.code === 'STORE_CORRUPT');
  assert.equal(readFileSync(path, 'utf8'), '{ this is not json', 'the damaged file is untouched, for recovery');
  assert.equal(existsSync(`${path}.lock`), false, 'and the lock was released');
  writeFileSync(path, JSON.stringify({ format: 99 }));
  await assert.rejects(openFileProcurementStore({ path }), (e) => e.code === 'STORE_CORRUPT');
});

test('two processes cannot write the same file; a stale lock is taken over', async () => {
  const path = join(dir(), 'p.json');
  const s1 = await openFileProcurementStore({ path });
  // our own pid is alive: a second open from "another" holder must be refused. Simulate another live process: the parent of this process
  writeFileSync(`${path}.lock`, String(process.ppid));
  await s1.close(); // removes our lock file (the simulated one replaced it, so recreate below)
  writeFileSync(`${path}.lock`, String(process.ppid));
  await assert.rejects(openFileProcurementStore({ path }), (e) => e.code === 'STORE_LOCKED');
  writeFileSync(`${path}.lock`, '2147483646'); // no such process
  const s2 = await openFileProcurementStore({ path });
  await s2.close();
});

test('when the write to disk fails the command fails and nothing is half-applied', async () => {
  let failing = false;
  const store = createMemoryProcurementStore({ onCommit: async () => { if (failing) throw new Error('disk full'); } });
  const merchantId = randomUUID();
  const { commands: c, queries: q } = createProcurement({ store, merchantId, now: () => NOW, retryDelayMs: 1 });
  await c.createItem(buyer, key(), { sku: 'OK-1', name: 'saved' });
  failing = true;
  const e = await rejects(c.createItem(buyer, key(), { sku: 'LOST-1', name: 'never saved' }), 'STORE_UNAVAILABLE');
  assert.ok(e instanceof ProcurementError);
  failing = false;
  assert.deepEqual((await q.items()).map((i) => i.sku), ['OK-1'], 'the failed command left no trace in memory either');
  await c.createItem(buyer, key(), { sku: 'LOST-1', name: 'saved this time' });
  assert.equal((await q.items()).length, 2);
});

test('a data file written before a collection was renamed still loads completely; an unknown collection is refused, never dropped', async () => {
  const { reviveState, serializeState } = await import('../src/procurement/memory-store.js');
  const store = createMemoryProcurementStore();
  const { commands: c, queries: q } = createProcurement({ store, merchantId: randomUUID(), now: () => NOW });
  await c.createLocation(owner, key(), { name: 'Warehouse', type: 'WAREHOUSE' });
  const modern = store.exportState();
  const legacy = { ...modern, locations: modern.stockLocations }; delete legacy.stockLocations; // what an older version wrote
  const path = join(dir(), 'old.json'); writeFileSync(path, JSON.stringify(legacy));
  const reopened = await openFileProcurementStore({ path });
  const again = createProcurement({ store: reopened, merchantId: [...JSON.parse(JSON.stringify(modern.stockLocations))][0][1].merchantId, now: () => NOW });
  assert.equal((await again.queries.locations()).length, 1, 'the location written by the old version is still there');
  await reopened.close();
  assert.throws(() => reviveState({ ...modern, somethingNew: [] }), /unknown collection/);
  assert.throws(() => reviveState({ ...modern, locations: [] }), /both locations and stockLocations/);
  assert.ok(serializeState); assert.ok(q);
});
