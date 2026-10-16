// File store -> PostgreSQL import. The field laptop keeps everything in data/local/procurement/procurement.json; when the PostgreSQL store becomes the source of truth,
// this moves that history over WITHOUT re-typing and without loss: suppliers, items (with photo references), quotes (every revision), visits, purchase orders (with
// their payment schedule), receipts, the whole stock ledger (balances are rebuilt by the database trigger, in ledger order), the audit journal, the idempotency records
// (a command retried after the move is still recognised), the consumed approvals (an approval stays single-use) and the numbering (the next PO number continues).
//
// Safety: all-or-nothing (one transaction); refuses a target that already holds anything for the merchant; refuses a file holding rows of another merchant;
// `dryRun` (the default) reads and validates only; after an import, `compareStores` proves the two stores answer the same questions the same way.
// Not preserved: the row `version` counters (they restart at 1: they only guard concurrent edits, and nothing is editing during the move).
import { reviveState, createMemoryProcurementStore } from './memory-store.js';
import { createProcurement } from './index.js';
import { balancesFrom, assertPostable } from './stock.js';

const ORDER = ['stockLocations', 'suppliers', 'items', 'supplierItems', 'quotes', 'purchaseOrders', 'visits', 'receipts']; // parents before children

export class ImportError extends Error { constructor(code, message, detail = {}) { super(message); this.name = 'ImportError'; this.code = code; this.detail = detail; } }

/** @param {{ state: object, target: object, merchantId: string, dryRun?: boolean }} a   state = serialized file-store state; target = a PostgreSQL procurement store */
export async function importFileState({ state, target, merchantId, dryRun = true }) {
  const d = reviveState(state);
  const mine = (r) => r.merchantId === merchantId;
  const counts = {};
  for (const c of ORDER) { const rows = [...d[c].values()]; if (rows.some((r) => !mine(r))) throw new ImportError('FOREIGN_MERCHANT', `the file holds ${c} rows of another merchant: refusing to import`, { collection: c }); counts[c] = rows.length; }
  for (const c of ['movements', 'events', 'incidents']) { if (d[c].some((r) => !mine(r))) throw new ImportError('FOREIGN_MERCHANT', `the file holds ${c} of another merchant`, { collection: c }); counts[c] = d[c].length; }
  counts.idempotency = [...d.idem.keys()].filter((k) => k.startsWith(`${merchantId}|`)).length; counts.approvals = [...d.approvals].filter((k) => k.startsWith(`${merchantId}|`)).length;
  // the target must be empty for this merchant
  const present = {};
  for (const c of ORDER) present[c] = (await target.list(c, merchantId)).length;
  for (const c of ['events', 'incidents']) present[c] = (await (c === 'events' ? target.listEvents(merchantId) : target.listIncidents(merchantId))).length;
  present.movements = (await target.listMovements(merchantId)).length;
  const dirty = Object.entries(present).filter(([, n]) => n > 0);
  if (dirty.length) throw new ImportError('TARGET_NOT_EMPTY', `the target already holds data for this merchant (${dirty.map(([c, n]) => `${c}: ${n}`).join(', ')}): refusing to import over it`, { present });
  if (dryRun) return { dryRun: true, counts, imported: false };

  await target.transaction(async (tx) => {
    for (const c of ORDER) for (const row of d[c].values()) await tx.insert(c, row);
    for (const m of d.movements) await tx.appendMovement(m); // ledger order: the balance trigger rebuilds every balance
    for (const e of d.events) await tx.appendEvent(e);
    for (const i of d.incidents) await tx.appendIncident(i);
    for (const [k, rec] of d.idem) { const [m, ...rest] = k.split('|'); if (m === merchantId) await tx.putIdem(m, rest.join('|'), rec); }
    for (const k of d.approvals) { const [m, ...rest] = k.split('|'); if (m === merchantId) await tx.consumeApproval(m, rest.join('|')); }
    for (const [k, n] of d.seq) { const [m, ...rest] = k.split('|'); if (m === merchantId) await tx.setSeq(m, rest.join('|'), n); }
  });
  return { dryRun: false, counts, imported: true };
}

