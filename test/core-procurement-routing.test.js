// Parle à Nordla x Stock / Achats (convergence): every request reaches the right module, nothing engaging is reachable from a sentence, retries create no duplicates, and a module that is down or absent is said so.
// Uses the REAL procurement assistant (15 tools) over the memory store; Core and Sourcing are the real engines on synthetic cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { askNordla } from '../src/core-pilot/ask.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createMemoryJournal } from '../src/core-pilot/journal.js';
import { validateCoreConfig } from '../src/core-pilot/config.js';
import { makeWorld, orderedPo, buyer, key } from './procurement-fixtures.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial, extraTraits } from './sourcing-fixtures.js';

const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
const blocked = mk([...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({})], 'blocked');
const AUTH = /(^|[^a-z])oui([^a-z]|$)|vous pouvez (maintenant )?(commander|acheter|payer)|achat autorisé|commande (passée|validée|confirmée|envoyée)|c.est (bon|validé|autorisé)/i;

/** A world with an ordered PO (200 x MAG-001, 120 received), a second PO waiting for approval, a reorder alert, and a spy on the assistant: which tools were called. */
async function world({ procurement = true } = {}) {
  const w = await makeWorld(); const po = await orderedPo(w, { qty: 200 });
  const { purchaseOrder: pending } = await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-12-01', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 100, quoteId: w.quote.id }] });
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: pending.id });
  const calls = []; const spy = { call: async (tool, args) => { calls.push(tool); return w.proc.assistant.call(tool, args); }, catalog: w.proc.assistant.catalog };
  const rt = createCoreRuntime({ merchantId: 'm', config: CONFIG, journal: createMemoryJournal({ merchantId: 'm' }), now: () => NOW });
  const ctx = { runtime: rt, getCase: async (id) => (id === 'blocked' ? blocked : null), externals: { safety: LIVE_CLEAN }, actor: { userId: 'u', role: 'OWNER' }, now: NOW, ...(procurement ? { procurement: spy } : {}) };
  return { w, po, pending, calls, rt, ask: (text, caseId = null, extra = {}) => askNordla({ text, caseId }, { ...ctx, ...extra }) };
}

test('the six ambiguous requests reach the right module (and the case assistant never captures a Stock / Achats request)', async () => {
  const x = await world();
  const stock = await x.ask('Mon stock', 'blocked'); assert.ok(stock.sources.some((s) => s.kind === 'procurement'), 'stock -> Stock / Achats'); assert.match(stock.answer, /MAG-001/); assert.equal(stock.intent, undefined);
  const transit = await x.ask('Marchandises en transit', 'blocked'); assert.equal(transit.sources[0].ref, 'goods_in_transit'); assert.match(transit.answer, /200 unité/);
  const open = await x.ask('Commandes en attente', 'blocked'); assert.equal(open.sources[0].ref, 'open_purchase_orders'); assert.match(open.answer, /PO-/);
  const reorder = await x.ask('Produits à recommander', 'blocked'); assert.equal(reorder.sources[0].ref, 'reorder_alerts');
  const best = await x.ask('Meilleur fournisseur', 'blocked'); assert.equal(best.intent, 'COMPARE_OFFERS', 'no item named: the open case answers (one offer), it points to the exact next step'); assert.deepEqual(best.sources[0], { kind: 'sourcing_case', ref: 'blocked', version: blocked.updatedAt });
  const bestCost = await x.ask('Meilleur coût rendu', 'blocked'); assert.equal(bestCost.intent, 'COMPARE_OFFERS'); assert.doesNotMatch(bestCost.answer, /le meilleur (est|fournisseur)|retenez|choisissez/i);
  const named = await x.ask('Meilleur fournisseur pour MAG-001 pour 100 pièces', 'blocked'); assert.equal(named.sources[0].ref, 'best_landed_cost_supplier'); assert.match(named.answer, /Shenzhen Gifts Co/);
  assert.match(named.answer, /taux de change non renseigné \(je n’en invente pas\)|marchandise SEULEMENT/, 'no exchange rate, freight or duty is invented'); assert.match(named.answer, /ne désigne ni ne commande personne/);
  assert.equal((await x.ask('Meilleur fournisseur pour MAG-001', 'blocked')).status, 'ASK', 'a missing quantity is asked for, never guessed');
  const approvals = await x.ask('Propositions en attente d’approbation', 'blocked'); assert.match(approvals.answer, /Nordla Core — aucune décision/); assert.match(approvals.answer, /Stock \/ Achats — 1 commande\(s\) d’achat à approuver/); assert.match(approvals.answer, /Nordla n’approuve rien/);
});

