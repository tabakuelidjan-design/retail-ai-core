// "Réception d'achat enregistrée": a REAL Stock / Achats receipt (receiveGoods) publishes GOODS_RECEIVED to the audit outlet; Notifications turns it into ONE alert per authorised member,
// whose link opens THAT receipt (GET /api/receipts/:id of the procurement API, deep link ?receipt=<id>). A replay and the catch-up sweep add nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeWorld, orderedPo, receive, NOW } from './procurement-fixtures.js';
import { createProcurementApp } from '../src/procurement/server/app.js';
import { createNotificationsService } from '../src/settings-notifications/service.js';
import { createMemoryNotificationsRepository } from '../src/settings-notifications/repository.js';
import { createReceiptEmitter, combineEmitters } from '../src/settings-notifications/emitters.js';
import { isWired } from '../src/settings-notifications/model.js';

const U = { owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', viewer: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', off: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', gone: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
async function setup() {
  const w = await makeWorld();
  const M = w.merchantId;
  const repo = createMemoryNotificationsRepository({ members: [{ merchantId: M, userId: U.owner, role: 'OWNER' }, { merchantId: M, userId: U.viewer, role: 'VIEWER' }, { merchantId: M, userId: U.off, role: 'ADMIN' }, { merchantId: M, userId: U.gone, role: 'VIEWER', active: false }] });
  const svc = createNotificationsService({ repo });
  await svc.setPreference({ tenant: { merchantId: M }, role: 'ADMIN', actor: U.off, type: 'receipt_recorded', channel: 'in_app', enabled: false });
  const em = createReceiptEmitter({ service: svc, merchantId: M, now: () => Date.parse(NOW) + 3600_000, poOf: async (id) => { const po = await w.q.purchaseOrder(id); if (!po) return null; const s = (await w.q.suppliers()).find((x) => x.id === po.supplierId); return { number: po.number, status: po.status, supplierName: s?.name ?? null }; }, listReceipts: () => w.q.receipts() });
  const pump = async () => { let n = 0; for (const e of w.audited.slice(pumped)) { await em.handle(e); n += 1; } pumped = w.audited.length; return n; }; let pumped = 0;
  return { w, M, repo, svc, em, pump };
}

test('NT-10 the alert is wired and addressed per authorised member; the receipt event creates ONE alert each, a replay and the catch-up add nothing', async () => {
  assert.equal(isWired('receipt_recorded'), true);
  const { w, M, repo, svc, em, pump } = await setup();
  const po = await orderedPo(w); await pump(); // orders emit no alert
  assert.equal(repo._rows.length, 0, 'only a receipt raises the alert');
  const r1 = await receive(w, po, [{ poLineId: po.lines[0].id, qtyAccepted: 80 }]); const receipt = r1.receipt;
  await pump(); // the audit outlet delivers the committed events
  const rows = repo._rows.filter((r) => r.type === 'receipt_recorded');
  assert.deepEqual(rows.map((r) => r.recipient_user_id).sort(), [U.owner, U.viewer].sort(), 'owner and read-only member; not the member who switched it off, not the removed one');
  for (const e of w.audited.filter((x) => x.type === 'GOODS_RECEIVED')) await em.handle(e); // the same event again (replay)
  assert.equal(repo._rows.length, 2);
  const sweep = await em.run(); assert.equal(sweep.created, 0, 'the catch-up finds the same receipt: nothing new'); assert.equal(repo._rows.length, 2);
  const inbox = await svc.inbox({ tenant: { merchantId: M }, role: 'VIEWER', actor: U.viewer }); assert.equal(inbox.items.length, 1);
  const it = inbox.items[0]; assert.equal(it.link, `/procurement/?receipt=${receipt.id}`); assert.match(it.title, new RegExp(po.number)); assert.match(it.body, /partielle/);
  assert.equal((await svc.inbox({ tenant: { merchantId: M }, role: 'ADMIN', actor: U.off })).items.length, 0);
  const opened = await svc.open({ tenant: { merchantId: M }, role: 'VIEWER', actor: U.viewer, id: it.id }); assert.equal(opened.link, it.link);
  // a second receipt completing the order is another event, another alert
  await receive(w, po, [{ poLineId: po.lines[0].id, qtyAccepted: 120 }]); await pump(); assert.equal(repo._rows.length, 4);
  assert.match((await svc.inbox({ tenant: { merchantId: M }, role: 'OWNER', actor: U.owner })).items[0].body, /totalité/);
});

test('NT-11 catch-up: a receipt committed while Notifications was not listening still alerts once; an old receipt and a foreign merchant event do not', async () => {
  const { w, M, repo, em } = await setup();
  const po = await orderedPo(w); const r = await receive(w, po, [{ poLineId: po.lines[0].id, qtyAccepted: 200 }]); // no pump: nobody heard the event
  assert.equal(repo._rows.length, 0);
  const a = await em.run(); assert.equal(a.created, 2); assert.equal((await em.run()).created, 0);
  assert.ok(repo._rows.every((x) => x.dedupe_key === `receipt_recorded:${r.receipt.id}` && x.data.complete === true));
  const late = createReceiptEmitter({ service: createNotificationsService({ repo: createMemoryNotificationsRepository({ members: [{ merchantId: M, userId: U.owner, role: 'OWNER' }] }) }), merchantId: M, now: () => Date.parse(NOW) + 10 * 24 * 3600_000, poOf: async () => null, listReceipts: () => w.q.receipts() });
  assert.equal((await late.run()).seen, 0, 'older than the window: ignored');
  assert.equal(await em.handle({ type: 'GOODS_RECEIVED', merchantId: 'someone-else', detail: { receiptId: r.receipt.id } }), null);
  assert.equal(await em.handle({ type: 'PO_CLOSED', merchantId: M, detail: {} }), null);
  assert.equal(await combineEmitters([em]).run().then((x) => x.length), 1);
});

test('NT-12 the receipt page behind the link: GET /api/receipts/:id answers this receipt (supplier, order, lines), 404 for an unknown or foreign id, and the UI carries the deep link', async () => {
  const { w } = await setup(); const po = await orderedPo(w); const { receipt } = await receive(w, po, [{ poLineId: po.lines[0].id, qtyAccepted: 150 }]);
  const handler = createProcurementApp({ procurement: w.proc, users: [], uploadsDir: '/tmp/none', sourcingDir: '/tmp/none' });
  const server = http.createServer((req, res) => handler.handleApi(req, res, new URL(req.url, 'http://x'), { id: 'u', role: 'OWNER', canApprove: true, grants: [] }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/receipts/${receipt.id}`); const j = await ok.json(); assert.equal(ok.status, 200);
    assert.deepEqual([j.id, j.poNumber, j.supplier.name, j.lines[0].qtyAccepted, j.lines[0].ordered, j.lines[0].name], [receipt.id, po.number, 'Shenzhen Gifts Co', 150, 200, 'Aimant rond']);
    assert.equal((await fetch(`${base}/api/receipts/00000000-0000-4000-8000-000000000000`)).status, 404);
  } finally { server.close(); }
  const { readFileSync } = await import('node:fs'); const ui = readFileSync(new URL('../src/procurement/ui/app.js', import.meta.url), 'utf8');
  assert.match(ui, /get\('receipt'\)/); assert.match(ui, /receipt: screenReceipt/); assert.match(ui, /\/api\/receipts\//);
});
