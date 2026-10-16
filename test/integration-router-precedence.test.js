// Hub router precedence for Stock / Achats sentences: the historic rules keep every sentence they routed before (nothing is re-routed), and the
// six sentences a person says in a shop now reach a module instead of "UNROUTABLE". Engaging steps are never reachable from a sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeUtterance, STATUS } from '../src/integration/router.js';
import { PROCUREMENT_RULES } from '../src/integration/procurement.js';
import { ACTION_POLICY } from '../src/integration/approval.js';
import { LEVEL } from '../src/integration/constants.js';

const route = (q, active) => routeUtterance(q, { extraRules: PROCUREMENT_RULES, available: () => true, active: active ?? { module: 'china_sourcing', entities: {} } });
const target = (r) => (r.route ?? []).map((s) => `${s.module}.${s.command}`).join(',');

test('the six shop sentences reach Stock / Achats or Buying (the historic compare rule keeps "meilleur fournisseur" and ASKS which product)', () => {
  assert.equal(target(route('Marchandises en transit')), 'STOCK_SALES.proc_goods_in_transit');
  assert.equal(target(route('Commandes en attente')), 'BUYING.proc_open_purchase_orders');
  assert.equal(target(route('Produits à recommander')), 'STOCK_SALES.proc_reorder_alerts');
  assert.equal(target(route('Meilleur coût rendu')), 'BUYING.proc_best_landed_cost_supplier');
  assert.equal(target(route('Mon stock')), 'STOCK_SALES.proc_stock_overview');
  const best = route('Meilleur fournisseur'); assert.equal(best.rule, 'compare_suppliers', 'a historic rule keeps its sentence'); assert.equal(best.status, STATUS.ASK, 'and asks which product instead of guessing');
});

test('append-only: sentences the historic rules routed are routed exactly as before, with or without the Stock / Achats rules', () => {
  for (const q of ['pourquoi mes ventes ont baissé ?', 'montre les factures de ce fournisseur', 'combien de stock reste-t-il de ce produit ?', 'résume ce dossier', 'compare les fournisseurs de ce produit', 'prépare une campagne pour ce produit']) {
    const withRules = route(q); const without = routeUtterance(q, { available: () => true, active: { module: 'china_sourcing', entities: {} } });
    assert.equal(withRules.status, without.status, q); assert.equal(target(withRules), target(without), q); assert.equal(withRules.rule, without.rule, q);
  }
});

test('never engaging: every route a Stock / Achats rule can produce is a read or a proposal for review - none places an order, receives goods, adjusts stock or pays', () => {
  for (const r of PROCUREMENT_RULES) for (const [module, command] of r.route) {
    const level = ACTION_POLICY[`${module}.${command}`]; assert.ok(level === LEVEL.READ_ONLY || level === LEVEL.OWNER_REVIEW, `${r.id}: ${module}.${command} is ${level}`);
  }
  for (const q of ['passe la commande', 'réceptionne la livraison', 'paie l’acompte']) assert.notEqual(route(q).status, STATUS.ROUTED, `${q}: nothing engaging is routed from a sentence`);
});
