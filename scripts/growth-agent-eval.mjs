#!/usr/bin/env node
// Growth agent evaluation (offline). Usage:
//   node scripts/growth-agent-eval.mjs                       -> validates the cases, reports provider variable NAMES, grades nothing
//   node scripts/growth-agent-eval.mjs --answers answers.json -> grades answers produced earlier by a real provider for these cases
// The provider is never called from here. Answers file: { "<case id>": "<model JSON text or {draft, reason, limits}>" }.
import { readFile, writeFile } from 'node:fs/promises';
import { runEvaluation } from '../src/growth/eval/run.js';

const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const answersPath = at('--answers');
const outPath = at('--out');
const answers = answersPath ? JSON.parse(await readFile(answersPath, 'utf8')) : null;
const r = await runEvaluation({ answers });

const lines = [];
lines.push('# Growth agents - evaluation (offline)');
lines.push(`Cases: ${r.casesTotal} across ${r.agents} agents. Validation: ${r.validation.ok ? 'OK' : 'PROBLEMS'}.`);
for (const p of r.validation.problems) lines.push(`- problem: ${p}`);
lines.push(`Provider variables (names only): ${Object.entries(r.provider.variables).map(([k, v]) => `${k}=${v ? 'set' : 'not set'}`).join(', ')}.`);
lines.push(`Quality: ${r.quality}.`);
const done = r.graded.filter((g) => !g.missing);
if (done.length) {
  const byAgent = {};
  for (const g of done) { (byAgent[g.agent] ??= []).push(g); }
  for (const [agent, list] of Object.entries(byAgent)) {
    const score = list.reduce((s, g) => s + g.score, 0) / list.length;
    lines.push(`- ${agent}: mean check score ${(score * 100).toFixed(0)} % over ${list.length} case(s); failed checks: ${[...new Set(list.flatMap((g) => g.failed))].join(', ') || 'none'}`);
  }
  if (done.some((g) => g.promptHasPersonalData)) lines.push('WARNING: a prompt contained a personal format.');
}
const text = lines.join('\n') + '\n';
process.stdout.write(text);
if (outPath) await writeFile(outPath, text);
