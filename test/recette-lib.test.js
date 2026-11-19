// Phase 5 - the recette helpers: parsing, cookies, expectations and the printed table (no secret is ever printed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, cookieHeaderOf, evaluate, renderTable } from '../scripts/recette-lib.mjs';

test('parseEnv reads KEY=VALUE lines and ignores blanks and comments', () => {
  const env = parseEnv('# comment\n\nOWNER_PASSWORD=abc=def\n  VIEWER_ID = 123 \nbadline\n');
  assert.deepEqual(env, { OWNER_PASSWORD: 'abc=def', VIEWER_ID: '123' });
});

test('cookieHeaderOf keeps name=value only, from several Set-Cookie lines', () => {
  assert.equal(cookieHeaderOf(['a=1; Path=/; HttpOnly', 'b=2; Secure']), 'a=1; b=2');
  assert.equal(cookieHeaderOf([]), '');
});

test('evaluate accepts any listed status and reports the failures', () => {
  const r = evaluate([
    { id: 1, role: 'X', action: 'ok', observed: 200, expect: 200 },
    { id: 2, role: 'X', action: 'either', observed: 403, expect: [401, 403] },
    { id: 3, role: 'X', action: 'bad', observed: 500, expect: 200 },
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.passed, 2);
  assert.deepEqual(r.failures.map((f) => f.id), [3]);
});

test('the table shows the expectation and the observation, never anything else', () => {
  const t = renderTable(evaluate([{ id: 1, role: 'Propriétaire', action: 'Connexion', observed: 200, expect: 200 }]).rows);
  assert.match(t, /Propriétaire/);
  assert.match(t, /\| 200 +\| 200 +\| OK +\|/);
  assert.equal(/password|cookie|token|secret/i.test(t), false);
});
