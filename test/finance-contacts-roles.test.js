import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activityCounts, contactDisplayName, contactRoles, possibleNameDuplicate, roleChangeProblems } from '../src/finance/contacts.js';
import { startApp } from './finance-dashboard-helpers.js';

// Finance > Contacts: add / edit a contact with a DECLARED role (customer / supplier / both), person or company, phone, IBAN.
// One contact store (fin_companies): the role shown is the union of the declared role and the role derived from real documents,
// and a role backed by documents can never be removed silently. SYNTHETIC data only.
const read = (f) => readFileSync(new URL(`../src/finance/ui/${f}`, import.meta.url), 'utf8');
const appSrc = read('app.js'); const contactsSrc = read('views-contacts.js');
const form = appSrc.slice(appSrc.indexOf('function companyModal('), appSrc.indexOf('// ---------- receivables ----------'));

async function withApp(fn) { const a = await startApp({}); try { await fn(await a.authed(), a); } finally { await a.close(); } }
const list = async (c, role = 'all') => (await c.get(`/api/contacts?role=${role}`)).data.rows;

// ---------- pure rules ----------
test('roles: effective role = declared UNION documents; the role-change guard protects roles backed by documents', () => {
  assert.deepEqual(contactRoles({ declaredRoles: { customer: false, supplier: true } }, { customerDocuments: 2 }), { declared: { customer: false, supplier: true }, fromDocuments: { customer: true, supplier: false }, isCustomer: true, isSupplier: true });
  assert.deepEqual(contactRoles({}, {}).isCustomer, false, 'no declared role, no document: no role (never guessed)');
  assert.deepEqual(roleChangeProblems({ customer: false, supplier: true }, { customerDocuments: 3 }), [{ role: 'customer', code: 'ROLE_CUSTOMER_HAS_DOCUMENTS', documents: 3 }]);
  assert.deepEqual(roleChangeProblems({ customer: true, supplier: false }, { supplierDocuments: 1 }), [{ role: 'supplier', code: 'ROLE_SUPPLIER_HAS_DOCUMENTS', documents: 1 }]);
  assert.deepEqual(roleChangeProblems({ customer: true, supplier: true }, { customerDocuments: 3, supplierDocuments: 1 }), [], 'keeping both roles is always allowed');
  assert.deepEqual(roleChangeProblems({ customer: false, supplier: true }, {}), [], 'a role without documents can change freely');
  const salesDocs = [{ doc: { customer: { companyId: 'c1' }, lockedAt: 'x', status: 'ISSUED' } }, { doc: { customer: { companyId: 'c1' }, lockedAt: null, status: 'DRAFT' } }, { doc: { customer: { companyId: 'c1' }, lockedAt: 'x', status: 'CANCELLED' } }];
  assert.deepEqual(activityCounts('c1', { salesDocs, supplierInvoices: [{ supplierCompanyId: 'c1' }, { supplierCompanyId: 'c2' }] }), { customerDocuments: 1, supplierDocuments: 1 }, 'drafts and cancelled documents do not count');
});

test('display name and obvious duplicates: a person is "First Last"; same normalised name (not archived) is a probable duplicate', () => {
  assert.equal(contactDisplayName({ kind: 'individual', firstName: 'Marie', name: 'Dupont' }), 'Marie Dupont');
  assert.equal(contactDisplayName({ kind: 'business', firstName: 'x', name: 'Atelier SRL' }), 'Atelier SRL');
  const companies = [{ id: 'a', kind: 'business', name: 'Atelier Test SRL' }, { id: 'b', kind: 'business', name: 'Autre', archivedAt: '2026-01-01' }];
  assert.equal(possibleNameDuplicate({ kind: 'business', name: 'atelier  test srl.' }, companies).id, 'a');
  assert.equal(possibleNameDuplicate({ kind: 'business', name: 'Autre' }, companies), null, 'an archived contact is not an active duplicate');
  assert.equal(possibleNameDuplicate({ kind: 'business', name: 'Atelier Test' }, companies), null, 'never fuzzy');
});

