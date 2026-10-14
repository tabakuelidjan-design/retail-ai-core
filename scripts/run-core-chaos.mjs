// The Nordla Core chaos benchmark: deterministic synthetic scenarios, fake providers only. NO network, NO credential, NO provider call.
//   node scripts/run-core-chaos.mjs                 prints the report (summary; --full adds every record); exit 0 only for NORDLA_CORE_RESILIENCE_READY = YES
//   node scripts/run-core-chaos.mjs --write-matrix  regenerates docs/architecture/nordla-core-resilience-matrix.json from the real policy
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCoreRegistry } from '../src/core-resilience/index.js';
import { creativeMigrationReport, registerAll, registerCreative } from '../src/core-resilience/adapters/index.js';
import { buildRecoveryMatrix } from '../src/core-resilience/matrix.js';
import { runChaos } from '../benchmarks/core-resilience/harness.js';
import { SCENARIOS } from '../benchmarks/core-resilience/scenarios.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--write-matrix')) {
  const matrix = buildRecoveryMatrix();
  writeFileSync(path.join(root, 'docs', 'architecture', 'nordla-core-resilience-matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`);
  console.log(JSON.stringify({ written: 'docs/architecture/nordla-core-resilience-matrix.json', categories: Object.keys(matrix.categories).length }));
} else {
  const report = await runChaos(SCENARIOS);
  const migration = creativeMigrationReport(registerAll(registerCreative(createCoreRegistry())));
  const out = { ...report, CREATIVE_BRAIN_MIGRATED_TO_CORE_RESILIENCE: migration.migrated ? 'YES' : 'NO', creative_migration: migration, live_provider_calls: 0 };
  if (!process.argv.includes('--full')) delete out.records;
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = report.NORDLA_CORE_RESILIENCE_READY === 'YES' && migration.migrated ? 0 : 3;
}