test('backward compatibility: with Stock / Achats connected the case questions, the journal answers and Finance / Analytics behave exactly as before', async () => {
  const x = await world();
  const margin = await x.ask('quelle est la marge ?', 'blocked'); assert.equal(margin.intent, 'MARGIN'); assert.deepEqual(margin.sources[0], { kind: 'sourcing_case', ref: 'blocked', version: blocked.updatedAt });
  assert.match((await x.ask('résume ce dossier', 'blocked')).answer, /blocage dur/);
  assert.match((await x.ask('puis-je commander ?', 'blocked')).answer, /^Pas à ce stade/);
  assert.match((await x.ask('quelles décisions sont en attente ?')).answer, /Aucune décision n’attend votre validation/);
  for (const q of ['quelles factures fournisseurs dois-je payer ?', 'ma trésorerie', 'comment évoluent mes ventes ?']) assert.equal((await x.ask(q, 'blocked')).status, 'MODULE_NOT_CONNECTED', q);
  assert.deepEqual(x.calls.filter((c) => !['stock_overview', 'goods_in_transit', 'open_purchase_orders', 'reorder_alerts'].includes(c)), [], 'case / Finance questions never touch Stock / Achats');
});

test('read-only: only READ tools are ever called, nothing is written, and the same question repeated (retries) gives the same answer with no duplicate anywhere', async () => {
  const x = await world(); const before = JSON.stringify(await x.w.store.snapshot());
  const qs = ['Mon stock', 'Marchandises en transit', 'Commandes en attente', 'Produits à recommander', 'Meilleur fournisseur pour MAG-001 pour 100 pièces', 'Propositions en attente d’approbation', 'quelle est la marge ?', 'Meilleur fournisseur'];
  const first = []; for (const q of qs) first.push(JSON.stringify((await x.ask(q, 'blocked')).answer));
  for (let round = 0; round < 3; round += 1) for (const [i, q] of qs.entries()) assert.equal(JSON.stringify((await x.ask(q, 'blocked')).answer), first[i], `${q}: retry ${round} gave another answer`);
  assert.equal(JSON.stringify(await x.w.store.snapshot()), before, 'the procurement store is byte-identical after every question and retry');
  assert.equal((await x.rt.overview()).decisions.length, 0, 'the Core journal is untouched');
  const readTools = new Set(x.w.proc.assistant.catalog.filter((t) => t.authority === 'READ_ONLY').map((t) => t.name));
  assert.ok(x.calls.length > 0 && x.calls.every((c) => readTools.has(c)), `non-read tool called: ${[...new Set(x.calls)].join(', ')}`);
  assert.ok(!x.calls.some((c) => c.startsWith('propose_')), 'not even a proposal is made from a sentence');
});

test('actions are refused out loud even with Stock / Achats connected: no order, no payment, no approval, no stock change, no tool call', async () => {
  const x = await world(); const before = JSON.stringify(await x.w.store.snapshot());
  for (const q of [`passe la commande ${x.po.number}`, `approuve la commande ${x.pending.number}`, 'commande 500 pièces de MAG-001', 'paie l’acompte au fournisseur', 'ajuste le stock de MAG-001 de 50', 'réceptionne la livraison', 'annule la commande', 'envoie la commande au fournisseur']) {
    const r = await x.ask(q, 'blocked'); assert.equal(r.status, 'ACTION_REFUSED', q); assert.doesNotMatch(r.answer, AUTH, q);
  }
  assert.deepEqual(x.calls, [], 'no assistant tool was called for an order to act'); assert.equal(JSON.stringify(await x.w.store.snapshot()), before);
  for (const q of ['commande fournisseur en cours ?', 'Où en est ma commande ?', 'quelle commande est en retard ?']) assert.notEqual((await x.ask(q, 'blocked')).status, 'ACTION_REFUSED', `${q}: a question about orders is not an order`);
});