// ---------- API ----------
test('create a customer, a supplier and a customer + supplier: each is shown with its role and counted in the right filter', () => withApp(async (c) => {
  const mk = async (name, roles) => { const r = await c.post('/api/companies', { kind: 'business', name, address: { countryCode: 'BE' }, roles }); assert.equal(r.status, 201, name); return r.data; };
  const a = await mk('Client Seul SRL', { customer: true, supplier: false });
  const b = await mk('Fournisseur Seul SA', { customer: false, supplier: true });
  const d = await mk('Les Deux SC', { customer: true, supplier: true });
  const rows = await list(c); const by = (id) => rows.find((r) => r.id === id);
  assert.deepEqual([by(a.id).isCustomer, by(a.id).isSupplier], [true, false]);
  assert.deepEqual([by(b.id).isCustomer, by(b.id).isSupplier], [false, true]);
  assert.deepEqual([by(d.id).isCustomer, by(d.id).isSupplier], [true, true]);
  assert.deepEqual((await list(c, 'customer')).map((r) => r.id).sort(), [a.id, d.id].sort());
  assert.deepEqual((await list(c, 'supplier')).map((r) => r.id).sort(), [b.id, d.id].sort());
  assert.deepEqual((await list(c, 'both')).map((r) => r.id), [d.id]);
  assert.equal(by(a.id).roles.declared.customer, true); assert.equal(by(a.id).roles.fromDocuments.customer, false);
}));

test('a person with first name, phone and IBAN; details are stored and shown; the contact is searchable by phone', () => withApp(async (c) => {
  const r = await c.post('/api/companies', { kind: 'individual', firstName: 'Marie', name: 'Dupont', email: 'marie@client.example', phone: '+32 81 22 33 44', iban: 'be68 5390 0754 7034', address: { street: 'Rue X 1', postalCode: '5000', city: 'Namur', countryCode: 'BE' }, notes: 'Préfère le mail', roles: { customer: true } });
  assert.equal(r.status, 201);
  const d = (await c.get(`/api/contacts/${r.data.id}`)).data;
  assert.equal(d.displayName, 'Marie Dupont'); assert.equal(d.kind, 'individual'); assert.equal(d.firstName, 'Marie');
  assert.equal(d.phone, '+32 81 22 33 44'); assert.equal(d.iban, 'BE68539007547034', 'stored compact and upper-case'); assert.equal(d.notes, 'Préfère le mail');
  assert.deepEqual((await c.get('/api/contacts?q=22 33')).data.rows.map((x) => x.id), [r.data.id]);
}));

test('required fields and validation: no role, no name, bad email / phone / IBAN / VAT are refused and nothing is created', () => withApp(async (c) => {
  const bad = async (body, field, code) => { const r = await c.post('/api/companies', { kind: 'business', address: { countryCode: 'BE' }, ...body }); assert.equal(r.status, 422, JSON.stringify(body)); assert.ok(r.data.error.fields.some((f) => f.field === field && f.code === code), `${field} ${code}: ${JSON.stringify(r.data.error.fields)}`); };
  await bad({ name: 'X', roles: { customer: false, supplier: false } }, 'company.roles', 'ROLE_REQUIRED');
  await bad({ name: '', roles: { customer: true } }, 'company.name', 'REQUIRED');
  await bad({ name: 'X', email: 'pas-un-email', roles: { customer: true } }, 'company.email', 'EMAIL_INVALID');
  await bad({ name: 'X', phone: 'abc', roles: { customer: true } }, 'company.phone', 'PHONE_INVALID');
  await bad({ name: 'X', iban: 'BE00 0000 0000 0000', roles: { customer: true } }, 'company.iban', 'IBAN_INVALID');
  await bad({ name: 'X', vatNumber: 'BE0000000098', roles: { customer: true } }, 'company.vatNumber', 'BELGIAN_NUMBER_CHECKSUM_INVALID');
  assert.equal((await list(c)).length, 0);
  // a contact WITHOUT VAT is fine
  assert.equal((await c.post('/api/companies', { kind: 'business', name: 'Sans TVA', address: { countryCode: 'BE' }, roles: { supplier: true } })).status, 201);
}));

