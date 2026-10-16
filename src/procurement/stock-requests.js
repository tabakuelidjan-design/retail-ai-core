// Stock change REQUESTS (an adjustment or a physical count that needs a human decision). No table of their own: a request is the sequence of journal events
//   STOCK_CHANGE_REQUESTED -> STOCK_CHANGE_APPROVED | STOCK_CHANGE_REJECTED
// (the journal is append-only, so the history of a decision cannot be rewritten). This pure function folds the events into the current state.
export const REQUEST_EVENTS = Object.freeze(['STOCK_CHANGE_REQUESTED', 'STOCK_CHANGE_APPROVED', 'STOCK_CHANGE_REJECTED']);

/** @param {object[]} events journal events, oldest first. @returns {object[]} requests, newest first: { requestId, type, payload, status, requestedBy, requestedAt, decidedBy?, decidedAt?, reason?, solo? } */
export function foldStockRequests(events) {
  const byId = new Map();
  for (const e of events) {
    if (e.object?.kind !== 'stock_request') continue;
    const id = e.object.id;
    if (e.type === 'STOCK_CHANGE_REQUESTED') byId.set(id, { requestId: id, type: e.detail.type, payload: e.detail.payload, status: 'PENDING', requestedBy: e.detail.requestedBy, requestedAt: e.at, decidedBy: null, decidedAt: null, reason: null, selfApproved: false });
    else if (byId.has(id) && e.type === 'STOCK_CHANGE_APPROVED') Object.assign(byId.get(id), { status: 'APPROVED', decidedBy: e.detail.decidedBy, decidedAt: e.at, selfApproved: Boolean(e.approval?.separationWaived) });
    else if (byId.has(id) && e.type === 'STOCK_CHANGE_REJECTED') Object.assign(byId.get(id), { status: 'REJECTED', decidedBy: e.detail.decidedBy, decidedAt: e.at, reason: e.detail.reason ?? null });
  }
  return [...byId.values()].reverse();
}
