import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parseCamt053 } from '../src/finance/bank-camt053.js';
import { startApp, invoiceBody } from './finance-dashboard-helpers.js';
import { structuredCommunication } from '../src/finance/pdf.js';

// CAMT.053 adapter: same import contract as the CSV parser. SYNTHETIC XML only; the element layout is NOT verified against a real Belgian bank export.
const KEY = randomBytes(32);
const entry = ({ amt = '71.90', ccy = 'EUR', ind = 'CRDT', date = '2026-09-22', sts = 'BOOK', ref = null, ustrd = '', cp = 'Client Exemple SA', strd = '' } = {}) => `
  <Ntry>
    ${ref ? `<AcctSvcrRef>${ref}</AcctSvcrRef>` : ''}
    <Amt Ccy="${ccy}">${amt}</Amt>
    <CdtDbtInd>${ind}</CdtDbtInd>
    <Sts>${sts}</Sts>
    <BookgDt><Dt>${date}</Dt></BookgDt>
    <ValDt><Dt>${date}</Dt></ValDt>
    <NtryDtls><TxDtls>
      <RltdPties>${ind === 'CRDT' ? `<Dbtr><Nm>${cp}</Nm></Dbtr>` : `<Cdtr><Nm>${cp}</Nm></Cdtr>`}</RltdPties>
      <RmtInf>${strd}${ustrd ? `<Ustrd>${ustrd}</Ustrd>` : ''}</RmtInf>
    </TxDtls></NtryDtls>
  </Ntry>`;
const doc = (...entries) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
  <Acct><Id><IBAN>BE68539007547034</IBAN></Id><Ccy>EUR</Ccy></Acct>${entries.join('')}
