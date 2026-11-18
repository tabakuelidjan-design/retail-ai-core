// Identity of a bank MOVEMENT across statement formats (CSV and CAMT.053).
//
// Rules, in order (nothing is ever dropped silently):
//   1. same provider id (the store's key) -> already known, not stored again.
//   2. same RELIABLE bank reference (the bank's own id: CSV id column or CAMT AcctSvcrRef) AND same movement -> already known.
//   3. same RELIABLE bank reference but a different movement -> stored, and REPORTED as a conflict to check.
//   4. no reliable reference on one side, but the same movement (date, signed amount, currency, reference, counterparty) is stored
//      -> stored, and REPORTED as a possible duplicate to check by hand. Two real movements that look the same are not merged.
//   5. otherwise -> new.
// A movement with two different RELIABLE references is two movements, whatever they look like.

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

export const movementKey = (t) => [String(t.date ?? ''), Number(t.amountCents), String(t.currency ?? 'EUR').toUpperCase(), norm(t.reference), norm(t.counterpartyName)].join('|');

/**
 * @param {object[]} incoming parsed rows; each has id, line, date, amountCents, currency, reference, counterpartyName and bankReference (null when not reliable)
 * @param {object[]} stored   stored rows of the same account (providerTxId, bankReference and the same fields)
 * @returns {{ kept: object[], known: number, possible: {line:number, id:string, storedId:string, reason:string}[] }}
 *   kept: rows to store (new, or stored but to check); known: how many were already known; possible: rows to check by hand.
 */
export function classifyIncoming(incoming, stored) {
  const kept = []; let known = 0; const possible = [];
  for (const r of incoming) {
    // Same provider id: the same movement is known; a DIFFERENT movement under the same id is never stored (the id is the key) and is reported, never dropped silently.
    const sameId = stored.find((s) => String(s.providerTxId) === String(r.id));
    if (sameId) {
      if (movementKey(sameId) === movementKey(r)) { known += 1; continue; }
      possible.push({ line: r.line, id: String(r.id), storedId: String(sameId.providerTxId), reason: 'SAME_ID_OTHER_MOVEMENT', stored: false });
      continue;
    }
    const byRef = r.bankReference ? stored.find((s) => s.bankReference && s.bankReference === r.bankReference) : null;
    if (byRef) {
      if (movementKey(byRef) === movementKey(r)) { known += 1; continue; }
      kept.push(r); possible.push({ line: r.line, id: String(r.id), storedId: String(byRef.providerTxId), reason: 'SAME_BANK_REFERENCE_OTHER_MOVEMENT', stored: true });
      continue;
    }
    // A stored row with a DIFFERENT reliable reference is a different movement: it cannot be the same one.
    const candidate = stored.find((s) => movementKey(s) === movementKey(r) && !(s.bankReference && r.bankReference && s.bankReference !== r.bankReference));
    kept.push(r);
    if (candidate) possible.push({ line: r.line, id: String(r.id), storedId: String(candidate.providerTxId), reason: 'NO_RELIABLE_BANK_REFERENCE', stored: true });
  }
  return { kept, known, possible };
}
