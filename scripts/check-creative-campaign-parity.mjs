// The offline parity audit of the campaign stages. No network, no credential, no provider.
//   node scripts/check-creative-campaign-parity.mjs                  prints the verdict; exit 0 only when instruction and validator agree everywhere
//   node scripts/check-creative-campaign-parity.mjs --write-matrix   regenerates docs/architecture/creative-campaign-contract-matrix.md
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditCampaignParity, renderCampaignContractMatrix } from '../src/creative-campaign/parity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audit = auditCampaignParity();
if (process.argv.includes('--write-matrix')) {
  writeFileSync(path.join(root, 'docs', 'architecture', 'creative-campaign-contract-matrix.md'), renderCampaignContractMatrix(audit));
  console.log(JSON.stringify({ written: 'docs/architecture/creative-campaign-contract-matrix.md', rows: audit.rows.length, ready: audit.ready }));
} else {
  console.log(JSON.stringify({ ready: audit.ready, failures: audit.failures, stages: audit.stages.map((s) => s.stage) }, null, 2));
  process.exitCode = audit.ready ? 0 : 3;
}
