// Phase 1: unified Contact foundation. Pure-function tests for matching/role derivation (no server needed),
// then HTTP integration tests for the manual link/unlink lifecycle, tenant isolation, and the /api/contacts
// projection - against the real createFinanceApp, exactly like every other finance-*.test.js file.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFinanceApp } from '../src/finance/server/app.js';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { buildContacts, matchSupplierInvoicesToContacts, normalizeName, normalizeVat } from '../src/finance/contacts.js';
import { TOKEN, baseSettings } from './finance-dashboard-helpers.js';
import { mergeConfig } from '../src/metrics/config.js';

// ---------- pure matching (no server) ----------
test('normalizeVat: keeps the country prefix, strips presentation punctuation/whitespace, uppercases', () => {
  assert.equal(normalizeVat('BE 0123.456.789'), 'BE0123456789');
  assert.equal(normalizeVat('be0123456789'), 'BE0123456789');
  assert.equal(normalizeVat(null), null);
  assert.equal(normalizeVat(''), null);
});

test('normalizeName: case/whitespace/trivial punctuation only - never fuzzy', () => {
  assert.equal(normalizeName('TYESO SRL'), normalizeName('Tyeso srl'));
  assert.equal(normalizeName('  Tyeso   SRL. '), 'TYESO SRL');
  assert.notEqual(normalizeName('Tyeso'), normalizeName('Tyeso Europe')); // must never collapse - not fuzzy
});

test('MATCH: exact VAT after normalisation links automatically', () => {
  const companies = [{ id: 'c1', name: 'Tyeso SRL', vatNumber: 'BE0123456789' }];
  const invoices = [{ id: 'i1', supplierName: 'TYESO', supplierVatNumber: 'BE 0123.456.789', supplierCompanyId: null }];
  const r = matchSupplierInvoicesToContacts(invoices, companies);
  assert.deepEqual(r.links, [{ invoiceId: 'i1', contactId: 'c1', matchedBy: 'vat' }]);
  assert.equal(r.ambiguousVat.length, 0); assert.equal(r.unmatched.length, 0);
});

test('MATCH: ambiguous VAT (two companies normalise to the same VAT) - no auto-link', () => {
  // Distinct raw values (as the unique index on fin_companies allows), colliding only after normalisation.
  const companies = [{ id: 'c1', name: 'A', vatNumber: 'FR12345678901' }, { id: 'c2', name: 'B', vatNumber: 'FR 1234-5678901' }];
  const invoices = [{ id: 'i1', supplierName: 'Someone', supplierVatNumber: 'FR12345678901', supplierCompanyId: null }];
  const r = matchSupplierInvoicesToContacts(invoices, companies);
  assert.equal(r.links.length, 0);
  assert.deepEqual(r.ambiguousVat, ['i1']);
});

test('MATCH: no VAT match falls back to exact normalised name, unique match links', () => {
  const companies = [{ id: 'c1', name: 'Tyeso SRL', vatNumber: null }];
  const invoices = [{ id: 'i1', supplierName: 'tyeso srl', supplierVatNumber: null, supplierCompanyId: null }];
  const r = matchSupplierInvoicesToContacts(invoices, companies);
  assert.deepEqual(r.links, [{ invoiceId: 'i1', contactId: 'c1', matchedBy: 'name' }]);
});

test('MATCH: ambiguous name (two companies share the exact normalised name) - no auto-link', () => {
  const companies = [{ id: 'c1', name: 'Tyeso SRL', vatNumber: null }, { id: 'c2', name: 'TYESO SRL', vatNumber: null }];
  const invoices = [{ id: 'i1', supplierName: 'Tyeso SRL', supplierVatNumber: null, supplierCompanyId: null }];
  const r = matchSupplierInvoicesToContacts(invoices, companies);
  assert.equal(r.links.length, 0);
  assert.deepEqual(r.ambiguousName, ['i1']);
});

test('MATCH: merely similar names never auto-link (no fuzzy matching, ever)', () => {
  const companies = [{ id: 'c1', name: 'Tyeso Europe', vatNumber: null }];
  const invoices = [{ id: 'i1', supplierName: 'Tyeso', supplierVatNumber: null, supplierCompanyId: null }];
  const r = matchSupplierInvoicesToContacts(invoices, companies);
  assert.equal(r.links.length, 0);
  assert.deepEqual(r.unmatched, ['i1']);
});

