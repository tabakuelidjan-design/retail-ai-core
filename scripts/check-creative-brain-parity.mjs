// The offline live-readiness gate of the Creative Brain. No network, no credential, no provider.
//   node scripts/check-creative-brain-parity.mjs                  prints the verdict; exit 0 only for CREATIVE_BRAIN_CONTRACT_PARITY_READY
//   node scripts/check-creative-brain-parity.mjs --write-matrix   regenerates docs/architecture/creative-brain-contract-matrix.md from the real instructions and validators
//   node scripts/check-creative-brain-parity.mjs --code-hash      prints the hash of the code a verification must cover
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditContractParity, renderContractMatrix } from '../src/creative-brain/parity.js';
import { checkReadiness, codeHash } from '../src/creative-brain-benchmark/readiness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--write-matrix')) {
  const audit = auditContractParity();
  writeFileSync(path.join(root, 'docs', 'architecture', 'creative-brain-contract-matrix.md'), renderContractMatrix(audit));
  console.log(JSON.stringify({ written: 'docs/architecture/creative-brain-contract-matrix.md', rows: audit.rows.length, ready: audit.ready }));
} else if (process.argv.includes('--code-hash')) {
  console.log(codeHash(root));
} else {
  const verdict = checkReadiness();
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = verdict.ready ? 0 : 3;
}
