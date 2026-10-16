// The Stock / Achats wiring in src/integration: opt-in, additive, nothing existing replaced, nothing engaging reachable from a sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegration, MODULE as M, routeUtterance, STATUS, ACTION_POLICY, LEVEL } from '../src/integration/index.js';
import { PROCUREMENT_RULES, mergeProcurementAdapters, createProcurementCommands } from '../src/integration/procurement.js';
import { PROCUREMENT_TOOLS, PROCUREMENT_ACTIONS } from '../src/integration/procurement-policy.js';
import { makeWorld, orderedPo, receive, buyer } from './procurement-fixtures.js';

const TENANT = '00000000-0000-0000-0000-0000000000f1';
const wf = (n = 'wf-1') => ({ workflow_id: n, initiated_by: 'tester' });

test('the policy lists exactly the assistant tools: 13 reads, 2 proposals, nothing that engages', async () => {
  const w = await makeWorld();
  const names = w.proc.assistant.catalog.map((t) => t.name).sort();
  assert.deepEqual(names, Object.keys(PROCUREMENT_TOOLS).sort(), 'catalog and policy never drift apart');
  assert.equal(names.length, 15);
  const levels = Object.values(PROCUREMENT_TOOLS).map((t) => t.level);
  assert.equal(levels.filter((l) => l === LEVEL.READ_ONLY).length, 13); assert.equal(levels.filter((l) => l === LEVEL.OWNER_REVIEW).length, 2);
  // the two read-only compatibility views (purchase plans, incoming expectations) are the only other entries
  assert.equal(Object.keys(PROCUREMENT_ACTIONS).length, 17); assert.ok(Object.values(PROCUREMENT_ACTIONS).every((l) => l === LEVEL.READ_ONLY || l === LEVEL.OWNER_REVIEW));
  assert.ok(!levels.includes(LEVEL.AUTO_SAFE) && !levels.includes(LEVEL.OWNER_APPROVAL_REQUIRED));
  for (const t of w.proc.assistant.catalog) assert.equal(t.authority === 'READ_ONLY', PROCUREMENT_TOOLS[t.name].level === LEVEL.READ_ONLY, `${t.name}: tool authority and policy level agree`);
  // the engaging steps keep their own policy entries, untouched
  assert.equal(ACTION_POLICY[`${M.BUYING}.place_order`], LEVEL.OWNER_APPROVAL_REQUIRED); assert.equal(ACTION_POLICY[`${M.STOCK_SALES}.receive_goods`], LEVEL.OWNER_APPROVAL_REQUIRED);
  assert.equal(ACTION_POLICY[`${M.STOCK_SALES}.write_shopify`], LEVEL.BLOCKED);
});

test('through the hub: answers come from the real ledger, proposals are marked for review, every call is traced', async () => {
  const w = await makeWorld(); const po = await orderedPo(w, { qty: 200 }); await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 120 }]);
  const before = JSON.stringify(await w.store.snapshot());
  const integ = createIntegration({ tenant_id: TENANT, procurement: w.proc.assistant });
  const pos = await integ.call(M.STOCK_SALES, 'proc_stock_position', { sku: 'MAG-001' }, wf('a'));
  assert.equal(pos.ok, true); assert.equal(pos.status, 'OK'); assert.equal(pos.result.position.available, 120); assert.equal(pos.result.position.incoming.qty, 80);
  const tr = await integ.call(M.STOCK_SALES, 'proc_goods_in_transit', {}, wf('b'));
  assert.equal(tr.result.orderedNotReceived.units, 80);
  const best = await integ.call(M.BUYING, 'proc_best_landed_cost_supplier', { sku: 'MAG-001', qty: 100, fx: { USD: { rate: '0.9', date: '2026-10-16', source: 'test' } } }, wf('c'));
  assert.equal(best.result.comparison.decision.startsWith('NONE'), true);
  const prop = await integ.call(M.BUYING, 'proc_propose_purchase_order', { supplierId: w.supplier.id, lines: [{ sku: 'MAG-001', qty: 150 }] }, wf('d'));
  assert.equal(prop.status, 'REVIEW_REQUIRED'); assert.equal(prop.result.executed, false); assert.equal(prop.level, LEVEL.OWNER_REVIEW);
  const adj = await integ.call(M.STOCK_SALES, 'proc_propose_stock_adjustment', { sku: 'MAG-001', locationId: w.locs.warehouse.id, delta: -500, reason: 'whatever' }, wf('e'));
  assert.equal(adj.status, 'REVIEW_REQUIRED'); assert.equal(adj.result.status, 'WOULD_BE_REFUSED');
  const amb = await integ.call(M.STOCK_SALES, 'proc_stock_position', { sku: 'aimant' }, wf('f'));
  assert.equal(amb.result.status, 'NEED_CLARIFICATION');
  assert.equal(JSON.stringify(await w.store.snapshot()), before, 'no hub call changed anything in Stock / Achats');
  const trace = integ.ledger.list();
  assert.equal(trace.length, 6); assert.deepEqual(trace.map((e) => e.outcome), ['OK', 'OK', 'OK', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED', 'OK']);
  assert.equal(integ.ledger.verify().ok, true);
});

