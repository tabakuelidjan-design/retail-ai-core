// The purchase review pane really renders (fields + actions, not only the header) for every kind of purchase document:
// UBL invoice, imported PDF, manual invoice, captured expense, and a validated credit note.
//
// This codebase has no DOM test harness, so this test brings the smallest possible one: a fake document whose appendChild
// throws on anything that is not a node, exactly like the browser (that is how appendChild(null) broke the pane). The code under
// test is the REAL source: h() is taken from app.js, renderInboxDetail from views-workspace.js, captureInfoNode / attachButton
// from views-pack.js. The items come from the real Finance API (in-memory store), not from hand-written fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp } from './finance-dashboard-helpers.js';

const src = (f) => readFileSync(new URL(`../src/finance/ui/${f}`, import.meta.url), 'utf8');

// ---------- minimal DOM ----------
class FakeNode { constructor() { this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  appendChild(c) { if (!(c instanceof FakeNode)) throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'."); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); } }
class FakeText extends FakeNode { constructor(t) { super(); this.text = String(t); } get textContent() { return this.text; } }
class FakeElement extends FakeNode {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.className = ''; this.attributes = {}; this.listeners = {}; this.style = { setProperty() {} }; this.value = ''; this.disabled = false; }
  setAttribute(k, v) { this.attributes[k] = String(v); } getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  get options() { return this.childNodes.filter((c) => c.tagName === 'OPTION'); }
}
const all = (n, pred, out = []) => { for (const c of n.childNodes) { if (c instanceof FakeElement && pred(c)) out.push(c); all(c, pred, out); } return out; };
const byClass = (n, cls) => all(n, (e) => e.className.split(/\s+/).includes(cls));
const byTag = (n, tag) => all(n, (e) => e.tagName === tag.toUpperCase());

function loadUi(apiImpl) {
  const g = globalThis; const saved = {};
  const env = {
    Node: FakeNode, document: { createElement: (t) => new FakeElement(t), createTextNode: (t) => new FakeText(t) },
    tr: (s) => s, tt: (s, ...a) => a.reduce((acc, v, i) => acc.replace(`{${i}}`, v), String(s)), makeDateInput: () => {},
    api: apiImpl, fail: (e) => { throw e; }, toast: () => {}, modal: () => {}, svgIcon: () => new FakeElement('svg'),
    clear: (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; },
    INV_FILTERS: [], QUOTE_FILTERS: [], // app.js constants read while views-workspace.js loads (sales filters), unused here
    I18N: { getLang: () => 'fr', tag: () => 'fr-BE' }, CUR_SYMBOL: { EUR: '€' }, state: { settings: { defaults: { currency: 'EUR' } } },
  };
  for (const [k, v] of Object.entries(env)) { saved[k] = g[k]; g[k] = v; }
  saved.window = g.window; g.window = g;
  const appSrc = src('app.js'); const start = appSrc.indexOf('function h(tag, attrs, ...kids) {'); const close = /\r?\n\}\r?\n/.exec(appSrc.slice(start)); assert.ok(start >= 0 && close, 'h() found in app.js'); const end = start + close.index + close[0].length;
  // eslint-disable-next-line no-new-func
  g.h = new Function(`${appSrc.slice(start, end)}\nreturn h;`)();
  const mountLine = /^const mount = .*$/m.exec(appSrc); assert.ok(mountLine, 'mount() found in app.js');
  // eslint-disable-next-line no-new-func
  g.mount = new Function(`${mountLine[0]}\nreturn mount;`)();
  // eslint-disable-next-line no-new-func
  new Function(src('views-pack.js'))(); // defines window.captureInfoNode / window.attachButton (the real ones)
  // eslint-disable-next-line no-new-func
  const ws = new Function(`${src('views-workspace.js')}\nreturn { renderInboxDetail, PURCHASE_TABS };`)();
  return { ...ws, restore: () => { for (const [k, v] of Object.entries(saved)) g[k] = v; delete g.h; delete g.mount; delete g.captureInfoNode; delete g.attachButton; } };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n% synthetic supplier invoice\n1 0 obj<<>>endobj\n%%EOF\n');
const UBL = (root, id) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>${id}</cbc:ID><cbc:IssueDate>2026-09-10</cbc:IssueDate><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>F-UI-1</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>
<cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>BE0000000097</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>Fournisseur UI SRL</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">21.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">21.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>21</cbc:Percent></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">121.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">121.00</cbc:PayableAmount></cac:LegalMonetaryTotal></${root}>`, 'utf8');

async function render(ui, id) {
  const host = new FakeElement('div'); ui.renderInboxDetail(host, id);
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); // draw() is async (api call)
  const body = byClass(host, 'drawer-body')[0];
  return { host, body, fields: all(body, (e) => e.getAttribute('data-field') === 'documentType').concat(byTag(body, 'input')), buttons: byClass(body, 'actions').flatMap((a) => byTag(a, 'button').map((b) => b.textContent)), head: byClass(body, 'drawer-head')[0] };
}

test('the review pane renders fields and actions for a UBL invoice, an imported PDF, a manual invoice, a captured expense and a credit note', async () => {
  const a = await startApp(); const c = await a.authed();
  let ui;
  try {
    const ubl = (await c.post('/api/inbox/upload', { fileName: 'facture.xml', dataBase64: UBL('Invoice', 'F-UI-1').toString('base64') })).data.item;
    const pdf = (await c.post('/api/inbox/upload', { fileName: 'scan.pdf', dataBase64: PDF.toString('base64') })).data.item;
    const manual = (await c.post('/api/inbox/manual', { supplierName: 'Fournisseur Manuel SA', invoiceNumber: 'M-UI', issueDate: '2026-09-01', net: '10.00', vat: '2.10', gross: '12.10', currency: 'EUR' })).data;
    const capture = (await c.post('/api/inbox/capture', { fileName: 'ticket.png', dataBase64: PNG.toString('base64'), origin: 'camera', fields: { supplierName: 'Taxi Exemple', issueDate: '2026-09-12', gross: '18.00', currency: 'EUR' }, capture: { category: 'taxi', paymentMethod: 'card' } })).data.item;
    const cn = (await c.post('/api/inbox/upload', { fileName: 'avoir.xml', dataBase64: UBL('CreditNote', 'F-UI-1').toString('base64') })).data.item;
    assert.equal((await c.post(`/api/inbox/${cn.id}/validate`, {})).status, 200);
    const items = new Map();
    for (const it of [ubl, pdf, manual, capture, cn]) items.set(it.id, (await c.get(`/api/inbox/${it.id}`)).data);
    ui = loadUi(async (method, path) => { const id = path.split('/')[3]; if (method === 'GET' && items.has(id)) return items.get(id); throw new Error(`unexpected ${method} ${path}`); });

    const expectFull = (r, label) => {
      assert.ok(r.head, `${label}: header`);
      assert.ok(r.fields.length >= 14, `${label}: the form fields are rendered, not only the header (${r.fields.length})`);
      assert.ok(r.buttons.length >= 1, `${label}: the actions are rendered`);
    };
    const u = await render(ui, ubl.id); expectFull(u, 'UBL'); assert.deepEqual(u.buttons, ['Save', 'Validate', 'Reject']);
    assert.equal(byClass(u.body, 'doc-vat').length, 1, 'UBL: VAT by rate shown');
    const p = await render(ui, pdf.id); expectFull(p, 'PDF'); assert.deepEqual(p.buttons, ['Save', 'Validate', 'Reject']);
    const m = await render(ui, manual.id); expectFull(m, 'manual'); assert.ok(m.body.textContent.includes('Add the supporting document'), 'manual: no file yet, the real attach button is offered');
    const x = await render(ui, capture.id); expectFull(x, 'capture'); assert.equal(byClass(x.body, 'pk-capinfo').length, 1, 'capture: the real capture block is shown');
    assert.ok(x.head.textContent.includes('Receipt / ticket'), 'capture: typed as a receipt');
    const n = await render(ui, cn.id); expectFull(n, 'credit note');
    assert.deepEqual(n.buttons, ['Reopen for correction'], 'a validated credit note never offers "Mark to pay"');
    assert.ok(n.head.textContent.includes('Validated') && n.head.textContent.includes('Credit note'));
    assert.ok(n.body.textContent.includes('Open the source document'), 'the original document stays available');
  } finally { ui?.restore(); await a.close(); }
});

test('Achats views: every purchase document appears in exactly one view (To handle / Validated / To pay / Paid / Credit notes)', async () => {
  const a = await startApp(); const c = await a.authed(); let ui;
  try {
    const man = async (n, extra = {}) => (await c.post('/api/inbox/manual', { supplierName: 'Fournisseur Vues SA', invoiceNumber: n, issueDate: '2026-09-01', net: '10.00', vat: '2.10', gross: '12.10', currency: 'EUR', ...extra })).data.id;
    const ok = async (r) => { assert.ok(r.status < 300, JSON.stringify(r.data)); return r; };
    const toReview = await man('V-REVIEW');
    const validated = await man('V-VALID'); await ok(await c.post(`/api/inbox/${validated}/validate`, {}));
    const toPay = await man('V-TOPAY'); await ok(await c.post(`/api/inbox/${toPay}/validate`, {})); await ok(await c.post(`/api/inbox/${toPay}/to-pay`, {}));
    const paid = await man('V-PAID'); await ok(await c.post(`/api/inbox/${paid}/validate`, {})); await ok(await c.post(`/api/inbox/${paid}/to-pay`, {})); await ok(await c.post(`/api/inbox/${paid}/pay`, { paidOn: '2026-09-20', amount: '12.10' }));
    const credit = await man('V-AVOIR', { documentType: 'CREDIT_NOTE' }); await ok(await c.post(`/api/inbox/${credit}/validate`, {}));
    assert.equal((await c.post(`/api/inbox/${credit}/to-pay`, {})).status, 409, 'a credit note is never marked to pay');
    const scopes = { inbox: (await c.get('/api/inbox?scope=inbox')).data.rows, purchases: (await c.get('/api/inbox?scope=purchases')).data.rows };
    ui = loadUi(async () => { throw new Error('no api call expected'); });
    const T = ui.PURCHASE_TABS;
    assert.deepEqual(Object.keys(T), ['inbox', 'validated', 'to_pay', 'paid', 'credit_notes']);
    const viewsOf = (id) => Object.entries(T).filter(([, t]) => scopes[t.scope].filter(t.keep).some((r) => r.id === id)).map(([k]) => k);
    assert.deepEqual(viewsOf(toReview), ['inbox'], 'TO_REVIEW invoice: To handle');
    assert.deepEqual(viewsOf(validated), ['validated'], 'VALIDATED invoice: Validated (not To pay)');
    assert.deepEqual(viewsOf(toPay), ['to_pay'], 'TO_PAY invoice: To pay');
    assert.deepEqual(viewsOf(paid), ['paid'], 'PAID invoice: Paid');
    assert.deepEqual(viewsOf(credit), ['credit_notes'], 'VALIDATED credit note: Credit notes only');
    assert.equal(T.validated.label, 'Validated documents'); assert.equal(T.credit_notes.label, 'Credit notes');
    // the validated invoice still offers the normal next step; the validated credit note never does
    const items = new Map(); for (const id of [validated, credit]) items.set(id, (await c.get(`/api/inbox/${id}`)).data);
    ui.restore(); ui = loadUi(async (m, path) => items.get(path.split('/')[3]));
    assert.deepEqual((await render(ui, validated)).buttons, ['Mark to pay', 'Reopen for correction']);
    assert.deepEqual((await render(ui, credit)).buttons, ['Reopen for correction']);
  } finally { ui?.restore(); await a.close(); }
});

test('Achats: the views are reachable by URL and translated', () => {
  const ws = src('views-workspace.js');
  assert.match(ws, /let tab = q\.get\('tab'\) === 'analytics' \? 'analytics' : PURCHASE_TABS\[q\.get\('tab'\)\] \? q\.get\('tab'\) : 'inbox';/);
  assert.match(ws, /rows = r\.rows\.filter\(view\.keep\);/);
  const fr = src('lang-fr.js'); assert.match(fr, /"Validated documents": "Validées"/); assert.match(fr, /'Credit notes': 'Avoirs'|"Credit notes": "Avoirs"/);
  assert.match(src('lang-nl.js'), /"Validated documents": "Gevalideerd"/);
});

test('review pane (phase 2): the Supplier and Duplicates blocks show recognised / to confirm / unknown and none / possible, with only explicit actions', async () => {
  const a = await startApp(); const c = await a.authed(); let ui;
  try {
    const contact = (await c.post('/api/companies', { kind: 'business', name: 'Fournisseur UI SRL', vatNumber: 'BE0000000097', roles: { customer: false, supplier: true }, address: { countryCode: 'BE' } })).data;
    const man = async (o) => (await c.post('/api/inbox/manual', { issueDate: '2026-09-01', net: '10.00', vat: '2.10', gross: '12.10', currency: 'EUR', ...o })).data.id;
    const recognised = await man({ supplierName: 'Fournisseur UI SRL', supplierVatNumber: 'BE0000000097', invoiceNumber: 'R-1' });
    const byName = await man({ supplierName: 'fournisseur ui srl', invoiceNumber: 'N-1', issueDate: '2026-08-01', gross: '99.00', net: '99.00', vat: '0.00' });
    const unknown = await man({ supplierName: 'Nouveau Fournisseur SA', invoiceNumber: 'U-1' });
    const possible = await man({ supplierName: 'Fournisseur UI SRL', supplierVatNumber: 'BE0000000097', invoiceNumber: 'R-2', issueDate: '2026-09-03' });
    const items = new Map(); for (const id of [recognised, byName, unknown, possible]) items.set(id, (await c.get(`/api/inbox/${id}`)).data);
    ui = loadUi(async (m, path) => { const it = items.get(path.split('/')[3]); if (it) return it; throw new Error(`unexpected ${m} ${path}`); });
    const blocks = async (id) => { const r = await render(ui, id); const one = (cls) => byClass(r.body, cls)[0];
      const text = (el) => (el ? el.textContent : null); const btns = (el) => (el ? byTag(el, 'button').map((b) => b.textContent) : []);
      return { supplier: text(one('doc-supplier')), supplierButtons: btns(one('doc-supplier')), dups: text(one('doc-dups')), dupButtons: btns(one('doc-dups')), linked: items.get(id).supplierCompanyId }; };
    let b = await blocks(recognised);
    assert.match(b.supplier, /Supplier recognised/); assert.match(b.supplier, /Fournisseur UI SRL/); assert.match(b.supplier, /Same VAT number · 99 %/);
    assert.deepEqual(b.supplierButtons, ['Confirm', 'Choose another contact']); assert.equal(b.linked, null, 'shown, never linked by itself');
    assert.match(b.dups, /Possible duplicate/, 'R-1 and R-2: same supplier, same total, 2 days apart');
    b = await blocks(byName); assert.match(b.supplier, /To confirm/); assert.match(b.supplier, /Same name · 80 %/); assert.match(b.dups, /None/); assert.deepEqual(b.dupButtons, []);
    b = await blocks(unknown); assert.match(b.supplier, /Unknown supplier/); assert.deepEqual(b.supplierButtons, ['Create this supplier', 'Choose another contact', 'Not now']);
    b = await blocks(possible);
    assert.match(b.dups, /Possible duplicate/); assert.match(b.dups, /R-1/); assert.match(b.dups, /same supplier · same type · same total incl\. VAT · close date · different number/);
    assert.match(b.dups, /Invoice numberR-2R-1/, 'the differences are listed: this document vs the other');
    assert.deepEqual(b.dupButtons, ['Open the other document', 'Not a duplicate', 'It is a duplicate: reject this document']);
    assert.equal(contact.id.length > 0, true);
  } finally { ui?.restore(); await a.close(); }
});