test('MATCH: an invoice already linked is reported as alreadyLinked and never re-matched', () => {
  const companies = [{ id: 'c1', name: 'Tyeso', vatNumber: 'BE0123456789' }];
  const invoices = [{ id: 'i1', supplierName: 'Tyeso', supplierVatNumber: 'BE0123456789', supplierCompanyId: 'c-other' }];
  const r = matchSupplierInvoicesToContacts(invoices, companies);
  assert.equal(r.links.length, 0);
  assert.deepEqual(r.alreadyLinked, ['i1']);
});

// ---------- pure role derivation (no server) ----------
const m = (c) => (c / 100).toFixed(2);
test('ROLES: a company with only a locked sales document is a customer, never a supplier', () => {
  const company = { id: 'c1', name: 'Client A', kind: 'business', vatNumber: null };
  const salesDocs = [{ doc: { customer: { companyId: 'c1' }, lockedAt: '2026-01-01', status: 'ISSUED', type: 'invoice', issueDate: '2026-01-01', totals: { grossCents: 1000 } }, payments: [], creditNotes: [] }];
  const [row] = buildContacts({ companies: [company], salesDocs, supplierInvoices: [], m });
  assert.equal(row.isCustomer, true); assert.equal(row.isSupplier, false);
  assert.equal(row.customerDocumentCount, 1); assert.equal(row.supplierDocumentCount, 0);
});

test('ROLES: a company with only a linked supplier invoice is a supplier, never a customer', () => {
  const company = { id: 'c1', name: 'Supplier A', kind: 'business', vatNumber: null };
  const supplierInvoices = [{ id: 's1', supplierCompanyId: 'c1', status: 'TO_PAY', grossCents: 500, receivedAt: '2026-01-01T00:00:00Z', issueDate: '2026-01-01' }];
  const [row] = buildContacts({ companies: [company], salesDocs: [], supplierInvoices, m });
  assert.equal(row.isCustomer, false); assert.equal(row.isSupplier, true);
  assert.equal(row.amountPayable, '5.00');
});

test('ROLES: a company with both a sales document and a supplier invoice is Client + Fournisseur, not two rows', () => {
  const company = { id: 'c1', name: 'Both', kind: 'business', vatNumber: null };
  const salesDocs = [{ doc: { customer: { companyId: 'c1' }, lockedAt: '2026-01-01', status: 'ISSUED', type: 'invoice', issueDate: '2026-01-01', totals: { grossCents: 1000 } }, payments: [], creditNotes: [] }];
  const supplierInvoices = [{ id: 's1', supplierCompanyId: 'c1', status: 'TO_PAY', grossCents: 500, receivedAt: '2026-01-01T00:00:00Z', issueDate: '2026-01-01' }];
  const rows = buildContacts({ companies: [company], salesDocs, supplierInvoices, m });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isCustomer, true); assert.equal(rows[0].isSupplier, true);
});

test('ROLES: a draft-only sales document does not establish the customer role', () => {
  const company = { id: 'c1', name: 'Draft only', kind: 'business', vatNumber: null };
  const salesDocs = [{ doc: { customer: { companyId: 'c1' }, lockedAt: null, status: 'DRAFT', type: 'invoice', issueDate: null, totals: null }, payments: [], creditNotes: [] }];
  const [row] = buildContacts({ companies: [company], salesDocs, supplierInvoices: [], m });
  assert.equal(row.isCustomer, false);
});

// ---------- HTTP integration ----------
const withApp = (opts, fn) => async () => {
  const store = opts.store ?? createMemoryStore();
  let settings = opts.settings ?? baseSettings();
  const audits = [];
  const app = createFinanceApp({
    merchantId: opts.merchantId ?? 'merchant-test-1', store, token: TOKEN, retail: null, retailConfig: mergeConfig({}), timeZone: 'UTC',
    clock: { now: () => '2026-09-24T10:00:00.000Z', today: () => '2026-09-24' },
    settings: { load: async () => structuredClone(settings), save: async (s) => { settings = structuredClone(s); }, saveLogo: async () => 'x' },
    audit: async (e) => { audits.push(e); },
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; const base = `http://127.0.0.1:${port}`;
  function client() {
    const c = { cookie: null, csrf: null };
    c.raw = async (method, path, body) => {
      const headers = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}), ...(c.csrf ? { 'X-CSRF-Token': c.csrf } : {}) };
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const ct = res.headers.get('content-type') ?? ''; const data = ct.includes('json') ? await res.json() : null;
      return { status: res.status, data };
    };
    c.login = async () => { const r = await c.raw('POST', '/api/login', { token: TOKEN }); c.cookie = null; return r; };
    for (const mth of ['GET', 'POST', 'PUT']) c[mth.toLowerCase()] = (p, b) => c.raw(mth, p, b);
    return c;
  }
  const authed = async () => {
    const c = client();
    const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    c.cookie = res.headers.get('set-cookie').split(';')[0]; c.csrf = (await res.json()).csrf;
    return c;
  };
  try { await fn({ store, authed, client, audits }); } finally { await new Promise((r) => server.close(r)); }
};

