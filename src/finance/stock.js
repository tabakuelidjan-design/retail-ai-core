// Stock synchronisation for Finance sales. Shopify / Retail Core stays the inventory source of truth: Finance never keeps a stock level,
// it keeps an append-only LEDGER OF MOVEMENTS and applies each one to Shopify at most once.
//
// Rules (owner decision 2026-09-22):
//   - invoice linked to a shop / POS order          -> never decrement again
//   - standalone B2B invoice, catalogue-linked line -> decrement exactly once when the invoice is ISSUED
//   - draft, quote, custom line                     -> no stock change
//   - retry / reload                                -> idempotent (unique key per document + line + kind)
//   - credit note                                   -> restock only after an explicit merchant decision
//
// Audit chain kept forever on every movement: finance document -> line -> variant -> location -> quantity -> Shopify adjustment.
// The Shopify permission (write_inventory) is used for inventory quantity adjustments only, never for product data, prices or images.

import { FinanceError } from './document.js';

export const STOCK_MODES = ['off', 'dry_run', 'live'];
export const MOVEMENT_STATUSES = ['PENDING', 'APPLYING', 'APPLIED', 'FAILED', 'UNCERTAIN', 'SKIPPED'];
/** Allowed status changes. APPLIED and SKIPPED are final. */
export const TRANSITIONS = { PENDING: ['APPLYING', 'SKIPPED', 'FAILED'], APPLYING: ['APPLIED', 'FAILED', 'UNCERTAIN'], FAILED: ['PENDING'], UNCERTAIN: ['PENDING', 'APPLIED'], APPLIED: [], SKIPPED: [] };

const keyOf = (docId, position, kind) => `${docId}:${position}:${kind}`;
const wholeQty = (qtyMilli) => Number.isInteger(qtyMilli) && qtyMilli > 0 && qtyMilli % 1000 === 0;

/**
 * Pure planning: which movements does this document require? No I/O.
 * @returns {{movements: object[], reason: string|null}}
 */
export function planMovements(doc, { invoice = null } = {}) {
  const linesOf = (d, kind, sign) => (d.lines ?? []).filter((l) => l.catalog?.variantId).map((l) => (wholeQty(l.qtyMilli)
    ? { position: l.position, variantId: l.catalog.variantId, quantity: l.qtyMilli / 1000, delta: sign * (l.qtyMilli / 1000), kind, key: keyOf(d.id, l.position, kind), skip: null }
    : { position: l.position, variantId: l.catalog.variantId, quantity: 0, delta: 0, kind, key: keyOf(d.id, l.position, kind), skip: 'FRACTIONAL_OR_INVALID_QUANTITY' }));
  if (doc.type === 'invoice') {
    if (!doc.lockedAt || !['ISSUED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CREDITED'].includes(doc.status)) return { movements: [], reason: 'NOT_ISSUED' };
    if (doc.revenueBasis !== 'standalone_b2b') return { movements: [], reason: 'LINKED_TO_SHOP_ORDER_OR_UNDECLARED' };
    return { movements: linesOf(doc, 'SALE_DECREMENT', -1), reason: null };
  }
  if (doc.type === 'credit_note') {
    if (!doc.lockedAt) return { movements: [], reason: 'NOT_ISSUED' };
    if (!invoice || invoice.revenueBasis !== 'standalone_b2b') return { movements: [], reason: 'ORIGINAL_NOT_A_STANDALONE_B2B_INVOICE' };
    if (doc.stockReturn?.restock !== true) return { movements: [], reason: doc.stockReturn?.restock === false ? 'MERCHANT_DECLINED_RESTOCK' : 'RESTOCK_DECISION_MISSING' };
    return { movements: linesOf(doc, 'RETURN_RESTOCK', +1), reason: null };
  }
  return { movements: [], reason: 'DOCUMENT_TYPE_HAS_NO_STOCK_EFFECT' };
}

/**
 * @param {{store: object, merchantId: string, retail: {getCatalogVariant: Function, listLocations?: Function}|null, applier?: object|null,
 *          getSettings: () => Promise<{stock: {mode: string, locationId: string|null}}>, now?: () => string, audit?: Function}} deps
 * applier contract (Shopify): { hasScope(): Promise<boolean>, lookup(variantSourceId): Promise<{inventoryItemId, tracked}|null>,
 *   adjust({inventoryItemId, locationSourceId, delta, reason, referenceUri, key}): Promise<{ok: true, adjustmentId} | {ok: false, errors: string[]}> }
 */
