// Document intelligence, phase 2: supplier matching against Contacts (fin_companies) and duplicate detection.
// SYNTHETIC data only: invented suppliers, synthetic VAT / enterprise numbers / IBAN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createInboxService, createMemoryAttachmentStore, createSupabaseAttachmentStore } from '../src/finance/inbox.js';
import { MATCH_CONFIDENCE, createPrefillOf, findDuplicates, isReferenced, matchSupplier, refsOf, sameSupplier } from '../src/finance/purchase-matching.js';
import { readUblDocument } from '../src/finance/purchase-document.js';
import { startApp } from './finance-dashboard-helpers.js';

const M = 'm1'; const merchant = { type: 'merchant' };
const company = (id, o = {}) => ({ id, merchantId: M, kind: 'business', name: o.name ?? `Fournisseur ${id} SRL`, vatNumber: o.vat ?? null, enterpriseNumber: o.ent ?? null, address: o.address ?? {}, archivedAt: o.archivedAt ?? null, declaredRoles: { customer: false, supplier: true } });
const docOf = (o = {}) => ({ id: o.id ?? 'd1', supplierName: o.name ?? null, supplierVatNumber: o.vat ?? null, supplierEnterpriseNumber: o.ent ?? null, supplierIban: o.iban ?? null, supplierCompanyId: o.linked ?? null,
  extraction: o.address ? { provenance: { supplierAddress: { value: o.address } } } : {} });

