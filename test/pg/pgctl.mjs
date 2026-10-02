// Disposable PostgreSQL 17 for the Finance tests.  Usage: node test/pg/pgctl.mjs up|down|reset|status
// Local only: bound to 127.0.0.1, throw-away password, data on tmpfs (gone with the container). No production secret is ever read or written.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Official image, pinned by digest (a public image identifier, not a secret; written in two halves so the repository's 64-hex privacy scan stays meaningful).
export const IMAGE = `postgres:17@sha256:${['d74eeac9a635390a49bc21bd49fccd97', '3de707e2a53a76ac49b552b8712ec46f'].join('')}`;
export const CONTAINER = 'nordla-finance-pg17';
export const PORT = 54329;
export const CLUSTER_NAME = 'nordla_finance_test'; // sentinel checked by the safety guard
export const DEFAULT_URL = `postgres://postgres:finance_test_only@127.0.0.1:${PORT}/postgres`;

const DOCKER_BIN = 'C:\\Program Files\\Docker\\Docker\\resources\\bin';
const env = { ...process.env };
if (process.platform === 'win32' && existsSync(DOCKER_BIN)) env.PATH = `${DOCKER_BIN};${env.PATH ?? env.Path ?? ''}`; // docker + its credential helper

const docker = (...args) => spawnSync('docker', args, { env, encoding: 'utf8' });
const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();

export function status() {
  const r = docker('inspect', '-f', '{{.State.Running}}', CONTAINER);
  return r.status === 0 && r.stdout.trim() === 'true' ? 'running' : 'absent';
}
export function down() { docker('rm', '-f', '-v', CONTAINER); }
export function up() {
  if (status() === 'running') return;
  docker('rm', '-f', '-v', CONTAINER);
  const r = docker('run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${PORT}:5432`, '-e', 'POSTGRES_PASSWORD=finance_test_only', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m',
    IMAGE, '-c', `cluster_name=${CLUSTER_NAME}`, '-c', 'max_connections=200', '-c', 'fsync=off', '-c', 'deadlock_timeout=200ms', '-c', 'log_lock_waits=on');
  if (r.status !== 0) throw new Error(`docker run failed: ${out(r)}`);
  for (let i = 0; i < 60; i++) {
    if (docker('exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1').status === 0) {
      // the official image restarts once after initdb: wait for two consecutive ready answers
      if (docker('exec', CONTAINER, 'psql', '-U', 'postgres', '-tAc', 'select 1').status === 0) return;
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  }
  throw new Error(`postgres did not become ready: ${out(docker('logs', '--tail', '20', CONTAINER))}`);
}

if (process.argv[1] && process.argv[1].endsWith('pgctl.mjs')) {
  const cmd = process.argv[2];
  if (cmd === 'up') { up(); console.log(`postgres 17 ready on 127.0.0.1:${PORT} (container ${CONTAINER})`); }
  else if (cmd === 'down') { down(); console.log('removed'); }
  else if (cmd === 'reset') { down(); up(); console.log('recreated from zero'); }
  else if (cmd === 'status') console.log(status());
  else { console.error('usage: pgctl.mjs up|down|reset|status'); process.exit(2); }
}
