// CAMT.053 imports on a REAL PostgreSQL 17 (disposable database): concurrent imports of the same movement store it ONCE,
// and two genuinely distinct movements that race are BOTH kept. Same storage contract as the app (ON CONFLICT on merchant, account, provider id).
// Synthetic data only. The duplicate guard BANK_POSSIBLE_DUPLICATE lives in the service layer (bank-service.js), not in the database: see the last control.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedMerchants, num, freshDatabase, race, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { control, expectedP0 } from './lib/classify.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };

// Same column mapping as supabase-store.js (bankTxToRow); the account is the CAMT account scope (account-tagged id), the source is the file source.
const insertMovement = (c, merchantId, { id, date = '2026-09-22', amountCents = 3000, currency = 'EUR', counterparty = 'Client Exemple SA', reference = 'INV-2026-0001', account = 'csv-import' }) =>
  c.query(`insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, amount_cents, currency, counterparty_name, reference, source, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'csv','NEW') on conflict (merchant_id, account_id, provider_tx_id) do nothing`,
  [merchantId, account, id, date, amountCents, currency, counterparty, reference]);

control('CONCURRENT SAME MOVEMENT: eight simultaneous imports of the same accepted movement store it ONCE; the others are no-ops', withDb(async (d) => {
  const clients = await Promise.all(Array.from({ length: 8 }, () => d.open()));
  try {
    const settled = await race(clients, (c) => insertMovement(c, MERCHANT_A, { id: 'acct1:REF-SAME' }));
    const failed = settled.filter((s) => s.status === 'rejected');
    const created = settled.filter((s) => s.status === 'fulfilled').reduce((n, s) => n + s.value.rowCount, 0);
    const stored = await num(clients[0], `select count(*) s from fin_bank_transactions where merchant_id='${MERCHANT_A}' and provider_tx_id='acct1:REF-SAME'`);
    const holds = failed.length === 0 && created === 1 && stored === 1;
    return { holds, evidence: `8 connections -> created=${created} stored=${stored} failed=${failed.length}` };
  } finally { await Promise.all(clients.map((c) => c.end())); }
}));

control('CONCURRENT DISTINCT MOVEMENTS: two real movements with the same date, amount and counterparty that race are BOTH kept (not merged)', withDb(async (d) => {
  const clients = await Promise.all([d.open(), d.open()]);
  try {
    const settled = await race(clients, (c, i) => insertMovement(c, MERCHANT_A, { id: i === 0 ? 'acct1:REF-A' : 'acct1:REF-B', reference: '' }));
    const created = settled.filter((s) => s.status === 'fulfilled').reduce((n, s) => n + s.value.rowCount, 0);
    const stored = await num(clients[0], `select count(*) s from fin_bank_transactions where merchant_id='${MERCHANT_A}'`);
    return { holds: created === 2 && stored === 2, evidence: `two distinct references -> created=${created} stored=${stored}` };
  } finally { await Promise.all(clients.map((c) => c.end())); }
}));

control('ISOLATION AT STORAGE: the same movement stored for merchant A and for merchant B is two rows, one per merchant, never a conflict', withDb(async (d) => {
  const [a, b] = await Promise.all([d.open(), d.open()]);
  try {
    const settled = await race([a, b], (c, i) => insertMovement(c, i === 0 ? MERCHANT_A : MERCHANT_B, { id: 'acct1:REF-ISO' }));
    const created = settled.filter((s) => s.status === 'fulfilled').reduce((n, s) => n + s.value.rowCount, 0);
    return { holds: created === 2, evidence: `A and B store the same id -> created=${created} (expected 2, one per merchant)` };
  } finally { await Promise.all([a.end(), b.end()]); }
}));

expectedP0('DUPLICATE GUARD LOCATION: the database has no twin constraint; BANK_POSSIBLE_DUPLICATE is enforced in the service layer only (evidence)', withDb(async (d) => {
  const c = await d.open();
  try {
    // Two stored twins (same merchant, account, date, amount, counterparty, different ids) are accepted by the database.
    await insertMovement(c, MERCHANT_A, { id: 'acct1:TWIN-1', reference: '' });
    await insertMovement(c, MERCHANT_A, { id: 'acct1:TWIN-2', reference: '' });
    const twins = await num(c, `select count(*) s from fin_bank_transactions where merchant_id='${MERCHANT_A}' and amount_cents=3000`);
    // Reported as a finding, not as a pass: the guard is NOT in SQL. It needs a status column or a constraint (migration), not done here.
    return { holds: false, evidence: `database accepted ${twins} identical twins: the BANK_POSSIBLE_DUPLICATE guard is in bank-service.js, not in SQL` };
  } finally { await c.end(); }
}));
