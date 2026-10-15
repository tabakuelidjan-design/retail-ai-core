// tools/staging-db/run.sh never prints the database address (incident 2026-10-15: a password holding an unencoded '@' was split by
// the client and a fragment reached the job log). An ambiguous address is refused BEFORE any connection; nothing of it is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (url) => spawnSync('bash', ['tools/staging-db/run.sh', 'ops/staging-db/request.json', mkdtempSync(join(tmpdir(), 'sdb-'))], {
  encoding: 'utf8', timeout: 60000, env: { ...process.env, STAGING_DATABASE_URL: url, STAGING_BACKUP_PASSPHRASE: 'passphrase-long-enough', RESTORE_URL: 'postgresql://x@127.0.0.1/x' },
});
const has = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`]).status === 0;

test('staging-db guard: an address with an unencoded @ / # / ? in the password is refused before connecting, and never printed', { skip: !has('jq') && 'jq missing' }, () => {
  for (const url of ['postgresql://postgres.fvhiammdskpcnfodsnrc:Ab@FRAGMENTxyz@pooler.nordla-test.example:5432/postgres',
    'postgresql://postgres.fvhiammdskpcnfodsnrc:Ab#FRAGMENTxyz@pooler.nordla-test.example:5432/postgres']) {
    const r = run(url); const out = r.stdout + r.stderr;
    assert.equal(r.status, 2); assert.match(out, /STOP: the database URL is ambiguous/); assert.doesNotMatch(out, /FRAGMENTxyz/);
  }
});

test('staging-db guard: production refused; an unreachable well-formed address stops without printing it', { skip: !has('jq') && 'jq missing' }, () => {
  let r = run('postgresql://postgres.xbtzjabbseclmqfozjeo:Pwd123@pooler.nordla-test.example:5432/fvhiammdskpcnfodsnrc');
  assert.equal(r.status, 2); assert.match(r.stdout + r.stderr, /PRODUCTION/);
  if (!has('psql')) return;
  r = run('postgresql://postgres.fvhiammdskpcnfodsnrc:SECRETpwd123@nohost-fvhiammdskpcnfodsnrc.example:5432/postgres');
  assert.equal(r.status, 2); assert.match(r.stdout + r.stderr, /cannot connect/); assert.doesNotMatch(r.stdout + r.stderr, /SECRETpwd123|nohost/);
});
