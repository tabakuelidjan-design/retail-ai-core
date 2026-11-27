// Nordla Growth - the offline evaluation CLI: every group, the default group, all, saved answers, and every usage error. The CLI is run as a
// child process with a minimal environment. Nothing reaches a provider, and no secret is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'growth-agent-eval.mjs');
const run = (args, extraEnv = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd: ROOT, encoding: 'utf8',
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...extraEnv },
});
const tmp = mkdtempSync(join(tmpdir(), 'growth-eval-cli-'));
const answersFile = (name, obj) => { const p = join(tmp, name); writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p; };

test('default group: no argument runs the reference group (24 cases), validates it, and claims no quality', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Group: reference \(24 cases, 8 agents\)/);
  assert.match(r.stdout, /Validation: OK\./);
  assert.match(r.stdout, /Quality: NOT EVALUATED/);
  assert.doesNotMatch(r.stdout, /## Group: (remax|goal)/, 'the default run does not mix in the other groups');
});

for (const [name, n] of [['reference', 24], ['remax', 5], ['remax-synthetic', 3], ['goal', 7]]) {
  test(`group ${name}: runs its ${n} cases offline and reports NOT EVALUATED without answers`, () => {
    const r = run([`--group=${name}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`## Group: ${name} \\(${n} cases`));
    assert.match(r.stdout, /Validation: OK\./);
    assert.match(r.stdout, /Quality: NOT EVALUATED/);
  });
}

test('group all: one section per group, then a total of 39 cases in 4 groups', () => {
  const r = run(['--group=all']);
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['reference', 'remax', 'remax-synthetic', 'goal']) assert.match(r.stdout, new RegExp(`## Group: ${name} `));
  assert.match(r.stdout, /## Total: 39 cases in 4 group\(s\); graded offline: 0\./);
  assert.match(r.stdout, /Quality: NOT EVALUATED/);
});

test('the separate-value form works too: --group goal', () => {
  const r = run(['--group', 'goal']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Group: goal \(7 cases/);
});

test('help: lists every group and the options; exit 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node scripts\/growth-agent-eval\.mjs/);
  for (const name of ['reference', 'remax', 'remax-synthetic', 'goal', 'all']) assert.match(r.stdout, new RegExp(name));
});

test('usage errors: an unknown group, a group with no value, an unknown flag -> exit 2, nothing graded, the valid names are listed', () => {
  const unknown = run(['--group=nope']);
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /unknown group "nope"/); assert.match(unknown.stderr, /reference, remax, remax-synthetic, goal, all/);
  const noValue = run(['--group']);
  assert.equal(noValue.status, 2); assert.match(noValue.stderr, /--group needs a value/);
  const flag = run(['--frobnicate']);
  assert.equal(flag.status, 2); assert.match(flag.stderr, /unknown argument: --frobnicate/);
});

test('answers: a missing file, an invalid JSON file, and a malformed answer are refused with exit 2 (the malformed one names its case)', () => {
  const missing = run(['--answers', join(tmp, 'absent.json')]);
  assert.equal(missing.status, 2); assert.match(missing.stderr, /cannot read the answers file/);
  const bad = run(['--answers', answersFile('bad.json', '{ not json')]);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /not valid JSON/);
  const malformed = run(['--group=goal', '--answers', answersFile('mal.json', { 'goal-strat-1': 42 })]);
  assert.equal(malformed.status, 2); assert.match(malformed.stderr, /malformed answer for case goal-strat-1/);
  const notObject = run(['--answers', answersFile('arr.json', ['x'])]);
  assert.equal(notObject.status, 2); assert.match(notObject.stderr, /keyed by case id/);
});

test('answers: a partial set for one group is graded offline, the rest are counted as missing; no network', () => {
  const file = answersFile('goal.json', {
    'goal-strat-1': { draft: 'Cible 5 000 € ; réalisé 4 700 €, soit 94 %. Données fictives de test.', reason: 'Calcul serveur.', limits: [] },
    'goal-store-2': JSON.stringify({ draft: 'Ventes indisponibles : aucun écart calculé.', reason: 'r', limits: ['ventes indisponibles'] }),
  });
  const r = run(['--group=goal', '--answers', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Quality: graded offline: 2 of 7 cases, 5 without an answer\./);
  assert.doesNotMatch(r.stdout, /NOT EVALUATED/);
});

test('answers for another group are not used by this group, and the CLI says how many', () => {
  const file = answersFile('mixed.json', { 'strat-1': 'x'.repeat(10) }); // a reference case, not in goal
  const r = run(['--group=goal', '--answers', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 answer\(s\) in the file belong to other groups and were not used here/);
});

test('group all with answers: each group is graded separately and the total counts them', () => {
  const file = answersFile('all.json', {
    'strat-1': JSON.stringify({ draft: 'Brouillon de test.', reason: 'r', limits: [] }),
    'goal-store-1': JSON.stringify({ draft: 'Cible et réalisé distincts. Données fictives de test.', reason: 'r', limits: [] }),
  });
  const r = run(['--group=all', '--answers', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Total: 39 cases in 4 group\(s\); graded offline: 2, without an answer: 37\./);
  assert.match(r.stdout, /## Group: goal \(7 cases, \d+ agents\)[\s\S]*graded offline: 1 of 7/);
});

test('--out writes the same report to the file', () => {
  const out = join(tmp, 'report.md');
  const r = run(['--group=remax', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(out));
  assert.match(readFileSync(out, 'utf8'), /## Group: remax \(5 cases/);
});

test('provider configuration: reported by NAME only, the value never appears', () => {
  const r = run(['--group=goal'], { GROWTH_AI_API_KEY: 'SECRET-CLI-TEST-VALUE', GROWTH_AI_PROVIDER: 'anthropic', GROWTH_AI_MODEL: 'm' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GROWTH_AI_API_KEY=set/);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET-CLI-TEST-VALUE/);
});

test('cleanup of the temporary answers', () => { rmSync(tmp, { recursive: true, force: true }); assert.equal(existsSync(tmp), false); });