// canonical form for comparing two stores: key order is irrelevant, `null` and an absent field mean the same ("no value"), and the row version counters are excluded
const strip = (v) => {
  const norm = (x) => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([k, y]) => k !== 'version' && k !== 'ord' && y !== null && y !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, norm(y)]));
    return x;
  };
  return norm(JSON.parse(JSON.stringify(v)));
};
/** Do the two stores answer the same questions the same way? Returns the list of differences (empty = equivalent). */
export async function compareStores({ source, target, merchantId }) {
  const a = createProcurement({ store: source, merchantId }).queries; const b = createProcurement({ store: target, merchantId }).queries;
  const diffs = [];
  const same = async (name, fa, fb) => { const x = JSON.stringify(strip(await fa())); const y = JSON.stringify(strip(await fb())); if (x !== y) diffs.push({ name, source: x.slice(0, 400), target: y.slice(0, 400) }); };
  for (const q of ['items', 'suppliers', 'quotes', 'purchaseOrders', 'visits', 'locations']) await same(q, () => a[q](), () => b[q]());
  await same('stockPositions', () => a.stockPositions(), () => b.stockPositions());
  await same('events', () => a.events(), () => b.events());
  await same('inTransit', () => a.inTransit(), () => b.inTransit());
  for (const item of await a.items()) await same(`receiptLots:${item.sku}`, () => a.receiptLots(item.id), () => b.receiptLots(item.id));
  return diffs;
}

/**
 * Verifies the SOURCE before anything is written: every reference resolves, every PO line agrees with the ledger, the ledger replays without breaking an invariant,
 * numbering is not behind the orders that exist. Returns { ok, problems: [{ code, message }] }. An import never starts on a source with problems.
 */
