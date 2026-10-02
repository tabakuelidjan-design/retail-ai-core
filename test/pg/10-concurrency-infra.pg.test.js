// Phase 0 - proof that the bench really runs many simultaneous server connections and real transactions/locks (what PGlite cannot do).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminClient, freshDatabase, openMany, race } from './lib/db.js';
import { control } from './lib/classify.js';

let db;
const withDb = (fn) => async () => { db = await freshDatabase(); try { return await fn(db); } finally { await db.drop(); } };

for (const n of [8, 32, 100]) {
  control(`MULTI-CONNECTION ${n} simultaneous backends`, withDb(async (d) => {
    const { clients, pids, closeAll } = await openMany(d.name, n);
    try {
      assert.equal(new Set(pids).size, n, 'every connection has its own backend process');
      const watcher = await adminClient();
      const t0 = Date.now();
      const runs = race(clients, (c) => c.query('select pg_sleep(1.5), pg_backend_pid() p'));
      await new Promise((r) => setTimeout(r, 900));
      const active = (await watcher.query("select count(*)::int n from pg_stat_activity where datname=$1 and state='active' and query like '%pg_sleep(1.5)%'", [d.name])).rows[0].n;
      const settled = await runs; const ms = Date.now() - t0; await watcher.end();
      const ok = settled.filter((s) => s.status === 'fulfilled').length;
      return { holds: ok === n && active === n && ms < 1.5 * 1000 * 4, evidence: `${n} backends, ${active} observed ACTIVE at the same instant in pg_stat_activity, all ${ok} completed in ${ms} ms (serial would be ${n * 1500} ms)` };
    } finally { await closeAll(); }
  }));
}

control('ROLLBACK leaves nothing behind', withDb(async (d) => {
  const c = await d.open();
  try {
    await c.query('create table t_rb (v int)'); await c.query('begin'); await c.query('insert into t_rb values (1)'); await c.query('rollback');
    const n = (await c.query('select count(*)::int n from t_rb')).rows[0].n;
    return { holds: n === 0, evidence: `rows after rollback: ${n}` };
  } finally { await c.end(); }
}));

control('ROW LOCK: a second writer really waits for the first commit', withDb(async (d) => {
  const { clients, closeAll } = await openMany(d.name, 2); const [a, b] = clients;
  try {
    await a.query('create table t_lock (id int primary key, v int)'); await a.query('insert into t_lock values (1, 0)');
    await a.query('begin'); await a.query('update t_lock set v = 1 where id = 1');
    let done = false; const second = b.query('update t_lock set v = v + 10 where id = 1').then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 400)); const blocked = !done;
    await a.query('commit'); await second;
    const v = (await a.query('select v from t_lock where id=1')).rows[0].v;
    return { holds: blocked && v === 11, evidence: `second writer blocked while the first held the lock: ${blocked}; final value ${v} (1 then +10, no lost update)` };
  } finally { await closeAll(); }
}));

control('DEADLOCK is detected by the server (not a hang)', withDb(async (d) => {
  const { clients, closeAll } = await openMany(d.name, 2); const [a, b] = clients;
  try {
    await a.query('create table t_dl (id int primary key)'); await a.query('insert into t_dl values (1),(2)');
    await a.query('begin'); await b.query('begin'); await a.query('select * from t_dl where id=1 for update'); await b.query('select * from t_dl where id=2 for update');
    const r = await Promise.allSettled([a.query('select * from t_dl where id=2 for update'), b.query('select * from t_dl where id=1 for update')]);
    const dead = r.filter((x) => x.status === 'rejected' && /deadlock detected/.test(x.reason.message)).length;
    await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {});
    return { holds: dead === 1, evidence: `deadlock victims: ${dead} (exactly one session aborted, the other proceeded)` };
  } finally { await closeAll(); }
}));