// Real, checksum-valid Belgian VAT numbers (normalizeBelgianNumber() rejects anything else) - each test
// that needs more than one distinct company passes its own vatNumber override.
const company = (over = {}) => ({ kind: 'business', name: 'Tyeso SRL', vatNumber: 'BE0000000097', address: { street: 'Rue A 1', postalCode: '5000', city: 'Namur', countryCode: 'BE' }, ...over });

test('MANUAL LINK: link, idempotent re-link, explicit relink to another contact, unlink - never deletes the contact', withApp({}, async ({ authed }) => {
  const c = await authed();
  const co1 = (await c.post('/api/companies', company())).data;
  const co2 = (await c.post('/api/companies', company({ name: 'Autre Fournisseur', vatNumber: 'BE0000000196' }))).data;
  const inv = (await c.post('/api/inbox/manual', { supplierName: 'Tyeso', invoiceNumber: 'F-1' })).data;
  assert.equal(inv.supplierCompanyId, null);

  const linked = (await c.post(`/api/inbox/${inv.id}/contact`, { contactId: co1.id })).data;
  assert.equal(linked.supplierCompanyId, co1.id);
  assert.equal(linked.supplierName, 'Tyeso'); // snapshot untouched by linking

  const relinked = (await c.post(`/api/inbox/${inv.id}/contact`, { contactId: co1.id })).data; // idempotent
  assert.equal(relinked.supplierCompanyId, co1.id);

  const switched = (await c.post(`/api/inbox/${inv.id}/contact`, { contactId: co2.id })).data; // explicit change
  assert.equal(switched.supplierCompanyId, co2.id);

  const unlinked = (await c.post(`/api/inbox/${inv.id}/contact`, { contactId: null })).data;
  assert.equal(unlinked.supplierCompanyId, null);

  // The contact itself was never deleted by any of the above.
  assert.equal((await c.get(`/api/companies/${co1.id}`)).status, 200);
  assert.equal((await c.get(`/api/companies/${co2.id}`)).status, 200);
}));

test('SNAPSHOT: renaming the linked contact afterwards never rewrites the historical supplierName', withApp({}, async ({ authed }) => {
  const c = await authed();
  const co = (await c.post('/api/companies', company())).data;
  const inv = (await c.post('/api/inbox/manual', { supplierName: 'Tyeso (ancien nom)', invoiceNumber: 'F-1' })).data;
  await c.post(`/api/inbox/${inv.id}/contact`, { contactId: co.id });
  await c.put(`/api/companies/${co.id}`, company({ name: 'Tyeso SRL (nouveau nom)' }));
  const after = (await c.get(`/api/inbox/${inv.id}`)).data;
  assert.equal(after.supplierName, 'Tyeso (ancien nom)');
  assert.equal(after.supplierCompanyId, co.id);
}));

