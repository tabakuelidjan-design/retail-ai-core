// PILOT v5: the reader role has exactly its read set (audited), and the issue role gains nothing from it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, seedMerchants, insertDraft, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { setupLogins, poolFor, LOGIN_A, dropPilotLogins } from './lib/pilot.js';

const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? e.message; } };
after(dropPilotLogins);

test('the reader audit is exact on a freshly migrated database', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    const rows = (await admin.query('select check_name, ok, detail from nordla_runtime.fin_pilot_reader_audit()')).rows;
    assert.deepEqual(rows.filter((r) => !r.ok).map((r) => `${r.check_name} :: ${r.detail}`), []);
    await admin.query("grant select on public.fin_bank_transactions to nordla_fin_reader_pilot");
    const extra = (await admin.query('select check_name, ok from nordla_runtime.fin_pilot_reader_audit() where not ok')).rows;
    assert.ok(extra.some((r) => /reader privileges/.test(r.check_name)), 'an extra read grant is reported');
    await admin.query("revoke select on public.fin_bank_transactions from nordla_fin_reader_pilot");
  } finally { await admin.end(); await db.drop(); }
});

test('the issue role gains nothing from the reader role: no commerce read, no reader table, no write on the reader tables', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  await setupLogins(db);
  const pool = poolFor(db, LOGIN_A);
  try {
    await seedMerchants(admin);
    await insertDraft(admin, MERCHANT_A, { gross: 12100 });
    const c = await pool.connect();
    // one transaction per check: a failed statement aborts its transaction
    const inRole = async (role, sql, params = []) => {
      await c.query('begin'); await c.query(`set local role ${role}`);
      try { return await codeOf(() => c.query(sql, params)); } finally { await c.query('rollback'); }
    };
    try {
      assert.equal(await inRole('nordla_fin_issuer_pilot', 'select count(*) from public.orders'), '42501', 'issue role cannot read orders');
      assert.equal(await inRole('nordla_fin_issuer_pilot', 'select count(*) from public.fin_bank_transactions'), '42501', 'issue role cannot read bank rows');
      assert.equal(await inRole('nordla_fin_reader_pilot', "insert into public.orders (id, merchant_id, source_system, source_id, ordered_at, currency, status, taxes_included) values (gen_random_uuid(), $1, 'x', 'y', now(), 'EUR', 'paid', true)", [MERCHANT_A]), '42501', 'reader cannot write orders');
      await c.query('begin'); await c.query('set local role nordla_fin_reader_pilot');
      assert.equal((await c.query('select count(*)::int n from public.fin_documents where merchant_id = $1', [MERCHANT_B])).rows[0].n, 0, 'reader sees no foreign rows');
      await c.query('rollback');
    } finally { c.release(); }
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});
