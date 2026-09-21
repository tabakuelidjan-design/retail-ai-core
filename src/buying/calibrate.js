#!/usr/bin/env node
// node --env-file=.env src/buying/calibrate.js <candidate.json> --policy <baseline.json>
// Policy sensitivity: re-evaluates a candidate while varying ONE policy setting at a
// time around the baseline and shows how the verdict moves. The probe values are a
// sensitivity grid around the baseline the operator supplies - they are not
// recommendations and no value here is a default. Settings that are unset in the
// baseline are skipped and reported as such.

import { mkdir, writeFile } from 'node:fs/promises';
import { mergeConfig } from '../metrics/config.js';
import { DEFAULT_PATHS, loadBuyingContext, parseArgs, readJson } from './context.js';
import { evaluateCandidate } from './evaluate.js';

const clamp01 = (x) => Math.min(1, Math.max(0, Math.round(x * 1000) / 1000));
const r2 = (x) => Math.round(x * 100) / 100;

/** `path` is relative to the `buying` block. `probe(b)` returns the values to try around baseline value b. */
export const SWEEPS = [
  { path: 'testBudget', probe: (b) => [b * 0.5, b, b * 2] },
  { path: 'minUnitMarginPct', probe: (b) => [clamp01(b - 0.1), b, clamp01(b + 0.1)] },
  { path: 'paymentCostPct', probe: (b) => [clamp01(b - 0.01), b, clamp01(b + 0.02)] },
  { path: 'maxSellThroughWeeks', probe: (b) => [r2(b / 2), b, b * 2] },
  { path: 'maxLeadTimeDays', probe: (b) => [r2(b / 2), b, b * 2] },
  { path: 'exposure.noSaleShare', probe: (b) => [clamp01(b - 0.2), b, clamp01(b + 0.2)] },
  { path: 'exposure.coverWeeks', probe: (b) => [r2(b / 2), b, b * 2] },
  { path: 'stockTrust.blockedShare', probe: (b) => [clamp01(b / 2), b, clamp01(b * 2)] },
  { path: 'stockTrust.trustedShare', probe: (b) => [clamp01(b - 0.1), b, clamp01(b + 0.1)] },
  { path: 'stockTrust.unverifiedMaySupportPass', values: [false, true] },
  { path: 'estimateTolerancePct', probe: (b) => [clamp01(b / 2), b, clamp01(b * 2)] },
  { path: 'allowExploratoryTests', values: [false, true], needs: 'exploratoryBudget' },
];

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function withPath(policy, path, value) {
  const out = structuredClone(policy);
  out.buying ??= {};
  const keys = path.split('.');
  let cur = out.buying;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {});
  cur[keys.at(-1)] = value;
  return out;
}

/** Pure: runs the sweeps for one candidate. Exported for tests. */
export function runSensitivity({ rawCandidate, policy, demandFacts, preparedVerification, now }) {
  const base = mergeConfig(policy);
  const evaluate = (p) => evaluateCandidate({ rawCandidate, demandFacts, config: mergeConfig(p), preparedVerification, now });
  const baseline = evaluate(policy);
  const rows = [];
  const skipped = [];
  for (const s of SWEEPS) {
    const baseValue = getPath(base.buying, s.path);
    if (s.needs && getPath(base.buying, s.needs) == null) { skipped.push({ setting: s.path, reason: `baseline ${s.needs} is unset` }); continue; }
    let values = s.values;
    if (!values) {
      if (baseValue == null) { skipped.push({ setting: s.path, reason: 'unset in the baseline policy' }); continue; }
      values = [...new Set(s.probe(baseValue))];
    }
    for (const v of values) {
      const r = v === baseValue ? baseline : evaluate(withPath(policy, s.path, v));
      rows.push({ setting: s.path, value: v, is_baseline: v === baseValue, verdict: r.verdict, test_type: r.test_type, reasons: r.reason_codes });
    }
  }
  return { baseline: { verdict: baseline.verdict, test_type: baseline.test_type, reasons: baseline.reason_codes }, rows, skipped };
}

export function renderSensitivity(candidateId, result) {
  const lines = [
    `# Policy sensitivity: ${candidateId}`,
    'Probe values are a grid around the baseline policy supplied by the operator. They are not recommendations and not defaults.',
    `Baseline verdict: **${result.baseline.verdict}**${result.baseline.test_type ? ` (${result.baseline.test_type})` : ''} - ${result.baseline.reasons.join(', ')}`,
    '', '| Setting | Value | Verdict | Reasons |', '|---|---|---|---|',
  ];
  for (const r of result.rows) lines.push(`| ${r.setting} | ${r.value}${r.is_baseline ? ' (baseline)' : ''} | ${r.verdict}${r.test_type ? ` (${r.test_type})` : ''} | ${r.reasons.join(', ')} |`);
  if (result.skipped.length) lines.push('', 'Skipped: ' + result.skipped.map((s) => `${s.setting} (${s.reason})`).join('; '));
  return lines.join('\n');
}

async function main() {
  const { positional: files, opts } = parseArgs(process.argv.slice(2));
  if (files.length === 0 || !opts.policy) {
    console.error('Usage: node src/buying/calibrate.js <candidate.json> [...] --policy <baseline-policy.json>');
    process.exit(1);
  }
  const ctx = await loadBuyingContext({ policyPath: opts.policy, verificationPath: opts['stock-verification'] ?? DEFAULT_PATHS.verification });
  await mkdir('reports', { recursive: true });
  const stamp = ctx.now.toISOString().slice(0, 10);
  for (const file of files) {
    const raw = await readJson(file);
    const result = runSensitivity({ rawCandidate: raw, policy: ctx.policy, demandFacts: ctx.facts, preparedVerification: ctx.preparedVerification, now: ctx.now });
    const id = String(raw.candidate_id ?? 'candidate').replace(/[^A-Za-z0-9_-]/g, '_');
    await writeFile(`reports/buying-calibration-${id}-${stamp}.json`, JSON.stringify(result, null, 2));
    await writeFile(`reports/buying-calibration-${id}-${stamp}.md`, renderSensitivity(id, result));
    console.log(renderSensitivity(id, result));
  }
}

if (process.argv[1] && process.argv[1].endsWith('calibrate.js')) {
  main().catch((err) => {
    console.error('calibration failed:', err);
    process.exit(1);
  });
}
