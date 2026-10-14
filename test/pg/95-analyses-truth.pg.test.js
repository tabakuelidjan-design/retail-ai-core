// Analyses Phase 0 on a real PostgreSQL 17: only the DATABASE guarantees of migration 20261007090000 (the analytical logic is pure and is tested
// without a database in test/analyses-truth-*.test.js). Covered: the new order columns and their defaults, the indexes, merchant_profile
// (mandatory validated IANA timezone, formats, immutability, one profile per tenant) and tenant scoping of the refund-boundary reads.
import { seedMerchants, attempt, freshDatabase, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { control } from './lib/classify.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };
const A = MERCHANT_A; const B = MERCHANT_B;
const profile = (m, over = {}) => ({ sql: 'insert into merchant_profile (merchant_id, timezone, currency, country) values ($1,$2,$3,$4)', args: [m, over.timezone ?? 'Europe/Brussels', over.currency ?? 'EUR', over.country ?? 'BE'] });
const order = (c, m, tag, at) => c.query("insert into orders (merchant_id, source_system, source_id, ordered_at, currency, status, taxes_included) values ($1,'shopify',$2,$3,'EUR','PAID',true) returning id", [m, tag, at]).then((r) => r.rows[0].id);
const refund = (c, m, orderId, tag, at) => c.query("insert into refunds (merchant_id, order_id, source_system, source_id, amount, refunded_at) values ($1,$2,'shopify',$3,10,$4)", [m, orderId, tag, at]);

control('ORDER COLUMNS: cancellation fields are nullable, lines_truncated is NOT NULL default false, existing inserts keep working', withDb(async (d) => {
  const c = await d.open(); try {
    const id = await order(c, A, 'o1', '2026-09-01T10:00:00Z');
    const row = (await c.query('select cancelled_at, closed_at, cancel_reason, lines_truncated from orders where id=$1', [id])).rows[0];
    const nul = await attempt(c, 'update orders set lines_truncated = null where id=$1', [id]);
    const set = await attempt(c, "update orders set cancelled_at='2026-09-02T10:00:00Z', cancel_reason='CUSTOMER', lines_truncated=true where id=$1", [id]);
    return { holds: row.cancelled_at === null && row.closed_at === null && row.cancel_reason === null && row.lines_truncated === false && nul.ok === false && set.ok === true, evidence: `defaults ${JSON.stringify(row)}, null truncated flag refused (${nul.code}), cancellation writable` };
  } finally { await c.end(); }
}));

control('INDEXES: orders (merchant_id, ordered_at) and refunds (merchant_id, refunded_at) exist', withDb(async (d) => {
  const c = await d.open(); try {
    const idx = (await c.query("select indexname, indexdef from pg_indexes where schemaname='public' and indexname in ('orders_merchant_ordered_at_idx','refunds_merchant_refunded_at_idx')")).rows;
    const defs = Object.fromEntries(idx.map((i) => [i.indexname, i.indexdef]));
    return { holds: /\(merchant_id, ordered_at\)/.test(defs.orders_merchant_ordered_at_idx ?? '') && /\(merchant_id, refunded_at\)/.test(defs.refunds_merchant_refunded_at_idx ?? ''), evidence: Object.values(defs).join(' | ') };
  } finally { await c.end(); }
}));

control('MERCHANT_PROFILE: IANA timezone mandatory and validated, formats checked, merchant immutable, one profile per tenant, updated_at follows', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    const run = (q) => attempt(c, q.sql, q.args);
    out.push((await run(profile(A))).ok ? 'valid ok' : 'valid refused');
    out.push((await run(profile(A))).code); // second profile for the same tenant
    for (const tz of ['Mars/Phobos', 'EST', 'UTC+1', '']) out.push((await run(profile(B, { timezone: tz }))).code);
    out.push((await run(profile(B, { currency: 'eur' }))).code, (await run(profile(B, { currency: 'EURO' }))).code, (await run(profile(B, { country: 'Belgium' }))).code);
    out.push((await attempt(c, 'insert into merchant_profile (merchant_id, currency) values ($1,$2)', [B, 'EUR'])).code); // timezone missing = not null
    out.push((await attempt(c, 'insert into merchant_profile (merchant_id, timezone, currency) values ($1,$2,$3)', ['99999999-9999-9999-9999-999999999999', 'UTC', 'EUR'])).code); // unknown merchant
    out.push((await attempt(c, 'update merchant_profile set merchant_id=$2 where merchant_id=$1', [A, B])).code);
    out.push((await attempt(c, "update merchant_profile set timezone='Not/AZone' where merchant_id=$1", [A])).code);
    out.push((await attempt(c, "update merchant_profile set channel_aliases='[]'::jsonb where merchant_id=$1", [A])).code); // must be an object
    const before = (await c.query('select created_at, updated_at from merchant_profile where merchant_id=$1', [A])).rows[0];
    await c.query('select pg_sleep(0.05)'); await c.query("update merchant_profile set timezone='Europe/Paris', pos_channel_handles='[\"pos\"]'::jsonb, channel_aliases='{\"point_of_sale\":\"pos\"}'::jsonb where merchant_id=$1", [A]);
    const after = (await c.query('select created_at, updated_at, timezone from merchant_profile where merchant_id=$1', [A])).rows[0];
    const stamps = after.updated_at > before.updated_at && String(after.created_at) === String(before.created_at) && after.timezone === 'Europe/Paris';
    const expect = ['valid ok', 'merchant_profile_pkey', '23514', '23514', '23514', '23514', 'merchant_profile_currency_check', 'merchant_profile_currency_check', 'merchant_profile_country_check', '23514', 'merchant_profile_merchant_id_fkey', '23000', '23514', 'merchant_profile_channel_aliases_check'];
    // errcodes: unique_violation, check_violation (trigger or column check), not_null_violation, foreign_key_violation, integrity_constraint_violation
    const got = out.map((x) => String(x));
    return { holds: got.join() === expect.join() && stamps, evidence: `${got.join(' / ')}; updated_at advanced=${stamps}` };
  } finally { await c.end(); }
}));

control('REFUND BOUNDARY reads are tenant-scoped: the exact query shapes of the loader return only this merchant\'s refunds and context orders', withDb(async (d) => {
  const c = await d.open(); try {
    const oldA = await order(c, A, 'oldA', '2026-07-01T10:00:00Z'); const oldB = await order(c, B, 'oldB', '2026-07-01T10:00:00Z');
    await refund(c, A, oldA, 'rA', '2026-09-20T10:00:00Z'); await refund(c, B, oldB, 'rB', '2026-09-20T10:00:00Z');
    const rs = (await c.query("select id, order_id from refunds where merchant_id=$1 and refunded_at >= $2 order by id", [A, '2026-08-04T00:00:00Z'])).rows;
    const ctx = (await c.query('select id, merchant_id from orders where merchant_id=$1 and id = any($2::uuid[])', [A, rs.map((r) => r.order_id)])).rows;
    const leak = (await c.query('select id from orders where merchant_id=$1 and id = $2', [A, oldB])).rows;
    return { holds: rs.length === 1 && ctx.length === 1 && ctx[0].id === oldA && leak.length === 0, evidence: `refunds for A in window=${rs.length}, context orders=${ctx.length}, B's order reachable through A's scope=${leak.length}` };
  } finally { await c.end(); }
}));
