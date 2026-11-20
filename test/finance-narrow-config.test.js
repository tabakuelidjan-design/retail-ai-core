// Narrow-pilot start-up configuration (no database needed): every refusal is explicit, service mode is the default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNarrowIssuePathFromEnv, FinanceRuntimeConfigError } from '../src/finance/runtime/narrow-config.js';
import { PilotConnectionError } from '../src/finance/runtime/pg-connection.js';

const M = '11111111-2222-4333-8444-555555555555';
const dir = mkdtempSync(join(tmpdir(), 'nordla-narrow-cfg-'));
const pem = join(dir, 'ca.pem');
writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nTEST-ONLY\n-----END CERTIFICATE-----\n');
const url = 'postgres://nordla_fin_pilot_cfg.fvhiammdskpcnfodsnrc:x@aws-1-eu-west-1.pooler.supabase.com:6543/postgres';

test('service is the default: no narrow path, no configuration needed', async () => {
  assert.equal(await createNarrowIssuePathFromEnv({ env: {}, merchantId: M }), null);
  assert.equal(await createNarrowIssuePathFromEnv({ env: { FINANCE_RUNTIME_DB: 'service' }, merchantId: M }), null);
});

test('an unknown mode is refused, never silently treated as service', async () => {
  await assert.rejects(() => createNarrowIssuePathFromEnv({ env: { FINANCE_RUNTIME_DB: 'narrow' }, merchantId: M }), (e) => e instanceof FinanceRuntimeConfigError && e.code === 'FINANCE_RUNTIME_DB_UNKNOWN');
});

test('narrow-pilot needs its URL and its CA file, both checked before any connection', async () => {
  await assert.rejects(() => createNarrowIssuePathFromEnv({ env: { FINANCE_RUNTIME_DB: 'narrow-pilot' }, merchantId: M }), (e) => e.code === 'FINANCE_PILOT_DATABASE_URL_MISSING');
  await assert.rejects(() => createNarrowIssuePathFromEnv({ env: { FINANCE_RUNTIME_DB: 'narrow-pilot', FINANCE_PILOT_DATABASE_URL: url }, merchantId: M }), (e) => e.code === 'FINANCE_PILOT_CA_FILE_MISSING');
  await assert.rejects(() => createNarrowIssuePathFromEnv({ env: { FINANCE_RUNTIME_DB: 'narrow-pilot', FINANCE_PILOT_DATABASE_URL: url, FINANCE_PILOT_CA_FILE: join(dir, 'missing.pem') }, merchantId: M }), (e) => e.code === 'FINANCE_PILOT_CA_FILE_UNREADABLE');
  const notPem = join(dir, 'not-pem.txt'); writeFileSync(notPem, 'hello');
  await assert.rejects(() => createNarrowIssuePathFromEnv({ env: { FINANCE_RUNTIME_DB: 'narrow-pilot', FINANCE_PILOT_DATABASE_URL: url, FINANCE_PILOT_CA_FILE: notPem }, merchantId: M }), (e) => e.code === 'FINANCE_PILOT_CA_FILE_INVALID');
});

test('a TLS parameter in the URL or a non-pilot login stops the start-up with the connection error', async () => {
  const env = (u) => ({ FINANCE_RUNTIME_DB: 'narrow-pilot', FINANCE_PILOT_DATABASE_URL: u, FINANCE_PILOT_CA_FILE: pem });
  await assert.rejects(() => createNarrowIssuePathFromEnv({ env: env(url + '?sslcert=/tmp/c.pem'), merchantId: M }), (e) => e instanceof PilotConnectionError && e.code === 'PILOT_TLS_PARAM_REFUSED');
  await assert.rejects(() => createNarrowIssuePathFromEnv({ env: env(url.replace('nordla_fin_pilot_cfg', 'postgres')), merchantId: M }), (e) => e instanceof PilotConnectionError && e.code === 'PILOT_LOGIN_REFUSED');
});
