import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateDataset } from '../benchmark/analyses/serving.mjs';
import { periodReport, resetPeriodCache } from '../src/analytics-premium/server/period-engine.js';
import { bindReportsTenant, unbindReportsTenant, tenantStamp } from '../src/analytics-premium/server/tenant.js';

// CHARACTERIZATION: the Explorer / Products / Clients builders are optimised in Analyses Phase 0 (per-day loops that rescanned every row). The
// optimisation must not change a single byte of their output: the SHA-256 of the full period reports over a deterministic SYNTHETIC dataset
// (2 000 orders, Europe/Brussels, several windows) was recorded BEFORE the change and is pinned here.
const NOW = new Date('2026-10-03T10:00:00Z'); const M = '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const QUERIES = [{ period: 'last_30_days' }, { period: 'last_90_days' }, { period: 'custom', from: '2026-01-01', to: '2026-03-31' }, { period: 'custom', from: '2025-10-04', to: '2026-10-02' }, { period: 'this_month' }, { period: 'previous_month' }];
// 24-hex prefixes of the SHA-256 (the repository privacy guard refuses any full 64-hex string outside vendor/)
const GOLDEN = {
  last_30_days: 'db180cd6b7d261d9b82acde2', last_90_days: '1e4422b031086bd2caf0ae39', 'custom:2026-01-01:2026-03-31': '17aaf2bcbf9a93c581f5788d',
  'custom:2025-10-04:2026-10-02': '549d3f67bbc4d1a434db8d31', this_month: '6578ac7121769597bfad0bf5', previous_month: '2d3aebf8c021cffd4bebe5d3',
};

test('G1. period reports over the synthetic dataset are byte-identical to the recorded ones (all three workspaces, six windows)', async () => {
  resetPeriodCache(); const dir = await mkdtemp(path.join(tmpdir(), 'golden-')); bindReportsTenant(dir, M);
  try {
    const data = generateDataset(2000, NOW);
    await writeFile(path.join(dir, 'dataset.json'), JSON.stringify({ version: 1, tenant: tenantStamp(M), generated_at: NOW.toISOString(), time_zone: 'Europe/Brussels', currency: 'EUR', data }));
    const got = {};
    for (const q of QUERIES) {
      const r = await periodReport(dir, q, { now: NOW }); assert.ok(r.ok, JSON.stringify(r));
      const { generated_at: _g, ...rest } = r.report; void _g;
      got[q.period === 'custom' ? `custom:${q.from}:${q.to}` : q.period] = createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 24);
    }
    if (process.env.PRINT_GOLDEN) console.log(JSON.stringify(got, null, 1));
    assert.deepEqual(got, GOLDEN);
  } finally { unbindReportsTenant(dir); resetPeriodCache(); await rm(dir, { recursive: true, force: true }); }
});
