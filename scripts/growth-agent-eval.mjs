#!/usr/bin/env node
// Growth agent evaluation - OFFLINE. The provider is never called from here, and no network is used.
//
// Usage:
//   node scripts/growth-agent-eval.mjs                                  validates and reports the default group (reference)
//   node scripts/growth-agent-eval.mjs --group=<name>                   one group: reference | remax | remax-synthetic | goal | all
//   node scripts/growth-agent-eval.mjs --group=<name> --answers a.json  grades saved answers for that group (offline)
//   node scripts/growth-agent-eval.mjs --group=<name> --answers a.json --out report.md   also writes the report
//   node scripts/growth-agent-eval.mjs --help
//
// Answers file: a JSON object { "<case id>": "<model JSON text>" } or { "<case id>": { "draft": "...", "reason": "...", "limits": [] } }.
// Without --answers nothing is graded and the report says "Quality: NOT EVALUATED".
// Exit codes: 0 = ran; 1 = a case group failed validation; 2 = usage error (unknown group, bad flag, missing or malformed answers file).
// Provider configuration is reported by variable NAME only (never a value).

import { readFile, writeFile } from 'node:fs/promises';
import { runEvaluation } from '../src/growth/eval/run.js';
import { coverageProblems } from '../src/growth/eval/expectations.js';
import { GROUPS, GROUP_NAMES, DEFAULT_GROUP, casesOfGroup } from '../src/growth/eval/groups.js';

const HELP = `Growth agent evaluation (offline)

Usage: node scripts/growth-agent-eval.mjs [--group=<name>] [--answers <file>] [--out <file>] [--help]

  --group=<name>   ${GROUP_NAMES.join(' | ')}   (default: ${DEFAULT_GROUP})
  --answers <file> saved answers as JSON: { "<case id>": "<model JSON>" | { "draft", "reason", "limits" } }
  --out <file>     also write the report to this file
  --help           show this help

Nothing is sent to a provider. Without --answers, no quality is claimed (Quality: NOT EVALUATED).
Groups: reference (24 synthetic cases), remax (REAL catalogue facts), remax-synthetic (FICTIONAL figures),
goal (weekly target, FICTIONAL figures), all (every group, one section each, then a total).
`;

class UsageError extends Error {}

/** Parses the arguments. Accepts --flag=value and --flag value. Unknown flags are usage errors. */
export function parseArgs(argv) {
  const out = { group: DEFAULT_GROUP, answers: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    const m = /^--(group|answers|out)(?:=(.*))?$/.exec(a);
    if (!m) throw new UsageError(`unknown argument: ${a}`);
    const key = m[1];
    const value = m[2] !== undefined ? m[2] : argv[i + 1];
    if (m[2] === undefined) i += 1;
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`--${key} needs a value`);
    out[key] = value;
  }
  if (!GROUP_NAMES.includes(out.group)) throw new UsageError(`unknown group "${out.group}": use one of ${GROUP_NAMES.join(', ')}`);
  return out;
}

/** A saved answer must be a text or an object with a draft text. Anything else is refused, naming the case. */
export function checkAnswers(answers, knownIds) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new UsageError('the answers file must be a JSON object keyed by case id');
  for (const [id, v] of Object.entries(answers)) {
    const ok = typeof v === 'string' || (v && typeof v === 'object' && !Array.isArray(v) && typeof v.draft === 'string');
    if (!ok) throw new UsageError(`malformed answer for case ${id}: expected a text or an object with a "draft" text`);
  }
  const ignored = Object.keys(answers).filter((id) => !knownIds.has(id));
  return { ignored };
}

