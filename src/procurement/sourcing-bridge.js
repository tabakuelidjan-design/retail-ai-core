// China Sourcing -> Stock / Achats bridge. A supplier visit recorded as a Sourcing case (supplier, product name, photos, quotes with tiers / MOQ / currency /
// Incoterm / payment terms) becomes, WITHOUT retyping: a supplier profile, a PROSPECT catalogue item with its photo references, one quote revision per
// supplier quote, and (on request) a DRAFT purchase order. It reads the case as plain JSON: it imports nothing from src/sourcing (which needs Node 24).
//
// Safety rules:
//  - nothing is invented: a value that cannot be read exactly (a price like "about 3 USD", an unknown currency) is reported as an issue and skipped;
//  - re-importing the same case never creates duplicates (deterministic idempotency keys + match on supplier name / SKU / barcode / unchanged terms);
//  - an ambiguous supplier match is refused, never guessed;
//  - a draft order is a DRAFT: no approval, no order, no payment happens here.
import { fingerprint, microOf } from './util.js';
import { INCOTERMS } from './service.js';

const DEC = /^\d{1,9}(\.\d{1,6})?$/;
const num = (v) => (v === undefined || v === null ? '' : String(v).trim().replace(',', '.'));
const intOf = (v) => { const n = Number(String(v ?? '').trim()); return Number.isInteger(n) && n > 0 ? n : null; };

/** Same normalisation as Sourcing's supplierKey, so the two modules agree on "the same supplier". */
export const supplierKeyOf = (name) => String(name ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(co|ltd|limited|company|inc|corp|trading|factory|llc)\b\.?/g, ' ').replace(/[^a-z0-9一-鿿]+/g, ' ').trim();

/** Pure: what a case says, in the module's vocabulary, plus everything that could not be read exactly. */
export function caseToCapture(caseState) {
  const issues = [];
  if (!caseState || typeof caseState !== 'object' || typeof caseState.id !== 'string') return { issues: [{ code: 'NOT_A_CASE', message: 'not a Sourcing case' }] };
  const supplierName = String(caseState.supplier?.name ?? '').trim();
  if (!supplierName) issues.push({ code: 'NO_SUPPLIER', message: 'the case has no supplier name' });
  const name = String(caseState.identity?.workingName ?? caseState.name ?? '').trim();
  if (!name) issues.push({ code: 'NO_PRODUCT_NAME', message: 'the case has no product name' });
  const gtin = String(caseState.identity?.identifiers?.gtin ?? '').trim();
  const attachments = [
    ...(caseState.identity?.photos ?? []).filter((p) => p?.ref).map((p) => ({ kind: 'PHOTO', ref: String(p.ref).slice(0, 300), note: p.note ? String(p.note).slice(0, 300) : null })),
    ...(caseState.documents ?? []).filter((d) => d?.ref || d?.photoRef).map((d) => ({ kind: d.photoRef && !d.ref ? 'PHOTO' : 'DOCUMENT', ref: String(d.ref ?? d.photoRef).slice(0, 300), note: d.fileName ? String(d.fileName).slice(0, 300) : null })),
  ].filter((a, i, all) => all.findIndex((b) => b.ref === a.ref) === i).slice(0, 20);
  const quotes = [];
  for (const [i, q] of (caseState.quotes ?? []).entries()) {
    const where = `quote ${i + 1}`;
    const currency = String(q.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) { issues.push({ code: 'CURRENCY_MISSING', quote: i + 1, message: `${where}: no valid currency (never assumed)` }); continue; }
    const raw = Array.isArray(q.tiers) && q.tiers.length ? q.tiers.map((t) => ({ minQty: intOf(t.minQty), price: num(t.unitPrice) })) : [{ minQty: intOf(q.moq) ?? intOf(q.qty) ?? 1, price: num(q.unitPrice) }];
    const bad = raw.find((t) => !t.minQty || !DEC.test(t.price) || Number(t.price) <= 0);
    if (bad) { issues.push({ code: 'PRICE_NOT_PARSEABLE', quote: i + 1, message: `${where}: price "${bad.price}" / quantity ${bad.minQty} is not an exact number (not guessed)` }); continue; }
    const tiers = raw.sort((a, b) => a.minQty - b.minQty).map((t) => ({ minQty: t.minQty, unitPrice: t.price }));
    if (tiers.some((t, k) => k && t.minQty === tiers[k - 1].minQty)) { issues.push({ code: 'TIER_DUPLICATE', quote: i + 1, message: `${where}: two tiers share one quantity` }); continue; }
    const incoterm = q.incoterm ? String(q.incoterm).trim().toUpperCase() : null;
    if (incoterm && !INCOTERMS.includes(incoterm)) issues.push({ code: 'INCOTERM_UNKNOWN', quote: i + 1, message: `${where}: Incoterm "${q.incoterm}" not recognised: left empty` });
    const dep = q.payment?.depositPct;
    quotes.push({
      at: String(q.at ?? `#${i + 1}`), currency, tiers, moq: intOf(q.moq), incoterm: incoterm && INCOTERMS.includes(incoterm) ? incoterm : null, leadTimeDays: intOf(q.leadTimeDays),
      depositPct: dep !== undefined && /^\d{1,3}(\.\d{1,2})?$/.test(num(dep)) && Number(num(dep)) <= 100 ? num(dep) : null,
    });
  }
  return { caseId: caseState.id, supplierName, name, sku: `SRC-${caseState.id}`.slice(0, 64), barcode: /^\d{8,14}$/.test(gtin) ? gtin : null, attachments, quotes, issues };
}