// ---------- supplier matching (pure) ----------
test('matching: exact VAT wins, whatever the formatting; a VAT match is "recognised" and is never linked here', () => {
  const cs = [company('a', { vat: 'BE0000000097' }), company('b', { name: 'Fournisseur Exemple SRL' })];
  const m = matchSupplier(docOf({ vat: 'be 0000.000.097', name: 'Fournisseur Exemple SRL' }), cs);
  assert.equal(m.status, 'recognized'); assert.equal(m.proposal.contactId, 'a'); assert.equal(m.proposal.method, 'VAT'); assert.equal(m.proposal.confidence, MATCH_CONFIDENCE.VAT);
  assert.equal(m.candidates.length, 1, 'a later tier (name) is never mixed with the VAT tier');
  assert.deepEqual([m.level, m.proposal.level], ['HIGH', 'HIGH'], 'a structured level, not a probability');
});
test('matching: exact enterprise number, including the one inside a Belgian VAT number', () => {
  const cs = [company('a', { ent: '0000.000.097' }), company('b', { vat: 'BE0000000196' })];
  let m = matchSupplier(docOf({ ent: '0000000097' }), cs); assert.deepEqual([m.status, m.proposal.contactId, m.proposal.method], ['recognized', 'a', 'ENTERPRISE_NUMBER']);
  m = matchSupplier(docOf({ vat: 'BE0000000097' }), cs); assert.deepEqual([m.status, m.proposal.contactId, m.proposal.method], ['recognized', 'a', 'ENTERPRISE_NUMBER'], 'BE VAT -> enterprise number of a contact without VAT');
  m = matchSupplier(docOf({ ent: '0000.000.196' }), cs); assert.deepEqual([m.proposal.contactId, m.proposal.method], ['b', 'ENTERPRISE_NUMBER'], 'enterprise number -> contact known by its BE VAT');
});
test('matching: exact normalised name is only "to confirm"; the address is a secondary signal; a conflicting identifier discards the name match', () => {
  const cs = [company('a', { name: 'Imprimerie Exemple S.R.L.', address: { street: 'Rue de la Gare 1', postalCode: '5000' } })];
  let m = matchSupplier(docOf({ name: 'imprimerie exemple srl' }), cs); assert.deepEqual([m.status, m.proposal.method, m.proposal.confidence], ['to_confirm', 'NAME', MATCH_CONFIDENCE.NAME]);
  m = matchSupplier(docOf({ name: 'Imprimerie Exemple SRL', address: { street: 'Rue de la gare, 1', postalCode: '5000' } }), cs); assert.deepEqual([m.proposal.confidence, m.proposal.signals], [MATCH_CONFIDENCE.NAME_AND_ADDRESS, ['ADDRESS_MATCHES']]);
  assert.equal(matchSupplier(docOf({ name: 'imprimerie exemple srl' }), cs).level, 'LOW');
  assert.equal(matchSupplier(docOf({ name: 'Imprimerie Exemple SRL', address: { street: 'Rue de la gare, 1', postalCode: '5000' } }), cs).level, 'MEDIUM');
  m = matchSupplier(docOf({ name: 'Imprimerie Exemple SRL', address: { postalCode: '1000' } }), cs); assert.deepEqual([m.status, m.proposal.confidence, m.proposal.signals], ['to_confirm', MATCH_CONFIDENCE.NAME_ADDRESS_DIFFERS, ['ADDRESS_DIFFERS']]);
  assert.equal(matchSupplier(docOf({ name: 'Imprimerie Exemple', address: { postalCode: '5000' } }), cs).status, 'unknown', 'never fuzzy: a shorter name is not the same name; an address alone never matches');
  const withVat = [company('a', { name: 'Imprimerie Exemple SRL', vat: 'BE0000000196' })];
  assert.equal(matchSupplier(docOf({ name: 'Imprimerie Exemple SRL', vat: 'BE0000000097' }), withVat).status, 'unknown', 'same name but a different VAT: another company');
});
test('matching: several candidates -> to confirm, no proposal (nothing can be linked automatically); archived contacts are never proposed', () => {
  const cs = [company('a', { vat: 'BE0000000097', name: 'X SRL' }), company('b', { vat: 'BE0000000097', name: 'X SA' })];
  const m = matchSupplier(docOf({ vat: 'BE0000000097' }), cs); assert.deepEqual([m.status, m.proposal, m.candidates.map((c) => c.contactId)], ['to_confirm', null, ['a', 'b']]);
  assert.equal(m.level, 'AMBIGUOUS');
  const n = matchSupplier(docOf({ name: 'Même Nom SRL' }), [company('a', { name: 'Même Nom SRL' }), company('b', { name: 'MEME NOM SRL' }), company('c', { name: 'Même nom srl' })]);
  assert.equal(n.status, 'to_confirm'); assert.equal(n.proposal, null); assert.equal(n.candidates.length, 2, "accents are kept: 'MEME' is not 'MÊME'");
  assert.equal(matchSupplier(docOf({ vat: 'BE0000000097' }), [company('a', { vat: 'BE0000000097', archivedAt: '2026-09-01T00:00:00Z' })]).status, 'unknown');
  assert.equal(matchSupplier(docOf({ vat: 'BE0000000097', linked: 'z' }), [company('z')]).status, 'linked');
});
test('unknown supplier: a creation is proposed, prefilled only with what the document carries (Supplier, company)', () => {
  const m = matchSupplier(docOf({ name: 'Nouveau Fournisseur SRL', vat: 'BE0000000097', iban: 'BE68539007547034', address: { street: 'Rue Exemple 5', postalCode: '5000', city: 'Namur', countryCode: 'BE' } }), []);
  assert.equal(m.status, 'unknown');
  assert.deepEqual(m.createPrefill, { kind: 'business', role: 'supplier', name: 'Nouveau Fournisseur SRL', vatNumber: 'BE0000000097', enterpriseNumber: '0000.000.097', iban: 'BE68539007547034', street: 'Rue Exemple 5', postalCode: '5000', city: 'Namur', countryCode: 'BE' });
  assert.equal(matchSupplier(docOf({}), []).createPrefill, null, 'nothing to prefill: no proposal');
  assert.equal(createPrefillOf(docOf({ name: 'Y' })).countryCode, '');
});

// ---------- duplicates (pure) ----------
const inv = (id, o = {}) => ({ id, status: o.status ?? 'TO_REVIEW', documentType: o.type ?? 'INVOICE', supplierName: o.name ?? 'Fournisseur Exemple SRL', supplierVatNumber: o.vat ?? null, supplierCompanyId: o.linked ?? null,
  invoiceNumber: o.number === undefined ? `F-${id}` : o.number, issueDate: o.date ?? '2026-09-10', grossCents: o.gross ?? 12100, netCents: 10000, vatCents: 2100, currency: 'EUR', sha256: o.sha ?? null, extraction: o.extraction ?? {} });
