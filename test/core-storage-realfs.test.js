// REAL storage failure (not an injected fault): the Core journal on a real filesystem that becomes FULL (ENOSPC), then READ-ONLY (EROFS).
// The Core must never answer "recorded" for a decision that is not on the disk, must stay protected after the failure, and a restart must find
// exactly the decisions that were confirmed. Needs permission to mount a small tmpfs (root on Linux); skipped otherwise (the injected-fault
// equivalents run everywhere: test/core-reliability*.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createCoreHttp } from '../src/core-pilot/http.js';
import { createFileJournal } from '../src/core-pilot/journal.js';
import { validateCoreConfig } from '../src/core-pilot/config.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial } from './sourcing-fixtures.js';

const MID = 'merchant-test'; const TOKEN = 't'.repeat(32); const H = { 'x-sourcing-token': TOKEN };
const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const goCase = (id = 'case-go') => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of [...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, { type: 'SUPPLIER', supplier: { name: 'Yiwu Greenline' } }, ...commercial({ unitPrice: 4.2, qty: 1000 })]) c = dispatch(c, e, NOW); return c; };
const serve = (app) => { const s = http.createServer(app.handler); return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s))); };
const req = (port, method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers, ...(data ? { 'content-length': data.length } : {}) } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
  r.on('error', reject); if (data) r.write(data); r.end();
});
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const canMount = async () => {
  if (process.platform !== 'linux') return false;
  const d = await mkdtemp(join(tmpdir(), 'nordla-mnt-probe-')); const ok = sh('mount', ['-t', 'tmpfs', '-o', 'size=64k', 'tmpfs', d]).status === 0;
  if (ok) sh('umount', [d]); await rm(d, { recursive: true, force: true }); return ok;
};
const skip = (await canMount()) ? false : 'needs permission to mount a tmpfs (root on Linux)';

test('REAL full disk then read-only disk: never a false "recorded"; protected after the failure; a restart finds exactly the confirmed decisions', { skip }, async () => {
  const mnt = await mkdtemp(join(tmpdir(), 'nordla-fullfs-'));
  assert.equal(sh('mount', ['-t', 'tmpfs', '-o', 'size=96k', 'tmpfs', mnt]).status, 0);
  try {
    const file = join(mnt, 'core', 'decision-journal.jsonl');
    const store = createMemoryStore(); await store.save(goCase('case-a')); await store.save(goCase('case-b'));
    const boot = () => createCoreRuntime({ merchantId: MID, config: CONFIG, journal: createFileJournal({ merchantId: MID, file }), now: () => NOW });
    const open = async (rt) => { const s = await serve(createSourcingApp({ token: TOKEN, core: createCoreHttp({ runtime: rt, store, externals: async () => ({ safety: LIVE_CLEAN }) }), store, uiDir: '.', coreDir: '.' })); return s; };
    let s = await open(boot()); let port = s.address().port; const confirmed = [];
    try {
      const a = await req(port, 'POST', '/api/core/cases/case-a/analyse', { headers: H }); assert.equal(a.status, 200); confirmed.push(a.body.decision.id);
      const b = await req(port, 'POST', '/api/core/cases/case-b/analyse', { headers: H }); assert.equal(b.status, 200); confirmed.push(b.body.decision.id);
      // the disk fills up (another file takes every free byte)
      let filler = 0; for (;;) { try { await writeFile(join(mnt, `filler-${filler}`), Buffer.alloc(4096)); filler += 1; } catch (e) { assert.equal(e.code, 'ENOSPC'); break; } }
      const full = await req(port, 'POST', `/api/core/decisions/${confirmed[0]}/human`, { headers: H, body: { decision: 'REJECTED', reason: 'disk full' } });
      assert.notEqual(full.status, 200, 'never "recorded" on a full disk'); assert.equal(full.status, 503); assert.equal(full.body.decision, undefined);
      // space comes back: the journal stays PROTECTED until it is verified and the Core restarted (no silent resume on a possibly damaged file)
      for (let i = 0; i < filler; i += 1) await rm(join(mnt, `filler-${i}`));
      const after = await req(port, 'POST', `/api/core/decisions/${confirmed[0]}/human`, { headers: H, body: { decision: 'REJECTED', reason: 'space back' } });
      assert.equal(after.status, 503); assert.equal(after.body.error, 'JOURNAL_PROTECTED');
      const list = await req(port, 'GET', '/api/core/decisions?case=case-a', { headers: H }); assert.equal(list.status, 200); assert.equal(list.body.decisions[0].human_decision, null, 'the unrecorded decision is not shown');
    } finally { s.close(); }
    // restart on the same disk: exactly the confirmed decisions, nothing else
    assert.deepEqual(sh('ls', [join(mnt, 'core')]).stdout.split('\n').filter((f) => f.endsWith('.lock')), [], 'the failed writer left no lock behind');
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((e) => e.kind), ['ANALYSED', 'ANALYSED']);
    const rt2 = boot(); await rt2.ready();
    s = await open(rt2); port = s.address().port;
    try {
      const h = await req(port, 'POST', `/api/core/decisions/${confirmed[0]}/human`, { headers: H, body: { decision: 'REJECTED', reason: 'after restart' } }); assert.equal(h.status, 200, 'after a verified restart, writing works again at once (no lock left behind by the full disk)');
      // the disk becomes READ-ONLY: refused, never "recorded"
      assert.equal(sh('mount', ['-o', 'remount,ro', mnt]).status, 0);
      const ro = await req(port, 'POST', `/api/core/decisions/${confirmed[1]}/human`, { headers: H, body: { decision: 'REJECTED', reason: 'read-only disk' } });
      assert.equal(ro.status, 503); assert.equal(ro.body.decision, undefined);
    } finally { s.close(); }
    const final = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(final.map((e) => e.kind), ['ANALYSED', 'ANALYSED', final[2].kind]); assert.equal(final.length, 3, 'only the three confirmed events are on the disk');
  } finally { sh('umount', [mnt]); await rm(mnt, { recursive: true, force: true }); }
});
