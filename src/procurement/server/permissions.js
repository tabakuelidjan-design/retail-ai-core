// Who may do what in Stock / Achats V1 (pure functions: the server and the tests share them).
//
// A user, as the server sees them: { id, role, name?, canApprove?, approverRole?, grants? }.
//   role    OWNER | BUYER | WAREHOUSE | VIEWER     (what the module's own commands check)
//   grants  explicit authorizations an OWNER gave to a named person: 'APPROVE_PO' | 'RECEIVE' | 'ADJUST'
// The OWNER has every grant. When `grants` is absent (the standalone phone server, configured with `canApprove`), the grants are derived exactly as before:
// canApprove -> APPROVE_PO; canApprove with an OWNER / WAREHOUSE role -> RECEIVE and ADJUST. Nobody else receives, adjusts or approves.
//
// V1 rules:  receiving = the owner or a person explicitly authorized (RECEIVE);  adjusting / approving a count = the owner or a person explicitly authorized (ADJUST);
//            nobody approves what they prepared, except the OWNER, with an explicit confirmation for that very operation (`confirmSelfApproval`), which the journal records;
//            an assistant approves nothing: the server builds every approval from the authenticated HUMAN, never from the request body.
export const GRANTS = Object.freeze(['APPROVE_PO', 'RECEIVE', 'ADJUST']);

export function grantsOf(user) {
  if (!user || user.role === 'VIEWER') return new Set(); // a reader holds no grant, whatever was configured
  if (user.role === 'OWNER') return new Set(GRANTS);
  if (Array.isArray(user.grants)) return new Set(user.grants.filter((g) => GRANTS.includes(g)));
  const g = new Set();
  if (user.canApprove) { g.add('APPROVE_PO'); if (['OWNER', 'WAREHOUSE'].includes(user.role)) { g.add('RECEIVE'); g.add('ADJUST'); } }
  return g;
}

export function capabilitiesOf(user) {
  const g = grantsOf(user); const owner = user?.role === 'OWNER'; const read = ['OWNER', 'BUYER', 'WAREHOUSE', 'VIEWER'].includes(user?.role);
  const buys = ['OWNER', 'BUYER'].includes(user?.role);
  return {
    read,
    prepare: buys,                                                    // visits, offers, suppliers, draft orders
    canApprove: g.has('APPROVE_PO'),                                  // approve / place an order
    canReceive: g.has('RECEIVE'),                                     // goods receipt, transfers, count entry
    canAdjust: g.has('ADJUST'),                                       // file an adjustment / count and decide one (never your own, unless owner + confirmation)
    canSelfApprove: owner,                                            // the controlled exception, with confirmation
    grants: [...g],
  };
}

/** The role the module's own permission table sees for a stock-handling command: an explicitly authorized person acts as WAREHOUSE. */
export const stockActor = (user) => ({ id: user.id, role: ['OWNER', 'WAREHOUSE'].includes(user.role) ? user.role : 'WAREHOUSE' });

/** The module policy the SERVERS use (standalone and hosted): the usual separation of duties, plus the owner's per-operation confirmation. Nothing else is waived. */
export const SERVER_POLICY = Object.freeze({ separation: Object.freeze({ 'BUYING.approve_purchase_plan': true, 'STOCK_SALES.adjust_on_hand': true }), soloOwner: Object.freeze({ perOperationConfirmation: true }) });
