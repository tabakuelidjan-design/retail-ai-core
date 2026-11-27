// Nordla Growth - evaluation harness: validation of the cases, the grader's CONTRACT on hand-written answers, the offline runner, and the secrecy of
// the provider report. The answers used here are SIMULATED and only test that the grader discriminates; they are NOT evidence of answer quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CASES } from '../src/growth/eval/cases.js';
import { gradeAnswer } from '../src/growth/eval/grade.js';
import { runEvaluation, validateCases, providerVariableState } from '../src/growth/eval/run.js';

const byId = (id) => CASES.find((c) => c.id === id);

test('cases: 24 synthetic cases, three per agent, each agent reads only its own sources, no personal format in the data', () => {
  assert.equal(CASES.length, 24);
  assert.deepEqual(validateCases(), []);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, 'unique ids');
});

test('grader contract (SIMULATED answers, not a quality measure): a sourced answer passes, a bad one fails the matching checks', () => {
  const good = gradeAnswer(byId('strat-1'), JSON.stringify({ draft: '1. Vérifier les coûts d’achat (4 éléments).\n2. Pousser la coque chien.\n3. Garder le suivi.', reason: 'Priorités tirées des sources.', limits: ['Ventes sur 8 semaines'] }));
  assert.deepEqual(good.failed, [], 'a sourced, short, limited answer passes every check');
  const bad = gradeAnswer(byId('strat-1'), JSON.stringify({ draft: '1. a\n2. b\n3. c\n4. d\nCela vous garantit 45000 € de plus. Écrivez à marque.test@example.test', reason: 'r', limits: [] }));
  for (const k of ['noUnjustifiedClaim', 'grounded', 'noPersonalData', 'at-most-three-steps']) assert.ok(bad.failed.includes(k), `${k} must fail`);
  assert.equal(gradeAnswer(byId('strat-1'), 'pas du json').criteria.format, false);
  assert.equal(gradeAnswer(byId('strat-1'), 'pas du json').score, 0);
});

test('grader: a case with a missing source must say so; an ads answer ordering spend is refused; an invented identifier is refused', () => {
  const noLimit = gradeAnswer(byId('cont-2'), JSON.stringify({ draft: 'Publiez un texte.', reason: 'r', limits: [] }));
  assert.ok(noLimit.failed.includes('statesLimits'));
  const stated = gradeAnswer(byId('cont-2'), JSON.stringify({ draft: 'Compte non connecté : rien à lire.', reason: 'r', limits: ['source social non connectée'] }));
  assert.ok(!stated.failed.includes('statesLimits'));
  const spend = gradeAnswer(byId('ads-2'), JSON.stringify({ draft: 'Augmentez le budget de Noël.', reason: 'r', limits: [] }));
  assert.ok(spend.failed.includes('noUnjustifiedClaim') || spend.failed.includes('no-spend-order'));
  const ids = gradeAnswer(byId('prod-1'), JSON.stringify({ draft: 'Pousser product:gourde-z maintenant.', reason: 'r', limits: [] }));
  assert.ok(ids.failed.includes('noInventedIds'));
});

test('runner, offline: answers are graded through the real gateway prompt, and NO network call is made', async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('network must not be used'); };
  try {
    const answers = Object.fromEntries(CASES.map((c) => [c.id, { draft: 'Brouillon de test.', reason: 'Raison de test.', limits: ['limite de test'] }]));
    const r = await runEvaluation({ answers, env: {} });
    assert.equal(r.graded.length, 24); assert.equal(calls, 0);
    assert.ok(r.graded.every((g) => g.promptHasPersonalData === false));
    assert.match(r.quality, /graded offline: 24 of 24/);
  } finally { globalThis.fetch = realFetch; }
});

test('runner without answers grades nothing and claims no quality; the provider is reported by NAME only', async () => {
  const r = await runEvaluation({ answers: null, env: { GROWTH_AI_API_KEY: 'SECRET-VALUE-TEST-123' } });
  assert.equal(r.graded.length, 0);
  assert.match(r.quality, /NOT EVALUATED/);
  assert.deepEqual(r.provider.variables, { GROWTH_AI_PROVIDER: false, GROWTH_AI_API_KEY: true, GROWTH_AI_MODEL: false });
  assert.equal(r.provider.configured, false);
  assert.doesNotMatch(JSON.stringify(r), /SECRET-VALUE-TEST-123/);
  assert.deepEqual(providerVariableState({ GROWTH_AI_MODEL: '  ' }), { GROWTH_AI_PROVIDER: false, GROWTH_AI_API_KEY: false, GROWTH_AI_MODEL: false });
});

test('CLI: prints the protocol state, never a secret, and never calls a provider', () => {
  const out = spawnSync(process.execPath, ['scripts/growth-agent-eval.mjs'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GROWTH_AI_API_KEY: 'SECRET-VALUE-CLI-456', GROWTH_AI_PROVIDER: 'anthropic', GROWTH_AI_MODEL: 'm' }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Quality: NOT EVALUATED/);
  assert.match(out.stdout, /GROWTH_AI_API_KEY=set/);
  assert.doesNotMatch(out.stdout + out.stderr, /SECRET-VALUE-CLI-456/);
});

test('the runner has no network path: it imports neither the provider adapter nor any fetch', () => {
  const src = readFileSync(new URL('../src/growth/eval/run.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/growth/eval/grade.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /providerFromEnv|fetch\(|https?:\/\//);
});
