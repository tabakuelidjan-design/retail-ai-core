import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { auditContractParity } from '../src/creative-brain/parity.js';
import { checkReadiness, codeHash, evaluateReadiness, NOT_READY, READY, runCheck, runLive } from '../src/creative-brain-benchmark/index.js';
import { world } from './creative-brain-benchmark-world.js';

// THE LIVE-READINESS GATE (`// RG-N` markers): a live benchmark is refused unless CREATIVE_BRAIN_CONTRACT_PARITY_READY. Offline, fakes only.

const good = (hash) => ({
  code_hash: hash, full_suite: { tests: 100, pass: 100, fail: 0 }, mutation: { total: 10, killed: 10, survivors_documented: 0 },
  clean_clones: { node20: { tests: 100, pass: 100, fail: 0 }, node24: { tests: 100, pass: 100, fail: 0 } }, ci: { status: 'success' },
});
const parity = auditContractParity();

test('RG-1 the verdict is READY only when parity and every recorded verification hold for this exact code', () => {
  assert.equal(parity.ready, true);
  const ok = evaluateReadiness({ parity, attestation: good('h'), hash: 'h' });
  assert.deepEqual({ status: ok.status, ready: ok.ready, reasons: ok.reasons }, { status: READY, ready: true, reasons: [] });
  assert.equal(READY, 'CREATIVE_BRAIN_CONTRACT_PARITY_READY');
});

test('RG-2 every missing or failing piece of evidence names itself and refuses', () => {
  const cases = [
    ['no attestation', { parity, attestation: null, hash: 'h' }, /NO_ATTESTATION/],
    ['other code', { parity, attestation: good('other'), hash: 'h' }, /ATTESTATION_IS_FOR_OTHER_CODE/],
    ['suite red', { parity, attestation: { ...good('h'), full_suite: { tests: 5, pass: 4, fail: 1 } }, hash: 'h' }, /FULL_SUITE_NOT_GREEN/],
    ['suite empty', { parity, attestation: { ...good('h'), full_suite: { tests: 0, pass: 0, fail: 0 } }, hash: 'h' }, /FULL_SUITE_NOT_GREEN/],
    ['mutation incomplete', { parity, attestation: { ...good('h'), mutation: { total: 10, killed: 8 } }, hash: 'h' }, /MUTATION_SWEEP/],
    ['mutation absent', { parity, attestation: { ...good('h'), mutation: undefined }, hash: 'h' }, /MUTATION_SWEEP/],
    ['node 20 red', { parity, attestation: { ...good('h'), clean_clones: { ...good('h').clean_clones, node20: { tests: 5, pass: 4, fail: 1 } } }, hash: 'h' }, /NODE_20/],
    ['node 24 absent', { parity, attestation: { ...good('h'), clean_clones: { node20: good('h').clean_clones.node20 } }, hash: 'h' }, /NODE_24/],
    ['ci pending', { parity, attestation: { ...good('h'), ci: { status: 'pending' } }, hash: 'h' }, /CI_NOT_SUCCESS/],
    ['parity drift', { parity: { ready: false, failures: ['FRAME: a rule is missing'] }, attestation: good('h'), hash: 'h' }, /CONTRACT_PARITY_FAILS: FRAME/],
  ];
  for (const [name, input, reason] of cases) {
    const v = evaluateReadiness(input);
    assert.equal(v.status, NOT_READY, name);
    assert.equal(v.ready, false, name);
    assert.ok(v.reasons.some((r) => reason.test(r)), `${name}: ${v.reasons}`);
  }
});

test('RG-3 the code hash follows the code: a change of any source, test or script file invalidates the attestation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rg-'));
  for (const d of ['src', 'test', 'scripts']) mkdirSync(path.join(root, d));
  writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'package.json'), '{}');
  const h1 = codeHash(root);
  assert.equal(codeHash(root), h1);
  writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\r\n'); // line endings are not a change
  assert.equal(codeHash(root), h1);
  writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 2;\n');
  assert.notEqual(codeHash(root), h1);
  const h2 = codeHash(root);
  writeFileSync(path.join(root, 'test', 'new.test.js'), 'x');
  assert.notEqual(codeHash(root), h2);
  const att = path.join(root, 'att.json');
  writeFileSync(att, JSON.stringify(good(h2)));
  const stale = checkReadiness({ attestationFile: att, root });
  assert.equal(stale.ready, false);
  assert.ok(stale.reasons.some((r) => /OTHER_CODE/.test(r)));
  writeFileSync(att, JSON.stringify(good(codeHash(root))));
  assert.equal(checkReadiness({ attestationFile: att, root }).status, READY);
});

test('RG-4 a live run is refused before anything else happens when the gate is not READY, or not wired at all', async () => {
  for (const readiness of [undefined, () => ({ ready: false, status: NOT_READY, reasons: ['NO_ATTESTATION'] })]) {
    const w = world();
    if (readiness) w.deps.readiness = readiness; else delete w.deps.readiness;
    const live = await runLive(w.deps, { confirmed: true });
    assert.equal(live.status, 'BLOCKED: CONTRACT_PARITY_NOT_READY');
    assert.equal(w.trace.length, 0);
    assert.equal(w.portArgs.length, 0);
    assert.equal(await w.store.exists('live-run-001.lock'), false);
    const check = await runCheck(w.deps);
    assert.equal(check.status, 'BLOCKED: CONTRACT_PARITY_NOT_READY');
    assert.equal(check.checks.filter((c) => !c.ok).length, 1); // the gate is the one failing check
  }
});