test('duplicates: same VAT is refused; same name without VAT needs an explicit confirmation', () => withApp(async (c) => {
  const base = { kind: 'business', address: { countryCode: 'BE' }, roles: { customer: true } };
  const first = await c.post('/api/companies', { ...base, name: 'Atelier Test SRL', vatNumber: 'BE0000000097' }); assert.equal(first.status, 201);
  const sameVat = await c.post('/api/companies', { ...base, name: 'Autre nom', vatNumber: 'BE0000000097' });
  assert.equal(sameVat.status, 409); assert.equal(sameVat.data.error.code, 'COMPANY_ALREADY_EXISTS');
  const n1 = await c.post('/api/companies', { ...base, name: 'Boulangerie du Coin' }); assert.equal(n1.status, 201);
  const n2 = await c.post('/api/companies', { ...base, name: 'boulangerie du coin' });
  assert.equal(n2.status, 409); assert.equal(n2.data.error.code, 'CONTACT_POSSIBLE_DUPLICATE'); assert.equal(n2.data.error.existingId, n1.data.id); assert.equal(n2.data.error.existingName, 'Boulangerie du Coin');
  assert.equal((await c.post('/api/companies', { ...base, name: 'boulangerie du coin', confirmDuplicate: true })).status, 201, 'a different contact with the same name, explicitly confirmed');
}));

test('edit: role, kind and details change; a supplier role backed by a supplier invoice cannot be removed', () => withApp(async (c) => {
  const co = (await c.post('/api/companies', { kind: 'business', name: 'Tyeso SRL', address: { countryCode: 'BE' }, roles: { supplier: true } })).data;
  // switch Supplier -> Customer + Supplier -> Customer while nothing is linked: allowed
  assert.equal((await c.put(`/api/companies/${co.id}`, { kind: 'business', name: 'Tyeso SRL', address: { countryCode: 'BE' }, roles: { customer: true, supplier: true } })).status, 200);
  assert.equal((await c.put(`/api/companies/${co.id}`, { kind: 'business', name: 'Tyeso SRL', address: { countryCode: 'BE' }, roles: { customer: true } })).status, 200);
  assert.deepEqual((await list(c)).find((r) => r.id === co.id).isSupplier, false);
  // a supplier invoice is linked: the supplier role now comes from a document and cannot be dropped
  await c.put(`/api/companies/${co.id}`, { kind: 'business', name: 'Tyeso SRL', address: { countryCode: 'BE' }, roles: { supplier: true } });
  const inv = (await c.post('/api/inbox/manual', { supplierName: 'Tyeso SRL', invoiceNumber: 'F-1' })).data;
  await c.post(`/api/inbox/${inv.id}/contact`, { contactId: co.id });
  const refused = await c.put(`/api/companies/${co.id}`, { kind: 'business', name: 'Tyeso SRL', address: { countryCode: 'BE' }, roles: { customer: true } });
  assert.equal(refused.status, 409); assert.equal(refused.data.error.code, 'ROLE_IN_USE');
  assert.deepEqual(refused.data.error.problems, [{ role: 'supplier', code: 'ROLE_SUPPLIER_HAS_DOCUMENTS', documents: 1 }]);
  const d = (await c.get(`/api/contacts/${co.id}`)).data;
  assert.equal(d.isSupplier, true, 'unchanged after the refusal'); assert.equal(d.supplierDocumentCount, 1);
  // keeping both roles is allowed
  assert.equal((await c.put(`/api/companies/${co.id}`, { kind: 'business', name: 'Tyeso SRL', address: { countryCode: 'BE' }, roles: { customer: true, supplier: true } })).status, 200);
}));

test('edit keeps a person a person (the old form always sent "business"), and archiving never deletes', () => withApp(async (c) => {
  const p = (await c.post('/api/companies', { kind: 'individual', firstName: 'Luc', name: 'Martin', address: { countryCode: 'BE' }, roles: { customer: true } })).data;
  await c.put(`/api/companies/${p.id}`, { kind: 'individual', firstName: 'Luc', name: 'Martin', phone: '081 22 33 44', address: { countryCode: 'BE' }, roles: { customer: true } });
  const d = (await c.get(`/api/contacts/${p.id}`)).data; assert.equal(d.kind, 'individual'); assert.equal(d.displayName, 'Luc Martin'); assert.equal(d.phone, '081 22 33 44');
  await c.post(`/api/companies/${p.id}/archive`, {});
  assert.equal((await list(c)).length, 0); assert.equal((await list(c, 'archived')).length, 1, 'archived, not deleted');
}));

