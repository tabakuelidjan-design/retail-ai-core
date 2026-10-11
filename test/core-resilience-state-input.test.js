import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyChange, classifyProviderFailure, createCapabilityRegistry, createDependencyGraph, createStateHub, findDuplicateKey, FIELD_STATUS, invalidate, isTransient, jsonSlice, readAmount,
  readInput, readStructuredReply, readTextField, reconcileStatements, requireCollections, scriptsOf,
} from '../src/core-resilience/index.js';

// CORE RESILIENCE: STATE, USER INPUT, CHANGE OF MIND, THE PROVIDER BOUNDARY, CAPABILITIES (`// CS-N` markers). Offline, deterministic.

const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; };

// ------------------------------------------------------------------------------------------------ state
test('CS-1 a committed checkpoint is frozen and never overwritten; a failed stage leaves only partial evidence; rollback is explicit and keeps journal and meter', () => {
  const hub = createStateHub(); const run = hub.open('t1', 'r1');
  run.commit('a', { v: 1 }); run.meterCall('a', 0.01); run.record({ module: 'm', stage: 'a', result: 'COMMITTED' });
  assert.throws(() => run.commit('a', { v: 2 }), (e) => e.code === 'CORE_CHECKPOINT_OVERWRITE' && e.category === 'STATE_INTEGRITY_ERROR');
  assert.ok(Object.isFrozen(run.get('a')));
  assert.throws(() => { 'use strict'; run.get('a').v = 3; }, TypeError);
  run.abort('b', { half: 'done', secret: 'sk-abcdef1234567890' }, 'SOME_CODE');
  assert.equal(run.has('b'), false); // partial is not committed
  assert.equal(JSON.stringify(run.partial('b')).includes('sk-abcdef'), false);
  run.commit('b', 1); run.commit('c', 2);
  assert.deepEqual(run.rollbackTo('b'), ['b', 'c']);
  assert.deepEqual(run.committedStages(), ['a']);
  assert.deepEqual([run.meter().provider_calls, run.journal().length], [1, 1]); // accounting and evidence survive the rollback
  assert.deepEqual(run.uncommit(['a', 'zzz']), ['a']);
});

test('CS-2 side effects are exactly-once: concurrent attempts share one, a duplicate is suppressed and counted, an irreversible effect with an unknown outcome is never repeated', async () => {
  const run = createStateHub().open('t1', 'r1'); let n = 0;
  const results = await Promise.all(Array.from({ length: 6 }, () => run.once('k', async () => { n += 1; await new Promise((r) => setTimeout(r, 3)); return 'x'; })));
  assert.deepEqual([n, new Set(results).size, run.suppressedDuplicates()], [1, 1, 5]);
  await assert.rejects(run.once('boom', async () => { throw new Error('x'); }), /x/);
  assert.equal(await run.once('boom', async () => 'second try works'), 'second try works'); // a reversible failure may be repeated
  let sent = 0;
  await assert.rejects(run.once('mail', async () => { sent += 1; throw new Error('timeout'); }, { irreversible: true }));
  await assert.rejects(run.once('mail', async () => { sent += 1; }, { irreversible: true }), (e) => e.code === 'CORE_EFFECT_OUTCOME_UNKNOWN');
  assert.equal(sent, 1);
});

test('CS-3 tenants are separate in every dimension: same run id, handles, journals, meters, effects, exports', async () => {
  const hub = createStateHub(); const a = hub.open('ten-a', 'run-1'); const b = hub.open('ten-b', 'run-1');
  a.commit('s', { who: 'A-SECRET' }); a.meterCall('s', 1); a.record({ module: 'm', result: 'A' }); await a.once('e', async () => 1);
  assert.equal(b.has('s'), false);
  assert.deepEqual([b.meter().provider_calls, b.journal().length, b.effectKeys().length], [0, 0, 0]);
  assert.equal(JSON.stringify(hub.inspectTenant('ten-b')).includes('A-SECRET'), false);
  hub.open('ten-a', 'only-a');
  assert.throws(() => hub.handle('ten-b', 'only-a'), (e) => e.code === 'CORE_TENANT_MISMATCH');
  assert.throws(() => hub.handle('ten-b', 'missing'), (e) => e.code === 'CORE_RUN_NOT_FOUND_FOR_TENANT');
  assert.throws(() => hub.open('bad tenant!', 'r'), (e) => e.code === 'CORE_RUN_IDENTITY_INVALID');
  assert.deepEqual(hub.runs('ten-b'), ['run-1']);
});