export function createStockService({ store, merchantId, retail, applier = null, getSettings, now = () => new Date().toISOString(), audit = async () => {} }) {
  const settingsOf = async () => (await getSettings()).stock ?? { mode: 'off', locationId: null };

  async function resolveLocation(stockSettings) {
    const locations = (await retail?.listLocations?.()) ?? [];
    if (stockSettings.locationId) return locations.find((l) => l.id === stockSettings.locationId) ?? null;
    return locations.length === 1 ? locations[0] : null; // the only location is unambiguous; otherwise the merchant must choose
  }

  async function record(doc, { invoice = null } = {}) {
    if (doc.merchantId !== merchantId) throw new FinanceError('DOCUMENT_NOT_FOUND', doc.id);
    const { movements, reason } = planMovements(doc, { invoice });
    const cfg = await settingsOf();
    const location = movements.length ? await resolveLocation(cfg) : null;
    const created = [];
    for (const m of movements) {
      const variant = await retail?.getCatalogVariant?.(m.variantId);
      let status = 'PENDING'; let error = null;
      if (m.skip) { status = 'SKIPPED'; error = m.skip; }
      else if (!variant?.variantSourceId) { status = 'FAILED'; error = 'VARIANT_NOT_FOUND_IN_RETAIL_CORE'; }
      const row = {
        merchantId, documentId: doc.id, documentNumber: doc.number ?? null, documentType: doc.type, linePosition: m.position, kind: m.kind,
        variantId: m.variantId, variantSourceId: variant?.variantSourceId ?? null, sku: variant?.sku ?? null, locationId: location?.id ?? null, locationSourceId: location?.source_id ?? null,
        quantity: m.quantity, delta: m.delta, status, error, idempotencyKey: m.key, shopifyAdjustmentId: null, createdAt: now(), appliedAt: null,
      };
      const r = await store.insertStockMovement(row);
      if (r.created) created.push(r.row);
    }
    if (created.length) await audit({ at: now(), action: 'STOCK_MOVEMENTS_RECORDED', documentId: doc.id, count: created.length });
    return { created, existing: movements.length - created.length, reason };
  }

  const cas = async (id, from, patch) => { const r = await store.updateStockMovement(id, patch, from); if (!r) throw new FinanceError('STOCK_MOVEMENT_STATE_CHANGED', id); return r; };

  /** Apply pending movements. `dry_run` only reports; `live` writes to Shopify; `off` does nothing. Each movement is applied at most once. */
  async function applyPending() {
    const cfg = await settingsOf();
    const pending = (await store.listStockMovements({ merchantId, status: 'PENDING' }));
    if (cfg.mode === 'off') return { mode: 'off', applied: 0, pending: pending.length, results: [] };
    if (!applier) return { mode: cfg.mode, applied: 0, pending: pending.length, results: [], blocked: 'NO_SHOPIFY_CONNECTION' };
    if (cfg.mode === 'live' && !(await applier.hasScope())) return { mode: cfg.mode, applied: 0, pending: pending.length, results: [], blocked: 'SCOPE_MISSING_WRITE_INVENTORY' };
    const results = []; let applied = 0;
    for (const m of pending) {
      const loc = m.locationSourceId ? { source_id: m.locationSourceId, id: m.locationId } : await resolveLocation(cfg);
      if (!loc) { results.push({ id: m.id, outcome: 'BLOCKED', reason: 'LOCATION_NOT_CONFIGURED' }); continue; }
      let item = null;
      try { item = await applier.lookup(m.variantSourceId); } catch (e) { results.push({ id: m.id, outcome: 'LOOKUP_FAILED' }); continue; }
      if (!item || item.tracked === false) { if (cfg.mode === 'live') await cas(m.id, 'PENDING', { status: 'FAILED', error: item ? 'INVENTORY_NOT_TRACKED' : 'INVENTORY_ITEM_NOT_FOUND' }); results.push({ id: m.id, outcome: 'CANNOT_ADJUST', reason: item ? 'INVENTORY_NOT_TRACKED' : 'INVENTORY_ITEM_NOT_FOUND' }); continue; }
      if (cfg.mode === 'dry_run') { results.push({ id: m.id, outcome: 'WOULD_ADJUST', delta: m.delta, variantSourceId: m.variantSourceId, locationSourceId: loc.source_id }); continue; }
      // live: claim first (compare-and-set), so two runs can never both adjust the same movement
      try { await cas(m.id, 'PENDING', { status: 'APPLYING', locationId: loc.id ?? m.locationId, locationSourceId: loc.source_id }); } catch (e) { if (e.code === 'STOCK_MOVEMENT_STATE_CHANGED') { results.push({ id: m.id, outcome: 'CLAIMED_ELSEWHERE' }); continue; } throw e; }
      let r;
      try {
        r = await applier.adjust({ inventoryItemId: item.inventoryItemId, locationSourceId: loc.source_id, delta: m.delta, reason: m.kind === 'RETURN_RESTOCK' ? 'restock' : 'other', referenceUri: `gid://finance-app/${m.documentType}/${m.documentNumber ?? m.documentId}#line-${m.linePosition}`, key: m.idempotencyKey });
      } catch (e) {
        // outcome unknown (network cut after sending): never guess, never re-apply automatically
        await cas(m.id, 'APPLYING', { status: 'UNCERTAIN', error: 'OUTCOME_UNKNOWN_CHECK_SHOPIFY' });
        results.push({ id: m.id, outcome: 'UNCERTAIN' }); continue;
      }
      if (r.ok) { await cas(m.id, 'APPLYING', { status: 'APPLIED', shopifyAdjustmentId: r.adjustmentId ?? null, appliedAt: now(), error: null }); applied += 1; results.push({ id: m.id, outcome: 'APPLIED' }); await audit({ at: now(), action: 'STOCK_MOVEMENT_APPLIED', movementId: m.id, documentId: m.documentId }); }
      else { await cas(m.id, 'APPLYING', { status: 'FAILED', error: String((r.errors ?? ['REJECTED']).join('; ')).slice(0, 300) }); results.push({ id: m.id, outcome: 'FAILED' }); }
    }
    return { mode: cfg.mode, applied, pending: pending.length - applied, results };
  }

  return {
    record, applyPending, planMovements,
    list: (f = {}) => store.listStockMovements({ merchantId, ...f }),
    /** A failed movement (Shopify refused it, nothing changed) can be retried. An UNCERTAIN one needs the merchant to say what Shopify shows. */
    async retry(id, { appliedInShopify = null } = {}) {
      const m = await store.getStockMovement(id);
      if (!m || m.merchantId !== merchantId) throw new FinanceError('STOCK_MOVEMENT_NOT_FOUND', id);
      if (m.status === 'FAILED') return cas(id, 'FAILED', { status: 'PENDING', error: null });
      if (m.status === 'UNCERTAIN') {
        if (appliedInShopify === null) throw new FinanceError('DECISION_REQUIRED_APPLIED_OR_NOT');
        return appliedInShopify ? cas(id, 'UNCERTAIN', { status: 'APPLIED', appliedAt: now(), error: 'CONFIRMED_BY_MERCHANT' }) : cas(id, 'UNCERTAIN', { status: 'PENDING', error: null });
      }
      throw new FinanceError('INVALID_TRANSITION', m.status);
    },
    /** Issued standalone documents that have no movements yet (crash between issuance and recording): create them, never duplicate. */
    async reconcile(docs, invoiceOf) {
      let created = 0;
      for (const d of docs) if (['invoice', 'credit_note'].includes(d.type) && d.lockedAt && d.merchantId === merchantId) created += (await record(d, { invoice: d.type === 'credit_note' ? await invoiceOf(d.relatedDocumentId) : null })).created.length;
      return { created };
    },
    /** Does this credit note still need the "return to sellable stock?" decision? */
    async restockDecisionNeeded(creditNote, invoice) {
      if (creditNote.type !== 'credit_note' || !invoice || invoice.revenueBasis !== 'standalone_b2b') return false;
      if (!(creditNote.lines ?? []).some((l) => l.catalog?.variantId)) return false;
      const sold = (await store.listStockMovements({ merchantId, documentId: invoice.id })).some((m) => m.kind === 'SALE_DECREMENT' && m.status !== 'SKIPPED');
      return sold && typeof creditNote.stockReturn?.restock !== 'boolean';
    },
    async status() {
      const cfg = await settingsOf();
      const all = await store.listStockMovements({ merchantId });
      const counts = Object.fromEntries(MOVEMENT_STATUSES.map((s) => [s, all.filter((m) => m.status === s).length]));
      const locations = ((await retail?.listLocations?.()) ?? []).map((l) => ({ id: l.id, name: l.name }));
      const loc = await resolveLocation(cfg);
      let scope = 'UNKNOWN'; try { if (applier) scope = (await applier.hasScope()) ? 'OK' : 'MISSING'; } catch { scope = 'UNKNOWN'; }
      return { mode: cfg.mode, locationId: loc?.id ?? null, locationName: loc?.name ?? null, locations, scope, counts };
    },
  };
}

