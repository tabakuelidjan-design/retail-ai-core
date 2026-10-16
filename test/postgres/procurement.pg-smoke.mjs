// REAL PostgreSQL smoke test of supabase/migrations-pending/20261016090000_procurement_stock.sql. No simulation, no production data:
// it starts a THROWAWAY postgres container, applies the phase-1 schema (for `merchants`) and the procurement migration, then proves with real SQL
// the guarantees the migration claims: append-only ledger, non-negative balances, reserved <= on-hand, tenant-composite keys, legal PO transitions,
// single-use approvals, idempotency keys, a two-session race, and that the down script really reverses the migration.
//
//   node test/postgres/procurement.pg-smoke.mjs        (needs Docker; not part of `npm test`)
//
// Exit code 0 only if every check passes. KEEP_PG_SMOKE=1 keeps the container. PG_SMOKE_IMAGE overrides the image (default postgres:17).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NAME = 'nordla-pg-smoke-procurement';
const IMAGE = process.env.PG_SMOKE_IMAGE ?? 'postgres:17';
const results = [];
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8' });
if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('STOP: Docker is required (a real PostgreSQL, no in-memory substitute).'); process.exit(2); }

const psqlArgs = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const sql = (text) => { const r = docker(psqlArgs, text); return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
const sqlAsync = (text) => new Promise((resolve) => {
  const p = spawn('docker', psqlArgs); let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() })); p.stdin.end(text);
});
const check = (name, cond, detail = '') => { results.push({ name, ok: Boolean(cond) }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail}`}`); };
const mustOk = (name, r) => check(name, r.ok, r.err);
const mustFail = (name, r, pattern) => check(name, !r.ok && pattern.test(r.err), r.ok ? 'it succeeded' : r.err);
const sleepMs = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);

