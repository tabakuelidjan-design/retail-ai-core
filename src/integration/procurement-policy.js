// Approval-policy entries for the Stock / Achats assistant tools (src/procurement/assistant.js). Kept in their own file so the shared policy table (approval.js)
// changes by ONE spread line. Default-deny still applies to everything not listed here.
//   - the 13 READ tools answer from the ledger and the orders: READ_ONLY;
//   - the 2 PROPOSAL tools only describe what a human could do (executed:false): OWNER_REVIEW, i.e. the result is marked "pending review" and nothing is committed;
//   - there is deliberately NO entry for placing an order, receiving goods, adjusting stock or paying: those stay with the module's own approval steps
//     (BUYING.place_order, STOCK_SALES.receive_goods / adjust_on_hand, FINANCE.pay_supplier) and are never reachable from a sentence.
import { LEVEL as L, MODULE as M } from './constants.js';

/** assistant tool name -> the hub module that owns the capability, the command name, the policy level. */
export const PROCUREMENT_TOOLS = Object.freeze({
  find_item: { module: M.STOCK_SALES, level: L.READ_ONLY },
  stock_position: { module: M.STOCK_SALES, level: L.READ_ONLY },
  stock_overview: { module: M.STOCK_SALES, level: L.READ_ONLY },
  goods_in_transit: { module: M.STOCK_SALES, level: L.READ_ONLY },
  reorder_alerts: { module: M.STOCK_SALES, level: L.READ_ONLY },
  propose_stock_adjustment: { module: M.STOCK_SALES, level: L.OWNER_REVIEW },
  open_purchase_orders: { module: M.BUYING, level: L.READ_ONLY },
  delayed_orders: { module: M.BUYING, level: L.READ_ONLY },
  price_history: { module: M.BUYING, level: L.READ_ONLY },
  supplier_reliability: { module: M.BUYING, level: L.READ_ONLY },
  best_landed_cost_supplier: { module: M.BUYING, level: L.READ_ONLY },
  planned_margin: { module: M.BUYING, level: L.READ_ONLY },
  target_price: { module: M.BUYING, level: L.READ_ONLY },
  expiring_supplier_documents: { module: M.BUYING, level: L.READ_ONLY },
  propose_purchase_order: { module: M.BUYING, level: L.OWNER_REVIEW },
});

export const procCommand = (tool) => `proc_${tool}`;
export const PROCUREMENT_ACTIONS = Object.freeze(Object.fromEntries(Object.entries(PROCUREMENT_TOOLS).map(([tool, t]) => [`${t.module}.${procCommand(tool)}`, t.level])));
