// The offline parity audit of the creative REFINE. No network, no credential, no provider. The refine has no model stage: every rule is proved by a probe that breaks it and checks that the planner refuses it.
//   node scripts/check-creative-refine-parity.mjs                  prints the verdict; exit 0 only when every probe holds
//   node scripts/check-creative-refine-parity.mjs --write-matrix   regenerates docs/architecture/creative-refine-contract-matrix.md
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditRefineParity, renderRefineContractMatrix } from '../src/creative-refine/parity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audit = auditRefineParity();
if (process.argv.includes('--write-matrix')) {
  writeFileSync(path.join(root, 'docs', 'architecture', 'creative-refine-contract-matrix.md'), renderRefineContractMatrix(audit));
  console.log(JSON.stringify({ written: 'docs/architecture/creative-refine-contract-matrix.md', rows: audit.rows.length, ready: audit.ready }));
} else {
  console.log(JSON.stringify({ ready: audit.ready, failures: audit.failures, stages: audit.stages.map((s) => s.stage) }, null, 2));
  process.exitCode = audit.ready ? 0 : 3;
}