const sameTerms = (existing, q) => existing.currency === q.currency && existing.moq === q.moq && existing.incoterm === q.incoterm && existing.leadTimeDays === q.leadTimeDays
  && existing.tiers.length === q.tiers.length && existing.tiers.every((t, i) => t.minQty === q.tiers[i].minQty && t.unitPriceMicro === microOf(q.tiers[i].unitPrice));

/**
 * @param {{commands: object, queries: object, actor: {id: string, role: string}, caseState: object}} a
 * @returns {Promise<{status: 'IMPORTED'|'PARTIAL'|'BLOCKED', supplier?: object, item?: object, quotes: object[], issues: object[]}>}
 */
export async function importSourcingCase({ commands, queries, actor, caseState }) {
  const cap = caseToCapture(caseState);
  const issues = [...cap.issues];
  if (issues.some((i) => ['NOT_A_CASE', 'NO_SUPPLIER', 'NO_PRODUCT_NAME'].includes(i.code))) return { status: 'BLOCKED', quotes: [], issues };
  const caseId = cap.caseId;

  // ---- supplier: match, never guess
  const key = supplierKeyOf(cap.supplierName);
  const matches = (await queries.suppliers()).filter((s) => supplierKeyOf(s.name) === key);
  if (matches.length > 1) return { status: 'BLOCKED', quotes: [], issues: [...issues, { code: 'SUPPLIER_AMBIGUOUS', message: `${matches.length} suppliers match "${cap.supplierName}": merge them first`, candidates: matches.map((s) => ({ id: s.id, name: s.name })) }] };
  let supplier; let supplierCreated = false;
  if (matches.length === 1) supplier = matches[0];
  else {
    const first = cap.quotes[0];
    if (!first) return { status: 'BLOCKED', quotes: [], issues: [...issues, { code: 'NO_USABLE_QUOTE', message: 'a new supplier needs at least one readable quote (its currency)' }] };
    supplier = (await commands.createSupplier(actor, `src:${caseId}:supplier`, { name: cap.supplierName, currency: first.currency, ...(first.incoterm ? { incotermDefault: first.incoterm } : {}), ...(first.depositPct ? { payment: { depositPct: first.depositPct, balancePct: String(100 - Number(first.depositPct)) } } : {}) })).supplier;
    supplierCreated = true;
  }

  // ---- item: SKU derived from the case id, or the barcode when the case has one
  const items = await queries.items();
  let item = items.find((i) => i.sku === cap.sku) ?? (cap.barcode ? items.find((i) => i.barcode === cap.barcode) : null) ?? null;
  let itemCreated = false;
  if (!item) { item = (await commands.createItem(actor, `src:${caseId}:item`, { sku: cap.sku, name: cap.name, status: 'PROSPECT', ...(cap.barcode ? { barcode: cap.barcode } : {}) })).item; itemCreated = true; }
  const known = new Set((item.attachments ?? []).map((a) => a.ref));
  const fresh = cap.attachments.filter((a) => !known.has(a.ref));
  if (fresh.length) item = (await commands.updateItem(actor, `src:${caseId}:att:${fingerprint(fresh).slice(0, 16)}`, { itemId: item.id, patch: { attachments: [...(item.attachments ?? []), ...fresh].slice(0, 20) } })).item;

  // ---- quotes, in order; unchanged terms are not a new revision
  const out = [];
  const history = (await queries.quotes()).filter((q) => q.supplierId === supplier.id && q.itemId === item.id).sort((a, b) => a.revision - b.revision);
  let latest = history.at(-1) ?? null;
  for (const q of cap.quotes) {
    if (latest && sameTerms(latest, q)) { out.push({ quoteId: latest.id, revision: latest.revision, at: q.at, status: 'UNCHANGED' }); continue; }
    try {
      const r = await commands.recordQuote(actor, `src:${caseId}:quote:${fingerprint(q).slice(0, 20)}`, {
        supplierId: supplier.id, itemId: item.id, currency: q.currency, tiers: q.tiers, ...(q.moq ? { moq: q.moq } : {}), ...(q.incoterm ? { incoterm: q.incoterm } : {}), ...(q.leadTimeDays ? { leadTimeDays: q.leadTimeDays } : {}),
        provenance: 'SUPPLIER_CLAIM', reason: `imported from China Sourcing case ${caseId} (${q.at})`,
      });
      latest = r.quote; out.push({ quoteId: r.quote.id, revision: r.quote.revision, at: q.at, status: r.replayed ? 'UNCHANGED' : 'CREATED' });
    } catch (e) {
      if (!e.code) throw e;
      out.push({ at: q.at, status: 'SKIPPED', reason: e.code }); issues.push({ code: e.code, message: `quote ${q.at}: ${e.message}` });
    }
  }
  const usable = out.some((o) => o.status !== 'SKIPPED');
  return { status: issues.length || !usable ? 'PARTIAL' : 'IMPORTED', caseId, supplier: { id: supplier.id, name: supplier.name, created: supplierCreated }, item: { id: item.id, sku: item.sku, name: item.name, created: itemCreated, attachments: (item.attachments ?? []).length }, quotes: out, issues };
}