export function validateSourceState(state, merchantId) {
  const problems = []; const add = (code, message) => problems.push({ code, message });
  let d;
  try { d = reviveState(state); } catch (e) { return { ok: false, problems: [{ code: 'SOURCE_UNREADABLE', message: e.message }] }; }
  const ids = (c) => new Set([...d[c].keys()]);
  const items = ids('items'); const locs = ids('stockLocations'); const sup = ids('suppliers'); const quotes = ids('quotes'); const pos = ids('purchaseOrders');
  for (const c of ['items', 'stockLocations', 'suppliers', 'quotes', 'purchaseOrders', 'visits', 'receipts', 'supplierItems']) for (const r of d[c].values()) if (r.merchantId !== merchantId) add('FOREIGN_MERCHANT', `${c} ${r.id} belongs to another merchant`);
  for (const c of ['movements', 'events', 'incidents']) for (const r of d[c]) if (r.merchantId !== merchantId) add('FOREIGN_MERCHANT', `a ${c} row belongs to another merchant`);
  for (const q of d.quotes.values()) { if (!sup.has(q.supplierId)) add('DANGLING_REFERENCE', `quote ${q.id}: unknown supplier`); if (!items.has(q.itemId)) add('DANGLING_REFERENCE', `quote ${q.id}: unknown item`); }
  const received = new Map();
  for (const m of d.movements) {
    if (m.kind === 'RECEIPT' && m.bucket === 'ON_HAND' && m.reference?.type === 'purchase_order') { const k = `${m.reference.id}|${m.reference.lineId}`; received.set(k, (received.get(k) ?? 0) + m.delta); }
  }
  for (const po of d.purchaseOrders.values()) {
    if (!sup.has(po.supplierId)) add('DANGLING_REFERENCE', `order ${po.number}: unknown supplier`);
    if (!locs.has(po.destinationLocationId)) add('DANGLING_REFERENCE', `order ${po.number}: unknown destination location`);
    for (const l of po.lines) {
      if (!items.has(l.itemId)) add('DANGLING_REFERENCE', `order ${po.number} line ${l.id}: unknown item`);
      if (l.quoteId && !quotes.has(l.quoteId)) add('DANGLING_REFERENCE', `order ${po.number} line ${l.id}: unknown quote`);
      if ((received.get(`${po.id}|${l.id}`) ?? 0) !== l.qtyReceived) add('LEDGER_MISMATCH', `order ${po.number} line ${l.id}: the order says ${l.qtyReceived} received, the ledger says ${received.get(`${po.id}|${l.id}`) ?? 0}`);
      if (l.qtyReceived > l.qty) add('OVER_RECEIPT', `order ${po.number} line ${l.id}: more received than ordered`);
    }
  }
  for (const r of d.receipts.values()) if (!pos.has(r.poId)) add('DANGLING_REFERENCE', `receipt ${r.id}: unknown order`);
  for (const v of d.visits.values()) if (!sup.has(v.supplierId)) add('DANGLING_REFERENCE', `visit ${v.id}: unknown supplier`);
  const bal = new Map(); const keys = new Set();
  for (const m of d.movements) {
    if (!items.has(m.itemId)) add('DANGLING_REFERENCE', `a movement names an unknown item`); if (!locs.has(m.locationId)) add('DANGLING_REFERENCE', `a movement names an unknown location`);
    if (keys.has(m.idempotencyKey)) add('DUPLICATE_MOVEMENT_KEY', `movement key ${m.idempotencyKey} appears twice`); keys.add(m.idempotencyKey);
    const k = `${m.itemId}|${m.locationId}`; try { assertPostable(bal.get(k), m); } catch (e) { add('LEDGER_INVARIANT', `replaying the ledger breaks "${e.code}" (item ${m.itemId})`); break; }
    bal.set(k, balancesFrom([{ ...m }, ...(bal.has(k) ? [{ itemId: m.itemId, locationId: m.locationId, bucket: 'ON_HAND', delta: bal.get(k).onHand }, { itemId: m.itemId, locationId: m.locationId, bucket: 'RESERVED', delta: bal.get(k).reserved }] : [])]).get(k));
  }
  const maxNo = {}; for (const po of d.purchaseOrders.values()) { const m = /^PO-(\d{4})-(\d+)$/.exec(po.number); if (m) maxNo[m[1]] = Math.max(maxNo[m[1]] ?? 0, Number(m[2])); }
  for (const [year, n] of Object.entries(maxNo)) { const seq = d.seq.get(`${merchantId}|po-${year}`) ?? 0; if (seq < n) add('NUMBERING_BEHIND', `the numbering for ${year} is at ${seq} but order ${n} exists: numbers would repeat`); }
  return { ok: problems.length === 0, problems };
}

/**
 * The whole procedure, with an honest status:
 *   REFUSED_SOURCE_INVALID | REFUSED_TARGET_NOT_EMPTY | DRY_RUN_OK | IMPORTED_VERIFIED | IMPORTED_NOT_EQUIVALENT
 * Only IMPORTED_VERIFIED is a success. IMPORTED_NOT_EQUIVALENT means the data went in but the two stores do not answer alike: do NOT use the target
 * (drop the module with the rollback script and investigate); the source file is never modified by any of this.
 */
export async function runImport({ state, target, merchantId, apply = false }) {
  const source = validateSourceState(state, merchantId);
  if (!source.ok) return { status: 'REFUSED_SOURCE_INVALID', problems: source.problems };
  let plan;
  try { plan = await importFileState({ state, target, merchantId, dryRun: true }); } catch (e) { if (e instanceof ImportError) return { status: e.code === 'TARGET_NOT_EMPTY' ? 'REFUSED_TARGET_NOT_EMPTY' : `REFUSED_${e.code}`, message: e.message, detail: e.detail }; throw e; }
  if (!apply) return { status: 'DRY_RUN_OK', counts: plan.counts };
  await importFileState({ state, target, merchantId, dryRun: false });
  const diffs = await compareStores({ source: createMemoryProcurementStore({ state }), target, merchantId });
  return diffs.length ? { status: 'IMPORTED_NOT_EQUIVALENT', counts: plan.counts, diffs } : { status: 'IMPORTED_VERIFIED', counts: plan.counts };
}