test('modules absent or down: Stock / Achats missing -> stock questions are NOT connected; the module failing mid-question degrades to an honest answer, never a crash or an invented number', async () => {
  const off = await world({ procurement: false });
  assert.equal((await off.ask('Mon stock', 'blocked')).status, 'MODULE_NOT_CONNECTED'); assert.doesNotMatch((await off.ask('Mon stock', 'blocked')).answer, /\d/);
  const approvals = await off.ask('Propositions en attente d’approbation', 'blocked'); assert.match(approvals.answer, /Stock \/ Achats — non raccordé/); assert.ok(approvals.limits.some((l) => /pas relié/.test(l)));
  const down = await world(); const boom = { call: async () => { throw new Error('ECONNRESET: store unreachable (secret-connection-string)'); }, catalog: [] };
  for (const q of ['Mon stock', 'Commandes en attente', 'Meilleur fournisseur pour MAG-001 pour 100 pièces']) {
    const r = await down.ask(q, 'blocked', { procurement: boom }); assert.equal(r.status, 'MODULE_NOT_CONNECTED', q); assert.match(r.answer, /Rien n’a été changé/); assert.doesNotMatch(JSON.stringify(r), /ECONNRESET|secret-connection-string/, 'the error text (possibly a secret) never reaches the person');
  }
  const partial = await down.ask('Propositions en attente d’approbation', 'blocked', { procurement: boom }); assert.match(partial.answer, /réessayez/);
});

test('isolation between companies: one company\'s assistant never shows another company\'s items, orders or suppliers', async () => {
  const a = await world(); const other = await makeWorld({ merchantId: randomUUID() });
  await other.mk(other.c.createItem, buyer, { sku: 'ZZ-FOREIGN-77', name: 'Secret product of another company' });
  const mine = JSON.stringify(await a.ask('Mon stock', 'blocked')); assert.doesNotMatch(mine, /ZZ-FOREIGN|another company/);
  const probe = await a.ask('stock de ZZ-FOREIGN-77', 'blocked'); assert.doesNotMatch(JSON.stringify(probe), /Secret product/); assert.match(probe.answer, /Je ne trouve|Quel article|Aucun/);
  const theirs = await askNordla({ text: 'Mon stock', caseId: null }, { runtime: null, getCase: async () => null, externals: {}, actor: {}, now: NOW, procurement: other.proc.assistant }); assert.match(theirs.answer, /ZZ-FOREIGN-77/); const theirOrders = await askNordla({ text: 'Commandes en attente', caseId: null }, { runtime: null, getCase: async () => null, externals: {}, actor: {}, now: NOW, procurement: other.proc.assistant }); assert.doesNotMatch(theirOrders.answer, /PO-/, 'the other company sees none of our purchase orders');
});

test('expiring supplier documents are answered from Stock / Achats; supplier search is honestly not available', async () => {
  const x = await world(); const r = await x.ask('Quels certificats fournisseurs expirent bientôt ?', 'blocked');
  assert.equal(r.sources[0].ref, 'expiring_supplier_documents'); assert.match(r.answer, /Aucun document fournisseur|document\(s\) fournisseur/);
});

