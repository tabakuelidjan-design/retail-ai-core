// Backup alerting without reading logs: the hosted service exposes GET /healthz/backup (ages and counts only) for an OUTSIDE monitor
// (.github/workflows/staging-backup-monitor.yml), which opens an alert when it is not OK. Synthetic runs, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupHealth, createSourcingApp } from '../src/sourcing/server/app.js';
import { scheduleBackups } from '../src/sourcing/server/index.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';

const H = 3_600_000; const T0 = Date.parse('2026-10-16T08:00:00Z');
const ENV = { SOURCING_BACKUP_PASSPHRASE: 'a test passphrase, not a secret', SOURCING_BACKUP_BUCKET: 'nordla-backups', SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };

test('backupHealth: OK only with a recent off-server copy; first run grace; FAILING after a failed retry; STALE; never configured is an alert', () => {
  const st = (o) => ({ configured: true, started_at: T0, last_success_at: null, last_failure_at: null, consecutive_failures: 0, last_error_code: null, ...o });
  assert.equal(backupHealth(st({}), T0 + 10 * 60_000).status, 'PENDING_FIRST_RUN');
  assert.equal(backupHealth(st({}), T0 + 10 * 60_000).ok, true);
  assert.deepEqual(backupHealth(st({}), T0 + 2 * H), { ok: false, status: 'NO_OFFSITE_COPY_YET', last_success_age_h: null, last_failure_age_h: null, consecutive_failures: 0, error_code: null });
  assert.equal(backupHealth(st({ last_success_at: T0 + H }), T0 + 20 * H).status, 'OK');
  assert.equal(backupHealth(st({ last_success_at: T0 + H, consecutive_failures: 1, last_failure_at: T0 + 25 * H, last_error_code: 'OFFSITE_UPLOAD_FAILED' }), T0 + 25 * H).ok, true, 'one failure: the 1 h retry gets its chance');
  const failing = backupHealth(st({ last_success_at: T0 + H, consecutive_failures: 2, last_failure_at: T0 + 26 * H, last_error_code: 'OFFSITE_UPLOAD_FAILED' }), T0 + 26 * H);
  assert.equal(failing.status, 'FAILING'); assert.equal(failing.ok, false); assert.equal(failing.error_code, 'OFFSITE_UPLOAD_FAILED');
  assert.equal(backupHealth(st({ last_success_at: T0 }), T0 + 27 * H).status, 'STALE', 'a stopped scheduler (no run at all) is caught too');
  assert.equal(backupHealth({ configured: false }, T0).status, 'NOT_CONFIGURED');
  assert.equal(backupHealth(null, T0).ok, false);
});

test('the scheduler records real outcomes: failures counted, a success resets them; nothing but times, counts and a code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nordla-bh-'));
  try {
    let t = T0; let fail = true;
    const s = scheduleBackups({ env: ENV, dir, log: () => {}, now: () => t, firstDelayMs: H, retryMs: H, run: async () => { if (fail) throw Object.assign(new Error('bucket unreachable at https://x'), { code: 'OFFSITE_UPLOAD_FAILED' }); return { files: 3, offsite: 'sourcing-20261016T090000Z.nsb' }; } });
    try {
      t += 1; await s.runNow(); t += 1; await s.runNow();
      assert.deepEqual(Object.keys(s.status()).sort(), ['configured', 'consecutive_failures', 'last_error_code', 'last_failure_at', 'last_success_at', 'started_at']);
      assert.equal(s.status().consecutive_failures, 2); assert.equal(backupHealth(s.status(), t).status, 'FAILING');
      fail = false; t += 1; await s.runNow();
      assert.equal(s.status().consecutive_failures, 0); assert.equal(backupHealth(s.status(), t).status, 'OK');
      assert.ok(!JSON.stringify(s.status()).includes('sourcing-2026'), 'no archive name');
    } finally { s.stop(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GET /healthz/backup: 200 when OK, 503 when not (so any HTTP monitor alerts), no session needed, Host allow-list still applies', async () => {
  let st = { configured: true, started_at: Date.now() - 5 * H, last_success_at: Date.now() - H, last_failure_at: null, consecutive_failures: 0, last_error_code: null };
  const app = createSourcingApp({ token: 't'.repeat(32), store: createMemoryStore(), uiDir: '.', coreDir: '.', allowedHosts: ['app.example.test'], backupStatus: () => st });
  const s = http.createServer(app.handler); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const get = (host) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: s.address().port, path: '/healthz/backup', headers: { host } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); }).on('error', reject); });
  try {
    let r = await get('app.example.test'); assert.equal(r.status, 200); assert.equal(r.body.status, 'OK');
    st = { ...st, consecutive_failures: 2, last_failure_at: Date.now(), last_error_code: 'OFFSITE_UPLOAD_FAILED' };
    r = await get('app.example.test'); assert.equal(r.status, 503); assert.equal(r.body.status, 'FAILING');
    r = await get('evil.example'); assert.equal(r.status, 421);
  } finally { s.close(); }
});
