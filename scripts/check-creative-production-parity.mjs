// The offline parity audit of the layered production. No network, no credential, no provider. Production has no model stage: every rule is proved by a probe that breaks it and checks that the validator names it.
//   node scripts/check-creative-production-parity.mjs                  prints the verdict; exit 0 only when every probe holds
//   node scripts/check-creative-production-parity.mjs --write-matrix   regenerates docs/architecture/creative-production-contract-matrix.md
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditProductionParity, renderProductionContractMatrix } from '../src/creative-production/parity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audit = auditProductionParity();
if (process.argv.includes('--write-matrix')) {
  writeFileSync(path.join(root, 'docs', 'architecture', 'creative-production-contract-matrix.md'), renderProductionContractMatrix(audit));
  console.log(JSON.stringify({ written: 'docs/architecture/creative-production-contract-matrix.md', rows: audit.rows.length, ready: audit.ready }));
} else {
  console.log(JSON.stringify({ ready: audit.ready, failures: audit.failures, stages: audit.stages.map((s) => s.stage) }, null, 2));
  process.exitCode = audit.ready ? 0 : 3;
}