/** The report lines of one group. */
function groupReport(name, result, ignoredCount, answersGiven) {
  const lines = [];
  const done = result.graded.filter((g) => !g.missing);
  // without any answers file nothing is "missing": nothing was asked to be graded
  const missing = answersGiven ? result.casesTotal - done.length : 0;
  lines.push(`## Group: ${name} (${result.casesTotal} cases, ${result.agents} agents)`);
  lines.push(`Validation: ${result.validation.ok ? 'OK' : 'PROBLEMS'}.`);
  for (const p of result.validation.problems) lines.push(`- problem: ${p}`);
  lines.push(`Provider variables (names only): ${Object.entries(result.provider.variables).map(([k, v]) => `${k}=${v ? 'set' : 'not set'}`).join(', ')}.`);
  if (done.length) {
    lines.push(`Quality: graded offline: ${done.length} of ${result.casesTotal} cases${missing ? `, ${missing} without an answer` : ''}.`);
    const byAgent = {};
    for (const g of done) (byAgent[g.agent] ??= []).push(g);
    for (const [agent, list] of Object.entries(byAgent)) {
      const score = list.reduce((s, g) => s + g.score, 0) / list.length;
      lines.push(`- ${agent}: mean check score ${(score * 100).toFixed(0)} % over ${list.length} case(s); failed checks: ${[...new Set(list.flatMap((g) => g.failed))].join(', ') || 'none'}`);
    }
    if (done.some((g) => g.promptHasPersonalData)) lines.push('WARNING: a prompt contained a personal format.');
  } else {
    lines.push('Quality: NOT EVALUATED: no real provider answer was graded for this group.');
  }
  if (ignoredCount) lines.push(`(${ignoredCount} answer(s) in the file belong to other groups and were not used here)`);
  return { lines, graded: done.length, missing, total: result.casesTotal, validOk: result.validation.ok };
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(`error: ${e.message}\n\n${HELP}`); return 2; }
  if (args.help) { process.stdout.write(HELP); return 0; }

  let answers = null;
  if (args.answers) {
    let raw;
    try { raw = await readFile(args.answers, 'utf8'); } catch { process.stderr.write(`error: cannot read the answers file ${args.answers}\n`); return 2; }
    try { answers = JSON.parse(raw); } catch { process.stderr.write('error: the answers file is not valid JSON\n'); return 2; }
  }

  const names = args.group === 'all' ? Object.keys(GROUPS) : [args.group];
  const knownIds = new Set(casesOfGroup('all').map((c) => c.id));
  let ignored = 0;
  if (answers) {
    try { ignored = checkAnswers(answers, knownIds).ignored.length; }
    catch (e) { process.stderr.write(`error: ${e.message}\n`); return 2; }
  }

  const sections = []; let totals = { cases: 0, graded: 0, missing: 0 }; let allValid = true;
  const lines = ['# Growth agents - evaluation (offline)'];
  for (const name of names) {
    const cases = casesOfGroup(name);
    const ids = new Set(cases.map((c) => c.id));
    const groupAnswers = answers ? Object.fromEntries(Object.entries(answers).filter(([id]) => ids.has(id))) : null;
    const otherCount = answers ? Object.keys(answers).filter((id) => !ids.has(id)).length : 0;
    const result = await runEvaluation({ answers: groupAnswers && Object.keys(groupAnswers).length ? groupAnswers : null, cases, group: name });
    const rep = groupReport(name, result, args.group === 'all' ? 0 : otherCount, Boolean(answers));
    sections.push(rep);
    lines.push(...rep.lines, '');
    totals = { cases: totals.cases + rep.total, graded: totals.graded + rep.graded, missing: totals.missing + rep.missing };
    allValid = allValid && rep.validOk;
  }
  if (args.group === 'all' || names.length > 1) {
    // the total: every case exactly once, in its declared group, nothing lost or unexpected
    const totalProblems = coverageProblems('all', casesOfGroup('all'));
    for (const p of totalProblems) lines.push(`- total problem: ${p}`);
    if (totalProblems.length) allValid = false;
    lines.push(`## Total: ${totals.cases} cases in ${names.length} group(s); graded offline: ${totals.graded}${totals.missing ? `, without an answer: ${totals.missing}` : ''}.`);
    lines.push(totals.graded ? 'Quality: graded offline for the cases above; no quality is claimed beyond these checks.' : 'Quality: NOT EVALUATED: no real provider answer was graded.');
  }
  if (ignored && args.group !== 'all') lines.push(`(${ignored} answer(s) in the file match no case of any group)`);
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (args.out) await writeFile(args.out, text);
  return allValid ? 0 : 1;
}

const code = await main(process.argv.slice(2));
process.exitCode = code;
