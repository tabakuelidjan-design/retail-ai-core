// Nordla Growth - the declared coverage of each evaluation group: exact counts per group and per agent, and the failures that must be caught: a
// lost case, a duplicated case, a case in the wrong group, a case for an unexpected agent, an unexpected case, and the total of --group=all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED, coverageProblems } from '../src/growth/eval/expectations.js';
import { GROUPS, casesOfGroup } from '../src/growth/eval/groups.js';
import { runEvaluation } from '../src/growth/eval/run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const copy = (name) => GROUPS[name].cases.map((c) => ({ ...c }));

test('exact counts: reference 24 (3 per agent), remax 5 (3 Produits, 2 Stratège), remax-synthetic 3 (2 Produits, 1 Stratège), goal 7 (3 Stratège, 4 Boutique)', () => {
  assert.equal(casesOfGroup('reference').length, 24);
  assert.deepEqual(EXPECTED.reference.perAgent, { strategist: 3, products: 3, audience: 3, content: 3, store: 3, conversion: 3, ads: 3, experiments: 3 });
  assert.equal(casesOfGroup('remax').length, 5);
  assert.deepEqual(EXPECTED.remax.perAgent, { products: 3, strategist: 2 });
  assert.equal(casesOfGroup('remax-synthetic').length, 3);
  assert.deepEqual(EXPECTED['remax-synthetic'].perAgent, { products: 2, strategist: 1 });
  assert.equal(casesOfGroup('goal').length, 7);
  assert.deepEqual(EXPECTED.goal.perAgent, { strategist: 3, store: 4 }, 'the cases as written: 3 Stratège and 4 Boutique');
  for (const name of Object.keys(GROUPS)) assert.deepEqual(coverageProblems(name, copy(name)), [], `${name} is valid as declared`);
});

test('small groups are valid when their size is intentional (remax-synthetic has 3 cases, remax 5)', () => {
  assert.deepEqual(coverageProblems('remax-synthetic', copy('remax-synthetic')), []);
  assert.deepEqual(coverageProblems('remax', copy('remax')), []);
});

test('a lost case is caught, by id', () => {
  const cases = copy('goal').filter((c) => c.id !== 'goal-cmp-period');
  const problems = coverageProblems('goal', cases);
  assert.ok(problems.some((p) => p === 'goal-cmp-period: lost (expected for store)'), problems.join(' | '));
  assert.ok(problems.some((p) => /group goal has 6 cases, expected 7/.test(p)));
});

test('a duplicated case is caught', () => {
  const cases = [...copy('remax'), { ...copy('remax')[0] }];
  const problems = coverageProblems('remax', cases);
  assert.ok(problems.some((p) => p === 'remax-prod-1: duplicated (2 times)'), problems.join(' | '));
});

test('a case in the wrong group is caught (a remax case inside reference, a goal case inside remax)', () => {
  const misplaced = [...copy('reference'), { ...copy('remax')[0], id: 'remax-prod-1' }];
  assert.ok(coverageProblems('reference', misplaced).some((p) => /remax-prod-1: belongs to group remax, not reference/.test(p)));
  const cases = copy('remax').map((c, i) => (i === 0 ? { ...c, group: 'goal' } : c));
  assert.ok(coverageProblems('remax', cases).some((p) => /belongs to group goal, not remax/.test(p)));
});

test('a case for an unexpected agent is caught, and the declared count stops matching', () => {
  const cases = copy('remax').map((c) => (c.id === 'remax-strat-2' ? { ...c, agent: 'ads' } : c));
  const problems = coverageProblems('remax', cases);
  assert.ok(problems.includes('remax-strat-2: tests ads, expected strategist'), problems.join(' | '));
  assert.ok(problems.includes('ads: unexpected agent in group remax'));
  assert.ok(problems.includes('strategist: 1 case(s), expected 2'));
});

test('an unexpected case (an id the group does not declare) is caught', () => {
  const cases = [...copy('remax-synthetic'), { ...copy('remax-synthetic')[0], id: 'remax-syn-invented', group: 'remax-synthetic' }];
  assert.ok(coverageProblems('remax-synthetic', cases).some((p) => p === 'remax-syn-invented: unexpected case for group remax-synthetic'));
});

test('--group=all: each group is checked separately, and the total is every case exactly once in its declared group', () => {
  const all = casesOfGroup('all');
  assert.equal(all.length, 39);
  assert.deepEqual(coverageProblems('all', all), []);
  const lost = all.filter((c) => c.id !== 'remax-prod-2');
  assert.ok(coverageProblems('all', lost).includes('remax-prod-2: missing from the total'));
  const dup = [...all, { ...all[0] }];
  assert.ok(coverageProblems('all', dup).some((p) => /duplicated in the total/.test(p)));
  const extra = [...all, { ...all[0], id: 'unknown-case' }];
  assert.ok(coverageProblems('all', extra).includes('unknown-case: unexpected in the total'));
});

test('the runner reports a coverage failure as a failed validation (the CLI then exits 1)', async () => {
  const broken = copy('remax').filter((c) => c.id !== 'remax-strat-1');
  const r = await runEvaluation({ answers: null, env: {}, cases: broken, group: 'remax' });
  assert.equal(r.validation.ok, false);
  assert.ok(r.validation.problems.some((p) => /remax-strat-1: lost/.test(p)));
  const ok = await runEvaluation({ answers: null, env: {}, cases: copy('goal'), group: 'goal' });
  assert.equal(ok.validation.ok, true);
});

test('CLI --group=all: every group reports its own validation, the total is checked, and the exit code is 0', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'growth-agent-eval.mjs'), '--group=all'], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['reference', 'remax', 'remax-synthetic', 'goal']) assert.match(r.stdout, new RegExp(`## Group: ${name} \\(\\d+ cases[\\s\\S]*?Validation: OK\\.`));
  assert.match(r.stdout, /## Total: 39 cases in 4 group\(s\)/);
  assert.doesNotMatch(r.stdout, /PROBLEMS|total problem/);
});

test('CLI single group: the declared coverage is shown as OK for the small groups too', () => {
  for (const name of ['remax', 'remax-synthetic', 'goal']) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'growth-agent-eval.mjs'), `--group=${name}`], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    assert.equal(r.status, 0, `${name}: ${r.stdout}`);
    assert.match(r.stdout, /Validation: OK\./);
  }
});
