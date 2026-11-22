// CAMT.053 statement on a real PostgreSQL 17 (disposable database): the parser's rows are stored with the SAME contract as CSV rows.
// Covers: reimport adds nothing, two genuinely identical entries are two transactions, a mixed-currency statement is refused by the database,
// and a statement of one merchant never lands on another merchant's account. Synthetic statement only.
import { seedMerchants, num, freshDatabase, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { control } from './lib/classify.js';
import { parseCamt053 } from '../../src/finance/bank-camt053.js';
import { structuredCommunication } from '../../src/finance/pdf.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };
const ogm = structuredCommunication('INV-2026-0001');
const ntry = (amt, ind, date, ccy, ustrd, cp) => `<Ntry><Amt Ccy="${ccy}">${amt}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt><NtryDtls><TxDtls><RltdPties>${ind === 'CRDT' ? `<Dbtr><Nm>${cp}</Nm></Dbtr>` : `<Cdtr><Nm>${cp}</Nm></Cdtr>`}</RltdPties><RmtInf><Ustrd>${ustrd}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
const statement = (...ntries) => `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>BE68539007547034</IBAN></Id><Ccy>EUR</Ccy></Acct>${ntries.join('')}</Stmt></BkToCstmrStmt></Document>`;
const EUR_FILE = statement(
  ntry('71.90', 'CRDT', '2026-09-22', 'EUR', `facture ${ogm}`, 'Client Exemple SA'),
  ntry('71.90', 'CRDT', '2026-09-22', 'EUR', `facture ${ogm}`, 'Client Exemple SA'), // genuinely identical to the first one
  ntry('20.00', 'DBIT', '2026-09-23', 'EUR', 'achat fournitures', 'Fournisseur Exemple SRL'));
const USD_LINE = statement(ntry('5.00', 'CRDT', '2026-09-24', 'USD', 'payment in dollars', 'Client Exemple SA'));

// Same column mapping as supabase-store.js (bankTxToRow): one row per parsed transaction, the id is the provider_tx_id.
const insertRow = (c, merchantId, r) => c.query(
  `insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, value_date, amount_cents, currency, counterparty_name, reference, structured_reference, source, status, fingerprint)
   values ($1,'csv-import',$2,$3,$4,$5,$6,$7,$8,$9,'csv','NEW',$10) on conflict (merchant_id, account_id, provider_tx_id) do nothing`,
  [merchantId, r.id, r.date, r.valueDate, r.amountCents, r.currency, r.counterpartyName, r.reference, r.structuredReference, r.fingerprint]);

control('CAMT ROWS: the parser output is stored with the CSV contract; identical entries are two rows; reimport adds nothing', withDb(async (d) => {
  const c = await d.open();
  try {
    const parsed = parseCamt053(EUR_FILE);
    const ids = parsed.rows.map((r) => r.id);
    const first = await Promise.all(parsed.rows.map((r) => insertRow(c, MERCHANT_A, r)));
    const created = first.reduce((n, x) => n + x.rowCount, 0);
    const again = await Promise.all(parsed.rows.map((r) => insertRow(c, MERCHANT_A, r)));
    const reimported = again.reduce((n, x) => n + x.rowCount, 0);
    const stored = await num(c, `select count(*) s from fin_bank_transactions where merchant_id='${MERCHANT_A}'`);
    const distinctIds = new Set(ids).size;
    const holds = created === 3 && reimported === 0 && stored === 3 && distinctIds === 3;
    return { holds, evidence: `created=${created} reimported=${reimported} stored=${stored} distinct=${distinctIds} ids=${ids.join(' / ')}` };
  } finally { await c.end(); }
}));

control('CAMT CURRENCY: a statement with a foreign currency is refused by the database (account currency), nothing from it is stored', withDb(async (d) => {
  const c = await d.open();
  try {
    await insertRow(c, MERCHANT_A, parseCamt053(EUR_FILE).rows[0]); // the account is created in EUR on first sight
    const usd = parseCamt053(USD_LINE).rows[0];
    let refused = null; try { await insertRow(c, MERCHANT_A, usd); } catch (e) { refused = e.message; }
    const stored = await num(c, `select count(*) s from fin_bank_transactions where merchant_id='${MERCHANT_A}' and currency='USD'`);
    const holds = !!refused && /FIN_BANK_CURRENCY_MISMATCH/.test(refused) && stored === 0;
    const firstLine = refused ? refused.split('\n')[0] : 'NOT REFUSED';
    return { holds, evidence: `refused=${firstLine} usdStored=${stored}` };
  } finally { await c.end(); }
}));

control('CAMT ISOLATION: the same statement for merchant B creates B\'s own account and never touches merchant A\'s rows', withDb(async (d) => {
  const c = await d.open();
  try {
    const r = parseCamt053(EUR_FILE).rows[0];
    await insertRow(c, MERCHANT_A, r); await insertRow(c, MERCHANT_B, r);
    const accounts = await num(c, "select count(*) s from fin_bank_accounts where external_id='csv-import'");
    const aRows = await num(c, `select count(*) s from fin_bank_transactions where merchant_id='${MERCHANT_A}'`);
    const bRows = await num(c, `select count(*) s from fin_bank_transactions where merchant_id='${MERCHANT_B}'`);
    return { holds: accounts === 2 && aRows === 1 && bRows === 1, evidence: `accounts=${accounts} A=${aRows} B=${bRows}` };
  } finally { await c.end(); }
}));
