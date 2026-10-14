// Phase 0 - CONTROLS: protections the database already provides today. They must hold (a failure here is a regression or a bench problem, not a known P0).
import { test } from 'node:test';
import { freshDatabase, openMany, race, seedMerchants, insertDraft, issueDocument, issueSql, issueArgs, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { control } from './lib/classify.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };

control('CONCURRENT ISSUE: 8 connections issue the SAME draft -> exactly one wins', withDb(async (d) => {
  const setup = await d.open(); const doc = await insertDraft(setup, MERCHANT_A); await setup.end();
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c) => c.query(issueSql, issueArgs(MERCHANT_A, doc)));
    const won = res.filter((r) => r.status === 'fulfilled'); const lost = res.filter((r) => r.status === 'rejected');
    const nums = (await clients[0].query("select number from fin_documents where merchant_id=$1 and number is not null", [MERCHANT_A])).rows.map((r) => r.number);
    const lostOk = lost.every((r) => /FIN_CONCURRENT_MODIFICATION/.test(r.reason.message));
    return { holds: won.length === 1 && lostOk && nums.length === 1, evidence: `winners=${won.length}, losers=${lost.length} (all FIN_CONCURRENT_MODIFICATION=${lostOk}), numbers allocated=${JSON.stringify(nums)}` };
  } finally { await closeAll(); }
}));

control('CONCURRENT ISSUE: 8 connections issue 8 DIFFERENT drafts -> unique, gapless numbers', withDb(async (d) => {
  const setup = await d.open(); const docs = []; for (let i = 0; i < 8; i++) docs.push(await insertDraft(setup, MERCHANT_A)); await setup.end();
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c, i) => c.query(issueSql, issueArgs(MERCHANT_A, docs[i])));
    const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value.rows[0].r.number).sort();
    const expected = Array.from({ length: 8 }, (_, i) => `FACT-2026-${String(i + 1).padStart(4, '0')}`);
    return { holds: JSON.stringify(ok) === JSON.stringify(expected), evidence: `numbers: ${ok.join(', ')}` };
  } finally { await closeAll(); }
}));

control('CONCURRENT ISSUE: numbering is per merchant (A and B issue at the same time)', withDb(async (d) => {
  const setup = await d.open(); const a = await insertDraft(setup, MERCHANT_A); const b = await insertDraft(setup, MERCHANT_B); await setup.end();
  const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const res = await race(clients, (c, i) => c.query(issueSql, issueArgs(i ? MERCHANT_B : MERCHANT_A, i ? b : a)));
    const nums = res.map((r) => r.status === 'fulfilled' ? r.value.rows[0].r.number : 'ERR');
    return { holds: nums[0] === 'FACT-2026-0001' && nums[1] === 'FACT-2026-0001', evidence: `A=${nums[0]} B=${nums[1]}` };
  } finally { await closeAll(); }
}));

control('ISOLATION: another merchant cannot issue my document', withDb(async (d) => {
  const c = await d.open(); const doc = await insertDraft(c, MERCHANT_A);
  try { await c.query(issueSql, issueArgs(MERCHANT_B, doc)); return { holds: false, evidence: 'merchant B issued the document of merchant A' }; }
  catch (e) { return { holds: /FIN_NOT_FOUND/.test(e.message), evidence: e.message.split('\n')[0] }; } finally { await c.end(); }
}));

control('ROLLBACK: a failed issue (audit event without action) burns no number', withDb(async (d) => {
  const c = await d.open(); const bad = await insertDraft(c, MERCHANT_A); const good = await insertDraft(c, MERCHANT_A);
  const args = issueArgs(MERCHANT_A, bad); args[11] = '{}';
  let refused = false; try { await c.query(issueSql, args); } catch { refused = true; }
  const r = await issueDocument(c, MERCHANT_A, good); await c.end();
  return { holds: refused && r.number === 'FACT-2026-0001', evidence: `failed issue refused=${refused}; next number=${r.number} (no gap)` };
}));

control('IMMUTABILITY: an issued document and append-only ledgers refuse edits', withDb(async (d) => {
  const c = await d.open(); const doc = await insertDraft(c, MERCHANT_A); const issued = await issueDocument(c, MERCHANT_A, doc);
  const attempts = [['edit gross', 'update fin_documents set gross_cents=1 where id=$1'], ['delete issued', 'delete from fin_documents where id=$1'], ['edit event', 'update fin_events set action=\'X\' where document_id=$1'], ['delete event', 'delete from fin_events where document_id=$1']];
  const out = []; for (const [n, sql] of attempts) { try { await c.query(sql, [issued.id]); out.push(`${n}: ACCEPTED`); } catch { out.push(`${n}: refused`); } }
  await c.end(); return { holds: out.every((x) => x.endsWith('refused')), evidence: out.join('; ') };
}));

control('IDEMPOTENT IMPORT: 8 connections import the same bank transaction -> one row', withDb(async (d) => {
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c) => c.query(`insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, amount_cents, currency, source) values ($1,'csv-import','tx-1','2026-09-01',-1210,'EUR','csv')`, [MERCHANT_A]));
    const ok = res.filter((r) => r.status === 'fulfilled').length; const n = (await clients[0].query('select count(*)::int n from fin_bank_transactions')).rows[0].n;
    return { holds: ok === 1 && n === 1, evidence: `accepted=${ok}, rows=${n}` };
  } finally { await closeAll(); }
}));

control('IDEMPOTENT INTAKE: 8 connections register the same supplier file hash -> one row', withDb(async (d) => {
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c) => c.query(`insert into fin_supplier_invoices (merchant_id, status, sha256) values ($1,'RECEIVED','abc')`, [MERCHANT_A]));
    const ok = res.filter((r) => r.status === 'fulfilled').length; return { holds: ok === 1, evidence: `accepted=${ok}` };
  } finally { await closeAll(); }
}));

control('PERMISSIONS/RLS: anon sees no Finance row and cannot call the issue RPC, even with data present', withDb(async (d) => {
  const c = await d.open(); const doc = await insertDraft(c, MERCHANT_A);
  await c.query('set role anon');
  const read = (await c.query('select count(*)::int n from fin_documents')).rows[0].n;
  let wrote = true; try { await c.query("insert into fin_events (merchant_id, action) values ($1,'X')", [MERCHANT_A]); } catch { wrote = false; }
  let issued = true; try { await c.query(issueSql, issueArgs(MERCHANT_A, doc)); } catch { issued = false; }
  await c.query('reset role'); await c.end();
  return { holds: read === 0 && !wrote && !issued, evidence: `anon rows visible=${read}, anon write accepted=${wrote}, anon issue accepted=${issued}` };
}));

control('PERMISSIONS: service_role (what the Finance service uses) works end to end', withDb(async (d) => {
  const c = await d.open(); const doc = await insertDraft(c, MERCHANT_A);
  await c.query('set role service_role'); let ok = true; let why = ''; try { await c.query(issueSql, issueArgs(MERCHANT_A, doc)); } catch (e) { ok = false; why = e.message; }
  await c.query('reset role'); await c.end(); return { holds: ok, evidence: `service_role issue accepted=${ok} ${why}` };
}));