test('duplicates: same file, or same supplier + number + type, is CERTAIN; an invoice and a credit note with one number are distinct', () => {
  assert.deepEqual(findDuplicates(inv('a', { sha: 'x' }), [inv('b', { sha: 'x' })]).items.map((i) => [i.level, i.reasons]), [['certain', ['SAME_FILE']]]);
  const d = findDuplicates(inv('a', { number: 'F 100', vat: 'BE0000000097', name: 'Nom Un' }), [inv('b', { number: 'f100', vat: 'BE0000000097', name: 'Nom Deux' })]);
  assert.deepEqual([d.level, d.items[0].reasons], ['certain', ['SAME_SUPPLIER', 'SAME_NUMBER', 'SAME_TYPE']], 'same supplier by VAT even when the name is written differently');
  assert.equal(findDuplicates(inv('a', { number: 'F-1' }), [inv('b', { number: 'F-1', type: 'CREDIT_NOTE' })]).level, 'none', 'invoice vs credit note: never a duplicate');
  assert.equal(findDuplicates(inv('a', { number: 'F-1' }), [inv('b', { number: 'F-1', status: 'REJECTED' })]).level, 'none', 'a rejected document is ignored');
  assert.equal(findDuplicates(inv('a', { number: 'F-1', vat: 'BE0000000097' }), [inv('b', { number: 'F-1', vat: 'BE0000000196' })]).level, 'none', 'same name, different VAT: another supplier');
});
test('duplicates: same supplier + same total + date within 7 days + number missing or different is only POSSIBLE, with the differences listed', () => {
  const d = findDuplicates(inv('a', { number: null, date: '2026-09-10' }), [inv('b', { number: 'F-9', date: '2026-09-12' })]);
  assert.equal(d.level, 'possible'); assert.deepEqual(d.items[0].reasons, ['SAME_SUPPLIER', 'SAME_TYPE', 'SAME_TOTAL', 'CLOSE_DATE', 'NUMBER_MISSING']);
  assert.deepEqual(d.items[0].differences.map((x) => [x.field, x.thisValue, x.otherValue]), [['invoiceNumber', null, 'F-9'], ['issueDate', '2026-09-10', '2026-09-12']]);
  assert.deepEqual(findDuplicates(inv('a', { number: 'F-1' }), [inv('b', { number: 'F-2' })]).items[0].reasons, ['SAME_SUPPLIER', 'SAME_TYPE', 'SAME_TOTAL', 'SAME_DATE', 'NUMBER_DIFFERENT']);
  assert.equal(findDuplicates(inv('a', { number: null, date: '2026-09-01' }), [inv('b', { date: '2026-09-12' })]).level, 'none', '11 days apart: not flagged');
  assert.equal(findDuplicates(inv('a', { number: null, gross: 12101 }), [inv('b')]).level, 'none', 'another total: not flagged');
  // a possible duplicate set aside by the person is no longer counted; a certain one cannot be set aside
  const dismissed = findDuplicates(inv('a', { number: null, extraction: { duplicateDecisions: { b: { decision: 'not_duplicate' } } } }), [inv('b')]);
  assert.deepEqual([dismissed.level, dismissed.items[0].dismissed], ['none', true]);
  assert.equal(findDuplicates(inv('a', { number: 'F-1', extraction: { duplicateDecisions: { b: { decision: 'not_duplicate' } } } }), [inv('b', { number: 'F-1' })]).level, 'certain');
  const other = findDuplicates(inv('b', { number: 'F-2' }), [inv('a', { number: null, extraction: { duplicateDecisions: { b: { decision: 'not_duplicate' } } } })]);
  assert.deepEqual([other.level, other.items[0].dismissed], ['none', true], 'the decision is about the pair: it applies from the other document too');
  assert.equal(sameSupplier(inv('a', { linked: 'c1', name: 'A' }), inv('b', { linked: 'c1', name: 'B' })), true, 'same linked contact');
});