/** Shopify Admin GraphQL applier. The ONLY mutation is inventoryAdjustQuantities: no product, variant, price or image is ever written. */
export function createShopifyStockApplier(shopify) {
  const SCOPES = 'query { currentAppInstallation { accessScopes { handle } } }';
  const ITEM = 'query($id: ID!) { productVariant(id: $id) { inventoryItem { id tracked } } }';
  const ADJUST = 'mutation($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { inventoryAdjustmentGroup { id } userErrors { field message } } }';
  return {
    async hasScope() { const r = await shopify.graphql(SCOPES); return (r?.currentAppInstallation?.accessScopes ?? []).some((s) => s.handle === 'write_inventory'); },
    async lookup(variantSourceId) { const r = await shopify.graphql(ITEM, { id: variantSourceId }); const i = r?.productVariant?.inventoryItem; return i ? { inventoryItemId: i.id, tracked: i.tracked !== false } : null; },
    async adjust({ inventoryItemId, locationSourceId, delta, reason, referenceUri }) {
      const r = await shopify.graphql(ADJUST, { input: { reason, name: 'available', referenceDocumentUri: referenceUri, changes: [{ delta, inventoryItemId, locationId: locationSourceId }] } });
      const p = r?.inventoryAdjustQuantities;
      if (p?.userErrors?.length) return { ok: false, errors: p.userErrors.map((e) => e.message) };
      return p?.inventoryAdjustmentGroup?.id ? { ok: true, adjustmentId: p.inventoryAdjustmentGroup.id } : { ok: false, errors: ['NO_ADJUSTMENT_RETURNED'] };
    },
  };
}