/**
 * Import (idempotent) then prepare a DRAFT purchase order for `qty` units on the case's latest usable quote. Returns the existing draft when the same quote and
 * quantity already have an open order: pressing the button twice never creates two orders. The order stays DRAFT: nothing is submitted, approved or ordered.
 */
export async function draftOrderFromCase({ commands, queries, actor, caseState, qty, destinationLocationId, expectedDate, fx }) {
  const imp = await importSourcingCase({ commands, queries, actor, caseState });
  if (imp.status === 'BLOCKED') return { ...imp, purchaseOrder: null };
  const quote = [...imp.quotes].reverse().find((q) => q.status !== 'SKIPPED');
  if (!quote) return { ...imp, status: 'BLOCKED', purchaseOrder: null, issues: [...imp.issues, { code: 'NO_USABLE_QUOTE', message: 'no quote could be read: nothing to order' }] };
  const q = await queries.quote(quote.quoteId);
  const open = (await queries.purchaseOrders()).find((po) => !['CANCELLED', 'CLOSED'].includes(po.status) && po.lines.some((l) => l.quoteId === q.id && l.qty === qty));
  if (open) return { ...imp, purchaseOrder: { id: open.id, number: open.number, status: open.status, totalMinor: open.totalMinor, currency: open.currency, reused: true } };
  try {
    const r = await commands.createPurchaseOrder(actor, `src:${caseState.id}:po:${q.id}:${qty}`, {
      supplierId: imp.supplier.id, currency: q.currency, expectedDate, destinationLocationId, lines: [{ itemId: imp.item.id, quoteId: q.id, qty }], ...(fx && q.currency !== 'EUR' ? { fx } : {}),
    });
    const po = r.purchaseOrder;
    return { ...imp, purchaseOrder: { id: po.id, number: po.number, status: po.status, totalMinor: po.totalMinor, currency: po.currency, reused: false } };
  } catch (e) {
    if (!e.code) throw e;
    return { ...imp, status: 'PARTIAL', purchaseOrder: null, issues: [...imp.issues, { code: e.code, message: e.message }] };
  }
}