</Stmt></BkToCstmrStmt></Document>`;
const ogmOf = (number) => structuredCommunication(number);

test('CAMT: entries become rows with the CSV contract: signed integer cents, currency, date, counterparty, structured reference', () => {
  const r = parseCamt053(doc(entry({ ustrd: `${ogmOf('INV-2026-0001')}` }), entry({ amt: '12.50', ind: 'DBIT', date: '2026-09-23', cp: 'Fournisseur X', ustrd: 'frais' })));
  assert.equal(r.rows.length, 2); assert.equal(r.errors.length, 0);
  const [cr, db] = r.rows;
  assert.equal(cr.amountCents, 7190); assert.equal(cr.currency, 'EUR'); assert.equal(cr.date, '2026-09-22'); assert.equal(cr.counterpartyName, 'Client Exemple SA');
  assert.equal(cr.structuredReference, ogmOf('INV-2026-0001').replace(/\D/g, ''));
  assert.equal(db.amountCents, -1250); assert.equal(db.counterpartyName, 'Fournisseur X'); assert.equal(db.structuredReference, null);
  assert.deepEqual(r.period, { from: '2026-09-22', to: '2026-09-23' });
  for (const k of ['id', 'line', 'date', 'amountCents', 'currency', 'counterpartyName', 'reference', 'structuredReference']) assert.ok(k in cr, `contract field ${k}`);
});

test('CAMT: a booking TIMESTAMP becomes the merchant civil date (Europe/Brussels), never a truncated string', () => {
  const xml = doc(entry({ amt: '9.00' }).replace('<BookgDt><Dt>2026-09-22</Dt></BookgDt>', '<BookgDt><DtTm>2026-09-22T23:30:00Z</DtTm></BookgDt>'));
  assert.equal(parseCamt053(xml).rows[0].date, '2026-09-23', '23:30 UTC on 22 Sep is 01:30 on 23 Sep in Brussels (CEST)');
});

test('CAMT: not-booked entries, invalid amounts, unknown direction are reported per line, never dropped silently', () => {
  const r = parseCamt053(doc(entry({ sts: 'PDNG' }), entry({ amt: '71,90' }), entry({ ind: 'XXX' }), entry({ amt: '1.234' }), entry({})));
  assert.deepEqual(r.errors.map((e) => e.reason), ['NOT_BOOKED', 'AMOUNT_INVALID', 'DIRECTION_INVALID', 'AMOUNT_INVALID']);
  assert.equal(r.rows.length, 1);
});

test('CAMT: identical entries inside one file are two transactions ("#2"); a unique AcctSvcrRef is the id when every entry has one', () => {
  const twins = parseCamt053(doc(entry({ amt: '25.00', cp: 'Boutique X' }), entry({ amt: '25.00', cp: 'Boutique X' })));
  assert.equal(twins.rows.length, 2); assert.notEqual(twins.rows[0].id, twins.rows[1].id); assert.ok(twins.rows[1].id.endsWith('#2'));
  const withRefs = parseCamt053(doc(entry({ ref: 'R1' }), entry({ ref: 'R2', amt: '5.00' })));
  assert.deepEqual(withRefs.rows.map((r) => r.id), ['R1', 'R2']); assert.equal(withRefs.columns.id, 'AcctSvcrRef');
  // the same file parsed twice gives the same ids (idempotent reimport)
  assert.deepEqual(parseCamt053(doc(entry({ amt: '25.00' }))).rows[0].id, parseCamt053(doc(entry({ amt: '25.00' }))).rows[0].id);
});

test('CAMT SAFETY: a DOCTYPE or ENTITY is refused outright; malformed or empty input is refused; the size is capped', () => {
  const bomb = `<?xml version="1.0"?><!DOCTYPE Document [<!ENTITY x SYSTEM "file:///etc/passwd">]><Document>${entry({})}</Document>`;
  assert.throws(() => parseCamt053(bomb), (e) => e.code === 'BANK_CAMT_REFUSED' && /DOCTYPE/.test(e.message));
  assert.throws(() => parseCamt053('<Document><Ntry>'), (e) => e.code === 'BANK_CAMT_REFUSED');
  assert.throws(() => parseCamt053('   '), (e) => e.code === 'BANK_CAMT_EMPTY');
  assert.throws(() => parseCamt053(doc()), (e) => e.code === 'BANK_CAMT_NO_ENTRIES');
  assert.throws(() => parseCamt053('<Document>' + 'x'.repeat(2_100_000) + '</Document>'), (e) => e.code === 'BANK_CAMT_TOO_LARGE');
});

test('CAMT through the server: import with the same contract, reimport adds nothing, a structured reference gives an EXACT suggestion, a bad file stores nothing', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const d = (await c.post('/api/documents', invoiceBody({}))).data; await c.post(`/api/documents/${d.id}/submit`, {}); assert.equal((await c.post(`/api/documents/${d.id}/approve`, {})).status, 200);
    const number = (await c.get(`/api/documents/${d.id}`)).data.number;
    const xml = doc(entry({ ustrd: ogmOf(number) }), entry({ amt: '3.00', ind: 'DBIT', cp: 'Fournisseur X' }));
    const pv = await c.post('/api/bank/import-csv/preview', { csv: xml, format: 'camt053' }); assert.equal(pv.status, 200, JSON.stringify(pv.data)); assert.equal(pv.data.importable, 2);
    const imp = await c.post('/api/bank/import-csv', { csv: xml, format: 'camt053' }); assert.equal(imp.status, 200, JSON.stringify(imp.data)); assert.equal(imp.data.created, 2);
    const again = await c.post('/api/bank/import-csv', { csv: xml, format: 'camt053' }); assert.equal(again.data.created, 0); assert.equal(again.data.duplicates, 2);
    const inTx = (await c.get('/api/bank/transactions')).data.rows.find((t) => t.amountCents === 7190);
    const s = (await c.get('/api/bank/suggestions')).data.rows.find((x) => x.transactionId === inTx.id);
    assert.equal(s.status, 'EXACT', JSON.stringify(s));
    const bad = await c.post('/api/bank/import-csv', { csv: '<!DOCTYPE x [<!ENTITY e SYSTEM "x">]><Document/>', format: 'camt053' }); assert.ok(bad.status >= 400);
    assert.equal((await c.get('/api/bank/transactions')).data.rows.length, 2, 'a refused file stores nothing');
  } finally { await a.close(); }
});

// --- Hardening added on the branch (synthetic only) ---
import { suggestForCredit, suggestForDebit } from '../src/finance/reconcile.js';

test('CAMT: a reversal (RvslInd) is refused per line, never guessed into a movement', () => {
  const xml = doc(entry({ amt: '10.00', ind: 'CRDT' }).replace('<Sts>BOOK</Sts>', '<Sts>BOOK</Sts><RvslInd>true</RvslInd>'));
  const r = parseCamt053(xml);
  assert.equal(r.rows.length, 0); assert.equal(r.errors.length, 1); assert.equal(r.errors[0].reason, 'REVERSAL_NOT_SUPPORTED');
});

test('CAMT: a document that is not camt.053 (wrong namespace or root) is refused', () => {
  const pain = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn/></Document>';
  assert.throws(() => parseCamt053(pain), (e) => e.code === 'BANK_CAMT_REFUSED' && e.detail === 'NOT_CAMT053');
  const wrongRoot = '<?xml version="1.0"?><Other xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><Ntry><Amt Ccy="EUR">1.00</Amt></Ntry></Other>';
  assert.throws(() => parseCamt053(wrongRoot), (e) => e.code === 'BANK_CAMT_REFUSED' && e.detail === 'NOT_CAMT053');
});

test('CAMT: the account is identified by its IBAN MASKED only; the full number is never returned', () => {
  const r = parseCamt053(doc(entry()));
  assert.equal(r.account.ibanMasked, 'BE68 **** **** 7034');
  assert.ok(!JSON.stringify(r).includes('BE68539007547034'), 'the full IBAN appears nowhere in the parsed result');
});

test('CAMT: a net payout (Shopify/SumUp-like, one credit) never proposes an arbitrary invoice of the same amount', () => {
  const payout = parseCamt053(doc(entry({ amt: '1000.00', cp: 'Shopify Payments' }))).rows[0];
  const openInvoices = [{ documentId: 'd1', number: 'INV-2026-0001', customer: 'Client Exemple SA', remainingCents: 100000, currency: 'EUR' }];
  const s = suggestForCredit({ ...payout, reference: payout.reference }, openInvoices);
  assert.notEqual(s.status, 'EXACT', 'a payout is never EXACT against an unrelated invoice');
  assert.notEqual(s.status, 'PROBABLE', 'a payout is never PROBABLE without a reference or a matching customer name');
});

test('CAMT: a payment in another currency than the document never matches, even with the exact reference', () => {
  const usd = parseCamt053(doc(entry({ amt: '71.90', ccy: 'USD', ustrd: 'facture INV-2026-0001' }))).rows[0];
  const s = suggestForCredit(usd, [{ documentId: 'd1', number: 'INV-2026-0001', customer: 'Client Exemple SA', remainingCents: 7190, currency: 'EUR' }]);
  assert.equal(s.status, 'NO_MATCH');
  assert.ok(suggestForDebit({ ...usd, amountCents: -7190 }, [{ itemId: 'p1', invoiceNumber: 'INV-2026-0001', supplierName: 'X', grossCents: 7190, currency: 'EUR' }]).status === 'NO_MATCH');
});

// --- Cross-format duplicates and batch entries (synthetic only) ---
import { classifyIncoming, movementKey } from '../src/finance/bank-identity.js';

const csvBank = (rows) => ['Id;Date;Montant;Contrepartie;Communication', ...rows].join('\n');
const camtRef = (ref, amt, date, cp, ustrd) => doc(entry({ amt, date, cp, ustrd, ref }));
const batchEntry = (amt, refs, cps) => `<Ntry><Amt Ccy="EUR">${amt}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-22</Dt></BookgDt>
  <NtryDtls>${refs.map((r, i) => `<TxDtls><Amt Ccy="EUR">${cps[i].amt}</Amt><RltdPties><Dbtr><Nm>${cps[i].name}</Nm></Dbtr></RltdPties><RmtInf><Strd><CdtrRefInf><Ref>${r}</Ref></CdtrRefInf></Strd></RmtInf></TxDtls>`).join('')}</NtryDtls></Ntry>`;

test('IDENTITY (unit): same reliable reference = known; same movement without reference = possible duplicate, kept; distinct references = two movements', () => {
  const stored = [{ providerTxId: 'R1', bankReference: 'R1', date: '2026-09-22', amountCents: 7190, currency: 'EUR', reference: 'INV 2026 0001', counterpartyName: 'Client A' }];
  const same = classifyIncoming([{ id: 'R1', line: 1, bankReference: 'R1', date: '2026-09-22', amountCents: 7190, currency: 'EUR', reference: 'INV-2026-0001', counterpartyName: 'Client A' }], stored);
  assert.equal(same.known, 1); assert.equal(same.kept.length, 0, 'the same bank reference is not stored again');
  const noRef = classifyIncoming([{ id: 'fp1', line: 1, bankReference: null, date: '2026-09-22', amountCents: 7190, currency: 'EUR', reference: 'INV-2026-0001', counterpartyName: 'Client A' }], stored);
  assert.equal(noRef.kept.length, 0, 'a suspected duplicate is NOT stored by default'); assert.equal(noRef.possible.length, 1, 'it is held and reported'); assert.equal(noRef.possible[0].reason, 'NO_RELIABLE_BANK_REFERENCE'); assert.equal(noRef.possible[0].stored, true, 'storable only on explicit acceptance');
  const other = classifyIncoming([{ id: 'R2', line: 1, bankReference: 'R2', date: '2026-09-22', amountCents: 7190, currency: 'EUR', reference: 'INV-2026-0001', counterpartyName: 'Client A' }], stored);
  assert.equal(other.kept.length, 1, 'two different bank references: two movements, both kept'); assert.equal(other.possible.length, 0, 'and not flagged: the bank says they differ');
  assert.equal(movementKey({ ...stored[0], reference: 'inv 2026-0001!' }), movementKey(stored[0]), 'case, accents and punctuation do not change the identity');
});

test('CROSS-FORMAT with reliable references, CSV then CAMT.053: the same movement is stored ONCE; the other movement of the statement is stored', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const csv = csvBank(['BANK-REF-1;22/09/2026;71,90;Client Exemple SA;INV-2026-0001']);
    const first = await c.post('/api/bank/import-csv', { csv }); assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.created, 1);
    const xml = doc(entry({ amt: '71.90', ref: 'BANK-REF-1', ustrd: 'INV-2026-0001', cp: 'Client Exemple SA', date: '2026-09-22' }), entry({ amt: '3.00', ind: 'DBIT', ref: 'BANK-REF-2', cp: 'Fournisseur X', date: '2026-09-23' }));
    const second = await c.post('/api/bank/import-csv', { csv: xml, format: 'camt053' }); assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.created, 1); assert.equal(second.data.duplicates, 1); assert.equal(second.data.possibleDuplicates, undefined);
    assert.equal((await c.get('/api/bank/transactions')).data.rows.filter((t) => t.amountCents === 7190).length, 1);
  } finally { await a.close(); }
});

test('CROSS-FORMAT with reliable references, CAMT.053 then CSV: stored ONCE', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const xml = doc(entry({ amt: '71.90', ref: 'BANK-REF-1', ustrd: 'INV-2026-0001', cp: 'Client Exemple SA', date: '2026-09-22' }));
    assert.equal((await c.post('/api/bank/import-csv', { csv: xml, format: 'camt053' })).data.created, 1);
    const again = await c.post('/api/bank/import-csv', { csv: csvBank(['BANK-REF-1;22/09/2026;71,90;Client Exemple SA;INV-2026-0001']) });
    assert.equal(again.status, 200, JSON.stringify(again.data)); assert.equal(again.data.created, 0); assert.equal(again.data.duplicates, 1);
  } finally { await a.close(); }
});

test('CROSS-FORMAT without a reliable reference: the same-looking movement is IMPORTED and REPORTED for a manual check, never dropped', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const csv = ['Date;Montant;Contrepartie;Communication', '22/09/2026;71,90;Client Exemple SA;INV-2026-0001'].join('\n');
    assert.equal((await c.post('/api/bank/import-csv', { csv })).data.created, 1);
    const xml = doc(entry({ amt: '71.90', ustrd: 'INV-2026-0001', cp: 'Client Exemple SA', date: '2026-09-22' }));
    const pv = await c.post('/api/bank/import-csv/preview', { csv: xml, format: 'camt053' }); assert.equal(pv.status, 200, JSON.stringify(pv.data));
    assert.equal(pv.data.possibleDuplicates.length, 1, 'the preview shows the possible duplicate before any import');
    const imp = await c.post('/api/bank/import-csv', { csv: xml, format: 'camt053' }); assert.equal(imp.status, 200, JSON.stringify(imp.data));
    assert.equal(imp.data.created, 0, 'held: not stored by default');
    assert.equal(imp.data.possibleDuplicates.length, 1);
    const acc = await c.post('/api/bank/import-csv', { csv: xml, format: 'camt053', acceptPossibleDuplicates: true });
    assert.equal(acc.data.created, 1, 'stored only after the merchant accepts it explicitly');
  } finally { await a.close(); }
});

test('IDENTICAL-LOOKING distinct movements (same date, amount, counterparty, distinct bank references) are both kept', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const one = doc(entry({ amt: '10.00', ref: 'REF-A', cp: 'Client Exemple SA', date: '2026-09-22' }));
    const two = doc(entry({ amt: '10.00', ref: 'REF-B', cp: 'Client Exemple SA', date: '2026-09-22' }));
    assert.equal((await c.post('/api/bank/import-csv', { csv: one, format: 'camt053' })).data.created, 1);
    const r2 = await c.post('/api/bank/import-csv', { csv: two, format: 'camt053' });
    assert.equal(r2.data.created, 1, 'both movements are real and both are kept'); assert.equal(r2.data.possibleDuplicates, undefined);
  } finally { await a.close(); }
});

test('BATCH: several TxDtls keep the bank amount; one creditor reference is used, two different ones are not guessed', () => {
  const same = structuredCommunication('INV-2026-0001');
  const one = parseCamt053(doc(batchEntry('25.00', [same, same], [{ amt: '10.00', name: 'Client A' }, { amt: '15.00', name: 'Client A' }])));
  assert.equal(one.rows[0].amountCents, 2500, 'the entry amount is the bank truth');
  assert.ok(one.rows[0].structuredReference && one.rows[0].structuredReference.length === 12, 'one creditor reference: used');
  const two = parseCamt053(doc(batchEntry('25.00', [structuredCommunication('INV-2026-0001'), structuredCommunication('INV-2026-0002')], [{ amt: '10.00', name: 'Client A' }, { amt: '15.00', name: 'Client B' }])));
  assert.equal(two.rows[0].structuredReference, null, 'two different creditor references: none is guessed');
  assert.equal(two.batches.length, 1); assert.equal(two.batches[0].txCount, 2); assert.equal(two.batches[0].detailSumCents, 2500); assert.equal(two.batches[0].consistent, true);
});

test('BATCH: a detail that does not add up to the entry is reported, the entry is not silently changed', () => {
  const r = parseCamt053(doc(batchEntry('30.00', ['000000000000', '000000000000'], [{ amt: '10.00', name: 'A' }, { amt: '15.00', name: 'A' }])));
  assert.equal(r.rows[0].amountCents, 3000); assert.equal(r.batches[0].consistent, false); assert.equal(r.batches[0].detailSumCents, 2500);
});

test('FORMAT: an unknown statement format is refused, never read as CSV', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const r = await c.post('/api/bank/import-csv', { csv: doc(entry()), format: 'CAMT053' });
    assert.ok(r.status >= 400, 'an unknown format is refused');
    assert.match(JSON.stringify(r.data), /BANK_STATEMENT_FORMAT_UNSUPPORTED/);
    assert.equal((await c.get('/api/bank/transactions')).data.rows.length, 0, 'nothing stored');
  } finally { await a.close(); }
});

test('CONFLICT: the same bank reference with a DIFFERENT amount is never stored over the first and never silently dropped: reported, not stored', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    assert.equal((await c.post('/api/bank/import-csv', { csv: csvBank(['BANK-REF-9;22/09/2026;71,90;Client Exemple SA;INV-2026-0001']) })).data.created, 1);
    const xml = doc(entry({ amt: '80.00', ref: 'BANK-REF-9', ustrd: 'INV-2026-0001', cp: 'Client Exemple SA', date: '2026-09-22' }));
    const r = await c.post('/api/bank/import-csv', { csv: xml, format: 'camt053' }); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.created, 0, 'not stored over the existing reference');
    assert.equal(r.data.possibleDuplicates.length, 1); assert.equal(r.data.possibleDuplicates[0].reason, 'SAME_ID_OTHER_MOVEMENT'); assert.equal(r.data.possibleDuplicates[0].stored, false);
  } finally { await a.close(); }
});

// --- Financial safety: a suspected duplicate must not become a second confirmed payment by default ---
test('DOUBLE-COUNT GUARD: a suspected duplicate without a reliable reference is HELD, not stored, so it cannot be confirmed as a second payment', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const d = (await c.post('/api/documents', invoiceBody({}))).data; await c.post(`/api/documents/${d.id}/submit`, {}); assert.equal((await c.post(`/api/documents/${d.id}/approve`, {})).status, 200);
    const number = (await c.get(`/api/documents/${d.id}`)).data.number;
    const csv = ['Date;Montant;Contrepartie;Communication', `22/09/2026;30,00;Client Exemple SA;${number}`].join('\n');
    assert.equal((await c.post('/api/bank/import-csv', { csv })).data.created, 1, 'the first movement is stored');
    const xml = doc(entry({ amt: '30.00', ustrd: number, cp: 'Client Exemple SA', date: '2026-09-22' }));
    const again = await c.post('/api/bank/import-csv', { csv: xml, format: 'camt053' }); assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.created, 0, 'the suspected duplicate is NOT stored by default');
    assert.equal(again.data.possibleDuplicates.length, 1, 'and it is reported for a manual decision');
    const rows = (await c.get('/api/bank/transactions')).data.rows.filter((t) => t.amountCents === 3000);
    assert.equal(rows.length, 1, 'only one bank movement of 30.00 exists to be confirmed');
  } finally { await a.close(); }
});
