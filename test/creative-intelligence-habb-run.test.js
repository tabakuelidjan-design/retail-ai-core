import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

import { runBenchmark } from '../scripts/run-benchmark-001.mjs';

// HABB CREATIVE BENCHMARK 001: the real run (`// HR-N` markers). The private photograph is only present on a trusted local machine: the tests that need it run
// only there; everywhere else the run must report BLOCKED at readiness (never PASS, never a fallback).

const root = new URL('../', import.meta.url);
const CONFIG = 'benchmarks/creative-intelligence/habb-creative-benchmark-001.json';
const SPEC = 'benchmarks/creative-intelligence/habb-benchmark-001-run-spec.json';
const config = JSON.parse(await readFile(new URL(CONFIG, root), 'utf8'));
const HERE = existsSync(new URL(config.private_payloads[0].path, root));
const AT = '2026-10-09T20:36:09Z';
const stageOf = (report, name) => report.stages.find((s) => s.stage === name);

test('The run harness is generic, clock-free and never falls back', async () => {
  const source = await readFile(new URL('scripts/run-benchmark-001.mjs', root), 'utf8');
  // HR-1 no clock, no network, no provider, no generation in the harness
  assert.doesNotMatch(source, /Date\.now\(|new Date\(\)|performance\.now|fetch\(|node:https?|node:net|randomUUID|Math\.random/);
  const code = source.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith(String.fromCharCode(47, 47))).join(String.fromCharCode(10));
  assert.doesNotMatch(code, /provider|generat|mock|fixture|placeholder|synthetic/i);
  // HR-2 nothing about the merchant is hard-coded in it: the benchmark and the spec are configuration
  assert.doesNotMatch(source, /habb|samsung|a17|playfair|montserrat|36b1a1a7/i);
  // HR-3 the run needs its instant as an argument
  assert.match(source, /--at <ISO instant> is required/);
  // HR-4 the evidence and the derived PNG go to the gitignored private location only
  assert.doesNotThrow(() => execSync('git check-ignore -q data/private/benchmark-runs/x/candidate.png', { cwd: root }));
  const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n');
  assert.ok(!tracked.some((f) => f.startsWith('data/private/')));
});

test('The run: no PASS is inferred from readiness; the real asset is consumed; gates that cannot be measured keep it BLOCKED', async () => {
  const report = await runBenchmark({ at: AT, configPath: CONFIG, specPath: SPEC, outDir: null });
  // HR-5 the verdict is never PASS while a mandatory gate is not measurable, and no fallback is ever used
  assert.notEqual(report.verdict, 'PASS');
  assert.equal(report.fallback.used, false);
  assert.equal(report.environment, 'LOCAL_REAL_ASSET');
  if (!HERE) {
    // HR-6 a clean clone (no private payload): BLOCKED at readiness, ASSET_PAYLOAD_UNAVAILABLE, nothing else is attempted
    assert.equal(report.verdict, 'BLOCKED');
    assert.deepEqual(report.readiness.blockers, [{ id: 'asset', reason: 'ASSET_PAYLOAD_UNAVAILABLE' }]);
    assert.equal(report.stages.length, 1);
    assert.equal(report.asset, undefined);
    return;
  }
  // HR-7 locally: readiness RUNNABLE, the pinned hash verified again, the real photograph consumed
  assert.equal(stageOf(report, 'readiness').actual, 'RUNNABLE');
  assert.equal(stageOf(report, 'asset_hash').verdict, 'PASS');
  assert.equal(report.asset.ref, 'asset://habb/benchmark-001/real-personalised-case-001');
  assert.equal(report.asset.sha256, config.private_payloads[0].sha256);
  assert.equal(report.asset.consumed, true);
  assert.equal(report.png.asset_resolutions, 1);
  assert.equal(report.product.ref, 'product://habb/benchmark-001/samsung-galaxy-a17');
  assert.equal(report.product.product_gid, 'gid://shopify/Product/15684483187036');
  assert.equal(report.product.handle, 'coque-personnalisee-samsung-galaxy-a17');
  // HR-8 Preflight really ran and passed (19 checks, none failing); the PNG is a RESOLVED render with REAL typography at the canvas size
  assert.equal(report.preflight.status, 'PASS');
  assert.ok(report.preflight.checks.length >= 19 && report.preflight.checks.every((c) => !/=FAIL$/.test(c)));
  assert.equal(report.png.render_mode, 'RESOLVED');
  assert.equal(report.png.typography_mode, 'REAL');
  assert.deepEqual([report.png.width, report.png.height], [1080, 1350]);
  // HR-9 the two gates that decide are NOT_MEASURABLE, for their stated reasons, so the verdict is BLOCKED (not FAIL, not PASS)
  assert.equal(report.fidelity.outcome, 'NOT_MEASURABLE');
  assert.equal(report.fidelity.observed, 0);
  assert.equal(report.guardian.outcome, 'NOT_MEASURABLE');
  assert.equal(report.guardian.hard_outcome_reason, 'NO_APPLICABLE_HARD_RULES');
  assert.equal(report.guardian.applicable_hard_rules, 0);
  assert.equal(report.verdict, 'BLOCKED');
  // HR-10 the run is deterministic: the same instant gives the same PNG, byte for byte
  const again = await runBenchmark({ at: AT, configPath: CONFIG, specPath: SPEC, outDir: null });
  assert.equal(again.png.sha256, report.png.sha256);
  assert.equal(report.png.sha256, config.execution.attempts[1].png_sha256);
});

test('The recorded execution tells the truth: RUNNABLE -> RUN -> BLOCKED, status NOT_RUN, C2 closed', () => {
  const e = config.execution;
  // HR-11 both attempts are recorded, the original failure first and classified, the verdict BLOCKED
  assert.equal(e.summary, 'RUNNABLE -> RUN -> BLOCKED');
  assert.equal(e.verdict, 'BLOCKED');
  assert.match(e.attempts[0].decisive, /INVALID_Z_ORDER = FAIL/);
  assert.match(e.attempts[0].decisive, /harness defect/);
  assert.equal(e.attempts[1].verdict, 'BLOCKED');
  assert.deepEqual(e.blocking_gates, ['creative_fidelity', 'brand_guardian']);
  assert.equal(e.fallback_used, false);
  assert.equal(e.real_asset_consumed, true);
  // HR-12 the configuration status is not promoted, and C2 is not opened by a blocked run
  assert.equal(config.status, 'NOT_RUN');
  assert.match(e.c2, /^NOT READY/);
  assert.ok(!JSON.stringify(config).includes('"verdict":"PASS"'));
});