// ------------------------------------------------------------------------------------------------ user input
test('CS-4 meaning-preserving normalization only: Unicode form, invisible spaces and blank runs; nothing is truncated; joiners and bidirectional marks are kept', () => {
  assert.deepEqual(readTextField('Été'), { status: FIELD_STATUS.NORMALIZED, value: 'Été', repairs: ['UNICODE_NFC'] });
  assert.equal(readTextField('Pri​x   final ﻿').value, 'Prix final');
  assert.equal(readTextField('a  b').value, 'a b');
  assert.equal(readTextField('\u{1F468}‍\u{1F469}‍\u{1F467}').value, '\u{1F468}‍\u{1F469}‍\u{1F467}'); // the joiner is meaning
  assert.equal(readTextField('می‌خواهم').value.includes('‌'), true);
  assert.equal(readTextField('abc ‏ def').value.includes('‏'), true);
  assert.equal(readTextField('x'.repeat(2001)).status, FIELD_STATUS.TOO_LONG);
  assert.equal(readTextField('x'.repeat(2001)).value, null); // never truncated
  assert.equal(readTextField('line one\n\n\n\nline two', { multiline: true }).value, 'line one\n\nline two');
  assert.equal(readTextField('line one\nline two').value, 'line one line two');
  for (const empty of [null, undefined, '', '   ', '​﻿', 'N/A', 'null', 'None', 'néant', '—']) assert.equal(readTextField(empty).status, FIELD_STATUS.MISSING, String(empty));
  assert.equal(readTextField('none', { nullLike: 'LITERAL' }).value, 'none'); // a field that accepts the word keeps it
  assert.equal(readTextField(42).status, FIELD_STATUS.INVALID);
});

test('CS-5 amounts: unambiguous forms are read; a group separator is AMBIGUOUS and is never guessed', () => {
  for (const [raw, value] of [[25, 25], ['25', 25], ['25,50', 25.5], ['25.5', 25.5], ['€25', 25], ['EUR 25,00', 25], ['25,00 €', 25]]) assert.equal(readAmount(raw).value, value, String(raw));
  for (const raw of ['1.250', '1,250', '1 250,00', '12.345,67']) assert.equal(readAmount(raw).status, FIELD_STATUS.AMBIGUOUS, raw);
  for (const raw of ['cheap', '--5', '1e5', '25 euros please']) assert.equal(readAmount(raw).status, FIELD_STATUS.INVALID, raw);
  assert.equal(readAmount(-1).status, FIELD_STATUS.INVALID);
  assert.equal(readAmount('').status, FIELD_STATUS.MISSING);
});

test('CS-6 nothing is invented: a missing price, legal, financial, claim, supplier or compliance fact is MISSING_INFORMATION unless a safe default was DECLARED', () => {
  for (const factClass of ['price', 'legal', 'financial', 'claim', 'supplier_claim', 'compliance']) {
    const r = readInput({ f: { kind: 'text', required: true, factClass } }, {}, { module: 'm', stage: 's' });
    assert.deepEqual([r.issues.length, r.issues[0].category, r.issues[0].domain_code, 'f' in r.values], [1, 'MISSING_INFORMATION', `${factClass.toUpperCase()}_FACT_MISSING`, false]);
  }
  const declared = readInput({ f: { kind: 'text', required: true, safeDefault: 'none stated' } }, {}, { module: 'm', stage: 's' });
  assert.deepEqual([declared.values.f, declared.repairs[0].repair, declared.issues.length], ['none stated', 'DECLARED_SAFE_DEFAULT', 0]);
  const e = readInput({ kind: { kind: 'enum', enum: ['RED', 'BLUE'], required: true } }, { kind: 'violet' }, { module: 'm', stage: 's' });
  assert.equal(e.issues[0].category, 'INPUT_INVALID');
  assert.equal(readInput({ kind: { kind: 'enum', enum: ['RED', 'BLUE'], required: true } }, { kind: 'blue' }, { module: 'm', stage: 's' }).values.kind, 'BLUE');
  assert.equal(requireCollections({ orders: [] }, ['orders', 'lines'], { module: 'd', stage: 's' })[0].code, 'INPUT_COLLECTION_MISSING');
});