docker(['rm', '-f', NAME]);
const run = docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=smoke', IMAGE]);
if (run.status !== 0) { console.error(run.stderr); process.exit(2); }
try {
  const readyCount = () => { const r = docker(['logs', NAME]); return ((r.stdout ?? '') + (r.stderr ?? '')).split('database system is ready to accept connections').length - 1; };
  for (let i = 0; i < 60 && readyCount() < 2; i += 1) sleepMs(1000); // init server, then the final server
  for (let i = 0; i < 30 && !sql('select 1').ok; i += 1) sleepMs(1000);

  const up = readFileSync(`${ROOT}supabase/migrations-pending/20261016090000_procurement_stock.sql`, 'utf8');
  const down = readFileSync(`${ROOT}supabase/rollback/20261016090000_procurement_stock.down.sql`, 'utf8');
  const phase1 = readFileSync(`${ROOT}supabase/migrations/20260920132005_phase1_schema.sql`, 'utf8');
  mustOk('phase-1 schema (merchants) applies', sql(`begin;\n${phase1}\ncommit;`));
  mustOk('procurement migration applies in one transaction', sql(`begin;\n${up}\ncommit;`));
  mustOk('down script reverses it', sql(`begin;\n${down}\ncommit;`));
  check('no proc_ object is left after the down script', sql(`select count(*) from information_schema.tables where table_name like 'proc\\_%'`).out === '0');
  mustOk('migration re-applies after rollback', sql(`begin;\n${up}\ncommit;`));
  check('RLS is enabled on every proc_ table', sql(`select count(*) from pg_tables where tablename like 'proc\\_%' and not rowsecurity`).out === '0');

  const M1 = '00000000-0000-0000-0000-0000000000a1'; const M2 = '00000000-0000-0000-0000-0000000000a2';
  const I1 = '00000000-0000-0000-0000-00000000a001'; const I2 = '00000000-0000-0000-0000-00000000a002';
  const L1 = '00000000-0000-0000-0000-00000000b001'; const L2 = '00000000-0000-0000-0000-00000000b002';
  const L3 = '00000000-0000-0000-0000-00000000b004'; const S1 = '00000000-0000-0000-0000-00000000c001';
  const mv = (key, { m = M1, item = I1, loc = L1, bucket = 'ON_HAND', delta, kind = 'ADJUSTMENT' }) =>
    `insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values ('${m}','${key}','${item}','${loc}','${bucket}',${delta},'${kind}','u');`;
  mustOk('seed two merchants with items, locations, a supplier', sql(`
    insert into merchants (id, name) values ('${M1}','A'), ('${M2}','B');
    insert into proc_items (id, merchant_id, sku, name) values ('${I1}','${M1}','SKU-1','one'), ('${I2}','${M2}','SKU-1','one-other-tenant');
    insert into proc_locations (id, merchant_id, name, type) values ('${L1}','${M1}','Warehouse','WAREHOUSE'), ('${L2}','${M2}','Warehouse','WAREHOUSE'), ('${L3}','${M1}','Empty','STORE');
    insert into proc_suppliers (id, merchant_id, name, currency) values ('${S1}','${M1}','Shenzhen Gifts','USD');`));
  mustFail('same SKU twice for one merchant is refused', sql(`insert into proc_items (merchant_id, sku, name) values ('${M1}','SKU-1','dup');`), /duplicate key/);
  mustFail('supplier name uniqueness is case-insensitive', sql(`insert into proc_suppliers (merchant_id, name, currency) values ('${M1}','shenzhen gifts','USD');`), /duplicate key/);

  // ---- ledger and balances
  mustOk('receipt of 10 is accepted', sql(mv('k1', { delta: 10, kind: 'RECEIPT' })));
  check('balance is derived by the trigger: on_hand = 10', sql(`select on_hand||','||reserved from proc_stock_balances where item_id='${I1}'`).out === '10,0');
  mustFail('a movement below zero is refused (balance check)', sql(mv('k2', { delta: -11 })), /proc_balance_nonneg/);
  check('the refused movement left nothing behind (no row, balance unchanged)', sql(`select (select count(*) from proc_stock_movements)||','||(select on_hand from proc_stock_balances)`).out === '1,10');
  mustFail('a first-ever movement on an empty location cannot be negative either', sql(mv('k3', { loc: L3, delta: -1 })), /proc_balance_nonneg/);
  check('and it left no phantom balance row behind', sql(`select count(*) from proc_stock_balances where location_id='${L3}'`).out === '0');
  mustOk('reserving 6 of 10 is accepted', sql(mv('k5', { bucket: 'RESERVED', delta: 6, kind: 'RESERVE' })));
  mustFail('reserving above on-hand is refused', sql(mv('k6', { bucket: 'RESERVED', delta: 5, kind: 'RESERVE' })), /proc_balance_reserved_le_onhand/);
  mustFail('taking out units that are reserved is refused', sql(mv('k7', { delta: -5 })), /proc_balance_reserved_le_onhand/);
  mustOk('taking out only the unreserved units is accepted', sql(mv('k8', { delta: -4 })));
  mustFail('RESERVE must use the RESERVED bucket (kind/bucket check)', sql(mv('k9', { bucket: 'ON_HAND', delta: 1, kind: 'RESERVE' })), /violates check constraint/);
  mustFail('a zero movement is refused', sql(mv('k10', { delta: 0 })), /violates check constraint/);
  mustFail('idempotency key is unique per merchant', sql(mv('k1', { delta: 1 })), /duplicate key/);
  mustOk('the same key is fine for another merchant', sql(mv('k1', { m: M2, item: I2, loc: L2, delta: 3, kind: 'RECEIPT' })));
  mustFail('a movement cannot reference another merchant\'s item (tenant-composite FK)', sql(mv('k11', { m: M2, item: I1, loc: L2, delta: 1 })), /foreign key/);
  mustFail('a movement cannot reference another merchant\'s location', sql(mv('k12', { m: M1, item: I1, loc: L2, delta: 1 })), /foreign key/);
  mustFail('UPDATE of the ledger is forbidden', sql(`update proc_stock_movements set delta = 99 where idempotency_key = 'k1';`), /append-only/);
  mustFail('DELETE from the ledger is forbidden', sql(`delete from proc_stock_movements;`), /append-only/);
  mustFail('TRUNCATE of the ledger is forbidden', sql(`truncate proc_stock_movements cascade;`), /append-only|cannot truncate/);
  check('balances equal the sum of the ledger for every key', sql(`select count(*) from proc_stock_balances b where b.on_hand <> (select coalesce(sum(delta),0) from proc_stock_movements m where m.merchant_id=b.merchant_id and m.item_id=b.item_id and m.location_id=b.location_id and m.bucket='ON_HAND') or b.reserved <> (select coalesce(sum(delta),0) from proc_stock_movements m where m.merchant_id=b.merchant_id and m.item_id=b.item_id and m.location_id=b.location_id and m.bucket='RESERVED')`).out === '0');

  // ---- purchase order rules
  mustOk('a purchase order with a line is created', sql(`
    insert into proc_purchase_orders (id, merchant_id, number, supplier_id, currency, expected_date, original_expected_date, destination_location_id, total_minor, created_by)
      values ('00000000-0000-0000-0000-0000000d0001','${M1}','PO-2026-0001','${S1}','USD','2026-11-20','2026-11-20','${L1}',10000,'u');
    insert into proc_po_lines (merchant_id, po_id, line_id, position, item_id, qty, unit_price_micro, total_minor, price_source) values ('${M1}','00000000-0000-0000-0000-0000000d0001','L1',1,'${I1}',200,500000,10000,'MANUAL');`));
  const PO = `update proc_purchase_orders set status = `;
  const where = ` where id = '00000000-0000-0000-0000-0000000d0001';`;
  mustFail('DRAFT -> ORDERED is an illegal transition', sql(`${PO}'ORDERED'${where}`), /illegal purchase order transition/);
  mustOk('DRAFT -> PENDING_APPROVAL -> APPROVED -> ORDERED is legal', sql(`${PO}'PENDING_APPROVAL'${where}${PO}'APPROVED'${where}${PO}'ORDERED'${where}`));
  mustFail('ORDERED -> DRAFT (going back) is illegal', sql(`${PO}'DRAFT'${where}`), /illegal purchase order transition/);
  check('each update bumped the version', sql(`select version from proc_purchase_orders`).out === '4');
  mustFail('received above ordered is refused', sql(`update proc_po_lines set qty_received = 201 where po_id = '00000000-0000-0000-0000-0000000d0001';`), /proc_po_line_received_le_ordered/);
  mustFail('defective above received is refused', sql(`update proc_po_lines set qty_received = 10, qty_defective = 11;`), /proc_po_line_defective_le_received/);
  mustOk('a partial receipt (120 of 200) is accepted', sql(`update proc_po_lines set qty_received = 120, qty_defective = 2;`));
  mustFail('a PO line cannot point to another merchant\'s order (tenant FK)', sql(`insert into proc_po_lines (merchant_id, po_id, line_id, position, item_id, qty, unit_price_micro, total_minor, price_source) values ('${M2}','00000000-0000-0000-0000-0000000d0001','L9',2,'${I2}',1,1,0,'MANUAL');`), /foreign key/);
  mustFail('PO number is unique per merchant', sql(`insert into proc_purchase_orders (merchant_id, number, supplier_id, currency, expected_date, original_expected_date, destination_location_id, total_minor, created_by) values ('${M1}','PO-2026-0001','${S1}','USD','2026-11-20','2026-11-20','${L1}',1,'u');`), /duplicate key/);
  mustFail('a paid instalment must carry a payment reference', sql(`insert into proc_po_schedule (merchant_id, po_id, kind, amount_minor, due_event, status) values ('${M1}','00000000-0000-0000-0000-0000000d0001','DEPOSIT',3000,'ON_ORDER','PAID_LINKED');`), /violates check constraint/);

  // ---- one-shot tables and journal
  mustOk('an approval can be consumed once', sql(`insert into proc_approvals_used (merchant_id, approval_id) values ('${M1}','ap-1');`));
  mustFail('a second consumption of the same approval is refused', sql(`insert into proc_approvals_used (merchant_id, approval_id) values ('${M1}','ap-1');`), /duplicate key/);
  mustOk('an audit event is written', sql(`insert into proc_events (merchant_id, type, actor, object, idempotency_key) values ('${M1}','PO_CREATED','{"id":"u"}','{"kind":"purchase_order","id":"x"}','k');`));
  mustFail('the journal cannot be edited', sql(`update proc_events set type = 'X';`), /append-only/);
  mustFail('the journal cannot be emptied', sql(`delete from proc_events;`), /append-only/);

  // ---- concurrency: two sessions, one balance, 6 + 6 against 6 available -> exactly one wins; numbers never collide
  mustOk('seed 6 units in a fresh location', sql(`insert into proc_locations (id, merchant_id, name, type) values ('00000000-0000-0000-0000-00000000b003','${M1}','Race','STORE'); ${mv('r0', { loc: '00000000-0000-0000-0000-00000000b003', delta: 6, kind: 'RECEIPT' })}`));
  const racer = (key) => `begin; ${mv(key, { loc: '00000000-0000-0000-0000-00000000b003', delta: -6 })} select pg_sleep(1); commit;`;
  const [a, b] = await Promise.all([sqlAsync(racer('r1')), sqlAsync(racer('r2'))]);
  check('two concurrent withdrawals of 6 from 6: exactly one succeeds', [a, b].filter((x) => x.ok).length === 1, `${a.ok}/${b.ok} ${a.err} ${b.err}`);
  check('the loser failed on the balance rule, not on a deadlock', [a, b].some((x) => /proc_balance_nonneg/.test(x.err)), `${a.err} | ${b.err}`);
  check('final balance is exactly 0', sql(`select on_hand from proc_stock_balances where location_id='00000000-0000-0000-0000-00000000b003'`).out === '0');
  const nums = await Promise.all(Array.from({ length: 6 }, () => sqlAsync(`select proc_next_number('${M1}','po-2026');`)));
  const got = nums.map((n) => n.out).sort();
  check('six concurrent PO numbers are all distinct and gapless', new Set(got).size === 6 && got.join(',') === '1,2,3,4,5,6', got.join(','));
} finally {
  if (process.env.KEEP_PG_SMOKE !== '1') docker(['rm', '-f', NAME]);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