// ===================================================================== supplier search by name, role-gated; stock adjustment vs execution
test('supplier search by name: found, ambiguous, not found; no contact or bank detail ever leaves the tool; terms only for OWNER / ADMIN; isolation between companies', async () => {
  const x = await world(); const w = x.w;
  await w.mk(w.c.createSupplier, buyer, { name: 'Shenzhen Gifts Trading', country: 'cn', currency: 'USD', incotermDefault: 'FOB', payment: { depositPct: '30', balancePct: '70' }, leadTimeDays: 40, contacts: [{ name: 'Secret Person', email: 'secret@supplier.example' }], bank: { iban: 'CN00SECRET' } });
  const owner = await x.ask('Retrouve le fournisseur Shenzhen Gifts Co', 'blocked', { actor: { userId: 'u', role: 'OWNER' } });
  assert.match(owner.answer, /Fournisseur : Shenzhen Gifts Co \(CN\)/); assert.match(owner.answer, /devise USD, Incoterm FOB, délai 35 j/); assert.match(owner.answer, /Fiabilité \(faits tracés, pas de note\)/); assert.equal(owner.sources[0].ref, 'find_supplier');
  const viewer = await x.ask('Retrouve le fournisseur Shenzhen Gifts Co', 'blocked', { actor: { userId: 'v', role: 'COLLABORATOR' } });
  assert.match(viewer.answer, /Fournisseur : Shenzhen Gifts Co/); assert.doesNotMatch(viewer.answer, /Incoterm|devise|Fiabilité/); assert.ok(viewer.limits.some((l) => /Propriétaire et Administrateur/.test(l)));
  const amb = await x.ask('cherche le fournisseur shenzhen', 'blocked', { actor: { userId: 'u', role: 'OWNER' } }); assert.equal(amb.status, 'ASK'); assert.match(amb.answer, /Shenzhen Gifts Co.*Shenzhen Gifts Trading|Shenzhen Gifts Trading.*Shenzhen Gifts Co/);
  const none = await x.ask('trouve le fournisseur Inconnu SARL', 'blocked'); assert.match(none.answer, /Je ne trouve aucun fournisseur/); assert.ok(none.limits.some((l) => /China Sourcing/.test(l)));
  const raw = await w.proc.assistant.call('find_supplier', { text: 'shenzhen gifts trading' }); assert.deepEqual(Object.keys(raw.candidates[0]).sort(), ['country', 'currency', 'incotermDefault', 'leadTimeDays', 'name', 'supplierId']);
  assert.doesNotMatch(JSON.stringify(raw) + owner.answer + viewer.answer + amb.answer, /Secret Person|secret@supplier|CN00SECRET/, 'contacts and bank details never leave');
  const other = await makeWorld({ merchantId: randomUUID() }); await other.mk(other.c.createSupplier, buyer, { name: 'ZZ Foreign Supplier', country: 'de', currency: 'EUR' });
  assert.match((await x.ask('retrouve le fournisseur ZZ Foreign Supplier', 'blocked')).answer, /Je ne trouve aucun fournisseur/, 'another company\'s supplier does not exist here');
  for (const q of ['quels risques avec ce fournisseur ?', 'factures du fournisseur Shenzhen', 'le meilleur fournisseur']) assert.doesNotMatch(String((await x.ask(q, 'blocked')).sources?.[0]?.ref), /find_supplier/, `${q}: not a supplier lookup`);
});

test('stock and orders: the refusal says PROPOSING describes and EXECUTING is a named person in Achats; nothing is executed or called', async () => {
  const x = await world(); const before = JSON.stringify(await x.w.store.snapshot());
  const adj = await x.ask('ajuste le stock de MAG-001 de -50', 'blocked'); assert.equal(adj.status, 'ACTION_REFUSED'); assert.match(adj.answer, /s’exécute dans Achats, par une personne autorisée, avec son approbation nominative/); assert.match(adj.answer, /seulement le décrire sans rien modifier \(une proposition\)/);
  const ord = await x.ask('passe la commande 500 pièces de MAG-001', 'blocked'); assert.match(ord.answer, /approbation nominative/); assert.doesNotMatch(ord.answer, /ajustement de stock/);
  assert.deepEqual(x.calls, []); assert.equal(JSON.stringify(await x.w.store.snapshot()), before);
});

test('SKUs with several hyphen segments (TEST-MAG-001) are read whole, and "mes commandes" / "les commandes" reach the open-orders answer', async () => {
  const x = await world(); const w = x.w;
  await w.mk(w.c.createItem, buyer, { sku: 'TEST-MAG-009', name: '[TEST] Aimant multi-segments' });
  const st = await x.ask('stock de TEST-MAG-009', 'blocked'); assert.match(st.answer, /TEST-MAG-009/); assert.doesNotMatch(st.answer, /Quel article|Je ne trouve/);
  assert.equal((await x.ask('mes commandes', 'blocked')).sources[0].ref, 'open_purchase_orders');
  assert.equal((await x.ask('Les commandes', 'blocked')).sources[0].ref, 'open_purchase_orders');
  const cmp = await x.ask('Meilleur fournisseur pour TEST-MAG-009 pour 100 pièces', 'blocked'); assert.doesNotMatch(cmp.answer, /Which exact SKU/); assert.ok(['ANSWERED', 'ASK'].includes(cmp.status));
});