// ---------- service: early refusal, audit trail, storage hygiene ----------
const PDF = (tag) => Buffer.from(`%PDF-1.4\n% synthetic ${tag}\n1 0 obj<<>>endobj\n%%EOF\n`);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const ubl = (id, root = 'Invoice') => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>${id}</cbc:ID><cbc:IssueDate>2026-09-10</cbc:IssueDate><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cac:AccountingSupplierParty><cac:Party><cac:PostalAddress><cbc:StreetName>Rue Exemple 5</cbc:StreetName><cbc:CityName>Namur</cbc:CityName><cbc:PostalZone>5000</cbc:PostalZone><cac:Country><cbc:IdentificationCode>BE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
<cac:PartyTaxScheme><cbc:CompanyID>BE0000000097</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>Fournisseur Exemple SRL</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>BE68539007547034</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">21.00</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">121.00</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal></${root}>`, 'utf8');
function svc(over = {}) {
  const store = over.store ?? createMemoryStore(); const attachments = over.attachments ?? createMemoryAttachmentStore(); const audits = [];
  const inbox = createInboxService({ store, attachments, merchantId: M, audit: async (e) => { audits.push(e); } });
  return { store, attachments, audits, inbox };
}
const stored = (att, s) => [...new Set(s)].filter((ref) => att.has(ref));

test('UBL: the supplier postal address is read (secondary signal, create prefill), with its provenance', () => {
  const f = readUblDocument(ubl('F-1')).fields.supplierAddress;
  assert.deepEqual(f.value, { street: 'Rue Exemple 5', postalCode: '5000', city: 'Namur', countryCode: 'BE' }); assert.equal(f.path, 'Invoice/AccountingSupplierParty/Party/PostalAddress');
});
test('intake: the same file is idempotent, the same supplier + number + type is refused BEFORE anything is stored (with the existing document)', async () => {
  const { inbox, attachments, store } = svc();
  const first = await inbox.ingest({ fileName: 'f.xml', data: ubl('F-1') });
  const again = await inbox.ingest({ fileName: 'copie.xml', data: ubl('F-1') }); assert.deepEqual([again.duplicate, again.item.id], [true, first.item.id]);
  const other = Buffer.concat([ubl('F-1'), Buffer.from('\n')]);
  await assert.rejects(inbox.ingest({ fileName: 'renvoi.xml', data: other }), (e) => e.code === 'DUPLICATE_SUPPLIER_INVOICE' && e.existing.id === first.item.id && e.existing.invoiceNumber === 'F-1');
  assert.equal((await store.listSupplierInvoices(M)).length, 1);
  const { createHash } = await import('node:crypto'); const sha = createHash('sha256').update(other).digest('hex');
  assert.equal(attachments.has(`${M}/${sha}/renvoi.xml`), false, 'the refused file was never stored');
  const cn = await inbox.ingest({ fileName: 'nc.xml', data: ubl('F-1', 'CreditNote') }); assert.equal(cn.duplicate, false, 'a credit note with the invoice number is a different document');
  assert.equal((await inbox.intelligence(cn.item.id)).duplicates.level, 'none');
});
test('intake records the proposal (audit); nothing is linked and no contact is created', async () => {
  const { inbox, store } = svc();
  await store.saveCompany(company('c1', { vat: 'BE0000000097' }));
  const { item } = await inbox.ingest({ fileName: 'f.xml', data: ubl('F-2') });
  assert.equal(item.supplierCompanyId ?? null, null);
  assert.deepEqual([item.extraction.matching.status, item.extraction.matching.proposal.contactId, item.extraction.matching.proposal.method], ['recognized', 'c1', 'VAT']);
  assert.equal(item.extraction.duplicateCheck.level, 'none');
  assert.equal((await store.listCompanies(M)).length, 1);
});
test('orphan files: a file stored for a request that creates no record is removed; a file any record points to is never removed', async () => {
  // the record insert fails after the file was stored (e.g. the database unique index during a concurrent import)
  const base = createMemoryStore(); let failNext = true;
  const store = { ...base, async saveSupplierInvoice(r) { if (failNext) { failNext = false; throw new Error('duplicate key value violates unique constraint "fin_supplier_invoice_type_uq"'); } return base.saveSupplierInvoice(r); } };
  const t = svc({ store });
  await assert.rejects(t.inbox.ingest({ fileName: 'a.pdf', data: PDF('a') }));
  const { createHash } = await import('node:crypto'); const ref = `${M}/${createHash('sha256').update(PDF('a')).digest('hex')}/a.pdf`;
  assert.equal(t.attachments.has(ref), false, 'orphan removed'); assert.ok(t.audits.some((e) => e.action === 'INBOX_UNREFERENCED_FILE_REMOVED' && e.ref === ref));
  // same failure, but another record already points to that exact file (concurrent identical upload): the file is kept
  const kept = await t.inbox.ingest({ fileName: 'a.pdf', data: PDF('a') });
  failNext = true;
  const racing = createInboxService({ store: { ...store, findSupplierInvoiceBySha: async () => null }, attachments: t.attachments, merchantId: M });
  await assert.rejects(racing.ingest({ fileName: 'a.pdf', data: PDF('a') }));
  assert.equal(t.attachments.has(kept.item.attachmentRef), true, 'a file linked to a record is never deleted');
  // capture: original + generated PDF are both removed when no record is created
  failNext = true;
  await assert.rejects(t.inbox.captureExpense({ fileName: 'ticket.png', data: PNG, origin: 'camera', fields: { supplierName: 'Taxi', gross: 1800, currency: 'EUR' } }, merchant));
  const shaPng = createHash('sha256').update(PNG).digest('hex');
  assert.deepEqual(stored(t.attachments, [`${M}/${shaPng}/ticket.png`, `${M}/${shaPng}/ticket.pdf`]), []);
  // every file of every record is still there
  for (const r of await base.listSupplierInvoices(M)) for (const x of refsOf(r)) assert.equal(t.attachments.has(x), true, x);
  assert.equal(isReferenced(kept.item.attachmentRef, await base.listSupplierInvoices(M)), true);
});
test('orphan files: attaching a receipt that cannot be recorded removes only what that request stored', async () => {
  const base = createMemoryStore(); const store = { ...base, setSupplierInvoiceAttachment: async () => null };
  const t = svc({ store });
  const man = await t.inbox.createManual({ supplierName: 'Fournisseur Manuel SA', invoiceNumber: 'M-1', issueDate: '2026-09-01', netCents: 1000, vatCents: 210, grossCents: 1210, currency: 'EUR' }, merchant);
  await assert.rejects(t.inbox.attachDocument(man.id, { fileName: 'recu.pdf', data: PDF('recu') }, merchant), /ATTACHMENT_ALREADY_PRESENT/);
  const { createHash } = await import('node:crypto');
  assert.equal(t.attachments.has(`${M}/${createHash('sha256').update(PDF('recu')).digest('hex')}/recu.pdf`), false);
});
test('Supabase storage: removal is a DELETE with the service role on the private bucket; an already missing file is fine', async () => {
  const calls = []; let status = 200;
  const s = createSupabaseAttachmentStore({ url: 'https://project.example.test', serviceKey: 'service-key-synthetic', fetchImpl: async (u, i) => { calls.push({ u, i }); return { ok: status < 300, status }; } });
  await s.remove('m1/abc/x y.pdf');
  assert.deepEqual([calls[0].u, calls[0].i.method], ['https://project.example.test/storage/v1/object/finance-inbox/m1/abc/x%20y.pdf', 'DELETE']); assert.match(calls[0].i.headers.Authorization, /^Bearer /);
  status = 404; await s.remove('m1/abc/gone.pdf');
  status = 500; await assert.rejects(s.remove('m1/abc/x.pdf'), /ATTACHMENT_REMOVE_FAILED/);
});

// ---------- HTTP, end to end ----------
async function harness() { const a = await startApp(); return { a, c: await a.authed(), close: () => a.close() }; }
const withH = (fn) => async () => { const h = await harness(); try { await fn(h); } finally { await h.close(); } };
const upload = (h, name, buf) => h.c.post('/api/inbox/upload', { fileName: name, dataBase64: buf.toString('base64') });
const newContact = async (h, body) => (await h.c.post('/api/companies', { kind: 'business', roles: { customer: false, supplier: true }, address: { countryCode: 'BE' }, ...body })).data;

test('HTTP: recognised supplier -> the person confirms; the decision, method and confidence are kept', withH(async (h) => {
  const c = await newContact(h, { name: 'Fournisseur Exemple SRL', vatNumber: 'BE0000000097' });
  const it = (await upload(h, 'f.xml', ubl('F-10'))).data.item;
  let g = (await h.c.get(`/api/inbox/${it.id}`)).data;
  assert.deepEqual([g.supplierMatch.status, g.supplierMatch.proposal.contactId, g.supplierMatch.proposal.method, g.supplierCompanyId], ['recognized', c.id, 'VAT', null], 'recognised, not linked');
  assert.equal((await h.c.post(`/api/inbox/${it.id}/contact`, { contactId: c.id })).status, 200);
  g = (await h.c.get(`/api/inbox/${it.id}`)).data;
  assert.equal(g.supplierCompanyId, c.id); assert.equal(g.supplierMatch.status, 'linked');
  const d = g.supplierMatch.decisions.at(-1);
  assert.deepEqual([d.action, d.contactId, d.proposedContactId, d.method, d.level, d.matchStatus], ['CONFIRMED_PROPOSAL', c.id, c.id, 'VAT', 'HIGH', 'recognized']);
}));
test('HTTP: another contact can be chosen instead of the proposal; the choice is recorded as such', withH(async (h) => {
  const proposed = await newContact(h, { name: 'Fournisseur Exemple SRL', vatNumber: 'BE0000000097' });
  const other = await newContact(h, { name: 'Autre Fournisseur SA' });
  const it = (await upload(h, 'f.xml', ubl('F-11'))).data.item;
  await h.c.post(`/api/inbox/${it.id}/contact`, { contactId: other.id });
  const d = (await h.c.get(`/api/inbox/${it.id}`)).data.supplierMatch.decisions.at(-1);
  assert.deepEqual([d.action, d.contactId, d.proposedContactId], ['CHOSE_OTHER_CONTACT', other.id, proposed.id]);
}));
test('HTTP: several matching contacts -> nothing proposed, nothing linked', withH(async (h) => {
  // two contacts with the document's supplier name (and no identifier to tell them apart); a second contact with the same VAT is refused by Contacts itself
  assert.ok((await newContact(h, { name: 'Fournisseur Exemple SRL' })).id);
  assert.ok((await newContact(h, { name: 'Fournisseur Exemple SRL', confirmDuplicate: true })).id);
  const it = (await upload(h, 'f.xml', ubl('F-12'))).data.item;
  const g = (await h.c.get(`/api/inbox/${it.id}`)).data;
  assert.deepEqual([g.supplierMatch.status, g.supplierMatch.proposal, g.supplierMatch.candidates.length, g.supplierCompanyId], ['to_confirm', null, 2, null]);
}));
test('HTTP: unknown supplier -> creation proposed; declining creates nothing; creating links it and is recorded', withH(async (h) => {
  const it = (await upload(h, 'f.xml', ubl('F-13'))).data.item;
  let g = (await h.c.get(`/api/inbox/${it.id}`)).data;
  assert.equal(g.supplierMatch.status, 'unknown'); assert.equal(g.supplierMatch.createPrefill.name, 'Fournisseur Exemple SRL'); assert.equal(g.supplierMatch.createPrefill.iban, 'BE68539007547034'); assert.equal(g.supplierMatch.createPrefill.city, 'Namur');
  assert.equal((await h.c.post(`/api/inbox/${it.id}/supplier-decision`, { action: 'decline_create' })).status, 200);
  assert.equal((await h.c.get('/api/contacts')).data.rows.length, 0, 'declined: no contact created');
  g = (await h.c.get(`/api/inbox/${it.id}`)).data; assert.equal(g.supplierMatch.decisions.at(-1).action, 'DECLINED_CREATE'); assert.equal(g.supplierCompanyId, null);
  assert.equal((await h.c.post(`/api/inbox/${it.id}/supplier-decision`, { action: 'create' })).status, 422, 'the server never creates a contact from this route');
  // the person creates it (the contact form, prefilled), then it is linked with the decision recorded
  const p = g.supplierMatch.createPrefill;
  const c = await newContact(h, { name: p.name, vatNumber: p.vatNumber, enterpriseNumber: p.enterpriseNumber, iban: p.iban, address: { street: p.street, postalCode: p.postalCode, city: p.city, countryCode: p.countryCode } });
  assert.equal((await h.c.post(`/api/inbox/${it.id}/contact`, { contactId: c.id, created: true })).status, 200);
  g = (await h.c.get(`/api/inbox/${it.id}`)).data; assert.equal(g.supplierMatch.decisions.at(-1).action, 'CREATED_AND_LINKED'); assert.equal((await h.c.get('/api/contacts')).data.rows.length, 1);
}));
test('HTTP: a certain duplicate is refused at import with the existing document; a possible one is shown with its differences and decided by the person', withH(async (h) => {
  const first = (await upload(h, 'f.xml', ubl('F-20'))).data.item;
  const dup = await upload(h, 'f-renvoi.xml', Buffer.concat([ubl('F-20'), Buffer.from(' ')]));
  assert.equal(dup.status, 409); assert.equal(dup.data.error.code, 'DUPLICATE_SUPPLIER_INVOICE'); assert.equal(dup.data.error.existing.id, first.id); assert.equal(dup.data.error.existing.invoiceNumber, 'F-20');
  // possible: same supplier, same total, 3 days later, other number
  const man = (n, date) => h.c.post('/api/inbox/manual', { supplierName: 'Fournisseur Exemple SRL', supplierVatNumber: 'BE0000000097', invoiceNumber: n, issueDate: date, net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR' });
  const p1 = (await man('F-21', '2026-09-13')).data;
  let g = (await h.c.get(`/api/inbox/${p1.id}`)).data;
  assert.equal(g.duplicates.level, 'possible'); const item = g.duplicates.items.find((i) => i.id === first.id);
  assert.deepEqual(item.reasons, ['SAME_SUPPLIER', 'SAME_TYPE', 'SAME_TOTAL', 'CLOSE_DATE', 'NUMBER_DIFFERENT']); assert.equal(item.document.invoiceNumber, 'F-20');
  assert.ok(item.differences.some((x) => x.field === 'invoiceNumber') && item.differences.some((x) => x.field === 'issueDate'));
  assert.equal((await h.c.post(`/api/inbox/${p1.id}/duplicate-decision`, { otherId: first.id, decision: 'not_duplicate' })).status, 200);
  g = (await h.c.get(`/api/inbox/${p1.id}`)).data; assert.equal(g.duplicates.level, 'none'); assert.equal(g.duplicates.items[0].decision, 'not_duplicate');
  assert.equal(g.extraction.duplicateDecisions[first.id].level, 'possible', 'the decision keeps what was detected');
  // the other outcome: the person says it is a duplicate -> this document is rejected, the other is untouched
  const p2 = (await man('F-22', '2026-09-11')).data;
  const r = await h.c.post(`/api/inbox/${p2.id}/duplicate-decision`, { otherId: first.id, decision: 'duplicate' });
  assert.equal(r.data.status, 'REJECTED'); assert.match(r.data.rejectedReason, /Duplicate of F-20/);
  assert.equal((await h.c.get(`/api/inbox/${first.id}`)).data.status, 'TO_REVIEW');
  assert.equal((await h.c.post(`/api/inbox/${p1.id}/duplicate-decision`, { otherId: p1.id, decision: 'not_duplicate' })).status, 404);
  assert.equal((await h.c.post(`/api/inbox/${p1.id}/duplicate-decision`, { otherId: first.id, decision: 'maybe' })).status, 422);
  // a manual entry repeating supplier + number + type is refused with the existing document too
  const m = await man('F-20', '2026-09-10'); assert.equal(m.status, 409); assert.equal(m.data.error.existing.id, first.id);
}));
