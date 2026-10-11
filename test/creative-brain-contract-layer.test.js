import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { map, normalizeNearMisses, obj, text, validateAnswer, validateSpec, word } from '../src/creative-brain/contract.js';
import { askAndNormalize, findDuplicateKey } from '../src/creative-brain/model-port.js';
import { codeHash } from '../src/creative-brain-benchmark/readiness.js';

// The contract layer on its own (`// CL-N` markers): its edges, one by one.

test('CL-1 a map refuses too few AND too many entries', () => {
  const spec = map({ A: 'A', B: 'B', C: 'C' }, text({ min: 1, max: 9 }), { min: 1, max: 2 });
  assert.deepEqual(validateSpec(spec, { A: 'x', B: 'y' }, 'm'), { A: 'x', B: 'y' });
  assert.throws(() => validateSpec(spec, {}, 'm'), (e) => e.code === 'BRAIN_LIST_INVALID');
  assert.throws(() => validateSpec(spec, { A: 'x', B: 'y', C: 'z' }, 'm'), (e) => e.code === 'BRAIN_LIST_INVALID');
});

test('CL-2 the declared rules run, in order, after the spec', () => {
  const seen = [];
  const rules = [{ id: 'ONE', check: () => seen.push('one') }, { id: 'TWO', check: () => { seen.push('two'); throw Object.assign(new Error('rule two'), { code: 'BRAIN_RULE_VIOLATION' }); } }];
  assert.throws(() => validateAnswer({ spec: obj({ a: text({ min: 1, max: 9 }) }), rules }, { a: 'x' }, 'v'), (e) => e.code === 'BRAIN_RULE_VIOLATION');
  assert.deepEqual(seen, ['one', 'two']);
});

test('CL-3 a case near-miss is repaired only when exactly one word fits, and only when the contract says case-insensitive', () => {
  const ambiguous = word({ LOW: 'low', UP: 'LOW' }); // two words differ only by case: no choice may be made
  const repairs = [];
  assert.equal(normalizeNearMisses(ambiguous, 'Low', repairs), 'Low');
  assert.deepEqual(repairs, []);
  const strict = word({ A: 'ALPHA' }, { caseInsensitive: false });
  assert.equal(normalizeNearMisses(strict, 'alpha', repairs), 'alpha');
  assert.deepEqual(repairs, []);
  const open = word({ A: 'ALPHA' });
  assert.equal(normalizeNearMisses(open, 'alpha', repairs), 'ALPHA');
  assert.equal(repairs.length, 1);
});

test('CL-4 only null and the empty text mean "absent" for an optional key; any other value is kept', () => {
  const spec = obj({ a: text({ min: 1, max: 9 }), b: text({ min: 1, max: 9 }) }, { optional: ['b'] });
  for (const [given, kept] of [[null, false], ['', false], ['none', true], ['x', true]]) {
    const out = normalizeNearMisses(spec, { a: 'x', b: given }, []);
    assert.equal('b' in out, kept, String(given));
  }
});

test('CL-5 the journal of repairs is returned with the value, and key repairs keep their {path, from, to} shape', async () => {
  const spec = obj({ alpha: text({ min: 1, max: 20 }), beta: text({ min: 1, max: 20 }) });
  const { value, meta } = await askAndNormalize({ complete: async () => ({ text: JSON.stringify({ alpah: 'one', beta: 'two' }), model: 'm', request_id: 'r1' }), instruction: { system: 's', user: 'u' }, stage: 'T', spec, normalize: (v) => validateSpec(spec, v, 'answer') });
  assert.deepEqual(value, { alpha: 'one', beta: 'two' });
  assert.deepEqual(meta.key_repairs, [{ path: 'T', from: 'alpah', to: 'alpha' }]);
  assert.equal(meta.repairs.length, 1);
  assert.equal(meta.repairs[0].kind, 'KEY_NEAR_MISS');
});

test('CL-6 the code hash ignores fixtures and node_modules but not any other directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  for (const d of ['src', 'test', 'scripts']) mkdirSync(path.join(root, d));
  writeFileSync(path.join(root, 'package.json'), '{}');
  const before = codeHash(root);
  mkdirSync(path.join(root, 'test', 'fixtures')); writeFileSync(path.join(root, 'test', 'fixtures', 'big.json'), '{"x":1}');
  mkdirSync(path.join(root, 'src', 'node_modules')); writeFileSync(path.join(root, 'src', 'node_modules', 'm.js'), 'x');
  assert.equal(codeHash(root), before);
  mkdirSync(path.join(root, 'src', 'lib')); writeFileSync(path.join(root, 'src', 'lib', 'x.js'), 'x');
  assert.notEqual(codeHash(root), before);
});

test('CL-7 the duplicate-key scanner: the same name in different objects is fine, in one object it is a duplicate, and strings never confuse it', () => {
  assert.equal(findDuplicateKey('{"a":1,"b":{"a":2},"c":[{"a":1},{"a":2}]}'), null); // nested and listed objects have their own keys
  assert.deepEqual(findDuplicateKey('{"a":1,"b":{"a":2,"a":3}}'), { key: 'a', depth: 2 });
  assert.deepEqual(findDuplicateKey('{"c":[{"a":1,"a":2}]}'), { key: 'a', depth: 3 });
  assert.equal(findDuplicateKey('{"t":"x \\" , \\"a\\": 1 and {\\"a\\":2}","u":["a","a"]}'), null); // quotes, colons and braces inside strings; equal strings in a list
  assert.deepEqual(findDuplicateKey('{"k\\"q":1,"k\\"q":2}'), { key: 'k"q', depth: 1 }); // an escaped quote inside a key
  assert.equal(findDuplicateKey('{"a" : 1 , "b":2}'), null);
  assert.equal(findDuplicateKey('{"a":"same","b":"same"}'), null); // equal VALUES are not duplicate keys
  assert.deepEqual(findDuplicateKey('{"a" \n : 1 , "a"\t:2}'), { key: 'a', depth: 1 });
});