// ---------- UI wiring (real source) ----------
test('UI: the form asks the role (required), person or company, and every field; the new contact opens right after saving; no false success', () => {
  assert.match(form, /\[\['customer', tt\('Customer'\)\], \['supplier', tt\('Supplier'\)\], \['both', tt\('Customer \+ Supplier'\)\]\]/);
  assert.match(form, /\[\['business', tt\('A company'\)\], \['individual', tt\('A person'\)\]\]/);
  for (const k of ["inp('firstName'", "inp('name'", "inp('vatNumber'", "inp('enterpriseNumber'", "inp('email'", "inp('phone'", "inp('street'", "inp('postalCode'", "inp('city'", "inp('countryCode'", "inp('iban'", "inp('notes'"]) assert.ok(form.includes(k), k);
  assert.match(form, /if \(!m\.role\) problems\.push/, 'no request without a role');
  const call = form.indexOf("await api('POST', '/api/companies', body)"); const ok = form.indexOf("toast(tt('Contact saved'), 'ok')");
  assert.ok(call > 0 && ok > call, 'the success toast only after the API answered');
  assert.match(form, /location\.hash = target;/); assert.match(form, /#\/contacts\?open=\$\{r\.id\}/, 'the list reloads and the contact opens');
  assert.match(form, /e\.code === 'CONTACT_POSSIBLE_DUPLICATE'/); assert.match(form, /tt\('Create anyway'\)/); assert.match(form, /e\.code === 'ROLE_IN_USE'/);
  assert.match(form, /else if \(e\.code === 'INPUT_INVALID' && e\.fields\) showFieldErrors\(e\.fields\);\s*else fail\(e, err\);/, 'field errors are listed with readable labels; any other API error is shown in the form, which stays open');
  assert.match(form, /const drops = \(v\) => \(locked\.customer && v === 'supplier'\) \|\| \(locked\.supplier && v === 'customer'\);/, 'options that would drop a document-backed role are disabled');
});

test('UI: role badges in the list and the detail, contact details block, "Edit" passes the effective roles', () => {
  assert.match(contactsSrc, /const RELATION_TEXT = \{ both: 'Customer \+ Supplier', customer: 'Customer', supplier: 'Supplier', none: '—' \};/);
  assert.match(contactsSrc, /h\('td', \{ 'data-label': tr\('Relation'\) \}, relationBadge\(r\)\)/);
  assert.match(contactsSrc, /h\('p', null, relationBadge\(c\)\)/);
  assert.match(contactsSrc, /companyModal\(r\.company, c\)/);
  assert.match(contactsSrc, /\[tt\('Phone'\), c\.phone\]/); assert.match(contactsSrc, /\['IBAN', c\.iban\]/);
});

test('"+ New contact" stays reachable below 1180px (it lived in a quote-card, which is hidden there): phones, tablets, narrow laptop windows', () => {
  const css = read('style.css');
  assert.match(css, /@media \(max-width: 1179px\) \{ \.hero-row \{ grid-template-columns: 1fr; \} \.quote-card \{ display: none; \} \}/, 'the rule that hid it (unchanged for the Accueil decoration)');
  assert.match(css, /@media \(max-width: 1179px\) \{ \.hero-row\.subpage \.quote-card\.contacts-actions, \.hero-row\.subpage \.quote-card\.sales-actions, \.hero-row\.subpage \.quote-card\.bank-actions \{ display: flex; \} \}/, 'only the three action cards, never the quote-card in general');
  const ws = read('views-workspace.js');
  assert.match(ws, /class: 'quote-card sales-actions'[^\n]*#\/new\/invoice/, 'Sales: New invoice'); assert.match(ws, /class: 'quote-card bank-actions'[^\n]*#\/treasury/, 'Bank: Treasury');
  assert.ok(css.lastIndexOf('.quote-card.bank-actions { display: flex; }') > css.indexOf('.quote-card { display: none; }'), 'declared after the hiding rule');
  assert.match(contactsSrc, /class: 'quote-card contacts-actions'/);
});

// ---------- backward compatibility: existing contacts keep every role they had before the migration ----------
test('migration: an existing row (before the new columns exist, or with their defaults false / NULL) maps to "no declared role", never to an error', async () => {
  const { companyFromRow } = await import('../src/finance/supabase-store.js');
  const legacy = { id: 'c1', merchant_id: 'm', kind: 'business', name: 'Ancien Client SA', vat_number: null, street: null, postal_code: null, city: null, country_code: 'BE', contact_email: null, source: 'manual' };
  const migrated = { ...legacy, declared_customer: false, declared_supplier: false, first_name: null, phone: null, iban: null };
  for (const row of [legacy, migrated]) {
    const c = companyFromRow(row);
    assert.deepEqual(c.declaredRoles, { customer: false, supplier: false });
    assert.equal(c.firstName, null); assert.equal(c.phone, null); assert.equal(c.iban, null);
    assert.equal(c.name, 'Ancien Client SA', 'existing fields unchanged');
  }
  const sql = readFileSync(new URL('../supabase/migrations/20260926130000_finance_contacts_roles_phone_iban.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /\b(drop|delete|update|rename|truncate|alter\s+column)\b/i, 'additive only: nothing dropped, deleted, updated or renamed');
  assert.equal((sql.match(/add column/gi) || []).length, 5);
  assert.match(sql, /declared_customer boolean not null default false/); assert.match(sql, /declared_supplier boolean not null default false/);
});

test('backward compatibility: contacts with no declared role keep exactly the roles their documents prove (list AND detail)', async () => {
  const { buildContacts, contactDetail } = await import('../src/finance/contacts.js');
  const m = (c) => String(c);
  const legacy = [ // rows as they exist after the migration: declared roles all false
    { id: 'cust', kind: 'business', name: 'Client Historique', declaredRoles: { customer: false, supplier: false } },
    { id: 'supp', kind: 'business', name: 'Fournisseur Historique', declaredRoles: { customer: false, supplier: false } },
    { id: 'both', kind: 'business', name: 'Les Deux Historique' }, // no declaredRoles key at all
    { id: 'none', kind: 'business', name: 'Sans activité', declaredRoles: { customer: false, supplier: false } },
  ];
  const sale = (companyId) => ({ doc: { id: `d-${companyId}`, type: 'invoice', customer: { companyId }, lockedAt: '2026-09-01T10:00:00Z', status: 'ISSUED', issueDate: '2026-09-01', dueDate: '2026-10-01', totals: { grossCents: 12100 } }, payments: [], creditNotes: [] });
  const salesDocs = [sale('cust'), sale('both')];
  const supplierInvoices = [{ id: 's1', supplierCompanyId: 'supp', status: 'VALIDATED', grossCents: 500 }, { id: 's2', supplierCompanyId: 'both', status: 'TO_PAY', grossCents: 700 }];
  const rows = buildContacts({ companies: legacy, salesDocs, supplierInvoices, m, today: '2026-09-26' });
  const role = (id) => { const r = rows.find((x) => x.id === id); return [r.isCustomer, r.isSupplier]; };
  assert.deepEqual(role('cust'), [true, false], 'a customer invoice keeps the Customer role');
  assert.deepEqual(role('supp'), [false, true], 'a supplier invoice keeps the Supplier role');
  assert.deepEqual(role('both'), [true, true], 'both kinds of documents: Customer + Supplier');
  assert.deepEqual(role('none'), [false, false], 'no document, nothing declared: no role (nothing invented)');
  for (const c of legacy.slice(0, 3)) {
    const d = contactDetail(c, { salesDocs, supplierInvoices, m, today: '2026-09-26' });
    assert.deepEqual([d.isCustomer, d.isSupplier], role(c.id), `detail agrees with the list for ${c.id}`);
  }
});

test('role rule table: effective role = declared OR proven by documents; a proven role can never be removed', () => {
  const cases = [
    [{ customer: true, supplier: false }, {}, [true, false], 'declared Customer -> Customer'],
    [{ customer: false, supplier: false }, { customerDocuments: 1 }, [true, false], 'customer invoice, declared false -> Customer'],
    [{ customer: false, supplier: true }, {}, [false, true], 'declared Supplier -> Supplier'],
    [{ customer: false, supplier: false }, { supplierDocuments: 1 }, [false, true], 'supplier invoice -> Supplier'],
    [{ customer: true, supplier: true }, {}, [true, true], 'declared both -> Customer + Supplier'],
    [{ customer: true, supplier: false }, { supplierDocuments: 2 }, [true, true], 'declared Customer + supplier invoices -> Customer + Supplier'],
  ];
  for (const [declared, counts, expected, label] of cases) { const r = contactRoles({ declaredRoles: declared }, counts); assert.deepEqual([r.isCustomer, r.isSupplier], expected, label); }
  // removing a proven role is always refused, whatever is declared
  assert.equal(roleChangeProblems({ customer: false, supplier: true }, { customerDocuments: 1 }).length, 1);
  assert.equal(roleChangeProblems({ customer: true, supplier: false }, { supplierDocuments: 1 }).length, 1);
  assert.equal(roleChangeProblems({ customer: false, supplier: false }, { customerDocuments: 1, supplierDocuments: 1 }).length, 2);
});
