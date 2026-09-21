import test from 'node:test';
import assert from 'node:assert/strict';
import { hashSnapshot, verifyIntegrity } from '../src/finance/document.js';
import { AGENT_ACTOR, MERCHANT, MERCHANT_ACTOR, draftInvoice, issueInvoice, makeService } from './finance-fixtures.js';

async function ready(svc, over = {}) {
  const d = await svc.create(draftInvoice(over), AGENT_ACTOR);
  await svc.submit(d.id, AGENT_ACTOR);
  return d;
}

test('atomic issue: number, lock, hash and audit event land together; the stored hash equals the engine hash', async () => {
  const { svc, store } = makeService();
  const d = await ready(svc);
  const issued = await svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR);
  assert.equal(issued.number, 'INV-2026-0001');
  assert.equal(issued.status, 'ISSUED');
  assert.equal(issued.snapshotHash, hashSnapshot(issued)); // same canonical string, number substituted
  assert.equal(verifyIntegrity(issued).ok, true);
  const ev = (await svc.events(d.id)).find((e) => e.action === 'APPROVE_AND_ISSUE');
  assert.equal(ev.detail.number, 'INV-2026-0001');
  assert.ok(!JSON.stringify(ev).includes('__FIN_NUMBER_')); // the placeholder never leaks
  assert.equal(await store.peekNextNumber(MERCHANT, 'invoice', 2026), 2);
});

test('rollback: a failure inside the issue transaction leaves no burnt number, no lock, no event', async () => {
  const { svc, store } = makeService();
  const d = await ready(svc);
  store._debug.hooks.beforeCommit = () => { throw new Error('simulated crash after allocation'); };
  await assert.rejects(svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR), /simulated crash/);
  store._debug.hooks.beforeCommit = null;
  const after = await store.getDocument(d.id);
  assert.equal(after.number, null);
  assert.equal(after.lockedAt, null);
  assert.equal(after.status, 'READY_FOR_APPROVAL');
  assert.equal(await store.peekNextNumber(MERCHANT, 'invoice', 2026), 1); // the sequence did not advance
  assert.ok(!(await svc.events(d.id)).some((e) => e.action === 'APPROVE_AND_ISSUE'));
  const retry = await svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR); // retry after the "crash"
  assert.equal(retry.number, 'INV-2026-0001'); // no avoidable gap
});

test('crash simulation across many attempts: failures never create gaps in the issued sequence', async () => {
  const { svc, store } = makeService();
  const issuedNumbers = [];
  let failEvery = 0;
  store._debug.hooks.beforeCommit = () => { failEvery += 1; if (failEvery % 3 === 0) throw new Error('crash'); };
  for (let i = 0; i < 12; i += 1) {
    const d = await ready(svc);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { issuedNumbers.push((await svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR)).number); break; } catch (e) { if (!/crash/.test(e.message)) throw e; }
    }
  }
  assert.equal(issuedNumbers.length, 12);
  assert.deepEqual(issuedNumbers, Array.from({ length: 12 }, (_, i) => `INV-2026-${String(i + 1).padStart(4, '0')}`));
});

test('concurrent allocation: parallel approvals get unique, consecutive numbers', async () => {
  const { svc } = makeService();
  const docs = [];
  for (let i = 0; i < 25; i += 1) docs.push(await ready(svc));
  const out = await Promise.all(docs.map((d) => svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR)));
  const nums = out.map((d) => d.number).sort();
  assert.equal(new Set(nums).size, 25); // no duplicates
  assert.deepEqual(nums, Array.from({ length: 25 }, (_, i) => `INV-2026-${String(i + 1).padStart(4, '0')}`)); // no gaps
});

test('concurrent approval of the SAME document: exactly one wins, one number consumed', async () => {
  const { svc, store } = makeService();
  const d = await ready(svc);
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => ['CONCURRENT_MODIFICATION', 'INVALID_TRANSITION'].includes(r.reason.code)));
  assert.equal(await store.peekNextNumber(MERCHANT, 'invoice', 2026), 2);
});

test('quotes are issued atomically too, and the two numbering series stay independent', async () => {
  const { svc, store } = makeService();
  const q = await svc.create({ type: 'quote', customer: draftInvoice().customer, lines: draftInvoice().lines, vat: draftInvoice().vat, issueDate: '2026-09-21' }, AGENT_ACTOR);
  store._debug.hooks.beforeCommit = () => { throw new Error('crash'); };
  await assert.rejects(svc.sendQuote(q.id, MERCHANT_ACTOR), /crash/);
  store._debug.hooks.beforeCommit = null;
  assert.equal((await svc.sendQuote(q.id, MERCHANT_ACTOR)).number, 'QT-2026-0001');
  assert.equal((await issueInvoice(svc)).number, 'INV-2026-0001');
});

test('a description that looks like the placeholder cannot corrupt the number or the hash', async () => {
  const { svc } = makeService();
  const d = await ready(svc, { lines: [{ description: '__FIN_NUMBER_x__ and INV-2026-0001', quantity: '1', unitPrice: '10.00', vatRate: '21' }] });
  const issued = await svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR);
  assert.equal(issued.number, 'INV-2026-0001');
  assert.equal(verifyIntegrity(issued).ok, true);
  assert.equal(issued.lines[0].description, '__FIN_NUMBER_x__ and INV-2026-0001');
});

test('duplicate numbers are impossible: the store refuses a second document with an existing number', async () => {
  const { svc, store } = makeService();
  const a = await issueInvoice(svc);
  const clone = { ...structuredClone(a), id: 'other-id', lockedAt: null, snapshotHash: null };
  await assert.rejects(store.saveDocument(clone, null), (e) => e.code === 'DUPLICATE_DOCUMENT_NUMBER');
});