test('what is NOT reachable: placing an order, receiving goods, adjusting, paying - by command name or by sentence', async () => {
  const w = await makeWorld(); const before = JSON.stringify(await w.store.snapshot());
  const integ = createIntegration({ tenant_id: TENANT, procurement: w.proc.assistant });
  for (const [mod, cmd] of [[M.BUYING, 'proc_place_order'], [M.BUYING, 'proc_create_purchase_order'], [M.STOCK_SALES, 'proc_receive_goods'], [M.STOCK_SALES, 'proc_adjust_stock'], [M.FINANCE, 'proc_pay_supplier']]) {
    const r = await integ.call(mod, cmd, {}, wf()); assert.equal(r.ok, false, `${mod}.${cmd}`); assert.ok(['COMMAND_NOT_AVAILABLE', 'BLOCKED', 'MODULE_NOT_AVAILABLE'].includes(r.status), r.status);
  }
  const placed = await integ.call(M.BUYING, 'place_order', {}, wf()); assert.equal(placed.status, 'APPROVAL_REQUIRED', 'the existing engaging action still needs a named human');
  for (const s of ['passe la commande de 500 pieces maintenant', 'paie le fournisseur', 'reçois la marchandise', 'achete 1000 aimants', 'commande maintenant']) {
    const r = routeUtterance(s, { extraRules: PROCUREMENT_RULES });
    assert.ok(r.status === STATUS.UNROUTABLE || !r.route.some((x) => /place_order|receive|pay|adjust_on_hand/.test(x.command)), `${s} -> ${JSON.stringify(r.route ?? r.status)}`);
  }
  assert.equal(JSON.stringify(await w.store.snapshot()), before);
});

test('compatibility: without the opt-in nothing changes; existing commands and plan flow are intact; no silent override', async () => {
  const plain = createIntegration({ tenant_id: TENANT });
  assert.equal((await plain.call(M.STOCK_SALES, 'proc_stock_position', { sku: 'x' }, wf())).status, 'COMMAND_NOT_AVAILABLE');
  assert.equal(plain.hub.has(M.BUYING), true); assert.equal(plain.hub.has(M.STOCK_SALES), true);
  const w = await makeWorld(); const wired = createIntegration({ tenant_id: TENANT, procurement: w.proc.assistant });
  assert.equal((await wired.call(M.STOCK_SALES, 'read_availability', { product_ref: 'nordla:product:p1' }, wf())).ok, true, 'the existing availability read still works');
  assert.deepEqual(wired.availabilityFor('nordla:product:p1').incoming, [], 'the in-memory plan structures are untouched');
  const adapters = { [M.BUYING]: { commands: { proc_price_history: () => 1 } }, [M.STOCK_SALES]: { commands: {} } };
  assert.throws(() => mergeProcurementAdapters(adapters, w.proc.assistant), /already exists/);
  assert.throws(() => mergeProcurementAdapters({}, w.proc.assistant), /no .* adapter/);
});

test('contract drift is caught at wiring time, in both directions', async () => {
  const w = await makeWorld(); const cat = w.proc.assistant.catalog;
  const fake = (names) => ({ catalog: names.map((name) => ({ name })), call: async () => ({}) });
  assert.throws(() => createProcurementCommands(fake(cat.map((t) => t.name).filter((n) => n !== 'target_price'))), /no tool "target_price"/);
  assert.throws(() => createProcurementCommands(fake([...cat.map((t) => t.name), 'delete_everything'])), /does not list it/);
});

test('Parle à Nordla routing: the new questions find their tool; every existing sentence routes exactly as before', () => {
  const extraRules = PROCUREMENT_RULES;
  const route = (s) => { const r = routeUtterance(s, { extraRules }); return r.status === STATUS.ROUTED ? r.route.map((x) => `${x.module}.${x.command}`).join('+') : r.status; };
  const table = [
    ['Combien de marchandises avons-nous en transit ?', 'STOCK_SALES.proc_goods_in_transit'], ['Quelles commandes sont en retard ?', 'BUYING.proc_delayed_orders'],
    ['Quels produits sont en rupture, à réapprovisionner ?', 'STOCK_SALES.proc_reorder_alerts'], ['Montre l’historique des prix négociés', 'BUYING.proc_price_history'],
    ['Ce fournisseur est-il fiable ? taux de défauts', 'BUYING.proc_supplier_reliability'], ['Quel est le prix cible pour 5000 pièces ?', 'BUYING.proc_target_price'],
    ['Quelle est la marge prévue sur cet achat ?', 'BUYING.proc_planned_margin'], ['Quels certificats fournisseur expirent bientôt ?', 'BUYING.proc_expiring_supplier_documents'],
    ['Les bons de commande en attente d’approbation', 'BUYING.proc_open_purchase_orders'], ['Prépare un bon de commande pour ce fournisseur', 'BUYING.proc_propose_purchase_order'],
    ['Propose un ajustement d’inventaire pour l’aimant rond', 'STOCK_SALES.proc_propose_stock_adjustment'],
  ];
  // precedence is deliberate: the built-in stock rule keeps any sentence it already claimed ("... le stock de ..."), so new rules can only ADD routes
  assert.equal(route('Ajuste le stock de l’aimant rond'), STATUS.ASK);
  for (const [s, want] of table) assert.equal(route(s), want, s);
  const proposals = routeUtterance('Prépare un bon de commande pour ce fournisseur', { extraRules });
  assert.equal(proposals.needs_review, true); assert.equal(proposals.needs_approval, false);
  const existing = ['Pourquoi les ventes baissent ?', 'Montre-moi les factures de ce fournisseur', 'Compare les meilleurs fournisseurs pour ce produit', 'Combien il reste en stock du produit Aimant', 'Prépare une campagne pour ce produit', 'Résume-moi ce dossier', 'tout sur la finance du fournisseur', 'bonjour'];
  for (const s of existing) assert.deepEqual(routeUtterance(s, { extraRules }), routeUtterance(s), `existing sentence unchanged: ${s}`);
});
