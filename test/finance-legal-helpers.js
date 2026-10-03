// Shared synthetic world for the Belgium / Peppol tests: a finance service whose issuance archives the legal artifacts, the legal-artifact service, the Peppol service behind a fake provider.
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createFinanceService } from '../src/finance/service.js';
import { createInboxService, createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { createLegalArtifacts } from '../src/finance/legal-artifacts.js';
import { createPeppolService } from '../src/finance/peppol-service.js';
import { createFakePeppolProvider } from '../src/finance/peppol-provider.js';
import { renderDocumentPdf } from '../src/finance/pdf.js';
import { civilDateIn } from '../src/finance/civil-date.js';
import { CONFIG, CUSTOMER, MERCHANT_ACTOR, AGENT_ACTOR, SELLER, LINES, VAT_OK } from './finance-fixtures.js';

export const TZ = 'Europe/Brussels';
export const OTHER_SELLER = { name: 'Fournisseur Exemple SRL', vatNumber: 'BE0000000196', enterpriseNumber: '0000.000.196', iban: 'BE68 5390 0754 7034', bic: 'EXAMPLEB', address: { street: 'Rue du Test 9', postalCode: '5000', city: 'Namur', countryCode: 'BE' }, email: 'billing@supplier.example' };
export const BUYER_OF_SELLER = { kind: 'business', name: SELLER.name, vatNumber: SELLER.vatNumber, enterpriseNumber: SELLER.enterpriseNumber, address: SELLER.address };

export function legalWorld({ merchantId = 'merchant-test-1', seller = SELLER, store = createMemoryStore(), storage = createMemoryAttachmentStore(), provider = createFakePeppolProvider(), config = {}, ownEndpoints = null, renderPdf = renderDocumentPdf, validate = undefined, startIso = null } = {}) {
  let t = 0; const clock = startIso ? { now: () => new Date(Date.parse(startIso) + (t++) * 1000).toISOString(), today: () => civilDateIn(startIso, TZ), timeZone: TZ } : { now: () => new Date(Date.UTC(2026, 9, 3, 10, 0, t++)).toISOString(), today: () => '2026-09-30', timeZone: TZ };
  const legal = createLegalArtifacts({ store, merchantId, storage, clock, renderPdf, defaultBuyerReference: 'document_number', ...(validate ? { validate } : {}) });
  const hooks = { onIssued: async (doc) => { const original = doc.type === 'credit_note' && doc.relatedDocumentId ? (await store.getDocument(doc.relatedDocumentId))?.number ?? null : null; await legal.archiveIssued(doc, { atIssue: true, originalNumber: original, actor: MERCHANT_ACTOR }); } };
  const svc = createFinanceService({ store, config: { ...CONFIG, merchantId, seller, vat: { allowedRatesBp: [2100, 1200, 600, 0] }, ...config }, clock, hooks });
  const inbox = createInboxService({ store, attachments: storage, merchantId, now: clock.now });
  const own = ownEndpoints ?? [`0208:${seller.enterpriseNumber.replace(/\D/g, '')}`];
  const peppol = createPeppolService({ store, merchantId, provider, legal, storage, inbox, clock, ownEndpoints: own });
  const issue = (over = {}) => issueInvoiceAt(svc, over);
  const creditNote = async (inv, lines) => { const cn = await svc.createCreditNote(inv.id, { reason: 'return', ...(lines ? { lines } : {}) }, MERCHANT_ACTOR); await svc.submit(cn.id, MERCHANT_ACTOR); return svc.decide(cn.id, 'APPROVE', MERCHANT_ACTOR); };
  return { merchantId, store, storage, provider, clock, legal, svc, inbox, peppol, issue, creditNote, seller };
}
export async function issueInvoiceAt(svc, over = {}) {
  const d = await svc.create({ type: 'invoice', customer: CUSTOMER, lines: LINES, vat: VAT_OK, revenueBasis: 'standalone_b2b', issueDate: '2026-09-10', ...over }, AGENT_ACTOR);
  await svc.submit(d.id, AGENT_ACTOR); return svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR);
}
/** The structured original a supplier world issued to `buyer`, as exact bytes (what a provider would deliver). */
export async function supplierInvoiceXml({ attachments = [], lines = LINES, number = null, issueDate = '2026-09-10', count = 1 } = {}) {
  const w = legalWorld({ merchantId: 'supplier-merchant', seller: OTHER_SELLER });
  let inv; for (let i = 0; i < count; i++) inv = await w.issue({ customer: BUYER_OF_SELLER, lines, issueDate });
  const o = await w.legal.structuredOriginal(inv.id); void number; void attachments;
  return { xml: o.data, doc: inv, world: w };
}
export { MERCHANT_ACTOR, CUSTOMER, SELLER, LINES, VAT_OK };