test('CS-7 contradictions are detected, not resolved, unless an explicit user-priority rule resolves a deliberate reversal', () => {
  const stmts = (...list) => list.map(([key, value, explicit_change]) => ({ key, value, explicit_change }));
  assert.equal(reconcileStatements(stmts(['city', 'Namur'], ['city', ' namur ']), { module: 'm', stage: 's' }).contradictions.length, 0);
  assert.equal(reconcileStatements(stmts(['city', 'Namur'], ['city', 'Liège']), { module: 'm', stage: 's' }).contradictions[0].category, 'USER_CONTRADICTION');
  assert.equal(reconcileStatements(stmts(['tone', 'a'], ['tone', 'b', true]), { module: 'm', stage: 's' }).contradictions.length, 1); // no priority rule: ask
  assert.deepEqual(reconcileStatements(stmts(['tone', 'a'], ['tone', 'b', true]), { priority: { tone: 'LATEST_WINS' }, module: 'm', stage: 's' }).resolved, { tone: 'b' });
  assert.equal(reconcileStatements(stmts(['tone', 'a'], ['tone', 'b']), { priority: { tone: 'LATEST_WINS' }, module: 'm', stage: 's' }).contradictions.length, 1); // a rule resolves only a DELIBERATE change
});

test('CS-8 property: any text the user can type is handled without an exception, normalization is idempotent, a normalized value is never longer than its input, and a long text is never truncated', () => {
  const random = lcg(7);
  const alphabet = ['a', 'Z', ' ', '\n', '\t', 'é', 'é', '​', '‍', '﻿', 'م', '春', '\u{1F600}', '-', '"', '\\', '\u0000', ' ', ' ', '0'];
  for (let i = 0; i < 3000; i += 1) {
    const raw = Array.from({ length: Math.floor(random() * 40) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    const once = readTextField(raw, { max: 60 });
    assert.ok(Object.values(FIELD_STATUS).includes(once.status));
    if (once.value !== null) {
      const twice = readTextField(once.value, { max: 60, nullLike: 'LITERAL' });
      assert.equal(twice.value, once.value, JSON.stringify(raw));
      assert.ok(once.value.length <= raw.length + 1);
    } else assert.ok([FIELD_STATUS.MISSING, FIELD_STATUS.TOO_LONG].includes(once.status));
  }
  assert.deepEqual(scriptsOf('Spring 春 مرحبا \u{1F600}'), ['ARABIC', 'CJK', 'EMOJI', 'LATIN']);
});

// ------------------------------------------------------------------------------------------------ change of mind
const GRAPH = createDependencyGraph({ facts: ['product', 'audience', 'headline', 'price'], stages: [{ name: 'observe', reads: ['product'] }, { name: 'frame', reads: ['audience', 'observe'] }, { name: 'ideate', reads: ['frame'] }, { name: 'compose', reads: ['ideate', 'headline', 'price'] }, { name: 'render', reads: ['compose'] }] });
test('CS-9 a change invalidates exactly what depends on it: the closure is computed, the rest is preserved, an unknown fact is refused', () => {
  assert.deepEqual(invalidate(GRAPH, [{ fact: 'headline', change: 'CHANGED' }]).recompute, ['compose', 'render']);
  assert.deepEqual(invalidate(GRAPH, [{ fact: 'headline', change: 'CHANGED' }]).preserved, ['observe', 'frame', 'ideate']);
  assert.deepEqual(invalidate(GRAPH, [{ fact: 'price', change: 'REMOVED' }]).recompute, ['compose', 'render']);
  assert.deepEqual(invalidate(GRAPH, [{ fact: 'audience', change: 'CHANGED' }]).recompute, ['frame', 'ideate', 'compose', 'render']);
  assert.deepEqual(invalidate(GRAPH, [{ fact: 'product', change: 'CHANGED' }]).preserved, []);
  assert.deepEqual(invalidate(GRAPH, [{ fact: 'headline', change: 'CHANGED' }, { fact: 'audience', change: 'CHANGED' }]).recompute, ['frame', 'ideate', 'compose', 'render']);
  assert.throws(() => invalidate(GRAPH, [{ fact: 'mood', change: 'CHANGED' }]), (e) => e.code === 'CORE_UNKNOWN_FACT');
  assert.throws(() => createDependencyGraph({ facts: ['a'], stages: [{ name: 's', reads: ['later'] }] }), /neither a fact nor an earlier stage/);
  assert.throws(() => createDependencyGraph({ facts: ['a'], stages: [{ name: 'a', reads: [] }] }), /duplicate/);
});

test('CS-10 applying a change uncommits only the affected committed stages and journals it; the valid upstream state is untouched', () => {
  const run = createStateHub().open('t', 'r');
  for (const s of ['observe', 'frame', 'ideate', 'compose', 'render']) run.commit(s, { s });
  const before = run.get('frame');
  const plan = applyChange(GRAPH, run, [{ fact: 'headline', change: 'CHANGED' }]);
  assert.deepEqual(plan.removed, ['compose', 'render']);
  assert.deepEqual(run.committedStages(), ['observe', 'frame', 'ideate']);
  assert.equal(run.get('frame'), before);
  assert.match(run.journal().at(-1).result, /INVALIDATED:compose,render/);
});

// ------------------------------------------------------------------------------------------------ provider boundary
test('CS-11 structured replies: fences and prose are removed, a lone wrapper is unwrapped, and every other defect is a PROTOCOL_ERROR with a stable subcode', () => {
  const read = (text, expectedKeys = ['title', 'body']) => readStructuredReply(text, { module: 'm', stage: 's', expectedKeys });
  assert.deepEqual(read('```json\n{"title":"a","body":"b"}\n```').value, { title: 'a', body: 'b' });
  assert.deepEqual(read('Here you go:\n{"title":"a","body":"b"}\nThanks').value, { title: 'a', body: 'b' });
  assert.deepEqual(read('{"answer":{"title":"a","body":"b"}}').repairs.map((r) => r.kind), ['PROVIDER_WRAPPED_ANSWER']);
  assert.deepEqual(read('{"frame":{"title":"a","body":"b"}}').value, { title: 'a', body: 'b' }); // inside is exactly the contract
  assert.equal(read('{"frame":{"title":"a","body":"b","extra":1}}').value.frame.extra, 1); // not unwrapped: the inside is not the contract
  for (const [text, code] of [['', 'PROVIDER_EMPTY_BODY'], ['no json here', 'PROVIDER_NO_JSON_OBJECT'], ['{"title": [}', 'PROVIDER_MALFORMED_JSON'], ['{"title": [', 'PROVIDER_NO_JSON_OBJECT'], ['{"title":"a","title":"b"}', 'PROVIDER_DUPLICATE_KEYS'], ['{"x": 1}'.replace('{', '[').replace('}', ']'), 'PROVIDER_NO_JSON_OBJECT']]) {
    const r = read(text); assert.equal(r.ok, false, text); assert.deepEqual([r.error.category, r.error.code], ['PROTOCOL_ERROR', code], text);
  }
  assert.equal(findDuplicateKey('{"a":{"a":1},"b":[{"a":1},{"a":2}]}'), null);
  assert.equal(jsonSlice('nothing'), null);
});

test('CS-12 provider failures are classified without leaking: timeout, rate limit, network, auth, refusal, capability, outage, rejection; only the declared transient ones are transient', () => {
  const where = { module: 'm', stage: 's' };
  const cases = [
    [{ name: 'AbortError' }, 'PROVIDER_TIMEOUT', 'PROVIDER_FAILURE', true], [{ code: 'ETIMEDOUT' }, 'PROVIDER_TIMEOUT', 'PROVIDER_FAILURE', true], [{ status: 429, retryAfterMs: 2000 }, 'PROVIDER_RATE_LIMITED', 'PROVIDER_FAILURE', true],
    [{ code: 'ECONNRESET' }, 'PROVIDER_NETWORK', 'PROVIDER_FAILURE', true], [{ status: 401 }, 'PROVIDER_AUTH', 'PROVIDER_FAILURE', false], [{ status: 400, message: 'blocked by the content filter' }, 'PROVIDER_REFUSAL', 'PROVIDER_FAILURE', false],
    [{ status: 404, message: 'model not found' }, 'PROVIDER_CAPABILITY_UNAVAILABLE', 'TOOL_CAPABILITY_LIMIT', false], [{ status: 503 }, 'PROVIDER_UNAVAILABLE', 'PROVIDER_FAILURE', true], [{ status: 500 }, 'PROVIDER_SERVER_ERROR', 'PROVIDER_FAILURE', true],
    [{ status: 422 }, 'PROVIDER_REJECTED', 'PROVIDER_FAILURE', false], [{ message: 'strange' }, 'PROVIDER_UNKNOWN', 'PROVIDER_FAILURE', false],
  ];
  for (const [failure, code, category, transient] of cases) {
    const e = classifyProviderFailure(failure, where);
    assert.deepEqual([e.code, e.category, isTransient(e)], [code, category, transient], JSON.stringify(failure));
  }
  const leaky = classifyProviderFailure({ status: 500, message: 'HTTP 500: {"row":"alice@example.com","key":"sk-abcdef1234567890"} request_id=chatcmpl-abc' }, where);
  assert.doesNotMatch(JSON.stringify(leaky), /alice@example|sk-abcdef|chatcmpl-abc|row/);
});

test('CS-13 capabilities: only a DECLARED, AUTHORIZED, same-outcome, same-region alternate that does not widen the data class is safe; a degrading one is reported, never used silently', () => {
  const reg = createCapabilityRegistry();
  reg.register({ id: 'a', region: 'eu', data_class: 'PRIVATE', equivalentTo: [{ id: 'same', outcome: 'SAME' }, { id: 'lite', outcome: 'DEGRADES' }, { id: 'asia', outcome: 'SAME' }, { id: 'off', outcome: 'SAME' }, { id: 'pub', outcome: 'SAME' }, { id: 'ghost', outcome: 'SAME' }] });
  reg.register({ id: 'same', region: 'eu', data_class: 'PRIVATE' }); reg.register({ id: 'lite', region: 'eu', data_class: 'PRIVATE' }); reg.register({ id: 'asia', region: 'ap', data_class: 'PRIVATE' });
  reg.register({ id: 'off', region: 'eu', data_class: 'PRIVATE', authorized: false }); reg.register({ id: 'pub', region: 'eu', data_class: 'PUBLIC' }); reg.register({ id: 'undeclared', region: 'eu', data_class: 'PRIVATE' });
  assert.deepEqual(reg.alternatesFor('a', { data_class: 'PRIVATE' }), { safe: ['same'], degrading: ['lite'] });
  assert.deepEqual(reg.alternatesFor('a', { data_class: 'PUBLIC' }).safe, ['same', 'pub']);
  assert.deepEqual(reg.alternatesFor('nothing'), { safe: [], degrading: [] });
  assert.throws(() => reg.register({ id: 'x', data_class: 'SECRET' }), /data_class/);
  assert.throws(() => reg.register({ id: 'y', data_class: 'PUBLIC', equivalentTo: [{ id: 'z', outcome: 'BETTER' }] }), /outcome/);
});
