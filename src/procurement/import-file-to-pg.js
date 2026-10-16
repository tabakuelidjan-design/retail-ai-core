// File store -> PostgreSQL import. The field laptop keeps everything in data/local/procurement/procurement.json; when the PostgreSQL store becomes the source of truth,
// this moves that history over WITHOUT re-typing and without loss: suppliers, items (with photo references), quotes (every revision), visits, purchase orders (with
// their payment schedule), receipts, the whole stock ledger (balances are rebuilt by the database trigger, in ledger order), the audit journal, the idempotency records
// (a command retried after the move is still recognised), the consumed approvals (an approval stays single-use) and the numbering (the next PO number continues).
//
// Safety: all-or-nothing (one transaction); refuses a target that already holds anything for the merchant; refuses a file holding rows of another merchant;
// `dryRun` (the default) reads and validates only; after an import, `compareStores` proves the two stores answer the same questions the same way.
// Not preserved: the row `version` counters (they restart at 1: they only guard concurrent edits, and nothing is editing during the move).
import { reviveState } from './memory-store.js';
import { createProcurement } from './index.js';

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
