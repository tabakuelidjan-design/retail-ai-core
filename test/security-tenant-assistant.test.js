import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCoreHttp } from '../src/core-pilot/http.js';
import { createAnalyticsReader } from '../src/core-pilot/analytics-reader.js';
import { unbindReportsTenant } from '../src/analytics-premium/server/tenant.js';
import { writeDataset, NOW } from './fixtures/analytics-dataset.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

async function ask(core, text, role) {
  let result;
  const req = { method: 'POST', headers: {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ text })); } };
  await core.handle(req, { writeHead() {}, end(body) { result = JSON.parse(body); } }, new URL('https://core.example/api/core/ask'), { role, userId: 'synthetic-person' });
  return result;
}

test('assistant cannot read Finance or Analytics for a forbidden role or a disabled entitlement', async () => {
  let reads = 0;
  const forbiddenRead = async () => { reads++; throw new Error('private source must not be called'); };
  let active = new Set(['finance', 'analytics']);
  const core = createCoreHttp({ runtime: null, store: {}, merchantId: A, entitlements: async () => active,
    finance: { payables: forbiddenRead, treasury: forbiddenRead, purchases: forbiddenRead, today: () => { reads++; return '2026-11-19'; } },
    analytics: { salesEvolution: forbiddenRead },
  });
  const questions = ['quelles factures fournisseurs dois-je payer ?', 'ma trésorerie', 'mes achats du mois', 'comment évoluent mes ventes ?'];
  for (const role of ['VIEWER', 'COLLABORATOR', null]) for (const question of questions) {
    const result = await ask(core, question, role);
    assert.equal(result.status, 'FORBIDDEN', role + ': ' + question);
    assert.deepEqual(result.sources, []);
  }
  active = new Set();
  for (const question of questions) assert.equal((await ask(core, question, 'OWNER')).status, 'FORBIDDEN');
  assert.equal(reads, 0, 'the restricted financial sources were never read');
});

test('assistant report reader refuses a foreign or unstamped dataset and requires a merchant', async () => {
  const dir = await writeDataset({ merchantId: B });
  try {
    assert.throws(() => createAnalyticsReader({ reportsDir: dir }), /merchantId/);
    const reader = createAnalyticsReader({ reportsDir: dir, merchantId: A, now: () => NOW, source: 'synthetic' });
    assert.equal((await reader.salesEvolution()).ok, false, 'foreign report cannot enter assistant facts');
    assert.throws(() => createAnalyticsReader({ reportsDir: dir, merchantId: B }), /TENANT_MISMATCH/, 'a second reader cannot silently rebind the directory');
    const file = join(dir, 'dataset.json');
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    delete snapshot.tenant;
    await writeFile(file, JSON.stringify(snapshot));
    assert.equal((await reader.salesEvolution()).ok, false, 'legacy unstamped report is also refused');
    snapshot.tenant = { merchant_id: A };
    await writeFile(file, JSON.stringify(snapshot));
    assert.equal((await reader.salesEvolution()).ok, true, 'the correctly stamped report remains usable');
  } finally { unbindReportsTenant(dir); await rm(dir, { recursive: true, force: true }); }
});
