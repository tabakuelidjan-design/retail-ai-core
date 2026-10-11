import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditContractParity } from '../creative-brain/parity.js';

// THE LIVE-READINESS GATE. A live Creative Brain benchmark is refused unless one explicit, offline verdict says CREATIVE_BRAIN_CONTRACT_PARITY_READY. The verdict needs:
//   1. contract / prompt parity of every model stage (computed here, now, from the real instructions and validators);
//   2. an ATTESTATION recorded for exactly this code (a hash of src, test, scripts and package files): the full suite, the mutation sweep, the Node 20 and Node 24 clean clones and CI all passed.
// The attestation is evidence recorded by a person or a script after those runs; the gate verifies that it belongs to the code it is looking at. Any change of code invalidates it, so a live run can never
// follow an edit that was not verified again. The fuzz, property and synthetic end-to-end tests are part of the full suite the attestation records.

export const READY = 'CREATIVE_BRAIN_CONTRACT_PARITY_READY';
export const NOT_READY = 'NOT_READY';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ATTESTATION_PATH = path.join(ROOT, 'docs', 'architecture', 'creative-brain-readiness.json');
const HASHED = ['src', 'test', 'scripts'];
const HASHED_FILES = ['package.json', 'package-lock.json'];

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'fixtures') yield* files(full); } else if (/\.(js|mjs|cjs|json)$/.test(entry.name)) yield full;
  }
}

/** A hash of the code that a verification covers: file names and contents (line endings normalized), in a fixed order. */
export function codeHash(root = ROOT) {
  const hash = createHash('sha256');
  const list = [...HASHED.flatMap((d) => { try { return [...files(path.join(root, d))]; } catch { return []; } }), ...HASHED_FILES.map((f) => path.join(root, f))];
  for (const file of list) {
    let text; try { text = readFileSync(file, 'utf8'); } catch { continue; }
    hash.update(path.relative(root, file).split(path.sep).join('/')); hash.update('\0'); hash.update(text.replace(/\r\n/g, '\n')); hash.update('\0');
  }
  return hash.digest('hex').slice(0, 40); // 40 hex characters, like a git commit: the repository's privacy test forbids any 64-character hex string in a committed file
}

export function readAttestation(file = ATTESTATION_PATH) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

const green = (r) => r && Number.isInteger(r.tests) && r.tests > 0 && r.fail === 0 && r.pass > 0;

/** The explicit verdict. Pure given its inputs (the tests drive it with synthetic attestations). */
export function evaluateReadiness({ parity, attestation, hash }) {
  const reasons = [];
  if (!parity?.ready) reasons.push(`CONTRACT_PARITY_FAILS: ${(parity?.failures ?? ['no audit']).slice(0, 5).join(' | ')}`);
  if (!attestation) reasons.push('NO_ATTESTATION: the full suite, the mutation sweep, the clean clones and CI have not been recorded');
  else {
    if (attestation.code_hash !== hash) reasons.push('ATTESTATION_IS_FOR_OTHER_CODE: the code changed since it was verified; verify again');
    if (!green(attestation.full_suite)) reasons.push('FULL_SUITE_NOT_GREEN');
    const m = attestation.mutation;
    if (!m || !(m.total > 0) || m.killed + (m.survivors_documented ?? 0) !== m.total) reasons.push('MUTATION_SWEEP_NOT_COMPLETE_OR_SURVIVORS_UNDOCUMENTED');
    if (!green(attestation.clean_clones?.node20)) reasons.push('NODE_20_CLEAN_CLONE_NOT_GREEN');
    if (!green(attestation.clean_clones?.node24)) reasons.push('NODE_24_CLEAN_CLONE_NOT_GREEN');
    if (attestation.ci?.status !== 'success') reasons.push('CI_NOT_SUCCESS_YET');
  }
  return { status: reasons.length ? NOT_READY : READY, ready: reasons.length === 0, reasons };
}

/** The live gate, with the real parity audit, the real code hash and the recorded attestation. */
export function checkReadiness({ attestationFile = ATTESTATION_PATH, root = ROOT } = {}) {
  const parity = auditContractParity();
  const verdict = evaluateReadiness({ parity, attestation: readAttestation(attestationFile), hash: codeHash(root) });
  return { ...verdict, parity: { ready: parity.ready, stages: parity.stages.length, rows: parity.rows.length, failures: parity.failures.length } };
}
