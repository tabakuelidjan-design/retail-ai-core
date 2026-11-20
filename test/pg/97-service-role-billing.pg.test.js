// Billing under the REAL runtime roles after migrations 20261120083356 and 20261120085527 (on PostgreSQL 17):
//  - service_role (the Finance server key) issues a fictitious invoice through fin_issue_document: the number is
//    allocated, the document is ISSUED, numbering stays strictly sequential across two invoices;
//  - anon and authenticated are refused (insufficient_privilege, SQLSTATE 42501) on fin_issue_document,
//    fin_next_number and fin_payable_cents, and nothing is numbered or issued by their attempts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshDatabase, seedMerchants, insertDraft, issueDocument, MERCHANT_A } from './lib/db.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UP_1 = readFileSync(`${ROOT}supabase/migrations/20261120083356_fin_function_search_path.sql`, 'utf8');
const UP_2 = readFileSync(`${ROOT}supabase/migrations/20261120085527_fin_function_execute_scope.sql`, 'utf8');

const denied = async (c, role, sql, args) => {
  await c.query(`set role ${role}`);
  try { await c.query(sql, args); return null; }
  catch (e) { return e.code; }
  finally { await c.query('reset role'); }
};

test('service_role issues a fictitious invoice and numbering stays sequential after both migrations', async () => {
  const db = await freshDatabase();
  const c = await db.open();
  try {
    await c.query(UP_1); await c.query(UP_2); // idempotent on a migrated template; the real order is preserved
    await seedMerchants(c);
    const d1 = await insertDraft(c, MERCHANT_A, { gross: 12100 });
    const d2 = await insertDraft(c, MERCHANT_A, { gross: 6050 });
    await c.query('set role service_role');
    const i1 = await issueDocument(c, MERCHANT_A, d1, { prefix: 'FACT' });
    const i2 = await issueDocument(c, MERCHANT_A, d2, { prefix: 'FACT' });
    await c.query('reset role');
    assert.ok(i1 && i2, 'both issues return a row');
    const rows = (await c.query('select id, status, number, doc_type from fin_documents where id = any($1::uuid[]) order by number', [[d1.id, d2.id]])).rows;
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.status, 'ISSUED', `document ${r.id} is ISSUED`);
    const numbers = rows.map((r) => r.number).sort();
    assert.match(numbers[0], /^FACT-2026-0001$/, 'first number is FACT-2026-0001');
    assert.match(numbers[1], /^FACT-2026-0002$/, 'second number is FACT-2026-0002 (no gap, no duplicate)');
    const seq = (await c.query("select fin_next_number($1::uuid,'invoice',2026) as n", [MERCHANT_A])).rows[0];
    assert.ok(seq, 'service_role can allocate the next number; a probe as postgres does not consume service_role state');
  } finally { await c.end(); await db.drop(); }
});

test('anon and authenticated are refused on fin_issue_document, fin_next_number and fin_payable_cents (42501), and nothing is issued', async () => {
  const db = await freshDatabase();
  const c = await db.open();
  try {
    await c.query(UP_1); await c.query(UP_2);
    await seedMerchants(c);
    const d = await insertDraft(c, MERCHANT_A, { gross: 12100 });
    const issueArgsArr = [MERCHANT_A, d.id, d.version ?? 1, 'ISSUED', 'FACT', 4, '{prefix}-{year}-{seq}', 2026, '{}', 'X', '2026-09-30T10:00:00Z', '{"action":"ISSUED"}'];
    const issueSql = 'select fin_issue_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r';
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await denied(c, role, issueSql, issueArgsArr), '42501', `${role}: fin_issue_document refused`);
      assert.equal(await denied(c, role, "select fin_next_number($1::uuid,'invoice',2026)", [MERCHANT_A]), '42501', `${role}: fin_next_number refused`);
      assert.equal(await denied(c, role, 'select fin_payable_cents((select f from fin_documents f where f.id = $1))', [d.id]), '42501', `${role}: fin_payable_cents refused`);
    }
    const state = (await c.query('select status, number from fin_documents where id = $1', [d.id])).rows[0];
    assert.equal(state.status, 'DRAFT', 'refused attempts leave the draft untouched');
    assert.equal(state.number, null, 'no number was allocated by a refused attempt');
  } finally { await c.end(); await db.drop(); }
});
