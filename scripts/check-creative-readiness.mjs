// The offline readiness gate of the whole Creative pipeline (planning, Brain, campaign). No network, no credential, no provider.
//   node scripts/check-creative-readiness.mjs               prints the verdict; exit 0 only for CREATIVE_PIPELINE_READY
//   node scripts/check-creative-readiness.mjs --code-hash   prints the hash of the code a verification must cover
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCreativeReadiness, codeHash } from '../src/creative-readiness/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--code-hash')) console.log(codeHash(root));
else {
  const verdict = checkCreativeReadiness();
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = verdict.ready ? 0 : 3;
}