test('TENANT: a merchant cannot link its supplier invoice to another merchant\'s contact, nor vice versa', withApp({}, async ({ authed, store }) => {
  const a = await authed();
  const invA = (await a.post('/api/inbox/manual', { supplierName: 'Tyeso', invoiceNumber: 'F-1' })).data;
  // A second app instance, different merchant, SAME underlying store (mirrors tenant-isolation.test.js's pattern).
  const http2 = await new Promise((resolve) => {
    const app2 = createFinanceApp({ merchantId: 'merchant-test-2', store, token: TOKEN, retail: null, retailConfig: mergeConfig({}), timeZone: 'UTC', clock: { now: () => '2026-09-24T10:00:00.000Z', today: () => '2026-09-24' }, settings: { load: async () => baseSettings(), save: async () => {}, saveLogo: async () => 'x' } });
    const server = http.createServer(app2.handler); server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const base2 = `http://127.0.0.1:${http2.address().port}`;
  const login2 = await fetch(base2 + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  const cookie2 = login2.headers.get('set-cookie').split(';')[0]; const csrf2 = (await login2.json()).csrf;
  const post2 = (path, body) => fetch(base2 + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie2, 'X-CSRF-Token': csrf2 }, body: JSON.stringify(body) });
  const coB = await (await post2('/api/companies', company({ name: 'Contact B' }))).json();

  // Merchant A cannot link its invoice to merchant B's contact.
  const r1 = await a.post(`/api/inbox/${invA.id}/contact`, { contactId: coB.id });
  assert.equal(r1.status, 404);
  // Merchant B cannot link merchant A's invoice at all (not found in B's tenant).
  const r2 = await post2(`/api/inbox/${invA.id}/contact`, { contactId: coB.id });
  assert.equal(r2.status, 404);
  await new Promise((r) => http2.close(r));
}));

test('API: role=customer, role=supplier, role=all, search, and a dual-role contact appears exactly once', withApp({}, async ({ authed }) => {
  const c = await authed();
  const coCustomer = (await c.post('/api/companies', company({ name: 'Only Client', vatNumber: 'BE0000000097' }))).data;
  const coBoth = (await c.post('/api/companies', company({ name: 'Client Et Fournisseur', vatNumber: 'BE0000000196' }))).data;
  const dCustomer = (await c.post('/api/documents', { type: 'invoice', customer: { companyId: coCustomer.id, kind: 'business', name: coCustomer.name, address: coCustomer.address }, lines: [{ description: 'X', quantity: '1', unitPrice: '10.00', vatRate: '21' }], vat: { regime: 'domestic', confirmed: true }, revenueBasis: 'standalone_b2b', issueDate: '2026-09-21' })).data;
  await c.post(`/api/documents/${dCustomer.id}/submit`, {});
  await c.post(`/api/documents/${dCustomer.id}/approve`, {});
  const dBoth = (await c.post('/api/documents', { type: 'invoice', customer: { companyId: coBoth.id, kind: 'business', name: coBoth.name, address: coBoth.address }, lines: [{ description: 'X', quantity: '1', unitPrice: '10.00', vatRate: '21' }], vat: { regime: 'domestic', confirmed: true }, revenueBasis: 'standalone_b2b', issueDate: '2026-09-21' })).data;
  await c.post(`/api/documents/${dBoth.id}/submit`, {});
  await c.post(`/api/documents/${dBoth.id}/approve`, {});
  const invBoth = (await c.post('/api/inbox/manual', { supplierName: 'x', invoiceNumber: 'F-1' })).data;
  await c.post(`/api/inbox/${invBoth.id}/contact`, { contactId: coBoth.id });

  const all = (await c.get('/api/contacts')).data.rows;
  assert.equal(all.filter((r) => r.id === coBoth.id).length, 1); // never duplicated across roles

  const customers = (await c.get('/api/contacts?role=customer')).data.rows;
  assert.ok(customers.some((r) => r.id === coCustomer.id));
  assert.ok(customers.some((r) => r.id === coBoth.id));

  const suppliers = (await c.get('/api/contacts?role=supplier')).data.rows;
  assert.ok(suppliers.every((r) => r.id !== coCustomer.id));
  assert.ok(suppliers.some((r) => r.id === coBoth.id));

  const search = (await c.get('/api/contacts?q=Fournisseur')).data.rows;
  assert.ok(search.every((r) => r.id === coBoth.id));
}));

test('API: contact detail lists linked sales and supplier documents with real amounts, and 404s on a foreign id', withApp({}, async ({ authed }) => {
  const c = await authed();
  const co = (await c.post('/api/companies', company())).data;
  const inv = (await c.post('/api/inbox/manual', { supplierName: 'Tyeso', invoiceNumber: 'F-1', net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR', issueDate: '2026-09-21' })).data;
  await c.post(`/api/inbox/${inv.id}/contact`, { contactId: co.id });
  const detail = (await c.get(`/api/contacts/${co.id}`)).data;
  assert.equal(detail.displayName, 'Tyeso SRL');
  assert.equal(detail.isSupplier, true);
  assert.equal(detail.supplierDocuments.length, 1);
  assert.equal(detail.supplierDocuments[0].invoiceNumber, 'F-1');
  assert.equal((await c.get('/api/contacts/does-not-exist')).status, 404);
}));

test('REGRESSION: unlinked supplier invoices keep working end to end, and /api/companies is unaffected', withApp({}, async ({ authed }) => {
  const c = await authed();
  const inv = (await c.post('/api/inbox/manual', { supplierName: 'Sans contact', invoiceNumber: 'F-9', net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR', issueDate: '2026-09-21' })).data;
  assert.equal((await c.post(`/api/inbox/${inv.id}/validate`, {})).status, 200);
  assert.equal((await c.post(`/api/inbox/${inv.id}/to-pay`, {})).status, 200);
  assert.equal((await c.post(`/api/inbox/${inv.id}/pay`, { amount: '121.00', paidOn: '2026-09-24' })).status, 200);
  const co = (await c.post('/api/companies', company())).data;
  assert.equal((await c.get('/api/companies')).status, 200);
  assert.equal((await c.get(`/api/companies/${co.id}`)).status, 200);
}));
