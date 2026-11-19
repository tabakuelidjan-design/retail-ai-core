// Identity of a bank MOVEMENT across statement formats (CSV and CAMT.053), inside ONE merchant, ONE bank account and ONE source ('csv').
// The caller passes only the stored rows of that merchant, account and source (see bank-service.js), so these keys never cross them.
//
// Rules, in order. Nothing is ever dropped silently, and nothing suspected is stored by default:
//   1. same provider id, same movement      -> already known (not stored again).
//   2. same provider id, other movement     -> HELD (never stored: the id is the store's key). Needs a manual check.
//   3. same RELIABLE bank reference, other movement -> HELD for a manual check.
//   4. no reliable reference, same movement already stored -> HELD (suspected duplicate). Stored ONLY if the merchant accepts it explicitly.
//   5. otherwise -> new, stored.
// Two different RELIABLE references are two movements, whatever they look like.
// A HELD row never enters reconciliation: it is not in the store, so it cannot be suggested or confirmed.

// Explicit rule, identical in SQL (fin_bank_norm, migration 20261119100000): decompose, drop combining marks, every other non-ASCII character becomes a space
// (no Unicode case folding: 'ß', ligatures, 'Ø', dotless i are NOT expanded), ASCII upper case, runs of non [A-Z0-9] become one space, trimmed.
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^ -~]/g, ' ').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

export const movementKey = (t) => [String(t.date ?? ''), Number(t.amountCents), String(t.currency ?? 'EUR').toUpperCase(), norm(t.reference), norm(t.counterpartyName)].join('|');

/**
 * @param {object[]} incoming parsed rows (id, line, date, amountCents, currency, reference, counterpartyName, bankReference: string|null)
 * @param {object[]} stored   the merchant's stored rows of the same account and source (providerTxId, bankReference and the same fields)
 * @returns {{ kept: object[], known: number, possible: object[] }}
 *   kept     : new rows, to store.
 *   known    : rows already known (not stored again).
 *   possible : rows HELD for a manual check. { line, id, storedId, reason, stored, row } ; stored:false means never storable, stored:true means storable only if accepted.
 */
export function classifyIncoming(incoming, stored) {
  const kept = []; let known = 0; const possible = [];
  const hold = (r, storedId, reason, storable) => possible.push({ line: r.line, id: String(r.id), storedId: String(storedId), reason, stored: storable, row: r });
  for (const r of incoming) {
    const sameId = stored.find((s) => String(s.providerTxId) === String(r.id));
    if (sameId) {
      if (movementKey(sameId) === movementKey(r)) { known += 1; continue; }
      hold(r, sameId.providerTxId, 'SAME_ID_OTHER_MOVEMENT', false); continue;
    }
    const byRef = r.bankReference ? stored.find((s) => s.bankReference && s.bankReference === r.bankReference) : null;
    if (byRef) {
      if (movementKey(byRef) === movementKey(r)) { known += 1; continue; }
      hold(r, byRef.providerTxId, 'SAME_BANK_REFERENCE_OTHER_MOVEMENT', false); continue;
    }
    // A stored row with a DIFFERENT reliable reference is a different movement: it cannot be the same one.
    const candidate = stored.find((s) => movementKey(s) === movementKey(r) && !(s.bankReference && r.bankReference && s.bankReference !== r.bankReference));
    if (candidate) { hold(r, candidate.providerTxId, 'NO_RELIABLE_BANK_REFERENCE', true); continue; }
    kept.push(r);
  }
  return { kept, known, possible };
}

/** The held rows the merchant accepted explicitly: only those that are storable (no reliable conflict). */
export const acceptedHeld = (possible, accept) => (accept ? possible.filter((p) => p.stored).map((p) => p.row) : []);

/** What the merchant sees about a held row (no raw row, no account identifier). */
export const heldSummary = (possible) => possible.map(({ row, ...p }) => ({ ...p, date: row.date, amountCents: row.amountCents, currency: row.currency, counterpartyName: row.counterpartyName ?? null }));
