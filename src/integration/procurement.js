// Stock / Achats wiring for the integration layer. ADDITIVE and OPT-IN: nothing here replaces the existing in-memory purchase plan or any existing command.
//  - adapters: the 15 assistant tools of src/procurement become hub commands `proc_<tool>` on the module that owns the capability (STOCK_SALES or BUYING);
//  - rules: extra Parle à Nordla routing rules, evaluated AFTER the existing ones (routeUtterance ctx.extraRules), so every sentence that routes today routes the same way;
//  - never reachable from a sentence: placing an order, receiving goods, adjusting stock, paying. The tools are reads and proposals; the engaging steps keep their own
//    named-human approvals inside the module.
// Rollback: stop passing `procurement` to createIntegration / `extraRules` to routeUtterance (or revert the commit). The existing flows are untouched.
import { MODULE as M, ERR, fail } from './constants.js';
import { INTENT } from './router.js';
import { PROCUREMENT_TOOLS, procCommand } from './procurement-policy.js';

/** @param {{ call: (tool: string, args?: object) => Promise<object>, catalog: {name: string}[] }} assistant  from createProcurement().assistant */
export function createProcurementCommands(assistant) {
  const known = new Set(assistant.catalog.map((t) => t.name));
  for (const tool of Object.keys(PROCUREMENT_TOOLS)) if (!known.has(tool)) fail(ERR.HANDOFF_INVALID, `the procurement assistant has no tool "${tool}": the integration contract is out of date`);
  for (const t of known) if (!(t in PROCUREMENT_TOOLS)) fail(ERR.HANDOFF_INVALID, `the procurement assistant exposes "${t}" but the integration policy does not list it: it would be unreachable (default deny) and must be reviewed first`);
  const byModule = { [M.STOCK_SALES]: {}, [M.BUYING]: {} };
  for (const [tool, t] of Object.entries(PROCUREMENT_TOOLS)) byModule[t.module][procCommand(tool)] = (args = {}) => assistant.call(tool, args ?? {});
  return byModule;
}

/** Merge into an adapters table; a command name that already exists is a conflict, never a silent override. */
export function mergeProcurementAdapters(adapters, assistant) {
  const add = createProcurementCommands(assistant);
  for (const [module, commands] of Object.entries(add)) {
    const target = adapters[module] ?? fail(ERR.MODULE_NOT_AVAILABLE, `no ${module} adapter to extend`);
    for (const name of Object.keys(commands)) if (name in (target.commands ?? {})) fail(ERR.HANDOFF_INVALID, `${module}.${name} already exists`);
    target.commands = { ...target.commands, ...commands };
  }
  return adapters;
}

const rule = (id, re, intent, module, tool) => ({ id: `proc_${id}`, re, intent, route: [[module, procCommand(tool)]], needs: [] });
/** Appended after the existing RULES: the first match wins, so an existing rule always keeps its sentences. */
export const PROCUREMENT_RULES = Object.freeze([
  rule('in_transit', /(en transit|in transit|en route|en cours de livraison|how (much|many).*(on order|transit)|combien.*(en commande|attendu))/, INTENT.SHOW, M.STOCK_SALES, 'goods_in_transit'),
  rule('delayed', /(retard|late|delayed).*(commande|livraison|order|delivery)|(commande|order|livraison|delivery).*(retard|late|delayed)/, INTENT.SHOW, M.BUYING, 'delayed_orders'),
  rule('reorder', /(reapprovision|reorder|rupture|stockout|out of stock|a commander|restock)/, INTENT.SHOW, M.STOCK_SALES, 'reorder_alerts'),
  rule('price_history', /(historique|history).*(prix|price)|(prix|price).*(negocie|negotiat|historique|history)/, INTENT.SHOW, M.BUYING, 'price_history'),
  rule('reliability', /(fiabilite|reliab|ponctualite|punctual|on.time|defaut|defect).*(fournisseur|supplier)|(fournisseur|supplier).*(fiable|reliab|ponctuel|defaut|defect)/, INTENT.SHOW, M.BUYING, 'supplier_reliability'),
  rule('target_price', /(prix cible|target price|prix max|plafond de negociation|negotiation ceiling)/, INTENT.CALCULATE, M.BUYING, 'target_price'),
  rule('margin', /(marge).*(prevue|prevu|attendue|achat|commande)|(planned|expected|forecast).*(margin)/, INTENT.CALCULATE, M.BUYING, 'planned_margin'),
  rule('documents', /(certificat|document|contrat|certificate|contract).*(expir|echeance|perim)|expir.*(certificat|document|certificate)/, INTENT.SHOW, M.BUYING, 'expiring_supplier_documents'),
  rule('open_orders', /(commandes?|bons? de commande|purchase orders?).*(en cours|ouvert|en attente|pending|open|a approuver)|(en attente|pending).*(achat|commande|purchase)/, INTENT.SHOW, M.BUYING, 'open_purchase_orders'),
  rule('propose_po', /(prepar|propos|draft).*(bon de commande|commande fournisseur|purchase order)/, INTENT.CREATE, M.BUYING, 'propose_purchase_order'),
  rule('propose_adjust', /(ajust|corrig|adjust).*(stock|inventaire|inventory)/, INTENT.CREATE, M.STOCK_SALES, 'propose_stock_adjustment'),
  // added by the Parle à Nordla workstream (appended: every sentence that routed before routes the same way). Three sentences the list above left UNROUTABLE:
  rule('stock_overview', /(\bstock\b|inventaire)/, INTENT.SHOW, M.STOCK_SALES, 'stock_overview'),
  rule('to_reorder', /(produits?|articles?)? ?a recommander|a recommander/, INTENT.SHOW, M.STOCK_SALES, 'reorder_alerts'),
  rule('best_landed', /(meilleur|meilleure|moins cher|plus avantageux|compar).*(cout rendu|offre|devis)|cout rendu.*(meilleur|compar)/, INTENT.CALCULATE, M.BUYING, 'best_landed_cost_supplier'),
]);
